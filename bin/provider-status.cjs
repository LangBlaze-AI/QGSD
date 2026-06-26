#!/usr/bin/env node
'use strict';

/**
 * provider-status.cjs — deep diagnostic for all provider slots
 *
 * Runs each provider's deep_probe (or a quick --version check) and classifies
 * the result into: OK, AUTH_ERROR, QUOTA_EXCEEDED, FORMAT_ERROR, TIMEOUT, UNREACHABLE.
 *
 * Usage:
 *   node bin/provider-status.cjs                    # probe all slots
 *   node bin/provider-status.cjs --quick             # version check only (fast)
 *   node bin/provider-status.cjs --slots codex-1,gemini-1  # specific slots
 *   node bin/provider-status.cjs --json              # JSON output
 */

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { resolveSpawnTarget } = require('./resolve-cli.cjs');
const { loadProviders: loadProvidersConfig } = require('./resolve-providers.cjs');
const { resolveArgsTemplate } = require('./provider-arg-templates.cjs');

// ─── Error pattern classification ────────────────────────────────────────────

const ERROR_PATTERNS = [
  { status: 'QUOTA_EXCEEDED', patterns: ['quota exceeded', 'rate_limit', 'credit limit exceeded', 'too many requests', 'resource_exhausted', '429'] },
  { status: 'AUTH_ERROR',     patterns: ['unauthorized', 'refresh_token_reused', 'token_expired', 'invalid api key', 'invalid_api_key', '401', '403', 'please try signing in again'] },
  { status: 'FORMAT_ERROR',   patterns: ['invalid_request_error', 'request validation error', '400'] },
  { status: 'NO_CREDITS',    patterns: ['credit limit', '402', 'payment required'] },
];

function classifyOutput(text) {
  const lower = (text ?? '').toLowerCase();
  for (const { status, patterns } of ERROR_PATTERNS) {
    if (patterns.some(p => lower.includes(p))) return status;
  }
  return null;
}

// ─── Find providers.json ─────────────────────────────────────────────────────
// Delegates to the single source of truth in resolve-providers.cjs (issue #197).
// Canonical installed path: ~/.claude/nf-bin/providers.json
// (`'.claude', 'nf-bin', 'providers.json'`).
function loadProviders() {
  return loadProvidersConfig({ baseDir: __dirname });
}

// ─── Kill helper ─────────────────────────────────────────────────────────────

function killChild(child) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch (_) { try { child.kill('SIGTERM'); } catch (_) {} }
  setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (_) {} }
  }, 1000);
}

// ─── Run a command and capture output ────────────────────────────────────────

function runCommand(cli, args, timeoutMs, env) {
  return new Promise((resolve) => {
    const start = Date.now();
    let child;
    try {
      child = spawn(cli, args, {
        env:      { ...process.env, ...(env ?? {}) },
        cwd:      process.cwd(),
        stdio:    ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      resolve({ ok: false, output: '', error: `spawn: ${err.message}`, latencyMs: 0 });
      return;
    }

    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d.toString().slice(0, 4096); });
    child.stderr.on('data', d => { stderr += d.toString().slice(0, 4096); });

    child.on('close', (code) => {
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      const output = stdout + '\n' + stderr;
      if (timedOut) {
        resolve({ ok: false, output, error: 'TIMEOUT', latencyMs });
      } else {
        resolve({ ok: code === 0, output, error: code !== 0 ? `exit ${code}` : null, latencyMs });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: '', error: `spawn: ${err.message}`, latencyMs: Date.now() - start });
    });
  });
}

// ─── Log-based error detection (for CLIs that don't output errors to stderr) ─

// Provider-specific log directories and error patterns.
// When a probe times out or returns no useful output, check recent logs.
const LOG_SOURCES = {
  'opencode-1': {
    logDir: path.join(os.homedir(), '.local', 'share', 'opencode', 'log'),
    errorPattern: /Too Many Requests|quota exceeded|rate.limit|429/i,
    maxAgeMs: 30 * 60 * 1000, // only check logs from last 30 min
  },
};

function checkRecentLogs(slotName) {
  const source = LOG_SOURCES[slotName];
  if (!source) return null;

  try {
    if (!fs.existsSync(source.logDir)) return null;
    const files = fs.readdirSync(source.logDir)
      .filter(f => f.endsWith('.log'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(source.logDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return null;

    const latest = files[0];
    // Skip if log is too old
    if (Date.now() - latest.mtime > source.maxAgeMs) return null;

    // Read last 10KB of the file for efficiency
    const filePath = path.join(source.logDir, latest.name);
    const stat = fs.statSync(filePath);
    const readStart = Math.max(0, stat.size - 10240);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(Math.min(10240, stat.size));
    fs.readSync(fd, buf, 0, buf.length, readStart);
    fs.closeSync(fd);
    const tail = buf.toString('utf8');

    if (source.errorPattern.test(tail)) {
      // Extract the most recent matching line
      const lines = tail.split('\n').filter(l => source.errorPattern.test(l));
      const lastLine = lines[lines.length - 1] ?? '';
      // Pull out the concise error
      const match = lastLine.match(/error=(Too Many Requests|quota exceeded[^"]*)/i)
                 ?? lastLine.match(/(Too Many Requests[^"\n]{0,60})/i)
                 ?? lastLine.match(/(quota exceeded[^"\n]{0,60})/i);
      const detail = match ? match[1] : 'quota/rate-limit error in recent logs';
      return { status: 'QUOTA_EXCEEDED', detail: `[from logs] ${detail}` };
    }
    return null;
  } catch (_) { return null; }
}

// ─── Probe a single provider ─────────────────────────────────────────────────

async function probeProvider(provider, quick) {
  const name = provider.name;

  // Shared spawn-target resolver (issue #197): resolvedCli → resolveCli(cli || mainTool),
  // so slots that define only `mainTool` are not falsely reported UNREACHABLE.
  const spawnTarget = resolveSpawnTarget(provider) || provider.cli;

  // Quick mode: just --version
  if (quick) {
    const healthArgs = provider.health_check_args ?? ['--version'];
    const result = await runCommand(spawnTarget, healthArgs, 10000, provider.env);
    const version = result.output.trim().split('\n')[0];
    return {
      slot: name,
      status: result.ok ? 'OK' : 'UNREACHABLE',
      version: result.ok ? version : null,
      latencyMs: result.latencyMs,
      detail: result.ok ? null : result.error,
    };
  }

  // Deep probe: send actual prompt, check for PROBE_OK in output
  const probe = provider.deep_probe ?? { prompt: 'respond with: PROBE_OK', expect: 'PROBE_OK', timeout_ms: 45000 };
  // Resolve the args_template (explicit field → canonical family default). A null
  // here means an unknown family with no template — report MISCONFIGURED explicitly
  // rather than probing with empty argv (which would mask the config error).
  const argsTemplate = resolveArgsTemplate(provider);
  if (!Array.isArray(argsTemplate)) {
    return {
      slot: name, status: 'MISCONFIGURED', version: null, latencyMs: 0,
      detail: `no args_template and family '${provider.mainTool || '?'}' has no canonical default — fix providers.json`,
    };
  }
  const args  = argsTemplate.map(a => (a === '{prompt}' ? probe.prompt : a));
  const result = await runCommand(spawnTarget, args, probe.timeout_ms, provider.env);
  const combined = result.output;

  // Check for error patterns first
  const errorClass = classifyOutput(combined);
  if (errorClass) {
    // Extract the most relevant error line
    const lines = combined.split('\n').filter(l => l.trim());
    const errorLine = lines.find(l => {
      const lower = l.toLowerCase();
      return ERROR_PATTERNS.some(({ patterns }) => patterns.some(p => lower.includes(p)));
    }) ?? lines[lines.length - 1];

    return {
      slot: name,
      status: errorClass,
      latencyMs: result.latencyMs,
      detail: (errorLine ?? '').trim().slice(0, 120),
    };
  }

  // Check for expected response
  if (result.error === 'TIMEOUT') {
    // Some CLIs (like opencode) show errors in TUI, not stderr.
    // Check their log files for recent quota/auth errors.
    const logCheck = checkRecentLogs(name);
    if (logCheck) {
      return { slot: name, status: logCheck.status, latencyMs: result.latencyMs, detail: logCheck.detail };
    }
    return { slot: name, status: 'TIMEOUT', latencyMs: result.latencyMs, detail: `No response in ${probe.timeout_ms}ms` };
  }

  const hasExpected = combined.includes(probe.expect);
  return {
    slot: name,
    status: hasExpected ? 'OK' : 'UNKNOWN',
    latencyMs: result.latencyMs,
    detail: hasExpected ? null : combined.trim().slice(0, 120),
  };
}

// ─── Display ─────────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  magenta:'\x1b[35m',
};

const STATUS_DISPLAY = {
  OK:             { icon: '●', color: C.green,   label: 'OK' },
  QUOTA_EXCEEDED: { icon: '◆', color: C.yellow,  label: 'QUOTA' },
  NO_CREDITS:     { icon: '◆', color: C.yellow,  label: 'NO CREDITS' },
  AUTH_ERROR:     { icon: '✗', color: C.red,     label: 'AUTH ERROR' },
  FORMAT_ERROR:   { icon: '✗', color: C.red,     label: 'FORMAT ERR' },
  TIMEOUT:        { icon: '◌', color: C.dim,     label: 'TIMEOUT' },
  UNREACHABLE:    { icon: '✗', color: C.red,     label: 'UNREACHABLE' },
  UNKNOWN:        { icon: '?', color: C.magenta, label: 'UNKNOWN' },
};

function printTable(results, providers) {
  const tag    = 'nForma · Provider Status';
  const border = '─'.repeat(tag.length + 4);
  console.log(`\n  ${C.cyan}╭${border}╮${C.reset}`);
  console.log(`  ${C.cyan}│${C.reset}  ${C.bold}${tag}${C.reset}  ${C.cyan}│${C.reset}`);
  console.log(`  ${C.cyan}╰${border}╯${C.reset}\n`);

  for (const r of results) {
    const p    = providers.find(p => p.name === r.slot);
    const disp = STATUS_DISPLAY[r.status] ?? STATUS_DISPLAY.UNKNOWN;
    const model = (p?.model ?? '').split('/').pop().slice(0, 25);
    const slot  = r.slot.padEnd(10);
    const label = disp.label.padEnd(12);
    const ms    = r.latencyMs ? `${C.dim}${(r.latencyMs / 1000).toFixed(1)}s${C.reset}` : '';

    console.log(`  ${disp.color}${disp.icon}${C.reset}  ${C.bold}${slot}${C.reset}  ${disp.color}${label}${C.reset}  ${C.dim}${model.padEnd(26)}${C.reset}  ${ms}`);
    if (r.detail) {
      console.log(`     ${C.dim}${r.detail}${C.reset}`);
    }
  }

  const ok    = results.filter(r => r.status === 'OK').length;
  const total = results.length;
  const color = ok === total ? C.green : ok > 0 ? C.yellow : C.red;
  console.log(`\n  ${color}${ok}/${total} operational${C.reset}\n`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const argv    = process.argv.slice(2);
  const getArg  = (f) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] ? argv[i + 1] : null; };
  const quick   = argv.includes('--quick');
  const jsonOut = argv.includes('--json');
  const slotsArg = getArg('--slots');

  const providers = loadProviders();
  if (!providers) {
    process.stderr.write('[provider-status] Could not find providers.json\n');
    process.exit(1);
  }

  let targets = providers.filter(p => p.type === 'subprocess');
  if (slotsArg) {
    const names = slotsArg.split(',').map(s => s.trim());
    targets = targets.filter(p => names.includes(p.name));
  }

  if (!jsonOut) {
    const mode = quick ? 'quick (--version)' : 'deep probe';
    process.stderr.write(`  Probing ${targets.length} slots (${mode})...\n\n`);
  }

  const results = await Promise.all(targets.map(p => probeProvider(p, quick)));

  if (jsonOut) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  } else {
    printTable(results, providers);
  }
}

main().catch(err => {
  process.stderr.write(`[provider-status] ${err.message}\n`);
  process.exit(1);
});

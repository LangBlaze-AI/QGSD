#!/usr/bin/env node
// nf-slot-health-probe.js — probe each nForma quorum slot (MCP server) for responsiveness.
//
// For each slot present in BOTH ~/.claude.json mcpServers AND ~/.claude/nf/bin/providers.json,
// spawn the MCP server with the slot's env and send a JSON-RPC `initialize` over stdio.
// Success = a well-formed response within the timeout. Writes the cache atomically to
// ~/.claude/nf/slot-health.json. Statusline reads that cache and renders ●/⊘/○/·.
//
// Designed to run as a SessionStart hook fire-and-forget. Total budget ~10s.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// SessionStart hooks receive a JSON payload on stdin that includes a workspace cwd.
// Read it so the profile gate can pick up project-level `hook_profile: minimal` from the
// right .planning/ — falling back to process.cwd() when:
//   - stdin is a TTY (manual invocation with --print, would block on read)
//   - the payload is empty or not JSON
function readStdinSync() {
  if (process.stdin.isTTY) return null; // never block on the terminal
  try {
    const buf = fs.readFileSync(0, 'utf8'); // fd 0 = stdin
    return buf ? JSON.parse(buf) : null;
  } catch (_) { return null; }
}
const stdinPayload = readStdinSync();
const stdinCwd = (stdinPayload && (stdinPayload.workspace?.current_dir || stdinPayload.cwd)) || null;

// Profile gate — opt-out on `minimal`, on by default on `standard`/`strict`.
try {
  const { loadConfig, shouldRunHook } = require('./config-loader');
  const cfg = loadConfig(stdinCwd || process.cwd());
  const profile = cfg.hook_profile || 'standard';
  if (!shouldRunHook('nf-slot-health-probe', profile)) process.exit(0);
} catch (_) { /* config-loader missing on first install; fail-open */ }

const HOME = os.homedir();
const CACHE = path.join(HOME, '.claude', 'nf', 'slot-health.json');
const PER_SLOT_TIMEOUT_MS = 5000;
const TOTAL_BUDGET_MS = 10000;
const STDOUT_BUFFER_CAP = 64 * 1024; // bound to 64 KiB — beyond that, drop oldest data

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }

function probeSlot(name, mcpEntry, deadlineMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    let child;
    try {
      child = spawn(mcpEntry.command, mcpEntry.args || [], {
        env: { ...process.env, ...(mcpEntry.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ ok: false, latency_ms: 0, error: 'spawn:' + e.message });
    }

    // Incremental line buffer: carry over the last partial line and parse complete lines only.
    // Bounded to STDOUT_BUFFER_CAP so a noisy server can't blow out memory; we only need to find
    // a single line containing the JSON-RPC response to id:1.
    let pending = '';
    let stderrSawData = false;
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve(result);
    };

    child.stdout.on('data', (d) => {
      pending += d.toString();
      if (pending.length > STDOUT_BUFFER_CAP) pending = pending.slice(-STDOUT_BUFFER_CAP);
      const lastNl = pending.lastIndexOf('\n');
      if (lastNl < 0) return; // no complete line yet
      const complete = pending.slice(0, lastNl);
      pending = pending.slice(lastNl + 1);
      for (const line of complete.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg && msg.id === 1 && msg.result) {
            return finish({ ok: true, latency_ms: Date.now() - start });
          }
          if (msg && msg.id === 1 && msg.error) {
            // Truncate error message to a fixed length so we can't accidentally persist secrets
            // bundled into a verbose JSON-RPC error payload.
            return finish({ ok: false, latency_ms: Date.now() - start, error: 'init_error:' + (msg.error.message || 'unspecified').slice(0, 120) });
          }
        } catch (_) { /* not valid JSON, skip */ }
      }
    });
    // Note: we observe stderr only as a "saw any" signal, NOT to persist its content.
    // MCP server stderr can include tokens, prompts, or endpoints — never write to disk cache.
    child.stderr.on('data', () => { stderrSawData = true; });
    child.on('error', (e) => finish({ ok: false, latency_ms: Date.now() - start, error: 'spawn_err:' + e.message.slice(0, 120) }));
    child.on('exit', (code, sig) => {
      if (!done) finish({
        ok: false,
        latency_ms: Date.now() - start,
        error: 'exited:' + (code != null ? 'code=' + code : 'sig=' + sig) + (stderrSawData ? ' (stderr emitted)' : ''),
      });
    });

    const init = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'nf-slot-health-probe', version: '0.1' },
      },
    });
    try { child.stdin.write(init + '\n'); } catch (_) { /* will be caught by error/exit */ }

    const slotDeadline = Math.min(start + PER_SLOT_TIMEOUT_MS, deadlineMs);
    setTimeout(() => finish({ ok: false, latency_ms: Date.now() - start, error: 'timeout' }), Math.max(0, slotDeadline - Date.now()));
  });
}

async function main() {
  const claudeJson = readJson(path.join(HOME, '.claude.json')) || { mcpServers: {} };
  const providersData = readJson(path.join(HOME, '.claude', 'nf', 'bin', 'providers.json')) || { providers: [] };

  // Guard against malformed providers.json (missing/non-array `providers`). Default to []
  // so a malformed file is treated as "nothing to probe" rather than crashing the hook.
  const providersList = Array.isArray(providersData.providers) ? providersData.providers : [];
  const providerNames = new Set(providersList.map(p => p && p.name).filter(Boolean));
  const mcpServers = claudeJson.mcpServers || {};

  // Only probe slots that are in BOTH providers.json (claimed as nForma slots) AND mcpServers (registered).
  const targets = Object.entries(mcpServers)
    .filter(([name]) => providerNames.has(name))
    .map(([name, entry]) => ({ name, entry }));

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const results = await Promise.all(targets.map(async ({ name, entry }) => {
    const r = await probeSlot(name, entry, deadline);
    return [name, r];
  }));

  const slots = {};
  for (const [name, r] of results) slots[name] = r;

  // Atomic write
  const cacheDir = path.dirname(CACHE);
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (_) {}
  const tmp = CACHE + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ checked_at: new Date().toISOString(), slots }, null, 2) + '\n');
  fs.renameSync(tmp, CACHE);

  if (process.argv.includes('--print')) {
    for (const [name, r] of results) console.log(`${r.ok ? '●' : '⊘'} ${name.padEnd(18)} ${r.latency_ms}ms${r.error ? '  err=' + r.error : ''}`);
  }
}

main().catch(e => { process.stderr.write('[nf-slot-health-probe] ' + (e?.stack || e) + '\n'); process.exit(1); });

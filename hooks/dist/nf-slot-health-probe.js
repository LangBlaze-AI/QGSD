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

// Profile gate — opt-out on `minimal`, on by default on `standard`/`strict`.
try {
  const { loadConfig, shouldRunHook } = require('./config-loader');
  const cfg = loadConfig(process.cwd());
  const profile = cfg.hook_profile || 'standard';
  if (!shouldRunHook('nf-slot-health-probe', profile)) process.exit(0);
} catch (_) { /* config-loader missing on first install; fail-open */ }

const HOME = os.homedir();
const CACHE = path.join(HOME, '.claude', 'nf', 'slot-health.json');
const PER_SLOT_TIMEOUT_MS = 5000;
const TOTAL_BUDGET_MS = 10000;

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

    let out = '';
    let done = false;
    let stderrTail = '';

    const finish = (result) => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve(result);
    };

    child.stdout.on('data', (d) => {
      out += d.toString();
      // Look for the response to our init call: jsonrpc + id:1 + result
      // Any line containing "id":1 with a "result" key counts as a successful handshake.
      const lines = out.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg && msg.id === 1 && msg.result) {
            return finish({ ok: true, latency_ms: Date.now() - start });
          }
          if (msg && msg.id === 1 && msg.error) {
            return finish({ ok: false, latency_ms: Date.now() - start, error: 'init_error:' + (msg.error.message || JSON.stringify(msg.error)).slice(0, 120) });
          }
        } catch (_) { /* not a complete JSON message yet */ }
      }
    });
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-500); });
    child.on('error', (e) => finish({ ok: false, latency_ms: Date.now() - start, error: 'spawn_err:' + e.message }));
    child.on('exit', (code, sig) => {
      if (!done) finish({ ok: false, latency_ms: Date.now() - start, error: 'exited:' + (code != null ? 'code=' + code : 'sig=' + sig) + (stderrTail ? ' stderr=' + stderrTail.slice(0, 80) : '') });
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

  const providerNames = new Set(providersData.providers.map(p => p.name));
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

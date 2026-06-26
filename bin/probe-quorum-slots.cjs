#!/usr/bin/env node
'use strict';

/**
 * probe-quorum-slots.cjs — parallel reachability probe for quorum slots
 *
 * Usage:
 *   node probe-quorum-slots.cjs --slots slot1,slot2,slot3 [--timeout 8000] [--cwd <dir>]
 *
 * Spawns each slot's CLI with a minimal "OK" prompt and a short timeout.
 * All slots are probed in parallel (Promise.all).
 *
 * Output (stdout): JSON array of { slot, healthy, latencyMs, error }
 *   healthy: true  → CLI responded within timeout (any exit code)
 *   healthy: false → CLI timed out or failed to spawn
 *
 * Only probes type=subprocess slots. HTTP slots are skipped (marked healthy=true by default).
 * Exit code: always 0 — caller interprets the JSON to decide what to skip.
 */

const { spawn } = require('child_process');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const { resolveSpawnTarget } = require('./resolve-cli.cjs');
const { resolveEnvPlaceholders } = require('./resolve-env.cjs');
const { loadProviders } = require('./resolve-providers.cjs');
const { resolveArgsTemplate } = require('./provider-arg-templates.cjs');

// ─── Find providers.json ─────────────────────────────────────────────────────
// Delegates to the single source of truth in resolve-providers.cjs (issue #197).
// Canonical installed path: ~/.claude/nf-bin/providers.json
// (`'.claude', 'nf-bin', 'providers.json'`).
function findProviders() {
  return loadProviders({ baseDir: __dirname });
}

// ─── Kill entire process group (mirrors call-quorum-slot.cjs killGroup) ──────
function makeKillGroup(child) {
  return () => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (_) { try { child.kill('SIGTERM'); } catch (_) {} }
    setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (_) {} }
      try { child.stdout.destroy(); } catch (_) {}
      try { child.stderr.destroy(); } catch (_) {}
    }, 1000);
  };
}

// ─── Probe a single subprocess slot ──────────────────────────────────────────
function probeSlot(provider, timeoutMs, spawnCwd) {
  return new Promise((resolve) => {
    const start = Date.now();

    // Replace {prompt} with the minimal probe string (canonical fallback when the
    // provider entry lacks args_template — avoids the opaque `.map` of undefined).
    const args = (resolveArgsTemplate(provider) || []).map(a => (a === '{prompt}' ? 'OK' : a));
    // Resolve ${VAR} placeholders in provider.env (issue parity with
    // call-quorum-slot.cjs:462 / unified-mcp-server.mjs) — a secret-placeholder
    // slot was previously probed with an UNRESOLVED env and false-failed.
    const env  = { ...process.env, ...resolveEnvPlaceholders(provider.env ?? {}) };

    // Shared spawn-target resolver (issue #197): resolvedCli → resolveCli(cli || mainTool).
    // `cli` is optional in providers.json; this never hands null to spawn().
    const spawnTarget = resolveSpawnTarget(provider);
    if (!spawnTarget) {
      resolve({ slot: provider.name, healthy: false, latencyMs: Date.now() - start, error: 'spawn: no resolvable CLI (cli, resolvedCli, and mainTool all empty)' });
      return;
    }

    let child;
    try {
      child = spawn(spawnTarget, args, {
        env,
        cwd:      spawnCwd,
        stdio:    ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      resolve({ slot: provider.name, healthy: false, latencyMs: Date.now() - start, error: `spawn: ${err.message}` });
      return;
    }

    child.stdin.end(); // non-interactive

    let stdout   = '';
    let stderr   = '';
    let timedOut = false;

    const killGroup = makeKillGroup(child);

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d.toString().slice(0, 1024); });
    child.stderr.on('data', d => { stderr += d.toString().slice(0,  512); });

    child.on('close', (code) => {
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      if (timedOut) {
        resolve({ slot: provider.name, healthy: false, latencyMs, error: `TIMEOUT after ${timeoutMs}ms` });
      } else {
        // Any response (even exit code ≠ 0) counts as "reachable" — the CLI started and ran.
        // Only a timeout means the slot is truly unreachable.
        resolve({ slot: provider.name, healthy: true, latencyMs, error: code !== 0 ? `exit ${code}` : null });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ slot: provider.name, healthy: false, latencyMs: Date.now() - start, error: `spawn: ${err.message}` });
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const argv   = process.argv.slice(2);
  const getArg = (f) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] ? argv[i + 1] : null; };

  const slotsArg  = getArg('--slots');
  const timeoutMs = Math.max(1000, parseInt(getArg('--timeout') || '8000', 10));
  const spawnCwd  = getArg('--cwd') ?? process.cwd();

  if (!slotsArg) {
    process.stderr.write('Usage: node probe-quorum-slots.cjs --slots slot1,slot2 [--timeout 8000] [--cwd <dir>]\n');
    process.exit(1);
  }

  const providers = findProviders();
  if (!providers) {
    process.stderr.write('[probe-quorum-slots] Could not find providers.json — skipping probe\n');
    // Fail-open: emit empty array so caller treats all slots as healthy
    process.stdout.write('[]\n');
    process.exit(0);
  }

  if (providers.length === 0) {
    process.stderr.write('[probe-quorum-slots] No providers configured in providers.json — skipping probe\n');
    process.stdout.write('[]\n');
    process.exit(0);
  }

  const slotNames = slotsArg.split(',').map(s => s.trim()).filter(Boolean);

  const results = await Promise.all(
    slotNames.map(name => {
      const provider = providers.find(p => p.name === name);
      if (!provider) {
        // Unknown slot — treat as healthy (fail-open)
        return Promise.resolve({ slot: name, healthy: true, latencyMs: 0, error: 'unknown slot — skipped' });
      }
      if (provider.type !== 'subprocess') {
        // HTTP slots are not probed — treat as healthy
        return Promise.resolve({ slot: name, healthy: true, latencyMs: 0, error: null });
      }
      return probeSlot(provider, timeoutMs, spawnCwd);
    })
  );

  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`[probe-quorum-slots] Fatal: ${err.message}\n`);
  // Fail-open on unexpected errors
  process.stdout.write('[]\n');
  process.exit(0);
});

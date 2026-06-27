#!/usr/bin/env node
'use strict';

// Guards the fix for: "/nf:mcp-repair (and /nf:mcp-restart) don't update the statusline."
//
// The statusline is a PURE CACHE READ of ~/.claude/nf/slot-health.json with a 5-minute
// freshness window (hooks/nf-statusline.js: SLOT_FRESH_MS). mcp-repair / mcp-restart fix
// slot connectivity but, before this fix, never refreshed that cache — so a just-repaired
// slot kept rendering its stale pre-repair status (a red ⊘ + "/nf:mcp-restart" CTA) for
// up to 5 minutes. The fix: both skills re-run nf-slot-health-probe.js at the end to
// rewrite the cache.
//
// This suite proves BOTH halves:
//   (1) behavioural — running the probe rewrites a STALE, failing cache to current/healthy
//       (the mechanism the skills invoke), and
//   (2) contract    — both skills actually invoke the probe to refresh the cache.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const PROBE = path.join(REPO, 'hooks', 'nf-slot-health-probe.js');

// A minimal MCP server: answers the probe's `id:1 initialize` with a `result` (= healthy).
const FAKE_MCP = `'use strict';
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (m && m.id === 1 && m.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1,
          result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }) + '\\n');
      }
    } catch (_) { /* ignore */ }
  }
});
`;

function runProbe(homeDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROBE, '--print'], {
      cwd: homeDir, // no .planning here → profile gate defaults to 'standard' (runs)
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} reject(new Error('probe timed out')); }, 20000);
    child.stdin.end(); // close stdin so the probe's readStdinSync() gets EOF (doesn't block)
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('exit', () => { clearTimeout(killer); resolve(); });
  });
}

test('nf-slot-health-probe rewrites a STALE failing cache to current/healthy (the refresh mechanism)', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-slothealth-'));
  try {
    // Fake MCP server the slot points at.
    const fakeServer = path.join(homeDir, 'fake-mcp.js');
    fs.writeFileSync(fakeServer, FAKE_MCP);

    // ~/.claude.json — slot registered, pointing at the fake server.
    fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({
      mcpServers: { 'fake-1': { command: process.execPath, args: [fakeServer] } },
    }));

    // ~/.claude/nf-bin/providers.json — slot claimed as an nForma slot.
    const nfBin = path.join(homeDir, '.claude', 'nf-bin');
    fs.mkdirSync(nfBin, { recursive: true });
    fs.writeFileSync(path.join(nfBin, 'providers.json'), JSON.stringify({ providers: [{ name: 'fake-1' }] }));

    // Pre-existing STALE cache: slot marked failed, ancient timestamp (the pre-repair state).
    const cachePath = path.join(homeDir, '.claude', 'nf', 'slot-health.json');
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const STALE_TS = '2020-01-01T00:00:00.000Z';
    fs.writeFileSync(cachePath, JSON.stringify({
      checked_at: STALE_TS,
      slots: { 'fake-1': { ok: false, latency_ms: 0, error: 'stale-failure' } },
    }));

    await runProbe(homeDir);

    const after = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    // The cache must have been rewritten with a fresh timestamp...
    assert.notEqual(after.checked_at, STALE_TS, 'probe must rewrite checked_at (stale cache not refreshed)');
    const ageMs = Date.now() - Date.parse(after.checked_at);
    assert.ok(ageMs >= 0 && ageMs < 60_000, `checked_at must be recent, got age ${ageMs}ms`);
    // ...and the slot must now read healthy (was ok:false in the stale cache).
    assert.ok(after.slots && after.slots['fake-1'], 'slot entry must be present after probe');
    assert.equal(after.slots['fake-1'].ok, true,
      'a now-reachable slot must read ok:true after the refresh (was a stale ok:false)');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

// Contract: both skills must invoke the probe so the statusline cache is refreshed.
for (const skill of ['mcp-repair.md', 'mcp-restart.md']) {
  test(`commands/nf/${skill} refreshes the statusline slot-health cache after acting`, () => {
    const md = fs.readFileSync(path.join(REPO, 'commands', 'nf', skill), 'utf8');
    assert.match(md, /nf-slot-health-probe\.js/,
      `${skill} must invoke nf-slot-health-probe.js to refresh ~/.claude/nf/slot-health.json — ` +
      'otherwise the statusline shows stale slot health for up to 5 minutes after the action');
    // Uses the portable installed path with a CWD fallback (no hardcoded /Users/... homedir).
    assert.match(md, /\$HOME\/\.claude\/hooks\/nf-slot-health-probe\.js/,
      `${skill} must reference the probe via $HOME/.claude/hooks (portable), not a hardcoded path`);
    assert.doesNotMatch(md, /\/(Users|home)\/[^/\n]+\/\.claude/,
      `${skill} must not hardcode an absolute home directory`);
  });
}

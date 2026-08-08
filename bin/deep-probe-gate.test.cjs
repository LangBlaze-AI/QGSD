#!/usr/bin/env node
'use strict';
// bin/deep-probe-gate.test.cjs — P1 of #293, extracted fresh.
//
// L1 (`--version`) proves a binary exists; L2 (`/models`) treats 401/403 as reachable.
// Neither can tell a quota-dead slot from a healthy one. Demonstrated live on
// 2026-08-08: preflight reported 7/7 available while claude-z-ai (429, weekly limit)
// and antigravity-1 (quota, 74h to reset) could not answer at all.
//
// The rule is deliberately LOPSIDED, because the opposite error is the one this codebase
// has already paid for three times (STALL-TIMEOUT-01..03): killing a slow-but-alive slot.
//   downgrade ONLY on a fast, explicit auth/quota signal from the slot's own output.
//   timeout / spawn error / unrecognised output = INCONCLUSIVE, never a downgrade.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deepProbeSlot, DOWNGRADE_STATUSES } = require('./quorum-preflight.cjs');
const { classifyOutput } = require('./provider-status.cjs');

const TMP = [];
process.on('exit', () => { for (const d of TMP) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } });

function slotEmitting(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-dp-'));
  TMP.push(dir);
  const cli = path.join(dir, 'fake.cjs');
  fs.writeFileSync(cli, body, 'utf8');
  return { name: 't', type: 'subprocess', mainTool: 'node', cli: 'node',
           args_template: [cli, '{prompt}'], deep_probe: { prompt: 'hi', timeout_ms: 30000 } };
}

test('DPG-1: an explicit quota signal downgrades', async () => {
  const p = slotEmitting("process.stdout.write('API Error: Request rejected (429) Weekly Limit Exhausted\\n');process.exit(1);");
  const r = await deepProbeSlot(p, 10000);
  assert.strictEqual(r.downgrade, true);
  assert.strictEqual(r.status, 'QUOTA_EXCEEDED');
});

test('DPG-2: a SLOW but alive slot is never downgraded — the whole point', async () => {
  // The failure this must not reproduce. A 30s thinker probed with a 1s budget is
  // inconclusive, not dead.
  const p = slotEmitting("setTimeout(()=>process.stdout.write('PROBE_OK\\n'), 30000);");
  const r = await deepProbeSlot(p, 1200);
  assert.strictEqual(r.downgrade, false, 'a timeout must never downgrade a slot');
  assert.strictEqual(r.status, 'INCONCLUSIVE');
  assert.match(r.reason, /slow is not dead/);
});

test('DPG-3: a spawn failure is inconclusive, not a downgrade', async () => {
  const p = { name: 't', type: 'subprocess', mainTool: 'definitely-not-a-real-binary-xyz',
              cli: '/nonexistent/xyz', args_template: ['{prompt}'], deep_probe: { prompt: 'hi' } };
  const r = await deepProbeSlot(p, 5000);
  assert.strictEqual(r.downgrade, false, 'an unrunnable probe says nothing about slot health');
});

test('DPG-4: a healthy slot stays available', async () => {
  const r = await deepProbeSlot(slotEmitting("process.stdout.write('PROBE_OK\\n');"), 10000);
  assert.strictEqual(r.downgrade, false);
  assert.strictEqual(r.status, 'OK');
});

test('DPG-5: a slot with no deep_probe is skipped, not guessed at', async () => {
  const p = slotEmitting("process.stdout.write('PROBE_OK\\n');");
  delete p.deep_probe;
  const r = await deepProbeSlot(p, 5000);
  assert.strictEqual(r.probed, false);
});

test('DPG-6: the downgrade reason is the MATCHING line, not trailing noise', async () => {
  // First live run blamed "SessionEnd hook failed" for what was a 429, because it
  // quoted the last line of output. A wrong cause is worse than no cause.
  const p = slotEmitting(
    "process.stdout.write('API Error: Request rejected (429) Limit Exhausted\\n');" +
    "process.stdout.write('SessionEnd hook failed: Hook cancelled\\n');process.exit(1);");
  const r = await deepProbeSlot(p, 10000);
  assert.match(r.reason, /429/);
  assert.doesNotMatch(r.reason, /SessionEnd/);
});

test('DPG-7: only auth/quota classes may downgrade', () => {
  // A format error or an unknown response must not retire a slot.
  assert.ok(DOWNGRADE_STATUSES.has('QUOTA_EXCEEDED'));
  assert.ok(DOWNGRADE_STATUSES.has('AUTH_ERROR'));
  assert.ok(!DOWNGRADE_STATUSES.has('FORMAT_ERROR'), 'a malformed request is not a dead slot');
  assert.ok(!DOWNGRADE_STATUSES.has('TIMEOUT'));
});

test('DPG-8: the classifier recognises the real messages that motivated this', () => {
  // 'quota exceeded' alone missed antigravity's "Individual quota reached" — the slot
  // was reported healthy with 74h of cooldown remaining.
  assert.strictEqual(classifyOutput('Error: Individual quota reached. Resets in 74h38m39s.'), 'QUOTA_EXCEEDED');
  assert.strictEqual(classifyOutput('Weekly/Monthly Limit Exhausted'), 'QUOTA_EXCEEDED');
  assert.strictEqual(classifyOutput('Failed to refresh token: 401 Unauthorized'), 'AUTH_ERROR');
  // And must not fire on ordinary prose a model might emit.
  assert.strictEqual(classifyOutput('I reached the conclusion that the limit is fine'), null);
  assert.strictEqual(classifyOutput('PROBE_OK'), null);
});

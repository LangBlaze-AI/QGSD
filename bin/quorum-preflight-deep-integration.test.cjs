'use strict';

// P1 — LIVE deep-probe integration harness. Spawns a real (mock) provider CLI through
// deepProbeSlot and asserts the end-to-end classification. This is the harness that was
// deferred when P1's policy landed; it exercises the actual subprocess path, not just the
// pure classifier. The reviewers' "quota-dead slot blocked before review" case is the
// quota test below (deep probe downgrades → the P3 gate would then block).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { deepProbeSlot, computeQuorumGate } = require('./quorum-preflight.cjs');

const MOCK = path.join(__dirname, '__deep-probe-mock.cjs');
try { fs.chmodSync(MOCK, 0o755); } catch (_) {}

function mockProvider(mode, extra = {}) {
  return {
    name: `mock-${mode}`,
    type: 'subprocess',
    resolvedCli: MOCK,                 // resolveSpawnTarget prefers resolvedCli (absolute)
    args_template: ['{prompt}'],       // honored verbatim by resolveArgsTemplate
    deep_probe: { prompt: 'respond with: PROBE_OK', expect: 'PROBE_OK', timeout_ms: 4000 },
    env: { MOCK_MODE: mode, ...extra },
  };
}

describe('deepProbeSlot — live spawn classification (integration)', () => {
  it('healthy slot (prints PROBE_OK) → ok, OK', async () => {
    const r = await deepProbeSlot(mockProvider('probe_ok'), 10000);
    assert.equal(r.ok, true);
    assert.equal(r.classification, 'OK');
  });

  it('quota-dead slot (429/RESOURCE_EXHAUSTED) → DOWNGRADED (the L1/L2-missed case)', async () => {
    const r = await deepProbeSlot(mockProvider('quota'), 10000);
    assert.equal(r.ok, false);
    assert.equal(r.classification, 'QUOTA');
  });

  it('auth-dead slot (401) → DOWNGRADED', async () => {
    const r = await deepProbeSlot(mockProvider('auth'), 10000);
    assert.equal(r.ok, false);
    assert.equal(r.classification, 'AUTH');
  });

  it('slow-but-healthy slot (preamble, ~1.5s pause, then PROBE_OK) → ok, NOT killed', async () => {
    // The P2 shape at the deep-probe layer: a short preamble then a pause. Must pass.
    const r = await deepProbeSlot(mockProvider('slow_ok', { MOCK_DELAY_MS: '1500' }), 10000);
    assert.equal(r.ok, true);
    assert.equal(r.classification, 'OK');
  });

  it('hung slot (preamble then silence) → timeout is INCONCLUSIVE, never downgraded (P2-safe)', async () => {
    // A tight per-probe timeout fires; a timeout must NOT downgrade (would re-create the
    // slow-slot false-kill). ok stays true.
    const prov = mockProvider('hang');
    prov.deep_probe = { prompt: 'x', expect: 'PROBE_OK', timeout_ms: 800 };
    const r = await deepProbeSlot(prov, 10000);
    assert.equal(r.ok, true);
    assert.equal(r.classification, 'INCONCLUSIVE');
  });

  it('unspawnable slot (no target) → SKIP, never false-kills', async () => {
    const r = await deepProbeSlot({ name: 'x', type: 'subprocess', args_template: ['{prompt}'] }, 10000);
    assert.equal(r.ok, true);
    assert.equal(r.classification, 'SKIP');
  });

  it('E2E (reviewers\' key test): a quota-dead slot is downgraded → gate BLOCKS before review', async () => {
    // 3 slots pass L1/L2, max_quorum_size=3, but one is quota-dead. The deep probe catches
    // it (L1/L2 could not), dropping available to 2/3 → computeQuorumGate blocks. Without the
    // deep gate this quorum would have dispatched a real review on a dead slot.
    const slots = ['probe_ok', 'probe_ok', 'quota'];
    const results = await Promise.all(slots.map((m) =>
      deepProbeSlot(mockProvider(m), 10000).then(r => ({ m, r }))));
    let available = slots.length;
    for (const { r } of results) if (r.ok === false) available -= 1;
    assert.equal(available, 2, 'the quota-dead slot must be downgraded by the deep probe');
    const gate = computeQuorumGate(available, 3, false);
    assert.equal(gate.blocked, true, 'reduced (2/3) panel must block before any review runs');
    assert.equal(gate.waiver_required, true);
  });
});

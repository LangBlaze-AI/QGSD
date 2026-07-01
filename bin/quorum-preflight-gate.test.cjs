'use strict';

// P3 — authoritative degraded-panel gate. Previously the "available < max_quorum_size →
// BLOCK unless --force-quorum" decision lived in quorum.md prose (LLM-interpreted), so a
// panel that collapsed to 1/7 could run 6 silent reduced rounds. computeQuorumGate makes
// it a deterministic, testable machine field.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeQuorumGate } = require('./quorum-preflight.cjs');

describe('computeQuorumGate — degraded-panel gate', () => {
  it('quorum met (available >= max): not blocked, not degraded', () => {
    const g = computeQuorumGate(5, 3, false);
    assert.equal(g.quorum_met, true);
    assert.equal(g.blocked, false);
    assert.equal(g.degraded, false);
    assert.equal(g.available_count, 5);
    assert.ok(!g.waiver_required);
  });

  it('exactly at threshold (available === max): met, not blocked', () => {
    const g = computeQuorumGate(3, 3, false);
    assert.equal(g.quorum_met, true);
    assert.equal(g.blocked, false);
    assert.equal(g.degraded, false);
  });

  it('degraded (1 <= available < max) without waiver: BLOCKED + waiver_required + degraded', () => {
    const g = computeQuorumGate(1, 3, false);
    assert.equal(g.quorum_met, false);
    assert.equal(g.blocked, true);
    assert.equal(g.waiver_required, true);
    assert.equal(g.degraded, true);
    assert.match(g.gate_reason, /only 1\/3/);
  });

  it('panel down (0 available) without waiver: BLOCKED, degraded=false (nothing to run)', () => {
    const g = computeQuorumGate(0, 3, false);
    assert.equal(g.blocked, true);
    assert.equal(g.waiver_required, true);
    assert.equal(g.degraded, false); // 0 slots is "panel down", not "degraded"
    assert.match(g.gate_reason, /panel down/);
  });

  it('--force-quorum waives a degraded panel: not blocked, waiver_used recorded', () => {
    const g = computeQuorumGate(1, 3, true);
    assert.equal(g.blocked, false);
    assert.equal(g.waiver_used, true);
    assert.ok(!g.waiver_required);
    assert.match(g.gate_reason, /WAIVED via --force-quorum/);
  });

  it('--force-quorum on a met quorum is a no-op (no spurious waiver_used)', () => {
    const g = computeQuorumGate(4, 3, true);
    assert.equal(g.blocked, false);
    assert.ok(!g.waiver_used); // waiver only recorded when it actually overrode a block
  });

  it('the production failure shape: 1 of 7 with default max 3 blocks unless forced', () => {
    // This is exactly the session that motivated P3 — codex-1 only, panel collapsed.
    const blocked = computeQuorumGate(1, 3, false);
    assert.equal(blocked.blocked, true, '1/7-style panel must block by default');
    const forced = computeQuorumGate(1, 3, true);
    assert.equal(forced.blocked, false, '--force-quorum must allow explicit reduced-quorum runs');
    assert.equal(forced.waiver_used, true);
  });
});

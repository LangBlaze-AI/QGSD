'use strict';

// P1 — deep inference probe policy (pure logic). The spawn is deferred to a
// harness-backed follow-up; these guard the safety-critical policy:
//   - downgrade a slot ONLY on a fast explicit auth/quota signal (what L1/L2 miss);
//   - a TIMEOUT is inconclusive and never downgrades (so a slow-but-healthy slot —
//     the P2 failure mode — is not re-killed by the deep probe);
//   - run the probe when --deep or when the panel is degraded, budget permitting.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { shouldRunDeepProbe, classifyDeepProbeResult } = require('./quorum-preflight.cjs');

describe('shouldRunDeepProbe — when to run the deep gate', () => {
  it('runs when --deep is set', () => {
    assert.equal(shouldRunDeepProbe({ deep: true, degraded: false, budgetMs: null }), true);
  });
  it('auto-runs on a degraded panel WITH an explicit sufficient budget (real dispatch path)', () => {
    assert.equal(shouldRunDeepProbe({ deep: false, degraded: true, budgetMs: 60000, minBudgetMs: 45000 }), true);
  });
  it('does NOT auto-run on degraded with no budget — the cheap --all --probe path stays fast', () => {
    // Regression guard: auto-running live deep probes in the budget-less liveness path
    // blew its <8s budget (spawnSync ETIMEDOUT). Auto-enable requires an explicit budget.
    assert.equal(shouldRunDeepProbe({ deep: false, degraded: true, budgetMs: null }), false);
  });
  it('does NOT run on a healthy panel with no --deep (happy path untouched)', () => {
    assert.equal(shouldRunDeepProbe({ deep: false, degraded: false, budgetMs: null }), false);
  });
  it('is skipped when the time budget cannot cover a probe', () => {
    assert.equal(shouldRunDeepProbe({ deep: true, degraded: true, budgetMs: 1000, minBudgetMs: 45000 }), false);
    assert.equal(shouldRunDeepProbe({ deep: true, degraded: true, budgetMs: 60000, minBudgetMs: 45000 }), true);
  });
});

describe('classifyDeepProbeResult — downgrade only on fast auth/quota', () => {
  it('downgrades on an explicit auth failure (401/403/unauthorized)', () => {
    assert.equal(classifyDeepProbeResult('HTTP 401 unauthorized').ok, false);
    assert.equal(classifyDeepProbeResult('Error: invalid api key').classification, 'AUTH');
  });
  it('downgrades on an explicit quota/rate-limit signal (429/quota/resource exhausted)', () => {
    assert.equal(classifyDeepProbeResult('RESOURCE_EXHAUSTED (code 429): quota reached').ok, false);
    assert.equal(classifyDeepProbeResult('429 Too Many Requests').classification, 'QUOTA');
  });
  it('does NOT downgrade on a timeout — inconclusive, protecting slow-but-healthy slots (P2)', () => {
    const r = classifyDeepProbeResult('', { timedOut: true });
    assert.equal(r.ok, true);
    assert.equal(r.classification, 'INCONCLUSIVE');
  });
  it('passes when the expected token is present', () => {
    const r = classifyDeepProbeResult('...\nPROBE_OK\n', { expect: 'PROBE_OK' });
    assert.equal(r.ok, true);
    assert.equal(r.classification, 'OK');
  });
  it('assumes alive on ambiguous non-error output (never false-kills on ambiguity)', () => {
    const r = classifyDeepProbeResult('some normal model chatter', { expect: 'PROBE_OK' });
    assert.equal(r.ok, true);
    assert.equal(r.classification, 'INCONCLUSIVE');
  });
  it('the antigravity-1 shape: fast 429 with reset → downgraded (the L1/L2-missed case)', () => {
    const r = classifyDeepProbeResult('RESOURCE_EXHAUSTED (code 429): Resets in 32h54m49s');
    assert.equal(r.ok, false);
    assert.equal(r.classification, 'QUOTA');
  });
});

'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { classifyDivergence, analyzeTrace } = require('./attribute-trace-divergence.cjs');

// ── classifyDivergence ────────────────────────────────────────────────────────

test('classifyDivergence: impl-bug when context has uninitialized count fields', () => {
  const ttrace = {
    event: { action: 'quorum_complete', slots_available: 5 },
    actualState: 'DECIDED',
    expectedState: 'DELIBERATING',
    divergenceType: 'state_mismatch',
    guardEvaluations: [{
      guardName: 'minQuorumMet',
      passed: false,
      context: { slotsAvailable: 5, successCount: 0, polledCount: null },
    }],
  };
  const result = classifyDivergence(ttrace);
  assert.ok(result.implBugConfidence > result.specBugConfidence,
    'impl-bug should be more likely when context has 0/null count fields');
  assert.equal(result.failingGuard, 'minQuorumMet');
  assert.ok(result.recommendation.includes('impl-bug'));
});

test('classifyDivergence: spec-bug when context is populated but guard still failed', () => {
  const ttrace = {
    event: { action: 'quorum_complete', slots_available: 5 },
    actualState: 'DECIDED',
    expectedState: 'DELIBERATING',
    divergenceType: 'state_mismatch',
    guardEvaluations: [{
      guardName: 'minQuorumMet',
      passed: false,
      context: { slotsAvailable: 5, successCount: 3, polledCount: 5 },
    }],
  };
  const result = classifyDivergence(ttrace);
  assert.ok(result.specBugConfidence >= result.implBugConfidence,
    'spec-bug should be more likely when context looks populated');
  assert.ok(result.recommendation.includes('spec-bug'));
});

test('classifyDivergence: unmappable_action always classified as impl-bug', () => {
  const ttrace = {
    event: { action: 'unknown_action' },
    actualState: 'IDLE',
    expectedState: 'COLLECTING_VOTES',
    divergenceType: 'unmappable_action',
    guardEvaluations: [],
  };
  const result = classifyDivergence(ttrace);
  assert.equal(result.implBugConfidence, 90);
  assert.equal(result.specBugConfidence, 10);
});

test('analyzeTrace: returns all required output fields', () => {
  const ttrace = {
    event: { action: 'quorum_complete' },
    actualState: 'DECIDED',
    expectedState: 'DELIBERATING',
    divergenceType: 'state_mismatch',
    guardEvaluations: [],
  };
  const result = analyzeTrace(ttrace, null, null);
  assert.ok('event_action' in result,       'event_action required');
  assert.ok('actual_state' in result,       'actual_state required');
  assert.ok('expected_state' in result,     'expected_state required');
  assert.ok('divergence_type' in result,    'divergence_type required');
  assert.ok('spec_bug_confidence' in result, 'spec_bug_confidence required');
  assert.ok('impl_bug_confidence' in result, 'impl_bug_confidence required');
  assert.ok('recommendation' in result,     'recommendation required');
  assert.ok(Array.isArray(result.evidence), 'evidence must be array');
});

test('classifyDivergence: no guardEvaluations falls back gracefully', () => {
  const ttrace = {
    event: { action: 'deliberation_round' },
    actualState: 'DELIBERATING',
    expectedState: 'DECIDED',
    divergenceType: 'state_mismatch',
    guardEvaluations: [],
  };
  // Must not throw; returns 50/50 split with no failing guard
  const result = classifyDivergence(ttrace);
  assert.equal(result.failingGuard, null);
  assert.ok(typeof result.specBugConfidence === 'number');
  assert.ok(typeof result.implBugConfidence === 'number');
});

// ── ATD-1 ─────────────────────────────────────────────────────────────────────

test('classifyDivergence: null / non-object ttrace fails open instead of throwing', () => {
  for (const bad of [null, undefined, 42, 'oops']) {
    assert.doesNotThrow(() => classifyDivergence(bad),
      `classifyDivergence(${JSON.stringify(bad)}) must not throw`);
    const result = classifyDivergence(bad);
    assert.ok(typeof result.specBugConfidence === 'number');
    assert.ok(typeof result.implBugConfidence === 'number');
    assert.ok(Array.isArray(result.evidence));
  }
});

test('analyzeTrace: null ttrace fails open with required output fields', () => {
  assert.doesNotThrow(() => analyzeTrace(null, null, null));
  const result = analyzeTrace(null, null, null);
  assert.ok('event_action' in result);
  assert.ok('spec_bug_confidence' in result);
  assert.ok(Array.isArray(result.evidence));
});

// ── ATD-2 ─────────────────────────────────────────────────────────────────────

test('classifyDivergence: null/primitive entries in guardEvaluations are skipped, not thrown', () => {
  const ttrace = {
    event: { action: 'quorum_complete' },
    actualState: 'DECIDED',
    expectedState: 'DELIBERATING',
    divergenceType: 'state_mismatch',
    guardEvaluations: [null, 'bad', { guardName: 'minQuorumMet', passed: false, context: { successCount: 0 } }],
  };
  assert.doesNotThrow(() => classifyDivergence(ttrace));
  const result = classifyDivergence(ttrace);
  assert.equal(result.failingGuard, 'minQuorumMet');
});

// ── ATD-3 ─────────────────────────────────────────────────────────────────────

test('classifyDivergence: non-array guardEvaluations is treated as empty, not thrown', () => {
  const ttrace = {
    event: { action: 'x' },
    actualState: 'A',
    expectedState: 'B',
    divergenceType: 'state_mismatch',
    guardEvaluations: { guardName: 'g', passed: false },
  };
  assert.doesNotThrow(() => classifyDivergence(ttrace));
  const result = classifyDivergence(ttrace);
  assert.equal(result.failingGuard, null);
});

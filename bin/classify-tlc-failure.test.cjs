'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyTlcFailure, FAILURE_CLASSES } = require('./classify-tlc-failure.cjs');

// ── classifyTlcFailure ──────────────────────────────────────────────────────

test('classifyTlcFailure exports FAILURE_CLASSES with 6 entries', () => {
  assert.equal(FAILURE_CLASSES.length, 6);
  assert.deepEqual(FAILURE_CLASSES, [
    'deadlock',
    'sany_semantic',
    'fairness_gap',
    'invariant_violation',
    'syntax_error',
    'unknown',
  ]);
});

// Test 1: Deadlock classification
test('classifyTlcFailure: deadlock when summary contains "Deadlock reached"', () => {
  const entry = {
    tool: 'run-tlc',
    formalism: 'tla',
    result: 'fail',
    check_id: 'tla:deadlock-test',
    surface: 'tla',
    property: 'Liveness',
    runtime_ms: 1000,
    summary: 'Error: Deadlock reached. No successor states.',
    triage_tags: [],
    requirement_ids: [],
    metadata: {},
  };
  assert.equal(classifyTlcFailure(entry), 'deadlock');
});

// Test 2: Deadlock classification with lowercase "deadlock" + fail result
test('classifyTlcFailure: deadlock when summary contains "deadlock" and result="fail"', () => {
  const entry = {
    summary: 'Check failed: deadlock detected in state space',
    result: 'fail',
    metadata: {},
  };
  assert.equal(classifyTlcFailure(entry), 'deadlock');
});

// Test 3: SANY semantic error
test('classifyTlcFailure: sany_semantic when summary contains "Semantic error"', () => {
  const entry = {
    summary: 'Semantic error: multiply-defined symbol X at line 42',
    result: 'error',
    metadata: {},
  };
  assert.equal(classifyTlcFailure(entry), 'sany_semantic');
});

// Test 4: SANY semantic error with "multiply defined" variant
test('classifyTlcFailure: sany_semantic when summary contains "multiply defined"', () => {
  const entry = {
    summary: 'SANY parsing error: multiply defined symbol ZZZ in fairness',
    result: 'error',
    metadata: {},
  };
  assert.equal(classifyTlcFailure(entry), 'sany_semantic');
});

// Test 5: SANY semantic error via metadata
test('classifyTlcFailure: sany_semantic when metadata.error_type="semantic"', () => {
  const entry = {
    summary: 'Error in spec definition',
    result: 'error',
    metadata: { error_type: 'semantic' },
  };
  assert.equal(classifyTlcFailure(entry), 'sany_semantic');
});

// Test 6: Fairness gap
test('classifyTlcFailure: fairness_gap when summary contains "Temporal properties were violated"', () => {
  const entry = {
    summary: 'Temporal properties were violated. Stuttering detected in trace.',
    result: 'fail',
    metadata: {},
  };
  assert.equal(classifyTlcFailure(entry), 'fairness_gap');
});

// Test 7: Fairness gap via temporal + stuttering
test('classifyTlcFailure: fairness_gap when summary contains "temporal" and "stuttering"', () => {
  const entry = {
    summary: 'Temporal property violated: action stuttering without fairness constraint',
    result: 'fail',
    property: 'TemporalProperty',
    metadata: {},
  };
  assert.equal(classifyTlcFailure(entry), 'fairness_gap');
});

// Test 8: Fairness gap via liveness + stuttering
test('classifyTlcFailure: fairness_gap when summary contains "liveness" and "stuttering"', () => {
  const entry = {
    summary: 'Liveness check failed: stuttering in enabled action',
    result: 'fail',
    metadata: {},
  };
  assert.equal(classifyTlcFailure(entry), 'fairness_gap');
});

// Test 9: Fairness gap via property="Liveness" + stuttering
test('classifyTlcFailure: fairness_gap when property contains "Liveness" and summary has stuttering', () => {
  const entry = {
    summary: 'Counterexample trace shows stuttering state',
    result: 'fail',
    property: 'FallbackLiveness',
    metadata: {},
  };
  assert.equal(classifyTlcFailure(entry), 'fairness_gap');
});

// Test 10: Fairness gap via metadata.trace_type
test('classifyTlcFailure: fairness_gap when summary contains "temporal" and metadata.trace_type="stuttering"', () => {
  const entry = {
    summary: 'Temporal property check failed',
    result: 'fail',
    metadata: { trace_type: 'stuttering' },
  };
  assert.equal(classifyTlcFailure(entry), 'fairness_gap');
});

// Test 11: Syntax error
test('classifyTlcFailure: syntax_error when summary contains "Syntax error"', () => {
  const entry = {
    summary: 'Syntax error at line 10: unexpected token',
    result: 'error',
    metadata: {},
  };
  assert.equal(classifyTlcFailure(entry), 'syntax_error');
});

// Test 12: Syntax error with "parse error"
test('classifyTlcFailure: syntax_error when summary contains "parse error"', () => {
  const entry = {
    summary: 'Parse error in module definition: missing operator',
    result: 'error',
    metadata: {},
  };
  assert.equal(classifyTlcFailure(entry), 'syntax_error');
});

// Test 13: Invariant violation
test('classifyTlcFailure: invariant_violation when result="fail" and summary contains "Invariant"', () => {
  const entry = {
    summary: 'Invariant TypeInvariant is violated. Counterexample found.',
    result: 'fail',
    property: 'TypeInvariant',
    metadata: {},
  };
  assert.equal(classifyTlcFailure(entry), 'invariant_violation');
});

// Test 14: Invariant violation via counterexample
test('classifyTlcFailure: invariant_violation when result="fail" and summary contains "counterexample"', () => {
  const entry = {
    summary: 'Check failed: counterexample shows violation',
    result: 'fail',
    metadata: {},
  };
  assert.equal(classifyTlcFailure(entry), 'invariant_violation');
});

// Test 15: Unknown classification (unrecognized output)
test('classifyTlcFailure: unknown when summary is unrecognized', () => {
  const entry = {
    summary: 'Some unrecognized output',
    result: 'warn',
    metadata: {},
  };
  assert.equal(classifyTlcFailure(entry), 'unknown');
});

// Test 16: Null entry returns unknown
test('classifyTlcFailure: unknown when entry is null', () => {
  assert.equal(classifyTlcFailure(null), 'unknown');
});

// Test 17: Undefined entry returns unknown
test('classifyTlcFailure: unknown when entry is undefined', () => {
  assert.equal(classifyTlcFailure(undefined), 'unknown');
});

// Test 18: Missing summary field returns unknown (unless other fields match)
test('classifyTlcFailure: unknown when entry has no summary and no matching fields', () => {
  const entry = {
    result: 'pass',
    property: 'SomeProperty',
    metadata: {},
  };
  assert.equal(classifyTlcFailure(entry), 'unknown');
});

// Test 19: Deadlock with metadata.trace also classified correctly
test('classifyTlcFailure: deadlock with metadata.trace field', () => {
  const entry = {
    summary: 'Deadlock reached at state 123',
    result: 'fail',
    metadata: { trace: ['Init', 'Action1', 'Action2'] },
  };
  assert.equal(classifyTlcFailure(entry), 'deadlock');
});

// Test 20: Fairness gap with property and stuttering match
test('classifyTlcFailure: fairness_gap with property="Liveness" and stuttering in summary', () => {
  const entry = {
    summary: 'Trace: Init -> A -> B -> B stuttering detected',
    result: 'fail',
    property: 'EventuallyEnabledLiveness',
    metadata: {},
  };
  assert.equal(classifyTlcFailure(entry), 'fairness_gap');
});

// Test 21: Case insensitivity for "Deadlock Reached"
test('classifyTlcFailure: case-insensitive match for "Deadlock Reached"', () => {
  const entry = {
    summary: 'ERROR: DEADLOCK REACHED',
    result: 'fail',
    metadata: {},
  };
  assert.equal(classifyTlcFailure(entry), 'deadlock');
});

// Test 22: Edge case - object without summary field but with metadata.error_type
test('classifyTlcFailure: empty summary with semantic metadata', () => {
  const entry = {
    summary: '',
    result: 'error',
    metadata: { error_type: 'semantic' },
  };
  assert.equal(classifyTlcFailure(entry), 'sany_semantic');
});

// Test 23: Test ordering - sany_semantic takes precedence over other patterns
test('classifyTlcFailure: sany_semantic ordered first (before other matches)', () => {
  const entry = {
    summary: 'Semantic error: multiply-defined symbol plus syntax issue',
    result: 'error',
    metadata: {},
  };
  // Should match sany_semantic first, not syntax_error
  assert.equal(classifyTlcFailure(entry), 'sany_semantic');
});

// Test 24: Test ordering - fairness_gap before invariant_violation
test('classifyTlcFailure: fairness_gap ordered before invariant_violation', () => {
  const entry = {
    summary: 'Temporal properties violated with counterexample showing stuttering',
    result: 'fail',
    property: 'SomeLiveness',
    metadata: {},
  };
  // Should match fairness_gap (has "temporal" + "stuttering"), not invariant_violation
  assert.equal(classifyTlcFailure(entry), 'fairness_gap');
});

// CTF-1: Non-string summary must fail-open, not crash on .toLowerCase()
test('classifyTlcFailure: unknown when summary is a non-string (array)', () => {
  assert.equal(
    classifyTlcFailure({ summary: ['Deadlock reached'], result: 'fail', metadata: {} }),
    'unknown'
  );
});

test('classifyTlcFailure: unknown when summary is a number', () => {
  assert.equal(
    classifyTlcFailure({ summary: 42, result: 'fail', metadata: {} }),
    'unknown'
  );
});

// CTF-2: Non-string property must not crash; classification proceeds from summary
test('classifyTlcFailure: ignores non-string property and classifies via summary', () => {
  assert.equal(
    classifyTlcFailure({ summary: 'Deadlock reached at state 1', result: 'fail', property: 12345, metadata: {} }),
    'deadlock'
  );
});

test('classifyTlcFailure: unknown when property is an array and summary unrecognized', () => {
  assert.equal(
    classifyTlcFailure({ summary: 'misc output', result: 'warn', property: ['Liveness'], metadata: {} }),
    'unknown'
  );
});

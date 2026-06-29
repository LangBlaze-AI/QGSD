'use strict';
const assert = require('assert');
const { resolveGateScore } = require('./gate-score-utils.cjs');

// Gate A: v2 preferred
assert.strictEqual(resolveGateScore({ wiring_evidence_score: 0.9, grounding_score: 0.5 }, 'a'), 0.9);
// Gate A: v1 fallback
assert.strictEqual(resolveGateScore({ grounding_score: 0.7 }, 'a'), 0.7);
// Gate A: neither
assert.strictEqual(resolveGateScore({}, 'a'), 0);

// Gate B: v2 preferred
assert.strictEqual(resolveGateScore({ wiring_purpose_score: 0.8, gate_b_score: 0.4 }, 'b'), 0.8);
// Gate B: v1 fallback
assert.strictEqual(resolveGateScore({ gate_b_score: 0.6 }, 'b'), 0.6);

// Gate C: v2 preferred
assert.strictEqual(resolveGateScore({ wiring_coverage_score: 0.95 }, 'c'), 0.95);
// Gate C: v1 fallback
assert.strictEqual(resolveGateScore({ gate_c_score: 0.3 }, 'c'), 0.3);

// Null/undefined input
assert.strictEqual(resolveGateScore(null, 'a'), 0);
assert.strictEqual(resolveGateScore(undefined, 'b'), 0);

// Unknown gate name
assert.strictEqual(resolveGateScore({ wiring_evidence_score: 1 }, 'x'), 0);

// GSU-01: v2 score of 0 must be preferred over stale v1 data (|| vs ?? bug)
// Gate A: v2 present with value 0 must be preferred over v1
assert.strictEqual(resolveGateScore({ wiring_evidence_score: 0, grounding_score: 0.5 }, 'a'), 0);
// Gate B: v2 present with value 0 must be preferred over v1
assert.strictEqual(resolveGateScore({ wiring_purpose_score: 0, gate_b_score: 0.4 }, 'b'), 0);
// Gate C: v2 present with value 0 must be preferred over v1
assert.strictEqual(resolveGateScore({ wiring_coverage_score: 0, gate_c_score: 0.3 }, 'c'), 0);
// v1 fallback still applies when v2 absent (null/undefined), value 0 honored
assert.strictEqual(resolveGateScore({ grounding_score: 0 }, 'a'), 0);
assert.strictEqual(resolveGateScore({ wiring_evidence_score: null, grounding_score: 0.7 }, 'a'), 0.7);

console.log('gate-score-utils.test.cjs: all assertions passed');

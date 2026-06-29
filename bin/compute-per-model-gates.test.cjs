#!/usr/bin/env node
'use strict';

/**
 * compute-per-model-gates.test.cjs — Unit tests for aggregate score computations.
 *
 * Tests computeAggregate() against known fixtures including edge cases.
 * Validates field names and structure match the existing global gate JSON schemas.
 */

const { computeAggregate, evaluateConsecutivePass, shouldPromoteToHardGate } = require('./compute-per-model-gates.cjs');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    process.stdout.write('  PASS: ' + message + '\n');
  } else {
    failed++;
    process.stderr.write('  FAIL: ' + message + '\n');
  }
}

function assertClose(actual, expected, tolerance, message) {
  const ok = Math.abs(actual - expected) < tolerance;
  if (ok) {
    passed++;
    process.stdout.write('  PASS: ' + message + ' (' + actual.toFixed(4) + ' ~= ' + expected.toFixed(4) + ')\n');
  } else {
    failed++;
    process.stderr.write('  FAIL: ' + message + ' (got ' + actual + ', expected ~' + expected + ')\n');
  }
}

// ── Fixture 1: Mixed results (3 models: 2 pass A, 3 pass B, 1 passes C) ────

console.log('\n=== Fixture 1: Mixed results (3 models) ===');

const fixture1 = {
  './model-a.tla': { gate_a: true, gate_b: true, gate_c: true },
  './model-b.tla': { gate_a: true, gate_b: true, gate_c: false },
  './model-c.tla': { gate_a: false, gate_b: true, gate_c: false },
};

const agg1 = computeAggregate(fixture1);

// Gate A
assertClose(agg1.gate_a.wiring_evidence_score, 2 / 3, 0.0001, 'Gate A wiring_evidence_score = 2/3');
assert(agg1.gate_a.target === 0.8, 'Gate A target = 0.8');
assert(agg1.gate_a.target_met === false, 'Gate A target_met = false (0.667 < 0.8)');
assert(agg1.gate_a.explained === 2, 'Gate A explained = 2');
assert(agg1.gate_a.total === 3, 'Gate A total = 3');
assert(agg1.gate_a.unexplained_counts.model_gap === 1, 'Gate A model_gap = 1');
assert(agg1.gate_a.unexplained_counts.instrumentation_bug === 0, 'Gate A instrumentation_bug = 0');
assert(agg1.gate_a.unexplained_counts.genuine_violation === 0, 'Gate A genuine_violation = 0');

// Gate B
assertClose(agg1.gate_b.wiring_purpose_score, 1.0, 0.0001, 'Gate B wiring_purpose_score = 1.0');
assert(agg1.gate_b.total_entries === 3, 'Gate B total_entries = 3');
assert(agg1.gate_b.grounded_entries === 3, 'Gate B grounded_entries = 3');
assert(agg1.gate_b.orphaned_entries === 0, 'Gate B orphaned_entries = 0');
assert(agg1.gate_b.target === 1.0, 'Gate B target = 1.0');
assert(agg1.gate_b.target_met === true, 'Gate B target_met = true');

// Gate C
assertClose(agg1.gate_c.wiring_coverage_score, 1 / 3, 0.0001, 'Gate C wiring_coverage_score = 1/3');
assert(agg1.gate_c.total_entries === 3, 'Gate C total_entries = 3');
assert(agg1.gate_c.validated_entries === 1, 'Gate C validated_entries = 1');
assert(agg1.gate_c.unvalidated_entries === 2, 'Gate C unvalidated_entries = 2');
assert(agg1.gate_c.target === 0.8, 'Gate C target = 0.8');
assert(agg1.gate_c.target_met === false, 'Gate C target_met = false (0.333 < 0.8)');

// ── Fixture 2: Edge case — 0 models (empty input) ──────────────────────────

console.log('\n=== Fixture 2: Edge case - 0 models ===');

const agg2 = computeAggregate({});

assert(agg2.gate_a.wiring_evidence_score === 0, 'Empty: Gate A wiring_evidence_score = 0');
assert(agg2.gate_a.total === 0, 'Empty: Gate A total = 0');
assert(agg2.gate_a.explained === 0, 'Empty: Gate A explained = 0');
assert(agg2.gate_a.target_met === false, 'Empty: Gate A target_met = false');
assert(agg2.gate_b.wiring_purpose_score === 0, 'Empty: Gate B wiring_purpose_score = 0');
assert(agg2.gate_b.target_met === false, 'Empty: Gate B target_met = false');
assert(agg2.gate_c.wiring_coverage_score === 0, 'Empty: Gate C wiring_coverage_score = 0');
assert(agg2.gate_c.target_met === false, 'Empty: Gate C target_met = false');

// ── Fixture 3: Edge case — all models pass all gates ────────────────────────

console.log('\n=== Fixture 3: All models pass all gates ===');

const fixture3 = {
  './m1.tla': { gate_a: true, gate_b: true, gate_c: true },
  './m2.tla': { gate_a: true, gate_b: true, gate_c: true },
};

const agg3 = computeAggregate(fixture3);

assert(agg3.gate_a.wiring_evidence_score === 1.0, 'All-pass: Gate A wiring_evidence_score = 1.0');
assert(agg3.gate_a.target_met === true, 'All-pass: Gate A target_met = true');
assert(agg3.gate_a.unexplained_counts.model_gap === 0, 'All-pass: Gate A model_gap = 0');
assert(agg3.gate_b.wiring_purpose_score === 1.0, 'All-pass: Gate B wiring_purpose_score = 1.0');
assert(agg3.gate_b.target_met === true, 'All-pass: Gate B target_met = true');
assert(agg3.gate_b.orphaned_entries === 0, 'All-pass: Gate B orphaned_entries = 0');
assert(agg3.gate_c.wiring_coverage_score === 1.0, 'All-pass: Gate C wiring_coverage_score = 1.0');
assert(agg3.gate_c.target_met === true, 'All-pass: Gate C target_met = true');

// ── Fixture 4: Field name / structure validation ────────────────────────────

console.log('\n=== Fixture 4: Structure validation ===');

// Verify all required fields exist (matching global gate JSON schemas)
const gateAFields = ['wiring_evidence_score', 'target', 'target_met', 'explained', 'total', 'unexplained_counts'];
for (const f of gateAFields) {
  assert(f in agg1.gate_a, 'Gate A has field: ' + f);
}
assert('instrumentation_bug' in agg1.gate_a.unexplained_counts, 'Gate A unexplained_counts has instrumentation_bug');
assert('model_gap' in agg1.gate_a.unexplained_counts, 'Gate A unexplained_counts has model_gap');
assert('genuine_violation' in agg1.gate_a.unexplained_counts, 'Gate A unexplained_counts has genuine_violation');

const gateBFields = ['wiring_purpose_score', 'total_entries', 'grounded_entries', 'orphaned_entries', 'target', 'target_met'];
for (const f of gateBFields) {
  assert(f in agg1.gate_b, 'Gate B has field: ' + f);
}

const gateCFields = ['wiring_coverage_score', 'total_entries', 'validated_entries', 'unvalidated_entries', 'target', 'target_met'];
for (const f of gateCFields) {
  assert(f in agg1.gate_c, 'Gate C has field: ' + f);
}

// ── GPROMO-01: consecutive_pass_count tracking ──────────────────────────────

console.log('\n=== GPROMO-01: consecutive_pass_count tracking ===');

// Model passes session (maturity=2, evidence=2, not unstable) -> count increments 0->1
{
  const model = { gate_maturity: 'SOFT_GATE', consecutive_pass_count: 0 };
  const ev = { score: 2, total: 5, skipped: false };
  const result = evaluateConsecutivePass(model, 2, ev, false);
  assert(result.passes === true, 'GPROMO-01: model passes session (maturity=2, evidence=2)');
  assert(result.newCount === 1, 'GPROMO-01: count increments 0->1');
}

// Model passes again -> count increments 1->2, 2->3
{
  const model = { gate_maturity: 'SOFT_GATE', consecutive_pass_count: 1 };
  const ev = { score: 2, total: 5, skipped: false };
  const result = evaluateConsecutivePass(model, 2, ev, false);
  assert(result.newCount === 2, 'GPROMO-01: count increments 1->2');
}
{
  const model = { gate_maturity: 'SOFT_GATE', consecutive_pass_count: 2 };
  const ev = { score: 2, total: 5, skipped: false };
  const result = evaluateConsecutivePass(model, 2, ev, false);
  assert(result.newCount === 3, 'GPROMO-01: count increments 2->3');
}

// Model fails (maturity=0) -> count resets to 0
{
  const model = { gate_maturity: 'SOFT_GATE', consecutive_pass_count: 3 };
  const ev = { score: 2, total: 5, skipped: false };
  const result = evaluateConsecutivePass(model, 0, ev, false);
  assert(result.passes === false, 'GPROMO-01: model fails with maturity=0');
  assert(result.newCount === 0, 'GPROMO-01: count resets to 0 on maturity failure');
}

// Model fails (evidence regresses below threshold) -> count resets to 0
{
  const model = { gate_maturity: 'SOFT_GATE', consecutive_pass_count: 5 };
  const ev = { score: 0.5, total: 5, skipped: false }; // below SOFT_GATE threshold of 0.8
  const result = evaluateConsecutivePass(model, 2, ev, false);
  assert(result.passes === false, 'GPROMO-01: model fails with evidence below SOFT_GATE threshold');
  assert(result.newCount === 0, 'GPROMO-01: count resets to 0 on evidence regression');
}

// Model in UNSTABLE state -> count resets to 0 regardless of maturity
{
  const model = { gate_maturity: 'SOFT_GATE', consecutive_pass_count: 4 };
  const ev = { score: 3, total: 5, skipped: false };
  const result = evaluateConsecutivePass(model, 3, ev, true);
  assert(result.passes === false, 'GPROMO-01: UNSTABLE model does not pass');
  assert(result.newCount === 0, 'GPROMO-01: count resets to 0 when UNSTABLE');
}

// Model with no prior consecutive_pass_count field -> initializes to 0 then increments to 1
{
  const model = { gate_maturity: 'ADVISORY' };
  const ev = { score: 1, total: 5, skipped: false };
  const result = evaluateConsecutivePass(model, 1, ev, false);
  assert(result.passes === true, 'GPROMO-01: model with no prior field passes');
  assert(result.newCount === 1, 'GPROMO-01: initializes from undefined to 1');
}

// Evidence skipped -> evidence check passes (fail-open)
{
  const model = { gate_maturity: 'SOFT_GATE', consecutive_pass_count: 2 };
  const ev = { score: 0, total: 5, skipped: true };
  const result = evaluateConsecutivePass(model, 2, ev, false);
  assert(result.passes === true, 'GPROMO-01: evidence skipped passes (fail-open)');
  assert(result.newCount === 3, 'GPROMO-01: count increments with skipped evidence');
}

// ── GPROMO-02: HARD_GATE promotion gating ───────────────────────────────────

console.log('\n=== GPROMO-02: HARD_GATE promotion gating ===');

// SOFT_GATE model with consecutive_pass_count=2 (< 3), maturity=3, evidence=3 -> false
{
  const model = { gate_maturity: 'SOFT_GATE', consecutive_pass_count: 2 };
  const ev = { score: 3, total: 5, skipped: false };
  assert(shouldPromoteToHardGate(model, 3, ev, false) === false,
    'GPROMO-02: consecutive_pass_count=2 blocks promotion');
}

// SOFT_GATE model with consecutive_pass_count=3, maturity=3, evidence=3 -> true
{
  const model = { gate_maturity: 'SOFT_GATE', consecutive_pass_count: 3 };
  const ev = { score: 3, total: 5, skipped: false };
  assert(shouldPromoteToHardGate(model, 3, ev, false) === true,
    'GPROMO-02: consecutive_pass_count=3 allows promotion');
}

// SOFT_GATE model with consecutive_pass_count=5 -> true (>= 3 is sufficient)
{
  const model = { gate_maturity: 'SOFT_GATE', consecutive_pass_count: 5 };
  const ev = { score: 3, total: 5, skipped: false };
  assert(shouldPromoteToHardGate(model, 3, ev, false) === true,
    'GPROMO-02: consecutive_pass_count=5 allows promotion (>= 3)');
}

// SOFT_GATE model with consecutive_pass_count=3, maturity=2 (< 3) -> false
{
  const model = { gate_maturity: 'SOFT_GATE', consecutive_pass_count: 3 };
  const ev = { score: 3, total: 5, skipped: false };
  assert(shouldPromoteToHardGate(model, 2, ev, false) === false,
    'GPROMO-02: maturity=2 blocks promotion despite consecutive_pass_count=3');
}

// SOFT_GATE model with consecutive_pass_count=3, evidence=2 (< 3) -> false
{
  const model = { gate_maturity: 'SOFT_GATE', consecutive_pass_count: 3 };
  const ev = { score: 2, total: 5, skipped: false };
  assert(shouldPromoteToHardGate(model, 3, ev, false) === false,
    'GPROMO-02: evidence=2 blocks promotion despite consecutive_pass_count=3');
}

// SOFT_GATE model with consecutive_pass_count=3 but isUnstableOrCooling=true -> false
{
  const model = { gate_maturity: 'SOFT_GATE', consecutive_pass_count: 3 };
  const ev = { score: 3, total: 5, skipped: false };
  assert(shouldPromoteToHardGate(model, 3, ev, true) === false,
    'GPROMO-02: UNSTABLE blocks promotion despite all other criteria met');
}

// ADVISORY model should never promote to HARD_GATE
{
  const model = { gate_maturity: 'ADVISORY', consecutive_pass_count: 10 };
  const ev = { score: 5, total: 5, skipped: false };
  assert(shouldPromoteToHardGate(model, 3, ev, false) === false,
    'GPROMO-02: ADVISORY model cannot promote directly to HARD_GATE');
}

// Evidence skipped -> should allow promotion (fail-open)
{
  const model = { gate_maturity: 'SOFT_GATE', consecutive_pass_count: 3 };
  const ev = { score: 0, total: 5, skipped: true };
  assert(shouldPromoteToHardGate(model, 3, ev, false) === true,
    'GPROMO-02: evidence skipped allows promotion (fail-open)');
}

// ── GPROMO-03: changelog evidence (structural assertion) ─────────────────────

console.log('\n=== GPROMO-03: changelog evidence (structural) ===');

// When shouldPromoteToHardGate returns true, model.consecutive_pass_count is accessible and >= 3
{
  const model = { gate_maturity: 'SOFT_GATE', consecutive_pass_count: 4 };
  const ev = { score: 3, total: 5, skipped: false };
  const eligible = shouldPromoteToHardGate(model, 3, ev, false);
  assert(eligible === true, 'GPROMO-03: model is eligible for promotion');
  assert(model.consecutive_pass_count >= 3, 'GPROMO-03: consecutive_pass_count accessible and >= 3 when eligible');
  assert(typeof model.consecutive_pass_count === 'number', 'GPROMO-03: consecutive_pass_count is a number');
}

// When shouldPromoteToHardGate returns false, consecutive_pass_count may be < 3
{
  const model = { gate_maturity: 'SOFT_GATE', consecutive_pass_count: 1 };
  const ev = { score: 3, total: 5, skipped: false };
  const eligible = shouldPromoteToHardGate(model, 3, ev, false);
  assert(eligible === false, 'GPROMO-03: model with count=1 is not eligible');
  assert(model.consecutive_pass_count < 3, 'GPROMO-03: consecutive_pass_count < 3 when not eligible due to count');
}

// ── Adversarial: null gate field must not crash ─────────────────────────────
console.log('\n=== Adversarial: null gate field ===');
{
  const fixture = { './m.tla': { gate_a: null, gate_b: true, gate_c: true } };
  let threw = false;
  let agg;
  try { agg = computeAggregate(fixture); } catch (_) { threw = true; }
  assert(!threw, 'computeAggregate does not throw on null gate_a field');
  assert(!threw && agg.gate_a.explained === 0, 'null gate_a counted as non-pass (explained=0)');
  assert(!threw && agg.gate_a.unexplained_counts.model_gap === 1, 'null gate_a counts as model_gap');
}

// ── Adversarial: null/undefined input fails open ────────────────────────────
console.log('\n=== Adversarial: null/undefined input ===');
{
  let threw = false;
  let agg;
  try { agg = computeAggregate(null); } catch (_) { threw = true; }
  assert(!threw, 'computeAggregate fails open on null input');
  assert(!threw && agg.gate_a.total === 0, 'null input yields gate_a.total = 0');
  assert(!threw && agg.gate_b.wiring_purpose_score === 0, 'null input yields gate_b score = 0');
}
{
  let threw = false;
  let agg;
  try { agg = computeAggregate(undefined); } catch (_) { threw = true; }
  assert(!threw, 'computeAggregate fails open on undefined input');
  assert(!threw && agg.gate_c.unvalidated_entries === 0, 'undefined input yields gate_c.unvalidated_entries = 0');
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log('\n=== Results ===');
console.log('  Passed: ' + passed);
console.log('  Failed: ' + failed);
console.log('  Total:  ' + (passed + failed));

process.exit(failed > 0 ? 1 : 0);

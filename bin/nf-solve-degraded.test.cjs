'use strict';

// Degraded-convergence guard (CE-5 quorum dogfood finding): a skipped layer (residual -1)
// must not read as "clean" in the aggregate. computeUnmeasuredLayers surfaces skipped layers
// so a total===0 is never mistaken for a proven convergence when a layer didn't run.

const { test } = require('node:test');
const assert = require('node:assert');
const { computeUnmeasuredLayers } = require('./nf-solve.cjs');

test('all layers measured (residual >= 0) → no unmeasured (not degraded)', () => {
  const layers = { r_to_f: { residual: 0 }, f_to_t: { residual: 3 }, c_to_f: { residual: 0 } };
  assert.deepStrictEqual(computeUnmeasuredLayers(layers), []);
});

test('a skipped layer (residual -1) is flagged unmeasured — the false-convergence hole', () => {
  const layers = { r_to_f: { residual: 0 }, f_to_t: { residual: -1 }, c_to_f: { residual: 0 } };
  assert.deepStrictEqual(computeUnmeasuredLayers(layers), ['f_to_t']);
});

test('multiple skipped layers all surface', () => {
  const layers = { a: { residual: -1 }, b: { residual: 2 }, c: { residual: -1 } };
  assert.deepStrictEqual(computeUnmeasuredLayers(layers).sort(), ['a', 'c']);
});

test('a clean total (0) with a skipped layer is DEGRADED, not converged', () => {
  // Simulates the bug: r_to_f measured clean (0), but f_to_t was skipped (-1). The old
  // aggregate would sum to 0 and read as "converged". The guard says: degraded.
  const layers = { r_to_f: { residual: 0 }, f_to_t: { residual: -1 } };
  const unmeasured = computeUnmeasuredLayers(layers);
  const degraded = unmeasured.length > 0;
  assert.strictEqual(degraded, true, 'a 0-residual total with a skipped layer must be degraded');
});

test('non-numeric / missing residual counts as unmeasured (not >= 0)', () => {
  assert.deepStrictEqual(
    computeUnmeasuredLayers({ a: {}, b: { residual: undefined }, c: { residual: 'x' }, d: { residual: 0 } }).sort(),
    ['a', 'b', 'c']
  );
});

test('bad input degrades to [] without throwing', () => {
  assert.deepStrictEqual(computeUnmeasuredLayers(null), []);
  assert.deepStrictEqual(computeUnmeasuredLayers(undefined), []);
});

// ── computeDegradedConvergence (#44): wire `degraded` into the DECISION output ──
// The old aggregate could report converged/clean while layers were skipped. This helper
// is the exported decision seam formatJSON emits as `degraded_convergence`.
const { computeDegradedConvergence } = require('./nf-solve.cjs');

test('THE BUG: converged claimed while a layer was skipped → degraded_convergence true', () => {
  // total===0 (all measured layers clean) but f_to_t was skipped (unmeasured).
  assert.strictEqual(computeDegradedConvergence(true, 0, ['f_to_t']), true);
});

test('clean total (0) with a skipped layer is degraded even if converged flag is false', () => {
  assert.strictEqual(computeDegradedConvergence(false, 0, ['f_to_t']), true);
});

test('genuinely clean: converged/total 0 with NO unmeasured layers → NOT degraded', () => {
  assert.strictEqual(computeDegradedConvergence(true, 0, []), false);
  assert.strictEqual(computeDegradedConvergence(false, 0, []), false);
});

test('real residual present (total > 0) is never a "degraded convergence" — nothing was falsely claimed clean', () => {
  // Even with unmeasured layers, a non-zero total is not claiming clean, so not degraded_convergence.
  assert.strictEqual(computeDegradedConvergence(false, 5, ['f_to_t']), false);
});

test('converged with unmeasured layers but non-zero total → still flagged (claim made via converged flag)', () => {
  assert.strictEqual(computeDegradedConvergence(true, 5, ['f_to_t']), true);
});

test('non-array unmeasuredLayers degrades to false without throwing', () => {
  assert.strictEqual(computeDegradedConvergence(true, 0, null), false);
  assert.strictEqual(computeDegradedConvergence(true, 0, undefined), false);
});

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

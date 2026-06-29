#!/usr/bin/env node
'use strict';
// bin/solve-incremental-filter.test.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeAffectedLayers, expandWithCallGraph } = require('./solve-incremental-filter.cjs');

test('empty file list returns all layers (safe fallback)', () => {
  const result = computeAffectedLayers([]);
  assert.equal(result.files_analyzed, 0);
  assert.ok(result.affected_layers.length > 0);
  assert.equal(result.skip_layers.length, 0);
});

test('null input returns all layers', () => {
  const result = computeAffectedLayers(null);
  assert.equal(result.skip_layers.length, 0);
});

test('formal model files affect R→F, F→T, F→C', () => {
  const result = computeAffectedLayers(['.planning/formal/alloy/test.als']);
  assert.ok(result.affected_layers.includes('r_to_f'));
  assert.ok(result.affected_layers.includes('f_to_t'));
  assert.ok(result.affected_layers.includes('f_to_c'));
});

test('test files affect T→C, F→T, T→R', () => {
  const result = computeAffectedLayers(['bin/nf-solve.test.cjs']);
  assert.ok(result.affected_layers.includes('t_to_c'));
  assert.ok(result.affected_layers.includes('f_to_t'));
  assert.ok(result.affected_layers.includes('t_to_r'));
});

test('doc files affect R→D, D→C, D→R', () => {
  const result = computeAffectedLayers(['docs/dev/guide.md']);
  assert.ok(result.affected_layers.includes('r_to_d'));
  assert.ok(result.affected_layers.includes('d_to_c'));
  assert.ok(result.affected_layers.includes('d_to_r'));
});

test('source code files affect C→F, C→R', () => {
  const result = computeAffectedLayers(['bin/hazard-model.cjs']);
  assert.ok(result.affected_layers.includes('c_to_f'));
  assert.ok(result.affected_layers.includes('c_to_r'));
});

test('only formal models touched → many layers skipped', () => {
  const result = computeAffectedLayers([
    '.planning/formal/tla/NFDispatch.tla',
    '.planning/formal/alloy/test.als',
  ]);
  // Should NOT include d_to_c, d_to_r, t_to_r, c_to_r, hazard_model
  assert.ok(result.skip_layers.includes('d_to_c'));
  assert.ok(result.skip_layers.includes('hazard_model'));
  assert.ok(result.skip_layers.length > 0, 'should skip some layers');
});

test('unknown file type conservatively adds forward layers', () => {
  const result = computeAffectedLayers(['some/random/file.xyz']);
  assert.ok(result.affected_layers.includes('c_to_f'));
  assert.ok(result.affected_layers.includes('t_to_c'));
});

test('requirements.json affects R→F, R→D, reverse layers', () => {
  const result = computeAffectedLayers(['.planning/formal/requirements.json']);
  assert.ok(result.affected_layers.includes('r_to_f'));
  assert.ok(result.affected_layers.includes('r_to_d'));
  assert.ok(result.affected_layers.includes('c_to_r'));
  assert.ok(result.affected_layers.includes('t_to_r'));
});

test('ALWAYS_SWEEP layers are never skipped', () => {
  const result = computeAffectedLayers(['.planning/formal/alloy/test.als']);
  assert.ok(result.affected_layers.includes('r_to_f'));
  assert.ok(result.affected_layers.includes('r_to_d'));
});

// ── expandWithCallGraph tests (CDIAG-03) ─────────────────────────────────────

test('expandWithCallGraph: null adapter leaves affectedSet unchanged', () => {
  const affected = new Set(['r_to_f']);
  expandWithCallGraph(['bin/utils.cjs'], affected, null);
  assert.equal(affected.size, 1); // unchanged
  assert.ok(affected.has('r_to_f'));
});

test('expandWithCallGraph: unhealthy adapter leaves affectedSet unchanged', () => {
  const unhealthyAdapter = {
    healthSync: () => ({ healthy: false }),
    getCallersSync: () => ({ error: 'down' })
  };
  const affected = new Set(['r_to_f']);
  expandWithCallGraph(['bin/utils.cjs'], affected, unhealthyAdapter);
  assert.equal(affected.size, 1); // unchanged
});

test('expandWithCallGraph: getCallersSync error skips gracefully (no crash)', () => {
  const errorAdapter = {
    healthSync: () => ({ healthy: true }),
    getCallersSync: () => ({ error: 'timeout' })
  };
  const affected = new Set();
  expandWithCallGraph(['bin/utils.cjs'], affected, errorAdapter);
  assert.equal(affected.size, 0); // no expansion, no crash
});

test('expandWithCallGraph: getCallersSync throws — caught, no crash (fail-open)', () => {
  const throwAdapter = {
    healthSync: () => ({ healthy: true }),
    getCallersSync: () => { throw new Error('boom'); }
  };
  const affected = new Set();
  assert.doesNotThrow(() => expandWithCallGraph(['bin/utils.cjs'], affected, throwAdapter));
  assert.equal(affected.size, 0);
});

test('expandWithCallGraph: empty files list skips gracefully', () => {
  const adapter = {
    healthSync: () => ({ healthy: true }),
    getCallersSync: () => ({ callers: ['bin/nf-solve.cjs'] })
  };
  const affected = new Set(['r_to_f']);
  expandWithCallGraph([], affected, adapter);
  assert.equal(affected.size, 1); // unchanged
});

test('expandWithCallGraph: caller matches DOMAIN_MAP pattern — layer added to affectedSet', () => {
  // bin/nf-solve.cjs matches pattern /^bin\/(?!.*test).*\.cjs$/ -> ['c_to_f', 'c_to_r', 't_to_c']
  const stubAdapter = {
    healthSync: () => ({ healthy: true }),
    getCallersSync: (symbol, file) => ({ callers: ['bin/nf-solve.cjs'] })
  };
  const affected = new Set(['r_to_f']); // start with one layer
  expandWithCallGraph(['bin/utils.cjs'], affected, stubAdapter);
  assert.ok(affected.has('c_to_f'), 'should add c_to_f because bin/nf-solve.cjs matches bin/*.cjs pattern');
  assert.ok(affected.has('c_to_r'), 'should add c_to_r because bin/nf-solve.cjs matches bin/*.cjs pattern');
  assert.ok(affected.has('r_to_f'), 'original layer must be preserved');
});

test('expandWithCallGraph: monotone safety — never removes existing layers', () => {
  const fullAdapter = {
    healthSync: () => ({ healthy: true }),
    getCallersSync: () => ({ callers: [] }) // returns empty callers
  };
  const affected = new Set(['r_to_f', 'c_to_r', 'f_to_t']);
  const sizeBefore = affected.size;
  expandWithCallGraph(['bin/any-file.cjs'], affected, fullAdapter);
  assert.ok(affected.size >= sizeBefore, 'affectedSet must never shrink');
  assert.ok(affected.has('r_to_f'), 'r_to_f must be preserved');
  assert.ok(affected.has('c_to_r'), 'c_to_r must be preserved');
  assert.ok(affected.has('f_to_t'), 'f_to_t must be preserved');
});

test('computeAffectedLayers: backward compatible with 1-arg signature (no adapter)', () => {
  // Old callers that pass only filesTouched still work
  const result = computeAffectedLayers(['bin/nf-solve.cjs']);
  assert.ok(Array.isArray(result.affected_layers));
  assert.ok(Array.isArray(result.skip_layers));
  assert.equal(result.files_analyzed, 1);
});

test('computeAffectedLayers: null adapter passed explicitly behaves same as no adapter', () => {
  const r1 = computeAffectedLayers(['bin/nf-solve.cjs']);
  const r2 = computeAffectedLayers(['bin/nf-solve.cjs'], null);
  assert.deepEqual(r1.affected_layers.sort(), r2.affected_layers.sort());
  assert.deepEqual(r1.skip_layers.sort(), r2.skip_layers.sort());
});

test('computeAffectedLayers: non-string array entries do not crash (coerce to unknown)', () => {
  assert.doesNotThrow(() => computeAffectedLayers([null]));
  assert.doesNotThrow(() => computeAffectedLayers([123]));
  assert.doesNotThrow(() => computeAffectedLayers([{}]));
  const result = computeAffectedLayers(['bin/nf-solve.cjs', null, 42]);
  assert.ok(Array.isArray(result.affected_layers));
  assert.ok(Array.isArray(result.skip_layers));
  assert.equal(result.files_analyzed, 3);
  // non-string entries fall through to the unknown-file branch -> forward layers present
  assert.ok(result.affected_layers.includes('c_to_f'));
});

test('expandWithCallGraph: non-string callers do not crash, valid ones still processed (fail-open)', () => {
  const adapter = {
    healthSync: () => ({ healthy: true }),
    getCallersSync: () => ({ callers: [null, 123, 'bin/nf-solve.cjs'] })
  };
  const affected = new Set(['r_to_f']);
  assert.doesNotThrow(() => expandWithCallGraph(['bin/utils.cjs'], affected, adapter));
  // valid string caller still maps bin/*.cjs -> c_to_f, c_to_r
  assert.ok(affected.has('c_to_f'), 'valid string caller still processed');
  assert.ok(affected.has('r_to_f'), 'original layer preserved');
});

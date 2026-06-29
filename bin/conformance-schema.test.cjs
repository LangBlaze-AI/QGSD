'use strict';
// Test suite for bin/conformance-schema.cjs
// Uses Node.js built-in test runner: node --test bin/conformance-schema.test.cjs
//
// Verifies all exported enum arrays and schema_version are stable.
// These values are used by hooks, trace validators, and the formal spec —
// any accidental mutation would cascade silently.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const schema = require('./conformance-schema.cjs');

// ─── Structural tests ─────────────────────────────────────────────────────────

test('exports VALID_ACTIONS array', () => {
  assert.ok(Array.isArray(schema.VALID_ACTIONS));
  assert.ok(schema.VALID_ACTIONS.length > 0);
});

test('exports VALID_PHASES array', () => {
  assert.ok(Array.isArray(schema.VALID_PHASES));
  assert.ok(schema.VALID_PHASES.length > 0);
});

test('exports VALID_OUTCOMES array', () => {
  assert.ok(Array.isArray(schema.VALID_OUTCOMES));
  assert.ok(schema.VALID_OUTCOMES.length > 0);
});

test('exports schema_version string', () => {
  assert.equal(typeof schema.schema_version, 'string');
  assert.equal(schema.schema_version, '1');
});

// ─── Content tests ────────────────────────────────────────────────────────────

test('VALID_ACTIONS contains expected values', () => {
  const expected = ['quorum_start', 'quorum_complete', 'quorum_block', 'deliberation_round', 'circuit_break'];
  for (const action of expected) {
    assert.ok(schema.VALID_ACTIONS.includes(action), `Missing action: ${action}`);
  }
});

test('VALID_PHASES contains expected FSM states', () => {
  const expected = ['IDLE', 'COLLECTING_VOTES', 'DELIBERATING', 'DECIDED'];
  for (const phase of expected) {
    assert.ok(schema.VALID_PHASES.includes(phase), `Missing phase: ${phase}`);
  }
});

test('VALID_OUTCOMES contains expected verdict values', () => {
  const expected = ['APPROVE', 'BLOCK', 'UNAVAILABLE', 'DELIBERATE'];
  for (const outcome of expected) {
    assert.ok(schema.VALID_OUTCOMES.includes(outcome), `Missing outcome: ${outcome}`);
  }
});

// ─── Immutability tests ───────────────────────────────────────────────────────

test('VALID_ACTIONS reference is stable across requires (module cache)', () => {
  const schema2 = require('./conformance-schema.cjs');
  assert.equal(schema.VALID_ACTIONS, schema2.VALID_ACTIONS, 'Should be same reference via module cache');
});

test('all array values are non-empty strings', () => {
  for (const val of [...schema.VALID_ACTIONS, ...schema.VALID_PHASES, ...schema.VALID_OUTCOMES]) {
    assert.equal(typeof val, 'string');
    assert.ok(val.length > 0, `Empty string found in schema arrays`);
  }
});

test('no duplicate values in VALID_ACTIONS', () => {
  const unique = new Set(schema.VALID_ACTIONS);
  assert.equal(unique.size, schema.VALID_ACTIONS.length, 'VALID_ACTIONS contains duplicates');
});

test('no duplicate values in VALID_PHASES', () => {
  const unique = new Set(schema.VALID_PHASES);
  assert.equal(unique.size, schema.VALID_PHASES.length, 'VALID_PHASES contains duplicates');
});

test('no duplicate values in VALID_OUTCOMES', () => {
  const unique = new Set(schema.VALID_OUTCOMES);
  assert.equal(unique.size, schema.VALID_OUTCOMES.length, 'VALID_OUTCOMES contains duplicates');
});

test('exported enum arrays are frozen — mutation throws and does not corrupt the shared enum', () => {
  for (const [name, arr] of [
    ['VALID_ACTIONS', schema.VALID_ACTIONS],
    ['VALID_PHASES', schema.VALID_PHASES],
    ['VALID_OUTCOMES', schema.VALID_OUTCOMES],
  ]) {
    assert.ok(Object.isFrozen(arr), `${name} should be frozen`);
    const before = arr.length;
    assert.throws(() => { arr.push('__malicious__'); }, TypeError, `${name}.push should throw`);
    assert.throws(() => { arr[0] = '__overwritten__'; }, TypeError, `${name}[0]= should throw`);
    assert.equal(arr.length, before, `${name} length must be unchanged`);
    assert.equal(arr.includes('__malicious__'), false, `${name} must not contain injected value`);
  }
  // shared reference stays intact for the next requirer
  const schema2 = require('./conformance-schema.cjs');
  assert.equal(schema2.VALID_ACTIONS.includes('__malicious__'), false);
});

#!/usr/bin/env node
/**
 * Unit tests for parse-tlc-counterexample.cjs
 * Tests ITF JSON parsing, special value normalization, and field extraction.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseITFTrace, normalizeITFValue, extractStateFields } = require('./parse-tlc-counterexample.cjs');

// Helper: create temp ITF file with content
function createTempITF(content) {
  const tmpPath = path.join('/tmp', `test-itf-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(content), 'utf8');
  return tmpPath;
}

// Helper: cleanup temp file
function cleanupTemp(tmpPath) {
  try {
    fs.unlinkSync(tmpPath);
  } catch (e) {
    // ignore
  }
}

test('parseITFTrace: parses minimal 2-state trace correctly', () => {
  const itf = {
    states: [
      { x: 0, y: 5 },
      { x: 1, y: 4 }
    ]
  };
  const tmpPath = createTempITF(itf);
  try {
    const result = parseITFTrace(tmpPath);
    assert.strictEqual(result.trace_length, 2);
    assert.deepStrictEqual(result.states[0], { x: 0, y: 5 });
    assert.deepStrictEqual(result.states[1], { x: 1, y: 4 });
    assert.strictEqual(result.loopPoint, null);
    assert.strictEqual(result.violated_invariant, null);
  } finally {
    cleanupTemp(tmpPath);
  }
});

test('parseITFTrace: extracts loopPoint when present', () => {
  const itf = {
    states: [
      { count: 0 },
      { count: 1 },
      { count: 2 }
    ],
    loop: 1  // Cycle starts at state 1
  };
  const tmpPath = createTempITF(itf);
  try {
    const result = parseITFTrace(tmpPath);
    assert.strictEqual(result.loopPoint, 1);
  } finally {
    cleanupTemp(tmpPath);
  }
});

test('parseITFTrace: extracts violated_invariant', () => {
  const itf = {
    states: [{ x: 0 }, { x: 1 }],
    violated_invariant: 'Inv1'
  };
  const tmpPath = createTempITF(itf);
  try {
    const result = parseITFTrace(tmpPath);
    assert.strictEqual(result.violated_invariant, 'Inv1');
  } finally {
    cleanupTemp(tmpPath);
  }
});

test('parseITFTrace: handles missing states array gracefully', () => {
  const itf = { loop: 0 };  // No states array
  const tmpPath = createTempITF(itf);
  try {
    const result = parseITFTrace(tmpPath);
    assert.deepStrictEqual(result.states, []);
    assert.strictEqual(result.trace_length, 0);
  } finally {
    cleanupTemp(tmpPath);
  }
});

test('parseITFTrace: throws on empty file', () => {
  const tmpPath = path.join('/tmp', `test-empty-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, '', 'utf8');
  try {
    assert.throws(
      () => parseITFTrace(tmpPath),
      /ITF file is empty/
    );
  } finally {
    cleanupTemp(tmpPath);
  }
});

test('parseITFTrace: throws on malformed JSON', () => {
  const tmpPath = path.join('/tmp', `test-bad-json-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, '{ invalid json }', 'utf8');
  try {
    assert.throws(
      () => parseITFTrace(tmpPath),
      /Malformed JSON/
    );
  } finally {
    cleanupTemp(tmpPath);
  }
});

test('parseITFTrace: handles JSON null trace without crashing', () => {
  const tmpPath = path.join('/tmp', `test-null-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmpPath, 'null', 'utf8');
  try {
    const result = parseITFTrace(tmpPath);
    assert.deepStrictEqual(result.states, []);
    assert.strictEqual(result.trace_length, 0);
    assert.strictEqual(result.loopPoint, null);
    assert.strictEqual(result.violated_invariant, null);
  } finally {
    cleanupTemp(tmpPath);
  }
});

test('parseITFTrace: handles non-array states without crashing', () => {
  const tmpPath = createTempITF({ states: { '0': { x: 0 } }, loop: 0 });
  try {
    const result = parseITFTrace(tmpPath);
    assert.deepStrictEqual(result.states, []);
    assert.strictEqual(result.trace_length, 0);
  } finally {
    cleanupTemp(tmpPath);
  }
});

test('normalizeITFValue: converts bigint encoding to string', () => {
  const value = { '#bigint': '123456789' };
  const result = normalizeITFValue(value);
  assert.strictEqual(result, '123456789');
  assert.strictEqual(typeof result, 'string');
});

test('normalizeITFValue: converts set encoding to sorted array', () => {
  const value = { '#set': [3, 1, 2] };
  const result = normalizeITFValue(value);
  assert(Array.isArray(result));
  assert.deepStrictEqual(result, [1, 2, 3]);
});

test('normalizeITFValue: converts map encoding to plain object', () => {
  const value = { '#map': [['k1', 'v1'], ['k2', 'v2']] };
  const result = normalizeITFValue(value);
  assert.deepStrictEqual(result, { k1: 'v1', k2: 'v2' });
});

test('normalizeITFValue: passes primitives through unchanged', () => {
  assert.strictEqual(normalizeITFValue(42), 42);
  assert.strictEqual(normalizeITFValue('hello'), 'hello');
  assert.strictEqual(normalizeITFValue(true), true);
  assert.strictEqual(normalizeITFValue(null), null);
});

test('normalizeITFValue: handles nested structures recursively', () => {
  const value = {
    timeout: { '#bigint': '5000' },
    phases: { '#set': [3, 1, 2] },
    config: { '#map': [['mode', 'fast']] }
  };
  const result = normalizeITFValue(value);
  assert.strictEqual(result.timeout, '5000');
  assert.deepStrictEqual(result.phases, [1, 2, 3]);
  assert.deepStrictEqual(result.config, { mode: 'fast' });
});

test('extractStateFields: filters to named fields only', () => {
  const states = [
    { x: 0, y: 5, z: 10 },
    { x: 1, y: 4, z: 10 }
  ];
  const result = extractStateFields(states, ['x', 'y']);
  assert.deepStrictEqual(result[0], { x: 0, y: 5 });
  assert.deepStrictEqual(result[1], { x: 1, y: 4 });
});

test('extractStateFields: returns all fields when no filter', () => {
  const states = [
    { x: 0, y: 5 },
    { x: 1, y: 4 }
  ];
  const result = extractStateFields(states, null);
  assert.deepStrictEqual(result, states);
});

test('extractStateFields: returns all fields when filter is empty array', () => {
  const states = [
    { x: 0, y: 5 }
  ];
  const result = extractStateFields(states, []);
  assert.deepStrictEqual(result, states);
});

test('extractStateFields: handles missing fields gracefully', () => {
  const states = [
    { x: 0, y: 5 }
  ];
  const result = extractStateFields(states, ['x', 'z']);
  assert.deepStrictEqual(result[0], { x: 0 });  // z not present
});

#!/usr/bin/env node
'use strict';
// bin/verify-formal-results.test.cjs
// Wave 0 RED scaffold for bin/verify-formal-results.cjs contract.
// Tests must FAIL in RED state (implementation script does not exist yet).
// Requirements: VERIFY-01, VERIFY-02

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Test 1: VERIFY-01 — module loads without SyntaxError ────────────────────
test('VERIFY-01: verify-formal-results.cjs loads without SyntaxError', () => {
  // This test FAILS in Wave 0 — module does not exist yet
  const scriptPath = path.join(__dirname, 'verify-formal-results.cjs');
  assert.ok(fs.existsSync(scriptPath),
    'bin/verify-formal-results.cjs must exist before it can be loaded');
  // If it exists, require it — catches SyntaxError at load time
  require(scriptPath);
});

// ─── Test 2: VERIFY-01 — parseNDJSON parses valid NDJSON lines ───────────────
test('VERIFY-01: parseNDJSON parses valid NDJSON lines into result objects', () => {
  const { parseNDJSON } = require('./verify-formal-results.cjs');
  const tmpFile = path.join(os.tmpdir(), 'fv-test-' + Date.now() + '.ndjson');
  const entries = [
    { formalism: 'tla', result: 'pass', check_id: 'tla:quorum-safety', summary: 'pass: tla:quorum-safety in 1823ms' },
    { formalism: 'tla', result: 'fail', check_id: 'tla:quorum-liveness', summary: 'fail: counterexample found' },
    { formalism: 'alloy', result: 'inconclusive', check_id: 'alloy:quorum-votes', summary: 'inconclusive: solver timeout' },
  ];
  fs.writeFileSync(tmpFile, entries.map(e => JSON.stringify(e)).join('\n'), 'utf8');
  try {
    const results = parseNDJSON(tmpFile);
    assert.strictEqual(results.length, 3, 'Should parse 3 NDJSON records');
    assert.strictEqual(results[0].formalism, 'tla');
    assert.strictEqual(results[1].result, 'fail');
    assert.strictEqual(results[2].formalism, 'alloy');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// ─── Test 3: VERIFY-01 — groupByFormalism groups results correctly ────────────
test('VERIFY-01: groupByFormalism returns counts keyed by formalism', () => {
  const { groupByFormalism } = require('./verify-formal-results.cjs');
  const results = [
    { formalism: 'tla', result: 'pass' },
    { formalism: 'tla', result: 'pass' },
    { formalism: 'tla', result: 'fail' },
    { formalism: 'alloy', result: 'inconclusive' },
    { formalism: 'prism', result: 'pass' },
  ];
  const grouped = groupByFormalism(results);
  assert.deepStrictEqual(grouped.tla, { pass: 2, fail: 1, warn: 0, inconclusive: 0 });
  assert.deepStrictEqual(grouped.alloy, { pass: 0, fail: 0, warn: 0, inconclusive: 1 });
  assert.deepStrictEqual(grouped.prism, { pass: 1, fail: 0, warn: 0, inconclusive: 0 });
});

// ─── Test 4: VERIFY-02 — generateFVSection produces ## Formal Verification ───
test('VERIFY-02: generateFVSection produces markdown section with expected structure', () => {
  const { generateFVSection } = require('./verify-formal-results.cjs');
  const grouped = {
    tla: { pass: 9, fail: 0, warn: 0, inconclusive: 0 },
  };
  const section = generateFVSection(grouped, 'run-formal-verify --only=tla', '2026-02-28T12:00:00Z');
  assert.match(section, /## Formal Verification/, 'Section must start with ## Formal Verification');
  assert.match(section, /pass.*9|9.*pass/, 'Section must show pass count of 9');
  assert.match(section, /Overall Status.*pass|pass.*Overall Status/i, 'Section must show overall status');
});

// ─── Test 5: VERIFY-01 edge — parseNDJSON returns empty array for empty file ─
test('VERIFY-01 edge: parseNDJSON returns empty array for empty file (fail-open)', () => {
  const { parseNDJSON } = require('./verify-formal-results.cjs');
  const tmpFile = path.join(os.tmpdir(), 'fv-empty-' + Date.now() + '.ndjson');
  fs.writeFileSync(tmpFile, '', 'utf8');
  try {
    const results = parseNDJSON(tmpFile);
    assert.ok(Array.isArray(results), 'Must return an array even for empty file');
    assert.strictEqual(results.length, 0, 'Empty NDJSON must return 0 results (fail-open)');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// ─── Test 6: VERIFY-01 edge — parseNDJSON skips malformed lines ───────────────
test('VERIFY-01 edge: parseNDJSON skips malformed JSON lines without throwing', () => {
  const { parseNDJSON } = require('./verify-formal-results.cjs');
  const tmpFile = path.join(os.tmpdir(), 'fv-malformed-' + Date.now() + '.ndjson');
  const content = [
    JSON.stringify({ formalism: 'tla', result: 'pass', check_id: 'tla:safety', summary: 'pass' }),
    'this is not valid json {{{',
    JSON.stringify({ formalism: 'tla', result: 'fail', check_id: 'tla:liveness', summary: 'fail' }),
  ].join('\n');
  fs.writeFileSync(tmpFile, content, 'utf8');
  try {
    // Must not throw — skip malformed line and return 2 valid records
    const results = parseNDJSON(tmpFile);
    assert.strictEqual(results.length, 2, 'Must parse 2 valid lines, skip 1 malformed line');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// ─── Test 7: VERIFY-02 — verification-report.md template includes ## Formal Verification ─
test('VERIFY-02: core/templates/verification-report.md contains ## Formal Verification section', () => {
  const templatePath = path.join(__dirname, '..', 'core', 'templates', 'verification-report.md');
  assert.ok(fs.existsSync(templatePath), 'verification-report.md must exist');
  const src = fs.readFileSync(templatePath, 'utf8');
  assert.match(src, /## Formal Verification/,
    'Template must contain ## Formal Verification section (VERIFY-02)');
});

// ─── VERIFY-01 edge — groupByFormalism survives a bare `null` NDJSON record ───
test('VERIFY-01 edge: parseNDJSON + groupByFormalism survives a bare `null` NDJSON line', () => {
  const { parseNDJSON, groupByFormalism } = require('./verify-formal-results.cjs');
  const tmpFile = path.join(os.tmpdir(), 'fv-null-' + Date.now() + '.ndjson');
  const content = [
    JSON.stringify({ formalism: 'tla', result: 'pass' }),
    'null', // valid JSON scalar — slips past parseNDJSON's malformed-line guard
    JSON.stringify({ formalism: 'tla', result: 'fail' }),
  ].join('\n');
  fs.writeFileSync(tmpFile, content, 'utf8');
  try {
    const results = parseNDJSON(tmpFile);
    // Currently throws: Cannot read properties of null (reading 'formalism')
    const grouped = groupByFormalism(results);
    assert.deepStrictEqual(grouped.tla, { pass: 1, fail: 1, warn: 0, inconclusive: 0 },
      'null record must be skipped; valid records grouped normally');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// ─── VERIFY-01 edge — groupByFormalism must not drop a '__proto__' formalism ───
test('VERIFY-01 edge: groupByFormalism records a record whose formalism is "__proto__"', () => {
  const { groupByFormalism } = require('./verify-formal-results.cjs');
  const grouped = groupByFormalism([{ formalism: '__proto__', result: 'fail' }]);
  assert.ok(Object.prototype.hasOwnProperty.call(grouped, '__proto__'),
    '__proto__ formalism must become an own key, not be swallowed by the prototype chain');
  assert.strictEqual(grouped['__proto__'].fail, 1,
    'fail count must be 1, not silently dropped');
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { detectAssumptionDelta, suggestInvariant } = require('./detect-assumption-delta.cjs');

const BIN = path.join(__dirname, 'detect-assumption-delta.cjs');

test('detects pluralization drift and attaches a multiplicity invariant', () => {
  const r = detectAssumptionDelta('The wizard now supports multiple provider slots per project.');
  assert.strictEqual(r.detected, true);
  const plural = r.signals.find((s) => s.kind === 'pluralization');
  assert.ok(plural, 'a pluralization signal fired');
  assert.strictEqual(plural.suggestion.layer, 'multiplicity');
  assert.match(plural.suggestion.invariant_sketch, /Cardinality|set|function/i);
});

test('detects optional drift → nullability invariant', () => {
  const r = detectAssumptionDelta('The apiKey field is now optional.');
  const s = r.signals.find((x) => x.kind === 'optional');
  assert.ok(s);
  assert.strictEqual(s.suggestion.layer, 'nullability');
  assert.match(s.suggestion.invariant_sketch, /NULL/);
});

test('detects chosen/parameterization drift → parameterization invariant', () => {
  const r = detectAssumptionDelta('The retry limit is now configurable per-project.');
  const s = r.signals.find((x) => x.kind === 'chosen');
  assert.ok(s);
  assert.strictEqual(s.suggestion.layer, 'parameterization');
  assert.match(s.suggestion.invariant_sketch, /CONSTANT|ASSUME/);
});

test('cue terms inside fenced code do NOT fire', () => {
  const text = ['Scope: single fixed value.', '', '```', 'const opts = { multiple: true, optional: false };', '```'].join('\n');
  assert.strictEqual(detectAssumptionDelta(text).detected, false, 'fenced code is stripped before scanning');
});

test('word-boundary: interior substrings do not match', () => {
  // "seconds" must not fire the "second" cue; "optionally" IS a real cue.
  const r = detectAssumptionDelta('Timeout is 30 seconds.');
  assert.strictEqual(r.detected, false, '"seconds" is not the "second" cue');
});

test('non-string / empty input degrades to not-detected without throwing', () => {
  assert.strictEqual(detectAssumptionDelta(null).detected, false);
  assert.strictEqual(detectAssumptionDelta('').detected, false);
  assert.strictEqual(detectAssumptionDelta('   ').detected, false);
});

test('suggestInvariant covers all three kinds + unknown', () => {
  assert.strictEqual(suggestInvariant({ kind: 'pluralization' }).layer, 'multiplicity');
  assert.strictEqual(suggestInvariant({ kind: 'optional' }).layer, 'nullability');
  assert.strictEqual(suggestInvariant({ kind: 'chosen' }).layer, 'parameterization');
  assert.strictEqual(suggestInvariant({ kind: 'weird' }).layer, 'unknown');
});

test('CLI: STDIN → JSON, exit 0 on detect', () => {
  const out = execFileSync(process.execPath, [BIN, '--json'], { input: 'Add a second fallback provider.', encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.strictEqual(r.detected, true);
  assert.ok(r.signals[0].suggestion.invariant_sketch.length > 0);
});

test('CLI: exit 1 when no signal', () => {
  let code = 0;
  try { execFileSync(process.execPath, [BIN, '--json'], { input: 'A single fixed timeout.', encoding: 'utf8' }); }
  catch (e) { code = e.status; }
  assert.strictEqual(code, 1);
});

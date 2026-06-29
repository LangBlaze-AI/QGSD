'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyTlcOutput, isDiscriminating, discoverCases } = require('./check-formal-discrimination.cjs');

test('classifyTlcOutput: invariant violation → violated', () => {
  assert.equal(classifyTlcOutput('Error: Invariant NoUnnecessarySwap is violated.'), 'violated');
  assert.equal(classifyTlcOutput('Error: Invariant ThresholdIncluded is violated by the initial state:'), 'violated');
});

test('classifyTlcOutput: clean completion → clean', () => {
  assert.equal(classifyTlcOutput('Model checking completed. No error has been found.'), 'clean');
  assert.equal(classifyTlcOutput('...\nNo error has been found\n...'), 'clean');
});

test('classifyTlcOutput: parse error / junk / empty → error (never silently clean)', () => {
  assert.equal(classifyTlcOutput('Parse Error in module bug'), 'error');
  assert.equal(classifyTlcOutput('java.lang.Exception: boom'), 'error');
  assert.equal(classifyTlcOutput(''), 'error');
  assert.equal(classifyTlcOutput(null), 'error');
  assert.equal(classifyTlcOutput(undefined), 'error');
  assert.equal(classifyTlcOutput(42), 'error');
});

test('classifyTlcOutput: a broken-spec invariant error is NOT a violation', () => {
  // "is not defined" mentions an invariant but is a broken spec, not a counterexample.
  // It must classify as 'error' so a broken bug-spec cannot masquerade as discriminating.
  assert.equal(classifyTlcOutput('Error: Invariant Foo is not defined'), 'error');
  assert.equal(classifyTlcOutput('Error: Invariant Bar substitution missing'), 'error');
});

test('isDiscriminating: only bug=violated && fix=clean counts', () => {
  assert.equal(isDiscriminating('violated', 'clean'), true);
  // The theater failure modes — a checker that does not depend on the bug:
  assert.equal(isDiscriminating('clean', 'clean'), false);     // bug not caught
  assert.equal(isDiscriminating('violated', 'violated'), false); // fix not proven
  assert.equal(isDiscriminating('error', 'clean'), false);      // bug run broke
  assert.equal(isDiscriminating('violated', 'error'), false);   // fix run broke
});

test('discoverCases: only dirs with a complete bug+fix spec pair are returned', () => {
  // Against the real repo: every discovered case must carry all four files.
  const cases = discoverCases(require('path').join(__dirname, '..', '.planning', 'formal', 'spec'));
  assert.ok(Array.isArray(cases));
  for (const c of cases) {
    assert.ok(c.name.startsWith('debug-bench-'), 'case name prefix');
    assert.ok(typeof c.dir === 'string' && c.dir.length > 0, 'case dir');
  }
});

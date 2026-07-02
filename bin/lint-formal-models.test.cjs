'use strict';

// Unit tests for the static formal-model semantic checks added to
// lint-formal-models.cjs. These catch semantic corruption (a reference to a
// signature that is not defined) that the structural counters miss — the gap
// that made the benchmark's f_to_f detection challenges unwinnable — while
// staying --fast-native (pure static analysis, no Alloy/TLC invocation).

const { test } = require('node:test');
const assert = require('node:assert');
const { checkAlloyDanglingRefs, extractAlloyTypeRefs, stripAlloyComments, parseAlloySigs } = require('./lint-formal-models.cjs');

function danglingRules(content) {
  return checkAlloyDanglingRefs(content, parseAlloySigs(content))
    .filter(v => v.rule === 'dangling-sig-ref')
    .map(v => v.message);
}

test('detects a predicate quantifying over a nonexistent signature', () => {
  const model = [
    'sig ValidSig { f: one ValidSig }',
    'pred Corrupt {',
    '  some x: NonexistentSignature | x.f = x',
    '}',
    'run Corrupt for 3',
  ].join('\n');
  const msgs = danglingRules(model);
  assert.ok(msgs.some(m => m.includes('NonexistentSignature')),
    'expected a dangling-sig-ref for NonexistentSignature, got: ' + JSON.stringify(msgs));
});

test('detects a field targeting an undefined signature', () => {
  const model = 'sig A { link: one MissingSig }';
  const msgs = danglingRules(model);
  assert.ok(msgs.some(m => m.includes('MissingSig')), JSON.stringify(msgs));
});

test('detects an extends of an undefined parent signature', () => {
  const model = 'sig Child extends GhostParent { }';
  const msgs = danglingRules(model);
  assert.ok(msgs.some(m => m.includes('GhostParent')), JSON.stringify(msgs));
});

test('clean model: quantifiers over defined sigs produce no dangling ref', () => {
  const model = [
    'sig Account { }',
    'sig PoolState { active: lone Account }',
    'pred Valid { all p: PoolState | some a: Account | p.active = a }',
    'run Valid for 3',
  ].join('\n');
  assert.deepStrictEqual(danglingRules(model), [], 'valid model must be clean');
});

test('no false positive from Capitalized words in comments/prose', () => {
  const model = [
    'sig Node { }',
    '-- Coverage: V8 Digest of URLs and Structural Disjointness per INTENT-03',
    '// The Hypothesis references Every Trace and Phase; ID exists in Envelope',
    'sig Line { at: one Node -- must always be False per INTENT-03',
    '}',
  ].join('\n');
  assert.deepStrictEqual(danglingRules(model), [],
    'Capitalized words in comments must not be read as signatures');
});

test('Bool/Int/univ/seq built-ins are not flagged as dangling', () => {
  const model = 'sig S { flag: one Bool, n: one Int, u: set univ }';
  assert.deepStrictEqual(danglingRules(model), []);
});

test('stripAlloyComments removes line and block comments', () => {
  const stripped = stripAlloyComments('sig A {} -- c1\n/* block\nInside */ sig B {} // c2');
  assert.ok(!/c1|block|Inside|c2/.test(stripped), stripped);
  assert.ok(/sig A/.test(stripped) && /sig B/.test(stripped));
});

test('extractAlloyTypeRefs pulls Capitalized tokens, ignoring inline comments', () => {
  assert.deepStrictEqual(extractAlloyTypeRefs('Account -> lone Balance'), ['Account', 'Balance']);
  assert.deepStrictEqual(extractAlloyTypeRefs('Bool  -- must be False per INTENT-03'), ['Bool']);
});

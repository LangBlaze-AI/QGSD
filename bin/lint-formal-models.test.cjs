'use strict';

// Unit tests for the static formal-model semantic checks added to
// lint-formal-models.cjs. These catch semantic corruption (a reference to a
// signature that is not defined) that the structural counters miss — the gap
// that made the benchmark's f_to_f detection challenges unwinnable — while
// staying --fast-native (pure static analysis, no Alloy/TLC invocation).

const { test } = require('node:test');
const assert = require('node:assert');
const { checkAlloyDanglingRefs, extractAlloyTypeRefs, stripAlloyComments, parseAlloySigs, checkTLATrivialInvariant, isTrivialTautology, stripTLAComments } = require('./lint-formal-models.cjs');

function trivialRules(content) {
  return checkTLATrivialInvariant(content).filter(v => v.rule === 'trivial-invariant').map(v => v.message);
}

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
  // Block comments must also be stripped (CodeRabbit review on #297).
  assert.deepStrictEqual(extractAlloyTypeRefs('one /* Some Prose Word */ Balance'), ['Balance']);
});

test('no false positive from a Capitalized word inside a block comment in a field type', () => {
  const model = 'sig Account {}\nsig Ledger { bal: one /* Legacy Balance Field */ Account }';
  assert.deepStrictEqual(danglingRules(model), [],
    'a block comment in a field type must not produce a dangling-sig-ref');
});

// ── TLA+ trivial-invariant detection (BENCH-023) ────────────────────────────
// A meaningful safety invariant replaced with a tautology (x = x) is corruption
// the structural counters and the precomputed TLC report both miss. Detected
// purely from source so it fires during a --fast benchmark solve.

test('detects a multi-line invariant whose body was replaced with x = x', () => {
  const model = [
    '---- MODULE M ----',
    'VARIABLES recovered, fileExists',
    'RecoveryRequiresFile ==',
    '    recovered = recovered',
    '====',
  ].join('\n');
  assert.deepStrictEqual(trivialRules(model),
    ['RecoveryRequiresFile has a trivially-true body: recovered = recovered']);
});

test('detects inline x = x, x <= x, and 1 = 1 tautologies', () => {
  assert.ok(isTrivialTautology('x = x'));
  assert.ok(isTrivialTautology('stepCount <= stepCount'));
  assert.ok(isTrivialTautology('n >= n'));
  assert.ok(isTrivialTautology('1 = 1'));
});

test('does NOT flag UNCHANGED (x\' = x) — the prime makes the tokens differ', () => {
  assert.ok(!isTrivialTautology("recovered' = recovered"));
  const model = '---- MODULE M ----\nKeep ==\n    x\' = x\n====';
  assert.deepStrictEqual(trivialRules(model), []);
});

test('does NOT flag a meaningful implication invariant', () => {
  const model = [
    '---- MODULE M ----',
    'ActivityValid ==',
    '    fileExists = TRUE => activity \\in Activities',
    '====',
  ].join('\n');
  assert.deepStrictEqual(trivialRules(model), []);
});

test('does NOT flag bare TRUE — a documented placeholder invariant is legitimate', () => {
  const model = '---- MODULE M ----\nWizardStartsCorrectly ==\n    TRUE \\* Enforced by Init\n====';
  assert.deepStrictEqual(trivialRules(model), []);
});

test('does NOT flag a different-identifier equality (x = y)', () => {
  assert.ok(!isTrivialTautology('x = y'));
  assert.ok(!isTrivialTautology('a = b'));
});

test('ignores content after the ==== module terminator', () => {
  const model = '---- MODULE M ----\nReal ==\n    x => y\n====\ntrailing == z = z';
  assert.deepStrictEqual(trivialRules(model), [],
    'a tautology after the terminator is dead text, not a spec definition');
});

test('does NOT flag a tautology hidden inside a comment', () => {
  const model = '---- MODULE M ----\nReal ==\n    x => y  \\* note: x = x would be trivial\n====';
  assert.deepStrictEqual(trivialRules(model), []);
});

test('stripTLAComments removes line and block comments', () => {
  const stripped = stripTLAComments('Foo == bar \\* trailing\n(* block\ncomment *)\nBaz == qux');
  assert.ok(/Foo == bar/.test(stripped) && /Baz == qux/.test(stripped));
  assert.ok(!/trailing/.test(stripped) && !/block/.test(stripped));
});

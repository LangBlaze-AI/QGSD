'use strict';

// Tests for the pure helpers of the formal-model teeth tester. The TLC-driven run() is
// integration-only (needs tla2tools.jar); these lock the parsing that decides which
// variables get frozen and whether a model asserts a real property.

const { test } = require('node:test');
const assert = require('node:assert');
const { literalInits, cfgSpecAndConstants, ownAssertedInvariants } = require('./formal-model-teeth.cjs');

test('literalInits extracts only literal (=) init conjuncts, not nondeterministic (\\in)', () => {
  const tla = [
    '---- MODULE Foo ----',
    'Init ==',
    '    /\\ iteration = 0',
    '    /\\ status = "running"',
    '    /\\ goalMet = FALSE',
    '    /\\ pool \\in 0..MaxN',   // nondeterministic — must be skipped
    '',
    'Next == iteration\' = iteration + 1',
    '====',
  ].join('\n');
  const inits = literalInits(tla);
  const names = inits.map(i => i.name);
  assert.deepStrictEqual(names.sort(), ['goalMet', 'iteration', 'status']);
  assert.ok(!names.includes('pool'), 'nondeterministic \\in init is not frozen');
  assert.strictEqual(inits.find(i => i.name === 'status').value, '"running"');
});

test('literalInits handles the first conjunct with no leading /\\ (single-line and mixed)', () => {
  assert.deepStrictEqual(literalInits('Init == x = 0\n\nNext == TRUE').map(i => i.name), ['x'], 'single conjunct, no /\\');
  const two = literalInits('Init == x = 0 /\\ y = 1\n\nNext == TRUE');
  assert.deepStrictEqual(two.map(i => i.name).sort(), ['x', 'y'], 'first conjunct without /\\ still frozen');
});

test('cfgSpecAndConstants pulls the SPECIFICATION name and the CONSTANTS block', () => {
  const cfg = ['\\* header', 'SPECIFICATION Spec', 'CONSTANTS', '    MaxN = 4', '    MaxT = 60', 'INVARIANT TypeOK'].join('\n');
  const { spec, constants } = cfgSpecAndConstants(cfg);
  assert.strictEqual(spec, 'Spec');
  assert.deepStrictEqual(constants, ['MaxN = 4', 'MaxT = 60']);
});

test('ownAssertedInvariants counts non-TypeOK invariants and any PROPERTY, excludes TypeOK', () => {
  assert.strictEqual(ownAssertedInvariants('INVARIANT TypeOK').length, 0, 'TypeOK-only asserts nothing');
  assert.strictEqual(ownAssertedInvariants('INVARIANT TypeOK\nINVARIANT MutualExclusion').length, 1);
  assert.strictEqual(ownAssertedInvariants('INVARIANT TypeOK\nPROPERTY EventuallyDone').length, 1, 'a temporal property counts');
  assert.strictEqual(ownAssertedInvariants('INVARIANT TypeOK\nINVARIANT Safe\nPROPERTY Live').length, 2);
});

test('ownAssertedInvariants handles the multi-line INVARIANTS/PROPERTIES block form', () => {
  const cfg = ['SPECIFICATION Spec', 'CONSTANTS', '    MaxPool = 4', 'INVARIANTS', '    TypeOK', '    ActiveIsPoolMember', '    NoActiveWhenEmpty', 'PROPERTIES', '    IdleReachable'].join('\n');
  const got = ownAssertedInvariants(cfg);
  assert.deepStrictEqual(got.sort(), ['ActiveIsPoolMember', 'IdleReachable', 'NoActiveWhenEmpty'], 'block-form names counted, TypeOK excluded');
});

test('ownAssertedInvariants ignores pure fairness (WF_/SF_) in a PROPERTIES block', () => {
  const cfg = ['SPECIFICATION Spec', 'INVARIANTS', '    TypeOK', 'PROPERTIES', '    /\\ WF_vars(Finish)', '    /\\ SF_vars(Retry)'].join('\n');
  assert.strictEqual(ownAssertedInvariants(cfg).length, 0, 'fairness-only asserts no checked property');
});

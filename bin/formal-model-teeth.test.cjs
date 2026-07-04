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

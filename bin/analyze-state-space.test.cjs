'use strict';

// Tests for the cfg→module derivation fallback in analyze-state-space.cjs.
// Regression guard for the state-space-guard false-block: FSM-transpiled MC* cfgs that
// are NOT in the static CFG_TO_MODULE table must still have their CONSTANTS linked, so
// bounded ranges like 0..MaxN resolve instead of reading as unbounded → HIGH → blocked.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { analyzeModel } = require('./analyze-state-space.cjs');

function tmpProject(tlaName, tlaBody, cfgName, cfgBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
  const dir = path.join(root, '.planning', 'formal', 'tla');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, tlaName), tlaBody);
  fs.writeFileSync(path.join(dir, cfgName), cfgBody);
  return root;
}

const TLA = [
  '---- MODULE Foo ----',
  'EXTENDS Naturals',
  'CONSTANTS MaxN',
  'VARIABLES x',
  '',
  'TypeOK ==',
  '    /\\ x \\in 0..MaxN',
  '',
  'Init == x = 0',
  'Next == x\' = x',
  'Spec == Init /\\ [][Next]_x',
  '====',
].join('\n');

test('cfg NOT in the static map: header ".tla" reference links CONSTANTS → bounded, not HIGH', () => {
  const cfg = ['\\* TLC model for Foo.tla', 'SPECIFICATION Spec', 'CONSTANTS', '    MaxN = 4', 'INVARIANT TypeOK'].join('\n');
  const root = tmpProject('Foo.tla', TLA, 'MCFooLookup.cfg', cfg);
  try {
    const a = analyzeModel('MCFooLookup', root);
    assert.notStrictEqual(a.risk_level, 'HIGH', 'MaxN=4 resolves → 0..4 bounded, not falsely HIGH');
    assert.strictEqual(a.estimated_states, 5, '0..4 = 5 states');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cfg header prose "for Foo" (no .tla suffix) also links CONSTANTS', () => {
  const cfg = ['\\* TLC configuration for Foo', 'SPECIFICATION Spec', 'CONSTANT MaxN = 3', 'INVARIANT TypeOK'].join('\n');
  const root = tmpProject('Foo.tla', TLA, 'MCFooProse.cfg', cfg);
  try {
    const a = analyzeModel('MCFooProse', root);
    assert.notStrictEqual(a.risk_level, 'HIGH');
    assert.strictEqual(a.estimated_states, 4, '0..3 = 4 states');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('MC-prefix strip resolves when the module file matches the stripped basename', () => {
  const cfg = ['\\* no useful header here', 'SPECIFICATION Spec', 'CONSTANTS', '    MaxN = 2', 'INVARIANT TypeOK'].join('\n');
  const root = tmpProject('Foo.tla', TLA, 'MCFoo.cfg', cfg); // MCFoo → strip MC → Foo.tla exists
  try {
    const a = analyzeModel('MCFoo', root);
    assert.notStrictEqual(a.risk_level, 'HIGH');
    assert.strictEqual(a.estimated_states, 3, '0..2 = 3 states');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('genuinely unresolvable cfg stays conservative (no false LOW)', () => {
  // Unbounded Nat domain with no bounding constant — must remain HIGH.
  const tla = TLA.replace('/\\ x \\in 0..MaxN', '/\\ x \\in Nat');
  const cfg = ['\\* TLC model for Foo.tla', 'SPECIFICATION Spec', 'INVARIANT TypeOK'].join('\n');
  const root = tmpProject('Foo.tla', tla, 'MCFooUnbounded.cfg', cfg);
  try {
    const a = analyzeModel('MCFooUnbounded', root);
    assert.strictEqual(a.risk_level, 'HIGH', 'unbounded Nat is genuinely HIGH');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

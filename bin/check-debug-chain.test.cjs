'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadManifest, chainHolds } = require('./check-debug-chain.cjs');

test('chainHolds: requires ALL four endpoints true', () => {
  assert.equal(chainHolds({ codeBug: true, modelBug: true, modelFix: true, codeFix: true }), true);
  // Each missing endpoint breaks the chain (these are the real failure modes):
  assert.equal(chainHolds({ codeBug: false, modelBug: true, modelFix: true, codeFix: true }), false); // code didn't reproduce
  assert.equal(chainHolds({ codeBug: true, modelBug: false, modelFix: true, codeFix: true }), false); // model didn't reproduce (the sort-drift mode)
  assert.equal(chainHolds({ codeBug: true, modelBug: true, modelFix: false, codeFix: true }), false); // fix not proven in model
  assert.equal(chainHolds({ codeBug: true, modelBug: true, modelFix: true, codeFix: false }), false); // fix not proven in code
});

test('loadManifest: parses the real manifest and every entry is complete', () => {
  const path = require('path');
  const cases = loadManifest(path.join(__dirname, '..', 'benchmarks', 'debug', 'chain', 'manifest.json'));
  assert.ok(Array.isArray(cases) && cases.length >= 3, 'expected >=3 chain cases');
  for (const c of cases) {
    for (const k of ['case', 'stub', 'test', 'model', 'fixed']) {
      assert.equal(typeof c[k], 'string', `case ${c.case} missing ${k}`);
    }
  }
});

test('loadManifest: malformed / missing file → [] (never throws)', () => {
  assert.deepEqual(loadManifest('/no/such/manifest.json'), []);
});

'use strict';

// Dogfood Batch 10 (data-integrity): solve-tui's dtoc cache key hashed only
// `item.reason`, which is generic for whole classes of items (e.g. "not in any
// dependency manifest"). Dozens of distinct items collapsed to ONE key, so a single
// Haiku classification verdict was silently applied to all of them (44 → 1 observed).
// The key now also discriminates on value + doc_file.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { itemKey } = require('./solve-tui.cjs');

// Batch 10: close-formal-gaps (formal-model-loop) crashed deref'ing modelResult.spec
// on iteration 2 when iteration 1 failed before modelResult was set. Exercised
// behaviorally via the injectable callLlm.
const { refineModel } = require('./formal-model-loop.cjs');
describe('formal-model-loop regenerates instead of deref-ing a null prior result', () => {
  it('iteration 1 failing (no modelResult) does not crash iteration 2', async () => {
    let calls = 0;
    // iter 1: LLM "fails" (non-zero status, no stdout) → modelResult stays null.
    // iter 2: returns a valid model → must regenerate (not refine a null), then validate.
    const callLlm = async () => {
      calls++;
      if (calls === 1) return { status: 1, stdout: '' }; // generate fails on iter 1
      if (calls === 2) return { status: 0, stdout: 'SPEC_START\n```alloy\nsig X {}\n```\nSPEC_END\nINVARIANT: x>0\nENGLISH: x must be positive\nBUG_EXPLANATION: off-by-one' };
      return { status: 0, stdout: 'EXPLAINS — the model matches' }; // validate
    };
    const result = await refineModel({
      codeSource: 'function f(){}', testSource: 'test()', testFailureOutput: 'FAIL\n',
      formalism: 'alloy', maxIterations: 3, callLlm, onLog: () => {},
    });
    assert.equal(result.converged, true, 'must recover and converge, not crash on a null prior result');
    assert.ok(result.invariant, 'a real model was produced on iteration 2');
  });
});

describe('solve-tui dtoc itemKey discriminates distinct items', () => {
  const reason = 'not in any dependency manifest';

  it('two dtoc items with the same reason but different value/doc_file get distinct keys', () => {
    const a = itemKey('dtoc', { reason, value: 'foo', doc_file: 'a.md' });
    const b = itemKey('dtoc', { reason, value: 'bar', doc_file: 'b.md' });
    assert.notEqual(a, b, 'distinct items must not collapse to one cache key');
  });

  it('the same dtoc item hashes stably (cache still works)', () => {
    const a = itemKey('dtoc', { reason, value: 'foo', doc_file: 'a.md' });
    const a2 = itemKey('dtoc', { reason, value: 'foo', doc_file: 'a.md' });
    assert.equal(a, a2, 'an identical item must hash to the same key');
  });

  it('differs by value alone and by doc_file alone', () => {
    const base = { reason, value: 'foo', doc_file: 'a.md' };
    assert.notEqual(itemKey('dtoc', base), itemKey('dtoc', { ...base, value: 'foo2' }));
    assert.notEqual(itemKey('dtoc', base), itemKey('dtoc', { ...base, doc_file: 'b.md' }));
  });
});

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
// on iteration 2 when iteration 1 failed before modelResult was set. Source-guarded
// (a behavioral test would require mocking the whole LLM refine loop).
describe('formal-model-loop regenerates instead of deref-ing a null prior result', () => {
  it('the refine branch is guarded by `i === 1 || !modelResult`', () => {
    const src = fs.readFileSync(path.join(__dirname, 'formal-model-loop.cjs'), 'utf8');
    assert.match(src, /if \(i === 1 \|\| !modelResult\)/, 'must regenerate when there is no prior modelResult to refine');
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

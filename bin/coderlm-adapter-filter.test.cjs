#!/usr/bin/env node
'use strict';
// bin/coderlm-adapter-filter.test.cjs
// Unit tests for filterSourceCallers — the documentation/prose caller filter.
//
// coderlm indexes Markdown/docs and reports prose mentions of a symbol as
// "callers", which inflates caller-count priority ranking in nf:solve
// (sweepGitHeatmap / sweepCtoR / sweepTtoR). filterSourceCallers drops those
// non-source entries so caller counts reflect real call sites only.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const coderlmAdapter = require('./coderlm-adapter.cjs');
const { filterSourceCallers } = coderlmAdapter;

// Contract guard: the /nf:coderlm skill's query subcommands call the query
// methods on the object returned by createAdapter() — NOT on the module itself.
// The query methods are instance methods, so calling them on the bare module
// (the original skill bug) throws "adapter.getCallers is not a function".
// This locks the API shape the skill depends on.
describe('adapter API contract (consumed by /nf:coderlm skill)', () => {
  it('module exports createAdapter (a factory), not the query methods directly', () => {
    assert.equal(typeof coderlmAdapter.createAdapter, 'function');
    assert.equal(typeof coderlmAdapter.getCallers, 'undefined',
      'query methods must live on the instance, not the module');
  });

  it('createAdapter() returns an instance exposing the skill query methods', () => {
    const inst = coderlmAdapter.createAdapter();
    for (const m of ['getCallers', 'getImplementation', 'findTests', 'peek']) {
      assert.equal(typeof inst[m], 'function', `instance must expose ${m}()`);
    }
  });
});

describe('filterSourceCallers', () => {
  it('is exported as a function', () => {
    assert.equal(typeof filterSourceCallers, 'function');
  });

  it('drops Markdown/doc caller objects, keeps code callers', () => {
    const input = [
      { file: 'bin/coderlm-lifecycle.cjs', line: 218, text: 'ensureRunning()' },
      { file: 'docs/coderlm-integration.md', line: 96, text: '- ensureRunning' },
      { file: 'bin/coderlm-lifecycle.test.cjs', line: 259, text: 'lifecycle.ensureRunning()' },
      { file: 'README.md', line: 12, text: 'call ensureRunning to start' },
    ];
    const out = filterSourceCallers(input);
    assert.deepEqual(out.map(c => c.file), [
      'bin/coderlm-lifecycle.cjs',
      'bin/coderlm-lifecycle.test.cjs',
    ]);
  });

  it('filters every known prose extension (.md/.markdown/.mdx/.txt/.rst/.adoc)', () => {
    const docs = ['a.md', 'b.markdown', 'c.mdx', 'd.txt', 'e.rst', 'f.adoc']
      .map(f => ({ file: f, line: 1 }));
    assert.equal(filterSourceCallers(docs).length, 0);
  });

  it('is case-insensitive on the extension (.MD, .Md)', () => {
    const input = [{ file: 'NOTES.MD', line: 1 }, { file: 'x.js', line: 2 }];
    assert.deepEqual(filterSourceCallers(input).map(c => c.file), ['x.js']);
  });

  it('keeps source extensions that merely contain doc letters (.mjs, .mts)', () => {
    const input = [
      { file: 'bin/unified-mcp-server.mjs', line: 1 },
      { file: 'src/x.mts', line: 2 },
      { file: 'src/y.md', line: 3 },
    ];
    assert.deepEqual(filterSourceCallers(input).map(c => c.file),
      ['bin/unified-mcp-server.mjs', 'src/x.mts']);
  });

  it('supports string entries (legacy shape), not just objects', () => {
    const input = ['bin/x.cjs', 'docs/guide.md', 'bin/y.js'];
    assert.deepEqual(filterSourceCallers(input), ['bin/x.cjs', 'bin/y.js']);
  });

  it('keeps entries with no extension (e.g. a Makefile or odd path)', () => {
    const input = [{ file: 'Makefile', line: 1 }, { file: 'bin/tool', line: 2 }];
    assert.equal(filterSourceCallers(input).length, 2);
  });

  it('keeps entries of unknown shape rather than dropping data (fail-open)', () => {
    const input = [{ line: 5 }, { file: 42 }, null, { file: 'a.md' }];
    const out = filterSourceCallers(input);
    // the three non-string-file entries are preserved; only a.md is dropped
    assert.equal(out.length, 3);
    assert.ok(!out.some(c => c && c.file === 'a.md'));
  });

  it('passes non-array input through untouched (fail-open)', () => {
    assert.equal(filterSourceCallers(undefined), undefined);
    assert.equal(filterSourceCallers(null), null);
    const obj = { error: 'disabled' };
    assert.equal(filterSourceCallers(obj), obj);
  });

  it('returns an empty array unchanged', () => {
    assert.deepEqual(filterSourceCallers([]), []);
  });
});

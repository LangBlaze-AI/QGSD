#!/usr/bin/env node
'use strict';
// bin/repowise/inject-cochange-debug.test.cjs
// Tests for bin/repowise/inject-cochange-debug.cjs — Co-change debug injection

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { injectCoChangeDebug, loadCachedCoChange, saveCachedCoChange } = require('./inject-cochange-debug.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// injectCoChangeDebug
// ---------------------------------------------------------------------------

describe('injectCoChangeDebug', () => {
  it('returns null for file with no co-change partners', () => {
    const result = injectCoChangeDebug('nonexistent/file.xyz', PROJECT_ROOT);
    assert.equal(result, null);
  });

  it('returns formatted string when partners exist', () => {
    const { computeCoChange } = require('./cochange.cjs');
    const { loadCachedCoChange } = require('./inject-cochange-debug.cjs');
    // Use the same data source injectCoChangeDebug will use: cache first, then live
    const cochange = loadCachedCoChange(PROJECT_ROOT) ?? computeCoChange(PROJECT_ROOT);
    if (cochange.pairs.length > 0) {
      const file = cochange.pairs[0].file1;
      const result = injectCoChangeDebug(file, PROJECT_ROOT);
      assert.ok(result !== null, 'should return a string for a file with partners');
      assert.ok(result.includes('CO-CHANGE PARTNERS'), 'should include header');
      assert.ok(result.includes(file), 'should mention the file');
    }
  });

  it('output mentions partner files', () => {
    const { computeCoChange } = require('./cochange.cjs');
    const { loadCachedCoChange } = require('./inject-cochange-debug.cjs');
    // Use the same data source injectCoChangeDebug will use: cache first, then live
    const cochange = loadCachedCoChange(PROJECT_ROOT) ?? computeCoChange(PROJECT_ROOT);
    if (cochange.pairs.length > 0) {
      const { file1, file2 } = cochange.pairs[0];
      const result = injectCoChangeDebug(file1, PROJECT_ROOT);
      if (result) {
        assert.ok(result.includes(file2), 'should mention partner file');
        assert.ok(result.includes('shared commits'), 'should include shared commits');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// DP-1: cache helpers fail open on bad projectRoot
// ---------------------------------------------------------------------------

describe('cache helpers fail-open on bad projectRoot', () => {
  it('loadCachedCoChange returns null for non-string projectRoot instead of throwing', () => {
    assert.equal(loadCachedCoChange(undefined), null);
    assert.equal(loadCachedCoChange(null), null);
    assert.equal(loadCachedCoChange(123), null);
  });

  it('saveCachedCoChange does not throw for non-string projectRoot', () => {
    assert.doesNotThrow(() => saveCachedCoChange(undefined, { pairs: [], summary: {} }));
    assert.doesNotThrow(() => saveCachedCoChange(null, { pairs: [], summary: {} }));
  });
});

// ---------------------------------------------------------------------------
// DP-2: corrupt cache shape (pairs missing / not an array)
// ---------------------------------------------------------------------------

describe('injectCoChangeDebug corrupt-cache shape', () => {
  it('does not crash when cache is missing the pairs array', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cochange-shape-'));
    const cacheDir = path.join(tmp, '.planning', 'repowise');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'cochange-cache.json'), JSON.stringify({ summary: {} }));
    let result;
    assert.doesNotThrow(() => { result = injectCoChangeDebug('some/file.js', tmp); });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// DP-3: malformed pair entry (null / non-object inside pairs)
// ---------------------------------------------------------------------------

describe('injectCoChangeDebug malformed pair entry', () => {
  it('does not crash on a null entry inside pairs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cochange-pair-'));
    const cacheDir = path.join(tmp, '.planning', 'repowise');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'cochange-cache.json'), JSON.stringify({ pairs: [null], summary: {} }));
    let result;
    assert.doesNotThrow(() => { result = injectCoChangeDebug('some/file.js', tmp); });
    assert.equal(result, null);
  });
});

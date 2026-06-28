#!/usr/bin/env node
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const {
  analyzeContextNeeds,
  fetchContext,
  DOMAIN_CONFIG,
  TOKEN_BUDGET_CHARS,
  MAX_ROUNDS,
} = require('./context-retriever.cjs');

// --- Constants tests ---

describe('Constants', () => {
  it('TOKEN_BUDGET_CHARS equals 32000', () => {
    assert.equal(TOKEN_BUDGET_CHARS, 32000);
  });

  it('MAX_ROUNDS equals 2', () => {
    assert.equal(MAX_ROUNDS, 2);
  });
});

// --- analyzeContextNeeds tests ---

describe('analyzeContextNeeds', () => {
  it('returns test domain for "do the tests pass?"', () => {
    const needs = analyzeContextNeeds('do the tests pass?', null, '');
    assert.ok(needs.some(n => n.domain === 'test'));
  });

  it('returns architecture domain for "what design pattern should we use?"', () => {
    const needs = analyzeContextNeeds('what design pattern should we use?', null, '');
    assert.ok(needs.some(n => n.domain === 'architecture'));
  });

  it('returns formal domain for "does the TLA+ model verify?"', () => {
    const needs = analyzeContextNeeds('does the TLA+ model verify?', null, '');
    assert.ok(needs.some(n => n.domain === 'formal'));
  });

  it('returns multiple domains when question spans domains', () => {
    const needs = analyzeContextNeeds('check test coverage and formal invariant', null, '');
    const domains = needs.map(n => n.domain);
    assert.ok(domains.includes('test'));
    assert.ok(domains.includes('formal'));
  });

  it('returns empty array for generic question with no domain keywords', () => {
    const needs = analyzeContextNeeds('how is the weather today?', null, '');
    assert.equal(needs.length, 0);
  });

  it('detects domain from artifactPath', () => {
    const needs = analyzeContextNeeds('what is this?', 'bin/foo.test.cjs', '');
    assert.ok(needs.some(n => n.domain === 'test'));
  });

  it('detects repowise domain from hotspot keyword', () => {
    const needs = analyzeContextNeeds('which files are hotspots?', null, '');
    assert.ok(needs.some(n => n.domain === 'repowise'));
  });

  it('detects repowise domain from churn keyword', () => {
    const needs = analyzeContextNeeds('what is the churn rate?', null, '');
    assert.ok(needs.some(n => n.domain === 'repowise'));
  });

  it('detects repowise domain from repowise path segment', () => {
    const needs = analyzeContextNeeds('what is this?', '.planning/repowise/hotspot-cache.json', '');
    assert.ok(needs.some(n => n.domain === 'repowise'));
  });

  it('detects formal domain from artifact path with tla', () => {
    const needs = analyzeContextNeeds('what is this?', '.planning/formal/tla/foo.tla', '');
    assert.ok(needs.some(n => n.domain === 'formal'));
  });

  it('deduplicates domains', () => {
    // 'test' keyword in question + 'test' in path should not produce two test entries
    const needs = analyzeContextNeeds('run the test', 'bin/foo.test.cjs', '');
    const testDomains = needs.filter(n => n.domain === 'test');
    assert.equal(testDomains.length, 1);
  });

  it('skips domains already in existingContext', () => {
    const existing = 'some content\n--- test ---\ntest stuff here';
    const needs = analyzeContextNeeds('run the test and check formal model', null, existing);
    assert.ok(!needs.some(n => n.domain === 'test'));
    assert.ok(needs.some(n => n.domain === 'formal'));
  });

  it('does not throw when question is a non-string', () => {
    let needs;
    assert.doesNotThrow(() => { needs = analyzeContextNeeds(42, null, ''); });
    assert.ok(Array.isArray(needs));
  });

  it('does not throw when existingContext is a non-string', () => {
    assert.doesNotThrow(() => analyzeContextNeeds('run the test', null, ['--- test ---']));
  });
});

// --- fetchContext tests ---

describe('fetchContext', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-retriever-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty string for empty needs array', () => {
    const result = fetchContext(tmpDir, [], 1000);
    assert.equal(result, '');
  });

  it('returns empty string for unknown domain', () => {
    const result = fetchContext(tmpDir, [{ domain: 'nonexistent', query: '' }], 1000);
    assert.equal(result, '');
  });

  it('respects charBudget', () => {
    // Create a known file for test domain
    const dir = path.join(tmpDir, '.planning', 'formal');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'unit-test-coverage.json'), 'x'.repeat(50000));

    const budget = 500;
    const result = fetchContext(tmpDir, [{ domain: 'test', query: '' }], budget);
    assert.ok(result.length <= budget);
  });

  it('reads known files from DOMAIN_CONFIG', () => {
    // Create architecture domain files
    const planningDir = path.join(tmpDir, '.planning');
    const memoryDir = path.join(tmpDir, '.planning', 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'STATE.md'), '# Project State\nStatus: active');
    fs.writeFileSync(path.join(memoryDir, 'decisions.jsonl'), '{"summary":"use node:test"}\n');

    const result = fetchContext(tmpDir, [{ domain: 'architecture', query: '' }], 5000);
    assert.ok(result.includes('STATE.md'));
    assert.ok(result.includes('Project State'));
  });

  it('fails open on missing files', () => {
    // No files exist in tmpDir -- should not throw
    const result = fetchContext(tmpDir, [{ domain: 'architecture', query: '' }], 5000);
    // Should return empty or partial, not throw
    assert.equal(typeof result, 'string');
  });

  it('includes domain section markers in output', () => {
    const dir = path.join(tmpDir, '.planning');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'STATE.md'), 'hello world');

    const result = fetchContext(tmpDir, [{ domain: 'architecture', query: '' }], 5000);
    assert.ok(result.includes('--- .planning/STATE.md ---'));
  });

  it('scans search directories for matching files', () => {
    // Create formal model files in the expected subdirectory
    const tlaDir = path.join(tmpDir, '.planning', 'formal', 'tla');
    fs.mkdirSync(tlaDir, { recursive: true });
    fs.writeFileSync(path.join(tlaDir, 'MyModel.tla'), 'MODULE MyModel');
    // Also create known files dir
    const formalDir = path.join(tmpDir, '.planning', 'formal');
    fs.writeFileSync(path.join(formalDir, 'traceability-matrix.json'), '{}');
    fs.writeFileSync(path.join(formalDir, 'solve-state.json'), '{}');

    const result = fetchContext(tmpDir, [{ domain: 'formal', query: '' }], 10000);
    assert.ok(result.includes('MyModel'));
  });

  it('fails open on null/non-object element in needs array', () => {
    assert.doesNotThrow(() => fetchContext(tmpDir, [null], 1000));
    assert.equal(fetchContext(tmpDir, [null], 1000), '');
    // a valid need alongside a bad one still resolves
    const dir = path.join(tmpDir, '.planning');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'STATE.md'), 'hello world');
    const result = fetchContext(tmpDir, [null, { domain: 'architecture', query: '' }], 5000);
    assert.ok(result.includes('STATE.md'));
  });

  it('returns empty string for non-array needs', () => {
    assert.equal(fetchContext(tmpDir, {}, 1000), '');
    assert.doesNotThrow(() => fetchContext(tmpDir, { domain: 'test' }, 1000));
  });
});

// --- DOMAIN_CONFIG structure tests ---

describe('DOMAIN_CONFIG', () => {
  it('has test, architecture, formal, and repowise domains', () => {
    assert.ok(DOMAIN_CONFIG.test);
    assert.ok(DOMAIN_CONFIG.architecture);
    assert.ok(DOMAIN_CONFIG.formal);
    assert.ok(DOMAIN_CONFIG.repowise);
  });

  it('repowise domain has correct files and searchDirs', () => {
    assert.ok(DOMAIN_CONFIG.repowise.files.includes('.planning/repowise/hotspot-cache.json'));
    assert.ok(DOMAIN_CONFIG.repowise.files.includes('.planning/repowise/cochange-cache.json'));
    assert.ok(DOMAIN_CONFIG.repowise.searchDirs.includes('.planning/repowise/'));
  });

  it('formal searchDirs use explicit subdirectories', () => {
    const dirs = DOMAIN_CONFIG.formal.searchDirs;
    assert.ok(dirs.includes('.planning/formal/tla/'));
    assert.ok(dirs.includes('.planning/formal/alloy/'));
    assert.ok(dirs.includes('.planning/formal/prism/'));
  });
});

// --- Fail-open tests ---

describe('Fail-open', () => {
  it('CLI with no args exits 0', () => {
    const script = path.join(__dirname, 'context-retriever.cjs');
    // Should not throw -- exits 0
    const result = execFileSync('node', [script], {
      encoding: 'utf8',
      timeout: 5000,
    });
    // No crash = success
    assert.equal(typeof result, 'string');
  });
});

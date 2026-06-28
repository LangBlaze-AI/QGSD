#!/usr/bin/env node
'use strict';
// bin/failure-taxonomy.test.cjs
// Tests for failure-taxonomy.cjs

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = process.env.PROJECT_ROOT || path.join(__dirname, '..');
const OUTPUT_PATH = path.join(ROOT, '.planning', 'formal', 'evidence', 'failure-taxonomy.json');

const { classifyFailure, TIMEOUT_THRESHOLD_MS } = require('./failure-taxonomy.cjs');

describe('failure-taxonomy classification rules', () => {
  it('classifies crash by stack trace', () => {
    const entry = { result: 'fail', metadata: { stack_trace: 'Error at...' }, summary: 'crash' };
    const { category } = classifyFailure(entry);
    assert.strictEqual(category, 'crash');
  });

  it('classifies timeout by runtime exceeding threshold', () => {
    const entry = { result: 'fail', runtime_ms: TIMEOUT_THRESHOLD_MS + 1000, formalism: 'tla', summary: 'fail: MCinstaller' };
    const { category } = classifyFailure(entry);
    assert.strictEqual(category, 'timeout');
  });

  it('classifies drift for trace formalism with divergences', () => {
    const entry = { result: 'fail', formalism: 'trace', summary: 'fail: 6369 divergence(s) in 35721 traces' };
    const { category } = classifyFailure(entry);
    assert.strictEqual(category, 'drift');
  });

  it('classifies logic_violation for TLA+ counterexample', () => {
    const entry = { result: 'fail', formalism: 'tla', runtime_ms: 500, summary: 'fail: MCbreaker in 209ms' };
    const { category } = classifyFailure(entry);
    assert.strictEqual(category, 'logic_violation');
  });

  it('classifies alloy failure as logic_violation', () => {
    const entry = { result: 'fail', formalism: 'alloy', runtime_ms: 1200, summary: 'fail: alloy:account-pool in 1385ms' };
    const { category } = classifyFailure(entry);
    assert.strictEqual(category, 'logic_violation');
  });

  it('degradation falls back to logic_violation (no baseline)', () => {
    // When no baseline data exists, potential degradation is classified as logic_violation
    const entry = { result: 'fail', formalism: 'tla', runtime_ms: 400, summary: 'fail: performance degraded' };
    const { category } = classifyFailure(entry);
    assert.strictEqual(category, 'logic_violation', 'No baseline = fallback to logic_violation');
  });
});

describe('failure-taxonomy mutual exclusivity', () => {
  it('each failure gets exactly one category', () => {
    const testEntries = [
      { result: 'fail', metadata: { stack_trace: 'err' }, summary: 'crash' },
      { result: 'fail', runtime_ms: 1000000, formalism: 'tla', summary: 'timeout' },
      { result: 'fail', formalism: 'trace', summary: '100 divergence(s)' },
      { result: 'fail', formalism: 'tla', runtime_ms: 100, summary: 'fail: counter' },
    ];

    for (const entry of testEntries) {
      const { category } = classifyFailure(entry);
      assert.ok(
        ['crash', 'timeout', 'logic_violation', 'drift', 'degradation'].includes(category),
        `Invalid category: ${category}`
      );
    }
  });
});

describe('failure-taxonomy integration', () => {
  before(() => {
    execFileSync('node', ['bin/failure-taxonomy.cjs'], { cwd: ROOT, stdio: 'pipe' });
  });

  it('classifies all failures with zero unclassified', () => {
    const result = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    assert.strictEqual(result.unclassified.length, 0, 'All failures must be classified');
  });

  it('category counts sum to total', () => {
    const result = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    const sum = Object.values(result.category_counts).reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, result.total_failures, 'Category counts must equal total');
  });

  it('has degradation_fallback_note', () => {
    const result = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    assert.ok(result.degradation_fallback_note, 'degradation_fallback_note must be present');
  });

  it('has total failures from check-results', () => {
    const result = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    assert.ok(result.total_failures >= 0, `Expected 0+ failures/errors, got ${result.total_failures}`);
  });
});

describe('failure-taxonomy null/malformed entry hardening', () => {
  it('does not crash on null entry and returns a valid category', () => {
    let result;
    assert.doesNotThrow(() => { result = classifyFailure(null); });
    assert.ok(
      ['crash', 'timeout', 'logic_violation', 'drift', 'degradation'].includes(result.category),
      `Invalid category for null entry: ${result && result.category}`
    );
  });

  it('does not crash on undefined or non-object entry', () => {
    assert.doesNotThrow(() => classifyFailure(undefined));
    assert.doesNotThrow(() => classifyFailure('not-an-object'));
  });
});

describe('failure-taxonomy non-string summary hardening', () => {
  it('does not crash on numeric summary in default branch', () => {
    const entry = { result: 'fail', formalism: 'tla', runtime_ms: 100, summary: 12345 };
    let result;
    assert.doesNotThrow(() => { result = classifyFailure(entry); });
    assert.strictEqual(result.category, 'logic_violation');
  });

  it('does not crash on array summary in default branch', () => {
    const entry = { result: 'fail', formalism: 'tla', summary: ['a', 'b'] };
    assert.doesNotThrow(() => classifyFailure(entry));
  });
});

describe('failure-taxonomy trace branch non-string summary hardening', () => {
  it('does not crash on numeric summary for trace formalism', () => {
    const entry = { result: 'fail', formalism: 'trace', summary: 6369 };
    let result;
    assert.doesNotThrow(() => { result = classifyFailure(entry); });
    assert.strictEqual(result.category, 'drift');
  });
});

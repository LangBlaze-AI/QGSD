#!/usr/bin/env node
'use strict';
// bin/repowise/budget-compressor.test.cjs
// Tests for bin/repowise/budget-compressor.cjs — Budget-aware compression

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  compressContext,
  allocateBudget,
  estimateTokens,
  formatEntryByDetail,
  DETAIL_LEVELS,
} = require('./budget-compressor.cjs');

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  it('estimates ~1 token per 4 characters', () => {
    assert.ok(estimateTokens('hello world') >= 2);
    assert.ok(estimateTokens('a') === 1);
  });
});

// ---------------------------------------------------------------------------
// allocateBudget
// ---------------------------------------------------------------------------

describe('allocateBudget', () => {
  it('allocates higher budget to high-risk files', () => {
    const files = [
      { filePath: 'high.js', hotspotRisk: 0.85 },
      { filePath: 'low.js', hotspotRisk: 0.1 },
    ];
    const result = allocateBudget(files, 1000);
    const highAlloc = result.allocations.find(a => a.filePath === 'high.js');
    const lowAlloc = result.allocations.find(a => a.filePath === 'low.js');
    assert.ok(highAlloc.budget > lowAlloc.budget, 'high risk should get more budget');
  });

  it('returns overflow=true when budget is too small', () => {
    const files = [
      { filePath: 'a.js' },
      { filePath: 'b.js' },
      { filePath: 'c.js' },
    ];
    const result = allocateBudget(files, 30, { minBudgetPerFile: 50 });
    assert.equal(result.overflow, true);
  });

  it('returns names_only detail when budget is very low per file', () => {
    const files = [{ filePath: 'a.js' }];
    const result = allocateBudget(files, 30);
    assert.equal(result.allocations[0].detail, 'names_only');
  });

  it('returns skeleton detail when budget is sufficient', () => {
    const files = [{ filePath: 'a.js' }];
    const result = allocateBudget(files, 2000);
    assert.equal(result.allocations[0].detail, 'skeleton');
  });

  it('returns empty for empty files array', () => {
    const result = allocateBudget([], 1000);
    assert.equal(result.allocations.length, 0);
  });
});

// ---------------------------------------------------------------------------
// compressContext
// ---------------------------------------------------------------------------

describe('compressContext', () => {
  it('produces <repowise> XML with budget_mode=compressed', () => {
    const files = [
      { filePath: 'src/foo.js', hotspotRisk: 0.5 },
      { filePath: 'src/bar.ts', hotspotRisk: 0.1 },
    ];
    const result = compressContext(files, 4000);
    assert.ok(result.xml.includes('<repowise'));
    assert.ok(result.xml.includes('budget_mode="compressed"'));
    assert.ok(result.json.repowise.budget_mode === 'compressed');
  });

  it('produces overflow mode when budget is too small', () => {
    const files = [
      { filePath: 'a.js' },
      { filePath: 'b.js' },
    ];
    const result = compressContext(files, 20, { minBudgetPerFile: 50 });
    assert.ok(result.xml.includes('budget_mode="overflow"'));
    assert.ok(result.json.repowise.budget_mode === 'overflow');
  });

  it('high-risk files get higher detail than low-risk files', () => {
    const files = [
      { filePath: 'high.js', hotspotRisk: 0.85 },
      { filePath: 'low.js', hotspotRisk: 0.1 },
    ];
    const result = compressContext(files, 4000);
    const highAlloc = result.allocations.find(a => a.filePath === 'high.js');
    const lowAlloc = result.allocations.find(a => a.filePath === 'low.js');
    // Both should get at least signatures detail with this budget
    assert.ok(highAlloc.budget >= lowAlloc.budget, 'high risk should get >= budget');
  });

  it('returns allocations array', () => {
    const files = [{ filePath: 'a.js' }];
    const result = compressContext(files, 1000);
    assert.ok(Array.isArray(result.allocations));
    assert.ok(result.allocations.length > 0);
  });
});

// ---------------------------------------------------------------------------
// formatEntryByDetail
// ---------------------------------------------------------------------------

describe('formatEntryByDetail', () => {
  it('returns filePath for names_only detail', () => {
    const entry = { filePath: 'src/foo.js' };
    assert.equal(formatEntryByDetail(entry, 'names_only'), 'src/foo.js');
  });

  it('returns signatures for signatures detail', () => {
    const entry = {
      filePath: 'src/foo.js',
      skeletonEntries: [
        { type: 'function_declaration', name: 'hello', start: 1, end: 5 },
      ],
    };
    const result = formatEntryByDetail(entry, 'signatures');
    assert.ok(result.includes('hello'));
  });
});

// ---------------------------------------------------------------------------
// formatEntryByDetail (hardening)
// ---------------------------------------------------------------------------

describe('formatEntryByDetail (hardening)', () => {
  it('does not crash on skeletonEntries missing a type field', () => {
    const entry = {
      filePath: 'src/foo.js',
      skeletonEntries: [
        { name: 'mystery', start: 1, end: 5 }, // no `type`
        { type: 'function_declaration', name: 'hello', start: 6, end: 9 },
      ],
    };
    let result;
    assert.doesNotThrow(() => { result = formatEntryByDetail(entry, 'signatures'); });
    // the well-formed entry still surfaces, the malformed one is skipped
    assert.ok(result.includes('hello'));
    assert.ok(!result.includes('mystery'));
  });
});

// ---------------------------------------------------------------------------
// allocateBudget (hardening)
// ---------------------------------------------------------------------------

describe('allocateBudget (hardening)', () => {
  it('treats null/undefined files as empty instead of throwing', () => {
    assert.doesNotThrow(() => allocateBudget(null, 1000));
    const result = allocateBudget(undefined, 1000);
    assert.equal(result.allocations.length, 0);
    assert.equal(result.overflow, false);
  });
});

// ---------------------------------------------------------------------------
// compressContext (hardening)
// ---------------------------------------------------------------------------

describe('compressContext (hardening)', () => {
  it('treats NaN budget as overflow, not a bogus compressed result', () => {
    const files = [{ filePath: 'a.js' }, { filePath: 'b.js' }];
    const result = compressContext(files, NaN);
    assert.equal(result.json.repowise.budget_mode, 'overflow');
    assert.ok(result.xml.includes('budget_mode="overflow"'));
  });
});

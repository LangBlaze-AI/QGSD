#!/usr/bin/env node
'use strict';
// bin/repowise/cochange.test.cjs
// Tests for bin/repowise/cochange.cjs — Co-change prediction for Repowise

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  computeCoChange,
  formatCoChangeXml,
  getPartnersForFile,
} = require('./cochange.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// computeCoChange with mock data
// ---------------------------------------------------------------------------

describe('computeCoChange — mock data', () => {
  // We test the core logic by testing on the real repo
  it('returns valid structure with pairs and summary', () => {
    const result = computeCoChange(PROJECT_ROOT, { minSharedCommits: 2, minCouplingDegree: 0.1 });
    assert.ok(Array.isArray(result.pairs), 'pairs should be array');
    assert.ok(result.summary, 'should have summary');
    assert.ok(typeof result.summary.total_pairs === 'number');
    assert.ok(typeof result.summary.strong_coupling_count === 'number');
  });

  it('pairs have file1, file2, shared_commits, coupling_degree fields', () => {
    const result = computeCoChange(PROJECT_ROOT, { minSharedCommits: 2, minCouplingDegree: 0.1 });
    if (result.pairs.length > 0) {
      const p = result.pairs[0];
      assert.ok(typeof p.file1 === 'string');
      assert.ok(typeof p.file2 === 'string');
      assert.ok(typeof p.shared_commits === 'number');
      assert.ok(typeof p.coupling_degree === 'number');
    }
  });

  it('coupling_degree is between 0 and 1', () => {
    const result = computeCoChange(PROJECT_ROOT, { minSharedCommits: 2, minCouplingDegree: 0.1 });
    for (const p of result.pairs) {
      assert.ok(p.coupling_degree >= 0 && p.coupling_degree <= 1.001, `coupling ${p.coupling_degree} out of range`);
    }
  });

  it('pairs are sorted by coupling_degree descending', () => {
    const result = computeCoChange(PROJECT_ROOT, { minSharedCommits: 2, minCouplingDegree: 0.1 });
    for (let i = 1; i < result.pairs.length; i++) {
      assert.ok(result.pairs[i - 1].coupling_degree >= result.pairs[i].coupling_degree, 'pairs should be sorted');
    }
  });

  it('thresholds filter pairs correctly', () => {
    const loose = computeCoChange(PROJECT_ROOT, { minSharedCommits: 2, minCouplingDegree: 0.1 });
    const strict = computeCoChange(PROJECT_ROOT, { minSharedCommits: 5, minCouplingDegree: 0.5 });
    assert.ok(strict.pairs.length <= loose.pairs.length, 'strict thresholds should produce fewer pairs');
  });

  it('fileIndex provides fast partner lookup', () => {
    const result = computeCoChange(PROJECT_ROOT, { minSharedCommits: 2, minCouplingDegree: 0.1 });
    assert.ok(result.fileIndex instanceof Map);
  });
});

// ---------------------------------------------------------------------------
// getPartnersForFile
// ---------------------------------------------------------------------------

describe('getPartnersForFile', () => {
  it('returns partners for a file that has co-change pairs', () => {
    const result = computeCoChange(PROJECT_ROOT, { minSharedCommits: 2, minCouplingDegree: 0.1 });
    if (result.pairs.length > 0) {
      const firstPair = result.pairs[0];
      const partners = getPartnersForFile(firstPair.file1, result);
      assert.ok(Array.isArray(partners));
      assert.ok(partners.length > 0, 'should have at least one partner');
      assert.ok(partners.some(p => p.partner === firstPair.file2), 'should include the paired file');
    }
  });

  it('returns empty array for file with no partners', () => {
    const result = computeCoChange(PROJECT_ROOT, { minSharedCommits: 2, minCouplingDegree: 0.1 });
    const partners = getPartnersForFile('nonexistent/file.xyz', result);
    assert.deepEqual(partners, []);
  });

  it('returns empty array when result is null', () => {
    const partners = getPartnersForFile('foo.js', null);
    assert.deepEqual(partners, []);
  });
});

// ---------------------------------------------------------------------------
// formatCoChangeXml
// ---------------------------------------------------------------------------

describe('formatCoChangeXml', () => {
  it('produces <pairs> section with <pair> elements', () => {
    const cochange = {
      pairs: [
        { file1: 'src/a.js', file2: 'src/b.ts', shared_commits: 5, coupling_degree: 0.45 },
      ],
      summary: { total_pairs: 1, strong_coupling_count: 0 },
      fileIndex: new Map(),
    };
    const xml = formatCoChangeXml(cochange);
    assert.ok(xml.includes('<pairs>'));
    assert.ok(xml.includes('file1="src/a.js"'));
    assert.ok(xml.includes('coupling_degree="0.45"'));
  });

  it('escapes XML special characters in file paths', () => {
    const cochange = {
      pairs: [
        { file1: 'src/a&b.js', file2: 'src/c<d.ts', shared_commits: 3, coupling_degree: 0.5 },
      ],
      summary: { total_pairs: 1, strong_coupling_count: 1 },
      fileIndex: new Map(),
    };
    const xml = formatCoChangeXml(cochange);
    assert.ok(xml.includes('src/a&amp;b.js'));
    assert.ok(xml.includes('src/c&lt;d.ts'));
  });
});

// ---------------------------------------------------------------------------
// Adversarial / hardening
// ---------------------------------------------------------------------------

describe('formatCoChangeXml — adversarial', () => {
  it('does not throw and emits empty <pairs> when pairs array is missing', () => {
    assert.doesNotThrow(() => formatCoChangeXml({ summary: {}, fileIndex: new Map() }));
    const xml = formatCoChangeXml({ summary: {}, fileIndex: new Map() });
    assert.ok(xml.includes('<pairs>'));
    assert.ok(xml.includes('</pairs>'));
  });

  it('does not throw on null input', () => {
    assert.doesNotThrow(() => formatCoChangeXml(null));
  });
});

describe('getPartnersForFile — adversarial', () => {
  it('returns empty array when fileIndex is a plain object (JSON round-trip)', () => {
    const roundTripped = JSON.parse(JSON.stringify({ pairs: [], summary: {}, fileIndex: new Map() }));
    assert.doesNotThrow(() => getPartnersForFile('foo.js', roundTripped));
    assert.deepEqual(getPartnersForFile('foo.js', roundTripped), []);
  });
});

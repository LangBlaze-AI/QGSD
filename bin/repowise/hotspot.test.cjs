#!/usr/bin/env node
'use strict';
// bin/repowise/hotspot.test.cjs
// Tests for bin/repowise/hotspot.cjs — Hotspot detection for Repowise

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  isExcluded,
  normalizeMap,
  computeChurnScores,
  estimateComplexity,
  computeHotspots,
  computeAstComplexity,
  formatHotspotXml,
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_MASS_REFACTOR_THRESHOLD,
} = require('./hotspot.cjs');

// ---------------------------------------------------------------------------
// isExcluded
// ---------------------------------------------------------------------------

describe('isExcluded', () => {
  it('excludes node_modules paths', () => {
    assert.equal(isExcluded('src/node_modules/foo/index.js'), true);
  });

  it('excludes .min.js paths', () => {
    assert.equal(isExcluded('dist/bundle.min.js'), true);
  });

  it('excludes package-lock.json', () => {
    assert.equal(isExcluded('package-lock.json'), true);
  });

  it('excludes .planning paths', () => {
    assert.equal(isExcluded('foo/.planning/ROADMAP.md'), true);
    assert.equal(isExcluded('.planning/ROADMAP.md'), true);
  });

  it('does NOT exclude normal source paths', () => {
    assert.equal(isExcluded('src/index.js'), false);
  });

  it('does NOT exclude test files', () => {
    assert.equal(isExcluded('test/foo.test.js'), false);
  });
});

// ---------------------------------------------------------------------------
// normalizeMap
// ---------------------------------------------------------------------------

describe('normalizeMap', () => {
  it('normalizes [10, 20, 30] to [0, 0.5, 1]', () => {
    const input = new Map([['a', 10], ['b', 20], ['c', 30]]);
    const result = normalizeMap(input);
    assert.equal(result.get('a'), 0);
    assert.equal(result.get('b'), 0.5);
    assert.equal(result.get('c'), 1);
  });

  it('returns 0.5 for all values when all equal', () => {
    const input = new Map([['a', 5], ['b', 5], ['c', 5]]);
    const result = normalizeMap(input);
    assert.equal(result.get('a'), 0.5);
    assert.equal(result.get('b'), 0.5);
    assert.equal(result.get('c'), 0.5);
  });

  it('returns empty map for empty input', () => {
    const result = normalizeMap(new Map());
    assert.equal(result.size, 0);
  });

  it('normalizes single entry to 0.5', () => {
    const input = new Map([['a', 42]]);
    const result = normalizeMap(input);
    assert.equal(result.get('a'), 0.5);
  });
});

// ---------------------------------------------------------------------------
// computeChurnScores
// ---------------------------------------------------------------------------

describe('computeChurnScores', () => {
  it('computes basic churn: 3 commits touching file.js = churn score 3', () => {
    const commits = [
      { sha: 'aaa1111', message: 'feat: add foo', files: [{ path: 'src/file.js', added: 10, deleted: 2 }] },
      { sha: 'bbb2222', message: 'fix: update foo', files: [{ path: 'src/file.js', added: 5, deleted: 1 }] },
      { sha: 'ccc3333', message: 'refactor: rename', files: [{ path: 'src/file.js', added: 3, deleted: 3 }] },
    ];
    const result = computeChurnScores(commits);
    assert.equal(result.get('src/file.js'), 3);
  });

  it('mass-refactor weighting: 100 files with threshold=50 → each gets weight 0.5', () => {
    const files = [];
    for (let i = 0; i < 100; i++) {
      files.push({ path: `src/file${i}.js`, added: 1, deleted: 0 });
    }
    const commits = [{ sha: 'mass111', message: 'mass refactor', files }];
    const result = computeChurnScores(commits, { massRefactorThreshold: 50 });
    // weight = 1 / max(1, 100/50) = 1/2 = 0.5
    assert.equal(result.get('src/file0.js'), 0.5);
  });

  it('excludes files matching exclude patterns', () => {
    const commits = [
      { sha: 'aaa1111', message: 'feat', files: [{ path: 'src/node_modules/pkg/index.js', added: 10, deleted: 0 }] },
      { sha: 'bbb2222', message: 'fix', files: [{ path: 'src/good.js', added: 5, deleted: 1 }] },
    ];
    const result = computeChurnScores(commits);
    assert.equal(result.has('src/node_modules/pkg/index.js'), false);
    assert.equal(result.get('src/good.js'), 1);
  });

  it('returns empty map for empty commits', () => {
    const result = computeChurnScores([]);
    assert.equal(result.size, 0);
  });
});

// ---------------------------------------------------------------------------
// estimateComplexity
// ---------------------------------------------------------------------------

describe('estimateComplexity', () => {
  it('counts non-blank non-comment lines for a real file', () => {
    const projectRoot = path.resolve(__dirname, '../..');
    const complexity = estimateComplexity('bin/repowise/escape-xml.cjs', projectRoot);
    assert.ok(complexity > 0, 'should have positive complexity for escape-xml.cjs');
  });

  it('returns 0 for non-existent file', () => {
    const projectRoot = path.resolve(__dirname, '../..');
    const complexity = estimateComplexity('nonexistent/file.xyz', projectRoot);
    assert.equal(complexity, 0);
  });
});

describe('computeAstComplexity', () => {
  it('falls back to estimateComplexity when skeleton.cjs is unavailable', async () => {
    const projectRoot = path.resolve(__dirname, '../..');
    const complexity = await computeAstComplexity('bin/repowise/escape-xml.cjs', projectRoot);
    assert.ok(complexity >= 0, 'should return non-negative complexity');
  });

  it('returns 0 for non-existent file', async () => {
    const projectRoot = path.resolve(__dirname, '../..');
    const complexity = await computeAstComplexity('nonexistent/file.xyz', projectRoot);
    assert.equal(complexity, 0);
  });
});

// ---------------------------------------------------------------------------
// computeHotspots (integration)
// ---------------------------------------------------------------------------

describe('computeHotspots', () => {
  it('returns files array with path, churn, complexity, hotspot_score fields', () => {
    const projectRoot = path.resolve(__dirname, '../..');
    const result = computeHotspots(projectRoot);
    assert.ok(Array.isArray(result.files), 'files should be an array');
    if (result.files.length > 0) {
      const f = result.files[0];
      assert.ok(typeof f.path === 'string', 'path should be string');
      assert.ok(typeof f.churn === 'number', 'churn should be number');
      assert.ok(typeof f.complexity === 'number', 'complexity should be number');
      assert.ok(typeof f.hotspot_score === 'number', 'hotspot_score should be number');
      assert.ok(['low', 'medium', 'high'].includes(f.risk), 'risk should be low/medium/high');
    }
  });

  it('summary contains total_files, high_risk_count, medium_risk_count', () => {
    const projectRoot = path.resolve(__dirname, '../..');
    const result = computeHotspots(projectRoot);
    assert.ok(typeof result.summary.total_files === 'number');
    assert.ok(typeof result.summary.high_risk_count === 'number');
    assert.ok(typeof result.summary.medium_risk_count === 'number');
  });

  it('hotspot_score is between 0 and 1', () => {
    const projectRoot = path.resolve(__dirname, '../..');
    const result = computeHotspots(projectRoot);
    for (const f of result.files) {
      assert.ok(f.hotspot_score >= 0 && f.hotspot_score <= 1, `score ${f.hotspot_score} out of range for ${f.path}`);
    }
  });

  it('files are sorted by hotspot_score descending', () => {
    const projectRoot = path.resolve(__dirname, '../..');
    const result = computeHotspots(projectRoot);
    for (let i = 1; i < result.files.length; i++) {
      assert.ok(result.files[i - 1].hotspot_score >= result.files[i].hotspot_score, 'files should be sorted descending');
    }
  });
});

// ---------------------------------------------------------------------------
// formatHotspotXml
// ---------------------------------------------------------------------------

describe('formatHotspotXml', () => {
  it('produces <files> section with <file> elements', () => {
    const hotspots = {
      files: [
        { path: 'src/foo.js', churn: 12, complexity: 45, hotspot_score: 0.85, risk: 'high' },
        { path: 'src/bar.ts', churn: 5, complexity: 30, hotspot_score: 0.35, risk: 'low' },
      ],
      summary: { total_files: 2, high_risk_count: 1, medium_risk_count: 0 },
    };
    const xml = formatHotspotXml(hotspots);
    assert.ok(xml.includes('<files>'), 'should contain <files>');
    assert.ok(xml.includes('path="src/foo.js"'), 'should contain file path');
    assert.ok(xml.includes('hotspot_score="0.85"'), 'should contain hotspot_score');
    assert.ok(xml.includes('risk="high"'), 'should contain risk level');
  });

  it('escapes XML special characters in path attributes', () => {
    const hotspots = {
      files: [
        { path: 'src/foo&bar.js', churn: 3, complexity: 10, hotspot_score: 0.5, risk: 'medium' },
      ],
      summary: { total_files: 1, high_risk_count: 0, medium_risk_count: 1 },
    };
    const xml = formatHotspotXml(hotspots);
    assert.ok(xml.includes('path="src/foo&amp;bar.js"'), 'should escape & in path');
  });
});

// ---------------------------------------------------------------------------
// Hardening: estimateComplexity non-string filePath (HOTSPOT-01)
// ---------------------------------------------------------------------------

describe('estimateComplexity hardening', () => {
  it('returns 0 for a non-string filePath instead of throwing', () => {
    const projectRoot = path.resolve(__dirname, '../..');
    assert.equal(estimateComplexity(undefined, projectRoot), 0);
    assert.equal(estimateComplexity(123, projectRoot), 0);
  });
});

// ---------------------------------------------------------------------------
// Hardening: computeChurnScores malformed commits (HOTSPOT-02)
// ---------------------------------------------------------------------------

describe('computeChurnScores hardening', () => {
  it('does not crash on a commit object missing files', () => {
    const result = computeChurnScores([{ sha: 'aaa1111', message: 'no files' }]);
    assert.equal(result.size, 0);
  });

  it('skips a commit whose files is null among valid commits', () => {
    const commits = [
      { sha: 'aaa1111', message: 'bad', files: null },
      { sha: 'bbb2222', message: 'good', files: [{ path: 'src/good.js', added: 1, deleted: 0 }] },
    ];
    const result = computeChurnScores(commits);
    assert.equal(result.get('src/good.js'), 1);
  });
});

// ---------------------------------------------------------------------------
// Hardening: normalizeMap NaN poisoning (HOTSPOT-03)
// ---------------------------------------------------------------------------

describe('normalizeMap hardening', () => {
  it('does not produce NaN when a value is NaN', () => {
    const input = new Map([['a', NaN], ['b', 5], ['c', 10]]);
    const result = normalizeMap(input);
    for (const [k, v] of result) {
      assert.ok(Number.isFinite(v), `normalized value for ${k} should be finite, got ${v}`);
      assert.ok(v >= 0 && v <= 1, `normalized value for ${k} out of range: ${v}`);
    }
  });
});

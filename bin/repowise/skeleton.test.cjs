#!/usr/bin/env node
'use strict';
// bin/repowise/skeleton.test.cjs
// Tests for bin/repowise/skeleton.cjs — Skeleton views for Repowise

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  extractSkeleton,
  extractSkeletonRegex,
  extractSkeletonFromTree,
  enrichSkeleton,
  formatSkeletonXml,
  countDecisionPoints,
} = require('./skeleton.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// extractSkeleton — regex fallback
// ---------------------------------------------------------------------------

describe('extractSkeletonRegex', () => {
  it('extracts JS function declarations', () => {
    const content = 'function hello() {\n  return 42;\n}\nconst add = (a, b) => a + b;';
    const entries = extractSkeletonRegex(content, 'js');
    assert.ok(entries.length >= 1, 'should find at least one entry');
    assert.ok(entries.some(e => e.name === 'hello'), 'should find hello function');
  });

  it('extracts Python function definitions', () => {
    const content = 'def hello():\n    pass\n\nclass Foo:\n    def bar(self):\n        pass';
    const entries = extractSkeletonRegex(content, 'py');
    assert.ok(entries.some(e => e.name === 'hello'), 'should find hello');
    assert.ok(entries.some(e => e.name === 'Foo'), 'should find Foo class');
  });

  it('returns empty for unknown language', () => {
    const entries = extractSkeletonRegex('function foo() {}', 'rust');
    assert.deepEqual(entries, []);
  });

  it('returns empty for content without definitions', () => {
    const entries = extractSkeletonRegex('x = 1\ny = 2\n', 'py');
    assert.deepEqual(entries, []);
  });
});

// ---------------------------------------------------------------------------
// extractSkeleton — integration (may use AST or regex)
// ---------------------------------------------------------------------------

describe('extractSkeleton', () => {
  it('returns valid structure for a JS file', async () => {
    const result = await extractSkeleton('bin/repowise/escape-xml.cjs', PROJECT_ROOT);
    assert.ok(Array.isArray(result.entries));
    assert.ok(typeof result.lang === 'string');
    assert.ok(typeof result.lineCount === 'number');
    assert.ok(['ast', 'regex', 'none'].includes(result.method));
  });

  it('returns method=ast or regex for JS files', async () => {
    const result = await extractSkeleton('bin/repowise/escape-xml.cjs', PROJECT_ROOT);
    assert.ok(result.method !== 'none', 'should use AST or regex for JS');
  });

  it('returns empty for nonexistent file', async () => {
    const result = await extractSkeleton('nonexistent/file.xyz', PROJECT_ROOT);
    assert.deepEqual(result.entries, []);
    assert.equal(result.method, 'none');
  });

  it('entries have required fields', async () => {
    const result = await extractSkeleton('bin/repowise/escape-xml.cjs', PROJECT_ROOT);
    if (result.entries.length > 0) {
      const e = result.entries[0];
      assert.ok(typeof e.type === 'string');
      assert.ok(typeof e.name === 'string');
      assert.ok(typeof e.start === 'number');
      assert.ok(typeof e.end === 'number');
      assert.ok(typeof e.complexity === 'number');
    }
  });
});

// ---------------------------------------------------------------------------
// enrichSkeleton
// ---------------------------------------------------------------------------

describe('enrichSkeleton', () => {
  it('adds hotspot_risk when file is in hotspots', () => {
    const skeleton = { entries: [], lang: 'js', method: 'ast', filePath: 'src/foo.js' };
    const hotspots = { files: [{ path: 'src/foo.js', hotspot_score: 0.85 }] };
    const enriched = enrichSkeleton(skeleton, hotspots, null);
    assert.equal(enriched.hotspot_risk, 0.85);
  });

  it('adds coupling_degree when file has co-change partners', () => {
    const skeleton = { entries: [], lang: 'js', method: 'ast', filePath: 'src/foo.js' };
    const cochange = { fileIndex: new Map([['src/foo.js', [{ partner: 'src/bar.ts', coupling_degree: 0.7 }]]]) };
    const enriched = enrichSkeleton(skeleton, null, cochange);
    assert.equal(enriched.max_coupling_degree, 0.7);
  });

  it('omits enrichment when no matching data', () => {
    const skeleton = { entries: [], lang: 'js', method: 'ast', filePath: 'src/foo.js' };
    const enriched = enrichSkeleton(skeleton, null, null);
    assert.equal(enriched.hotspot_risk, undefined);
    assert.equal(enriched.max_coupling_degree, undefined);
  });
});

describe('enrichSkeleton — corrupt co-change data', () => {
  it('does not crash when a co-change partner is null', () => {
    const skeleton = { entries: [], lang: 'js', method: 'ast', filePath: 'src/foo.js' };
    const cochange = { fileIndex: new Map([['src/foo.js', [null, { partner: 'src/bar.ts', coupling_degree: 0.7 }]]]) };
    const enriched = enrichSkeleton(skeleton, null, cochange);
    assert.equal(enriched.max_coupling_degree, 0.7);
  });
});

describe('enrichSkeleton — non-numeric coupling_degree', () => {
  it('omits coupling_degree (never NaN) when partners lack a numeric coupling_degree', () => {
    const skeleton = { entries: [], lang: 'js', method: 'ast', filePath: 'src/foo.js' };
    const cochange = { fileIndex: new Map([['src/foo.js', [{ partner: 'src/bar.ts' }]]]) };
    const enriched = enrichSkeleton(skeleton, null, cochange);
    assert.equal(enriched.max_coupling_degree, undefined);
    const xml = formatSkeletonXml([{ type: 'f', name: 'x', start: 1, end: 1, complexity: 1, max_coupling_degree: enriched.max_coupling_degree }]);
    assert.ok(!xml.includes('coupling_degree="NaN"'), 'must never emit NaN coupling');
  });
});

describe('enrichSkeleton — corrupt hotspots data', () => {
  it('does not crash when hotspots.files contains a null entry', () => {
    const skeleton = { entries: [], lang: 'js', method: 'ast', filePath: 'src/foo.js' };
    const hotspots = { files: [null, { path: 'src/foo.js', hotspot_score: 0.85 }] };
    const enriched = enrichSkeleton(skeleton, hotspots, null);
    assert.equal(enriched.hotspot_risk, 0.85);
  });
});

// ---------------------------------------------------------------------------
// formatSkeletonXml
// ---------------------------------------------------------------------------

describe('formatSkeletonXml', () => {
  it('produces <entry> elements with attributes', () => {
    const skeletons = [
      { type: 'function_declaration', name: 'hello', start: 1, end: 5, complexity: 2 },
      { type: 'class_declaration', name: 'Foo', start: 10, end: 30, complexity: 5, hotspot_risk: 0.85 },
    ];
    const xml = formatSkeletonXml(skeletons);
    assert.ok(xml.includes('name="hello"'));
    assert.ok(xml.includes('complexity="2"'));
    assert.ok(xml.includes('hotspot_risk="0.85"'));
  });

  it('escapes XML special characters in names', () => {
    const skeletons = [
      { type: 'function', name: 'a&b', start: 1, end: 2, complexity: 1 },
    ];
    const xml = formatSkeletonXml(skeletons);
    assert.ok(xml.includes('name="a&amp;b"'));
  });
});

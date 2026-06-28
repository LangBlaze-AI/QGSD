'use strict';
/** @requirement SOLVE-01 — validates BFS graph traversal and semantic search in formal-graph-search.cjs */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { reachFiltered, proximityScore, keywordOverlap, graphDiscoverModules } = require('./formal-graph-search.cjs');

// ── reachFiltered tests ───────────────────────────────────────────────────────

describe('reachFiltered', () => {
  let mockIndex;

  beforeEach(() => {
    // Build a small 4-node graph:
    // A (formal_module) -> B (invariant) -> C (requirement) -> D (formal_module)
    mockIndex = {
      nodes: {
        'formal_module::A': {
          type: 'formal_module',
          edges: [{ to: 'invariant::B', rel: 'verifies' }]
        },
        'invariant::B': {
          type: 'invariant',
          edges: [{ to: 'requirement::C', rel: 'describes' }]
        },
        'requirement::C': {
          type: 'requirement',
          edges: [{ to: 'formal_module::D', rel: 'verified_by' }]
        },
        'formal_module::D': {
          type: 'formal_module',
          edges: []
        }
      }
    };
  });

  it('finds nodes within depth, respects typeFilter', () => {
    const result = reachFiltered(mockIndex, 'formal_module::A', 2, ['invariant', 'requirement']);
    assert.strictEqual(result.length, 2, 'expected 2 results within depth 2');
    assert.strictEqual(result[0].key, 'invariant::B');
    assert.strictEqual(result[1].key, 'requirement::C');
  });

  it('respects maxDepth limit', () => {
    const result = reachFiltered(mockIndex, 'formal_module::A', 1, ['requirement']);
    assert.strictEqual(result.length, 0, 'requirement at depth 2 should not be found with maxDepth=1');
  });

  it('returns empty array for nonexistent start node', () => {
    const result = reachFiltered(mockIndex, 'nonexistent::X', 2, ['formal_module']);
    assert.deepStrictEqual(result, []);
  });

  it('filters by type correctly', () => {
    const result = reachFiltered(mockIndex, 'formal_module::A', 3, ['formal_module']);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].key, 'formal_module::D');
  });

  it('does not crash when a reachable node lacks an edges array (leaf node)', () => {
    const idx = {
      nodes: {
        'a::1': { type: 'a', edges: [{ to: 'b::2', rel: 'owns' }] },
        'b::2': { type: 'b' } // no edges property — terminal node
      }
    };
    let result;
    assert.doesNotThrow(() => { result = reachFiltered(idx, 'a::1', 3, ['b']); });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].key, 'b::2');
  });
});

// ── proximityScore tests ──────────────────────────────────────────────────────

describe('proximityScore', () => {
  let mockIndex;

  beforeEach(() => {
    // Linear 3-node graph: A -> B -> C
    mockIndex = {
      nodes: {
        'node::A': {
          type: 'node',
          edges: [{ to: 'node::B', rel: 'owns' }]
        },
        'node::B': {
          type: 'node',
          edges: [{ to: 'node::C', rel: 'contains' }]
        },
        'node::C': {
          type: 'node',
          edges: []
        }
      }
    };
  });

  it('returns 1.0 for same node', () => {
    const result = proximityScore(mockIndex, 'node::A', 'node::A');
    assert.strictEqual(result, 1.0);
  });

  it('returns score > 0 for reachable node', () => {
    const result = proximityScore(mockIndex, 'node::A', 'node::C');
    assert.ok(result > 0, 'expected score > 0 for reachable node');
    assert.ok(result < 1, 'expected score < 1 due to decay');
  });

  it('returns 0 for unreachable node', () => {
    const result = proximityScore(mockIndex, 'nonexistent::X', 'node::B');
    assert.strictEqual(result, 0);
  });

  it('handles null/missing nodes gracefully', () => {
    const result = proximityScore(mockIndex, 'node::A', 'nonexistent::Y');
    assert.strictEqual(result, 0);
  });

  it('does not crash when a queued node lacks an edges array', () => {
    const idx = {
      nodes: {
        'node::A': { type: 'node', edges: [{ to: 'node::B', rel: 'owns' }] },
        'node::B': { type: 'node' } // no edges property
      }
    };
    let result;
    assert.doesNotThrow(() => { result = proximityScore(idx, 'node::A', 'node::C'); });
    assert.strictEqual(result, 0);
  });
});

// ── keywordOverlap tests ──────────────────────────────────────────────────────

describe('keywordOverlap', () => {
  let tmpDir;
  let tmpFile;

  beforeEach(() => {
    tmpDir = path.join(process.cwd(), '.test-models');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    tmpFile = path.join(tmpDir, 'test-model-' + Date.now() + '.tla');
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      // Clean up dir if empty
      if (fs.existsSync(tmpDir)) {
        const files = fs.readdirSync(tmpDir);
        if (files.length === 0) fs.rmdirSync(tmpDir);
      }
    } catch { /* ignore */ }
  });

  it('detects keyword overlap', () => {
    fs.writeFileSync(tmpFile, 'circuit breaker timeout mechanism', 'utf8');
    const relPath = path.relative(process.cwd(), tmpFile);
    const result = keywordOverlap(relPath, 'circuit breaker');
    assert.strictEqual(result, true);
  });

  it('rejects zero-overlap case', () => {
    // Use model content that has completely different keywords
    fs.writeFileSync(tmpFile, 'zebra elephant giraffe animal wildlife', 'utf8');
    const relPath = path.relative(process.cwd(), tmpFile);
    const result = keywordOverlap(relPath, 'circuit breaker timeout');
    assert.strictEqual(result, false);
  });

  it('returns true for missing file (fail-open)', () => {
    const result = keywordOverlap('.test-models/nonexistent-model-99999.tla', 'test');
    assert.strictEqual(result, true);
  });

  it('returns true for empty requirement text (can\'t filter)', () => {
    fs.writeFileSync(tmpFile, 'some content', 'utf8');
    const relPath = path.relative(process.cwd(), tmpFile);
    const result = keywordOverlap(relPath, '');
    assert.strictEqual(result, true);
  });

  it('returns true for empty model file (can\'t filter)', () => {
    fs.writeFileSync(tmpFile, '', 'utf8');
    const relPath = path.relative(process.cwd(), tmpFile);
    const result = keywordOverlap(relPath, 'circuit breaker');
    assert.strictEqual(result, true);
  });
});

// ── graphDiscoverModules tests ────────────────────────────────────────────────

describe('graphDiscoverModules', () => {
  let mockIndex;

  beforeEach(() => {
    // Graph with concept nodes leading to formal modules:
    // concept::breaker -> formal_module::breaker-mod (depth 1)
    // concept::circuit-breaker -> formal_module::breaker-mod (depth 1)
    // concept::breaker -> formal_module::breaker-mod-advanced (depth 2)
    mockIndex = {
      nodes: {
        'concept::breaker': {
          type: 'concept',
          edges: [
            { to: 'formal_module::breaker-mod', rel: 'describes' },
            { to: 'intermediate::X', rel: 'relates_to' }
          ]
        },
        'formal_module::breaker-mod': {
          type: 'formal_module',
          edges: []
        },
        'concept::circuit-breaker': {
          type: 'concept',
          edges: [{ to: 'formal_module::breaker-mod', rel: 'describes' }]
        },
        'intermediate::X': {
          type: 'intermediate',
          edges: [{ to: 'formal_module::breaker-mod-advanced', rel: 'contains' }]
        },
        'formal_module::breaker-mod-advanced': {
          type: 'formal_module',
          edges: []
        }
      }
    };
  });

  it('discovers modules from concept exact match', () => {
    const result = graphDiscoverModules(mockIndex, ['breaker'], '');
    assert.ok(result.some(r => r.module === 'breaker-mod'), 'expected breaker-mod to be discovered');
  });

  it('discovers via partial match', () => {
    const result = graphDiscoverModules(mockIndex, ['break'], '');
    // 'break' should match concepts containing 'break' like 'breaker' and 'circuit-breaker'
    assert.ok(result.length > 0, 'expected partial match to find modules');
  });

  it('returns empty for empty index', () => {
    const result = graphDiscoverModules(null, ['breaker'], '');
    assert.deepStrictEqual(result, []);
  });

  it('returns empty for empty tokens', () => {
    const result = graphDiscoverModules(mockIndex, [], '');
    assert.deepStrictEqual(result, []);
  });

  it('deduplicates by module, keeps shortest path', () => {
    const result = graphDiscoverModules(mockIndex, ['breaker'], '');
    const breaker = result.find(r => r.module === 'breaker-mod');
    assert.ok(breaker, 'expected breaker-mod in results');
    // Should be discovered via concept::breaker at depth 1, not at a deeper path
    assert.strictEqual(breaker.depth, 1, 'expected depth 1 for shortest path');
  });

  it('sorts deterministically: by depth ascending, then module name', () => {
    // With two modules at different depths, verify sort order
    const result = graphDiscoverModules(mockIndex, ['breaker'], '');
    if (result.length >= 2) {
      for (let i = 1; i < result.length; i++) {
        const prev = result[i - 1];
        const curr = result[i];
        // Either curr is deeper, or same depth but alphabetically later
        assert.ok(
          curr.depth > prev.depth || (curr.depth === prev.depth && curr.module >= prev.module),
          `expected proper sort order at index ${i}`
        );
      }
    }
  });

  it('sorts equal-depth modules alphabetically (deterministic output)', () => {
    // Create scenario with two modules at same depth
    const testIndex = {
      nodes: {
        'concept::test': {
          type: 'concept',
          edges: [
            { to: 'formal_module::zebra-mod', rel: 'describes' },
            { to: 'formal_module::apple-mod', rel: 'describes' }
          ]
        },
        'formal_module::zebra-mod': {
          type: 'formal_module',
          edges: []
        },
        'formal_module::apple-mod': {
          type: 'formal_module',
          edges: []
        }
      }
    };

    const result = graphDiscoverModules(testIndex, ['test'], '');
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].module, 'apple-mod', 'expected apple-mod first (alphabetically)');
    assert.strictEqual(result[1].module, 'zebra-mod', 'expected zebra-mod second (alphabetically)');
  });

  it('skips non-string tokens without crashing', () => {
    let result;
    assert.doesNotThrow(() => { result = graphDiscoverModules(mockIndex, [42, 'breaker'], ''); });
    assert.ok(result.some(r => r.module === 'breaker-mod'), 'expected valid string token to still discover breaker-mod');
  });
});

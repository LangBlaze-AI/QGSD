const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// Mock proximity function for isolated unit tests
// ─────────────────────────────────────────────────────────────────────────────

// We test discoverCandidates by mocking the proximity function it imports.
// Since discoverCandidates uses require('./formal-proximity.cjs'), we override
// the module cache before importing.

const MOCK_SCORES = new Map();

function setMockScores(scores) {
  MOCK_SCORES.clear();
  for (const [key, val] of Object.entries(scores)) {
    MOCK_SCORES.set(key, val);
  }
}

// Override the formal-proximity module in cache with a mock
const formalProximityPath = require.resolve('./formal-proximity.cjs');
const originalModule = require.cache[formalProximityPath];

// Install mock before loading candidate-discovery
require.cache[formalProximityPath] = {
  id: formalProximityPath,
  filename: formalProximityPath,
  loaded: true,
  exports: {
    proximity: (index, keyA, keyB, maxDepth) => {
      const lookupKey = `${keyA}|${keyB}`;
      if (MOCK_SCORES.has(lookupKey)) return MOCK_SCORES.get(lookupKey);
      return 0;
    },
    buildIndex: () => ({ index: { nodes: {} }, totalNodes: 0, totalEdges: 0 }),
    EDGE_WEIGHTS: {},
    REVERSE_RELS: {},
    ENSEMBLE_METHODS: ['semantic+hub+tfidf'],
    AMPLIFIED_ENSEMBLE_METHODS: ['semantic+hub+tfidf', 'semantic+hub+embed'],
    loadEmbeddingCache: () => null,
  },
};

const { discoverCandidates } = require('./candidate-discovery.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMockIndex(extraNodes) {
  return {
    schema_version: '1',
    generated: '2026-01-01T00:00:00.000Z',
    node_key_format: 'type::id',
    sources: {},
    nodes: {
      'formal_model::models/a.als': { type: 'formal_model', id: 'models/a.als', edges: [] },
      'requirement::REQ-01': { type: 'requirement', id: 'REQ-01', edges: [] },
      'requirement::REQ-02': { type: 'requirement', id: 'REQ-02', edges: [] },
      ...(extraNodes || {}),
    },
  };
}

function makeMockRegistry(models) {
  return { version: '1.0', models: models || {} };
}

function makeMockRequirements(ids) {
  return ids.map(id => ({ id, text: `Requirement ${id}`, category: 'Test' }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('candidate-discovery', () => {

  describe('discoverCandidates', () => {

    it('should discover candidates with score > threshold within 3 hops', () => {
      const index = makeMockIndex();
      const registry = makeMockRegistry({
        'models/a.als': { requirements: [], source_layer: 'L3', gate_maturity: 'SOFT_GATE' },
      });
      const reqs = makeMockRequirements(['REQ-01', 'REQ-02']);

      // Mock scores: REQ-01 is close (0.85), REQ-02 is far (0.3)
      setMockScores({
        'formal_model::models/a.als|requirement::REQ-01': 0.85,
        'formal_model::models/a.als|requirement::REQ-02': 0.3,
      });

      const result = discoverCandidates(index, registry, reqs, { threshold: 0.7, maxHops: 3 });

      assert.equal(result.candidates.length, 1, 'should find exactly 1 candidate');
      assert.equal(result.candidates[0].model, 'models/a.als');
      assert.equal(result.candidates[0].requirement, 'REQ-01');
      assert.equal(result.candidates[0].proximity_score, 0.85);
      assert.equal(result.metadata.candidates_found, 1);
    });

    it('should skip already-linked (model, req) pairs', () => {
      const index = makeMockIndex();
      const registry = makeMockRegistry({
        'models/a.als': { requirements: ['REQ-01'], source_layer: 'L3' },
      });
      const reqs = makeMockRequirements(['REQ-01']);

      // Even though score would be high, the pair is linked so should be excluded
      setMockScores({
        'formal_model::models/a.als|requirement::REQ-01': 0.95,
      });

      const result = discoverCandidates(index, registry, reqs, { threshold: 0.6, maxHops: 3 });

      assert.equal(result.candidates.length, 0, 'linked pair should be excluded');
      assert.equal(result.metadata.total_pairs_checked, 0, 'linked pair should not even be checked');
    });

    it('should return candidates in deterministic order', () => {
      const index = makeMockIndex({
        'formal_model::models/b.als': { type: 'formal_model', id: 'models/b.als', edges: [] },
      });
      const registry = makeMockRegistry({
        'models/a.als': { requirements: [] },
        'models/b.als': { requirements: [] },
      });
      const reqs = makeMockRequirements(['REQ-01', 'REQ-02']);

      setMockScores({
        'formal_model::models/a.als|requirement::REQ-01': 0.75,
        'formal_model::models/a.als|requirement::REQ-02': 0.85,
        'formal_model::models/b.als|requirement::REQ-01': 0.85,
        'formal_model::models/b.als|requirement::REQ-02': 0.65,
      });

      const result1 = discoverCandidates(index, registry, reqs, { threshold: 0.6, maxHops: 3 });
      const result2 = discoverCandidates(index, registry, reqs, { threshold: 0.6, maxHops: 3 });

      // Strip generated timestamp for comparison (it changes each call)
      const c1 = result1.candidates;
      const c2 = result2.candidates;

      assert.deepStrictEqual(c1, c2, 'two runs should produce identical candidate arrays');
      assert.equal(c1.length, 4, 'should find 4 candidates');

      // Verify sort order: highest score first, then alphabetical for ties
      assert.equal(c1[0].proximity_score, 0.85);
      assert.equal(c1[1].proximity_score, 0.85);
      // Tie-break: models/a.als::REQ-02 < models/b.als::REQ-01 (alphabetical)
      assert.equal(c1[0].model, 'models/a.als');
      assert.equal(c1[0].requirement, 'REQ-02');
      assert.equal(c1[1].model, 'models/b.als');
      assert.equal(c1[1].requirement, 'REQ-01');
    });

    it('should handle missing proximity-index gracefully', () => {
      // discoverCandidates doesn't read files — the CLI does. But we test
      // that it handles empty/missing nodes gracefully (returns 0 candidates)
      const emptyIndex = { schema_version: '1', nodes: {} };
      const registry = makeMockRegistry({
        'models/a.als': { requirements: [] },
      });
      const reqs = makeMockRequirements(['REQ-01']);

      setMockScores({}); // All scores return 0

      const result = discoverCandidates(emptyIndex, registry, reqs, { threshold: 0.6, maxHops: 3 });

      assert.equal(result.candidates.length, 0, 'should return 0 candidates for empty index');
      assert.equal(result.metadata.total_pairs_checked, 1);
    });

    it('should include proximity_index_hash in metadata', () => {
      const index = makeMockIndex();
      const registry = makeMockRegistry({
        'models/a.als': { requirements: [] },
      });
      const reqs = makeMockRequirements(['REQ-01']);

      setMockScores({});

      const result = discoverCandidates(index, registry, reqs);

      // Hash should be 8-character hex string
      assert.ok(result.metadata.proximity_index_hash, 'should have proximity_index_hash');
      assert.match(result.metadata.proximity_index_hash, /^[0-9a-f]{8}$/, 'hash should be 8-char hex');

      // Verify it matches expected SHA256 prefix
      const expected = crypto.createHash('sha256').update(JSON.stringify(index)).digest('hex').slice(0, 8);
      assert.equal(result.metadata.proximity_index_hash, expected, 'hash should match SHA256 prefix of index');
    });

    it('should respect --min-score threshold', () => {
      const index = makeMockIndex();
      const registry = makeMockRegistry({
        'models/a.als': { requirements: [] },
      });
      const reqs = makeMockRequirements(['REQ-01', 'REQ-02']);

      setMockScores({
        'formal_model::models/a.als|requirement::REQ-01': 0.5,
        'formal_model::models/a.als|requirement::REQ-02': 0.8,
      });

      // With threshold 0.7, only REQ-02 should appear
      const result1 = discoverCandidates(index, registry, reqs, { threshold: 0.7, maxHops: 3 });
      assert.equal(result1.candidates.length, 1);
      assert.equal(result1.candidates[0].requirement, 'REQ-02');

      // With threshold 0.4, both should appear
      const result2 = discoverCandidates(index, registry, reqs, { threshold: 0.4, maxHops: 3 });
      assert.equal(result2.candidates.length, 2);
    });

    it('default threshold is 0.7 so score 0.65 should NOT appear', () => {
      const index = makeMockIndex();
      const registry = makeMockRegistry({
        'models/a.als': { requirements: [] },
      });
      const reqs = makeMockRequirements(['REQ-01']);

      setMockScores({
        'formal_model::models/a.als|requirement::REQ-01': 0.65,
      });

      // With default threshold (0.7), 0.65 should be excluded
      const result = discoverCandidates(index, registry, reqs, { maxHops: 3 });
      assert.equal(result.candidates.length, 0, 'score 0.65 should not appear with default 0.7 threshold');
    });

    it('orphan detection uses graph connectivity', () => {
      // REQ-01 has edges, REQ-02 has 0 edges -- REQ-02 should be orphan
      const index = makeMockIndex({
        'requirement::REQ-01': { type: 'requirement', id: 'REQ-01', edges: [
          { to: 'formal_model::models/a.als', rel: 'modeled_by', source: 'test' }
        ] },
        'requirement::REQ-02': { type: 'requirement', id: 'REQ-02', edges: [] },
      });
      const registry = makeMockRegistry({
        'models/a.als': { requirements: [] },
      });
      const reqs = makeMockRequirements(['REQ-01', 'REQ-02']);

      setMockScores({});

      const result = discoverCandidates(index, registry, reqs, { threshold: 0.7, maxHops: 3 });

      // REQ-02 should be orphan (0 edges), REQ-01 should NOT
      const orphanIds = result.orphans.requirements.map(o => o.id);
      assert.ok(orphanIds.includes('REQ-02'), 'REQ-02 with 0 edges should be orphan');
      assert.ok(!orphanIds.includes('REQ-01'), 'REQ-01 with edges should NOT be orphan');
    });

    it('result includes uncovered_requirements array', () => {
      const index = makeMockIndex();
      const registry = makeMockRegistry({
        'models/a.als': { requirements: [] },
      });
      const reqs = makeMockRequirements(['REQ-01']);

      setMockScores({});

      const result = discoverCandidates(index, registry, reqs, { threshold: 0.7, maxHops: 3 });
      assert.ok(Array.isArray(result.uncovered_requirements), 'uncovered_requirements should be an array');
      assert.ok(typeof result.metadata.uncovered_requirements_count === 'number', 'metadata should have uncovered_requirements_count');
    });

    it('should handle NaN/undefined proximity scores gracefully', () => {
      const index = makeMockIndex();
      const registry = makeMockRegistry({
        'models/a.als': { requirements: [] },
      });
      const reqs = makeMockRequirements(['REQ-01']);

      setMockScores({
        'formal_model::models/a.als|requirement::REQ-01': NaN,
      });

      // Should not crash, should skip the pair
      const result = discoverCandidates(index, registry, reqs, { threshold: 0.6, maxHops: 3 });
      assert.equal(result.candidates.length, 0, 'NaN scores should be skipped');
    });

    it('should not crash when model-registry has a null model entry', () => {
      const index = makeMockIndex();
      const registry = makeMockRegistry({
        'models/a.als': null,
      });
      const reqs = makeMockRequirements(['REQ-01']);

      setMockScores({});

      // Should skip the malformed entry rather than throw
      const result = discoverCandidates(index, registry, reqs, { threshold: 0.7, maxHops: 3 });
      assert.ok(Array.isArray(result.candidates), 'should return a candidates array');
      assert.equal(result.candidates.length, 0, 'null model contributes no candidates');
    });

    it('should not crash when requirements array contains a null entry', () => {
      const index = makeMockIndex();
      const registry = makeMockRegistry({
        'models/a.als': { requirements: [] },
      });
      const reqs = [...makeMockRequirements(['REQ-01']), null];

      setMockScores({
        'formal_model::models/a.als|requirement::REQ-01': 0.85,
      });

      const result = discoverCandidates(index, registry, reqs, { threshold: 0.7, maxHops: 3 });
      assert.equal(result.candidates.length, 1, 'valid requirement still produces its candidate');
      assert.equal(result.candidates[0].requirement, 'REQ-01');
    });

  });

});

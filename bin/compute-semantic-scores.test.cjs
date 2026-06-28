const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeGateSemanticScore, enrichGateFile } = require('./compute-semantic-scores.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeCandidate(model, requirement, verdict, confidence) {
  return {
    model,
    requirement,
    proximity_score: 0.8,
    verdict,
    confidence: confidence || 0.9,
    evaluation_timestamp: '2026-01-01T00:00:00Z',
  };
}

function makePerModelGates(models) {
  const result = {};
  for (const [modelPath, gates] of Object.entries(models)) {
    result[modelPath] = {
      gate_a: { pass: gates.a !== false, reason: 'test' },
      gate_b: { pass: gates.b !== false, reason: 'test' },
      gate_c: { pass: gates.c !== false, reason: 'test' },
    };
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('compute-semantic-scores', () => {

  describe('computeGateSemanticScore', () => {

    it('should compute gate semantic_score as confirmed/total ratio', () => {
      const candidates = [
        makeCandidate('m1.als', 'REQ-01', 'yes'),
        makeCandidate('m2.als', 'REQ-02', 'yes'),
        makeCandidate('m3.als', 'REQ-03', 'no'),
      ];
      const perModelGates = makePerModelGates({
        'm1.als': { a: true },
        'm2.als': { a: true },
        'm3.als': { a: true },
      });

      const result = computeGateSemanticScore(candidates, perModelGates, 'gate_a', 0.5);

      // 2 yes + 0 maybe + 1 no = 2/3
      assert.ok(Math.abs(result.semantic_score - 0.6667) < 0.001, `expected ~0.667, got ${result.semantic_score}`);
      assert.equal(result.semantic_metadata.confirmed, 2);
      assert.equal(result.semantic_metadata.rejected, 1);
      assert.equal(result.semantic_metadata.evaluated_candidates, 3);
    });

    it('should handle 0 confirmed candidates (score = 0)', () => {
      const candidates = [
        makeCandidate('m1.als', 'REQ-01', 'no'),
        makeCandidate('m2.als', 'REQ-02', 'no'),
      ];
      const perModelGates = makePerModelGates({
        'm1.als': { a: true },
        'm2.als': { a: true },
      });

      const result = computeGateSemanticScore(candidates, perModelGates, 'gate_a', 0.5);
      assert.equal(result.semantic_score, 0.0);
    });

    it('should handle 0 total candidates (score = 0)', () => {
      const candidates = [];
      const perModelGates = makePerModelGates({
        'm1.als': { a: true },
      });

      const result = computeGateSemanticScore(candidates, perModelGates, 'gate_a', 0.5);
      assert.equal(result.semantic_score, 0.0);
      assert.ok(!isNaN(result.semantic_score), 'should not be NaN');
      assert.ok(isFinite(result.semantic_score), 'should not be Infinity');
    });

    it('should treat maybe verdicts with configurable weight', () => {
      const candidates = [
        makeCandidate('m1.als', 'REQ-01', 'yes'),
        makeCandidate('m2.als', 'REQ-02', 'maybe'),
        makeCandidate('m3.als', 'REQ-03', 'no'),
      ];
      const perModelGates = makePerModelGates({
        'm1.als': { a: true },
        'm2.als': { a: true },
        'm3.als': { a: true },
      });

      const result = computeGateSemanticScore(candidates, perModelGates, 'gate_a', 0.5);
      // (1 + 0.5*1) / 3 = 1.5/3 = 0.5
      assert.equal(result.semantic_score, 0.5);
      assert.equal(result.semantic_metadata.maybe, 1);
    });

    it('should only count candidates whose model passes the specific gate', () => {
      const candidates = [
        makeCandidate('m1.als', 'REQ-01', 'yes'),
        makeCandidate('m2.als', 'REQ-02', 'yes'),
      ];
      // m2 fails gate_b
      const perModelGates = makePerModelGates({
        'm1.als': { a: true, b: true, c: true },
        'm2.als': { a: true, b: false, c: true },
      });

      const resultA = computeGateSemanticScore(candidates, perModelGates, 'gate_a', 0.5);
      assert.equal(resultA.semantic_metadata.evaluated_candidates, 2);

      const resultB = computeGateSemanticScore(candidates, perModelGates, 'gate_b', 0.5);
      assert.equal(resultB.semantic_metadata.evaluated_candidates, 1);
      assert.equal(resultB.semantic_score, 1.0); // only m1, which is yes
    });

    it('should skip null / non-object model entries in perModelGates without throwing', () => {
      const candidates = [
        makeCandidate('m1.als', 'REQ-01', 'yes'),
        makeCandidate('m2.als', 'REQ-02', 'yes'),
      ];
      // m1.als entry is null (corrupt per-model-gates.json); m2.als is well-formed
      const perModelGates = {
        'm1.als': null,
        'm2.als': { gate_a: { pass: true }, gate_b: { pass: true }, gate_c: { pass: true } },
      };

      let result;
      assert.doesNotThrow(() => {
        result = computeGateSemanticScore(candidates, perModelGates, 'gate_a', 0.5);
      });
      // Only m2.als is a valid passing model
      assert.equal(result.semantic_metadata.evaluated_candidates, 1);
      assert.equal(result.semantic_score, 1.0);
    });

    it('should ignore null / non-object candidate entries without throwing', () => {
      const candidates = [
        makeCandidate('m1.als', 'REQ-01', 'yes'),
        null,
        makeCandidate('m1.als', 'REQ-02', 'no'),
      ];
      const perModelGates = makePerModelGates({ 'm1.als': { a: true } });

      let result;
      assert.doesNotThrow(() => {
        result = computeGateSemanticScore(candidates, perModelGates, 'gate_a', 0.5);
      });
      // null entry dropped; 1 yes + 1 no = 0.5
      assert.equal(result.semantic_metadata.evaluated_candidates, 2);
      assert.equal(result.semantic_score, 0.5);
    });

    it('should fall back to default weight when maybeWeight is NaN (no NaN score)', () => {
      const candidates = [
        makeCandidate('m1.als', 'REQ-01', 'yes'),
        makeCandidate('m2.als', 'REQ-02', 'no'),
      ];
      const perModelGates = makePerModelGates({
        'm1.als': { a: true },
        'm2.als': { a: true },
      });

      // e.g. CLI `--maybe-weight abc` -> parseFloat('abc') -> NaN
      const result = computeGateSemanticScore(candidates, perModelGates, 'gate_a', NaN);
      assert.ok(!isNaN(result.semantic_score), `score should not be NaN, got ${result.semantic_score}`);
      assert.ok(isFinite(result.semantic_score), 'score should be finite');
      // 1 yes + 0 maybe over 2 total -> 0.5 with the default weight
      assert.equal(result.semantic_score, 0.5);
    });

  });

  describe('enrichGateFile', () => {

    it('should write semantic_score to gate JSON alongside wiring_score', () => {
      const gateData = {
        schema_version: '2',
        generated: '2026-01-01T00:00:00Z',
        wiring_evidence_score: 1,
        target: 0.8,
        target_met: true,
        explained: 180,
        total: 180,
        unexplained_counts: { instrumentation_bug: 0, model_gap: 0, genuine_violation: 0 },
      };

      const enriched = enrichGateFile(gateData, 0.85, {
        evaluated_candidates: 20,
        confirmed: 17,
        rejected: 3,
        maybe: 0,
        computed: '2026-01-01T00:00:00Z',
      });

      // Both wiring and semantic present
      assert.equal(enriched.wiring_evidence_score, 1);
      assert.equal(enriched.semantic_score, 0.85);
      assert.equal(enriched.schema_version, '3');
      assert.deepStrictEqual(enriched.semantic_metadata, {
        evaluated_candidates: 20,
        confirmed: 17,
        rejected: 3,
        maybe: 0,
        computed: '2026-01-01T00:00:00Z',
      });
    });

    it('should preserve existing gate JSON fields', () => {
      const gateData = {
        schema_version: '2',
        generated: '2026-01-01T00:00:00Z',
        wiring_purpose_score: 0.983,
        total_entries: 180,
        grounded_entries: 177,
        orphaned_entries: 3,
        target: 1,
        target_met: false,
      };

      const enriched = enrichGateFile(gateData, 0.92, {
        evaluated_candidates: 25,
        confirmed: 23,
        rejected: 2,
        maybe: 0,
        computed: '2026-01-01T00:00:00Z',
      });

      // All original fields preserved
      assert.equal(enriched.wiring_purpose_score, 0.983);
      assert.equal(enriched.total_entries, 180);
      assert.equal(enriched.grounded_entries, 177);
      assert.equal(enriched.orphaned_entries, 3);
      assert.equal(enriched.target, 1);
      assert.equal(enriched.target_met, false);
      assert.equal(enriched.generated, '2026-01-01T00:00:00Z');
      // New fields added
      assert.equal(enriched.semantic_score, 0.92);
      assert.equal(enriched.schema_version, '3');
    });

    it('should be idempotent: same input produces same output', () => {
      const gateData = {
        schema_version: '2',
        wiring_coverage_score: 1,
        target: 0.8,
      };
      const metadata = {
        evaluated_candidates: 18,
        confirmed: 14,
        rejected: 4,
        maybe: 0,
        computed: '2026-01-01T00:00:00Z',
      };

      const result1 = enrichGateFile(gateData, 0.78, metadata);
      const result2 = enrichGateFile(gateData, 0.78, metadata);

      assert.deepStrictEqual(result1, result2);
    });

  });

});

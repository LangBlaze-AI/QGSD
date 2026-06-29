const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { generatePairings } = require('./candidate-pairings.cjs');

describe('candidate-pairings', () => {

  function makeCandidatesData(candidates) {
    return { metadata: { generated: '2026-01-01', candidates_found: candidates.length }, candidates };
  }

  function makeCandidate(model, req, verdict, score) {
    return { model, requirement: req, proximity_score: score || 0.8, verdict: verdict || 'yes', confidence: 0.9, reasoning: 'test' };
  }

  it('should generate pairings from candidates with resolution tracking', () => {
    const data = makeCandidatesData([makeCandidate('m1.als', 'REQ-01', 'yes', 0.85)]);
    const result = generatePairings(data, null);

    assert.equal(result.pairings.length, 1);
    assert.equal(result.pairings[0].status, 'pending');
    assert.equal(result.pairings[0].resolved_at, null);
    assert.equal(result.pairings[0].resolved_by, null);
    assert.equal(result.pairings[0].proximity_score, 0.85);
    assert.equal(result.pairings[0].verdict, 'yes');
    assert.equal(result.metadata.pending, 1);
  });

  it('should preserve rejected pairings on re-run (PAIR-04 cache)', () => {
    const data = makeCandidatesData([makeCandidate('m1.als', 'REQ-01', 'yes', 0.85)]);
    const existing = {
      metadata: {},
      pairings: [{
        model: 'm1.als', requirement: 'REQ-01', proximity_score: 0.85,
        verdict: 'yes', confidence: 0.9, reasoning: 'test',
        status: 'rejected', resolved_at: '2026-01-01T00:00:00Z', resolved_by: 'human',
      }],
    };

    const result = generatePairings(data, existing);
    assert.equal(result.pairings[0].status, 'rejected');
    assert.equal(result.pairings[0].resolved_at, '2026-01-01T00:00:00Z');
    assert.equal(result.metadata.rejected, 1);
    assert.equal(result.metadata.pending, 0);
  });

  it('should preserve confirmed pairings on re-run', () => {
    const data = makeCandidatesData([makeCandidate('m1.als', 'REQ-01', 'yes', 0.85)]);
    const existing = {
      metadata: {},
      pairings: [{
        model: 'm1.als', requirement: 'REQ-01', proximity_score: 0.85,
        verdict: 'yes', confidence: 0.9, reasoning: 'test',
        status: 'confirmed', resolved_at: '2026-01-01T00:00:00Z', resolved_by: 'human',
      }],
    };

    const result = generatePairings(data, existing);
    assert.equal(result.pairings[0].status, 'confirmed');
    assert.equal(result.metadata.confirmed, 1);
  });

  it('should add new candidates as pending', () => {
    const data = makeCandidatesData([
      makeCandidate('m1.als', 'REQ-01', 'yes', 0.85),
      makeCandidate('m2.als', 'REQ-02', 'maybe', 0.7),
    ]);
    const existing = {
      metadata: {},
      pairings: [{
        model: 'm1.als', requirement: 'REQ-01', proximity_score: 0.85,
        verdict: 'yes', status: 'confirmed', resolved_at: '2026-01-01', resolved_by: 'human',
      }],
    };

    const result = generatePairings(data, existing);
    assert.equal(result.pairings.length, 2);
    const newPairing = result.pairings.find(p => p.requirement === 'REQ-02');
    assert.equal(newPairing.status, 'pending');
  });

  it('should sort by verdict priority then score', () => {
    const data = makeCandidatesData([
      makeCandidate('m1.als', 'REQ-01', 'no', 0.9),
      makeCandidate('m2.als', 'REQ-02', 'yes', 0.7),
      makeCandidate('m3.als', 'REQ-03', 'maybe', 0.8),
      makeCandidate('m4.als', 'REQ-04', 'yes', 0.9),
    ]);

    const result = generatePairings(data, null);
    assert.equal(result.pairings[0].verdict, 'yes');
    assert.equal(result.pairings[0].proximity_score, 0.9); // highest yes
    assert.equal(result.pairings[1].verdict, 'yes');
    assert.equal(result.pairings[2].verdict, 'maybe');
    assert.equal(result.pairings[3].verdict, 'no');
  });

  it('should include metadata with source_candidates_hash', () => {
    const data = makeCandidatesData([makeCandidate('m1.als', 'REQ-01')]);
    const result = generatePairings(data, null);

    assert.ok(result.metadata.source_candidates_hash);
    assert.match(result.metadata.source_candidates_hash, /^[0-9a-f]{8}$/);

    const expected = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 8);
    assert.equal(result.metadata.source_candidates_hash, expected);
  });

  it('should not crash on null or non-object candidatesData (candidates.json parsing to null)', () => {
    assert.doesNotThrow(() => generatePairings(null, null));
    const result = generatePairings(null, null);
    assert.equal(result.pairings.length, 0);
    assert.equal(result.metadata.total_pairings, 0);
    assert.equal(result.metadata.pending, 0);
  });

  it('should treat a non-array candidates field as empty', () => {
    const result = generatePairings({ candidates: { bogus: true } }, null);
    assert.equal(result.pairings.length, 0);
    assert.equal(result.metadata.total_pairings, 0);
  });

  it('should skip null/non-object candidate entries instead of crashing', () => {
    const data = makeCandidatesData([null, makeCandidate('m1.als', 'REQ-01', 'yes', 0.85)]);
    let result;
    assert.doesNotThrow(() => { result = generatePairings(data, null); });
    assert.equal(result.pairings.length, 1);
    assert.equal(result.pairings[0].requirement, 'REQ-01');
    assert.equal(result.pairings[0].status, 'pending');
  });

  it('should not crash when existing pairings has a corrupt shape', () => {
    const data = makeCandidatesData([makeCandidate('m1.als', 'REQ-01', 'yes', 0.85)]);
    assert.doesNotThrow(() => generatePairings(data, { pairings: { junk: true } }));
    let result;
    assert.doesNotThrow(() => { result = generatePairings(data, { pairings: [null] }); });
    assert.equal(result.pairings.length, 1);
    assert.equal(result.pairings[0].status, 'pending');
  });

});

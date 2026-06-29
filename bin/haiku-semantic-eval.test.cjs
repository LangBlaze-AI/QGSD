const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseHaikuResponse, evaluateCandidatesBatch, shouldSkipCached } = require('./haiku-semantic-eval.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Tests — all use mocked API, no real Haiku calls
// ─────────────────────────────────────────────────────────────────────────────

describe('haiku-semantic-eval', () => {

  describe('parseHaikuResponse', () => {

    it('should parse valid JSON verdict from Haiku response', () => {
      const text = '{"verdict":"yes","confidence":0.9,"reasoning":"Direct coverage"}';
      const result = parseHaikuResponse(text);
      assert.equal(result.verdict, 'yes');
      assert.equal(result.confidence, 0.9);
      assert.equal(result.reasoning, 'Direct coverage');
    });

    it('should parse JSON from markdown-wrapped response', () => {
      const text = '```json\n{"verdict":"no","confidence":0.8,"reasoning":"No match"}\n```';
      const result = parseHaikuResponse(text);
      assert.equal(result.verdict, 'no');
      assert.equal(result.confidence, 0.8);
    });

    it('should fallback to maybe on unparseable response', () => {
      const text = 'I think this model covers the requirement';
      const result = parseHaikuResponse(text);
      assert.equal(result.verdict, 'maybe');
      assert.equal(result.confidence, 0.0);
      assert.ok(result.reasoning.startsWith('unparseable:'));
    });

    it('should handle empty/null input', () => {
      assert.equal(parseHaikuResponse('').verdict, 'maybe');
      assert.equal(parseHaikuResponse(null).verdict, 'maybe');
      assert.equal(parseHaikuResponse(undefined).verdict, 'maybe');
    });

    it('should normalize verdict values', () => {
      assert.equal(parseHaikuResponse('{"verdict":"YES"}').verdict, 'yes');
      assert.equal(parseHaikuResponse('{"verdict":"No"}').verdict, 'no');
      assert.equal(parseHaikuResponse('{"verdict":"uncertain"}').verdict, 'maybe');
    });

  });

  describe('shouldSkipCached', () => {

    it('should skip already-evaluated candidates with cached verdicts', () => {
      const candidate = {
        model: 'test.als',
        requirement: 'REQ-01',
        proximity_score: 0.85,
        verdict: 'yes',
        confidence: 0.9,
        evaluation_timestamp: '2026-01-01T00:00:00Z',
      };
      assert.equal(shouldSkipCached(candidate), true);
    });

    it('should not skip candidates without verdict', () => {
      const candidate = {
        model: 'test.als',
        requirement: 'REQ-01',
        proximity_score: 0.85,
      };
      assert.equal(shouldSkipCached(candidate), false);
    });

    it('should not skip candidates without evaluation_timestamp', () => {
      const candidate = {
        model: 'test.als',
        requirement: 'REQ-01',
        proximity_score: 0.85,
        verdict: 'yes',
      };
      assert.equal(shouldSkipCached(candidate), false);
    });

  });

  describe('shouldSkipCached (adversarial)', () => {
    it('should not crash on null / non-object candidate', () => {
      assert.equal(shouldSkipCached(null), false);
      assert.equal(shouldSkipCached(undefined), false);
      assert.equal(shouldSkipCached('not-an-object'), false);
      assert.equal(shouldSkipCached(42), false);
    });
  });

  describe('evaluateCandidatesBatch', () => {

    it('should batch candidates and call API for each', async () => {
      let callCount = 0;
      const mockApi = async () => {
        callCount++;
        return '{"verdict":"yes","confidence":0.95,"reasoning":"test"}';
      };

      const candidates = [
        { model: 'a.als', requirement: 'REQ-01', proximity_score: 0.8 },
        { model: 'b.als', requirement: 'REQ-02', proximity_score: 0.7 },
        { model: 'c.als', requirement: 'REQ-03', proximity_score: 0.9 },
      ];

      const results = await evaluateCandidatesBatch(candidates, 'test-key', { apiCall: mockApi });

      assert.equal(callCount, 3, 'should call API once per candidate');
      assert.equal(results.length, 3);
      assert.equal(results[0].verdict, 'yes');
      assert.equal(results[1].verdict, 'yes');
      assert.ok(results[0].evaluation_timestamp);
    });

    it('should handle 429 rate limit with retry', async () => {
      let callCount = 0;
      const mockApi = async () => {
        callCount++;
        if (callCount === 1) {
          throw Object.assign(new Error('HTTP 429'), { statusCode: 429 });
        }
        return '{"verdict":"no","confidence":0.7,"reasoning":"retry worked"}';
      };

      const candidates = [
        { model: 'a.als', requirement: 'REQ-01', proximity_score: 0.8 },
      ];

      const results = await evaluateCandidatesBatch(candidates, 'test-key', { apiCall: mockApi });

      assert.ok(callCount >= 2, 'should have retried');
      assert.equal(results[0].verdict, 'no');
    });

    it('should fallback to maybe after max retries', async () => {
      const mockApi = async () => {
        throw Object.assign(new Error('HTTP 500'), { statusCode: 500 });
      };

      const candidates = [
        { model: 'a.als', requirement: 'REQ-01', proximity_score: 0.8 },
      ];

      const results = await evaluateCandidatesBatch(candidates, 'test-key', { apiCall: mockApi });

      assert.equal(results[0].verdict, 'maybe');
      assert.equal(results[0].confidence, 0.0);
      assert.ok(results[0].reasoning.includes('failed after retries'));
    });

  });

  describe('evaluateCandidatesBatch (adversarial)', () => {
    it('should not crash when the batch contains a null entry', async () => {
      const mockApi = async () => '{"verdict":"yes","confidence":0.9,"reasoning":"ok"}';
      const candidates = [
        null,
        { model: 'a.als', requirement: 'REQ-01', proximity_score: 0.8 },
      ];
      const results = await evaluateCandidatesBatch(candidates, 'test-key', { apiCall: mockApi });
      assert.equal(results.length, 2);
      assert.equal(results[1].verdict, 'yes');
    });
  });

  describe('parseHaikuResponse (confidence bounds)', () => {
    it('should clamp out-of-range confidence into [0,1]', () => {
      assert.equal(parseHaikuResponse('{"verdict":"yes","confidence":1.5}').confidence, 1);
      assert.equal(parseHaikuResponse('{"verdict":"no","confidence":-0.3}').confidence, 0);
    });
    it('should clamp confidence inside a markdown fence too', () => {
      const text = '```json\n{"verdict":"yes","confidence":99}\n```';
      assert.equal(parseHaikuResponse(text).confidence, 1);
    });
  });

});

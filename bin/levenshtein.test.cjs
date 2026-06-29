const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Tests written FIRST (TDD red phase) — implementation does not exist yet
const { levenshteinDistance, levenshteinSimilarity } = require('./levenshtein.cjs');

describe('levenshteinDistance', () => {
  it('kitten -> sitting = 3', () => {
    assert.strictEqual(levenshteinDistance('kitten', 'sitting'), 3);
  });

  it('empty -> empty = 0', () => {
    assert.strictEqual(levenshteinDistance('', ''), 0);
  });

  it('abc -> empty = 3', () => {
    assert.strictEqual(levenshteinDistance('abc', ''), 3);
  });

  it('empty -> abc = 3', () => {
    assert.strictEqual(levenshteinDistance('', 'abc'), 3);
  });

  it('same -> same = 0', () => {
    assert.strictEqual(levenshteinDistance('same', 'same'), 0);
  });

  it('a -> b = 1 (single substitution)', () => {
    assert.strictEqual(levenshteinDistance('a', 'b'), 1);
  });

  it('abc -> axc = 1 (middle substitution)', () => {
    assert.strictEqual(levenshteinDistance('abc', 'axc'), 1);
  });

  it('flaw -> lawn = 2', () => {
    assert.strictEqual(levenshteinDistance('flaw', 'lawn'), 2);
  });

  it('handles unicode characters', () => {
    // distance('café', 'cafe') = 1 (accent substitution)
    assert.strictEqual(levenshteinDistance('café', 'cafe'), 1);
  });
});

describe('levenshteinSimilarity', () => {
  it('identical strings = 1.0', () => {
    assert.strictEqual(levenshteinSimilarity('same', 'same'), 1.0);
  });

  it('both empty strings = 1.0', () => {
    assert.strictEqual(levenshteinSimilarity('', ''), 1.0);
  });

  it('abc vs xyz — low similarity', () => {
    // distance=3, max_len=3, similarity = 1 - 3/3 = 0.0
    assert.strictEqual(levenshteinSimilarity('abc', 'xyz'), 0.0);
  });

  it('abc vs abd — high similarity (0.667)', () => {
    // distance=1, max_len=3, similarity = 1 - 1/3 ≈ 0.667
    const sim = levenshteinSimilarity('abc', 'abd');
    assert.ok(Math.abs(sim - 0.6667) < 0.01, `Expected ~0.667, got ${sim}`);
  });

  it('case sensitive by default — ABC vs abc', () => {
    // distance=3 (3 substitutions), max_len=3, similarity=0.0
    const sim = levenshteinSimilarity('ABC', 'abc');
    assert.strictEqual(sim, 0.0);
  });

  it('near-duplicate: similar titles above 0.85 threshold', () => {
    // Realistic near-duplicate: same error with minor wording variation
    const sim = levenshteinSimilarity(
      'TypeError in authentication handler module',
      'TypeError in authentication handler service'
    );
    assert.ok(sim >= 0.85, `Expected >= 0.85, got ${sim}`);
  });

  it('different issues: "TypeError in auth" vs "SyntaxError in parser" < 0.85', () => {
    const sim = levenshteinSimilarity('TypeError in auth', 'SyntaxError in parser');
    assert.ok(sim < 0.85, `Expected < 0.85, got ${sim}`);
  });

  it('long string test (256 chars) completes without error', () => {
    const a = 'a'.repeat(256);
    const b = 'b'.repeat(256);
    const sim = levenshteinSimilarity(a, b);
    assert.strictEqual(sim, 0.0);
  });

  it('similarity is between 0.0 and 1.0 for arbitrary input', () => {
    const sim = levenshteinSimilarity('hello world', 'hello wurld');
    assert.ok(sim >= 0.0 && sim <= 1.0, `Expected 0.0-1.0, got ${sim}`);
  });

  it('one empty string returns 0.0', () => {
    assert.strictEqual(levenshteinSimilarity('abc', ''), 0.0);
    assert.strictEqual(levenshteinSimilarity('', 'abc'), 0.0);
  });
});

describe('levenshteinDistance hardening', () => {
  it('null/undefined operand does not crash (treated as empty string)', () => {
    assert.strictEqual(levenshteinDistance(null, 'abc'), 3);
    assert.strictEqual(levenshteinDistance('abc', undefined), 3);
    assert.strictEqual(levenshteinDistance(undefined, ''), 0);
  });
});

describe('levenshteinSimilarity hardening', () => {
  it('null/undefined operand returns a number instead of throwing', () => {
    assert.strictEqual(levenshteinSimilarity(null, 'abc'), 0.0);
    assert.strictEqual(levenshteinSimilarity('abc', undefined), 0.0);
    assert.strictEqual(levenshteinSimilarity(null, null), 1.0);
  });
});

describe('levenshteinDistance type-coercion hardening', () => {
  it('numeric operands do not throw RangeError', () => {
    assert.strictEqual(levenshteinDistance(12, 12), 0);
    assert.strictEqual(levenshteinDistance(12, 34), 2);
  });
});

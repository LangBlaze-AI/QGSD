#!/usr/bin/env node
'use strict';
// bin/requirement-map.test.cjs
// Tests for bin/requirement-map.cjs — centralized check_id → requirement_ids map.
// Run with: node --test bin/requirement-map.test.cjs
// Requirements: SCHEMA-03

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getRequirementIds, CHECK_ID_TO_REQUIREMENTS } = require('./requirement-map.cjs');

// ── 1. Module shape ───────────────────────────────────────────────────────────
describe('requirement-map module shape', () => {
  it('exports getRequirementIds as a function', () => {
    assert.strictEqual(typeof getRequirementIds, 'function');
  });

  it('exports CHECK_ID_TO_REQUIREMENTS as an object', () => {
    assert.strictEqual(typeof CHECK_ID_TO_REQUIREMENTS, 'object');
    assert.notStrictEqual(CHECK_ID_TO_REQUIREMENTS, null);
  });

  it('has at least 20 entries in CHECK_ID_TO_REQUIREMENTS', () => {
    const count = Object.keys(CHECK_ID_TO_REQUIREMENTS).length;
    assert.ok(count >= 20, 'Expected at least 20 entries, got ' + count);
  });

  it('every value in CHECK_ID_TO_REQUIREMENTS is an array of strings', () => {
    for (const [key, val] of Object.entries(CHECK_ID_TO_REQUIREMENTS)) {
      assert.ok(Array.isArray(val), key + ' should map to an array');
      for (const item of val) {
        assert.strictEqual(typeof item, 'string', key + ' array should contain strings');
      }
    }
  });
});

// ── 2. Fail-open for unknown check_ids ────────────────────────────────────────
describe('getRequirementIds — fail-open', () => {
  it('returns [] for completely unknown check_id', () => {
    const result = getRequirementIds('unknown:check-id');
    assert.deepStrictEqual(result, []);
  });

  it('returns [] for empty string', () => {
    const result = getRequirementIds('');
    assert.deepStrictEqual(result, []);
  });

  it('returns [] for null-like input (undefined)', () => {
    const result = getRequirementIds(undefined);
    assert.deepStrictEqual(result, []);
  });

  it('returns [] for tla:nonexistent', () => {
    const result = getRequirementIds('tla:nonexistent');
    assert.deepStrictEqual(result, []);
  });
});

// ── 2b. Fail-open for inherited Object.prototype key names ────────────────────
describe('getRequirementIds — inherited prototype keys (fail-open)', () => {
  it('returns [] for inherited Object.prototype key names instead of throwing', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      let result;
      assert.doesNotThrow(() => { result = getRequirementIds(key); }, key + ' should not throw');
      assert.deepStrictEqual(result, [], key + ' should fail open to []');
    }
  });
});

// ── 3. TLA+ runner check_ids ─────────────────────────────────────────────────
describe('getRequirementIds — TLA+ runners', () => {
  it('tla:quorum-safety returns core quorum requirements', () => {
    const ids = getRequirementIds('tla:quorum-safety');
    assert.ok(ids.length > 0, 'should return non-empty array');
    assert.ok(ids.includes('QUORUM-01'), 'should include QUORUM-01');
    assert.ok(ids.includes('SAFE-01'),   'should include SAFE-01');
  });

  it('tla:quorum-liveness returns liveness requirements', () => {
    const ids = getRequirementIds('tla:quorum-liveness');
    assert.ok(ids.length > 0);
    assert.ok(ids.includes('QUORUM-04'), 'should include QUORUM-04');
  });

  it('tla:breaker returns oscillation detection requirements', () => {
    const ids = getRequirementIds('tla:breaker');
    assert.ok(ids.includes('DETECT-01'), 'should include DETECT-01');
    assert.ok(ids.includes('DETECT-02'));
    assert.ok(ids.includes('DETECT-03'));
  });

  it('tla:stop-hook returns stop hook requirements', () => {
    const ids = getRequirementIds('tla:stop-hook');
    assert.ok(ids.includes('STOP-01'), 'should include STOP-01');
    assert.ok(ids.includes('SPEC-01'), 'should include SPEC-01');
    assert.ok(ids.length >= 8, 'should have at least 8 stop-hook requirements');
  });

  it('tla:account-manager returns credential management requirements', () => {
    const ids = getRequirementIds('tla:account-manager');
    assert.ok(ids.includes('CRED-01'), 'should include CRED-01');
    assert.ok(ids.includes('CRED-06'), 'should include CRED-06');
  });
});

// ── 4. Alloy runner check_ids ─────────────────────────────────────────────────
describe('getRequirementIds — Alloy runners', () => {
  it('alloy:quorum-votes returns vote counting requirements', () => {
    const ids = getRequirementIds('alloy:quorum-votes');
    assert.ok(ids.length > 0);
    assert.ok(ids.includes('QUORUM-02'), 'should include QUORUM-02');
    assert.ok(ids.includes('SAFE-01'),   'should include SAFE-01');
  });

  it('alloy:scoreboard returns scoreboard requirements', () => {
    const ids = getRequirementIds('alloy:scoreboard');
    assert.ok(ids.includes('SCBD-01'), 'should include SCBD-01');
    assert.ok(ids.includes('SCBD-04'), 'should include SCBD-04');
  });

  it('alloy:availability returns calibration requirements', () => {
    const ids = getRequirementIds('alloy:availability');
    assert.ok(ids.includes('CALIB-01'), 'should include CALIB-01');
  });

  it('alloy:transcript returns transcript scanning requirements', () => {
    const ids = getRequirementIds('alloy:transcript');
    assert.ok(ids.includes('STOP-08'), 'should include STOP-08');
    assert.ok(ids.includes('STOP-11'), 'should include STOP-11');
  });

  it('alloy:account-pool returns pool invariant requirements', () => {
    const ids = getRequirementIds('alloy:account-pool');
    assert.ok(ids.includes('CRED-07'), 'should include CRED-07');
    assert.ok(ids.includes('CRED-11'), 'should include CRED-11');
  });
});

// ── 5. PRISM runner check_ids ────────────────────────────────────────
describe('getRequirementIds — PRISM runners', () => {
  it('prism:quorum returns probabilistic model requirements', () => {
    const ids = getRequirementIds('prism:quorum');
    assert.ok(ids.includes('PRM-01'), 'should include PRM-01');
    assert.ok(ids.includes('QUORUM-04'), 'should include QUORUM-04');
  });

  it('prism:oauth-rotation returns rotation requirements', () => {
    const ids = getRequirementIds('prism:oauth-rotation');
    assert.ok(ids.includes('CRED-01'), 'should include CRED-01');
  });

  it('prism:mcp-availability returns MCP requirements', () => {
    const ids = getRequirementIds('prism:mcp-availability');
    assert.ok(ids.includes('MCPENV-04'), 'should include MCPENV-04');
    assert.ok(ids.includes('FAIL-01'),   'should include FAIL-01');
  });

});

// ── 6. CI runner check_ids ─────────────────────────────────────────────────────
describe('getRequirementIds — CI runners', () => {
  it('ci:trace-redaction returns redaction requirement', () => {
    const ids = getRequirementIds('ci:trace-redaction');
    assert.ok(ids.includes('REDACT-01'), 'should include REDACT-01');
  });

  it('ci:trace-schema-drift returns drift requirement', () => {
    const ids = getRequirementIds('ci:trace-schema-drift');
    assert.ok(ids.includes('DRIFT-01'), 'should include DRIFT-01');
  });

  it('ci:liveness-fairness-lint returns fairness requirements', () => {
    const ids = getRequirementIds('ci:liveness-fairness-lint');
    assert.ok(ids.includes('LIVE-01'), 'should include LIVE-01');
    assert.ok(ids.includes('LIVE-02'), 'should include LIVE-02');
  });
});

// ── 7. Return type consistency ────────────────────────────────────────────────
describe('getRequirementIds — return type consistency', () => {
  it('always returns an array regardless of input', () => {
    const inputs = [
      'tla:quorum-safety', 'alloy:scoreboard', 'prism:quorum',
      'unknown:id', '', null, undefined, 42, {}, [],
    ];
    for (const input of inputs) {
      const result = getRequirementIds(input);
      assert.ok(Array.isArray(result), 'result for ' + JSON.stringify(input) + ' should be an array');
    }
  });

  it('returns new array reference on each call (no mutation risk)', () => {
    const a = getRequirementIds('tla:quorum-safety');
    const b = getRequirementIds('tla:quorum-safety');
    // They should be equal in content
    assert.deepStrictEqual(a, b);
    // Mutating one should not affect the source (arrays from || [] fallback are new)
    a.push('EXTRA-ID');
    const c = getRequirementIds('tla:quorum-safety');
    assert.ok(!c.includes('EXTRA-ID'), 'mutating return value should not affect subsequent calls');
  });
});

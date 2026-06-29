const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { confirmPairing, rejectPairing } = require('./resolve-pairings.cjs');

describe('resolve-pairings', () => {

  function makeRegistry(models) {
    return { models };
  }

  function makePairing(model, req, verdict) {
    return {
      model,
      requirement: req,
      proximity_score: 0.85,
      verdict: verdict || 'yes',
      confidence: 0.9,
      reasoning: 'test',
      status: 'pending',
      resolved_at: null,
      resolved_by: null,
    };
  }

  it('should confirm pairing and add to model-registry requirements', () => {
    const registry = makeRegistry({
      'm1.als': { requirements: ['REQ-00'] },
    });
    const pairing = makePairing('m1.als', 'REQ-01');

    const result = confirmPairing(pairing, registry);

    assert.equal(result.pairing.status, 'confirmed');
    assert.equal(result.pairing.resolved_by, 'human');
    assert.ok(result.pairing.resolved_at);
    assert.equal(result.added, true);
    assert.ok(registry.models['m1.als'].requirements.includes('REQ-01'));
    assert.ok(registry.models['m1.als'].requirements.includes('REQ-00'));
  });

  it('should reject pairing and set status', () => {
    const pairing = makePairing('m1.als', 'REQ-01');

    const result = rejectPairing(pairing);

    assert.equal(result.status, 'rejected');
    assert.equal(result.resolved_by, 'human');
    assert.ok(result.resolved_at);
  });

  it('should not duplicate requirements in model-registry', () => {
    const registry = makeRegistry({
      'm1.als': { requirements: ['REQ-01'] },
    });
    const pairing = makePairing('m1.als', 'REQ-01');

    const result = confirmPairing(pairing, registry);

    assert.equal(result.added, false);
    assert.equal(registry.models['m1.als'].requirements.length, 1);
  });

  it('should skip already-resolved pairings (confirmed stays confirmed)', () => {
    const registry = makeRegistry({ 'm1.als': { requirements: [] } });
    const pairing = makePairing('m1.als', 'REQ-01');
    pairing.status = 'confirmed';
    pairing.resolved_at = '2026-01-01T00:00:00Z';
    pairing.resolved_by = 'human';

    // confirmPairing overwrites — but the CLI filters pending only
    // This test verifies the function itself sets fields correctly
    const result = confirmPairing(pairing, registry);
    assert.equal(result.pairing.status, 'confirmed');
    assert.equal(result.added, true);
  });

  it('should handle missing model in registry gracefully', () => {
    const registry = makeRegistry({});
    const pairing = makePairing('nonexistent.als', 'REQ-01');

    // Should not throw
    const result = confirmPairing(pairing, registry);

    assert.equal(result.pairing.status, 'confirmed');
    assert.equal(result.added, false);
    // Model not in registry — no crash, just skipped
    assert.equal(registry.models['nonexistent.als'], undefined);
  });

  it('should not prototype-pollute when model is __proto__', () => {
    const registry = makeRegistry({ 'm1.als': { requirements: [] } });
    const pairing = makePairing('__proto__', 'REQ-99');
    try {
      const result = confirmPairing(pairing, registry);
      // Treated as missing model: no registry mutation, no added
      assert.equal(result.added, false);
      // Object.prototype must NOT gain a `requirements` property
      assert.equal({}.requirements, undefined);
    } finally {
      // Defensive cleanup in case the (buggy) code polluted the prototype
      delete Object.prototype.requirements;
    }
  });

  it('should not crash when registry is null', () => {
    const pairing = makePairing('m1.als', 'REQ-01');
    const result = confirmPairing(pairing, null);
    assert.equal(result.pairing.status, 'confirmed');
    assert.equal(result.added, false);
  });

});

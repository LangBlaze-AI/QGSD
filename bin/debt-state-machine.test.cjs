const { test } = require('node:test');
const assert = require('node:assert');
const { canTransition, transitionDebtEntry, ALLOWED_TRANSITIONS } = require('./debt-state-machine.cjs');

test('Task 2: Debt state machine enforcement (TDD)', async (t) => {
  // ========== VALID FORWARD TRANSITIONS ==========
  await t.test('Valid forward transition: open -> acknowledged', () => {
    assert.strictEqual(canTransition('open', 'acknowledged'), true, 'open->acknowledged should be allowed');
  });

  await t.test('Valid forward transition: acknowledged -> resolving', () => {
    assert.strictEqual(canTransition('acknowledged', 'resolving'), true, 'acknowledged->resolving should be allowed');
  });

  await t.test('Valid forward transition: resolving -> resolved', () => {
    assert.strictEqual(canTransition('resolving', 'resolved'), true, 'resolving->resolved should be allowed');
  });

  // ========== REVERT TRANSITIONS ==========
  await t.test('Revert transition allowed: acknowledged -> open', () => {
    assert.strictEqual(canTransition('acknowledged', 'open'), true, 'acknowledged->open (revert) should be allowed');
  });

  // ========== INVALID BACKWARD TRANSITIONS ==========
  await t.test('Invalid backward transition: resolved -> open', () => {
    assert.strictEqual(canTransition('resolved', 'open'), false, 'resolved->open should be rejected');
  });

  await t.test('Invalid backward transition: resolved -> acknowledged', () => {
    assert.strictEqual(canTransition('resolved', 'acknowledged'), false, 'resolved->acknowledged should be rejected');
  });

  await t.test('Invalid backward transition: resolved -> resolving', () => {
    assert.strictEqual(canTransition('resolved', 'resolving'), false, 'resolved->resolving should be rejected');
  });

  // ========== INVALID SKIP TRANSITIONS ==========
  await t.test('Invalid skip transition: open -> resolving', () => {
    assert.strictEqual(canTransition('open', 'resolving'), false, 'open->resolving should be rejected');
  });

  await t.test('Invalid skip transition: open -> resolved', () => {
    assert.strictEqual(canTransition('open', 'resolved'), false, 'open->resolved should be rejected');
  });

  await t.test('Invalid skip transition: acknowledged -> resolved', () => {
    assert.strictEqual(canTransition('acknowledged', 'resolved'), false, 'acknowledged->resolved should be rejected');
  });

  // ========== NO-OP TRANSITIONS ==========
  await t.test('No-op transition rejected: open -> open', () => {
    assert.strictEqual(canTransition('open', 'open'), false, 'open->open (no-op) should be rejected');
  });

  await t.test('No-op transition rejected: acknowledged -> acknowledged', () => {
    assert.strictEqual(canTransition('acknowledged', 'acknowledged'), false, 'acknowledged->acknowledged (no-op) should be rejected');
  });

  await t.test('No-op transition rejected: resolving -> resolving', () => {
    assert.strictEqual(canTransition('resolving', 'resolving'), false, 'resolving->resolving (no-op) should be rejected');
  });

  await t.test('No-op transition rejected: resolved -> resolved', () => {
    assert.strictEqual(canTransition('resolved', 'resolved'), false, 'resolved->resolved (no-op) should be rejected');
  });

  // ========== TERMINAL STATE ==========
  await t.test('Terminal state: resolved has no outbound transitions', () => {
    assert.deepStrictEqual(ALLOWED_TRANSITIONS['resolved'], [], 'resolved state should have empty transition list');
  });

  // ========== TRANSITION RESULT STRUCTURE ==========
  await t.test('transitionDebtEntry returns success structure on valid transition', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T10:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'open',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };

    const result = transitionDebtEntry(entry, 'acknowledged');
    assert.strictEqual(result.success, true, 'Valid transition should have success: true');
    assert.ok(result.entry, 'Valid transition should return updated entry');
    assert.strictEqual(result.entry.status, 'acknowledged', 'Updated entry should have new status');
  });

  await t.test('transitionDebtEntry returns error structure on invalid transition', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T10:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'resolved',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };

    const result = transitionDebtEntry(entry, 'open');
    assert.strictEqual(result.success, false, 'Invalid transition should have success: false');
    assert.ok(result.error, 'Invalid transition should have error message');
  });

  // ========== INVALID TARGET STATUS ==========
  await t.test('Invalid target status rejected', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T10:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'open',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };

    const result = transitionDebtEntry(entry, 'invalid');
    assert.strictEqual(result.success, false, 'Invalid target status should return success: false');
    assert.ok(result.error, 'Should have error message');
  });

  // ========== RESOLVED_AT TIMESTAMP ==========
  await t.test('resolved_at timestamp added when transitioning to resolved', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T10:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'resolving',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };

    const before = Date.now();
    const result = transitionDebtEntry(entry, 'resolved');
    const after = Date.now();

    assert.strictEqual(result.success, true, 'Transition to resolved should succeed');
    assert.ok(result.entry.resolved_at, 'Updated entry should have resolved_at timestamp');

    const resolvedTime = new Date(result.entry.resolved_at).getTime();
    assert.ok(resolvedTime >= before && resolvedTime <= after, 'resolved_at should be current time');
  });

  await t.test('resolved_at NOT added when transitioning to non-terminal states', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T10:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'open',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };

    const result = transitionDebtEntry(entry, 'acknowledged');
    assert.strictEqual(result.success, true, 'Transition should succeed');
    assert.strictEqual(result.entry.resolved_at, undefined, 'resolved_at should NOT be added for non-terminal states');
  });

  // ========== STATE MATRIX COVERAGE ==========
  // Test all 16 state pairs (4x4)
  const states = ['open', 'acknowledged', 'resolving', 'resolved'];
  const expectedValid = {
    'open': { 'acknowledged': true },
    'acknowledged': { 'open': true, 'resolving': true },
    'resolving': { 'resolved': true },
    'resolved': {}
  };

  for (const fromState of states) {
    for (const toState of states) {
      if (fromState === toState) continue;

      const isValid = (expectedValid[fromState] && expectedValid[fromState][toState]) || false;
      await t.test(`State matrix: ${fromState} -> ${toState} (${isValid ? 'valid' : 'invalid'})`, () => {
        const result = canTransition(fromState, toState);
        assert.strictEqual(result, isValid, `${fromState}->${toState} should be ${isValid ? 'allowed' : 'rejected'}`);
      });
    }
  }

  // ========== ALLOWED_TRANSITIONS CONSTANT ==========
  await t.test('ALLOWED_TRANSITIONS constant is properly defined', () => {
    assert.ok(ALLOWED_TRANSITIONS, 'ALLOWED_TRANSITIONS should be defined');
    assert.ok(typeof ALLOWED_TRANSITIONS === 'object', 'ALLOWED_TRANSITIONS should be object');
    assert.ok(Array.isArray(ALLOWED_TRANSITIONS['open']), 'Each state should have an array of targets');
  });
});

// ========== DSM-1: non-object entry fails closed (no throw) ==========
test('transitionDebtEntry fails closed on non-object entry (no throw)', () => {
  for (const bad of [null, undefined, 'open', 42, true]) {
    let result;
    assert.doesNotThrow(() => { result = transitionDebtEntry(bad, 'acknowledged'); },
      `entry=${String(bad)} should not throw`);
    assert.strictEqual(result.success, false, `entry=${String(bad)} should return success:false`);
    assert.ok(result.error, `entry=${String(bad)} should return an error message`);
  }
});

// ========== DSM-2: prototype-chain keys as fromStatus are no-op ==========
test('canTransition treats prototype-chain keys as no-op, never throws', () => {
  for (const key of ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString']) {
    let result;
    assert.doesNotThrow(() => { result = canTransition(key, 'open'); },
      `fromStatus=${key} should not throw`);
    assert.strictEqual(result, false, `fromStatus=${key} should be rejected (no own transitions)`);
  }
});

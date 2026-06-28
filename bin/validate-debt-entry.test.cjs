const { test } = require('node:test');
const assert = require('node:assert');
const { validateDebtEntry, validateDebtLedger } = require('./validate-debt-entry.cjs');

test('Task 1: Debt schema validation (TDD)', async (t) => {
  // ========== VALID ENTRY TESTS ==========
  await t.test('Valid entry passes validation (all required fields present, correct types)', () => {
    const validEntry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Sample error in production',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'open',
      formal_ref: null,
      source_entries: [
        {
          source_type: 'github',
          source_id: 'gh-123',
          observed_at: '2026-03-04T12:00:00Z'
        }
      ]
    };
    const result = validateDebtEntry(validEntry);
    assert.strictEqual(result, true, 'Valid entry should pass validation');
  });

  await t.test('Valid entry with formal_ref string accepted', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test error',
      occurrences: 5,
      first_seen: '2026-03-04T10:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['staging', 'production'],
      status: 'acknowledged',
      formal_ref: 'MCsafety.cfg:MaxDeliberation',
      source_entries: [
        {
          source_type: 'sentry',
          source_id: 'sentry-abc',
          observed_at: '2026-03-04T11:00:00Z'
        }
      ]
    };
    const result = validateDebtEntry(entry);
    assert.strictEqual(result, true, 'Entry with formal_ref string should pass');
  });

  await t.test('Valid entry with multiple environments accepted', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'def456ghi789abc1234567',
      title: 'Multi-env issue',
      occurrences: 2,
      first_seen: '2026-03-04T08:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production', 'staging', 'development'],
      status: 'open',
      formal_ref: null,
      source_entries: [
        {
          source_type: 'prometheus',
          source_id: 'prom-001',
          observed_at: '2026-03-04T08:30:00Z'
        }
      ]
    };
    const result = validateDebtEntry(entry);
    assert.strictEqual(result, true, 'Entry with multiple environments should pass');
  });

  await t.test('Valid entry with multiple source_entries accepted', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'xyz789def123456789abcd',
      title: 'Cross-source issue',
      occurrences: 3,
      first_seen: '2026-03-04T06:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'resolving',
      formal_ref: null,
      source_entries: [
        {
          source_type: 'github',
          source_id: 'gh-456',
          observed_at: '2026-03-04T06:30:00Z'
        },
        {
          source_type: 'sentry-feedback',
          source_id: 'sf-789',
          observed_at: '2026-03-04T10:00:00Z'
        }
      ]
    };
    const result = validateDebtEntry(entry);
    assert.strictEqual(result, true, 'Entry with multiple source_entries should pass');
  });

  // ========== MISSING REQUIRED FIELDS ==========
  await t.test('Missing id rejected', () => {
    const entry = {
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'open',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };
    const result = validateDebtEntry(entry);
    assert.ok(Array.isArray(result), 'Missing id should return error array');
    assert.ok(result.some(e => e.includes('id')), 'Error should mention id');
  });

  await t.test('Missing fingerprint rejected', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'open',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };
    const result = validateDebtEntry(entry);
    assert.ok(Array.isArray(result), 'Missing fingerprint should return error array');
    assert.ok(result.some(e => e.includes('fingerprint')), 'Error should mention fingerprint');
  });

  await t.test('Missing title rejected', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'open',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };
    const result = validateDebtEntry(entry);
    assert.ok(Array.isArray(result), 'Missing title should return error array');
    assert.ok(result.some(e => e.includes('title')), 'Error should mention title');
  });

  await t.test('Missing occurrences rejected', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'open',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };
    const result = validateDebtEntry(entry);
    assert.ok(Array.isArray(result), 'Missing occurrences should return error array');
    assert.ok(result.some(e => e.includes('occurrences')), 'Error should mention occurrences');
  });

  await t.test('Missing first_seen rejected', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'open',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };
    const result = validateDebtEntry(entry);
    assert.ok(Array.isArray(result), 'Missing first_seen should return error array');
    assert.ok(result.some(e => e.includes('first_seen')), 'Error should mention first_seen');
  });

  await t.test('Missing last_seen rejected', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'open',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };
    const result = validateDebtEntry(entry);
    assert.ok(Array.isArray(result), 'Missing last_seen should return error array');
    assert.ok(result.some(e => e.includes('last_seen')), 'Error should mention last_seen');
  });

  await t.test('Missing environments rejected', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      status: 'open',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };
    const result = validateDebtEntry(entry);
    assert.ok(Array.isArray(result), 'Missing environments should return error array');
    assert.ok(result.some(e => e.includes('environments')), 'Error should mention environments');
  });

  await t.test('Missing status rejected', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };
    const result = validateDebtEntry(entry);
    assert.ok(Array.isArray(result), 'Missing status should return error array');
    assert.ok(result.some(e => e.includes('status')), 'Error should mention status');
  });

  await t.test('Missing source_entries rejected', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'open'
    };
    const result = validateDebtEntry(entry);
    assert.ok(Array.isArray(result), 'Missing source_entries should return error array');
    assert.ok(result.some(e => e.includes('source_entries')), 'Error should mention source_entries');
  });

  // ========== ENUM VALIDATION ==========
  await t.test('Invalid status enum rejected (invalid value)', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'invalid',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };
    const result = validateDebtEntry(entry);
    assert.ok(Array.isArray(result), 'Invalid status should return error array');
    assert.ok(result.some(e => e.includes('status')), 'Error should mention status');
  });

  await t.test('Invalid status enum rejected (closed)', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'closed',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };
    const result = validateDebtEntry(entry);
    assert.ok(Array.isArray(result), 'Status "closed" should return error array');
    assert.ok(result.some(e => e.includes('status')), 'Error should mention status');
  });

  await t.test('Valid status values accepted', () => {
    const statuses = ['open', 'acknowledged', 'resolving', 'resolved'];
    for (const status of statuses) {
      const entry = {
        id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        fingerprint: 'abc123def456789012345',
        title: 'Test',
        occurrences: 1,
        first_seen: '2026-03-04T12:00:00Z',
        last_seen: '2026-03-04T12:00:00Z',
        environments: ['production'],
        status,
        source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
      };
      const result = validateDebtEntry(entry);
      assert.strictEqual(result, true, `Status "${status}" should be valid`);
    }
  });

  // ========== TIMESTAMP VALIDATION ==========
  await t.test('Invalid timestamp format rejected (non-ISO8601)', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: 'invalid-date',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'open',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };
    const result = validateDebtEntry(entry);
    assert.ok(Array.isArray(result), 'Invalid timestamp should return error array');
    assert.ok(result.some(e => e.includes('first_seen')), 'Error should mention first_seen');
  });

  await t.test('Valid ISO8601 timestamps accepted', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'open',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };
    const result = validateDebtEntry(entry);
    assert.strictEqual(result, true, 'Valid ISO8601 timestamps should pass');
  });

  // ========== ARRAY VALIDATION ==========
  await t.test('Empty environments array rejected', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: [],
      status: 'open',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };
    const result = validateDebtEntry(entry);
    assert.ok(Array.isArray(result), 'Empty environments array should return error array');
    assert.ok(result.some(e => e.includes('environments')), 'Error should mention environments');
  });

  await t.test('Empty source_entries array rejected', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'open',
      source_entries: []
    };
    const result = validateDebtEntry(entry);
    assert.ok(Array.isArray(result), 'Empty source_entries array should return error array');
    assert.ok(result.some(e => e.includes('source_entries')), 'Error should mention source_entries');
  });

  await t.test('Invalid environment value rejected', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['prod'],
      status: 'open',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };
    const result = validateDebtEntry(entry);
    assert.ok(Array.isArray(result), 'Invalid environment should return error array');
    assert.ok(result.some(e => e.includes('environment')), 'Error should mention environment');
  });

  await t.test('Valid environment values accepted', () => {
    const envs = ['production', 'staging', 'development', 'test', 'local'];
    for (const env of envs) {
      const entry = {
        id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        fingerprint: 'abc123def456789012345',
        title: 'Test',
        occurrences: 1,
        first_seen: '2026-03-04T12:00:00Z',
        last_seen: '2026-03-04T12:00:00Z',
        environments: [env],
        status: 'open',
        source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
      };
      const result = validateDebtEntry(entry);
      assert.strictEqual(result, true, `Environment "${env}" should be valid`);
    }
  });

  // ========== TIMESTAMP ORDERING ==========
  await t.test('last_seen < first_seen rejected', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T10:00:00Z',
      environments: ['production'],
      status: 'open',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };
    const result = validateDebtEntry(entry);
    assert.ok(Array.isArray(result), 'last_seen < first_seen should return error array');
    assert.ok(result.some(e => e.includes('last_seen')), 'Error should mention last_seen ordering');
  });

  await t.test('last_seen == first_seen accepted', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'open',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };
    const result = validateDebtEntry(entry);
    assert.strictEqual(result, true, 'last_seen == first_seen should be valid');
  });

  await t.test('last_seen > first_seen accepted', () => {
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
    const result = validateDebtEntry(entry);
    assert.strictEqual(result, true, 'last_seen > first_seen should be valid');
  });

  // ========== FORMAL_REF VALIDATION ==========
  await t.test('Valid formal_ref (string) accepted', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'open',
      formal_ref: 'MCsafety.cfg:MaxDeliberation',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };
    const result = validateDebtEntry(entry);
    assert.strictEqual(result, true, 'String formal_ref should be valid');
  });

  await t.test('Valid formal_ref (null) accepted', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'open',
      formal_ref: null,
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
    };
    const result = validateDebtEntry(entry);
    assert.strictEqual(result, true, 'Null formal_ref should be valid');
  });

  // ========== SOURCE_ENTRIES VALIDATION ==========
  await t.test('Valid source_type values accepted', () => {
    const sourceTypes = ['github', 'sentry', 'sentry-feedback', 'prometheus', 'grafana', 'logstash', 'bash'];
    for (const sourceType of sourceTypes) {
      const entry = {
        id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        fingerprint: 'abc123def456789012345',
        title: 'Test',
        occurrences: 1,
        first_seen: '2026-03-04T12:00:00Z',
        last_seen: '2026-03-04T12:00:00Z',
        environments: ['production'],
        status: 'open',
        source_entries: [{ source_type: sourceType, source_id: 'id-1', observed_at: '2026-03-04T12:00:00Z' }]
      };
      const result = validateDebtEntry(entry);
      assert.strictEqual(result, true, `source_type "${sourceType}" should be valid`);
    }
  });

  await t.test('Invalid source_type rejected', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'open',
      source_entries: [{ source_type: 'invalid', source_id: 'id-1', observed_at: '2026-03-04T12:00:00Z' }]
    };
    const result = validateDebtEntry(entry);
    assert.ok(Array.isArray(result), 'Invalid source_type should return error array');
  });

  await t.test('Missing source_entry fields rejected', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'open',
      source_entries: [{ source_type: 'github' }]
    };
    const result = validateDebtEntry(entry);
    assert.ok(Array.isArray(result), 'Missing source_entry fields should return error array');
  });

  // ========== ADDITIONAL PROPERTIES ==========
  await t.test('Additional properties rejected (additionalProperties: false)', () => {
    const entry = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'open',
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }],
      extraField: 'should-be-rejected'
    };
    const result = validateDebtEntry(entry);
    assert.ok(Array.isArray(result), 'Additional properties should return error array');
  });

  // ========== LEDGER VALIDATION ==========
  await t.test('Ledger validation: schema_version must be "1"', () => {
    const ledger = {
      schema_version: '2',
      debt_entries: []
    };
    const result = validateDebtLedger(ledger);
    assert.ok(Array.isArray(result), 'Invalid schema_version should return error array');
    assert.ok(result.some(e => e.includes('schema_version')), 'Error should mention schema_version');
  });

  await t.test('Ledger validation: debt_entries must be array', () => {
    const ledger = {
      schema_version: '1',
      debt_entries: 'not-an-array'
    };
    const result = validateDebtLedger(ledger);
    assert.ok(Array.isArray(result), 'Invalid debt_entries type should return error array');
  });

  await t.test('Ledger validation: chains to entry validation', () => {
    const ledger = {
      schema_version: '1',
      debt_entries: [
        {
          id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          fingerprint: 'abc123def456789012345',
          title: 'Valid entry',
          occurrences: 1,
          first_seen: '2026-03-04T12:00:00Z',
          last_seen: '2026-03-04T12:00:00Z',
          environments: ['production'],
          status: 'open',
          source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
        },
        {
          id: 'invalid-entry',
          fingerprint: 'abc123def456789012345',
          title: 'Invalid entry',
          occurrences: 1,
          first_seen: '2026-03-04T12:00:00Z',
          last_seen: '2026-03-04T12:00:00Z',
          environments: ['production'],
          status: 'open',
          source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
        }
      ]
    };
    const result = validateDebtLedger(ledger);
    assert.ok(Array.isArray(result), 'Invalid entry in ledger should return error array');
    assert.ok(result.some(e => e.includes('debt_entries[1]')), 'Error should reference entry index');
  });

  await t.test('Valid ledger passes validation', () => {
    const ledger = {
      schema_version: '1',
      created_at: '2026-03-04T12:00:00Z',
      last_updated: '2026-03-04T12:00:00Z',
      debt_entries: [
        {
          id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          fingerprint: 'abc123def456789012345',
          title: 'Test',
          occurrences: 1,
          first_seen: '2026-03-04T12:00:00Z',
          last_seen: '2026-03-04T12:00:00Z',
          environments: ['production'],
          status: 'open',
          source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
        }
      ]
    };
    const result = validateDebtLedger(ledger);
    assert.strictEqual(result, true, 'Valid ledger should pass validation');
  });
});

// ── v0.27-03 formal_ref_source tests ──────────────────────────────────────

test('v0.27-03: formal_ref_source validation', async (t) => {
  function makeEntry(overrides = {}) {
    return {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      fingerprint: 'abc123def456789012345',
      title: 'Test entry',
      occurrences: 1,
      first_seen: '2026-03-04T12:00:00Z',
      last_seen: '2026-03-04T12:00:00Z',
      environments: ['production'],
      status: 'open',
      formal_ref: null,
      source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }],
      ...overrides
    };
  }

  await t.test('accepts formal_ref_source: "manual"', () => {
    const result = validateDebtEntry(makeEntry({ formal_ref_source: 'manual' }));
    assert.strictEqual(result, true);
  });

  await t.test('accepts formal_ref_source: "auto-detect"', () => {
    const result = validateDebtEntry(makeEntry({ formal_ref_source: 'auto-detect' }));
    assert.strictEqual(result, true);
  });

  await t.test('accepts formal_ref_source: "spec-inferred"', () => {
    const result = validateDebtEntry(makeEntry({ formal_ref_source: 'spec-inferred' }));
    assert.strictEqual(result, true);
  });

  await t.test('accepts formal_ref_source: null', () => {
    const result = validateDebtEntry(makeEntry({ formal_ref_source: null }));
    assert.strictEqual(result, true);
  });

  await t.test('accepts entry without formal_ref_source (backward compatible)', () => {
    const entry = makeEntry();
    delete entry.formal_ref_source;
    const result = validateDebtEntry(entry);
    assert.strictEqual(result, true);
  });

  await t.test('rejects invalid formal_ref_source value', () => {
    const result = validateDebtEntry(makeEntry({ formal_ref_source: 'invalid' }));
    assert.notStrictEqual(result, true);
    assert.ok(result.some(e => e.includes('formal_ref_source')));
  });

  await t.test('rejects formal_ref_source as number', () => {
    const result = validateDebtEntry(makeEntry({ formal_ref_source: 42 }));
    assert.notStrictEqual(result, true);
    assert.ok(result.some(e => e.includes('formal_ref_source')));
  });

  await t.test('allows formal_ref_source: "manual" with formal_ref: null', () => {
    const result = validateDebtEntry(makeEntry({ formal_ref_source: 'manual', formal_ref: null }));
    assert.strictEqual(result, true);
  });
});

// ── VDE-1: prototype-pollution / null-proto hardening ──────────────────────

test('VDE adversarial: own hasOwnProperty key and null-proto entry do not crash', async (t) => {
  const base = {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    fingerprint: 'abc123def456789012345',
    title: 'Test',
    occurrences: 1,
    first_seen: '2026-03-04T12:00:00Z',
    last_seen: '2026-03-04T12:00:00Z',
    environments: ['production'],
    status: 'open',
    source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
  };

  await t.test('own hasOwnProperty string property does not throw', () => {
    const entry = { ...base, formal_ref: 'r', hasOwnProperty: 'x' };
    let result;
    assert.doesNotThrow(() => { result = validateDebtEntry(entry); }, 'must not throw on shadowed hasOwnProperty');
    assert.ok(Array.isArray(result), 'poisoned entry should return an error array');
    assert.ok(result.some(e => e.includes('hasOwnProperty')), 'extra hasOwnProperty key should be reported');
  });

  await t.test('null-prototype entry does not throw', () => {
    const entry = Object.assign(Object.create(null), base, { formal_ref: 'r' });
    let result;
    assert.doesNotThrow(() => { result = validateDebtEntry(entry); }, 'must not throw on null-proto object');
    assert.strictEqual(result, true, 'an otherwise-valid null-proto entry should validate');
  });

  await t.test('ledger with a hasOwnProperty-poisoned entry does not throw', () => {
    const ledger = { schema_version: '1', debt_entries: [{ ...base, formal_ref: 'r', hasOwnProperty: 'x' }] };
    let result;
    assert.doesNotThrow(() => { result = validateDebtLedger(ledger); }, 'ledger validation must not throw');
    assert.ok(Array.isArray(result), 'poisoned entry should surface as ledger error');
  });
});

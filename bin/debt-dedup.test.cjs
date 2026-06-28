const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deduplicateEntries, mergeDebtEntries } = require('./debt-dedup.cjs');

// Helper: create a minimal valid debt entry
function makeEntry(overrides = {}) {
  return {
    id: overrides.id || 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    fingerprint: overrides.fingerprint || 'abc123def4567890',
    title: overrides.title || 'Test entry',
    occurrences: overrides.occurrences || 1,
    first_seen: overrides.first_seen || '2026-03-01T12:00:00Z',
    last_seen: overrides.last_seen || '2026-03-04T12:00:00Z',
    environments: overrides.environments || ['production'],
    status: overrides.status || 'open',
    formal_ref: overrides.formal_ref !== undefined ? overrides.formal_ref : null,
    formal_ref_source: overrides.formal_ref_source !== undefined ? overrides.formal_ref_source : null,
    source_entries: overrides.source_entries || [
      { source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }
    ],
    ...(overrides.resolved_at ? { resolved_at: overrides.resolved_at } : {})
  };
}

// ── mergeDebtEntries tests ──────────────────────────────────────────

test('mergeDebtEntries', async (t) => {
  await t.test('primary (occurrences: 5) + secondary (occurrences: 3): result has occurrences: 8', () => {
    const a = makeEntry({ occurrences: 5 });
    const b = makeEntry({ occurrences: 3, id: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    const merged = mergeDebtEntries(a, b);
    assert.strictEqual(merged.occurrences, 8);
  });

  await t.test('source_entries from both are concatenated', () => {
    const a = makeEntry({ source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-01T12:00:00Z' }] });
    const b = makeEntry({ source_entries: [{ source_type: 'sentry', source_id: 'sn-1', observed_at: '2026-03-02T12:00:00Z' }], id: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    const merged = mergeDebtEntries(a, b);
    assert.strictEqual(merged.source_entries.length, 2);
    assert.ok(merged.source_entries.some(se => se.source_type === 'github'));
    assert.ok(merged.source_entries.some(se => se.source_type === 'sentry'));
  });

  await t.test('first_seen = min of both', () => {
    const a = makeEntry({ first_seen: '2026-03-03T12:00:00Z' });
    const b = makeEntry({ first_seen: '2026-03-01T12:00:00Z', id: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    const merged = mergeDebtEntries(a, b);
    assert.strictEqual(merged.first_seen, '2026-03-01T12:00:00Z');
  });

  await t.test('last_seen = max of both', () => {
    const a = makeEntry({ last_seen: '2026-03-01T12:00:00Z' });
    const b = makeEntry({ last_seen: '2026-03-04T12:00:00Z', id: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    const merged = mergeDebtEntries(a, b);
    assert.strictEqual(merged.last_seen, '2026-03-04T12:00:00Z');
  });

  await t.test('environments = union (deduplicated)', () => {
    const a = makeEntry({ environments: ['production', 'staging'] });
    const b = makeEntry({ environments: ['staging', 'development'], id: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    const merged = mergeDebtEntries(a, b);
    assert.deepStrictEqual(merged.environments.sort(), ['development', 'production', 'staging']);
  });

  await t.test('primary title preserved', () => {
    const a = makeEntry({ occurrences: 5, title: 'Primary title' });
    const b = makeEntry({ occurrences: 3, title: 'Secondary title', id: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    const merged = mergeDebtEntries(a, b);
    assert.strictEqual(merged.title, 'Primary title');
  });

  await t.test('primary id preserved', () => {
    const a = makeEntry({ occurrences: 5, id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
    const b = makeEntry({ occurrences: 3, id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
    const merged = mergeDebtEntries(a, b);
    assert.strictEqual(merged.id, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });

  await t.test('primary fingerprint preserved', () => {
    const a = makeEntry({ occurrences: 5, fingerprint: 'aaaa1234aaaa5678' });
    const b = makeEntry({ occurrences: 3, fingerprint: 'bbbb1234bbbb5678', id: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    const merged = mergeDebtEntries(a, b);
    assert.strictEqual(merged.fingerprint, 'aaaa1234aaaa5678');
  });

  await t.test('formal_ref: non-null preserved; if both non-null, primary wins', () => {
    const a = makeEntry({ occurrences: 5, formal_ref: 'requirement:DEBT-01' });
    const b = makeEntry({ occurrences: 3, formal_ref: 'requirement:DEBT-02', id: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    const merged = mergeDebtEntries(a, b);
    assert.strictEqual(merged.formal_ref, 'requirement:DEBT-01');

    // When primary is null, secondary wins
    const c = makeEntry({ occurrences: 5, formal_ref: null });
    const d = makeEntry({ occurrences: 3, formal_ref: 'requirement:FP-01', id: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    const merged2 = mergeDebtEntries(c, d);
    assert.strictEqual(merged2.formal_ref, 'requirement:FP-01');
  });

  await t.test('formal_ref_source: non-null preserved; if both non-null, primary wins', () => {
    const a = makeEntry({ occurrences: 5, formal_ref_source: 'manual' });
    const b = makeEntry({ occurrences: 3, formal_ref_source: 'auto-detect', id: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    const merged = mergeDebtEntries(a, b);
    assert.strictEqual(merged.formal_ref_source, 'manual');

    const c = makeEntry({ occurrences: 5, formal_ref_source: null });
    const d = makeEntry({ occurrences: 3, formal_ref_source: 'spec-inferred', id: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    const merged2 = mergeDebtEntries(c, d);
    assert.strictEqual(merged2.formal_ref_source, 'spec-inferred');
  });

  await t.test('status merge: acknowledged + open = acknowledged (more advanced wins)', () => {
    const a = makeEntry({ status: 'acknowledged' });
    const b = makeEntry({ status: 'open', id: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    const merged = mergeDebtEntries(a, b);
    assert.strictEqual(merged.status, 'acknowledged');
  });

  await t.test('status merge: resolving + acknowledged = resolving', () => {
    const a = makeEntry({ status: 'resolving' });
    const b = makeEntry({ status: 'acknowledged', id: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    const merged = mergeDebtEntries(a, b);
    assert.strictEqual(merged.status, 'resolving');
  });

  await t.test('when secondary has higher occurrences, secondary becomes primary (swap)', () => {
    const a = makeEntry({ occurrences: 2, title: 'A title', id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
    const b = makeEntry({ occurrences: 5, title: 'B title', id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
    const merged = mergeDebtEntries(a, b);
    // b has higher occurrences, so b becomes primary
    assert.strictEqual(merged.title, 'B title');
    assert.strictEqual(merged.id, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    assert.strictEqual(merged.occurrences, 7);
  });

  await t.test('resolved_at: keep non-null if either has it', () => {
    const a = makeEntry({ resolved_at: '2026-03-04T18:00:00Z' });
    const b = makeEntry({ id: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    const merged = mergeDebtEntries(a, b);
    assert.strictEqual(merged.resolved_at, '2026-03-04T18:00:00Z');
  });
});

// ── deduplicateEntries tests ──────────────────────────────────────────

test('deduplicateEntries', async (t) => {
  await t.test('two entries with same fingerprint merge into one', () => {
    const entries = [
      makeEntry({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', fingerprint: 'samefingerprint1' }),
      makeEntry({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', fingerprint: 'samefingerprint1' })
    ];
    const result = deduplicateEntries(entries);
    assert.strictEqual(result.entries.length, 1);
    assert.strictEqual(result.mergeCount, 1);
  });

  await t.test('three entries with same fingerprint merge into one, all source_entries preserved', () => {
    const entries = [
      makeEntry({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', fingerprint: 'samefingerprint1', source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-01T12:00:00Z' }] }),
      makeEntry({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', fingerprint: 'samefingerprint1', source_entries: [{ source_type: 'sentry', source_id: 'sn-1', observed_at: '2026-03-02T12:00:00Z' }] }),
      makeEntry({ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', fingerprint: 'samefingerprint1', source_entries: [{ source_type: 'bash', source_id: 'bs-1', observed_at: '2026-03-03T12:00:00Z' }] })
    ];
    const result = deduplicateEntries(entries);
    assert.strictEqual(result.entries.length, 1);
    assert.strictEqual(result.entries[0].source_entries.length, 3);
    assert.strictEqual(result.mergeCount, 2);
  });

  await t.test('two entries with different fingerprints but similar titles (>= 0.85) merge', () => {
    const entries = [
      makeEntry({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', fingerprint: 'fingerprint00001', title: 'TypeError in authentication handler module' }),
      makeEntry({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', fingerprint: 'fingerprint00002', title: 'TypeError in authentication handler service' })
    ];
    const result = deduplicateEntries(entries);
    assert.strictEqual(result.entries.length, 1);
    assert.strictEqual(result.mergeCount, 1);
    assert.strictEqual(result.mergeLog[0].merge_type, 'levenshtein');
  });

  await t.test('two entries with different fingerprints and different titles do NOT merge', () => {
    const entries = [
      makeEntry({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', fingerprint: 'fingerprint00001', title: 'TypeError in auth handler' }),
      makeEntry({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', fingerprint: 'fingerprint00002', title: 'SyntaxError in config parser' })
    ];
    const result = deduplicateEntries(entries);
    assert.strictEqual(result.entries.length, 2);
    assert.strictEqual(result.mergeCount, 0);
  });

  await t.test('mixed: some fingerprint matches + some Levenshtein matches', () => {
    const entries = [
      makeEntry({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', fingerprint: 'samefingerprint1', title: 'Error A' }),
      makeEntry({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', fingerprint: 'samefingerprint1', title: 'Error A also' }),
      makeEntry({ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', fingerprint: 'uniquefingerpr01', title: 'TypeError in authentication handler module' }),
      makeEntry({ id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', fingerprint: 'uniquefingerpr02', title: 'TypeError in authentication handler service' }),
      makeEntry({ id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', fingerprint: 'uniquefingerpr03', title: 'Completely different error' })
    ];
    const result = deduplicateEntries(entries);
    // a+b merge by fingerprint, c+d merge by levenshtein, e stays
    assert.strictEqual(result.entries.length, 3);
    assert.strictEqual(result.mergeCount, 2);
  });

  await t.test('custom threshold: options.threshold = 0.90 changes merge behavior', () => {
    // These titles have similarity ~0.88 (above 0.85, below 0.90)
    const entries = [
      makeEntry({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', fingerprint: 'fingerprint00001', title: 'TypeError in authentication handler module' }),
      makeEntry({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', fingerprint: 'fingerprint00002', title: 'TypeError in authentication handler service' })
    ];
    const result = deduplicateEntries(entries, { threshold: 0.95 });
    // Should NOT merge at 0.95 threshold
    assert.strictEqual(result.entries.length, 2);
    assert.strictEqual(result.mergeCount, 0);
  });

  await t.test('fingerprint exact-match runs first, Levenshtein only on remaining', () => {
    const entries = [
      makeEntry({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', fingerprint: 'samefingerprint1', title: 'Error alpha version one' }),
      makeEntry({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', fingerprint: 'samefingerprint1', title: 'Error alpha version two' })
    ];
    const result = deduplicateEntries(entries);
    // Should merge by fingerprint, not levenshtein
    assert.strictEqual(result.mergeCount, 1);
    assert.strictEqual(result.mergeLog[0].merge_type, 'fingerprint');
  });

  await t.test('empty entries array returns empty', () => {
    const result = deduplicateEntries([]);
    assert.strictEqual(result.entries.length, 0);
    assert.strictEqual(result.mergeCount, 0);
    assert.strictEqual(result.mergeLog.length, 0);
  });

  await t.test('single entry returns unchanged', () => {
    const entries = [makeEntry()];
    const result = deduplicateEntries(entries);
    assert.strictEqual(result.entries.length, 1);
    assert.strictEqual(result.mergeCount, 0);
  });

  await t.test('returns { entries, mergeCount, mergeLog }', () => {
    const result = deduplicateEntries([makeEntry()]);
    assert.ok(Array.isArray(result.entries));
    assert.strictEqual(typeof result.mergeCount, 'number');
    assert.ok(Array.isArray(result.mergeLog));
  });

  await t.test('mergeLog contains primary_id, secondary_id, merge_type, similarity', () => {
    const entries = [
      makeEntry({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', fingerprint: 'fingerprint00001', title: 'TypeError in authentication handler module' }),
      makeEntry({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', fingerprint: 'fingerprint00002', title: 'TypeError in authentication handler service' })
    ];
    const result = deduplicateEntries(entries);
    assert.strictEqual(result.mergeLog.length, 1);
    const log = result.mergeLog[0];
    assert.ok(log.primary_id);
    assert.ok(log.secondary_id);
    assert.ok(['fingerprint', 'levenshtein'].includes(log.merge_type));
    if (log.merge_type === 'levenshtein') {
      assert.strictEqual(typeof log.similarity, 'number');
    }
  });

  await t.test('title normalization: lowercase comparison for Levenshtein', () => {
    const entries = [
      makeEntry({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', fingerprint: 'fingerprint00001', title: 'TypeError In Authentication Handler Module' }),
      makeEntry({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', fingerprint: 'fingerprint00002', title: 'typeerror in authentication handler service' })
    ];
    const result = deduplicateEntries(entries);
    // Should merge despite case differences
    assert.strictEqual(result.entries.length, 1);
  });
});

// ── adversarial hardening tests ──────────────────────────────────────

test('deduplicateEntries does not crash when an entry has no string title (Phase 2)', () => {
  const a = makeEntry({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', fingerprint: 'uniquefp00000001' });
  delete a.title; // adversarial: title missing on a ledger entry
  const b = makeEntry({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', fingerprint: 'uniquefp00000002', title: 'Some real title' });
  // distinct fingerprints => both reach the Levenshtein phase
  let result;
  assert.doesNotThrow(() => { result = deduplicateEntries([a, b]); });
  assert.strictEqual(result.entries.length, 2);
  assert.strictEqual(result.mergeCount, 0);
});

test('deduplicateEntries skips null/non-object elements without crashing', () => {
  const valid = makeEntry({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', fingerprint: 'samefingerprint1' });
  let result;
  assert.doesNotThrow(() => { result = deduplicateEntries([null, valid]); });
  assert.ok(Array.isArray(result.entries));
  // the one well-formed entry survives
  assert.ok(result.entries.some(e => e && e.id === 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
});

test('mergeDebtEntries returns the present entry when the other is null', () => {
  const a = makeEntry({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', occurrences: 5 });
  let merged;
  assert.doesNotThrow(() => { merged = mergeDebtEntries(a, null); });
  assert.strictEqual(merged.id, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  assert.strictEqual(merged.occurrences, 5);
  // symmetric
  let merged2;
  assert.doesNotThrow(() => { merged2 = mergeDebtEntries(null, a); });
  assert.strictEqual(merged2.id, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
});

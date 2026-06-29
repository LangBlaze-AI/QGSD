'use strict';
/** @requirement DIAG-01 — validates error clustering for solve diagnostic pipeline */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { clusterErrors } = require('../bin/error-clusterer.cjs');

describe('clusterErrors', () => {
  it('returns empty array for empty input', () => {
    assert.deepStrictEqual(clusterErrors([]), []);
    assert.deepStrictEqual(clusterErrors(null), []);
    assert.deepStrictEqual(clusterErrors(undefined), []);
  });

  it('returns single cluster for single entry (rolled into Other)', () => {
    const entries = [
      { symptom: 'Error: ENOENT: no such file /tmp/foo', ts: new Date().toISOString(), confidence: 'high' }
    ];
    const clusters = clusterErrors(entries);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].count, 1);
    // Single entry gets rolled into Other bucket
    assert.equal(clusters[0].errorType, 'Other');
  });

  it('groups shell escaping errors into one cluster', () => {
    const entries = [
      { symptom: 'if (x \\\\!== y) causes SyntaxError in shell', ts: new Date().toISOString() },
      { symptom: 'if (z \\\\!== w) causes SyntaxError in shell', ts: new Date().toISOString() },
      { symptom: '\\\\!fs.existsSync(p) fails in bash', ts: new Date().toISOString() },
    ];
    const clusters = clusterErrors(entries);
    // All have \\! so all get ShellEscaping type
    const shellClusters = clusters.filter(c => c.errorType === 'ShellEscaping');
    assert.ok(shellClusters.length >= 1, 'Should have at least one ShellEscaping cluster');
    const totalShellEntries = shellClusters.reduce((sum, c) => sum + c.count, 0);
    assert.equal(totalShellEntries, 3, 'All 3 shell escaping entries should be accounted for');
  });

  it('groups ENOENT errors separately from shell escaping', () => {
    const entries = [
      { symptom: 'if (x \\\\!== y) SyntaxError', ts: new Date().toISOString() },
      { symptom: 'if (z \\\\!== w) SyntaxError', ts: new Date().toISOString() },
      { symptom: 'Error: ENOENT: no such file /tmp/a', ts: new Date().toISOString() },
      { symptom: 'Error: ENOENT: no such file /tmp/b', ts: new Date().toISOString() },
    ];
    const clusters = clusterErrors(entries);
    const shellClusters = clusters.filter(c => c.errorType === 'ShellEscaping');
    const enoentClusters = clusters.filter(c => c.errorType === 'ENOENT');
    assert.equal(shellClusters.length, 1, 'Shell escaping should be one consolidated cluster');
    assert.equal(enoentClusters.length, 1, 'ENOENT should be one consolidated cluster');
    assert.equal(shellClusters[0].count, 2);
    assert.equal(enoentClusters[0].count, 2);
  });

  it('produces multiple clusters for mixed error types', () => {
    const entries = [
      { symptom: 'if (x \\\\!== y) shell error', ts: new Date().toISOString() },
      { symptom: 'if (z \\\\!== w) shell error', ts: new Date().toISOString() },
      { symptom: '\\\\!fs.existsSync shell error', ts: new Date().toISOString() },
      { symptom: 'Error: ENOENT: no such file /a', ts: new Date().toISOString() },
      { symptom: 'Error: ENOENT: no such file /b', ts: new Date().toISOString() },
      { symptom: 'TypeError: Cannot read properties of undefined', ts: new Date().toISOString() },
    ];
    const clusters = clusterErrors(entries);
    // ShellEscaping (3 entries consolidated), ENOENT (2 consolidated), TypeError (1 → Other)
    assert.equal(clusters.length, 3, `Expected 3 clusters (Shell, ENOENT, Other), got ${clusters.length}`);
    const types = new Set(clusters.map(c => c.errorType));
    assert.ok(types.has('ShellEscaping'));
    assert.ok(types.has('ENOENT'));
    assert.ok(types.has('Other'), 'Singleton TypeError should roll into Other');
  });

  it('sub-clusters within non-consolidated type when symptoms are dissimilar', () => {
    // Use RuntimeError (not in CONSOLIDATE_TYPES) to test Levenshtein sub-clustering
    const entries = [
      { symptom: 'Deadlock reached in state machine alpha controller', ts: new Date().toISOString() },
      { symptom: 'Deadlock reached in state machine alpha controller', ts: new Date().toISOString() },
      { symptom: 'Deadlock completely different: throw new Error in unrelated beta module far away', ts: new Date().toISOString() },
    ];
    const clusters = clusterErrors(entries, { threshold: 0.7 });
    const runtimeClusters = clusters.filter(c => c.errorType === 'RuntimeError');
    // First two identical → one sub-cluster (count=2). Third is different → singleton → Other.
    assert.equal(runtimeClusters.length, 1, 'Identical pair should form one RuntimeError cluster');
    assert.equal(runtimeClusters[0].count, 2, 'RuntimeError cluster should have 2 entries');
    // The dissimilar third entry becomes a singleton and rolls into Other
    const otherClusters = clusters.filter(c => c.errorType === 'Other');
    assert.equal(otherClusters.length, 1, 'Dissimilar singleton should roll into Other');
  });

  it('detects stale clusters (all entries older than 7 days)', () => {
    const now = new Date('2026-03-10T00:00:00Z');
    const oldTs = new Date('2026-02-28T00:00:00Z').toISOString(); // 10 days ago
    const recentTs = new Date('2026-03-09T00:00:00Z').toISOString(); // 1 day ago

    const staleEntries = [
      { symptom: 'Error: ENOENT: old file missing', ts: oldTs },
      { symptom: 'Error: ENOENT: another old file missing', ts: oldTs },
    ];
    const staleClusters = clusterErrors(staleEntries, { now });
    assert.equal(staleClusters[0].stale, true, 'All-old cluster should be stale');

    const mixedEntries = [
      { symptom: 'Error: ENOENT: old file missing', ts: oldTs },
      { symptom: 'Error: ENOENT: recent file missing', ts: recentTs },
    ];
    const mixedClusters = clusterErrors(mixedEntries, { now });
    assert.equal(mixedClusters[0].stale, false, 'Cluster with one recent entry should not be stale');
  });

  it('handles missing fields gracefully', () => {
    const entries = [
      { symptom: undefined, ts: new Date().toISOString() },
      { ts: new Date().toISOString() },
      {},
    ];
    const clusters = clusterErrors(entries);
    // All should be classified as Unknown
    assert.ok(clusters.length >= 1);
    for (const c of clusters) {
      assert.equal(c.errorType, 'Unknown');
    }
  });

  it('entry without ts is treated as not-stale', () => {
    const now = new Date('2026-03-10T00:00:00Z');
    const entries = [
      { symptom: 'Error: ENOENT: no ts entry' },
    ];
    const clusters = clusterErrors(entries, { now });
    assert.equal(clusters[0].stale, false, 'Entry without ts should not be stale');
  });

  it('computes avgConfidence correctly', () => {
    const entries = [
      { symptom: 'Error: ENOENT: file a', ts: new Date().toISOString(), confidence: 'low' },
      { symptom: 'Error: ENOENT: file b', ts: new Date().toISOString(), confidence: 'high' },
    ];
    const clusters = clusterErrors(entries);
    assert.equal(clusters[0].avgConfidence, 'high', 'Should be high if any entry is high');

    const lowEntries = [
      { symptom: 'TypeError: foo', ts: new Date().toISOString(), confidence: 'low' },
      { symptom: 'TypeError: bar', ts: new Date().toISOString(), confidence: 'low' },
    ];
    const lowClusters = clusterErrors(lowEntries);
    const typeClusters = lowClusters.filter(c => c.errorType === 'TypeError');
    for (const c of typeClusters) {
      assert.equal(c.avgConfidence, 'low', 'Should be low if all entries are low');
    }
  });

  it('cluster objects have all required fields', () => {
    const entries = [
      { symptom: 'SyntaxError: Unexpected token', ts: new Date().toISOString(), confidence: 'medium' },
    ];
    const clusters = clusterErrors(entries);
    const c = clusters[0];
    assert.ok('clusterId' in c, 'Missing clusterId');
    assert.ok('label' in c, 'Missing label');
    assert.ok('errorType' in c, 'Missing errorType');
    assert.ok('count' in c, 'Missing count');
    assert.ok('entries' in c, 'Missing entries');
    assert.ok('representative' in c, 'Missing representative');
    assert.ok('stale' in c, 'Missing stale');
    assert.ok('avgConfidence' in c, 'Missing avgConfidence');
    assert.equal(typeof c.clusterId, 'string');
    assert.equal(typeof c.label, 'string');
    assert.equal(typeof c.count, 'number');
    assert.equal(typeof c.stale, 'boolean');
    assert.ok(Array.isArray(c.entries));
  });

  it('picks highest-confidence entry as representative', () => {
    const entries = [
      { symptom: 'Error: ENOENT: file low', ts: new Date().toISOString(), confidence: 'low' },
      { symptom: 'Error: ENOENT: file high', ts: new Date().toISOString(), confidence: 'high' },
      { symptom: 'Error: ENOENT: file medium', ts: new Date().toISOString(), confidence: 'medium' },
    ];
    const clusters = clusterErrors(entries);
    assert.equal(clusters[0].representative.confidence, 'high');
  });

  it('does not crash on a null or non-object entry in the array', () => {
    const entries = [
      { symptom: 'Error: ENOENT: file a', ts: new Date().toISOString() },
      { symptom: 'Error: ENOENT: file b', ts: new Date().toISOString() },
      null,
      'not-an-object',
    ];
    let clusters;
    assert.doesNotThrow(() => { clusters = clusterErrors(entries); });
    // The two valid ENOENT entries still cluster together
    const enoent = clusters.filter(c => c.errorType === 'ENOENT');
    assert.equal(enoent.length, 1);
    assert.equal(enoent[0].count, 2);
  });

  it('does not crash when symptom is a non-string value', () => {
    const entries = [
      { symptom: 42, ts: new Date().toISOString() },
      { symptom: { nested: 'oops' }, ts: new Date().toISOString() },
    ];
    let clusters;
    assert.doesNotThrow(() => { clusters = clusterErrors(entries); });
    assert.ok(clusters.length >= 1);
    // Non-string symptoms classify as Unknown and roll into Other
    for (const c of clusters) {
      assert.ok(['Unknown', 'Other'].includes(c.errorType));
      assert.equal(typeof c.label, 'string');
    }
  });

  it('does not crash when options is null', () => {
    const entries = [{ symptom: 'Error: ENOENT: x', ts: new Date().toISOString() }];
    let clusters;
    assert.doesNotThrow(() => { clusters = clusterErrors(entries, null); });
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].count, 1);
  });
});

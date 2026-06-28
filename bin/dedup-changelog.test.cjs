#!/usr/bin/env node
'use strict';

/**
 * dedup-changelog.test.cjs — Tests for dedup logic and write-time guard.
 * Requirements: STAB-03
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { dedup, DEDUP_WINDOW_MS } = require('./dedup-changelog.cjs');

function makeEntry(model, from, to, timestampMs) {
  return {
    model,
    from_level: from,
    to_level: to,
    timestamp: new Date(timestampMs).toISOString(),
    evidence_readiness: { score: 3, total: 5 },
    trigger: 'auto_promotion',
  };
}

const BASE_TIME = Date.parse('2026-03-10T12:00:00Z');

describe('dedup()', () => {

  it('removes duplicates within 5-min window', () => {
    const changelog = [
      makeEntry('.planning/formal/alloy/quorum.als', 'ADVISORY', 'SOFT_GATE', BASE_TIME),
      makeEntry('.planning/formal/alloy/quorum.als', 'ADVISORY', 'SOFT_GATE', BASE_TIME + 60000), // 1 min later
    ];
    const result = dedup(changelog);
    assert.strictEqual(result.length, 1, 'duplicate should be removed');
  });

  it('keeps entries outside window', () => {
    const changelog = [
      makeEntry('.planning/formal/alloy/quorum.als', 'ADVISORY', 'SOFT_GATE', BASE_TIME),
      makeEntry('.planning/formal/alloy/quorum.als', 'ADVISORY', 'SOFT_GATE', BASE_TIME + 600000), // 10 min later
    ];
    const result = dedup(changelog);
    assert.strictEqual(result.length, 2, 'both should be kept');
  });

  it('keeps different transitions', () => {
    const changelog = [
      makeEntry('.planning/formal/alloy/quorum.als', 'ADVISORY', 'SOFT_GATE', BASE_TIME),
      makeEntry('.planning/formal/alloy/quorum.als', 'SOFT_GATE', 'HARD_GATE', BASE_TIME + 1000),
    ];
    const result = dedup(changelog);
    assert.strictEqual(result.length, 2, 'different transitions should both be kept');
  });

  it('handles empty array', () => {
    assert.deepStrictEqual(dedup([]), []);
  });

  it('handles single entry', () => {
    const entry = makeEntry('model.als', 'ADVISORY', 'SOFT_GATE', BASE_TIME);
    const result = dedup([entry]);
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0], entry);
  });

  it('preserves chronological order', () => {
    const changelog = [
      makeEntry('model-a.als', 'ADVISORY', 'SOFT_GATE', BASE_TIME),
      makeEntry('model-b.als', 'ADVISORY', 'SOFT_GATE', BASE_TIME + 10000),
      makeEntry('model-c.als', 'ADVISORY', 'SOFT_GATE', BASE_TIME + 20000),
    ];
    const result = dedup(changelog);
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].model, 'model-a.als');
    assert.strictEqual(result[1].model, 'model-b.als');
    assert.strictEqual(result[2].model, 'model-c.als');
  });

  it('multiple models interleaved — only same-model duplicates removed', () => {
    const changelog = [
      makeEntry('model-a.als', 'ADVISORY', 'SOFT_GATE', BASE_TIME),
      makeEntry('model-b.als', 'ADVISORY', 'SOFT_GATE', BASE_TIME + 1000),
      makeEntry('model-a.als', 'ADVISORY', 'SOFT_GATE', BASE_TIME + 2000), // dup of first
      makeEntry('model-b.als', 'ADVISORY', 'SOFT_GATE', BASE_TIME + 3000), // dup of second
    ];
    const result = dedup(changelog);
    assert.strictEqual(result.length, 2, 'should keep one per model');
    assert.strictEqual(result[0].model, 'model-a.als');
    assert.strictEqual(result[1].model, 'model-b.als');
  });

  it('boundary test: exactly 5 minutes apart — kept (strict less-than)', () => {
    const changelog = [
      makeEntry('model.als', 'ADVISORY', 'SOFT_GATE', BASE_TIME),
      makeEntry('model.als', 'ADVISORY', 'SOFT_GATE', BASE_TIME + DEDUP_WINDOW_MS), // exactly 5 min
    ];
    const result = dedup(changelog);
    assert.strictEqual(result.length, 2, 'entries exactly at boundary should both be kept');
  });

  it('handles non-array input', () => {
    assert.deepStrictEqual(dedup(null), []);
    assert.deepStrictEqual(dedup(undefined), []);
    assert.deepStrictEqual(dedup('string'), []);
  });

  it('handles entries with missing timestamp gracefully', () => {
    const changelog = [
      { model: 'a', from_level: 'X', to_level: 'Y', timestamp: new Date(BASE_TIME).toISOString() },
      { model: 'a', from_level: 'X', to_level: 'Y' }, // missing timestamp
    ];
    // Should not throw — NaN comparison fails the window check, so entry is kept
    assert.doesNotThrow(() => dedup(changelog));
  });

  it('does not crash on null / non-object entries in the array', () => {
    const changelog = [
      null,
      makeEntry('model.als', 'ADVISORY', 'SOFT_GATE', BASE_TIME),
      42,
    ];
    assert.doesNotThrow(() => dedup(changelog));
    const result = dedup(changelog);
    // the real entry must survive the garbage neighbours
    assert.ok(result.some((e) => e && e.model === 'model.als'),
      'valid entry should be preserved alongside skipped garbage');
  });

  it('keeps an entry with an unparseable timestamp instead of deduping it against an old entry', () => {
    const changelog = [
      makeEntry('model.als', 'ADVISORY', 'SOFT_GATE', BASE_TIME),
      // same transition but NO/garbage timestamp -> NaN time; must not be window-bypassed
      { model: 'model.als', from_level: 'ADVISORY', to_level: 'SOFT_GATE' },
    ];
    const result = dedup(changelog);
    assert.strictEqual(result.length, 2,
      'NaN-timestamp entry must not bypass the window check and be silently removed');
  });
});

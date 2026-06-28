#!/usr/bin/env node
'use strict';
// bin/solve-cycle-detector.test.cjs
// Tests for solve-cycle-detector.cjs — CONV-01 + QUICK-342

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CycleDetector, detectCycles, detectStateCycles, hashState, countBounces } = require('./solve-cycle-detector.cjs');

// ── detectCycles (original A-B-A-B) ─────────────────────────────────────────

test('detectCycles: returns empty for null/empty input', () => {
  assert.deepStrictEqual(detectCycles(null), []);
  assert.deepStrictEqual(detectCycles({}), []);
});

test('detectCycles: no oscillation with < 4 points', () => {
  assert.deepStrictEqual(detectCycles({ r_to_f: [1, 2, 1] }), []);
});

test('detectCycles: detects A-B-A-B pattern', () => {
  const result = detectCycles({ r_to_f: [5, 3, 5, 3] });
  assert.deepStrictEqual(result, ['r_to_f']);
});

test('detectCycles: no false positive for monotonic decrease', () => {
  assert.deepStrictEqual(detectCycles({ r_to_f: [10, 8, 6, 4] }), []);
});

test('detectCycles: detects late-onset oscillation', () => {
  const result = detectCycles({ r_to_f: [10, 8, 3, 5, 3, 5] });
  assert.deepStrictEqual(result, ['r_to_f']);
});

// ── hashState ────────────────────────────────────────────────────────────────

test('hashState: deterministic for same input', () => {
  const a = hashState({ r_to_f: 3, f_to_t: 0 });
  const b = hashState({ f_to_t: 0, r_to_f: 3 }); // different key order
  assert.equal(a, b, 'hash should be deterministic regardless of key order');
});

test('hashState: different for different input', () => {
  const a = hashState({ r_to_f: 3, f_to_t: 0 });
  const b = hashState({ r_to_f: 3, f_to_t: 1 });
  assert.notEqual(a, b);
});

// ── detectStateCycles ────────────────────────────────────────────────────────

test('detectStateCycles: no cycle with < 4 hashes', () => {
  const result = detectStateCycles(['a', 'b', 'c']);
  assert.equal(result.detected, false);
});

test('detectStateCycles: detects period-2 cycle (A-B-A-B)', () => {
  const hashes = ['aaa', 'bbb', 'aaa', 'bbb'];
  const result = detectStateCycles(hashes);
  assert.equal(result.detected, true);
  assert.equal(result.cycle_length, 2);
});

test('detectStateCycles: detects period-3 cycle (A-B-C-A-B-C)', () => {
  const hashes = ['aaa', 'bbb', 'ccc', 'aaa', 'bbb', 'ccc'];
  const result = detectStateCycles(hashes);
  assert.equal(result.detected, true);
  assert.equal(result.cycle_length, 3);
});

test('detectStateCycles: no false positive for convergent sequence', () => {
  const hashes = ['aaa', 'bbb', 'ccc', 'ddd', 'eee'];
  const result = detectStateCycles(hashes);
  assert.equal(result.detected, false);
});

// ── countBounces ─────────────────────────────────────────────────────────────

test('countBounces: returns 0 for < 3 values', () => {
  assert.equal(countBounces([1, 2]), 0);
});

test('countBounces: counts direction changes', () => {
  // 5 -> 3 (down) -> 5 (up) = 1 bounce
  assert.equal(countBounces([5, 3, 5]), 1);
});

test('countBounces: counts multiple bounces', () => {
  // 5->3 (down) ->5 (up, bounce) ->2 (down, bounce) ->4 (up, bounce) = 3 bounces
  assert.equal(countBounces([5, 3, 5, 2, 4]), 3);
});

test('countBounces: no bounces for monotonic decrease', () => {
  assert.equal(countBounces([10, 8, 6, 4, 2]), 0);
});

test('countBounces: flat segments do not count as bounces', () => {
  assert.equal(countBounces([5, 5, 5, 5]), 0);
});

// ── CycleDetector class ──────────────────────────────────────────────────────

test('CycleDetector: record + detectOscillating integration', () => {
  const cd = new CycleDetector();
  cd.record(1, { r_to_f: 5, f_to_t: 0 });
  cd.record(2, { r_to_f: 3, f_to_t: 2 });
  cd.record(3, { r_to_f: 5, f_to_t: 0 });
  cd.record(4, { r_to_f: 3, f_to_t: 2 });
  assert.deepStrictEqual(cd.detectOscillating(), ['r_to_f', 'f_to_t']);
});

test('CycleDetector: detectStateCycle detects period-2', () => {
  const cd = new CycleDetector();
  cd.record(1, { r_to_f: 5, f_to_t: 0 });
  cd.record(2, { r_to_f: 3, f_to_t: 2 });
  cd.record(3, { r_to_f: 5, f_to_t: 0 });
  cd.record(4, { r_to_f: 3, f_to_t: 2 });
  const result = cd.detectStateCycle();
  assert.equal(result.detected, true);
  assert.equal(result.cycle_length, 2);
});

test('CycleDetector: getBlockedLayers with threshold', () => {
  const cd = new CycleDetector({ bounce_threshold: 2 });
  // r_to_f: 5->3->5->2->4 = 3 bounces (exceeds threshold of 2)
  cd.record(1, { r_to_f: 5 });
  cd.record(2, { r_to_f: 3 });
  cd.record(3, { r_to_f: 5 });
  cd.record(4, { r_to_f: 2 });
  cd.record(5, { r_to_f: 4 });
  const blocked = cd.getBlockedLayers();
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].layer, 'r_to_f');
  assert.equal(blocked[0].bounces, 3);
});

test('CycleDetector: getBlockedLayers with no bounces', () => {
  const cd = new CycleDetector({ bounce_threshold: 2 });
  cd.record(1, { r_to_f: 10 });
  cd.record(2, { r_to_f: 8 });
  cd.record(3, { r_to_f: 6 });
  const blocked = cd.getBlockedLayers();
  assert.equal(blocked.length, 0);
});

test('CycleDetector: stateHashes recorded correctly', () => {
  const cd = new CycleDetector();
  cd.record(1, { r_to_f: 5 });
  cd.record(2, { r_to_f: 3 });
  assert.equal(cd.getStateHashes().length, 2);
  assert.equal(typeof cd.getStateHashes()[0], 'string');
});

test('CycleDetector: record tolerates prototype-polluting layer keys', () => {
  const cd = new CycleDetector();
  const poisoned = JSON.parse('{"__proto__": 5, "r_to_f": 3}');
  assert.doesNotThrow(() => cd.record(1, poisoned));
  // real layer still recorded; pollution key handled as an own property, not a crash
  assert.deepStrictEqual(cd.getHistory().r_to_f, [3]);
  assert.equal(cd.getStateHashes().length, 1);
});

test('CycleDetector: tolerates null/non-object opts', () => {
  assert.doesNotThrow(() => new CycleDetector(null));
  const cd = new CycleDetector(null);
  assert.equal(cd.bounceThreshold, 2);
  assert.equal(cd.getStateHashes().length, 0);
});

test('CycleDetector: bounce_threshold of 0 is honored, not coerced to default', () => {
  const cd = new CycleDetector({ bounce_threshold: 0 });
  assert.equal(cd.bounceThreshold, 0);
  cd.record(1, { r_to_f: 5 });
  cd.record(2, { r_to_f: 3 });
  cd.record(3, { r_to_f: 6 }); // one bounce (down then up)
  const blocked = cd.getBlockedLayers();
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].layer, 'r_to_f');
});

// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
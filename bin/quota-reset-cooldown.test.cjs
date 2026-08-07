#!/usr/bin/env node
'use strict';
// bin/quota-reset-cooldown.test.cjs — QUOTA-RESET-01
//
// A quota-dead slot states when it comes back, but in shapes parseAvailabilityHint did
// not match, so it fell through to the 5-minute default and was re-dispatched every
// 5 minutes for DAYS — burning a slot in every quorum round and dragging the live-voter
// count toward the min_live_voters floor. Both strings below are verbatim from live
// slots on 2026-08-07:
//   antigravity-1  "Resets in 95h26m37s."                    -> was 5 min, should be ~95h
//   claude-z-ai    "...will reset at 2026-08-09 10:01:44"     -> was 5 min, should be ~41h

const { test } = require('node:test');
const assert = require('node:assert');
const { parseAvailabilityHint } = require('./update-scoreboard.cjs');

const minutesOut = (msg) => {
  const r = parseAvailabilityHint(msg);
  return r ? Math.round((r.available_at.getTime() - Date.now()) / 60000) : null;
};

test('QRC-1: a compact duration is honoured, not defaulted to 5 minutes', () => {
  const msg = 'Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 95h26m37s.';
  const mins = minutesOut(msg);
  assert.ok(mins > 5700 && mins < 5740, `expected ~5726 min, got ${mins}`);
  assert.strictEqual(parseAvailabilityHint(msg).reason, 'quota exceeded');
});

test('QRC-2: an absolute reset timestamp is honoured', () => {
  // Far-future date so the assertion doesn't rot; the shape is what matters.
  const msg = 'API Error: Request rejected (429) · [1310][Weekly/Monthly Limit Exhausted. Your limit will reset at 2099-01-01 10:01:44]';
  const r = parseAvailabilityHint(msg);
  assert.ok(r && r.available_at.getUTCFullYear() === 2099, 'absolute reset time must be parsed');
  assert.strictEqual(r.reason, 'quota exceeded');
});

test('QRC-3: partial compact forms parse (h+m, m+s, bare s)', () => {
  assert.ok(Math.abs(minutesOut('quota exhausted, resets in 32h54m') - 1974) <= 1);
  assert.ok(Math.abs(minutesOut('retry in 5m30s') - 5) <= 1);
  assert.ok(minutesOut('available in 90s') === 1 || minutesOut('available in 90s') === 2);
});

test('QRC-4: a transient failure still gets the SHORT default, not a multi-day hold', () => {
  // The dangerous direction: over-matching would retire a healthy slot for days on a
  // one-off stall. These must stay at the 5-minute default.
  assert.strictEqual(minutesOut('STALL: no output at all for 30000ms'), 5);
  assert.strictEqual(minutesOut('IDLE_TIMEOUT after 300000ms of inactivity'), 5);
  assert.strictEqual(minutesOut('TIMEOUT after 0ms'), 5);
});

test('QRC-5: an already-past absolute reset does not produce a negative cooldown', () => {
  // A stale message must not resolve to "available in the past" and it must not be
  // mistaken for a fresh multi-day hold either.
  const r = parseAvailabilityHint('Limit exhausted. Your limit will reset at 2020-01-01 10:00:00');
  assert.ok(!r || r.available_at.getTime() > Date.now(), 'a past reset time must not be recorded as a cooldown');
});

test('QRC-6: the empty-match trap stays closed', () => {
  // The first implementation used one pattern of all-optional unit groups, which matches
  // the empty string: every capture undefined, silent fall-through to the 5-min default.
  // A message with a reset word but NO duration must reach the default deliberately.
  assert.strictEqual(minutesOut('quota reached, resets soon'), 5);
  assert.strictEqual(parseAvailabilityHint('resets eventually'), null,
    'no failure pattern and no duration means no cooldown at all');
});

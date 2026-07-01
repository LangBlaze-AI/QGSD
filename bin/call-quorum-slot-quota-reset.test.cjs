'use strict';

// P4 — parse a provider's quota-reset window from its error text so the cooldown
// matches the real quota (rolling ~33h) instead of the fixed 30-min failure TTL.
// Motivated by antigravity-1 (Google 429 "Resets in 32h54m49s") being re-probed and
// re-failed every 30 min all session.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseQuotaResetMs } = require('./call-quorum-slot.cjs');

const H = 3600000, M = 60000, S = 1000;

describe('parseQuotaResetMs — quota reset-window parser', () => {
  it('parses the compact Google form "Resets in 32h54m49s"', () => {
    assert.equal(parseQuotaResetMs('RESOURCE_EXHAUSTED (code 429): Resets in 32h54m49s.'),
      32 * H + 54 * M + 49 * S);
  });

  it('parses "resets in 1h30m" and "resets in 45m"', () => {
    assert.equal(parseQuotaResetMs('quota reached, resets in 1h30m'), 1 * H + 30 * M);
    assert.equal(parseQuotaResetMs('resets in 45m'), 45 * M);
  });

  it('parses verbose "try again in 30 minutes" / "in 2 hours" / "in 45 seconds"', () => {
    assert.equal(parseQuotaResetMs('rate limited, try again in 30 minutes'), 30 * M);
    assert.equal(parseQuotaResetMs('quota exceeded; available in 2 hours'), 2 * H);
    assert.equal(parseQuotaResetMs('retry in 45 seconds'), 45 * S);
  });

  it('returns null when no reset window is present', () => {
    assert.equal(parseQuotaResetMs('429 Too Many Requests'), null);
    assert.equal(parseQuotaResetMs('some unrelated error'), null);
    assert.equal(parseQuotaResetMs(''), null);
    assert.equal(parseQuotaResetMs(null), null);
  });

  it('clamps absurd windows to 48h (defends against a malformed "9999h")', () => {
    assert.equal(parseQuotaResetMs('resets in 9999h'), 48 * H);
  });

  it('does not misfire on a bare number without a unit', () => {
    assert.equal(parseQuotaResetMs('error 500 on attempt 3'), null);
  });
});

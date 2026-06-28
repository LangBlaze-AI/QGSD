'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  countDirectionChanges,
  detectFlipFlops,
  isCooldownSatisfied,
  updateCooldownState,
  createUnstableEntry,
  LEVEL_ORDER,
  DEFAULT_FLIP_FLOP_THRESHOLD,
  DEFAULT_REQUIRED_SESSIONS,
  DEFAULT_REQUIRED_WALL_TIME_MS,
} = require('./gate-stability.cjs');

// ── countDirectionChanges ────────────────────────────────────────────────────

describe('countDirectionChanges', () => {
  it('returns 0 for empty array', () => {
    assert.strictEqual(countDirectionChanges([]), 0);
  });

  it('returns 0 for single entry', () => {
    assert.strictEqual(countDirectionChanges([
      { from_level: 'ADVISORY', to_level: 'SOFT_GATE' },
    ]), 0);
  });

  it('returns 0 for same-direction-only entries (all promotions)', () => {
    const entries = [
      { from_level: 'ADVISORY', to_level: 'SOFT_GATE' },
      { from_level: 'ADVISORY', to_level: 'SOFT_GATE' },
      { from_level: 'ADVISORY', to_level: 'SOFT_GATE' },
    ];
    assert.strictEqual(countDirectionChanges(entries), 0);
  });

  it('returns 1 for one direction reversal (up then down)', () => {
    const entries = [
      { from_level: 'ADVISORY', to_level: 'SOFT_GATE' },   // up
      { from_level: 'SOFT_GATE', to_level: 'ADVISORY' },   // down (change 1)
    ];
    assert.strictEqual(countDirectionChanges(entries), 1);
  });

  it('returns 3 for classic flip-flop pattern (up, down, up, down)', () => {
    const entries = [
      { from_level: 'ADVISORY', to_level: 'SOFT_GATE' },   // up
      { from_level: 'SOFT_GATE', to_level: 'ADVISORY' },   // down (change 1)
      { from_level: 'ADVISORY', to_level: 'SOFT_GATE' },   // up (change 2)
      { from_level: 'SOFT_GATE', to_level: 'ADVISORY' },   // down (change 3)
    ];
    assert.strictEqual(countDirectionChanges(entries), 3);
  });

  it('skips entries with unknown levels', () => {
    const entries = [
      { from_level: 'ADVISORY', to_level: 'SOFT_GATE' },   // up
      { from_level: 'UNKNOWN', to_level: 'SOFT_GATE' },    // skip
      { from_level: 'SOFT_GATE', to_level: 'ADVISORY' },   // down (change 1)
    ];
    assert.strictEqual(countDirectionChanges(entries), 1);
  });

  it('skips entries where from_level === to_level', () => {
    const entries = [
      { from_level: 'ADVISORY', to_level: 'SOFT_GATE' },   // up
      { from_level: 'SOFT_GATE', to_level: 'SOFT_GATE' },  // skip (same)
      { from_level: 'SOFT_GATE', to_level: 'ADVISORY' },   // down (change 1)
    ];
    assert.strictEqual(countDirectionChanges(entries), 1);
  });

  it('handles multi-level jumps (ADVISORY -> HARD_GATE)', () => {
    const entries = [
      { from_level: 'ADVISORY', to_level: 'HARD_GATE' },   // up
      { from_level: 'HARD_GATE', to_level: 'SOFT_GATE' },  // down (change 1)
    ];
    assert.strictEqual(countDirectionChanges(entries), 1);
  });

  it('does not count same-direction duplicates as alternations (Pitfall 1)', () => {
    // Two promotions in a row should NOT count as an alternation
    const entries = [
      { from_level: 'ADVISORY', to_level: 'SOFT_GATE' },   // up
      { from_level: 'SOFT_GATE', to_level: 'HARD_GATE' },  // up (same direction)
      { from_level: 'HARD_GATE', to_level: 'SOFT_GATE' },  // down (change 1)
    ];
    assert.strictEqual(countDirectionChanges(entries), 1);
  });
});

describe('countDirectionChanges adversarial', () => {
  it('skips null/non-object entries without crashing', () => {
    const entries = [
      { from_level: 'ADVISORY', to_level: 'SOFT_GATE' }, // up
      null,                                              // skip
      { from_level: 'SOFT_GATE', to_level: 'ADVISORY' }, // down (change 1)
    ];
    assert.strictEqual(countDirectionChanges(entries), 1);
  });

  it('skips a primitive entry without crashing', () => {
    const entries = [
      { from_level: 'ADVISORY', to_level: 'SOFT_GATE' },
      'oops',
      { from_level: 'SOFT_GATE', to_level: 'ADVISORY' },
    ];
    assert.strictEqual(countDirectionChanges(entries), 1);
  });
});

// ── detectFlipFlops ──────────────────────────────────────────────────────────

describe('detectFlipFlops', () => {
  it('returns empty object for stable models (< threshold changes)', () => {
    const changelog = [
      { model: 'model-a', from_level: 'ADVISORY', to_level: 'SOFT_GATE' },
      { model: 'model-a', from_level: 'SOFT_GATE', to_level: 'ADVISORY' },
    ];
    assert.deepStrictEqual(detectFlipFlops(changelog), {});
  });

  it('flags model with >= 3 direction changes (default threshold)', () => {
    const changelog = [
      { model: 'model-a', from_level: 'ADVISORY', to_level: 'SOFT_GATE' },
      { model: 'model-a', from_level: 'SOFT_GATE', to_level: 'ADVISORY' },
      { model: 'model-a', from_level: 'ADVISORY', to_level: 'SOFT_GATE' },
      { model: 'model-a', from_level: 'SOFT_GATE', to_level: 'ADVISORY' },
    ];
    const result = detectFlipFlops(changelog);
    assert.ok(result['model-a']);
    assert.strictEqual(result['model-a'].direction_changes, 3);
    assert.ok(result['model-a'].flagged_at);
  });

  it('groups entries correctly by model path', () => {
    const changelog = [
      // model-a: stable (1 change only)
      { model: 'model-a', from_level: 'ADVISORY', to_level: 'SOFT_GATE' },
      { model: 'model-a', from_level: 'SOFT_GATE', to_level: 'ADVISORY' },
      // model-b: unstable (3 changes)
      { model: 'model-b', from_level: 'ADVISORY', to_level: 'SOFT_GATE' },
      { model: 'model-b', from_level: 'SOFT_GATE', to_level: 'ADVISORY' },
      { model: 'model-b', from_level: 'ADVISORY', to_level: 'SOFT_GATE' },
      { model: 'model-b', from_level: 'SOFT_GATE', to_level: 'ADVISORY' },
    ];
    const result = detectFlipFlops(changelog);
    assert.ok(!result['model-a'], 'model-a should not be flagged');
    assert.ok(result['model-b'], 'model-b should be flagged');
    assert.strictEqual(result['model-b'].direction_changes, 3);
  });

  it('custom threshold works (threshold=2)', () => {
    const changelog = [
      { model: 'model-a', from_level: 'ADVISORY', to_level: 'SOFT_GATE' },
      { model: 'model-a', from_level: 'SOFT_GATE', to_level: 'ADVISORY' },
      { model: 'model-a', from_level: 'ADVISORY', to_level: 'SOFT_GATE' },
    ];
    const result = detectFlipFlops(changelog, 2);
    assert.ok(result['model-a']);
    assert.strictEqual(result['model-a'].direction_changes, 2);
  });

  it('handles empty changelog', () => {
    assert.deepStrictEqual(detectFlipFlops([]), {});
  });
});

describe('detectFlipFlops prototype-pollution keys', () => {
  it('does not crash and groups a __proto__ model path as an own key', () => {
    const changelog = [
      { model: '__proto__', from_level: 'ADVISORY', to_level: 'SOFT_GATE' },
      { model: '__proto__', from_level: 'SOFT_GATE', to_level: 'ADVISORY' },
      { model: '__proto__', from_level: 'ADVISORY', to_level: 'SOFT_GATE' },
      { model: '__proto__', from_level: 'SOFT_GATE', to_level: 'ADVISORY' },
    ];
    let result;
    assert.doesNotThrow(() => { result = detectFlipFlops(changelog); });
    assert.ok(Object.prototype.hasOwnProperty.call(result, '__proto__'),
      '__proto__ model should be an own key of the result');
    assert.strictEqual(result['__proto__'].direction_changes, 3);
  });

  it('handles a constructor model path without mis-grouping', () => {
    const changelog = [
      { model: 'constructor', from_level: 'ADVISORY', to_level: 'SOFT_GATE' },
      { model: 'constructor', from_level: 'SOFT_GATE', to_level: 'ADVISORY' },
    ];
    let result;
    assert.doesNotThrow(() => { result = detectFlipFlops(changelog); });
    assert.deepStrictEqual(result, {});
  });
});

// ── isCooldownSatisfied ──────────────────────────────────────────────────────

describe('isCooldownSatisfied', () => {
  it('returns true when no stability info (null)', () => {
    assert.strictEqual(isCooldownSatisfied(null), true);
  });

  it('returns true when no stability info (undefined)', () => {
    assert.strictEqual(isCooldownSatisfied(undefined), true);
  });

  it('returns true when stability_status is not UNSTABLE', () => {
    assert.strictEqual(isCooldownSatisfied({ stability_status: 'STABLE' }), true);
  });

  it('returns false when sessions not met (1 of 3)', () => {
    const info = {
      stability_status: 'UNSTABLE',
      flagged_at: new Date(Date.now() - 7200000).toISOString(), // 2 hours ago (wall time met)
      cooldown: {
        consecutive_stable_sessions: 1,
        required_sessions: 3,
        required_wall_time_ms: 3600000,
      },
    };
    assert.strictEqual(isCooldownSatisfied(info), false);
  });

  it('returns false when wall time not met (sessions OK but < 1 hour)', () => {
    const info = {
      stability_status: 'UNSTABLE',
      flagged_at: new Date(Date.now() - 1000).toISOString(), // 1 second ago
      cooldown: {
        consecutive_stable_sessions: 5,
        required_sessions: 3,
        required_wall_time_ms: 3600000,
      },
    };
    assert.strictEqual(isCooldownSatisfied(info), false);
  });

  it('returns true when both conditions met', () => {
    const info = {
      stability_status: 'UNSTABLE',
      flagged_at: new Date(Date.now() - 7200000).toISOString(), // 2 hours ago
      cooldown: {
        consecutive_stable_sessions: 3,
        required_sessions: 3,
        required_wall_time_ms: 3600000,
      },
    };
    assert.strictEqual(isCooldownSatisfied(info), true);
  });

  it('returns false when neither condition met', () => {
    const info = {
      stability_status: 'UNSTABLE',
      flagged_at: new Date(Date.now() - 1000).toISOString(), // 1 second ago
      cooldown: {
        consecutive_stable_sessions: 0,
        required_sessions: 3,
        required_wall_time_ms: 3600000,
      },
    };
    assert.strictEqual(isCooldownSatisfied(info), false);
  });
});

// ── updateCooldownState ──────────────────────────────────────────────────────

describe('updateCooldownState', () => {
  it('increments consecutive_stable_sessions when gate score passes', () => {
    const stability = {
      stability_status: 'UNSTABLE',
      flagged_at: new Date().toISOString(),
      cooldown: {
        consecutive_stable_sessions: 1,
        required_sessions: 3,
        required_wall_time_ms: 3600000,
        last_session_timestamp: null,
      },
    };
    const result = updateCooldownState(stability, 2, 1); // score 2 >= threshold 1
    assert.strictEqual(result.cooldown.consecutive_stable_sessions, 2);
    assert.ok(result.cooldown.last_session_timestamp);
  });

  it('resets consecutive_stable_sessions to 0 when gate score drops (Pitfall 3)', () => {
    const stability = {
      stability_status: 'UNSTABLE',
      flagged_at: new Date().toISOString(),
      cooldown: {
        consecutive_stable_sessions: 2,
        required_sessions: 3,
        required_wall_time_ms: 3600000,
        last_session_timestamp: null,
      },
    };
    const result = updateCooldownState(stability, 0, 1); // score 0 < threshold 1
    assert.strictEqual(result.cooldown.consecutive_stable_sessions, 0);
  });

  it('returns unchanged for non-UNSTABLE models', () => {
    const stability = { stability_status: 'STABLE' };
    const result = updateCooldownState(stability, 2, 1);
    assert.deepStrictEqual(result, stability);
  });

  it('returns null/undefined unchanged', () => {
    assert.strictEqual(updateCooldownState(null, 2, 1), null);
    assert.strictEqual(updateCooldownState(undefined, 2, 1), undefined);
  });
});

// ── createUnstableEntry ──────────────────────────────────────────────────────

describe('createUnstableEntry', () => {
  it('returns correct structure with all required fields', () => {
    const entry = createUnstableEntry(5);
    assert.strictEqual(entry.stability_status, 'UNSTABLE');
    assert.strictEqual(entry.direction_changes, 5);
    assert.ok(entry.flagged_at);
    assert.ok(entry.cooldown);
  });

  it('sets consecutive_stable_sessions to 0', () => {
    const entry = createUnstableEntry(3);
    assert.strictEqual(entry.cooldown.consecutive_stable_sessions, 0);
  });

  it('sets required_sessions to 3 and required_wall_time_ms to 3600000', () => {
    const entry = createUnstableEntry(3);
    assert.strictEqual(entry.cooldown.required_sessions, 3);
    assert.strictEqual(entry.cooldown.required_wall_time_ms, 3600000);
  });

  it('sets last_session_timestamp to null', () => {
    const entry = createUnstableEntry(3);
    assert.strictEqual(entry.cooldown.last_session_timestamp, null);
  });
});

// ── Constants ────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('LEVEL_ORDER has 3 levels', () => {
    assert.strictEqual(LEVEL_ORDER.length, 3);
    assert.deepStrictEqual(LEVEL_ORDER, ['ADVISORY', 'SOFT_GATE', 'HARD_GATE']);
  });

  it('DEFAULT_FLIP_FLOP_THRESHOLD is 3', () => {
    assert.strictEqual(DEFAULT_FLIP_FLOP_THRESHOLD, 3);
  });

  it('DEFAULT_REQUIRED_SESSIONS is 3', () => {
    assert.strictEqual(DEFAULT_REQUIRED_SESSIONS, 3);
  });

  it('DEFAULT_REQUIRED_WALL_TIME_MS is 3600000', () => {
    assert.strictEqual(DEFAULT_REQUIRED_WALL_TIME_MS, 3600000);
  });
});

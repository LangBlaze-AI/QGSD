#!/usr/bin/env node
'use strict';

/**
 * gate-stability.cjs — Flip-flop detection and cooldown enforcement for gate promotions.
 *
 * Scans promotion-changelog.json for direction alternations (promote/demote flip-flops)
 * and enforces a configurable cooldown window before re-promotion of unstable models.
 *
 * Requirements: STAB-01, STAB-02
 */

// ── Constants ────────────────────────────────────────────────────────────────

const LEVEL_ORDER = ['ADVISORY', 'SOFT_GATE', 'HARD_GATE'];
const DEFAULT_FLIP_FLOP_THRESHOLD = 3;
const DEFAULT_REQUIRED_SESSIONS = 3;
const DEFAULT_REQUIRED_WALL_TIME_MS = 3600000; // 1 hour

// ── Flip-Flop Detection (STAB-01) ────────────────────────────────────────────

/**
 * Counts direction alternations in a sequence of changelog entries for a single model.
 *
 * A "direction change" occurs when consecutive transitions go in opposite directions
 * (e.g., up then down). Same-direction consecutive entries do NOT count as alternations —
 * this prevents duplicate changelog entries from inflating the count (Pitfall 1).
 *
 * @param {Array<{from_level: string, to_level: string}>} entries - Changelog entries for one model
 * @returns {number} Number of direction alternations
 */
function countDirectionChanges(entries) {
  if (!Array.isArray(entries) || entries.length < 2) return 0;

  let changes = 0;
  let lastDirection = null; // 'up' or 'down'

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    // Skip null/non-object entries (e.g. trailing garbage / partially-written records)
    if (!e || typeof e !== 'object') continue;

    const fromIdx = LEVEL_ORDER.indexOf(e.from_level);
    const toIdx = LEVEL_ORDER.indexOf(e.to_level);

    // Skip entries with unknown levels or same-level transitions
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) continue;

    const direction = toIdx > fromIdx ? 'up' : 'down';

    if (lastDirection !== null && direction !== lastDirection) {
      changes++;
    }
    lastDirection = direction;
  }

  return changes;
}

/**
 * Detects models with flip-flop patterns in the promotion changelog.
 *
 * Groups entries by model, counts direction alternations for each, and returns
 * models exceeding the threshold.
 *
 * @param {Array} changelog - Full promotion changelog array
 * @param {number} [threshold=3] - Minimum direction changes to flag as unstable
 * @returns {Object} Map of model path -> { direction_changes, flagged_at }
 */
function detectFlipFlops(changelog, threshold) {
  threshold = threshold != null ? threshold : DEFAULT_FLIP_FLOP_THRESHOLD;

  if (!Array.isArray(changelog) || changelog.length === 0) return {};

  // Group entries by model (null-proto so '__proto__'/'constructor' model paths
  // are ordinary own keys instead of hitting inherited getters/setters)
  const byModel = Object.create(null);
  for (const entry of changelog) {
    if (!entry || !entry.model) continue;
    if (!byModel[entry.model]) byModel[entry.model] = [];
    byModel[entry.model].push(entry);
  }

  // Detect flip-flops per model
  const unstable = {};
  for (const [model, entries] of Object.entries(byModel)) {
    const directionChanges = countDirectionChanges(entries);
    if (directionChanges >= threshold) {
      // defineProperty so a '__proto__' model path is recorded as a plain own
      // key instead of mutating the result object's prototype.
      Object.defineProperty(unstable, model, {
        value: {
          direction_changes: directionChanges,
          flagged_at: new Date().toISOString(),
        },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }

  return unstable;
}

// ── Cooldown Enforcement (STAB-02) ───────────────────────────────────────────

/**
 * Checks whether a model's cooldown period has been satisfied.
 *
 * Both conditions must be met:
 * 1. consecutive_stable_sessions >= required_sessions
 * 2. Wall time since flagging >= required_wall_time_ms
 *
 * @param {Object|null|undefined} stabilityInfo - Model's stability object from per-model-gates.json
 * @returns {boolean} true if no cooldown needed or cooldown is satisfied
 */
function isCooldownSatisfied(stabilityInfo) {
  if (!stabilityInfo || stabilityInfo.stability_status !== 'UNSTABLE') return true;

  const cooldown = stabilityInfo.cooldown;
  if (!cooldown) return true;

  const sessionsMet = cooldown.consecutive_stable_sessions >= (cooldown.required_sessions || DEFAULT_REQUIRED_SESSIONS);
  const elapsed = Date.now() - new Date(stabilityInfo.flagged_at).getTime();
  const wallTimeMet = elapsed >= (cooldown.required_wall_time_ms || DEFAULT_REQUIRED_WALL_TIME_MS);

  return sessionsMet && wallTimeMet;
}

/**
 * Updates cooldown counters for a model after a solve session.
 *
 * If the model still passes the gate threshold, increments consecutive_stable_sessions.
 * If the model regressed (score dropped), resets counter to 0 (Pitfall 3).
 *
 * @param {Object} existingStability - Current stability object for the model
 * @param {number} currentGateScore - Model's current evidence/maturity score
 * @param {number} gateThreshold - Score threshold the model needs to sustain
 * @returns {Object} Updated stability object
 */
function updateCooldownState(existingStability, currentGateScore, gateThreshold) {
  if (!existingStability || existingStability.stability_status !== 'UNSTABLE') {
    return existingStability;
  }

  const updated = JSON.parse(JSON.stringify(existingStability)); // deep copy

  if (!updated.cooldown) {
    updated.cooldown = {
      consecutive_stable_sessions: 0,
      required_sessions: DEFAULT_REQUIRED_SESSIONS,
      required_wall_time_ms: DEFAULT_REQUIRED_WALL_TIME_MS,
      last_session_timestamp: null,
    };
  }

  if (currentGateScore >= gateThreshold) {
    // Model still passes — increment counter
    updated.cooldown.consecutive_stable_sessions++;
    updated.cooldown.last_session_timestamp = new Date().toISOString();
  } else {
    // Model regressed — reset counter (Pitfall 3)
    updated.cooldown.consecutive_stable_sessions = 0;
  }

  return updated;
}

/**
 * Creates a fresh UNSTABLE stability entry for a newly flagged model.
 *
 * @param {number} directionChanges - Number of direction alternations detected
 * @returns {Object} Fresh UNSTABLE stability object with cooldown initialized
 */
function createUnstableEntry(directionChanges) {
  return {
    stability_status: 'UNSTABLE',
    direction_changes: directionChanges,
    flagged_at: new Date().toISOString(),
    cooldown: {
      consecutive_stable_sessions: 0,
      required_sessions: DEFAULT_REQUIRED_SESSIONS,
      required_wall_time_ms: DEFAULT_REQUIRED_WALL_TIME_MS,
      last_session_timestamp: null,
    },
  };
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Functions
  countDirectionChanges,
  detectFlipFlops,
  isCooldownSatisfied,
  updateCooldownState,
  createUnstableEntry,
  // Constants
  LEVEL_ORDER,
  DEFAULT_FLIP_FLOP_THRESHOLD,
  DEFAULT_REQUIRED_SESSIONS,
  DEFAULT_REQUIRED_WALL_TIME_MS,
};

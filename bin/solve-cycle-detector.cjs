'use strict';

/**
 * solve-cycle-detector.cjs — Detects oscillation patterns in per-layer
 * residual history across solve iterations.
 *
 * Supports:
 *   - A-B-A-B (2-point) oscillation detection (original CONV-01)
 *   - N-layer cycle detection (depth 2-4) via state hashing (QUICK-342)
 *   - Per-layer bounce counting with auto-block after threshold
 *
 * Requirements: CONV-01, QUICK-342
 */

const crypto = require('crypto');
const { LAYER_KEYS } = require('./layer-constants.cjs');

/**
 * Detect oscillating layers from a history object.
 * A layer oscillates when values[i] === values[i-2] for at least 2 consecutive
 * pairs starting from index 2 (spanning 4+ points: A-B-A-B).
 *
 * @param {Object<string, number[]>} history - layer name -> residual values per iteration
 * @returns {string[]} layer keys exhibiting A-B-A-B oscillation
 */
function detectCycles(history) {
  if (!history || typeof history !== 'object') return [];

  const oscillating = [];

  for (const [layer, values] of Object.entries(history)) {
    if (!Array.isArray(values) || values.length < 4) continue;

    // Check for A-B-A-B pattern: values[i]===values[i-2] AND values[i+1]===values[i-1]
    // spanning any consecutive 4-point window
    let found = false;
    for (let i = 2; i < values.length - 1; i++) {
      // Require that the "alternating" values are actually different (A !== B)
      if (values[i] === values[i - 2] && values[i + 1] === values[i - 1] && values[i] !== values[i - 1]) {
        found = true;
        break;
      }
    }

    if (found) {
      oscillating.push(layer);
    }
  }

  return oscillating;
}

/**
 * Hash a residual state vector into a compact string for cycle detection.
 * Only includes automatable layers to avoid noise from informational signals.
 *
 * @param {Object<string, number>} perLayerResiduals - layer -> residual value
 * @returns {string} SHA-256 hex digest (first 16 chars)
 */
function hashState(perLayerResiduals) {
  if (!perLayerResiduals || typeof perLayerResiduals !== 'object') {
    return crypto.createHash('sha256').update('empty').digest('hex').slice(0, 16);
  }

  const sorted = Object.keys(perLayerResiduals).sort();
  const values = sorted.map(k => `${k}:${perLayerResiduals[k]}`).join('|');
  return crypto.createHash('sha256').update(values).digest('hex').slice(0, 16);
}

/**
 * Detect N-length cycles in state hash history.
 * Checks if stateHash[i] === stateHash[i-K] for K in [2, 3, 4].
 *
 * @param {string[]} stateHashes - array of state hashes, one per iteration
 * @returns {{ detected: boolean, cycle_length: number|null }}
 */
function detectStateCycles(stateHashes) {
  if (!Array.isArray(stateHashes) || stateHashes.length < 4) {
    return { detected: false, cycle_length: null };
  }

  const latest = stateHashes.length - 1;

  // Check for cycles of length K = 2, 3, 4
  for (const K of [2, 3, 4]) {
    if (latest >= K && stateHashes[latest] === stateHashes[latest - K]) {
      // Ensure the cycle involves at least 2 distinct states
      const cycleWindow = stateHashes.slice(latest - K + 1, latest + 1);
      const uniqueInCycle = new Set(cycleWindow);
      if (uniqueInCycle.size < 2) continue; // constant state is not a cycle

      if (latest >= 2 * K && stateHashes[latest - K] === stateHashes[latest - 2 * K]) {
        return { detected: true, cycle_length: K };
      }
      // Single match is still worth reporting if we don't have enough history for double-check
      if (latest < 2 * K) {
        return { detected: true, cycle_length: K };
      }
    }
  }

  return { detected: false, cycle_length: null };
}

/**
 * Count direction changes ("bounces") for a single layer's residual history.
 * A bounce = residual went up then down, or down then up.
 *
 * @param {number[]} values - residual values over iterations
 * @returns {number} bounce count
 */
function countBounces(values) {
  if (!Array.isArray(values) || values.length < 3) return 0;

  let bounces = 0;
  for (let i = 2; i < values.length; i++) {
    const prev = values[i - 1] - values[i - 2]; // previous direction
    const curr = values[i] - values[i - 1];     // current direction
    // Bounce: direction changed sign (up->down or down->up), excluding flat segments
    if ((prev > 0 && curr < 0) || (prev < 0 && curr > 0)) {
      bounces++;
    }
  }
  return bounces;
}

/**
 * Stateful cycle detector that accumulates per-layer residual history
 * across iterations and detects oscillation patterns.
 *
 * Enhanced with:
 *   - N-layer cycle detection via full-state hashing (QUICK-342)
 *   - Per-layer bounce counting with auto-block threshold
 */
class CycleDetector {
  /**
   * @param {{ bounce_threshold?: number }} opts
   */
  constructor(opts = {}) {
    /** @type {Object<string, number[]>} */
    this.history = Object.create(null);
    /** @type {string[]} state hashes per iteration */
    this.stateHashes = [];
    /** @type {number} bounces before auto-blocking a layer */
    this.bounceThreshold = (opts && typeof opts === 'object' ? opts.bounce_threshold : undefined) ?? 2;
  }

  /**
   * Record per-layer residuals for an iteration.
   *
   * @param {number} iteration - iteration number (informational)
   * @param {Object<string, number>} perLayerResiduals - e.g. { r_to_f: 3, f_to_t: 0, ... }
   */
  record(iteration, perLayerResiduals) {
    if (!perLayerResiduals || typeof perLayerResiduals !== 'object') return;

    // Filter to numeric values only (consistent between history and hash)
    const numericResiduals = {};
    for (const [layer, value] of Object.entries(perLayerResiduals)) {
      if (typeof value !== 'number') continue;
      numericResiduals[layer] = value;

      // Record in history
      if (!this.history[layer]) {
        this.history[layer] = [];
      }
      this.history[layer].push(value);
    }

    // Record state hash for N-cycle detection (use same filtered data as history)
    this.stateHashes.push(hashState(numericResiduals));
  }

  /**
   * Detect layers exhibiting A-B-A-B oscillation patterns (original CONV-01).
   *
   * @returns {string[]} layer keys that are oscillating
   */
  detectOscillating() {
    return detectCycles(this.history);
  }

  /**
   * Detect N-length cycles in the full residual state (QUICK-342).
   *
   * @returns {{ detected: boolean, cycle_length: number|null }}
   */
  detectStateCycle() {
    return detectStateCycles(this.stateHashes);
  }

  /**
   * Get layers that have bounced more than the threshold (auto-block candidates).
   *
   * @returns {{ layer: string, bounces: number }[]} layers exceeding bounce threshold
   */
  getBlockedLayers(windowSize = 20) {
    const blocked = [];
    for (const [layer, values] of Object.entries(this.history)) {
      const recent = values.slice(-windowSize);
      const bounces = countBounces(recent);
      if (bounces >= this.bounceThreshold) {
        blocked.push({ layer, bounces });
      }
    }
    return blocked;
  }

  /**
   * Return the full history object for debugging/reporting.
   *
   * @returns {Object<string, number[]>}
   */
  getHistory() {
    return this.history;
  }

  /**
   * Return state hashes for debugging/reporting.
   *
   * @returns {string[]}
   */
  getStateHashes() {
    return this.stateHashes;
  }
}

module.exports = { CycleDetector, detectCycles, detectStateCycles, hashState, countBounces };

// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
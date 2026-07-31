#!/usr/bin/env node
'use strict';

/**
 * routing-policy.cjs — Pluggable policy interface for slot selection routing
 *
 * 3-tier progressive authority ladder:
 *   Tier 0: PresetPolicy  — static first-eligible-subprocess (bootstrap prior)
 *   Tier 1: RiverPolicy   — contextual bandit with confidence gating
 *   Tier 2: (future)      — full RL / learned routing
 *
 * PolicyResult shape (JSDoc contract):
 *   { recommendation: string|null, confidence: number, evidenceCount: number,
 *     recentStability: number, reason: string }
 *
 * Exports: PresetPolicy, RiverPolicy, RewardRecorder, selectSlotWithPolicy
 */

const fs   = require('fs');
const path = require('path');

// ─── PolicyResult factory ──────────────────────────────────────────────────
/**
 * @typedef {Object} PolicyResult
 * @property {string|null} recommendation - Provider slot name or null
 * @property {number}      confidence     - 0..1 confidence in recommendation
 * @property {number}      evidenceCount  - Number of reward samples backing this
 * @property {number}      recentStability - 1 - stddev of recent rewards (0..1)
 * @property {string}      reason         - Human-readable explanation
 */
function makePolicyResult({ recommendation = null, confidence = 0, evidenceCount = 0, recentStability = 1.0, reason = '' } = {}) {
  return { recommendation, confidence, evidenceCount, recentStability, reason };
}

// ─── PresetPolicy (Tier 0) ─────────────────────────────────────────────────
/**
 * Bootstrap prior — always available, never fails.
 * Implements identical logic to the original selectSlot: first subprocess
 * provider with has_file_access === true.
 */
class PresetPolicy {
  /**
   * @param {string} taskType - e.g., "implement", "fix", "refactor", "test"
   * @param {Array}  providers - array of provider objects from providers.json
   * @param {string|object} [routingHint] - optional hint: slot name string or { executor: string }
   * @returns {PolicyResult}
   */
  recommend(taskType, providers, routingHint) {
    if (!Array.isArray(providers)) {
      return makePolicyResult({ reason: 'preset:no-providers' });
    }

    // Routing hint preference: if a valid hint is provided and matches an eligible slot, prefer it
    if (routingHint) {
      const hintName = typeof routingHint === 'string'
        ? routingHint
        : (routingHint && typeof routingHint.executor === 'string' ? routingHint.executor : null);

      if (hintName) {
        const hintLower = hintName.toLowerCase();
        const hinted = providers.find(
          p => p && typeof p.name === 'string' && p.name.toLowerCase().includes(hintLower) && p.type === 'subprocess' && p.has_file_access === true
        );
        if (hinted) {
          return makePolicyResult({
            recommendation: hinted.name,
            confidence: 1.0,
            evidenceCount: 0,
            recentStability: 1.0,
            reason: 'preset:routing-hint-match',
          });
        }
      }
      // Invalid or ineligible hint — fall through to first-eligible
    }

    const candidate = providers.find(
      p => p && p.type === 'subprocess' && p.has_file_access === true
    );

    if (!candidate) {
      return makePolicyResult({ reason: 'preset:no-eligible-subprocess' });
    }

    return makePolicyResult({
      recommendation: candidate.name,
      confidence: 1.0,
      evidenceCount: 0,
      recentStability: 1.0,
      reason: 'preset:first-eligible-subprocess',
    });
  }
}

// ─── RewardRecorder ────────────────────────────────────────────────────────
/**
 * Append-only JSONL reward log for routing decisions.
 * Fail-open: never throws, logs to stderr on error.
 */
class RewardRecorder {
  /**
   * @param {object} [opts]
   * @param {string} [opts.rewardsPath] - Override path for JSONL file
   */
  constructor(opts = {}) {
    this._rewardsPath = opts.rewardsPath || path.join(process.cwd(), '.nf-routing-rewards.jsonl');
  }

  /**
   * Record a reward event.
   * @param {object} entry
   * @param {string} entry.taskType
   * @param {string} entry.slot
   * @param {number} entry.reward   - 0..1
   * @param {number} [entry.latencyMs]
   * @param {string} [entry.timestamp] - ISO string, defaults to now
   */
  record({ taskType, slot, reward, latencyMs, timestamp } = {}) {
    try {
      const line = JSON.stringify({
        taskType,
        slot,
        reward,
        latencyMs: latencyMs || 0,
        timestamp: timestamp || new Date().toISOString(),
      });
      fs.appendFileSync(this._rewardsPath, line + '\n', 'utf8');
    } catch (err) {
      process.stderr.write(`[routing-policy] reward write error: ${err.message}\n`);
    }
  }

  /**
   * Read rewards filtered by taskType.
   * @param {string} taskType
   * @returns {Array<object>}
   */
  readRewards(taskType) {
    try {
      const content = fs.readFileSync(this._rewardsPath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      const entries = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.taskType === taskType) {
            entries.push(entry);
          }
        } catch (_) {
          // Skip malformed lines
        }
      }
      return entries;
    } catch (_) {
      return [];
    }
  }
}

// ─── RiverPolicy (Tier 1 — Q-learning with confidence gating) ─────────────
/**
 * Q-learning policy with Bellman updates, epsilon-greedy exploration,
 * learning rate decay, and confidence gating (minSamples, rewardMargin,
 * stability, incumbent bias, cooldown).
 *
 * Q-table structure in state file:
 *   {
 *     qTable: { "<taskType>": { "<slotName>": { q: number, visits: number, lastUpdate: ISO } } },
 *     lastProcessedIdx: { "<taskType>": number },
 *     promotions: { ... }
 *   }
 *
 * ─── Decision record (2026-07-30, river-finalization session) ─────────────
 * This pure-JS Q-learning IS the canonical Tier-1 bandit for nForma routing.
 * The Python `river` ML library was previously installed in bin/install.js but
 * never called by any JS code — the install path was a stub. The Python bridge
 * would add 50-200ms of subprocess overhead per routing decision, and the JS
 * surface already covers the use case (Bellman updates, epsilon-greedy,
 * confidence gating, incumbent bias, cooldown, shadow mode).
 *
 * If a future need arises for capabilities the JS implementation does not have
 * (e.g., drift detection on slot quality, contextual bandits with feature
 * vectors, Hoeffding trees), open a separate, scoped, quorum-ratified goal.
 * Do NOT re-introduce the Python bridge ad-hoc.
 *
 * See ~/.claude/goals/river-finalization.md for the full doctrine and
 * bin/install.js for the install-path cleanup.
 */
class RiverPolicy {
  /**
   * @param {object} [opts]
   * @param {string} [opts.statePath]    - Path to state JSON file
   * @param {string} [opts.rewardsPath]  - Path to rewards JSONL file
   * @param {object} [opts.config]       - Configuration overrides
   */
  constructor(opts = {}) {
    this._statePath = opts.statePath || path.join(process.cwd(), '.nf-river-state.json');
    this._rewardsPath = opts.rewardsPath || path.join(process.cwd(), '.nf-routing-rewards.jsonl');
    this._config = Object.assign({
      minSamples: 10,
      rewardMargin: 0.15,
      stabilityWindow: 5,
      cooldownMs: 300000,
      shadowMode: true,
      learningRate: 0.1,
      decayRate: 0.01,
      epsilon: 0.15,
      minExplore: 20,
    }, opts.config || {});
  }

  /**
   * Update Q-values for a given taskType using unprocessed rewards.
   * Bellman update: Q(s,a) = Q(s,a) + alpha * (reward - Q(s,a))
   * where alpha = learningRate / (1 + visits * decayRate)
   *
   * @param {string} taskType
   * @param {Array}  eligibleNames - array of eligible slot names
   * @returns {object} state - the updated state object
   * @private
   */
  _updateQValues(taskType, eligibleNames) {
    const state = this._loadState();

    // Initialize qTable and lastProcessedIdx if missing (backward compat)
    if (!state.qTable) state.qTable = {};
    if (!state.lastProcessedIdx) state.lastProcessedIdx = {};
    if (!state.qTable[taskType]) state.qTable[taskType] = {};

    // Ensure all eligible arms have entries
    for (const name of eligibleNames) {
      if (!state.qTable[taskType][name]) {
        state.qTable[taskType][name] = { q: 0, visits: 0, lastUpdate: new Date().toISOString() };
      }
    }

    // Read all rewards for this taskType
    const recorder = new RewardRecorder({ rewardsPath: this._rewardsPath });
    const rewards = recorder.readRewards(taskType);

    const lastIdx = state.lastProcessedIdx[taskType] || 0;

    // Process only new rewards
    for (let i = lastIdx; i < rewards.length; i++) {
      const entry = rewards[i];
      const slotName = entry.slot;
      if (slotName === '__proto__' || slotName === 'constructor' || slotName === 'prototype') continue;
      if (!Object.prototype.hasOwnProperty.call(state.qTable[taskType], slotName)) {
        state.qTable[taskType][slotName] = { q: 0, visits: 0, lastUpdate: new Date().toISOString() };
      }

      const arm = state.qTable[taskType][slotName];
      const reward = entry.reward || 0;

      // Decaying learning rate: alpha = learningRate / (1 + visits * decayRate)
      const alpha = this._config.learningRate / (1 + arm.visits * this._config.decayRate);

      // Bellman update (single-state Q-learning: no discount factor needed)
      arm.q = arm.q + alpha * (reward - arm.q);
      arm.visits += 1;
      arm.lastUpdate = entry.timestamp || new Date().toISOString();
    }

    state.lastProcessedIdx[taskType] = rewards.length;
    this._saveState(state);

    return state;
  }

  /**
   * @param {string} taskType
   * @param {Array}  providers
   * @returns {PolicyResult}
   */
  recommend(taskType, providers) {
    if (!Array.isArray(providers)) {
      return makePolicyResult({ reason: 'river:no-providers' });
    }

    const eligible = providers.filter(
      p => p && p.type === 'subprocess' && p.has_file_access === true
    );
    if (eligible.length === 0) {
      return makePolicyResult({ reason: 'river:no-eligible-providers' });
    }

    const eligibleNames = eligible.map(p => p.name);

    // Run Q-value updates with any new rewards
    const state = this._updateQValues(taskType, eligibleNames);
    const qTableForTask = (state.qTable && state.qTable[taskType]) || {};

    // Check if we have any reward data at all
    const totalVisits = Object.values(qTableForTask).reduce((s, arm) => s + (arm.visits || 0), 0);
    if (totalVisits === 0) {
      return makePolicyResult({ reason: 'river:no-reward-data' });
    }

    // Epsilon-greedy exploration: if any eligible arm has fewer than minExplore visits,
    // defer to preset for forced exploration
    for (const name of eligibleNames) {
      const arm = qTableForTask[name];
      if (!arm || arm.visits < this._config.minExplore) {
        return makePolicyResult({ reason: 'river:exploring' });
      }
    }

    // With probability epsilon, defer to preset for exploration diversity
    if (Math.random() < this._config.epsilon) {
      return makePolicyResult({ reason: 'river:exploring' });
    }

    // Select arm with highest Q-value
    const armEntries = eligibleNames
      .map(name => [name, qTableForTask[name] || { q: 0, visits: 0 }])
      .filter(([, arm]) => arm.visits > 0)
      .sort((a, b) => b[1].q - a[1].q);

    if (armEntries.length === 0) {
      return makePolicyResult({ reason: 'river:no-arm-data' });
    }

    const [bestName, bestArm] = armEntries[0];
    const secondBestQ = armEntries.length > 1 ? armEntries[1][1].q : 0;

    // Compute per-arm statistics for confidence gates (stability from raw rewards)
    const recorder = new RewardRecorder({ rewardsPath: this._rewardsPath });
    const rewards = recorder.readRewards(taskType);
    const armStats = {};
    for (const name of eligibleNames) {
      const armRewards = rewards.filter(r => r.slot === name);
      const count = armRewards.length;
      const qEntry = qTableForTask[name] || { q: 0, visits: 0 };

      let stability = 1.0;
      if (count >= 2) {
        const window = this._config.stabilityWindow;
        const recentRewards = armRewards.slice(-window).map(r => r.reward || 0);
        if (recentRewards.length >= 2) {
          const recentMean = recentRewards.reduce((s, v) => s + v, 0) / recentRewards.length;
          const variance = recentRewards.reduce((s, v) => s + (v - recentMean) ** 2, 0) / recentRewards.length;
          stability = Math.max(0, 1 - Math.sqrt(variance));
        }
      }

      armStats[name] = { q: qEntry.q, count, stability, visits: qEntry.visits };
    }

    const bestStats = armStats[bestName];

    // Confidence gate checks
    if (bestStats.count < this._config.minSamples) {
      return makePolicyResult({
        confidence: bestStats.q,
        evidenceCount: bestStats.count,
        recentStability: bestStats.stability,
        reason: `river:insufficient-samples (${bestStats.count} < ${this._config.minSamples})`,
      });
    }

    const margin = bestStats.q - secondBestQ;
    if (margin < this._config.rewardMargin) {
      return makePolicyResult({
        confidence: bestStats.q,
        evidenceCount: bestStats.count,
        recentStability: bestStats.stability,
        reason: `river:margin-insufficient (${margin.toFixed(3)} < ${this._config.rewardMargin})`,
      });
    }

    if (bestStats.stability < 0.7) {
      return makePolicyResult({
        confidence: bestStats.q,
        evidenceCount: bestStats.count,
        recentStability: bestStats.stability,
        reason: `river:stability-low (${bestStats.stability.toFixed(3)} < 0.7)`,
      });
    }

    // Incumbent bias: if preset winner is within margin, do not override
    const presetWinner = eligible[0] ? eligible[0].name : null;
    if (presetWinner && presetWinner !== bestName) {
      const presetStats = armStats[presetWinner];
      if (presetStats && presetStats.count > 0) {
        const incumbentMargin = bestStats.q - presetStats.q;
        if (incumbentMargin < this._config.rewardMargin) {
          return makePolicyResult({
            confidence: bestStats.q,
            evidenceCount: bestStats.count,
            recentStability: bestStats.stability,
            reason: `incumbent-bias:margin-insufficient (${incumbentMargin.toFixed(3)} < ${this._config.rewardMargin})`,
          });
        }
      }
    }

    // Cooldown check
    const lastPromotion = (state.promotions && state.promotions[taskType]) || 0;
    if (Date.now() - lastPromotion < this._config.cooldownMs) {
      return makePolicyResult({
        recommendation: bestName,
        confidence: bestStats.q,
        evidenceCount: bestStats.count,
        recentStability: bestStats.stability,
        reason: 'river:in-cooldown',
      });
    }

    // Gate passes — record promotion and return recommendation
    if (!state.promotions) state.promotions = {};
    state.promotions[taskType] = Date.now();
    this._saveState(state);

    return makePolicyResult({
      recommendation: bestName,
      confidence: bestStats.q,
      evidenceCount: bestStats.count,
      recentStability: bestStats.stability,
      reason: 'river:confidence-gate-passed',
    });
  }

  /** @private */
  _loadState() {
    try {
      const content = fs.readFileSync(this._statePath, 'utf8');
      return JSON.parse(content);
    } catch (_) {
      return {};
    }
  }

  /** @private */
  _saveState(state) {
    try {
      fs.writeFileSync(this._statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
    } catch (err) {
      process.stderr.write(`[routing-policy] state write error: ${err.message}\n`);
    }
  }
}

// ─── selectSlotWithPolicy ──────────────────────────────────────────────────
/**
 * Override chain: iterate policies from highest tier to lowest.
 * First policy whose recommendation is non-null and confidence gate passes wins.
 * Shadow mode: River recommends but preset result is returned.
 *
 * @param {string} taskType
 * @param {Array}  providers
 * @param {object} [opts]
 * @param {Array}  [opts.policies]   - Array of policy objects ordered by tier
 * @param {boolean} [opts.shadowMode] - Default true
 * @returns {{ slot: string|null, tier: number, policyResult: PolicyResult, shadow: PolicyResult|null }}
 */
function selectSlotWithPolicy(taskType, providers, opts = {}) {
  const shadowMode = opts.shadowMode !== undefined ? opts.shadowMode : true;
  const policies = opts.policies || [new PresetPolicy(), new RiverPolicy()];

  // Collect results from all policies
  const results = policies.map((p, i) => {
    try {
      // Pass routingHint to preset policy (index 0); other policies ignore it
      return i === 0 ? p.recommend(taskType, providers, opts.routingHint) : p.recommend(taskType, providers);
    } catch (_) {
      return makePolicyResult({ reason: 'policy:error' });
    }
  });

  // Preset is always tier 0 (index 0)
  const presetResult = results[0];

  // Check higher tiers (River = index 1, etc.) in reverse order (highest first)
  let shadow = null;
  for (let i = results.length - 1; i >= 1; i--) {
    const result = results[i];
    if (result.recommendation) {
      if (shadowMode) {
        // Log shadow recommendation to stderr
        process.stderr.write(
          `[routing-policy] shadow: river recommends ${result.recommendation} for ${taskType} (confidence: ${result.confidence.toFixed(3)})\n`
        );
        shadow = result;
        // Persist shadow recommendation to state file for statusline consumption
        try {
          const riverPolicy = policies.find(p => p instanceof RiverPolicy);
          if (riverPolicy) {
            let state = {};
            try { state = JSON.parse(fs.readFileSync(riverPolicy._statePath, 'utf8')); } catch (_) {}
            state.lastShadow = {
              recommendation: result.recommendation,
              confidence: result.confidence,
              taskType: taskType,
              timestamp: new Date().toISOString(),
            };
            fs.writeFileSync(riverPolicy._statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
          }
        } catch (_) { /* fail-open */ }
        // Return preset result with shadow info
        return {
          slot: presetResult.recommendation,
          tier: 0,
          policyResult: presetResult,
          shadow,
        };
      }
      // Shadow mode off — promote higher tier
      return {
        slot: result.recommendation,
        tier: i,
        policyResult: result,
        shadow: null,
      };
    }
  }

  // Clear any stale shadow recommendation from state
  try {
    const riverPolicy = policies.find(p => p instanceof RiverPolicy);
    if (riverPolicy) {
      let state = {};
      try { state = JSON.parse(fs.readFileSync(riverPolicy._statePath, 'utf8')); } catch (_) {}
      if (state.lastShadow) {
        delete state.lastShadow;
        fs.writeFileSync(riverPolicy._statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
      }
    }
  } catch (_) { /* fail-open */ }

  // Default: preset wins
  return {
    slot: presetResult.recommendation,
    tier: 0,
    policyResult: presetResult,
    shadow,
  };
}

// ─── Module exports ────────────────────────────────────────────────────────
module.exports = {
  PresetPolicy,
  RiverPolicy,
  RewardRecorder,
  selectSlotWithPolicy,
};

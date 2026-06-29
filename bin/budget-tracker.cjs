'use strict';
// bin/budget-tracker.cjs
// Token budget calculation, profile downgrade logic, and subscription slot exclusion.
// Uses only node:fs, node:path. No external dependencies.

const fs = require('fs');
const path = require('path');

// Profile downgrade sequence: quality -> balanced -> budget -> null (minimum)
const DOWNGRADE_CHAIN = { quality: 'balanced', balanced: 'budget', budget: null };

/**
 * Compute budget status from context window usage percentage.
 * @param {number} usedPct - Context window used percentage (0-100).
 * @param {object} budgetConfig - budget config section from nf.json.
 * @param {object} agentConfig - agent_config section from nf.json (unused for now, reserved for sub exclusion).
 * @returns {object} Budget status object.
 */
function computeBudgetStatus(usedPct, budgetConfig, agentConfig, cooldownActive) {
  if (!budgetConfig || budgetConfig.session_limit_tokens == null) {
    return { active: false };
  }

  const pct = Number.isFinite(usedPct) ? usedPct : 0;
  const estimatedTokens = Math.round((pct / 100) * 200000);
  const budgetUsedPct = Math.round((estimatedTokens / budgetConfig.session_limit_tokens) * 100);

  return {
    active: true,
    estimatedTokens,
    budgetUsedPct,
    shouldWarn: budgetUsedPct >= (budgetConfig.warn_pct || 60),
    shouldDowngrade: cooldownActive ? false : budgetUsedPct >= (budgetConfig.downgrade_pct || 85),
  };
}

/**
 * Check cooldown status for model downgrades.
 * @param {string} cwd - Project working directory.
 * @param {number} [cooldownMs=300000] - Cooldown period in milliseconds (default 5 minutes).
 * @returns {object} { active: boolean, lastDowngradeTs: string|null, remainingMs: number }
 */
function checkCooldown(cwd, cooldownMs) {
  const cd = typeof cooldownMs === 'number' ? cooldownMs : 300000;
  try {
    const configPath = path.join(cwd, '.planning', 'config.json');
    if (!fs.existsSync(configPath)) {
      return { active: false, lastDowngradeTs: null, remainingMs: 0 };
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const history = Array.isArray(config.downgrade_history) ? config.downgrade_history : [];
    if (history.length === 0) {
      return { active: false, lastDowngradeTs: null, remainingMs: 0 };
    }
    const last = history[history.length - 1];
    const lastTs = new Date(last.ts).getTime();
    const elapsed = Date.now() - lastTs;
    if (elapsed < cd) {
      return { active: true, lastDowngradeTs: last.ts, remainingMs: cd - elapsed };
    }
    return { active: false, lastDowngradeTs: last.ts, remainingMs: 0 };
  } catch {
    return { active: false, lastDowngradeTs: null, remainingMs: 0 };
  }
}

/**
 * Detect oscillation in downgrade history.
 * Returns true if the last 3+ entries show alternating directions within 10 minutes.
 * @param {Array} history - Array of { ts, from, to } objects.
 * @returns {boolean}
 */
function detectOscillation(history) {
  if (!Array.isArray(history) || history.length < 3) return false;
  const recent = history.slice(-3);
  // Reject malformed (null / non-object) entries before dereferencing .ts/.from/.to
  if (recent.some((e) => e === null || typeof e !== 'object')) return false;
  // Check all within 10 minutes
  const first = new Date(recent[0].ts).getTime();
  const last = new Date(recent[recent.length - 1].ts).getTime();
  if (last - first > 600000) return false; // 10 minutes

  // Check alternating: each consecutive pair must have opposite direction
  for (let i = 1; i < recent.length; i++) {
    const prevDown = DOWNGRADE_CHAIN[recent[i - 1].from] === recent[i - 1].to;
    const currDown = DOWNGRADE_CHAIN[recent[i].from] === recent[i].to;
    if (prevDown === currDown) return false; // same direction = not oscillating
  }
  return true;
}

/**
 * Trigger a model profile downgrade by writing to .planning/config.json.
 * @param {string} cwd - Project working directory.
 * @param {object} [options] - Optional parameters.
 * @param {number} [options.cooldownMs=300000] - Cooldown period in milliseconds (default 5 minutes).
 * @returns {object} Downgrade result.
 */
function triggerProfileDowngrade(cwd, options) {
  try {
    const opts = options || {};
    const cooldownMs = typeof opts.cooldownMs === 'number' ? opts.cooldownMs : 300000;

    const configPath = path.join(cwd, '.planning', 'config.json');
    let config = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    const current = config.model_profile || 'balanced';

    // Initialize downgrade_history if needed
    if (!Array.isArray(config.downgrade_history)) {
      config.downgrade_history = [];
    }

    // Check cooldown: if most recent entry is within cooldownMs, block downgrade
    if (config.downgrade_history.length > 0) {
      const lastEntry = config.downgrade_history[config.downgrade_history.length - 1];
      const elapsed = Date.now() - new Date(lastEntry.ts).getTime();
      if (elapsed < cooldownMs) {
        return { downgraded: false, reason: 'cooldown_active', current };
      }
    }

    // Detect oscillation: 3+ alternating in 10 minutes = freeze
    if (detectOscillation(config.downgrade_history)) {
      return { downgraded: false, reason: 'oscillation_detected', current };
    }

    const next = DOWNGRADE_CHAIN[current];
    if (next === undefined || next === null) {
      return { downgraded: false, current };
    }
    config.model_profile = next;

    // Append to downgrade_history and prune to 10 entries
    config.downgrade_history.push({ ts: new Date().toISOString(), from: current, to: next });
    if (config.downgrade_history.length > 10) {
      config.downgrade_history = config.downgrade_history.slice(-10);
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    return { downgraded: true, from: current, to: next };
  } catch (e) {
    return { downgraded: false, error: e.message };
  }
}

/**
 * Format a budget warning message for additionalContext injection.
 * @param {object} status - Output from computeBudgetStatus.
 * @param {object|null} downgradeResult - Output from triggerProfileDowngrade (or null).
 * @returns {string} Warning message.
 */
function formatBudgetWarning(status, downgradeResult) {
  if (status.shouldDowngrade && downgradeResult && downgradeResult.downgraded) {
    return `BUDGET ALERT: Context at ${status.budgetUsedPct}% of token budget. Model profile downgraded from '${downgradeResult.from}' to '${downgradeResult.to}'. Consider running /compact.`;
  }
  if (status.shouldWarn) {
    return `BUDGET WARNING: Context at ${status.budgetUsedPct}% of token budget (${status.estimatedTokens} estimated tokens of ${status.active ? (status.budgetUsedPct > 0 ? Math.round(status.estimatedTokens * 100 / status.budgetUsedPct) : 0) : 0} limit). Monitor usage and consider /compact at next clean boundary.`;
  }
  return '';
}

module.exports = { DOWNGRADE_CHAIN, computeBudgetStatus, triggerProfileDowngrade, formatBudgetWarning, checkCooldown, detectOscillation };

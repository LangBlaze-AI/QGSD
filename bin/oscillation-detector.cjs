#!/usr/bin/env node
'use strict';

/**
 * oscillation-detector.cjs — Per-layer trend analysis and oscillation credit enforcement.
 *
 * Reads solve-trend.jsonl, computes Mann-Kendall trend per layer, detects oscillation
 * patterns, manages oscillation credits (Option C), and writes verdicts to
 * oscillation-verdicts.json.
 *
 * Requirements: TRACK-02, OSC-01, OSC-02
 */

const fs = require('fs');
const path = require('path');

const { LAYER_KEYS } = require('./layer-constants.cjs');

// ── Constants ─────────────────────────────────────────────────────────────────

const WINDOW_SIZE = 20;
const MIN_POINTS = 5;
const Z_THRESHOLD = 1.96;

/**
 * Upstream dependency DAG: layer -> array of upstream layers.
 * When an upstream layer was remediated, downstream layers get a grace period.
 */
const LAYER_DEPS = {
  f_to_t: ['r_to_f', 'p_to_f'],
  t_to_c: ['f_to_t'],
  f_to_c: ['r_to_f', 'c_to_f'],
  d_to_c: ['r_to_d'],
};

const TAG = '[oscillation-detector]';

// ── Mann-Kendall Trend Test ───────────────────────────────────────────────────

/**
 * Implements the Mann-Kendall non-parametric trend test.
 *
 * @param {number[]} values - Time series of residual values
 * @returns {{ S: number, Z: number, trend: string }}
 */
function mannKendall(values) {
  if (!Array.isArray(values) || values.length < 2) {
    return { S: 0, Z: 0, trend: 'INSUFFICIENT_DATA' };
  }

  const n = values.length;

  // Compute S = sum of sgn(x_j - x_i) for all i < j
  let S = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const diff = values[j] - values[i];
      if (diff > 0) S++;
      else if (diff < 0) S--;
    }
  }

  // Compute variance: Var(S) = n*(n-1)*(2*n+5)/18
  const varS = (n * (n - 1) * (2 * n + 5)) / 18;

  // Compute Z score
  let Z;
  if (S > 0) {
    Z = (S - 1) / Math.sqrt(varS);
  } else if (S === 0) {
    Z = 0;
  } else {
    Z = (S + 1) / Math.sqrt(varS);
  }

  // Classify trend
  let trend;
  if (Z <= -Z_THRESHOLD) {
    trend = 'DECREASING';
  } else if (Z >= Z_THRESHOLD) {
    trend = 'INCREASING';
  } else {
    trend = 'STABLE';
  }

  return { S, Z, trend };
}

// ── Oscillation Counting ──────────────────────────────────────────────────────

/**
 * Count sign changes in consecutive deltas.
 * A sign change occurs when sgn(diff[i]) !== sgn(diff[i-1]) and neither is 0.
 *
 * @param {number[]} values - Time series of residual values
 * @returns {number} Number of sign changes
 */
function countOscillations(values) {
  if (!Array.isArray(values) || values.length < 3) return 0;

  const deltas = [];
  for (let i = 0; i < values.length - 1; i++) {
    deltas.push(values[i + 1] - values[i]);
  }

  let changes = 0;
  for (let i = 1; i < deltas.length; i++) {
    const prevSign = Math.sign(deltas[i - 1]);
    const currSign = Math.sign(deltas[i]);
    if (prevSign !== 0 && currSign !== 0 && prevSign !== currSign) {
      changes++;
    }
  }

  return changes;
}

// ── Trend Window Reader ───────────────────────────────────────────────────────

/**
 * Read last N entries from solve-trend.jsonl.
 *
 * @param {string} trendPath - Path to solve-trend.jsonl
 * @param {number} [windowSize=WINDOW_SIZE] - Number of entries to return
 * @returns {Object[]} Array of parsed entries (last windowSize valid entries)
 */
function readTrendWindow(trendPath, windowSize) {
  const ws = windowSize || WINDOW_SIZE;
  try {
    if (!fs.existsSync(trendPath)) return [];
    const content = fs.readFileSync(trendPath, 'utf8').trim();
    if (!content) return [];

    const entries = [];
    for (const line of content.split('\n')) {
      try {
        entries.push(JSON.parse(line));
      } catch (_) {
        // skip malformed lines
      }
    }

    return entries.slice(-ws);
  } catch (_) {
    return [];
  }
}

// ── Session Action Reader ─────────────────────────────────────────────────────

/**
 * Read actions from the most recent solve-session file.
 * Returns a Set of layer names that had remediation actions.
 *
 * @param {string} sessionsDir - Path to solve-sessions directory
 * @returns {Set<string>} Set of remediated layer names
 */
function readLastSessionActions(sessionsDir) {
  try {
    if (!fs.existsSync(sessionsDir)) return new Set();
    const files = fs.readdirSync(sessionsDir)
      .filter(f => f.startsWith('solve-session-') && f.endsWith('.md'))
      .sort();

    if (files.length === 0) return new Set();

    const latest = fs.readFileSync(path.join(sessionsDir, files[files.length - 1]), 'utf8');
    const remediated = new Set();

    // Scan for layer names in action lines
    for (const key of LAYER_KEYS) {
      // Match patterns like "Generated test stubs for N" (f_to_t remediation)
      // or layer key appearing in action descriptions
      const keyPattern = key.replace(/_/g, '[_\\s]');
      if (new RegExp(keyPattern, 'i').test(latest) ||
          latest.includes(key)) {
        remediated.add(key);
      }
    }

    // Specific remediation patterns
    if (latest.includes('test stubs') || latest.includes('formal-test-sync')) {
      remediated.add('f_to_t');
    }
    if (latest.includes('parameter update') || latest.includes('autoClosePtoF')) {
      remediated.add('p_to_f');
    }
    if (latest.includes('TLA+ config') || latest.includes('generate-tla-cfg')) {
      remediated.add('formal_lint');
    }
    if (latest.includes('gate maturity') || latest.includes('per-model')) {
      remediated.add('per_model_gates');
    }

    return remediated;
  } catch (_) {
    return new Set();
  }
}

// ── Verdict Update ────────────────────────────────────────────────────────────

/**
 * Main orchestration: compute and write per-layer oscillation verdicts.
 *
 * @param {Object} options
 * @param {string} options.root - Project root directory
 * @param {string} [options.trendPath] - Override path to solve-trend.jsonl
 * @param {string} [options.verdictsPath] - Override path to oscillation-verdicts.json
 * @param {string} [options.sessionsDir] - Override path to solve-sessions directory
 * @returns {Object} The verdicts object that was written
 */
function updateVerdicts(options) {
  if (!options || typeof options !== 'object') options = {};
  const root = options.root || process.cwd();
  const formalDir = path.join(root, '.planning', 'formal');
  const trendPath = options.trendPath || path.join(formalDir, 'solve-trend.jsonl');
  const verdictsPath = options.verdictsPath || path.join(formalDir, 'oscillation-verdicts.json');
  const sessionsDir = options.sessionsDir || path.join(formalDir, 'solve-sessions');

  // Read trend window
  const entries = readTrendWindow(trendPath, WINDOW_SIZE);

  // Load previous verdicts (fail-open)
  let prevVerdicts = {};
  try {
    if (fs.existsSync(verdictsPath)) {
      const raw = JSON.parse(fs.readFileSync(verdictsPath, 'utf8'));
      prevVerdicts = raw.layers || {};
    }
  } catch (_) { /* fail-open */ }

  // Build verdict structure
  const layers = {};

  // If insufficient data, mark all as INSUFFICIENT_DATA
  if (entries.length < MIN_POINTS) {
    for (const key of LAYER_KEYS) {
      layers[key] = {
        trend: 'INSUFFICIENT_DATA',
        z_score: 0,
        oscillation_count: 0,
        credits_remaining: 1,
        blocked: false,
        last_direction: null,
        grace_period: false,
      };
    }

    const verdicts = {
      generated: new Date().toISOString(),
      window_size: WINDOW_SIZE,
      min_points: MIN_POINTS,
      entry_count: entries.length,
      layers,
    };

    writeVerdictsAtomic(verdictsPath, verdicts);
    return verdicts;
  }

  // Read last session actions for cascade grace period
  const remediatedLayers = readLastSessionActions(sessionsDir);

  // Process each layer
  for (const key of LAYER_KEYS) {
    // Extract layer residual series, filtering out -1 (fast-mode skipped)
    const series = [];
    for (const entry of entries) {
      const val = entry && entry.per_layer && entry.per_layer[key];
      if (typeof val === 'number' && val >= 0) {
        series.push(val);
      }
    }

    if (series.length < MIN_POINTS) {
      layers[key] = {
        trend: 'INSUFFICIENT_DATA',
        z_score: 0,
        oscillation_count: 0,
        credits_remaining: (prevVerdicts[key] && typeof prevVerdicts[key].credits_remaining === 'number')
          ? prevVerdicts[key].credits_remaining : 1,
        blocked: false,
        last_direction: null,
        grace_period: false,
      };
      continue;
    }

    // Mann-Kendall trend
    const mk = mannKendall(series);
    const oscCount = countOscillations(series);

    // Determine last direction from most recent delta
    let lastDirection = null;
    if (series.length >= 2) {
      const lastDelta = series[series.length - 1] - series[series.length - 2];
      if (lastDelta > 0) lastDirection = 'up';
      else if (lastDelta < 0) lastDirection = 'down';
      else lastDirection = 'flat';
    }

    // Check cascade grace period
    const upstreams = LAYER_DEPS[key] || [];
    const hasGrace = upstreams.some(u => remediatedLayers.has(u));

    // Compute oscillation credits
    const prevCredit = (prevVerdicts[key] && typeof prevVerdicts[key].credits_remaining === 'number')
      ? prevVerdicts[key].credits_remaining : 1;
    const prevDirection = prevVerdicts[key] ? prevVerdicts[key].last_direction : null;

    let credits = prevCredit;

    // Direction change detection (only consume credit if not in grace period)
    if (prevDirection && lastDirection &&
        prevDirection !== lastDirection &&
        prevDirection !== 'flat' && lastDirection !== 'flat' &&
        !hasGrace) {
      credits = Math.max(0, credits - 1);
    }

    const blocked = credits <= 0;

    // Override trend to OSCILLATING if oscillation_count >= 2 and Mann-Kendall is STABLE
    let finalTrend = mk.trend;
    if (oscCount >= 2 && mk.trend === 'STABLE') {
      finalTrend = 'OSCILLATING';
    }

    layers[key] = {
      trend: finalTrend,
      z_score: mk.Z,
      oscillation_count: oscCount,
      credits_remaining: credits,
      blocked,
      last_direction: lastDirection,
      grace_period: hasGrace,
    };
  }

  const verdicts = {
    generated: new Date().toISOString(),
    window_size: WINDOW_SIZE,
    min_points: MIN_POINTS,
    entry_count: entries.length,
    layers,
  };

  writeVerdictsAtomic(verdictsPath, verdicts);
  return verdicts;
}

/**
 * Write verdicts atomically (write to temp, then rename).
 */
function writeVerdictsAtomic(verdictsPath, verdicts) {
  try {
    const dir = path.dirname(verdictsPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = verdictsPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(verdicts, null, 2) + '\n');
    fs.renameSync(tmpPath, verdictsPath);
  } catch (e) {
    process.stderr.write(TAG + ' WARNING: could not write verdicts: ' + e.message + '\n');
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  mannKendall,
  countOscillations,
  readTrendWindow,
  readLastSessionActions,
  updateVerdicts,
  WINDOW_SIZE,
  MIN_POINTS,
  Z_THRESHOLD,
  LAYER_DEPS,
  LAYER_KEYS,
};

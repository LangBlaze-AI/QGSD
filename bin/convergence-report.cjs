#!/usr/bin/env node
'use strict';

/**
 * convergence-report.cjs — Trend sparklines, oscillation status, and action items
 * for the nf:solve convergence report section.
 *
 * Reads solve-trend.jsonl and oscillation-verdicts.json to produce a formatted
 * terminal section showing per-layer trend sparklines, oscillation status, and
 * prioritized action items.
 *
 * Requirements: INTG-02
 */

const fs = require('fs');
const path = require('path');
const { readTrendWindow } = require('./oscillation-detector.cjs');
const { LAYER_KEYS } = require('./layer-constants.cjs');

// ── Constants ─────────────────────────────────────────────────────────────────

const SPARKLINE_CHARS = '▁▂▃▄▅▆▇█';
const MISSING_CHAR = '·';
const DEFAULT_MAX_ITEMS = 3;
const TAG = '[convergence-report]';

// Human-readable layer labels
const LAYER_LABELS = {
  r_to_f: 'R->F',  f_to_t: 'F->T',  c_to_f: 'C->F',  t_to_c: 'T->C',
  f_to_c: 'F->C',  r_to_d: 'R->D',  d_to_c: 'D->C',  p_to_f: 'P->F',
  c_to_r: 'C->R',  t_to_r: 'T->R',  d_to_r: 'D->R',
  l1_to_l3: 'L1->L3', l3_to_tc: 'L3->TC',
  per_model_gates: 'Gates', git_heatmap: 'Heatmap', git_history: 'GitHist',
  formal_lint: 'FLint', hazard_model: 'Hazard',
};

// CONV-02: Bucket classification per layer
const BUCKET_MAP = {};
['r_to_f', 'f_to_t', 'c_to_f', 't_to_c', 'f_to_c', 'r_to_d', 'l1_to_l3', 'l3_to_tc'].forEach(k => { BUCKET_MAP[k] = 'automatable'; });
['d_to_c', 'c_to_r', 't_to_r', 'd_to_r'].forEach(k => { BUCKET_MAP[k] = 'manual'; });
['git_heatmap', 'git_history', 'formal_lint', 'hazard_model', 'per_model_gates', 'p_to_f'].forEach(k => { BUCKET_MAP[k] = 'informational'; });

// ── Sparkline Generation ─────────────────────────────────────────────────────

/**
 * Generate a Unicode sparkline string from a series of numeric values.
 *
 * @param {number[]} values - Residual values (-1 = missing/skipped)
 * @returns {string} Sparkline string
 */
function generateSparkline(values) {
  if (!Array.isArray(values) || values.length === 0) return '';

  // Separate valid and missing values
  const validValues = values.filter(v => v >= 0);

  if (validValues.length === 0) {
    return values.map(() => MISSING_CHAR).join('');
  }

  const min = Math.min(...validValues);
  const max = Math.max(...validValues);

  return values.map(v => {
    if (v < 0) return MISSING_CHAR;
    if (min === max) return SPARKLINE_CHARS[4]; // middle level
    const index = Math.round(((v - min) / (max - min)) * 7);
    return SPARKLINE_CHARS[index];
  }).join('');
}

// ── Action Item Ranking ──────────────────────────────────────────────────────

/**
 * Rank layers by actionability and return top N action items.
 *
 * @param {Object} verdicts - Per-layer verdict objects from oscillation-verdicts.json
 * @param {Object} latestResiduals - Latest per_layer residual values
 * @param {number} [maxItems=3] - Maximum number of items to return
 * @returns {Array<Object>} Sorted action items
 */
function rankActionItems(verdicts, latestResiduals, maxItems) {
  const max = typeof maxItems === 'number' ? maxItems : DEFAULT_MAX_ITEMS;
  if (!verdicts || typeof verdicts !== 'object') return [];

  const items = [];

  for (const key of LAYER_KEYS) {
    const v = verdicts[key];
    if (!v) continue;

    const residual = (latestResiduals && typeof latestResiduals[key] === 'number')
      ? latestResiduals[key] : 0;

    let priority = 0;
    let action = '';

    if (v.blocked) {
      priority = 100 + residual;
      action = `BLOCKED — oscillation detected. Run /nf:resolve ${key} for manual triage`;
    } else if (v.trend === 'INCREASING') {
      priority = 80 + residual;
      action = `Residual increasing — investigate recent changes to ${key} pipeline`;
    } else if (v.trend === 'OSCILLATING') {
      priority = 60 + residual;
      action = `Oscillating — cascade grace may resolve; monitor next 2 sessions`;
    } else if (v.trend === 'STABLE' && residual > 0) {
      priority = 40 + residual;
      action = `Stalled at ${residual} — check if layer needs manual intervention`;
    } else if (v.trend === 'INSUFFICIENT_DATA') {
      priority = 20;
      action = `Insufficient data — need more solve sessions`;
    } else if (v.trend === 'DECREASING') {
      priority = 0; // not actionable
      action = 'Making progress — no action needed';
    } else {
      continue; // skip layers with no actionable status
    }

    // Skip zero-priority items (DECREASING = making progress)
    if (priority === 0) continue;

    items.push({
      layer: key,
      label: LAYER_LABELS[key] || key,
      residual,
      trend: v.trend,
      priority,
      blocked: v.blocked || false,
      grace_period: v.grace_period || false,
      action,
    });
  }

  // Sort by priority descending
  items.sort((a, b) => b.priority - a.priority);

  return items.slice(0, max);
}

// ── Section Formatting ───────────────────────────────────────────────────────

/**
 * Generate the full convergence report section.
 *
 * @param {Object} options
 * @param {string} options.root - Project root directory
 * @param {number} [options.maxItems=3] - Max action items to show
 * @returns {string} Formatted convergence section
 */
function formatConvergenceSection(options = {}) {
  const opts = (options && typeof options === 'object') ? options : {};
  const root = opts.root || process.cwd();
  const maxItems = opts.maxItems || DEFAULT_MAX_ITEMS;
  const formalDir = path.join(root, '.planning', 'formal');
  const trendPath = path.join(formalDir, 'solve-trend.jsonl');
  const verdictsPath = path.join(formalDir, 'oscillation-verdicts.json');

  // Read trend data
  let entries;
  try {
    entries = readTrendWindow(trendPath, 20);
  } catch (_) {
    entries = [];
  }
  // Fail-open: readTrendWindow JSON.parses each line verbatim, so a corrupt
  // solve-trend.jsonl can yield non-object entries (a bare `null`, number,
  // string, or array). Drop them before any per_layer/buckets dereference.
  if (!Array.isArray(entries)) entries = [];
  entries = entries.filter(e => e && typeof e === 'object' && !Array.isArray(e));

  if (entries.length === 0) {
    return '─ Convergence Report ─────────────────────────────────\n' +
      'Convergence data unavailable — run at least 5 solve sessions to enable trend tracking\n';
  }

  // Read verdicts
  let verdicts = {};
  try {
    if (fs.existsSync(verdictsPath)) {
      const raw = JSON.parse(fs.readFileSync(verdictsPath, 'utf8'));
      verdicts = raw.layers || {};
    }
  } catch (_) { /* fail-open */ }

  // Extract latest residuals
  const latestEntry = entries[entries.length - 1];
  const latestResiduals = latestEntry.per_layer || {};

  // Build output sections
  const lines = [];

  // Section 1: Trend Sparklines
  lines.push('─ Convergence Trends (last ' + entries.length + ' sessions) ────────────────');
  lines.push(pad('Layer', 20) + pad('Trend', 18) + 'Sparkline');
  lines.push('─────────────────────────────────────────────────────────');

  let hasData = false;
  for (const key of LAYER_KEYS) {
    const series = entries.map(e => (e.per_layer && typeof e.per_layer[key] === 'number') ? e.per_layer[key] : -1);
    const validCount = series.filter(v => v >= 0).length;
    if (validCount === 0) continue;

    hasData = true;
    const sparkline = generateSparkline(series);
    const trend = (verdicts[key] && verdicts[key].trend) || 'NO_DATA';
    const label = LAYER_LABELS[key] || key;
    lines.push(pad(label, 20) + pad(trend, 18) + sparkline);
  }

  if (!hasData) {
    lines.push('  No layer data available');
  }

  lines.push('');

  // Section 1b: Residual Buckets (CONV-02)
  lines.push('─ Residual Buckets ─────────────────────────────────────');
  if (latestEntry.buckets && typeof latestEntry.buckets === 'object') {
    const b = latestEntry.buckets;
    const fmtVal = (v) => typeof v === 'number' && v >= 0 ? String(v) : '?';
    lines.push('Automatable: ' + fmtVal(b.automatable) + '  |  Manual: ' + fmtVal(b.manual) + '  |  Informational: ' + fmtVal(b.informational));
  } else {
    lines.push('Residual buckets: not yet tracked (data from pre-CONV-02 sessions)');
  }

  lines.push('');

  // Section 2: Oscillation Status
  lines.push('─ Oscillation Status ───────────────────────────────────');

  const oscLayers = [];
  for (const key of LAYER_KEYS) {
    const v = verdicts[key];
    if (!v) continue;
    if (v.oscillation_count > 0 || v.blocked || v.grace_period) {
      oscLayers.push({ key, ...v });
    }
  }

  if (oscLayers.length === 0) {
    lines.push('  All layers stable — no oscillation detected');
  } else {
    lines.push(pad('Layer', 20) + pad('Credits', 10) + pad('Blocked', 10) + 'Grace');
    lines.push('─────────────────────────────────────────────────────────');
    for (const l of oscLayers) {
      const label = LAYER_LABELS[l.key] || l.key;
      const credits = (typeof l.credits_remaining === 'number' ? l.credits_remaining : '?') + '/1';
      lines.push(
        pad(label, 20) +
        pad(credits, 10) +
        pad(l.blocked ? 'YES' : 'no', 10) +
        (l.grace_period ? 'yes' : 'no')
      );
    }
  }

  lines.push('');

  // Section 3: Action Items
  const actionItems = rankActionItems(verdicts, latestResiduals, maxItems);

  lines.push('─ Top ' + maxItems + ' Action Items ───────────────────────────────');

  if (actionItems.length === 0) {
    lines.push('  No action items — all tracked layers are converging or converged');
  } else {
    for (let i = 0; i < actionItems.length; i++) {
      const item = actionItems[i];
      const bucket = BUCKET_MAP[item.layer] || 'unknown';
      lines.push((i + 1) + '. [' + item.label + '] ' + item.action + ' [' + bucket + ']');
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Pad a string to a fixed width.
 */
function pad(str, width) {
  const s = String(str);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = { generateSparkline, rankActionItems, formatConvergenceSection };

// ── CLI Mode ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');

  let root = process.cwd();
  for (const arg of args) {
    if (arg.startsWith('--project-root=')) {
      root = path.resolve(arg.slice('--project-root='.length));
    }
  }

  let maxItems = DEFAULT_MAX_ITEMS;
  for (const arg of args) {
    if (arg.startsWith('--max-items=')) {
      const val = parseInt(arg.slice('--max-items='.length), 10);
      if (!isNaN(val) && val >= 1) maxItems = val;
    }
  }

  if (jsonMode) {
    const formalDir = path.join(root, '.planning', 'formal');
    const trendPath = path.join(formalDir, 'solve-trend.jsonl');
    const verdictsPath = path.join(formalDir, 'oscillation-verdicts.json');

    let entries = [];
    try { entries = readTrendWindow(trendPath, 20); } catch (_) {}

    let verdicts = {};
    try {
      if (fs.existsSync(verdictsPath)) {
        verdicts = JSON.parse(fs.readFileSync(verdictsPath, 'utf8')).layers || {};
      }
    } catch (_) {}

    const latestResiduals = entries.length > 0 ? (entries[entries.length - 1].per_layer || {}) : {};
    const actionItems = rankActionItems(verdicts, latestResiduals, maxItems);

    const sparklines = {};
    for (const key of LAYER_KEYS) {
      const series = entries.map(e => (e.per_layer && typeof e.per_layer[key] === 'number') ? e.per_layer[key] : -1);
      if (series.filter(v => v >= 0).length > 0) {
        sparklines[key] = generateSparkline(series);
      }
    }

    const latestBuckets = entries.length > 0 ? (entries[entries.length - 1].buckets || null) : null;

    process.stdout.write(JSON.stringify({
      entry_count: entries.length,
      sparklines,
      verdicts,
      action_items: actionItems,
      buckets: latestBuckets,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(formatConvergenceSection({ root, maxItems }));
  }
}

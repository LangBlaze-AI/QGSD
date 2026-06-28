#!/usr/bin/env node
'use strict';

/**
 * predictive-power.cjs — Bug-to-property linking, per-model recall scoring,
 * convergence velocity estimation.
 *
 * Requirements: PRED-01, PRED-02, TRACK-03
 */

const fs = require('fs');
const path = require('path');
const { readTrendWindow } = require('./oscillation-detector.cjs');
const { LAYER_KEYS } = require('./layer-constants.cjs');

// ── Bug-to-Property Linking (PRED-01) ────────────────────────────────────────

/**
 * Links observed bugs (from debt.json) to formal properties (from model-registry.json)
 * that could have caught them, using requirement ID overlap as the JOIN key.
 *
 * @param {string} debtPath - Path to debt.json
 * @param {string} registryPath - Path to model-registry.json
 * @returns {Object} Mapping object with schema_version, total_bugs, total_linked, mappings
 */
function linkBugsToProperties(debtPath, registryPath) {
  let debt;
  try {
    debt = JSON.parse(fs.readFileSync(debtPath, 'utf8'));
  } catch (e) {
    process.stderr.write('[predictive-power] WARNING: cannot read debt.json: ' + e.message + '\n');
    return { schema_version: '1', total_bugs: 0, total_linked: 0, mappings: [] };
  }

  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (e) {
    process.stderr.write('[predictive-power] WARNING: cannot read model-registry.json: ' + e.message + '\n');
    return { schema_version: '1', total_bugs: 0, total_linked: 0, mappings: [] };
  }

  const models = (registry && typeof registry === 'object') ? (registry.models || registry) : {};
  const entries = (debt && typeof debt === 'object' && Array.isArray(debt.debt_entries)) ? debt.debt_entries : [];
  const mappings = [];
  let totalLinked = 0;

  for (const entry of entries) {
    const refs = entry.formal_refs || [];

    if (refs.length === 0) {
      // Unlinked bug — no formal_refs
      mappings.push({
        bug_id: entry.id,
        bug_fingerprint: entry.fingerprint,
        bug_title: (entry.title || '').slice(0, 120),
        source_type: entry.source_entries?.[0]?.source_type || 'unknown',
        formal_refs: [],
        matching_models: [],
        predicted: false,
      });
      continue;
    }

    const matching = [];
    for (const [modelPath, model] of Object.entries(models)) {
      // Filter to only model paths starting with '.'
      if (!modelPath.startsWith('.')) continue;
      if (!model || typeof model !== 'object') continue;
      const overlap = (model.requirements || []).filter(r => refs.includes(r));
      if (overlap.length > 0) {
        matching.push({
          model_path: modelPath,
          requirements_overlap: overlap,
          gate_maturity: model.gate_maturity || 'ADVISORY',
          layer_maturity: model.layer_maturity || 0,
        });
      }
    }

    mappings.push({
      bug_id: entry.id,
      bug_fingerprint: entry.fingerprint,
      bug_title: (entry.title || '').slice(0, 120),
      source_type: entry.source_entries?.[0]?.source_type || 'unknown',
      formal_refs: refs,
      matching_models: matching,
      predicted: matching.length > 0,
    });

    if (matching.length > 0) totalLinked++;
  }

  return {
    schema_version: '1',
    total_bugs: mappings.length,
    total_linked: totalLinked,
    mappings,
  };
}

/**
 * Convenience writer — writes mapping object to outputPath as formatted JSON.
 *
 * @param {Object} mappingObj - Mapping object from linkBugsToProperties
 * @param {string} outputPath - Path to write bug-to-property.json
 */
function writeBugToProperty(mappingObj, outputPath) {
  const output = Object.assign({}, mappingObj, {
    generated: new Date().toISOString(),
  });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
}

// ── Per-Model Recall (PRED-02) ───────────────────────────────────────────────

/**
 * Computes per-model recall: bugs_predicted / total_relevant_bugs.
 *
 * A bug is "predicted" if the model passes gate_a (grounding) in per-model-gates.json.
 * Recall is INFORMATIONAL ONLY — not used as a gate input (PRED-03 deferred).
 *
 * @param {Array} mappings - mappings array from linkBugsToProperties result
 * @param {string} perModelGatesPath - Path to per-model-gates.json
 * @returns {Object} Map of model_path -> { relevant, predicted, recall }
 */
function computePerModelRecall(mappings, perModelGatesPath) {
  // Fail-open on missing per-model-gates.json
  let perModelGates = {};
  try {
    perModelGates = JSON.parse(fs.readFileSync(perModelGatesPath, 'utf8'));
  } catch (e) {
    process.stderr.write('[predictive-power] WARNING: cannot read per-model-gates.json: ' + e.message + '\n');
    return {};
  }

  const recall = {};

  for (const mapping of mappings) {
    for (const match of mapping.matching_models) {
      if (!recall[match.model_path]) {
        recall[match.model_path] = { relevant: 0, predicted: 0 };
      }
      recall[match.model_path].relevant++;

      // A bug is "predicted" if the model passes gate_a
      const gates = perModelGates[match.model_path];
      if (gates && gates.gate_a && gates.gate_a.pass) {
        recall[match.model_path].predicted++;
      }
    }
  }

  // Compute recall scores
  for (const [model, counts] of Object.entries(recall)) {
    counts.recall = counts.relevant > 0
      ? +(counts.predicted / counts.relevant).toFixed(4)
      : 0;
  }

  return recall;
}

// ── Recall Summary ───────────────────────────────────────────────────────────

/**
 * Formats a human-readable recall summary (top-5 models, aggregate stats).
 * Kept under 15 lines for solve report integration.
 *
 * @param {Object} recallScores - Map from computePerModelRecall
 * @returns {string} Formatted summary
 */
function formatRecallSummary(recallScores) {
  if (!recallScores || Object.keys(recallScores).length === 0) {
    return '--- Recall ---\nNo recall data available.\n';
  }

  const entries = Object.entries(recallScores);
  const total = entries.length;
  const avgRecall = entries.reduce((sum, [, v]) => sum + v.recall, 0) / total;

  // Top 5 by recall
  const sorted = entries
    .sort(([, a], [, b]) => b.recall - a.recall)
    .slice(0, 5);

  const lines = [
    '--- Recall ---',
    `Models scored: ${total} | Avg recall: ${avgRecall.toFixed(4)}`,
    'Top models by recall:',
  ];

  for (const [model, counts] of sorted) {
    const shortName = path.basename(model);
    lines.push(`  ${shortName}: ${counts.recall} (${counts.predicted}/${counts.relevant})`);
  }

  return lines.join('\n') + '\n';
}

// ── Convergence Velocity (TRACK-03) ──────────────────────────────────────────

/**
 * Fits exponential decay y = a * exp(-lambda * t) to a series of residual values.
 * Uses linearized OLS on log-transformed data.
 *
 * @param {number[]} values - Residual values in chronological order
 * @returns {Object} { status, lambda?, a?, sessions_to_convergence? }
 */
function fitExponentialDecay(values) {
  // Filter out values <= 0 (can't log-transform; also covers -1 fast-mode entries)
  const valid = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] > 0) valid.push({ t: i, y: values[i] });
  }

  if (valid.length < 10) return { status: 'INSUFFICIENT_DATA' };

  // All values are the same (no decay)
  if (valid.every(v => v.y === valid[0].y)) {
    return { status: 'STABLE', lambda: 0, sessions_to_convergence: null };
  }

  // Linearize: ln(y) = ln(a) - lambda * t
  const n = valid.length;
  let sumT = 0, sumLnY = 0, sumTLnY = 0, sumT2 = 0;
  for (const { t, y } of valid) {
    const lnY = Math.log(y);
    sumT += t;
    sumLnY += lnY;
    sumTLnY += t * lnY;
    sumT2 += t * t;
  }

  const denom = n * sumT2 - sumT * sumT;
  if (Math.abs(denom) < 1e-12) return { status: 'DEGENERATE' };

  const slope = (n * sumTLnY - sumT * sumLnY) / denom;
  const intercept = (sumLnY - slope * sumT) / n;

  const lambda = -slope;
  const a = Math.exp(intercept);

  if (lambda <= 0) return { status: 'NOT_CONVERGING', lambda, a };

  // Estimate sessions to reach threshold (0.5 residual)
  const threshold = 0.5;
  const currentResidual = values[values.length - 1];
  if (currentResidual <= threshold) {
    return { status: 'CONVERGED', lambda: +lambda.toFixed(6), a: +a.toFixed(4), sessions_to_convergence: 0 };
  }

  const sessions = Math.ceil(Math.log(currentResidual / threshold) / lambda);

  return {
    status: 'CONVERGING',
    lambda: +lambda.toFixed(6),
    a: +a.toFixed(4),
    sessions_to_convergence: sessions,
  };
}

/**
 * Computes convergence velocity per layer from solve-trend JSONL data.
 *
 * @param {string} trendPath - Path to solve-trend.jsonl
 * @param {Object} [opts] - Options
 * @param {number} [opts.windowSize=30] - Window size for trend entries
 * @returns {Object} Map of layer name -> { status, lambda?, a?, sessions_to_convergence? }
 */
function computeConvergenceVelocity(trendPath, opts) {
  opts = opts || {};
  const windowSize = opts.windowSize || 30;

  // First-run / missing JSONL: return all layers as INSUFFICIENT_DATA
  let entries;
  try {
    entries = readTrendWindow(trendPath, windowSize);
  } catch (e) {
    process.stderr.write('[predictive-power] WARNING: cannot read solve-trend.jsonl: ' + e.message + '\n');
    const result = {};
    for (const key of LAYER_KEYS) result[key] = { status: 'INSUFFICIENT_DATA' };
    return result;
  }

  if (!entries || entries.length === 0) {
    const result = {};
    for (const key of LAYER_KEYS) result[key] = { status: 'INSUFFICIENT_DATA' };
    return result;
  }

  const result = {};
  for (const key of LAYER_KEYS) {
    // Extract residual values for this layer, filter -1 (skipped) for clarity
    const values = entries
      .map(e => (e && e.layers && e.layers[key] != null) ? e.layers[key] : -1)
      .filter(v => v >= 0);

    if (values.length === 0) {
      result[key] = { status: 'INSUFFICIENT_DATA' };
    } else {
      result[key] = fitExponentialDecay(values);
    }
  }

  return result;
}

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * Main orchestration function — runs linking, recall, and velocity in one call.
 * Called from nf-solve.cjs after updateVerdicts.
 *
 * @param {Object} opts - Options
 * @param {string} opts.root - Project root path
 * @returns {Object} { linking, recall, velocity }
 */
function updatePredictivePower(opts) {
  const root = opts.root || process.cwd();
  const formalDir = path.join(root, '.planning', 'formal');

  try {
    const debtPath = path.join(formalDir, 'debt.json');
    const registryPath = path.join(formalDir, 'model-registry.json');
    const perModelGatesPath = path.join(formalDir, 'per-model-gates.json');
    const bugToPropertyPath = path.join(formalDir, 'bug-to-property.json');
    const trendPath = path.join(formalDir, 'solve-trend.jsonl');

    // 1. Bug-to-property linking (PRED-01)
    const linkingResult = linkBugsToProperties(debtPath, registryPath);
    writeBugToProperty(linkingResult, bugToPropertyPath);

    // 2. Per-model recall (PRED-02)
    const recallScores = computePerModelRecall(linkingResult.mappings, perModelGatesPath);

    // 3. Convergence velocity (TRACK-03)
    const velocity = computeConvergenceVelocity(trendPath);

    return { linking: linkingResult, recall: recallScores, velocity };
  } catch (e) {
    process.stderr.write('[predictive-power] WARNING: updatePredictivePower failed: ' + e.message + '\n');
    return { linking: null, recall: null, velocity: null };
  }
}

/**
 * Formats a combined predictive power summary for the solve report.
 * Combines recall + velocity into a compact section (under 25 lines).
 *
 * @param {Object} results - From updatePredictivePower
 * @returns {string} Formatted summary
 */
function formatPredictivePowerSummary(results) {
  if (!results) {
    return '--- Predictive Power ---\nNo data available.\n';
  }

  const lines = ['--- Predictive Power ---'];

  // Linking summary
  if (results.linking) {
    lines.push(`Bugs: ${results.linking.total_bugs} total, ${results.linking.total_linked} linked to formal properties`);
  }

  // Recall summary
  if (results.recall && Object.keys(results.recall).length > 0) {
    const entries = Object.entries(results.recall);
    const avgRecall = entries.reduce((sum, [, v]) => sum + v.recall, 0) / entries.length;
    const top3 = entries.sort(([, a], [, b]) => b.recall - a.recall).slice(0, 3);
    lines.push(`Recall: ${entries.length} models scored, avg ${avgRecall.toFixed(4)}`);
    for (const [model, counts] of top3) {
      lines.push(`  ${path.basename(model)}: ${counts.recall} (${counts.predicted}/${counts.relevant})`);
    }
  } else {
    lines.push('Recall: no data');
  }

  // Velocity summary
  if (results.velocity) {
    const velocityEntries = Object.entries(results.velocity);
    const converging = velocityEntries.filter(([, v]) => v.status === 'CONVERGING');
    const converged = velocityEntries.filter(([, v]) => v.status === 'CONVERGED');
    const insufficient = velocityEntries.filter(([, v]) => v.status === 'INSUFFICIENT_DATA');

    lines.push(`Velocity: ${converging.length} converging, ${converged.length} converged, ${insufficient.length} insufficient data`);
    for (const [layer, v] of converging.slice(0, 5)) {
      lines.push(`  ${layer}: ~${v.sessions_to_convergence} sessions remaining (lambda=${v.lambda})`);
    }
  } else {
    lines.push('Velocity: no data');
  }

  return lines.join('\n') + '\n';
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  linkBugsToProperties,
  writeBugToProperty,
  computePerModelRecall,
  formatRecallSummary,
  fitExponentialDecay,
  computeConvergenceVelocity,
  updatePredictivePower,
  formatPredictivePowerSummary,
};

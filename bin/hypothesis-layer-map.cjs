#!/usr/bin/env node
'use strict';
// bin/hypothesis-layer-map.cjs
// Maps hypothesis measurement source_model paths to solve-wave-dag layer keys,
// detects verdict transitions, and computes priority weights for wave ordering.
//
// Usage:
//   node bin/hypothesis-layer-map.cjs              # Human-readable output
//   node bin/hypothesis-layer-map.cjs --json       # JSON output
//
// Requirements: HTARGET-01

const fs   = require('fs');
const path = require('path');

// ── Layer Mapping Table ──────────────────────────────────────────────────────
// Maps keywords from TLA+ filenames to solve-wave-dag layer keys.
// A model may map to multiple layers or none.

const KEYWORD_TO_LAYERS = {
  oscillation:  ['c_to_r'],       // oscillation detection -> correlation-to-residual
  safety:       ['hazard_model'], // safety spec -> hazard model
  solve:        ['l1_to_l3'],     // solve convergence -> L1-to-L3 mapping
  recruit:      ['per_model_gates'], // recruiting -> per-model gates
  session:      ['git_heatmap'],  // session persistence -> git heatmap
  breaker:      ['c_to_r'],       // circuit breaker -> correlation-to-residual
  convergence:  ['l1_to_l3'],     // convergence spec -> L1-to-L3
  prefilter:    ['r_to_f'],       // prefilter -> residual-to-formal
  account:      ['per_model_gates'], // account manager -> per-model gates
};

// ── Core Functions ───────────────────────────────────────────────────────────

/**
 * Map a hypothesis source_model path to DAG layer keys.
 * Extracts the TLA+ filename, tokenizes it, and matches against keyword table.
 *
 * @param {string} sourceModel — path to TLA+ model file
 * @returns {string[]} — array of matching layer keys (may be empty)
 */
function mapSourceToLayer(sourceModel) {
  if (!sourceModel || typeof sourceModel !== 'string') return [];

  // Extract filename without extension, lowercase
  const basename = path.basename(sourceModel, path.extname(sourceModel)).toLowerCase();

  // Remove common prefixes like "NF", "nf", "Nforma"
  const cleaned = basename.replace(/^(nf|nforma)/i, '');

  const matchedLayers = new Set();

  for (const [keyword, layers] of Object.entries(KEYWORD_TO_LAYERS)) {
    if (cleaned.includes(keyword.toLowerCase())) {
      for (const layer of layers) {
        matchedLayers.add(layer);
      }
    }
  }

  return [...matchedLayers];
}

/**
 * Load hypothesis measurements and detect transitions from UNMEASURABLE to CONFIRMED/VIOLATED.
 *
 * @param {string} root — project root directory
 * @param {string} [previousPath] — path to previous measurements (default: hypothesis-measurements.prev.json)
 * @returns {Array<{assumption_name: string, source_model: string, from_verdict: string, to_verdict: string, layer_keys: string[]}>}
 */
function loadHypothesisTransitions(root, previousPath) {
  const currentPath = path.join(root, '.planning', 'formal', 'evidence', 'hypothesis-measurements.json');
  const prevPath = previousPath || path.join(root, '.planning', 'formal', 'evidence', 'hypothesis-measurements.prev.json');

  // Fail-open: return empty if either file missing
  let current, previous;
  try {
    current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
  } catch {
    return [];
  }
  try {
    previous = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
  } catch {
    return [];
  }

  const isObj = (v) => v !== null && typeof v === 'object';
  const currentMeasurements = isObj(current) && Array.isArray(current.measurements) ? current.measurements : [];
  const previousMeasurements = isObj(previous) && Array.isArray(previous.measurements) ? previous.measurements : [];

  // Build lookup by assumption_name for previous measurements
  const prevByName = new Map();
  for (const m of previousMeasurements) {
    if (!m || typeof m !== 'object') continue;
    prevByName.set(m.assumption_name, m);
  }

  const transitions = [];

  for (const curr of currentMeasurements) {
    if (!curr || typeof curr !== 'object') continue;
    const prev = prevByName.get(curr.assumption_name);
    if (!prev) continue;

    // Only flag transitions FROM UNMEASURABLE TO CONFIRMED or VIOLATED
    if (prev.verdict === 'UNMEASURABLE' && (curr.verdict === 'CONFIRMED' || curr.verdict === 'VIOLATED')) {
      transitions.push({
        assumption_name: curr.assumption_name,
        source_model: curr.source_model,
        from_verdict: prev.verdict,
        to_verdict: curr.verdict,
        layer_keys: mapSourceToLayer(curr.source_model),
      });
    }
  }

  return transitions;
}

/**
 * Convert hypothesis transitions to layer priority weights.
 * Each transition adds +1 to each mapped layer key.
 *
 * @param {Array} transitions — from loadHypothesisTransitions
 * @returns {Object} — { [layerKey]: weightDelta } (only keys with delta > 0)
 */
function computeLayerPriorityWeights(transitions) {
  if (!transitions || transitions.length === 0) return {};

  const weights = {};

  for (const t of transitions) {
    for (const layerKey of (t.layer_keys || [])) {
      weights[layerKey] = (weights[layerKey] || 0) + 1;
    }
  }

  return weights;
}

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

  const transitions = loadHypothesisTransitions(root);
  const weights = computeLayerPriorityWeights(transitions);

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ transitions, weights }, null, 2) + '\n');
  } else {
    console.log('[hypothesis-layer-map] Hypothesis transitions:');
    if (transitions.length === 0) {
      console.log('  No transitions detected (both measurement files needed)');
    } else {
      for (const t of transitions) {
        console.log(`  ${t.assumption_name}: ${t.from_verdict} -> ${t.to_verdict} (layers: ${t.layer_keys.join(', ') || 'none'})`);
      }
    }
    console.log('\nPriority weights:');
    if (Object.keys(weights).length === 0) {
      console.log('  None (no layer-mapped transitions)');
    } else {
      for (const [key, val] of Object.entries(weights)) {
        console.log(`  ${key}: +${val}`);
      }
    }
  }

  process.exit(0);
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = { mapSourceToLayer, loadHypothesisTransitions, computeLayerPriorityWeights };

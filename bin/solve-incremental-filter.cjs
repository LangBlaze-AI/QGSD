#!/usr/bin/env node
'use strict';
// bin/solve-incremental-filter.cjs
// Maps file paths touched by remediation to affected layer domains.
// Returns a list of layers that need re-sweeping (skip the rest).
//
// Usage: echo '["path1","path2"]' | node bin/solve-incremental-filter.cjs
//    or: node bin/solve-incremental-filter.cjs --input=<path>
//
// Output: JSON { affected_layers: [...], skip_layers: [...], files_analyzed: N }
//
// Requirements: QUICK-344

const fs = require('fs');
const path = require('path');

const { LAYER_KEYS } = require('./layer-constants.cjs');

/**
 * File path pattern → affected layers mapping.
 * A file change in a domain potentially invalidates these layers.
 */
const DOMAIN_MAP = [
  // Formal models → R→F (new coverage), F→T (new test needs), F→C (new checks)
  { pattern: /^\.planning\/formal\/(tla|alloy|prism|petri)\//, layers: ['r_to_f', 'f_to_t', 'f_to_c'] },
  // Model registry/traceability → R→F, gate layers
  { pattern: /^\.planning\/formal\/(model-registry|traceability)/, layers: ['r_to_f', 'l1_to_l3', 'l3_to_tc', 'per_model_gates'] },
  // Test recipes → F→T, L3→TC
  { pattern: /^\.planning\/formal\/test-recipes\//, layers: ['f_to_t', 'l3_to_tc'] },
  // Evidence files → gate layers
  { pattern: /^\.planning\/formal\/evidence\//, layers: ['l1_to_l3', 'l3_to_tc', 'git_heatmap', 'git_history'] },
  // Requirements → R→F, R→D, reverse layers
  { pattern: /^\.planning\/formal\/requirements\.json$/, layers: ['r_to_f', 'r_to_d', 'c_to_r', 't_to_r', 'd_to_r'] },
  // Test files → T→C, F→T, T→R
  { pattern: /\.(test|spec)\.(js|cjs|mjs|ts)$/, layers: ['t_to_c', 'f_to_t', 't_to_r'] },
  { pattern: /^test\//, layers: ['t_to_c', 'f_to_t', 't_to_r'] },
  // Source code → C→F, C→R, T→C (tests may reference changed code)
  { pattern: /^bin\/(?!.*test).*\.cjs$/, layers: ['c_to_f', 'c_to_r', 't_to_c'] },
  { pattern: /^hooks\//, layers: ['c_to_f', 'c_to_r'] },
  // Documentation → R→D, D→C, D→R
  { pattern: /^docs\//, layers: ['r_to_d', 'd_to_c', 'd_to_r'] },
  { pattern: /^README\.md$/, layers: ['d_to_c', 'd_to_r'] },
  { pattern: /^CHANGELOG\.md$/, layers: ['d_to_c'] },
  // Commands/workflows (skill files) → C→R
  { pattern: /^commands\//, layers: ['c_to_r'] },
  { pattern: /^core\//, layers: ['c_to_r'] },
  // Debt/config files → informational layers
  { pattern: /^\.planning\/formal\/debt\.json$/, layers: ['hazard_model'] },
  { pattern: /^\.planning\/config\.json$/, layers: [] }, // config changes don't affect layers
];

// Layers that are ALWAYS re-swept (too cheap to skip or too important)
const ALWAYS_SWEEP = ['r_to_f', 'r_to_d'];

/**
 * CDIAG-03: Expand the affected layer set using getCallers transitive data.
 * For each changed file, query getCallers to find which files call it.
 * For each caller file, run it through DOMAIN_MAP to find additional affected layers.
 * This prevents incorrect skips when a utility file is changed but its callers map to layers.
 *
 * @param {string[]} filesTouched - File paths changed by remediation
 * @param {Set<string>} affectedSet - Already-affected layers (modified in place)
 * @param {object|null} adapter - coderlm adapter or null (fail-open)
 * @returns {void} — modifies affectedSet in place
 */
function expandWithCallGraph(filesTouched, affectedSet, adapter) {
  if (!adapter || !filesTouched || filesTouched.length === 0) return;

  let healthy = false;
  try {
    const h = adapter.healthSync();
    healthy = h.healthy;
  } catch (_) {}
  if (!healthy) return;

  for (const filePath of filesTouched) {
    let callers;
    try {
      const result = adapter.getCallersSync('', filePath);
      if (result.error || !Array.isArray(result.callers)) continue;
      callers = result.callers;
    } catch (_) {
      continue; // fail-open: one file failure doesn't block others
    }

    for (const callerFile of callers) {
      if (typeof callerFile !== 'string') continue;
      const normalized = callerFile.replace(/\\/g, '/');
      for (const { pattern, layers } of DOMAIN_MAP) {
        if (pattern.test(normalized)) {
          for (const layer of layers) affectedSet.add(layer);
        }
      }
    }
  }
}

/**
 * Given a list of file paths touched by remediation, compute which layers
 * need re-sweeping and which can be skipped.
 *
 * @param {string[]} filesTouched - relative file paths
 * @param {object|null} [adapter] - optional coderlm adapter for call-graph expansion (CDIAG-03)
 * @returns {{ affected_layers: string[], skip_layers: string[], files_analyzed: number }}
 */
function computeAffectedLayers(filesTouched, adapter) {
  if (!Array.isArray(filesTouched) || filesTouched.length === 0) {
    // No file info → sweep everything (safe fallback)
    return { affected_layers: [...LAYER_KEYS], skip_layers: [], files_analyzed: 0 };
  }

  const affected = new Set(ALWAYS_SWEEP);

  for (const filePath of filesTouched) {
    const normalized = String(filePath).replace(/\\/g, '/');
    let matched = false;
    for (const { pattern, layers } of DOMAIN_MAP) {
      if (pattern.test(normalized)) {
        for (const layer of layers) affected.add(layer);
        matched = true;
        // Don't break — a file may match multiple patterns
      }
    }
    if (!matched) {
      // Unknown file type — conservatively mark all forward layers
      affected.add('c_to_f');
      affected.add('t_to_c');
      affected.add('c_to_r');
    }
  }

  // CDIAG-03: Expand via call-graph (fail-open when adapter null/unavailable)
  expandWithCallGraph(filesTouched, affected, adapter || null);

  const affectedArray = [...affected];
  const skipArray = LAYER_KEYS.filter(k => !affected.has(k));

  return {
    affected_layers: affectedArray,
    skip_layers: skipArray,
    files_analyzed: filesTouched.length,
  };
}

// CLI entrypoint
if (require.main === module) {
  let filesTouched;
  const inputArg = process.argv.find(a => a.startsWith('--input='));
  if (inputArg) {
    filesTouched = JSON.parse(fs.readFileSync(inputArg.slice('--input='.length), 'utf8'));
  } else {
    filesTouched = JSON.parse(fs.readFileSync('/dev/stdin', 'utf8'));
  }

  // CDIAG-03: Optional coderlm adapter (fail-open when not provided)
  let adapter = null;
  const adapterHostArg = process.argv.find(a => a.startsWith('--adapter-host='));
  const adapterHost = adapterHostArg ? adapterHostArg.slice('--adapter-host='.length) : process.env.NF_CODERLM_HOST;
  if (adapterHost) {
    try {
      const { createAdapter } = require('./coderlm-adapter.cjs');
      adapter = createAdapter({ host: adapterHost });
    } catch (_) {} // fail-open if coderlm-adapter.cjs unavailable
  }

  const result = computeAffectedLayers(filesTouched, adapter);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

module.exports = { computeAffectedLayers, expandWithCallGraph, DOMAIN_MAP, ALWAYS_SWEEP };

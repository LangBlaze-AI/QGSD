#!/usr/bin/env node
'use strict';
// bin/model-complexity-profile.cjs
// Combines state-space-report.json (static complexity) with check-results.ndjson
// (runtime data) into a unified complexity profile with split/merge recommendations.
//
// Usage:
//   node bin/model-complexity-profile.cjs            # write to .planning/formal/model-complexity-profile.json
//   node bin/model-complexity-profile.cjs --json     # print JSON to stdout
//   node bin/model-complexity-profile.cjs --quiet    # suppress human summary
//   node bin/model-complexity-profile.cjs --project-root=PATH
//
// Requirements: QUICK-226

const fs   = require('fs');
const path = require('path');

const TAG = '[model-complexity-profile]';
let ROOT = process.cwd();

// Parse --project-root (overrides CWD-based ROOT for cross-repo usage)
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--project-root=')) {
    ROOT = path.resolve(arg.slice('--project-root='.length));
  }
}

const STATE_SPACE_PATH  = path.join(ROOT, '.planning', 'formal', 'state-space-report.json');
const NDJSON_PATH       = path.join(ROOT, '.planning', 'formal', 'check-results.ndjson');
const OUTPUT_PATH       = path.join(ROOT, '.planning', 'formal', 'model-complexity-profile.json');

// ── CLI flags ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const jsonMode  = args.includes('--json');
const quietMode = args.includes('--quiet');

// ── Runtime classification thresholds (ms) ──────────────────────────────────

const RUNTIME_THRESHOLDS = {
  FAST: 1000,       // <= 1000ms
  MODERATE: 10000,  // <= 10000ms
  SLOW: 30000,      // <= 30000ms
  // > 30000ms = HEAVY
};

/**
 * Classify runtime into FAST/MODERATE/SLOW/HEAVY.
 * @param {number|null} runtimeMs
 * @returns {string}
 */
function classifyRuntime(runtimeMs) {
  if (runtimeMs == null) return 'FAST'; // no data = assume fast
  if (runtimeMs <= RUNTIME_THRESHOLDS.FAST) return 'FAST';
  if (runtimeMs <= RUNTIME_THRESHOLDS.MODERATE) return 'MODERATE';
  if (runtimeMs <= RUNTIME_THRESHOLDS.SLOW) return 'SLOW';
  return 'HEAVY';
}

// ── Formalism prefix to directory map ───────────────────────────────────────

const FORMALISM_DIR_MAP = {
  tla:    '.planning/formal/tla/',
  alloy:  '.planning/formal/alloy/',
  prism:  '.planning/formal/prism/',
  petri:  '.planning/formal/petri/',
};

/**
 * Normalize a filename for slug matching.
 * Strips extension, lowercases, removes common prefixes (MC, NF).
 * @param {string} filename
 * @returns {string}
 */
function normalizeFilename(filename) {
  const base = path.basename(filename).replace(/\.[^.]+$/, '').toLowerCase();
  // Strip common prefixes: MC, NF, mc, nf
  return base.replace(/^(mc|nf)+/i, '');
}

/**
 * Normalize a slug for matching (lowercase, remove hyphens/underscores).
 * @param {string} slug
 * @returns {string}
 */
function normalizeSlug(slug) {
  return slug.toLowerCase().replace(/[-_]/g, '');
}

/**
 * Try to match a check_id to a state-space model entry.
 * @param {string} checkId - e.g., "tla:account-manager"
 * @param {Object} stateSpaceModels - keyed by file path
 * @returns {Object|null} - the matched state-space entry, or null
 */
function findStateSpaceMatch(checkId, stateSpaceModels) {
  if (!stateSpaceModels) return null;

  const colonIdx = checkId.indexOf(':');
  if (colonIdx === -1) return null;

  const formalism = checkId.substring(0, colonIdx);
  const slug = checkId.substring(colonIdx + 1);
  const dir = FORMALISM_DIR_MAP[formalism];

  if (!dir) return null;

  const normalizedSlug = normalizeSlug(slug);

  for (const modelPath of Object.keys(stateSpaceModels)) {
    if (!modelPath.startsWith(dir)) continue;
    const normalizedName = normalizeSlug(normalizeFilename(modelPath));
    if (normalizedName.includes(normalizedSlug) || normalizedSlug.includes(normalizedName)) {
      return stateSpaceModels[modelPath];
    }
  }

  return null;
}

/**
 * Parse check-results.ndjson and return a map of check_id -> { runtime_ms, formalism }.
 * For duplicate check_ids, keeps the max runtime_ms.
 * @param {string} ndjsonPath
 * @returns {Map<string, { runtime_ms: number, formalism: string }>}
 */
function parseNDJSON(ndjsonPath) {
  const map = new Map();

  if (!fs.existsSync(ndjsonPath)) return map;

  let content;
  try {
    content = fs.readFileSync(ndjsonPath, 'utf8');
  } catch (err) {
    process.stderr.write(TAG + ' warn: cannot read ' + ndjsonPath + ': ' + err.message + '\n');
    return map;
  }

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (e) {
      continue; // skip malformed lines
    }

    const checkId = entry.check_id;
    if (!checkId || typeof checkId !== 'string') continue;

    const runtimeMs = typeof entry.runtime_ms === 'number' ? entry.runtime_ms : null;
    const formalism = entry.formalism || null;

    const existing = map.get(checkId);
    if (!existing) {
      map.set(checkId, { runtime_ms: runtimeMs, formalism: formalism });
    } else {
      // Keep max runtime
      if (runtimeMs != null && (existing.runtime_ms == null || runtimeMs > existing.runtime_ms)) {
        existing.runtime_ms = runtimeMs;
      }
    }
  }

  return map;
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const warnings = [];

  // Load state-space report (optional — may not exist)
  let stateSpaceData = null;
  if (fs.existsSync(STATE_SPACE_PATH)) {
    try {
      stateSpaceData = JSON.parse(fs.readFileSync(STATE_SPACE_PATH, 'utf8'));
    } catch (err) {
      warnings.push('Failed to parse state-space-report.json: ' + err.message);
    }
  } else {
    warnings.push('state-space-report.json not found — runtime-only profile');
  }

  // Load NDJSON runtime data (optional — may not exist)
  const runtimeMap = parseNDJSON(NDJSON_PATH);
  if (runtimeMap.size === 0 && !fs.existsSync(NDJSON_PATH)) {
    warnings.push('check-results.ndjson not found — static-only profile');
  }

  const stateSpaceModels = stateSpaceData ? (stateSpaceData.models || {}) : null;

  // Build unified profiles from both sources (null-proto so a '__proto__' check_id is a normal key)
  const profiles = Object.create(null);
  const seenCheckIds = new Set();

  // 1. Process NDJSON entries (runtime data)
  for (const [checkId, rtData] of runtimeMap) {
    seenCheckIds.add(checkId);

    const ssMatch = findStateSpaceMatch(checkId, stateSpaceModels);

    profiles[checkId] = {
      formalism: rtData.formalism || checkId.split(':')[0] || 'unknown',
      runtime_ms: rtData.runtime_ms,
      estimated_states: ssMatch ? (ssMatch.estimated_states || null) : null,
      risk_level: ssMatch ? (ssMatch.risk_level || null) : null,
      variable_count: ssMatch ? (Array.isArray(ssMatch.variables) ? ssMatch.variables.length : null) : null,
      runtime_class: classifyRuntime(rtData.runtime_ms),
    };
  }

  // 2. Process state-space models not already covered by NDJSON
  if (stateSpaceModels) {
    for (const [modelPath, modelData] of Object.entries(stateSpaceModels)) {
      if (!modelData || typeof modelData !== 'object') continue;
      // Check if already matched via NDJSON
      let alreadyCovered = false;
      for (const checkId of seenCheckIds) {
        if (findStateSpaceMatch(checkId, { [modelPath]: modelData })) {
          alreadyCovered = true;
          break;
        }
      }

      if (!alreadyCovered) {
        const syntheticId = 'static:' + (modelData.module_name || path.basename(modelPath, path.extname(modelPath)));
        profiles[syntheticId] = {
          formalism: modelPath.includes('/tla/') ? 'tla' : modelPath.includes('/alloy/') ? 'alloy' : modelPath.includes('/prism/') ? 'prism' : modelPath.includes('/petri/') ? 'petri' : 'unknown',
          runtime_ms: null,
          estimated_states: modelData.estimated_states || null,
          risk_level: modelData.risk_level || null,
          variable_count: Array.isArray(modelData.variables) ? modelData.variables.length : null,
          runtime_class: 'FAST', // no runtime data = assume fast
        };
      }
    }
  }

  // 3. Generate recommendations
  const splitCandidates = [];
  const mergeCandidates = [];

  for (const [checkId, profile] of Object.entries(profiles)) {
    const hasStateSpace = profile.estimated_states != null || profile.variable_count != null;

    if (profile.runtime_class === 'HEAVY') {
      if (hasStateSpace) {
        const parts = [];
        parts.push('HEAVY runtime (' + profile.runtime_ms + 'ms)');
        if (profile.variable_count != null) parts.push(profile.variable_count + ' variables');
        if (profile.estimated_states != null) parts.push(formatStates(profile.estimated_states) + ' states');
        splitCandidates.push({ check_id: checkId, reason: parts.join(' with ') });
      } else {
        splitCandidates.push({
          check_id: checkId,
          reason: 'HEAVY runtime (' + profile.runtime_ms + 'ms) — split recommended',
        });
      }
    } else if (profile.runtime_class === 'SLOW') {
      if (hasStateSpace && ((profile.variable_count != null && profile.variable_count >= 5) || (profile.estimated_states != null && profile.estimated_states > 1000000))) {
        const parts = ['SLOW runtime (' + profile.runtime_ms + 'ms)'];
        if (profile.variable_count != null) parts.push(profile.variable_count + ' variables');
        if (profile.estimated_states != null) parts.push(formatStates(profile.estimated_states) + ' states');
        splitCandidates.push({ check_id: checkId, reason: parts.join(' with ') });
      } else {
        splitCandidates.push({
          check_id: checkId,
          reason: 'SLOW runtime (' + profile.runtime_ms + 'ms) — consider splitting if complexity grows',
        });
      }
    }
  }

  // Merge candidates: use cross_model from state-space-report if available
  if (stateSpaceData && stateSpaceData.cross_model && stateSpaceData.cross_model.pairs) {
    for (const pair of stateSpaceData.cross_model.pairs) {
      if (pair.recommendation !== 'merge') continue;

      // Find profiles for both models to check runtime class
      const profileA = findProfileByPath(pair.model_a, profiles, stateSpaceModels);
      const profileB = findProfileByPath(pair.model_b, profiles, stateSpaceModels);

      if (profileA && profileB) {
        const classA = profileA.runtime_class;
        const classB = profileB.runtime_class;
        if ((classA === 'FAST' || classA === 'MODERATE') && (classB === 'FAST' || classB === 'MODERATE')) {
          const combinedRuntime = (profileA.runtime_ms || 0) + (profileB.runtime_ms || 0);
          const reqText = pair.shared_requirements && pair.shared_requirements.length > 0
            ? 'Shared requirements [' + pair.shared_requirements.join(', ') + '], '
            : '';
          mergeCandidates.push({
            model_a: pair.model_a,
            model_b: pair.model_b,
            reason: reqText + 'combined runtime ' + combinedRuntime + 'ms, within TLC budget',
          });
        }
      }
    }
  }

  // 4. Build summary
  const byRuntimeClass = { FAST: 0, MODERATE: 0, SLOW: 0, HEAVY: 0 };
  for (const profile of Object.values(profiles)) {
    byRuntimeClass[profile.runtime_class] = (byRuntimeClass[profile.runtime_class] || 0) + 1;
  }

  const result = {
    metadata: {
      generated_at: new Date().toISOString(),
      generator: 'model-complexity-profile',
      version: '1.0',
      warnings: warnings.length > 0 ? warnings : undefined,
    },
    profiles: profiles,
    recommendations: {
      split_candidates: splitCandidates,
      merge_candidates: mergeCandidates,
    },
    summary: {
      total_profiled: Object.keys(profiles).length,
      by_runtime_class: byRuntimeClass,
      split_candidates: splitCandidates.length,
      merge_candidates: mergeCandidates.length,
    },
  };

  const jsonStr = JSON.stringify(result, null, 2);

  if (jsonMode) {
    process.stdout.write(jsonStr + '\n');
    return;
  }

  // Write to file
  fs.writeFileSync(OUTPUT_PATH, jsonStr + '\n', 'utf8');

  if (!quietMode) {
    process.stdout.write(TAG + ' Profiled ' + result.summary.total_profiled + ' models\n');
    process.stdout.write(TAG + '   FAST: ' + byRuntimeClass.FAST + '  MODERATE: ' + byRuntimeClass.MODERATE + '  SLOW: ' + byRuntimeClass.SLOW + '  HEAVY: ' + byRuntimeClass.HEAVY + '\n');
    process.stdout.write(TAG + '   Split candidates: ' + splitCandidates.length + '\n');
    process.stdout.write(TAG + '   Merge candidates: ' + mergeCandidates.length + '\n');
    if (warnings.length > 0) {
      for (const w of warnings) {
        process.stdout.write(TAG + '   warn: ' + w + '\n');
      }
    }
    process.stdout.write(TAG + ' Profile: .planning/formal/model-complexity-profile.json\n');
  }
}

/**
 * Format large state counts for human readability.
 */
function formatStates(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

/**
 * Find a profile entry by state-space model path (for merge candidate lookup).
 */
function findProfileByPath(modelPath, profiles, stateSpaceModels) {
  // Direct check: look for a profile whose check_id matches via the join
  for (const [checkId, profile] of Object.entries(profiles)) {
    if (checkId === modelPath) return profile;
    if (checkId.startsWith('static:')) {
      // Match by module name
      const ssModel = stateSpaceModels ? stateSpaceModels[modelPath] : null;
      if (ssModel && checkId === 'static:' + ssModel.module_name) return profile;
    }
    // Try the correlation layer
    if (stateSpaceModels && stateSpaceModels[modelPath]) {
      const match = findStateSpaceMatch(checkId, { [modelPath]: stateSpaceModels[modelPath] });
      if (match) return profile;
    }
  }
  return null;
}

// Export classifyRuntime and parseNDJSON for testing
module.exports = { classifyRuntime, parseNDJSON, findStateSpaceMatch, normalizeFilename, normalizeSlug, main };

// Run if invoked directly
if (require.main === module) {
  main();
}

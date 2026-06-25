#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { keywordOverlap } = require('./formal-graph-search.cjs');

const FORMAL_DIR = path.join(process.cwd(), '.planning', 'formal');
const PROXIMITY_INDEX_PATH = path.join(FORMAL_DIR, 'proximity-index.json');
const MODEL_REGISTRY_PATH = path.join(FORMAL_DIR, 'model-registry.json');
const REQUIREMENTS_PATH = path.join(FORMAL_DIR, 'requirements.json');
const OUTPUT_PATH = path.join(FORMAL_DIR, 'candidates.json');

// ─────────────────────────────────────────────────────────────────────────────
// Core discovery logic (exported for testability)
// ─────────────────────────────────────────────────────────────────────────────

// Note: keywordOverlap is imported from formal-graph-search.cjs

/**
 * Scan formal model source files for requirement ID mentions.
 * Returns the set of requirement IDs found in at least one source file.
 */
function scanSourceFilesForReqIds() {
  const found = new Set();
  const dirs = [
    { dir: path.join(FORMAL_DIR, 'alloy'), ext: '.als' },
    { dir: path.join(FORMAL_DIR, 'tla'), ext: '.tla' },
    { dir: path.join(FORMAL_DIR, 'prism'), ext: '.pm' },
    { dir: path.join(FORMAL_DIR, 'prism'), ext: '.props' },
  ];
  const allContent = [];
  for (const { dir, ext } of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith(ext));
    for (const file of files) {
      try {
        allContent.push(fs.readFileSync(path.join(dir, file), 'utf8'));
      } catch { /* skip unreadable */ }
    }
  }
  return { allContent, found };
}

/**
 * Find requirements that are not mentioned in any formal model source file.
 * @param {Array} requirements - Array of requirement objects with .id and .text
 * @returns {Array<{id: string, text: string}>}
 */
function findUncoveredRequirements(requirements) {
  const dirs = [
    { dir: path.join(FORMAL_DIR, 'alloy'), ext: '.als' },
    { dir: path.join(FORMAL_DIR, 'tla'), ext: '.tla' },
    { dir: path.join(FORMAL_DIR, 'prism'), ext: '.pm' },
    { dir: path.join(FORMAL_DIR, 'prism'), ext: '.props' },
  ];

  // Read all formal model source content into a single string for fast searching
  let allContent = '';
  for (const { dir, ext } of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith(ext));
      for (const file of files) {
        try {
          allContent += fs.readFileSync(path.join(dir, file), 'utf8') + '\n';
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip unreadable dir */ }
  }

  const uncovered = [];
  for (const req of requirements) {
    if (!allContent.includes(req.id)) {
      uncovered.push({ id: req.id, text: req.text || '' });
    }
  }
  return uncovered;
}

/**
 * Compute quick coverage ratio: how many requirement IDs appear in source files.
 * @param {Array} requirements - Array of requirement objects
 * @returns {{ covered: number, total: number, pct: number, uncovered: Array }}
 */
function quickCoverageCheck(requirements) {
  const uncovered = findUncoveredRequirements(requirements);
  const total = requirements.length;
  const covered = total - uncovered.length;
  const pct = total > 0 ? Math.round((covered / total) * 10000) / 100 : 100;
  return { covered, total, pct, uncovered };
}

/**
 * Discover unlinked (model, requirement) pairs within maxHops of the
 * proximity graph with score above threshold, plus top-N zero-path pairs
 * ranked by coverage-gap heuristic.
 *
 * @param {object} proximityIndex - The full proximity-index.json object
 * @param {object} modelRegistry  - The full model-registry.json object
 * @param {Array}  requirements   - Array of requirement objects with .id
 * @param {object} opts           - { threshold, maxHops, nonNeighborTop }
 * @returns {{ metadata: object, candidates: Array }}
 */
function discoverCandidates(proximityIndex, modelRegistry, requirements, opts = {}) {
  const { proximity, ENSEMBLE_METHODS, AMPLIFIED_ENSEMBLE_METHODS, loadEmbeddingCache } = require('./formal-proximity.cjs');

  // Load category-groups for domain gating
  const CATEGORY_GROUPS_PATH = path.join(process.cwd(), '.planning', 'formal', 'category-groups.json');
  let categoryGroups = {};
  try { categoryGroups = JSON.parse(fs.readFileSync(CATEGORY_GROUPS_PATH, 'utf8')); } catch { /* no category groups available */ }

  // Build model -> category group lookup from model-registry requirements
  // modelCategoryGroups: Map<modelPath, Set<categoryGroup>>
  const modelCategoryGroups = new Map();
  for (const [mp, mi] of Object.entries(modelRegistry.models || {})) {
    const groups = new Set();
    for (const rId of (mi.requirements || [])) {
      const req = requirements.find(r => r.id === rId);
      if (req && req.category && categoryGroups[req.category]) {
        groups.add(categoryGroups[req.category]);
      }
    }
    modelCategoryGroups.set(mp, groups);
  }

  // Build requirement -> category group lookup
  const reqCategoryGroup = new Map();
  for (const req of requirements) {
    if (req.category && categoryGroups[req.category]) {
      reqCategoryGroup.set(req.id, categoryGroups[req.category]);
    }
  }

  // Build requirement -> already-covered flag (formal_models non-empty)
  const reqAlreadyCovered = new Map();
  for (const req of requirements) {
    reqAlreadyCovered.set(req.id, Array.isArray(req.formal_models) && req.formal_models.length > 0);
  }

  const threshold = opts.threshold != null ? opts.threshold : 0.7;
  const maxHops = opts.maxHops != null ? opts.maxHops : 5;
  const nonNeighborTop = opts.nonNeighborTop != null ? opts.nonNeighborTop : 20;

  // Compute SHA256 hash of the proximity index for idempotency tracking
  const indexContent = JSON.stringify(proximityIndex);
  const proximityIndexHash = crypto.createHash('sha256').update(indexContent).digest('hex').slice(0, 8);

  const noFastPath = opts.noFastPath || false;

  const modelPaths = Object.keys(modelRegistry.models || {});
  const reqIds = requirements.map(r => r.id);

  // Fast-path: skip ensemble when coverage >= 95%
  if (!noFastPath && requirements.length > 0) {
    const coverage = quickCoverageCheck(requirements);
    if (coverage.pct >= 95) {
      process.stderr.write('[candidate-discovery] Fast path: ' + coverage.covered + '/' + coverage.total + ' requirements covered (' + coverage.pct + '%) -- skipping ensemble, surfacing gaps directly\n');

      // Compute orphans using graph connectivity
      const fpOrphanModels = [];
      const fpOrphanReqs = [];
      for (const modelPath of modelPaths) {
        const modelKey = 'formal_model::' + modelPath;
        const node = proximityIndex.nodes ? proximityIndex.nodes[modelKey] : null;
        if (!node || (node.edges || []).length === 0) {
          fpOrphanModels.push({ path: modelPath, edges: 0 });
        }
      }
      for (const reqId of reqIds) {
        const reqKey = 'requirement::' + reqId;
        const node = proximityIndex.nodes ? proximityIndex.nodes[reqKey] : null;
        if (!node || (node.edges || []).length === 0) {
          fpOrphanReqs.push({ id: reqId, edges: 0 });
        }
      }

      return {
        metadata: {
          generated: new Date().toISOString(),
          proximity_index_hash: proximityIndexHash,
          threshold,
          max_hops: maxHops,
          total_pairs_checked: 0,
          candidates_found: 0,
          candidates_filtered: 0,
          orphan_models_count: fpOrphanModels.length,
          orphan_requirements_count: fpOrphanReqs.length,
          uncovered_requirements_count: coverage.uncovered.length,
          non_neighbor_top: nonNeighborTop,
          fast_path: true,
        },
        candidates: [],
        orphans: {
          models: fpOrphanModels,
          requirements: fpOrphanReqs,
        },
        uncovered_requirements: coverage.uncovered,
      };
    }
  }

  // Auto-detect: use amplified ensemble (with embeddings) when cache is available
  const embeddingCache = loadEmbeddingCache();
  const methods = embeddingCache ? AMPLIFIED_ENSEMBLE_METHODS : ENSEMBLE_METHODS;
  const candidates = [];
  const zeroPairs = []; // Pairs with score 0 (no graph path)
  let totalPairsChecked = 0;
  let filteredCount = 0;

  for (const modelPath of modelPaths) {
    const modelInfo = modelRegistry.models[modelPath];
    const linkedReqs = new Set(modelInfo.requirements || []);
    const modelKey = `formal_model::${modelPath}`;

    for (const reqId of reqIds) {
      // Skip already-linked pairs
      if (linkedReqs.has(reqId)) continue;

      totalPairsChecked++;
      const reqKey = `requirement::${reqId}`;

      const req = requirements.find(r => r.id === reqId);
      const reqText = req ? req.text : '';

      // Ensemble scoring: score with primary method (first in ENSEMBLE_METHODS).
      // Secondary methods are used in the top-N union pass after this loop.
      let score;
      try {
        score = proximity(proximityIndex, modelKey, reqKey, maxHops, { method: methods[0], reqsData: requirements, reqText });
      } catch {
        process.stderr.write(`[candidate-discovery] WARN: proximity() failed for ${modelPath} <-> ${reqId}, skipping\n`);
        continue;
      }

      if (score == null || isNaN(score)) {
        process.stderr.write(`[candidate-discovery] WARN: proximity() returned ${score} for ${modelPath} <-> ${reqId}, skipping\n`);
        continue;
      }

      if (score > threshold) {
        let dominated = false;
        let filterReason = null;

        // Pre-filter 1: Category-domain gating
        // If model's declared requirements are ALL in one category group,
        // and the candidate requirement is in a DIFFERENT category group,
        // reject unless score > 0.95
        const modelGroups = modelCategoryGroups.get(modelPath);
        const reqGroup = reqCategoryGroup.get(reqId);
        if (modelGroups && modelGroups.size === 1 && reqGroup) {
          const modelGroup = [...modelGroups][0];
          if (modelGroup !== reqGroup && score <= 0.95) {
            dominated = true;
            filterReason = 'cross_domain';
          }
        }

        // Pre-filter 2: Already-covered requirement check
        // If requirement already has formal_models, raise threshold to 0.95
        if (!dominated && reqAlreadyCovered.get(reqId) && score <= 0.95) {
          dominated = true;
          filterReason = 'already_covered';
        }

        // Pre-filter 3: Keyword pre-screen
        if (!dominated) {
          const req = requirements.find(r => r.id === reqId);
          const reqText = req ? req.text : '';
          if (!keywordOverlap(modelPath, reqText)) {
            dominated = true;
            filterReason = 'no_keyword_overlap';
          }
        }

        if (!dominated) {
          candidates.push({
            model: modelPath,
            requirement: reqId,
            proximity_score: Math.round(score * 10000) / 10000,
            source: 'graph',
          });
        } else {
          filteredCount++;
        }
      } else if (score === 0) {
        // Track zero-path pairs for non-neighbor discovery
        zeroPairs.push({ model: modelPath, requirement: reqId });
      }
    }
  }

  // Ensemble union pass: run secondary methods on all model-requirement pairs,
  // add their top candidates that the primary method missed.
  // Each secondary method finds different true positives (validated by Haiku benchmark).
  // Domain gating and already-covered filters apply; keyword filter is skipped
  // because ensemble candidates are valued precisely for non-obvious textual matches.
  if (methods.length > 1) {
    const existingPairs = new Set(candidates.map(c => `${c.model}|${c.requirement}`));
    const secondaryCandidates = [];

    for (let mi = 1; mi < methods.length; mi++) {
      const method = methods[mi];
      const methodCandidates = [];

      for (const modelPath of modelPaths) {
        const modelInfo = modelRegistry.models[modelPath];
        const linkedReqs = new Set(modelInfo.requirements || []);
        const modelKey = `formal_model::${modelPath}`;

        for (const reqId of reqIds) {
          if (linkedReqs.has(reqId)) continue;
          const pairKey = `${modelPath}|${reqId}`;
          if (existingPairs.has(pairKey)) continue;

          const reqKey = `requirement::${reqId}`;
          const req = requirements.find(r => r.id === reqId);
          const reqText = req ? req.text : '';

          let score;
          try {
            score = proximity(proximityIndex, modelKey, reqKey, maxHops, { method, reqsData: requirements, reqText });
          } catch { continue; }

          // Ensemble uses a higher floor (0.7) since secondary methods produce
          // large candidate sets; the primary threshold may be much lower.
          const ensembleFloor = Math.max(threshold, 0.7);
          if (score == null || isNaN(score) || score <= ensembleFloor) continue;

          let dominated = false;

          // Domain gating
          const mGroups = modelCategoryGroups.get(modelPath);
          const rGroup = reqCategoryGroup.get(reqId);
          if (mGroups && mGroups.size === 1 && rGroup) {
            if ([...mGroups][0] !== rGroup && score <= 0.95) dominated = true;
          }

          // Already-covered check
          if (!dominated && reqAlreadyCovered.get(reqId) && score <= 0.95) dominated = true;

          // Keyword pre-screen SKIPPED for ensemble candidates:
          // The ensemble exists to find non-obvious pairs that lack textual similarity
          // but have graph proximity. Keyword filtering defeats this purpose.

          if (!dominated) {
            methodCandidates.push({
              model: modelPath,
              requirement: reqId,
              proximity_score: Math.round(score * 10000) / 10000,
              source: 'ensemble',
              scoring_method: method,
            });
          }
        }
      }

      // Take top candidates by score. No round-robin here — the final --top
      // round-robin handles diversity across the merged set.
      // Limit to 100 to avoid flooding the pipeline with noise.
      methodCandidates.sort((a, b) => b.proximity_score - a.proximity_score);
      let added = 0;
      for (const c of methodCandidates) {
        if (added >= 100) break;
        if (!existingPairs.has(`${c.model}|${c.requirement}`)) {
          secondaryCandidates.push(c);
          existingPairs.add(`${c.model}|${c.requirement}`);
          added++;
        }
      }
    }

    // Merge secondary candidates into main list
    candidates.push(...secondaryCandidates);
    if (secondaryCandidates.length > 0) {
      process.stderr.write(`[candidate-discovery] Ensemble: added ${secondaryCandidates.length} candidates from ${methods.length - 1} secondary method(s)\n`);
    }
  }

  // Graph-connectivity orphan detection: nodes with 0 edges in proximity index
  const orphanModels = [];
  const orphanReqs = [];

  // Orphan models: model nodes with 0 edges in the proximity graph
  for (const modelPath of modelPaths) {
    const modelKey = 'formal_model::' + modelPath;
    const node = proximityIndex.nodes ? proximityIndex.nodes[modelKey] : null;
    if (!node || (node.edges || []).length === 0) {
      orphanModels.push({ path: modelPath, edges: 0 });
    }
  }

  // Orphan requirements: requirement nodes with 0 edges in the proximity graph
  for (const reqId of reqIds) {
    const reqKey = 'requirement::' + reqId;
    const node = proximityIndex.nodes ? proximityIndex.nodes[reqKey] : null;
    if (!node || (node.edges || []).length === 0) {
      orphanReqs.push({ id: reqId, edges: 0 });
    }
  }

  // Truly uncovered requirements: not mentioned in any formal model source file
  const uncoveredRequirements = findUncoveredRequirements(requirements);

  // Sort by proximity_score descending, then model+requirement for ties (deterministic)
  candidates.sort((a, b) => {
    if (b.proximity_score !== a.proximity_score) return b.proximity_score - a.proximity_score;
    const aKey = `${a.model}::${a.requirement}`;
    const bKey = `${b.model}::${b.requirement}`;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });

  return {
    metadata: {
      generated: new Date().toISOString(),
      proximity_index_hash: proximityIndexHash,
      threshold,
      max_hops: maxHops,
      total_pairs_checked: totalPairsChecked,
      candidates_found: candidates.length,
      candidates_filtered: filteredCount,
      orphan_models_count: orphanModels.length,
      orphan_requirements_count: orphanReqs.length,
      uncovered_requirements_count: uncoveredRequirements.length,
      non_neighbor_top: nonNeighborTop,
    },
    candidates,
    orphans: {
      models: orphanModels,
      requirements: orphanReqs,
    },
    uncovered_requirements: uncoveredRequirements,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { minScore: 0.7, maxHops: 5, nonNeighborTop: 20, top: null, json: false, help: false, noFastPath: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else if (argv[i].startsWith('--min-score')) {
      const val = argv[i].includes('=') ? argv[i].split('=')[1] : argv[++i];
      args.minScore = parseFloat(val);
      if (Number.isNaN(args.minScore)) args.minScore = 0.7; // non-numeric → default, not a NaN threshold
    } else if (argv[i].startsWith('--max-hops')) {
      const val = argv[i].includes('=') ? argv[i].split('=')[1] : argv[++i];
      args.maxHops = parseInt(val, 10);
    } else if (argv[i].startsWith('--non-neighbor-top')) {
      const val = argv[i].includes('=') ? argv[i].split('=')[1] : argv[++i];
      args.nonNeighborTop = parseInt(val, 10);
    } else if (argv[i].startsWith('--top')) {
      const val = argv[i].includes('=') ? argv[i].split('=')[1] : argv[++i];
      args.top = parseInt(val, 10);
    } else if (argv[i] === '--no-fast-path') {
      args.noFastPath = true;
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node bin/candidate-discovery.cjs [options]

Options:
  --min-score <n>        Minimum proximity score threshold (default: 0.7)
  --no-fast-path         Force full ensemble even when coverage >= 95%
  --max-hops <n>         Maximum BFS hop count (default: 3)
  --non-neighbor-top <n> Include top N non-neighboring pairs by coverage gap (default: 20)
  --top <n>              Return only top N candidates by score (default: all)
  --json                 Print summary to stdout as JSON (for piping)
  --help                 Show this help message

Discovers unlinked (model, requirement) pairs within the proximity graph.
Writes .planning/formal/candidates.json.
`);
}

// Read + parse a required JSON input, exiting with a clean message (not a raw
// SyntaxError stack trace) on a missing or corrupt file (dogfood F47).
function readJsonOrExit(p, label) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    process.stderr.write(`[candidate-discovery] ERROR: cannot read ${label} (${p}): ${e.message}\n`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`[candidate-discovery] ERROR: ${label} is not valid JSON (${p}): ${e.message}\n`);
    process.exit(1);
  }
}

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Validate inputs exist
  if (!fs.existsSync(PROXIMITY_INDEX_PATH)) {
    process.stderr.write('[candidate-discovery] ERROR: proximity-index.json not found \u2014 run formal-verify first\n');
    process.exit(1);
  }
  if (!fs.existsSync(MODEL_REGISTRY_PATH)) {
    process.stderr.write('[candidate-discovery] ERROR: model-registry.json not found\n');
    process.exit(1);
  }
  if (!fs.existsSync(REQUIREMENTS_PATH)) {
    process.stderr.write('[candidate-discovery] ERROR: requirements.json not found\n');
    process.exit(1);
  }

  // Load inputs
  const proximityIndex = readJsonOrExit(PROXIMITY_INDEX_PATH, 'proximity-index.json');
  const modelRegistry = readJsonOrExit(MODEL_REGISTRY_PATH, 'model-registry.json');
  const requirementsData = readJsonOrExit(REQUIREMENTS_PATH, 'requirements.json');
  const requirements = requirementsData.requirements || [];

  const modelCount = Object.keys(modelRegistry.models || {}).length;
  const reqCount = requirements.length;
  process.stderr.write(`[candidate-discovery] Checking ${modelCount} models x ${reqCount} requirements...\n`);

  const result = discoverCandidates(proximityIndex, modelRegistry, requirements, {
    threshold: args.minScore,
    maxHops: args.maxHops,
    nonNeighborTop: args.nonNeighborTop,
    noFastPath: args.noFastPath,
  });

  // Log histogram of candidate scores to stderr (BEFORE truncation)
  if (result.candidates.length > 0) {
    const buckets = { '0.7-0.8': 0, '0.8-0.9': 0, '0.9-1.0': 0 };
    for (const c of result.candidates) {
      if (c.proximity_score < 0.8) buckets['0.7-0.8']++;
      else if (c.proximity_score < 0.9) buckets['0.8-0.9']++;
      else buckets['0.9-1.0']++;
    }
    process.stderr.write(`[candidate-discovery] Score histogram:\n`);
    for (const [range, count] of Object.entries(buckets)) {
      if (count > 0) process.stderr.write(`  ${range}: ${count}\n`);
    }
  }

  // Log orphan discovery counts
  if (result.orphans.models.length > 0 || result.orphans.requirements.length > 0) {
    process.stderr.write(`[candidate-discovery] Found ${result.orphans.models.length} orphan models, ${result.orphans.requirements.length} orphan requirements (limit ${result.metadata.non_neighbor_top})\n`);
  }

  // Log truly uncovered requirements
  if (result.uncovered_requirements && result.uncovered_requirements.length > 0) {
    process.stderr.write('[candidate-discovery] === TRULY UNCOVERED REQUIREMENTS ===\n');
    for (const ur of result.uncovered_requirements) {
      process.stderr.write('[candidate-discovery]   ' + ur.id + ': ' + (ur.text || '(no text)') + ' (no mention in any formal model)\n');
    }
    process.stderr.write('[candidate-discovery] === ' + result.uncovered_requirements.length + ' requirements have no formal model coverage ===\n');
  }

  // Log pre-filtered candidates
  if (result.metadata.candidates_filtered > 0) {
    process.stderr.write(`[candidate-discovery] Pre-filtered ${result.metadata.candidates_filtered} candidates (cross-domain, already-covered, or no keyword overlap)\n`);
  }

  // Apply --top N truncation with diversity-aware selection
  // Round-robin across models so no single model monopolizes the top-N slots.
  if (args.top != null && args.top > 0 && args.top < result.candidates.length) {
    const beforeCount = result.candidates.length;

    // Group candidates by model, preserving score order within each group
    const byModel = new Map();
    for (const c of result.candidates) {
      if (!byModel.has(c.model)) byModel.set(c.model, []);
      byModel.get(c.model).push(c);
    }

    // Sort model groups by their best candidate score (descending)
    const modelGroups = [...byModel.entries()]
      .sort((a, b) => b[1][0].proximity_score - a[1][0].proximity_score);

    // Round-robin pick: cycle through models, taking one candidate per pass
    const selected = [];
    const cursors = new Map(modelGroups.map(([m]) => [m, 0]));
    while (selected.length < args.top) {
      let picked = false;
      for (const [model, group] of modelGroups) {
        if (selected.length >= args.top) break;
        const idx = cursors.get(model);
        if (idx < group.length) {
          selected.push(group[idx]);
          cursors.set(model, idx + 1);
          picked = true;
        }
      }
      if (!picked) break; // all groups exhausted
    }

    result.candidates = selected;
    result.metadata.candidates_before_top = beforeCount;
    result.metadata.top = args.top;
    result.metadata.top_strategy = 'diversity_round_robin';
    result.metadata.models_represented = byModel.size;
    result.metadata.candidates_found = result.candidates.length;
    process.stderr.write(`[candidate-discovery] Showing top ${args.top} of ${beforeCount} candidates (round-robin across ${byModel.size} models)\n`);
  }

  process.stderr.write(`[candidate-discovery] Checked ${result.metadata.total_pairs_checked} pairs, found ${result.metadata.candidates_found} candidates (threshold=${result.metadata.threshold}, maxHops=${result.metadata.max_hops})\n`);

  // Write candidates.json
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2) + '\n');
  process.stderr.write(`[candidate-discovery] Written to: ${OUTPUT_PATH}\n`);

  // JSON output for piping
  if (args.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  }

  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { discoverCandidates };

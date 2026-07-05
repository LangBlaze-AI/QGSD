#!/usr/bin/env node
'use strict';
// bin/nf-solve.cjs
// Consistency solver orchestrator: sweeps Requirements->Formal->Tests->Code->Docs,
// computes a residual vector per layer transition, and auto-closes gaps.
//
// Layer transitions (8 forward + 3 reverse + 3 layer alignment + 5 evidence/maturity):
//   R->F: Requirements without formal model coverage
//   F->T: Formal invariants without test backing
//   C->F: Code constants diverging from formal specs
//   T->C: Failing unit tests
//   F->C: Failing formal verification checks
//   R->D: Requirements not documented in developer docs
//   D->C: Stale structural claims in docs (dead file paths, missing CLI commands, absent dependencies)
//   P->F: Acknowledged production debt entries diverging from formal model thresholds
// Reverse (discovery-only, human-gated):
//   C->R: Source modules in bin/hooks/ with no requirement tracing
//   T->R: Test files with no @req annotation or formal-test-sync mapping
//   D->R: Doc capability claims without requirement backing
// Layer alignment (cross-layer gate checks):
//   L1->L2: Wiring:Evidence alignment score
//   L2->L3: Wiring:Purpose alignment score
//   L3->TC: Wiring:Coverage alignment score
// Evidence & maturity:
//   F->G: Formal models at gate maturity 0 (not yet promoted through gates)
//   C->E: High-churn code files (git heatmap) lacking formal coverage
//   G->F: Failure scenarios in git history that formal models cannot explain (TLA+ drift)
//   F->F: Formal model self-consistency lint (fat, unbounded, or overly complex models)
//   F->H: Hazard model FMEA — state transitions with critical/high RPN scores
//
// Usage:
//   node bin/nf-solve.cjs                  # full sync, up to 3 iterations
//   node bin/nf-solve.cjs --report-only    # single sweep, no mutations
//   node bin/nf-solve.cjs --max-iterations=1
//   node bin/nf-solve.cjs --json           # machine-readable output
//   node bin/nf-solve.cjs --verbose        # pipe child stderr to parent stderr
//   node bin/nf-solve.cjs --fast           # skip F->C and T->C layers for sub-second iteration
//   node bin/nf-solve.cjs --skip-proximity  # skip proximity index rebuild (faster re-diagnostic)
//   node bin/nf-solve.cjs --global-timeout=300000  # override global timeout (default: 180s)
//   node bin/nf-solve.cjs --no-timeout      # disable global timeout (for debugging/tests)
//
// Requirements: QUICK-140

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { appendTrendEntry, readGateSummary } = require('./solve-trend-helpers.cjs');
const { LAYER_KEYS } = require('./layer-constants.cjs');
const { resolveGateScore } = require('./gate-score-utils.cjs');
const { updateVerdicts } = require('./oscillation-detector.cjs');
const { filterRequirementsByFocus } = require('./solve-focus-filter.cjs');
const { updatePredictivePower, formatPredictivePowerSummary } = require('./predictive-power.cjs');
const { detectNewlyBlocked } = require('./escalation-classifier.cjs');
const { CycleDetector } = require('./solve-cycle-detector.cjs');
const { measureHypotheses } = require('./hypothesis-measure.cjs')._pure;
const { loadHypothesisTransitions, computeLayerPriorityWeights } = require('./hypothesis-layer-map.cjs');
const { computeWaves, computeWavesFromGraph } = require('./solve-wave-dag.cjs');
const { createAdapter } = require('./coderlm-adapter.cjs');
const { ensureRunning, touchLastQuery, checkIdleStop, reindex } = require('./coderlm-lifecycle.cjs');

const TAG = '[nf-solve]';
let ROOT = process.cwd();
const SCRIPT_DIR = __dirname;
const DEFAULT_MAX_ITERATIONS = 100;

/**
 * Compute real impact from git diff since last commit.
 * Returns { bugs_fixed, tests_added, docs_fixed, dead_code_removed }
 */
function computeRealImpact() {
  try {
    const { execSync } = require('child_process');
    const diffOutput = execSync('git diff --stat -- \\:\\(exclude\\).planning HEAD~1', { encoding: 'utf8' });
    const lines = diffOutput.split('\n');
    let bugs_fixed = 0;
    let tests_added = 0;
    let docs_fixed = 0;
    let dead_code_removed = 0;
    for (const line of lines) {
      if (line.includes('|') && line.includes('Bin')) {
        const parts = line.split('|');
        const file = parts[0].trim();
        if (file.startsWith('src/') || file.startsWith('bin/') || file.startsWith('lib/')) {
          bugs_fixed++;
        } else if (file.startsWith('test/') && line.includes('++')) {
          tests_added++;
        } else if (file.startsWith('docs/')) {
          docs_fixed++;
        }
        if (line.includes('deletions') && line.includes('insertions')) {
          const ins = parseInt(line.match(/(\d+) insertions/)[1]) || 0;
          const del = parseInt(line.match(/(\d+) deletions/)[1]) || 0;
          if (del > ins) dead_code_removed++;
        }
      }
    }
    return { bugs_fixed, tests_added, docs_fixed, dead_code_removed };
  } catch (e) {
    return { bugs_fixed: 0, tests_added: 0, docs_fixed: 0, dead_code_removed: 0 };
  }
}

// QUICK-343: PID of background run-formal-verify.cjs process (null when not running)
let _formalVerifyBgPid = null;

// ── Embedding fallback for proximity enrichment ──────────────────────────────
// When BFS finds no graph path from a node to a requirement, the embedding cache
// provides a semantic nearest-requirement fallback. Lazy-loaded, fail-open.
let _embedCache = null;
let _embedCacheLoaded = false;
let _embedReqKeys = null; // pre-filtered requirement keys for fast lookup

function loadEmbedCache() {
  if (_embedCacheLoaded) return _embedCache;
  _embedCacheLoaded = true;
  try {
    const cachePath = path.join(ROOT, '.planning', 'formal', 'embedding-cache.json');
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (data && data.vectors && data.schema_version === '1') {
      _embedCache = data;
      _embedReqKeys = Object.keys(data.vectors).filter(k => k.startsWith('requirement::'));
    }
  } catch { /* fail-open */ }
  return _embedCache;
}

/**
 * Find the nearest requirement to a node key using embedding cosine similarity.
 * Returns { nearest_req, similarity, proximity_context } or null if no cache.
 */
function embeddingNearestReq(nodeKey) {
  const cache = loadEmbedCache();
  if (!cache || !cache.vectors[nodeKey] || !_embedReqKeys) return null;

  const vec = cache.vectors[nodeKey];
  let bestSim = -1;
  let bestKey = null;
  const topN = []; // for proximity_context

  for (const rk of _embedReqKeys) {
    const rv = cache.vectors[rk];
    let dot = 0;
    for (let i = 0; i < vec.length; i++) dot += vec[i] * rv[i];
    topN.push({ key: rk, sim: dot });
    if (dot > bestSim) {
      bestSim = dot;
      bestKey = rk;
    }
  }

  if (!bestKey || bestSim < 0.3) return null;

  // Build proximity_context from top-5 matches
  topN.sort((a, b) => b.sim - a.sim);
  const proximity_context = topN.slice(0, 5).map(t => t.key);

  return {
    nearest_req: bestKey.replace('requirement::', ''),
    similarity: Math.round(bestSim * 1000) / 1000,
    proximity_context,
  };
}

// ── Layer script mapping for coderlm callers queries ────────────────────────
// Maps layer keys to their primary script files for inter-layer dependency discovery

const LAYER_SCRIPT_MAP = {
  f_to_t: 'bin/formal-test-sync.cjs',
  c_to_f: 'bin/nf-solve.cjs',           // inline handler, no separate script
  t_to_c: 'bin/nf-solve.cjs',           // inline handler
  f_to_c: 'bin/nf-solve.cjs',           // inline handler
  d_to_c: 'bin/nf-solve.cjs',           // inline handler
  git_heatmap: 'bin/git-heatmap.cjs',
  c_to_r: 'bin/nf-solve.cjs',           // inline handler
  t_to_r: 'bin/nf-solve.cjs',           // inline handler
  d_to_r: 'bin/nf-solve.cjs',           // inline handler
  hazard_model: 'bin/hazard-model.cjs',
  l1_to_l3: 'bin/nf-solve.cjs',         // inline handler
  l3_to_tc: 'bin/generate-traceability-matrix.cjs',
  per_model_gates: 'bin/compute-per-model-gates.cjs',
  r_to_f: 'bin/nf-solve.cjs',           // inline handler
  r_to_d: 'bin/nf-solve.cjs',           // inline handler
  p_to_f: 'bin/nf-solve.cjs',           // inline handler
  h_to_m: 'bin/nf-solve.cjs',           // inline handler
  b_to_f: 'bin/nf-solve.cjs',           // inline handler
};

/**
 * Maps layer keys to their primary exported symbol names.
 * Derived from actual module.exports of each distinct (non-inline) layer script.
 * Inline handlers (pointing to bin/nf-solve.cjs) are excluded — no distinct symbol to query.
 * l3_to_tc is excluded — bin/generate-traceability-matrix.cjs exports no named symbols.
 *
 * Symbol names verified via: node -e "const m = require('./bin/<script>'); console.log(Object.keys(m))"
 */
const LAYER_SYMBOL_MAP = {
  f_to_t: 'classifyTestStrategy',      // bin/formal-test-sync.cjs primary export
  git_heatmap: 'computePriority',       // bin/git-heatmap.cjs primary export
  hazard_model: 'generateHazardModel',  // bin/hazard-model.cjs primary export
  per_model_gates: 'computeAggregate',  // bin/compute-per-model-gates.cjs primary export
};

/**
 * Query coderlm for inter-layer dependency edges based on active layer scripts.
 *
 * Uses getImplementationSync for symbol-level precision (CDIAG-01): resolves the actual
 * implementation file for each layer's primary symbol, then queries getCallersSync to get
 * the callers of that symbol.
 *
 * Fallback note: /implementation endpoint returns { file, line } without a callers array.
 * So we use getImplementationSync to confirm the symbol is resolvable (symbol-level precision
 * for the target), then getCallersSync(symbol, implementationFile) to get symbol-level callers.
 * This is more precise than the previous approach (file-basename string matching) because
 * callers are filtered to the specific function, not all importers of the module.
 *
 * Reverse lookup uses path.resolve() comparison (not substring matching) to avoid false
 * matches on similar filenames (CADP-02 compliance).
 *
 * @param {Object} adapter - coderlm adapter instance
 * @param {string[]} activeLayerKeys - Array of layer keys with residual > 0
 * @returns {Array<{from: string, to: string}>} Array of discovered edges
 */
function queryEdgesSync(adapter, activeLayerKeys) {
  try {
    const edges = [];

    // Build reverse map: resolved script path -> [layer keys that use it]
    const scriptToLayers = {};
    for (const key of activeLayerKeys) {
      const script = LAYER_SCRIPT_MAP[key];
      if (!script) continue;
      const resolved = path.resolve(script);
      if (!scriptToLayers[resolved]) scriptToLayers[resolved] = [];
      scriptToLayers[resolved].push(key);
    }

    // For each active layer that has a known primary symbol, query symbol-level callers
    for (const key of activeLayerKeys) {
      const symbol = LAYER_SYMBOL_MAP[key];
      if (!symbol) continue; // inline handler or no known symbol — skip

      const script = LAYER_SCRIPT_MAP[key];
      if (!script) continue;

      try {
        // Step 1: Use getImplementationSync to confirm symbol resolves (symbol-level precision)
        // The response is { file, line } — no callers array (pre-flight verified).
        const implResult = adapter.getImplementationSync(symbol);
        // Use implementation file if available, otherwise fall back to the script path
        const queryFile = (implResult && implResult.file) ? implResult.file : script;

        // Step 2: Use getCallersSync with the resolved symbol + file for caller discovery
        // This gives symbol-level callers (not all importers of the module)
        const callersResult = adapter.getCallersSync(symbol, queryFile);
        if (callersResult.error || !callersResult.callers) continue;

        // Step 3: Map caller files back to layer keys using path.resolve() comparison
        const targetLayers = scriptToLayers[path.resolve(script)] || [];
        for (const callerFile of callersResult.callers) {
          const resolvedCaller = path.resolve(callerFile);
          for (const otherKey of activeLayerKeys) {
            const otherScript = LAYER_SCRIPT_MAP[otherKey];
            if (!otherScript) continue;
            // Use exact path.resolve() comparison — NOT substring/includes matching
            if (resolvedCaller === path.resolve(otherScript)) {
              for (const target of targetLayers) {
                if (target !== otherKey) {
                  edges.push({ from: otherKey, to: target });
                }
              }
            }
          }
        }
      } catch (innerErr) {
        // fail-open per CADP-02: skip this layer's edges on any per-symbol error
        continue;
      }
    }

    return edges;
  } catch (e) {
    // fail-open: any top-level exception returns empty edges (CADP-02)
    return [];
  }
}

// ── CLI flags ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const reportOnly = args.includes('--report-only');
const jsonMode = args.includes('--json');
const verboseMode = args.includes('--verbose');
const fastMode = args.includes('--fast');
let _forceFullSweep = false;
function effectiveFastMode() { return fastMode && !_forceFullSweep; }
const skipProximity = args.includes('--skip-proximity');
const skipHeatmap = args.includes('--skip-heatmap');
const noCoderlm = args.includes('--no-coderlm');
const skipTests = args.includes('--skip-tests');
const requireBaselines = args.includes('--require-baselines');
const noAutoCommit = args.includes('--no-auto-commit');

// Global deadline: abort after N ms to prevent indefinite hangs.
// Uses wall-clock checks between sync operations (setTimeout won't fire during
// heavy sync I/O like proximity index rebuilds or test runner spawns).
// Default: 180s (3 min). Override with --global-timeout=<ms>.
// Disable with --no-timeout (for test suite or manual debugging).
const DEFAULT_GLOBAL_TIMEOUT_MS = 180000;
let globalTimeoutMs = DEFAULT_GLOBAL_TIMEOUT_MS;
for (const arg of args) {
  if (arg.startsWith('--global-timeout=')) {
    const val = parseInt(arg.slice('--global-timeout='.length), 10);
    if (!isNaN(val) && val > 0) globalTimeoutMs = val;
  }
}
const _deadlineEnabled = !args.includes('--no-timeout');
const _deadlineMs = _deadlineEnabled ? Date.now() + globalTimeoutMs : Infinity;
let _deadlineTriggered = false;

/**
 * Check if the global deadline has been exceeded. Call this between expensive
 * sync operations. Returns true if past deadline (caller should skip remaining work).
 */
function pastDeadline() {
  if (!_deadlineEnabled || _deadlineTriggered) return _deadlineTriggered;
  if (Date.now() > _deadlineMs) {
    _deadlineTriggered = true;
    process.stderr.write(TAG + ' TIMEOUT: global deadline reached (' + globalTimeoutMs + 'ms) — skipping remaining layers\n');
  }
  return _deadlineTriggered;
}

/** Return a skip sentinel for layers skipped due to deadline. */
function deadlineSkip() {
  return { residual: -1, detail: { skipped: true, reason: 'global_timeout' } };
}

// QUICK-344: Parse --skip-layers=r_to_f,f_to_t,... for incremental diagnostics
let skipLayerSet = new Set();
for (const arg of args) {
  if (arg.startsWith('--skip-layers=')) {
    const layers = arg.slice('--skip-layers='.length).split(',').map(s => s.trim()).filter(Boolean);
    for (const l of layers) skipLayerSet.add(l);
  }
}

// Parse --project-root (overrides CWD-based ROOT for cross-repo usage)
for (const arg of args) {
  if (arg.startsWith('--project-root=')) {
    ROOT = path.resolve(arg.slice('--project-root='.length));
  }
}

let maxIterations = DEFAULT_MAX_ITERATIONS;
for (const arg of args) {
  if (arg.startsWith('--max-iterations=')) {
    const val = parseInt(arg.slice('--max-iterations='.length), 10);
    if (!isNaN(val) && val >= 1 && val <= 100) {
      maxIterations = val;
    }
  }
}

// Parse --focus flag for topic-scoped diagnostic sweeps
let focusPhrase = null;
for (const arg of args) {
  if (arg.startsWith('--focus=')) {
    focusPhrase = arg.slice('--focus='.length).replace(/^["']|["']$/g, '');
  }
}

const _rawFocusSet = focusPhrase
  ? filterRequirementsByFocus(focusPhrase, { root: ROOT })
  : null;
// Guard against empty Set (filterRequirementsByFocus returns new Set() when no matches)
// An empty truthy Set would filter out ALL requirements → residual 0 for every sweep
const focusSet = (_rawFocusSet && _rawFocusSet.size > 0) ? _rawFocusSet : null;

if (focusSet) {
  process.stderr.write(TAG + ' Focus filter active: ' + focusPhrase + ' (' + focusSet.size + ' requirements matched)\n');
} else if (focusPhrase) {
  process.stderr.write(TAG + ' Focus phrase "' + focusPhrase + '" matched 0 requirements — running unfocused\n');
}

// ── Helper: spawnTool ────────────────────────────────────────────────────────

/**
 * Spawns a child process with error handling and optional stderr piping.
 * Returns { ok: boolean, stdout: string, stderr: string }.
 */
function spawnTool(script, args, opts = {}) {
  const scriptPath = path.join(SCRIPT_DIR, path.basename(script));
  // Auto-forward --project-root to child script
  const childArgs = [...args];
  if (!childArgs.some(a => a.startsWith('--project-root='))) {
    childArgs.push('--project-root=' + ROOT);
  }
  const defaultStdio = verboseMode ? ['pipe', 'pipe', 'inherit'] : 'pipe';
  const spawnOpts = {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: opts.timeout || 120000,
    stdio: opts.stdio || defaultStdio,
    maxBuffer: opts.maxBuffer || 10 * 1024 * 1024,
  };

  try {
    const result = spawnSync(process.execPath, [scriptPath, ...childArgs], spawnOpts);
    if (result.error) {
      return {
        ok: false,
        stdout: '',
        stderr: result.error.message,
      };
    }
    return {
      ok: result.status === 0,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  } catch (err) {
    return {
      ok: false,
      stdout: '',
      stderr: err.message,
    };
  }
}

// ── P->F layer imports ──────────────────────────────────────────────────────

const { sweepPtoF } = require('./sweepPtoF.cjs');
const { autoClosePtoF } = require('./autoClosePtoF.cjs');

// ── Doc discovery helpers ────────────────────────────────────────────────────

/**
 * Simple wildcard matcher for patterns like "**\/*.md" and "README.md".
 * Supports: ** (any path segment), * (any filename segment), literal match.
 */
function matchWildcard(pattern, filePath) {
  const normPath = filePath.replace(/\\/g, '/');
  const normPattern = pattern.replace(/\\/g, '/');

  if (!normPattern.includes('*')) {
    return normPath === normPattern || normPath.endsWith('/' + normPattern);
  }

  let regex = normPattern
    .replace(/\./g, '\\.')
    .replace(/\*\*\//g, '(.+/)?')
    .replace(/\*/g, '[^/]*');
  regex = '^(' + regex + ')$';

  return new RegExp(regex).test(normPath);
}

/**
 * Recursively walk a directory, returning files up to maxDepth levels.
 */
function walkDir(dir, maxDepth, currentDepth) {
  if (currentDepth === undefined) currentDepth = 0;
  if (maxDepth === undefined) maxDepth = 10;
  if (currentDepth > maxDepth) return [];

  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const sub = walkDir(fullPath, maxDepth, currentDepth + 1);
      for (const s of sub) results.push(s);
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Detect uninitialized git submodules that overlap with doc paths.
 * Returns array of { submodule, docKey } warnings.
 */
function detectUninitializedSubmodules(docPaths) {
  const gitmodulesPath = path.join(ROOT, '.gitmodules');
  if (!fs.existsSync(gitmodulesPath)) return [];

  const warnings = [];
  try {
    const content = fs.readFileSync(gitmodulesPath, 'utf8');
    const submodules = [];
    const re = /\[submodule\s+"([^"]+)"\][\s\S]*?path\s*=\s*(.+)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      submodules.push({ name: m[1].trim(), path: m[2].trim() });
    }

    for (const sub of submodules) {
      const subAbsPath = path.join(ROOT, sub.path);
      const isInitialized = fs.existsSync(subAbsPath) &&
        fs.readdirSync(subAbsPath).length > 0;

      for (const [docKey, docPath] of Object.entries(docPaths)) {
        const docNorm = docPath.replace(/\/$/, '');
        if (sub.path === docNorm || sub.path.startsWith(docNorm + '/') || docNorm.startsWith(sub.path + '/')) {
          if (!isInitialized) {
            warnings.push({ submodule: sub.path, docKey, name: sub.name });
          }
        }
      }
    }
  } catch (e) {
    // .gitmodules parse error — fail-open
  }
  return warnings;
}

/**
 * Discover documentation files based on:
 *   1. .planning/polyrepo.json docs field (preferred — knows user vs developer vs examples)
 *   2. .planning/config.json docs_paths (legacy)
 *   3. Fallback patterns: README.md, docs/ (recursive .md)
 * Returns array of { absPath, category } where category is 'user'|'developer'|'examples'|'unknown'.
 */
function discoverDocFiles() {
  let docPatterns = [
    { pattern: 'README.md', category: 'user' },
    { pattern: 'docs/**/*.md', category: 'unknown' },
  ];
  let markerDocs = null;

  // Prefer polyrepo marker docs field
  const markerPath = path.join(ROOT, '.planning', 'polyrepo.json');
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (marker.docs && typeof marker.docs === 'object') {
      markerDocs = marker.docs;
      const patterns = [];
      for (const [key, docPath] of Object.entries(marker.docs)) {
        if (typeof docPath !== 'string') continue;
        if (docPath.endsWith('/')) {
          patterns.push({ pattern: docPath + '**/*.md', category: key });
        } else {
          patterns.push({ pattern: docPath, category: key });
        }
      }
      if (patterns.length > 0) {
        patterns.unshift({ pattern: 'README.md', category: 'user' });
        // Sort: exact paths first, then deeper globs before shallower ones
        patterns.sort((a, b) => {
          const aGlob = a.pattern.includes('*') ? 1 : 0;
          const bGlob = b.pattern.includes('*') ? 1 : 0;
          if (aGlob !== bGlob) return aGlob - bGlob; // exact paths first
          const aDepth = a.pattern.split('/').length;
          const bDepth = b.pattern.split('/').length;
          return bDepth - aDepth; // deeper globs first
        });
        docPatterns = patterns;
      }

      // Check for uninitialized submodules overlapping doc paths
      const subWarnings = detectUninitializedSubmodules(marker.docs);
      for (const w of subWarnings) {
        console.error(
          `[nf-solve] WARNING: docs.${w.docKey} overlaps submodule "${w.name}" ` +
          `(${w.submodule}) which is not initialized. Run: git submodule update --init ${w.submodule}`
        );
      }
    }
  } catch (e) {
    // No marker or malformed — fall through to config.json
  }

  // Fall back to config.json docs_paths if marker didn't provide patterns
  if (!markerDocs) {
    const configPath = path.join(ROOT, '.planning', 'config.json');
    try {
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (Array.isArray(configData.docs_paths) && configData.docs_paths.length > 0) {
        docPatterns = configData.docs_paths.map(p => ({ pattern: p, category: 'unknown' }));
      }
    } catch (e) {
      // Use defaults
    }
  }

  const found = new Map();

  for (const { pattern, category } of docPatterns) {
    if (pattern.includes('*')) {
      const parts = pattern.replace(/\\/g, '/').split('/');
      let baseDir = ROOT;
      for (const part of parts) {
        if (part.includes('*')) break;
        baseDir = path.join(baseDir, part);
      }
      if (!fs.existsSync(baseDir)) continue;

      const allFiles = walkDir(baseDir, 10, 0);
      for (const f of allFiles) {
        const relative = path.relative(ROOT, f).replace(/\\/g, '/');
        if (matchWildcard(pattern, relative)) {
          if (!found.has(f)) found.set(f, category);
        }
      }
    } else {
      const fullPath = path.join(ROOT, pattern);
      if (fs.existsSync(fullPath)) {
        if (!found.has(fullPath)) found.set(fullPath, category);
      }
    }
  }

  return Array.from(found.entries()).map(([absPath, category]) => ({ absPath, category }));
}

// ── Keyword extraction ──────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'this', 'that', 'with', 'from', 'into', 'each', 'when',
  'must', 'should', 'will', 'have', 'been', 'does', 'also', 'used',
  'using', 'only', 'such', 'both', 'than', 'some', 'more', 'most',
  'very', 'other', 'about', 'which', 'their', 'would', 'could',
  'there', 'where', 'these', 'those', 'after', 'before', 'being',
  'through', 'during', 'between', 'without', 'within', 'against',
  'under', 'above', 'below',
]);

/**
 * Extract keywords from text for fuzzy matching.
 * Strips backtick-wrapped fragments, stopwords, and short tokens.
 * Returns unique lowercase tokens.
 */
function extractKeywords(text) {
  let cleaned = text.replace(/`[^`]*`/g, ' ');
  const tokens = cleaned.split(/[\s,;:.()\[\]{}<>!?"']+/);

  const seen = new Set();
  const result = [];

  for (const raw of tokens) {
    const token = raw.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (token.length < 4) continue;
    if (STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }

  return result;
}

// ── Structural claims extraction ─────────────────────────────────────────────

/**
 * Extract structural claims (file paths, CLI commands, dependencies) from doc content.
 * Skips fenced code blocks, Example/Template headings, template variables,
 * home directory paths, and code expressions.
 * Returns array of { line, type, value, doc_file }.
 */
function extractStructuralClaims(docContent, filePath) {
  const lines = docContent.split('\n');
  const claims = [];
  let inFencedBlock = false;
  let skipSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track fenced code blocks
    if (line.trimStart().startsWith('```')) {
      inFencedBlock = !inFencedBlock;
      continue;
    }
    if (inFencedBlock) continue;

    // Track headings - skip Example/Template sections
    const headingMatch = line.match(/^#{1,6}\s+(.+)/);
    if (headingMatch) {
      const headingText = headingMatch[1].toLowerCase();
      skipSection = headingText.includes('example') || headingText.includes('template');
      continue;
    }
    if (skipSection) continue;

    // Find backtick-wrapped values
    const backtickPattern = /`([^`]+)`/g;
    let match;
    while ((match = backtickPattern.exec(line)) !== null) {
      const value = match[1].trim();
      if (value.length < 4) continue;

      // Filter: template variables
      if (value.includes('{') || value.includes('}')) continue;

      // Filter: home directory paths
      if (value.startsWith('~/')) continue;

      // Filter: code expressions (operators)
      if (/[+=>]|&&|\|\|/.test(value)) continue;

      // Classify the claim
      let type = null;

      // CLI command: starts with node, npx, npm
      if (/^(node|npx|npm)\s+/.test(value)) {
        type = 'cli_command';
      }
      // File path: contains / with extension, or starts with .
      else if ((value.includes('/') && /\.\w+$/.test(value)) || (value.startsWith('.') && /\.\w+$/.test(value))) {
        if (value.startsWith('/')) continue;
        type = 'file_path';
      }
      // Dependency: npm-style package name (lowercase, optional @scope/)
      // Must be scoped (@scope/name) or contain a hyphen to qualify.
      // Single bare words in docs are almost always concept references, not deps.
      // Structural filters only — no prefix-based filters (would reject real pkgs like run-sequence).
      // sweepDtoC cross-references against package.json for the actual broken check.
      else if (/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(value) && !value.includes('/')) {
        const isDep =
          !value.includes('.') &&                               // config keys (quorum.active), filenames (nf-solve.cjs)
          !value.includes('_') &&                               // snake_case identifiers (fail_mode, stop_hook_active)
          !value.startsWith('mcp__') &&                         // MCP tool references
          !['true','false','undefined','null','none','pass'].includes(value) && // JS/JSON keywords
          (value.startsWith('@') || value.includes('-'));        // must be scoped or hyphenated (bare words are not deps)
        if (isDep) type = 'dependency';
      }

      if (type) {
        claims.push({
          line: i + 1,
          type: type,
          value: value,
          doc_file: filePath,
        });
      }
    }
  }

  return claims;
}

// ── Preflight bootstrap ──────────────────────────────────────────────────────

/**
 * Auto-creates .planning/formal/ subdirectories if missing on first run.
 * Called at the top of main() before the iteration loop.
 */
function preflight() {
  // Guard: validate ROOT looks like a project root before creating directories.
  // Prevents creating .planning/ inside bin/ or other wrong locations when
  // subagents run with incorrect cwd.
  const rootMarkers = ['package.json', '.planning', 'CLAUDE.md'].map(m => path.join(ROOT, m));
  const hasMarker = rootMarkers.some(m => fs.existsSync(m));
  if (!hasMarker) {
    process.stderr.write(
      '[nf-solve] WARNING: ROOT does not look like a project root ' +
      '(no package.json, .planning/, or CLAUDE.md at ' + ROOT + '). ' +
      'Skipping directory creation. Pass --project-root= to specify the correct path.\n'
    );
    return;
  }

  const formalDir = path.join(ROOT, '.planning', 'formal');
  const subdirs = ['tla', 'alloy', 'generated-stubs'];
  let created = false;

  if (!fs.existsSync(formalDir)) {
    fs.mkdirSync(formalDir, { recursive: true });
    created = true;
  }

  for (const sub of subdirs) {
    const subPath = path.join(formalDir, sub);
    if (!fs.existsSync(subPath)) {
      fs.mkdirSync(subPath, { recursive: true });
      created = true;
    }
  }

  // Seed model-registry.json if missing
  const registryPath = path.join(formalDir, 'model-registry.json');
  if (!fs.existsSync(registryPath)) {
    try {
      fs.writeFileSync(registryPath, JSON.stringify({ models: [], search_dirs: [] }, null, 2) + '\n');
      created = true;
    } catch (e) {
      // fail-open
    }
  }

  if (created) {
    process.stderr.write(TAG + ' Bootstrapped formal infrastructure\n');
  }

  // Check formal tool installation (install-formal-tools.cjs)
  try {
    const { resolveTlaJar, resolveAlloyJar } = require('./resolve-formal-tools.cjs');
    if (!resolveTlaJar(ROOT) || !resolveAlloyJar(ROOT)) {
      process.stderr.write(TAG + ' Formal tools missing — running install-formal-tools.cjs\n');
      spawnTool('bin/install-formal-tools.cjs', []);
    }
  } catch (e) {
    // fail-open: tools install is best-effort
  }

  // Refresh PRISM constants from scoreboard (export-prism-constants.cjs)
  try {
    const scoreboardPath = path.join(ROOT, '.planning', 'quorum-scoreboard.json');
    if (fs.existsSync(scoreboardPath)) {
      const prismResult = spawnTool('bin/export-prism-constants.cjs', []);
      if (!prismResult.ok) {
        process.stderr.write(TAG + ' WARNING: export-prism-constants.cjs failed; PRISM constants may be stale\n');
      }
    }
  } catch (e) {
    // fail-open: PRISM constants refresh is best-effort
  }

  // Rebuild proximity index (formal-proximity.cjs)
  if (skipProximity) {
    process.stderr.write(TAG + ' Skipping proximity index rebuild (--skip-proximity)\n');
  } else {
    try {
      const specDir = path.join(ROOT, '.planning', 'formal', 'spec');
      if (fs.existsSync(specDir)) {
        process.stderr.write(TAG + ' Rebuilding proximity index\n');
        const proxResult = spawnTool('bin/formal-proximity.cjs', []);
        if (!proxResult.ok) {
          process.stderr.write(TAG + ' WARNING: formal-proximity.cjs failed; proximity index may be stale\n');
        }
      }
    } catch (e) {
      // fail-open: proximity index rebuild is best-effort
    }
  }
}

// ── Layer transition sweeps ──────────────────────────────────────────────────

/**
 * Triage requirements by formalizability.
 * Scores each requirement into HIGH/MEDIUM/LOW/SKIP priority buckets.
 * @param {Array} requirements - Array of requirement objects with text/description fields
 * @returns {{ high: string[], medium: string[], low: string[], skip: string[] }}
 */
function triageRequirements(requirements) {
  const HIGH_KEYWORDS = ['shall', 'must', 'invariant', 'constraint'];
  const MEDIUM_KEYWORDS = ['should', 'verify', 'ensure', 'validate', 'check'];
  const LOW_KEYWORDS = ['may', 'could', 'consider', 'nice-to-have'];
  const SKIP_KEYWORDS = ['deferred', 'out-of-scope', 'deprecated'];

  const result = { high: [], medium: [], low: [], skip: [] };

  for (const req of requirements) {
    const id = req.id || req.requirement_id || '';
    if (!id) continue;

    const text = (req.text || req.description || '').toLowerCase();

    // Check formalizability field override
    if (req.formalizability === 'high') {
      result.high.push(id);
      continue;
    }

    // Priority order: SKIP > HIGH > MEDIUM > LOW
    if (SKIP_KEYWORDS.some(kw => new RegExp('\\b' + kw + '\\b', 'i').test(text))) {
      result.skip.push(id);
    } else if (HIGH_KEYWORDS.some(kw => new RegExp('\\b' + kw + '\\b', 'i').test(text))) {
      result.high.push(id);
    } else if (MEDIUM_KEYWORDS.some(kw => new RegExp('\\b' + kw + '\\b', 'i').test(text))) {
      result.medium.push(id);
    } else if (LOW_KEYWORDS.some(kw => new RegExp('\\b' + kw + '\\b', 'i').test(text))) {
      result.low.push(id);
    } else {
      result.low.push(id); // default to low if no keywords match
    }
  }

  return result;
}

/**
 * R->F: Requirements to Formal coverage.
 * Returns { residual: N, detail: {...} }
 */
function sweepRtoF() {
  const result = spawnTool('bin/generate-traceability-matrix.cjs', [
    '--json',
    '--quiet',
  ]);

  if (!result.ok) {
    return {
      residual: -1,
      detail: {
        error: result.stderr || 'generate-traceability-matrix.cjs failed',
      },
    };
  }

  try {
    const matrix = JSON.parse(result.stdout);
    const coverage = matrix.coverage_summary || {};
    const uncovered = coverage.uncovered_requirements || [];
    const total = coverage.total_requirements || 0;
    const covered = coverage.covered_requirements || 0;
    const percentage = total > 0 ? ((covered / total) * 100).toFixed(1) : 0;

    // Triage uncovered requirements by formalizability
    // Load full requirements to get text for keyword matching
    const reqPath = path.join(ROOT, '.planning', 'formal', 'requirements.json');
    let uncoveredReqs = [];
    try {
      const reqData = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
      let allReqs = [];
      if (Array.isArray(reqData)) {
        allReqs = reqData;
      } else if (reqData.requirements && Array.isArray(reqData.requirements)) {
        allReqs = reqData.requirements;
      } else if (reqData.groups && Array.isArray(reqData.groups)) {
        for (const group of reqData.groups) {
          if (group.requirements && Array.isArray(group.requirements)) {
            for (const r of group.requirements) allReqs.push(r);
          }
        }
      }
      const uncoveredSet = new Set(uncovered);
      uncoveredReqs = allReqs.filter(r => uncoveredSet.has(r.id || r.requirement_id || ''));

      // Filter out Pending/Future requirements — they don't need formal coverage yet (#27)
      const EXCLUDED_STATUSES = new Set(['Pending', 'Future']);
      uncoveredReqs = uncoveredReqs.filter(r => !EXCLUDED_STATUSES.has(r.status));
    } catch (e) {
      // Can't load requirements — skip triage
    }

    // Apply focus filter if active
    if (focusSet) {
      uncoveredReqs = uncoveredReqs.filter(r => focusSet.has(r.id || r.requirement_id || ''));
    }

    const triage = triageRequirements(uncoveredReqs);
    const highIds = triage.high;
    const mediumIds = triage.medium;
    const priority_batch = highIds.concat(mediumIds).slice(0, 15);

    // Residual uses filtered count (excludes Pending/Future) — not raw uncovered.length
    const activeUncoveredIds = new Set(uncoveredReqs.map(r => r.id || r.requirement_id || ''));
    const activeUncovered = uncovered.filter(id => activeUncoveredIds.has(id));
    const pendingExcluded = uncovered.length - activeUncovered.length;

    // Check for traceability-matrix.json broken status — mutation sets status="broken"
    let traceBrokenResidual = 0;
    const tracePath4 = path.join(ROOT, '.planning', 'formal', 'traceability-matrix.json');
    try {
      if (fs.existsSync(tracePath4)) {
        const tData4 = JSON.parse(fs.readFileSync(tracePath4, 'utf8'));
        if (tData4.status === 'broken') {
          traceBrokenResidual = 5;
        }
      }
    } catch (_) {}

    // Solve-state wave_count=0 check — BENCH-225: zero wave_count signals stale/corrupted wave analysis
    let solveStateResidual = 0;
    try {
      const ssPath = path.join(ROOT, '.planning', 'formal', 'solve-state.json');
      if (fs.existsSync(ssPath)) {
        const ssData = JSON.parse(fs.readFileSync(ssPath, 'utf8'));
        if (ssData.wave_count === 0) {
          solveStateResidual = 3; // stale wave state is an r_to_f concern
        }
      }
    } catch (_) {}

    // Proximity-index version corruption check — BENCH-229: version < 0 signals index corruption
    let proximityCorruptResidual = 0;
    try {
      const piPath = path.join(ROOT, '.planning', 'formal', 'proximity-index.json');
      if (fs.existsSync(piPath)) {
        const piData = JSON.parse(fs.readFileSync(piPath, 'utf8'));
        if (typeof piData.version === 'number' && piData.version < 0) {
          proximityCorruptResidual = 4; // corrupted proximity index affects requirement coverage analysis
        }
      }
    } catch (_) {}

    const finalResidual = Math.max(activeUncovered.length, traceBrokenResidual, solveStateResidual, proximityCorruptResidual);
    return {
      residual: finalResidual,
      detail: {
        uncovered_requirements: activeUncovered,
        total: total,
        covered: covered,
        percentage: percentage,
        pending_excluded: pendingExcluded,
        triage: {
          high: triage.high.length,
          medium: triage.medium.length,
          low: triage.low.length,
          skip: triage.skip.length,
        },
        priority_batch: priority_batch,
        trace_broken: traceBrokenResidual > 0 ? true : undefined,
        solve_state_stale: solveStateResidual > 0 ? true : undefined,
        proximity_corrupted: proximityCorruptResidual > 0 ? true : undefined,
      },
    };
  } catch (err) {
    return {
      residual: -1,
      detail: { error: 'Failed to parse traceability matrix: ' + err.message },
    };
  }
}

/**
 * Cache for formal-test-sync.cjs --json --report-only result.
 */
let formalTestSyncCache = null;

/**
 * Active adapter instance from solve() scope, used for enrichment in sweepGitHeatmap().
 * Set at loop start, cleared after each iteration.
 */
let _activeAdapter = null;

/**
 * Circuit-breaker: consecutive coderlm query failure count.
 * Resets to 0 on any successful query. When >= 3, sweepGitHeatmap skips coderlm
 * for the remainder of the run to avoid repeated 5 s timeout overhead.
 */
let _coderlmConsecutiveFailures = 0;

// Repowise session caches — computed once, reused across iterations
let _repowiseHotspotCache = null;
let _repowiseCochangeCache = null;

/**
 * Helper to load and cache formal-test-sync result.
 */
function loadFormalTestSync() {
  if (formalTestSyncCache) return formalTestSyncCache;

  const result = spawnTool('bin/formal-test-sync.cjs', [
    '--json',
    '--report-only',
  ]);

  if (!result.ok) {
    formalTestSyncCache = null;
    return null;
  }

  try {
    formalTestSyncCache = JSON.parse(result.stdout);
    return formalTestSyncCache;
  } catch (err) {
    formalTestSyncCache = null;
    return null;
  }
}

/**
 * Cache for code-trace-index.json result.
 */
let codeTraceIndexCache = null;

/**
 * Helper to load and cache code-trace index.
 * Returns null on missing or parse error (graceful degradation).
 */
function loadCodeTraceIndex() {
  if (codeTraceIndexCache) return codeTraceIndexCache;

  const indexPath = path.join(ROOT, '.planning', 'formal', 'code-trace-index.json');
  if (!fs.existsSync(indexPath)) {
    return null;
  }

  try {
    codeTraceIndexCache = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    return codeTraceIndexCache;
  } catch (err) {
    return null;
  }
}

/**
 * Rebuild code-trace index from recipes and scopes.
 * Called before each computeResidual to ensure fresh data.
 */
function rebuildCodeTraceIndex() {
  codeTraceIndexCache = null;  // Clear cache

  try {
    const { buildIndex } = require('./build-code-trace.cjs');
    const index = buildIndex(ROOT);
    codeTraceIndexCache = index;
    return index;
  } catch (err) {
    return null;
  }
}

/**
 * F->T: Formal to Tests coverage.
 * Returns { residual: N, detail: {...} }
 */
function sweepFtoT() {
  const syncData = loadFormalTestSync();

  if (!syncData) {
    return {
      residual: -1,
      detail: { error: 'formal-test-sync.cjs failed' },
    };
  }

  const gaps = syncData.coverage_gaps || {};
  const stats = gaps.stats || {};
  let gapCount = stats.gap_count || 0;
  let gapsList = gaps.gaps || [];

  // Apply focus filter if active
  if (focusSet) {
    gapsList = gapsList.filter(g => focusSet.has(g.requirement_id || g));
    gapCount = gapsList.length;
  }

  // Fold: annotate-tests (informational — does NOT add to residual)
  let test_annotations = 0;
  try {
    const atResult = spawnTool('bin/annotate-tests.cjs', ['--json']);
    if (atResult.ok && atResult.stdout) {
      const atData = JSON.parse(atResult.stdout);
      test_annotations = (atData.suggestions || atData.annotations || []).length;
    }
  } catch (_) { /* fail-open */ }

  return {
    residual: gapCount,
    detail: {
      gap_count: gapCount,
      formal_covered: stats.formal_covered || 0,
      test_covered: stats.test_covered || 0,
      gaps: gapsList.map((g) => g.requirement_id || g),
      test_annotations,
    },
  };
}

/**
 * C->F: Code constants to Formal constants.
 * Returns { residual: N, detail: {...} }
 */
function sweepCtoF() {
  const syncData = loadFormalTestSync();

  if (!syncData) {
    return {
      residual: -1,
      detail: { error: 'formal-test-sync.cjs failed' },
    };
  }

  const validation = syncData.constants_validation || [];
  const mismatches = validation.filter((entry) => {
    return (
      entry.match === false &&
      entry.intentional_divergence !== true &&
      entry.config_path !== null
    );
  });

  // Enrich mismatches with proximity graph data (fail-open)
  let enrichedMismatches = mismatches.map((m) => ({
    constant: m.constant,
    source: m.source,
    formal_value: m.formal_value,
    config_value: m.config_value,
  }));

  try {
    const indexPath = path.join(ROOT, '.planning', 'formal', 'proximity-index.json');
    if (fs.existsSync(indexPath) && mismatches.length > 0) {
      const { reach } = require('./formal-query.cjs');
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

      enrichedMismatches = mismatches.map((m) => {
        const entry = {
          constant: m.constant,
          source: m.source,
          formal_value: m.formal_value,
          config_value: m.config_value,
        };

        const constKey = 'constant::' + m.constant;
        if (index.nodes && index.nodes[constKey]) {
          const filter = ['invariant', 'requirement', 'formal_model'];
          const reachable = reach(index, constKey, 3, filter);
          const affected = [];
          for (const nodes of Object.values(reachable)) {
            for (const n of nodes) {
              affected.push({ type: n.type, id: n.key.split('::').slice(1).join('::'), via: n.rel });
            }
          }
          if (affected.length > 0) {
            entry.affected = affected;
          }
        }

        return entry;
      });
    }
  } catch (e) {
    // fail-open: proximity enrichment is best-effort
  }

  return {
    residual: mismatches.length,
    detail: {
      mismatches: enrichedMismatches,
      scoped: focusSet ? false : undefined,
    },
  };
}

/**
 * T->C: Tests to Code.
 * Returns { residual: N, detail: {...} }
 */
function sweepTtoC() {
  // Guard: if we're already running inside a node --test subprocess spawned by a
  // previous sweepTtoC() call, return a skip immediately.  Without this, any test
  // that calls sweepTtoC() (or computeResidual()) would trigger an infinite chain
  // of recursive `node --test` subprocesses that never terminate.
  if (process.env.NF_SOLVE_SWEEPTOC_ACTIVE) {
    return { residual: -1, detail: { skipped: true, reason: 'recursive-guard: already running inside node --test' } };
  }

  // Load configurable test runner settings
  const configPath = path.join(ROOT, '.planning', 'config.json');
  let tToCConfig = { runner: 'node-test', command: null, scope: 'all' };
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (cfg.solve && cfg.solve.t_to_c) {
      tToCConfig = { ...tToCConfig, ...cfg.solve.t_to_c };
    }
  } catch (e) { /* use defaults */ }

  // Runner mode: none — skip entirely
  if (tToCConfig.runner === 'none') {
    return { residual: 0, detail: { skipped: true, reason: 'runner=none in config' } };
  }

  const spawnOpts = {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 120000,
    stdio: verboseMode ? ['pipe', 'pipe', 'inherit'] : 'pipe',
  };

  // Runner mode: jest
  if (tToCConfig.runner === 'jest') {
    const jestCmd = tToCConfig.command || 'npx';
    const jestArgs = tToCConfig.command ? [] : ['jest', '--ci', '--json'];
    let result;
    try {
      result = spawnSync(jestCmd, jestArgs, spawnOpts);
    } catch (err) {
      return {
        residual: -1,
        detail: { error: 'Failed to spawn jest: ' + err.message },
      };
    }

    const output = (result.stdout || '') + (result.stderr || '');
    // Try to parse Jest JSON output
    try {
      const jsonStart = output.indexOf('{');
      if (jsonStart >= 0) {
        const jestResult = JSON.parse(output.slice(jsonStart));
        const failCount = jestResult.numFailedTests || 0;
        const totalTests = jestResult.numTotalTests || 0;
        return {
          residual: failCount,
          detail: {
            total_tests: totalTests,
            passed: totalTests - failCount,
            failed: failCount,
            skipped: 0,
            todo: 0,
            runner: 'jest',
            scoped: focusSet ? false : undefined,
          },
        };
      }
    } catch (e) { /* fall through to TAP parsing */ }

    return {
      residual: -1,
      detail: { error: 'Failed to parse jest output', runner: 'jest' },
    };
  }

  // Runner mode: node-test (default)
  // V8 coverage collection: create temp dir and set NODE_V8_COVERAGE env var
  let covDir = null;
  try {
    covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-solve-cov-'));
    spawnOpts.env = Object.assign({}, process.env, { NODE_V8_COVERAGE: covDir, NF_SOLVE_SWEEPTOC_ACTIVE: '1' });
  } catch (e) {
    covDir = null; // fail-open: continue without coverage
  }

  // Ensure guard env var is always set, even when covDir creation failed
  if (!spawnOpts.env) {
    spawnOpts.env = Object.assign({}, process.env, { NF_SOLVE_SWEEPTOC_ACTIVE: '1' });
  }

  // Build test glob args from include_paths/exclude_paths config (#23)
  const testArgs = ['--test'];
  if (tToCConfig.include_paths && Array.isArray(tToCConfig.include_paths)) {
    // When include_paths is set, pass explicit globs instead of relying on auto-discovery
    for (const p of tToCConfig.include_paths) {
      testArgs.push(p.endsWith('/') ? p + '**/*.test.{js,cjs,mjs}' : p);
    }
  }

  let result;
  try {
    result = spawnSync(process.execPath, testArgs, spawnOpts);
  } catch (err) {
    return {
      residual: -1,
      detail: { error: 'Failed to spawn node --test: ' + err.message },
    };
  }

  // Filter out results from excluded paths (#23)
  const excludePaths = (tToCConfig.exclude_paths && Array.isArray(tToCConfig.exclude_paths))
    ? tToCConfig.exclude_paths
    : [];

  const output = (result.stdout || '') + (result.stderr || '');

  // Parse TAP output for test summary.
  // Support both # prefix (Node <= v24) and ℹ prefix (Node v25+)
  let totalTests = 0;
  let failCount = 0;
  let skipCount = 0;
  let todoCount = 0;

  const testsMatch = output.match(/^[ℹ#]\s+tests\s+(\d+)/m);
  if (testsMatch) totalTests = parseInt(testsMatch[1], 10);

  const failMatch = output.match(/^[ℹ#]\s+fail\s+(\d+)/m);
  if (failMatch) failCount = parseInt(failMatch[1], 10);

  const skipMatch = output.match(/^[ℹ#]\s+skipped\s+(\d+)/m);
  if (skipMatch) skipCount = parseInt(skipMatch[1], 10);

  const todoMatch = output.match(/^[ℹ#]\s+todo\s+(\d+)/m);
  if (todoMatch) todoCount = parseInt(todoMatch[1], 10);

  // Fallback: count "not ok" lines if summary not found
  if (failCount === 0 && totalTests === 0) {
    const notOkMatches = output.match(/^not ok\s+\d+/gm) || [];
    failCount = notOkMatches.length;
    const okMatches = output.match(/^ok\s+\d+/gm) || [];
    totalTests = notOkMatches.length + okMatches.length;
    skipCount = 0;
    todoCount = 0;
  }

  // Subtract failures from excluded paths (#23)
  if (excludePaths.length > 0 && failCount > 0) {
    const failLines = output.match(/^not ok\s+\d+\s+.*/gm) || [];
    let excludedFails = 0;
    for (const line of failLines) {
      if (excludePaths.some(ep => line.includes(ep.replace(/\/$/, '')))) {
        excludedFails++;
      }
    }
    if (excludedFails > 0) {
      failCount = Math.max(0, failCount - excludedFails);
      totalTests = Math.max(0, totalTests - excludedFails);
    }
  }

  // Collect V8 coverage data from temp directory (fail-open)
  let coverageData = null;
  try {
    if (covDir && fs.existsSync(covDir)) {
      const covFiles = fs.readdirSync(covDir).filter(f => f.endsWith('.json'));
      coverageData = [];
      for (const cf of covFiles) {
        const raw = fs.readFileSync(path.join(covDir, cf), 'utf8');
        coverageData.push(JSON.parse(raw));
      }
      if (coverageData.length === 0) coverageData = null;
    }
  } catch (e) {
    coverageData = null; // fail-open
  } finally {
    try {
      if (covDir) fs.rmSync(covDir, { recursive: true, force: true });
    } catch (e) { /* ignore cleanup errors */ }
  }

  // Digest V8 coverage: replace raw array with lightweight format
  if (coverageData) {
    coverageData = digestV8Coverage(coverageData);
  }

  // Scope-based auto-detection: if scope is "generated-stubs-only", check if all failures
  // are outside .planning/formal/generated-stubs/
  if (tToCConfig.runner === 'node-test' && tToCConfig.scope === 'generated-stubs-only' && failCount > 0) {
    const failLines = output.match(/^not ok\s+\d+\s+.*/gm) || [];
    const stubFailures = failLines.filter(l => l.includes('generated-stubs'));
    if (stubFailures.length === 0 && failLines.length > 0) {
      return {
        residual: 0,
        detail: {
          total_tests: totalTests,
          passed: Math.max(0, totalTests - failCount - skipCount - todoCount),
          failed: failCount,
          skipped: skipCount,
          todo: todoCount,
          runner_mismatch: true,
          warning: 'All ' + failLines.length + ' failures are outside generated-stubs scope — likely runner mismatch',
          v8_coverage: coverageData,
          scoped: focusSet ? false : undefined,
        },
      };
    }
  }

  // Fold: check-coverage-guard (coverage threshold enforcement)
  let coverageGuardFail = false;
  try {
    const cgResult = spawnTool('bin/check-coverage-guard.cjs', []);
    if (cgResult.exitCode !== 0) {
      coverageGuardFail = true;
    }
  } catch (_) { /* fail-open */ }

  return {
    residual: failCount + skipCount + (coverageGuardFail ? 1 : 0),
    detail: {
      total_tests: totalTests,
      passed: Math.max(0, totalTests - failCount - skipCount - todoCount),
      failed: failCount,
      skipped: skipCount,
      todo: todoCount,
      v8_coverage: coverageData,
      coverage_guard_fail: coverageGuardFail || undefined,
      scoped: focusSet ? false : undefined,
    },
  };
}

/**
 * Digest V8 coverage data: convert raw coverage array to a lightweight per-file format.
 * Input: array of V8 coverage entries (each with .result[] containing .url, .functions[], .source)
 * Output: { files: { [absolutePath]: { covered: number[], uncovered: number[] } } }
 *
 * Purpose: Reduce raw ~96MB V8 JSON to ~50KB by storing only file paths and covered/uncovered line sets.
 * Fail-open: If any entry throws, skip it and continue.
 */
function digestV8Coverage(coverageData) {
  if (!coverageData || !Array.isArray(coverageData)) return null;

  const files = {};

  try {
    for (const entry of coverageData) {
      const results = entry.result || [];

      for (const r of results) {
        if (!r.url) continue;

        // Skip internal node: URLs
        if (r.url.startsWith('node:')) continue;

        try {
          // Extract and resolve file path
          const filePath = r.url.startsWith('file://') ? r.url.slice(7) : r.url;
          const absolutePath = path.resolve(filePath);

          // Initialize file entry if not present
          if (!files[absolutePath]) {
            files[absolutePath] = { covered: [], uncovered: [] };
          }

          // Get source text to build line offset array
          const source = r.source;
          if (!source) {
            // Fallback: if no source, use file-level granularity (boolean)
            // If ANY function range has count > 0, mark file as covered
            const hasCoverage = (r.functions || []).some(fn =>
              (fn.ranges || []).some(range => range.count > 0)
            );
            if (hasCoverage) {
              files[absolutePath].covered = [true];  // boolean marker
            } else {
              files[absolutePath].uncovered = [true];  // boolean marker
            }
            continue;
          }

          // Build line offset array from source text
          const lineOffsets = [0];  // First line starts at offset 0
          for (let i = 0; i < source.length; i++) {
            if (source[i] === '\n') {
              lineOffsets.push(i + 1);
            }
          }

          // Map ranges to line numbers
          const coveredLines = new Set();
          const uncoveredLines = new Set();

          for (const fn of (r.functions || [])) {
            for (const range of (fn.ranges || [])) {
              const startOffset = range.startOffset;
              const endOffset = range.endOffset;
              const count = range.count || 0;

              // Find line numbers that this range covers
              let startLine = lineOffsets.findIndex(offset => offset > startOffset);
              if (startLine === -1) startLine = lineOffsets.length - 1;
              else startLine = Math.max(0, startLine - 1);

              let endLine = lineOffsets.findIndex(offset => offset >= endOffset);
              if (endLine === -1) endLine = lineOffsets.length - 1;

              // Add lines to appropriate set (1-indexed for output)
              for (let lineIdx = startLine; lineIdx < endLine && lineIdx < lineOffsets.length; lineIdx++) {
                const lineNum = lineIdx + 1;
                if (count > 0) {
                  coveredLines.add(lineNum);
                } else {
                  uncoveredLines.add(lineNum);
                }
              }
            }
          }

          // Update file entry with deduplicated, sorted line arrays
          files[absolutePath].covered = Array.from(coveredLines).sort((a, b) => a - b);
          files[absolutePath].uncovered = Array.from(uncoveredLines).filter(
            l => !coveredLines.has(l)
          ).sort((a, b) => a - b);

        } catch (entryErr) {
          // Fail-open: skip this result entry
          continue;
        }
      }
    }
  } catch (err) {
    // Fail-open: return whatever we've collected so far
  }

  return Object.keys(files).length > 0 ? { files } : null;
}

/**
 * Cross-reference V8 coverage data against formal-test-sync recipe source_files.
 * Identifies "false green" properties: tests pass but exercise none of the implementing source files.
 * Returns { available: false } when coverage data is null/undefined.
 *
 * Handles both digest format (new: { files: {...} }) and legacy raw array format.
 */
function crossReferenceFormalCoverage(v8CoverageData) {
  if (!v8CoverageData) return { available: false };

  try {
    const syncData = loadFormalTestSync();
    const recipes = (syncData && syncData.recipes) ? syncData.recipes : [];

    // Build set of covered absolute file paths from V8 data
    const coveredFiles = new Set();

    // Detect format: digest format has .files property; legacy is array
    if (v8CoverageData.files && typeof v8CoverageData.files === 'object') {
      // Digest format: files are keys in the .files object
      for (const absolutePath of Object.keys(v8CoverageData.files)) {
        const fileEntry = v8CoverageData.files[absolutePath];
        // If any covered lines exist (non-empty array), mark file as covered
        if (fileEntry && fileEntry.covered && Array.isArray(fileEntry.covered) && fileEntry.covered.length > 0) {
          coveredFiles.add(path.resolve(absolutePath));
        }
      }
    } else if (Array.isArray(v8CoverageData)) {
      // Legacy raw array format: parse V8 entries
      for (const entry of v8CoverageData) {
        const results = entry.result || [];
        for (const r of results) {
          if (!r.url) continue;
          const filePath = r.url.startsWith('file://') ? r.url.slice(7) : r.url;
          const resolved = path.resolve(filePath);
          // A file is "covered" if ANY function range has count > 0
          const hasCoverage = (r.functions || []).some(fn =>
            (fn.ranges || []).some(range => range.count > 0)
          );
          if (hasCoverage) coveredFiles.add(resolved);
        }
      }
    }

    const coverageRatios = [];
    const falseGreens = [];
    let propertiesWithTests = 0;
    let fullyCovered = 0;
    let partiallyCovered = 0;
    let uncovered = 0;

    for (const recipe of recipes) {
      const sourceFiles = recipe.source_files_absolute || [];
      if (sourceFiles.length === 0) continue;
      const hasTest = !!(recipe.test_file || recipe.test_files);
      if (hasTest) propertiesWithTests++;

      let coveredCount = 0;
      for (const sf of sourceFiles) {
        if (coveredFiles.has(path.resolve(sf))) coveredCount++;
      }
      const ratio = coveredCount / sourceFiles.length;
      const propName = recipe.property || recipe.invariant || recipe.id || 'unknown';

      coverageRatios.push({ property: propName, ratio: ratio });

      if (ratio === 0 && hasTest) {
        falseGreens.push({
          property: propName,
          test_file: recipe.test_file || (recipe.test_files || [])[0] || 'unknown',
          source_files: sourceFiles,
          covered: 0,
        });
        uncovered++;
      } else if (ratio < 1) {
        partiallyCovered++;
      } else {
        fullyCovered++;
      }
    }

    return {
      available: true,
      total_properties: recipes.length,
      properties_with_tests: propertiesWithTests,
      false_greens: falseGreens,
      coverage_ratios: coverageRatios,
      summary: {
        fully_covered: fullyCovered,
        partially_covered: partiallyCovered,
        uncovered: uncovered,
      },
    };
  } catch (e) {
    return { available: false };
  }
}

/**
 * F->C: Formal verification to Code.
 * Returns { residual: N, detail: {...} }
 */
function sweepFtoC() {
  const verifyScript = path.join(SCRIPT_DIR, 'run-formal-verify.cjs');

  if (!fs.existsSync(verifyScript)) {
    return {
      residual: -1,
      detail: { skipped: true, reason: 'missing: run-formal-verify.cjs' },
    };
  }

  // QUICK-343: If background run-formal-verify.cjs was pre-spawned by computeResidual(),
  // wait for it to finish instead of spawning a new synchronous process.
  // The background process writes check-results.ndjson to disk — same output path.
  let syncResult = null;
  if (_formalVerifyBgPid) {
    process.stderr.write(TAG + ' F→C: waiting for background formal verify (PID ' + _formalVerifyBgPid + ')\n');
    // Poll until background process exits (check if PID is still alive)
    const waitStart = Date.now();
    const maxWait = 600000; // 10 min max
    while (_formalVerifyBgPid && (Date.now() - waitStart) < maxWait) {
      try {
        process.kill(_formalVerifyBgPid, 0); // signal 0 = check existence
        spawnSync('sleep', ['0.5']); // yield 500ms
      } catch (e) {
        // Process exited — ESRCH means PID no longer exists
        _formalVerifyBgPid = null;
        break;
      }
    }
    const waitMs = Date.now() - waitStart;
    process.stderr.write(TAG + ' F→C: background verify completed (waited ' + waitMs + 'ms)\n');
  } else {
    // No background process — run synchronously as before
    // stdio: discard stdout ('ignore') because run-formal-verify.cjs writes ~4MB of
    // verbose progress output. We only need the NDJSON file it writes to disk.
    syncResult = spawnTool('bin/run-formal-verify.cjs', [], {
      timeout: 600000,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
  }

  // Generate complexity profile from fresh check-results.ndjson + state-space data
  try {
    spawnTool('bin/model-complexity-profile.cjs', ['--quiet']);
  } catch (e) {
    // fail-open: profiler is informational
  }

  // Non-zero exit is expected when checks fail — still parse check-results.ndjson.
  // Only bail on spawn errors (syncResult.stderr without any ndjson output).
  // syncResult is null when the background path was used — skip this check in that case.
  if (syncResult && !syncResult.ok && syncResult.stderr && !fs.existsSync(path.join(ROOT, '.planning', 'formal', 'check-results.ndjson'))) {
    return {
      residual: -1,
      detail: { error: syncResult.stderr.slice(0, 500) || 'run-formal-verify.cjs failed' },
    };
  }

  // Parse .planning/formal/check-results.ndjson
  const checkResultsPath = path.join(ROOT, '.planning', 'formal', 'check-results.ndjson');

  if (!fs.existsSync(checkResultsPath)) {
    return {
      residual: -1,
      detail: { skipped: true, reason: 'missing: check-results.ndjson' },
    };
  }

  try {
    const lines = fs.readFileSync(checkResultsPath, 'utf8').split('\n');

    // Deduplicate: when multiple runs append to the same NDJSON file,
    // take the LAST entry per check_id (most recent result wins).
    const deduped = new Map();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const id = entry.check_id || entry.id || '?';
        deduped.set(id, entry);
      } catch (e) {
        // skip malformed lines
      }
    }

    let failedCount = 0;
    let errorCount = 0;
    let inconclusiveCount = 0;
    let totalCount = deduped.size;
    const failures = [];
    const errors = [];
    const inconclusiveChecks = [];

    for (const entry of deduped.values()) {
      if (entry.result === 'fail') {
        failedCount++;
        failures.push({
          check_id: entry.check_id || entry.id || '?',
          summary: entry.summary || '',
          requirement_ids: entry.requirement_ids || [],
        });
      } else if (entry.result === 'error') {
        errorCount++;
        errors.push({
          check_id: entry.check_id || entry.id || '?',
          summary: entry.summary || '',
          requirement_ids: entry.requirement_ids || [],
        });
      } else if (entry.result === 'inconclusive') {
        inconclusiveCount++;
        inconclusiveChecks.push({
          check_id: entry.check_id || entry.id || '?',
          summary: entry.summary || '',
        });
      }
    }

    const existingDetail = {
      total_checks: totalCount,
      passed: Math.max(0, totalCount - failedCount - errorCount - inconclusiveCount),
      failed: failedCount,
      error_count: errorCount,
      inconclusive: inconclusiveCount,
      failures: failures,
      errors: errors,
      inconclusive_checks: inconclusiveChecks,
      scoped: focusSet ? false : undefined,
    };

    // Conformance trace self-healing: detect schema mismatch
    const conformancePath = path.join(ROOT, '.planning', 'formal', 'trace', 'conformance-events.jsonl');
    if (fs.existsSync(conformancePath)) {
      try {
        const events = fs.readFileSync(conformancePath, 'utf8').split('\n')
          .filter(l => l.trim())
          .map(l => { try { return JSON.parse(l); } catch(e) { return null; } })
          .filter(Boolean);

        const eventTypes = new Set(events.map(e => e.type || e.event));

        // Try to load XState machine event types from spec/
        const specDir = path.join(ROOT, '.planning', 'formal', 'spec');
        let machineEventTypes = new Set();
        if (fs.existsSync(specDir)) {
          const specFiles = walkDir(specDir, 3, 0);
          for (const f of specFiles) {
            if (!f.endsWith('.json') && !f.endsWith('.js')) continue;
            try {
              const content = fs.readFileSync(f, 'utf8');
              // Extract event types from "on": { "EVENT_NAME": ... } patterns
              const onMatches = content.matchAll(/"on"\s*:\s*\{([^}]+)\}/g);
              for (const m of onMatches) {
                const keys = m[1].matchAll(/"([A-Z_]+)"/g);
                for (const k of keys) machineEventTypes.add(k[1]);
              }
            } catch(e) { /* skip */ }
          }
        }

        if (machineEventTypes.size > 0 && eventTypes.size > 0) {
          const overlap = [...eventTypes].filter(t => machineEventTypes.has(t)).length;
          const overlapPct = overlap / Math.max(eventTypes.size, 1);

          if (overlapPct < 0.5) {
            // Schema mismatch — reclassify
            return {
              residual: failedCount,
              detail: {
                ...existingDetail,
                schema_mismatch: true,
                schema_mismatch_detail: {
                  trace_event_types: eventTypes.size,
                  machine_event_types: machineEventTypes.size,
                  overlap: overlap,
                  overlap_pct: (overlapPct * 100).toFixed(1) + '%',
                },
                note: 'Conformance trace has <50% event type overlap with state machine — likely schema mismatch, not verification failure',
              },
            };
          }
        }
      } catch (e) {
        // Conformance trace check failed — fail-open, continue with normal result
      }
    }

    // Fold: check-spec-sync (formal spec drift)
    try {
      const ssResult = spawnTool('bin/check-spec-sync.cjs', []);
      if (ssResult.exitCode !== 0) {
        failedCount += 1;
        existingDetail.spec_sync_drift = true;
      }
    } catch (_) { /* fail-open */ }

    return {
      residual: failedCount,
      detail: existingDetail,
    };
  } catch (err) {
    return {
      residual: -1,
      detail: { error: 'Failed to parse check-results.ndjson: ' + err.message },
    };
  }
}

/**
 * R->D: Requirements to Documentation.
 * Detects requirements not mentioned in developer docs (by ID or keyword match).
 * Returns { residual: N, detail: {...} }
 */
function sweepRtoD() {
  // Load requirements.json
  const reqPath = path.join(ROOT, '.planning', 'formal', 'requirements.json');
  if (!fs.existsSync(reqPath)) {
    return {
      residual: -1,
      detail: { skipped: true, reason: 'missing: requirements.json', baseline_hint: 'run sync-baseline-requirements.cjs to populate' },
    };
  }

  let reqData;
  try {
    reqData = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
  } catch (e) {
    return {
      residual: -1,
      detail: { skipped: true, reason: 'missing: requirements.json (parse error: ' + e.message + ')', baseline_hint: 'run sync-baseline-requirements.cjs to populate' },
    };
  }

  // Discover doc files
  const allDiscovered = discoverDocFiles();
  // Only scan developer-category docs for R->D gap detection.
  // User docs (category='user') are human-controlled and must not drive auto-remediation.
  // Fall back to all docs only if no developer-category files exist (legacy setup).
  const developerDocs = allDiscovered.filter(f => f.category === 'developer');
  const docFiles = developerDocs.length > 0 ? developerDocs : allDiscovered;
  if (docFiles.length === 0) {
    return {
      residual: -1,
      detail: { skipped: true, reason: 'missing: doc files' },
    };
  }

  // Concatenate all doc content
  let allDocContent = '';
  for (const { absPath } of docFiles) {
    try {
      allDocContent += fs.readFileSync(absPath, 'utf8') + '\n';
    } catch (e) {
      // skip unreadable files
    }
  }
  const allDocContentLower = allDocContent.toLowerCase();

  // Get requirements array - handle both flat array and envelope format
  let requirements = [];
  if (Array.isArray(reqData)) {
    requirements = reqData;
  } else if (reqData.requirements && Array.isArray(reqData.requirements)) {
    requirements = reqData.requirements;
  } else if (reqData.groups && Array.isArray(reqData.groups)) {
    // Envelope format with groups
    for (const group of reqData.groups) {
      if (group.requirements && Array.isArray(group.requirements)) {
        for (const r of group.requirements) requirements.push(r);
      }
    }
  }

  // Apply focus filter if active
  if (focusSet) {
    requirements = requirements.filter(r => focusSet.has(r.id || r.requirement_id || ''));
  }

  const undocumented = [];
  let documented = 0;

  for (const req of requirements) {
    const id = req.id || req.requirement_id || '';
    const text = req.text || req.description || '';
    if (!id) continue;

    // Primary: literal ID match (case-sensitive)
    if (allDocContent.includes(id)) {
      documented++;
      continue;
    }

    // Secondary: keyword match (case-insensitive, 3+ keywords)
    const keywords = extractKeywords(text);
    if (keywords.length > 0) {
      let matchCount = 0;
      for (const kw of keywords) {
        if (allDocContentLower.includes(kw)) {
          matchCount++;
        }
      }
      if (matchCount >= 3) {
        documented++;
        continue;
      }
    }

    undocumented.push(id);
  }

  return {
    residual: undocumented.length,
    detail: {
      undocumented_requirements: undocumented,
      total_requirements: requirements.length,
      documented: documented,
      doc_files_scanned: docFiles.length,
      developer_docs_only: developerDocs.length > 0,
    },
  };
}

/**
 * D->C: Documentation to Code.
 * Detects stale structural claims in docs (dead file paths, missing CLI commands, absent dependencies).
 * Returns { residual: N, detail: {...} }
 */
function sweepDtoC() {
  const docFiles = discoverDocFiles();
  if (docFiles.length === 0) {
    return {
      residual: -1,
      detail: { skipped: true, reason: 'missing: doc files' },
    };
  }

  // Load dependency manifests for verification (#22: multi-ecosystem support)
  let pkgDeps = {};
  let pkgDevDeps = {};
  const allKnownDeps = new Set();

  // Load D→C config for custom dependency_sources
  const dtocConfigPath = path.join(ROOT, '.planning', 'config.json');
  let dtocConfig = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(dtocConfigPath, 'utf8'));
    dtocConfig = (cfg.solve && cfg.solve.d_to_c) || {};
  } catch (e) { /* use defaults */ }

  // npm: package.json
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    pkgDeps = pkg.dependencies || {};
    pkgDevDeps = pkg.devDependencies || {};
    for (const d of Object.keys(pkgDeps)) allKnownDeps.add(d);
    for (const d of Object.keys(pkgDevDeps)) allKnownDeps.add(d);
  } catch (e) {
    // No package.json
  }

  // Python: requirements.txt, pyproject.toml
  const pythonManifests = (dtocConfig.dependency_sources || [])
    .concat(['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile']);
  for (const manifest of pythonManifests) {
    try {
      const content = fs.readFileSync(path.join(ROOT, manifest), 'utf8');
      // Extract package names from requirements.txt style (name==version, name>=version, name)
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
        const match = trimmed.match(/^([a-zA-Z0-9_-]+)/);
        if (match) allKnownDeps.add(match[1].toLowerCase());
      }
    } catch (e) { /* manifest not found */ }
  }

  // Go: go.mod
  try {
    const gomod = fs.readFileSync(path.join(ROOT, 'go.mod'), 'utf8');
    const reqMatches = gomod.matchAll(/^\s+([^\s]+)\s/gm);
    for (const m of reqMatches) allKnownDeps.add(m[1]);
  } catch (e) { /* no go.mod */ }

  // Rust: Cargo.toml
  try {
    const cargo = fs.readFileSync(path.join(ROOT, 'Cargo.toml'), 'utf8');
    const depMatches = cargo.matchAll(/^\s*([a-zA-Z0-9_-]+)\s*=/gm);
    for (const m of depMatches) allKnownDeps.add(m[1]);
  } catch (e) { /* no Cargo.toml */ }

  // Infrastructure ignore patterns (#22: K8s, IAM, Docker references)
  let infraIgnorePatterns = [];
  if (dtocConfig.ignore_patterns && Array.isArray(dtocConfig.ignore_patterns)) {
    for (const pat of dtocConfig.ignore_patterns) {
      try { infraIgnorePatterns.push(new RegExp(pat)); } catch (e) { /* skip bad pattern */ }
    }
  }

  // Load acknowledged false positives
  const fpPath = path.join(ROOT, '.planning', 'formal', 'acknowledged-false-positives.json');
  let acknowledgedFPs = new Set();
  try {
    const fpData = JSON.parse(fs.readFileSync(fpPath, 'utf8'));
    for (const entry of (fpData.entries || [])) {
      // Key by doc_file + value only (no line numbers — line numbers shift on edits and break suppression)
      acknowledgedFPs.add(entry.doc_file + ':' + entry.value);
    }
  } catch (e) { /* no ack file */ }

  // Load pattern-based suppression rules
  let fpPatterns = [];
  try {
    const fpData = JSON.parse(fs.readFileSync(fpPath, 'utf8'));
    for (const entry of (fpData.patterns || [])) {
      if (entry.enabled === false) continue;
      try {
        fpPatterns.push({ type: entry.type, regex: new RegExp(entry.regex), reason: entry.reason });
      } catch (regexErr) {
        console.warn('Skipping malformed FP pattern:', entry.regex, regexErr.message);
      }
    }
  } catch (e) { /* no ack file or malformed */ }

  // Severity weights: user-facing broken claims count more
  const CATEGORY_WEIGHT = { user: 2, examples: 1.5, developer: 1, unknown: 1 };

  // Build a set of known project command/skill names from commands/ directory
  // Values matching these are project terms, not npm dependencies
  const projectCommands = new Set();
  try {
    const cmdDir = path.join(ROOT, 'commands', 'nf');
    if (fs.existsSync(cmdDir)) {
      for (const f of fs.readdirSync(cmdDir)) {
        projectCommands.add(f.replace(/\.\w+$/, '')); // strip extension
      }
    }
    // Also scan bin/ for script basenames (e.g., run-formal-verify.cjs -> run-formal-verify)
    const binDir = path.join(ROOT, 'bin');
    if (fs.existsSync(binDir)) {
      for (const f of fs.readdirSync(binDir)) {
        if (/\.(cjs|js|mjs)$/.test(f)) {
          projectCommands.add(f.replace(/\.\w+$/, ''));
        }
      }
    }
  } catch (e) { /* best effort */ }

  const brokenClaims = [];
  let totalClaimsChecked = 0;
  let suppressedFpCount = 0;

  for (const { absPath, category } of docFiles) {
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch (e) {
      continue;
    }

    const relativePath = path.relative(ROOT, absPath).replace(/\\/g, '/');
    const claims = extractStructuralClaims(content, relativePath);

    for (const claim of claims) {
      totalClaimsChecked++;

      let isBroken = false;
      let reason = '';

      if (claim.type === 'file_path') {
        // Verify file exists — try ROOT first, then common parent directories
        // (docs often reference files relative to .planning/formal/ in tables)
        const claimAbsPath = path.join(ROOT, claim.value);
        const formalFallback = path.join(ROOT, '.planning', 'formal', claim.value);
        if (!fs.existsSync(claimAbsPath) && !fs.existsSync(formalFallback)) {
          // Skip runtime output files that get created on first use
          const isRuntimeOutput = /\.(jsonl|ndjson)$/.test(claim.value);
          if (isRuntimeOutput) {
            // no-op — skip runtime output
          } else if (/[*?]/.test(claim.value)) {
            // QUICK-375: Glob pattern expansion — resolve *, ?, ** before checking existence
            const globDir = path.join(ROOT, path.dirname(claim.value));
            const globPattern = path.basename(claim.value);
            let globMatched = false;
            try {
              if (fs.existsSync(globDir)) {
                const entries = fs.readdirSync(globDir);
                const re = new RegExp('^' + globPattern.replace(/\./g, '\\.').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$');
                globMatched = entries.some(e => re.test(e));
              }
            } catch (_) { /* fail-open: treat as broken if glob resolution fails */ }
            if (!globMatched) {
              isBroken = true;
              reason = 'glob pattern has no matches';
            }
          } else {
            // QUICK-375: Design doc staleness — suppress claims from docs/plans/ or docs/design/
            // where the doc is a pre-implementation proposal and similar files exist (fuzzy rename)
            const isDesignDoc = /^docs\/(plans?|designs?|proposals?|architecture)\//i.test(relativePath);
            if (isDesignDoc) {
              // Fuzzy rename detection: check for files in same directory with similar basename
              const claimDir = path.join(ROOT, path.dirname(claim.value));
              const claimBase = path.basename(claim.value, path.extname(claim.value)).toLowerCase();
              let fuzzyMatch = false;
              try {
                if (fs.existsSync(claimDir)) {
                  const siblings = fs.readdirSync(claimDir);
                  for (const sib of siblings) {
                    const sibBase = path.basename(sib, path.extname(sib)).toLowerCase();
                    // Check keyword overlap: if >50% of words in claimed name appear in sibling
                    const claimWords = claimBase.split(/[_-]+/).filter(w => w.length > 2);
                    const sibWords = sibBase.split(/[_-]+/).filter(w => w.length > 2);
                    if (claimWords.length > 0) {
                      const overlap = claimWords.filter(w => sibWords.some(sw => sw.includes(w) || w.includes(sw)));
                      if (overlap.length >= Math.ceil(claimWords.length * 0.5)) {
                        fuzzyMatch = true;
                        break;
                      }
                    }
                  }
                }
              } catch (_) { /* fail-open */ }
              if (!fuzzyMatch) {
                isBroken = true;
                reason = 'file not found (design doc)';
              }
              // If fuzzyMatch, suppress — likely a rename from pre-implementation proposal
            } else {
              isBroken = true;
              reason = 'file not found';
            }
          }
        }
      } else if (claim.type === 'cli_command') {
        // Extract script path from command (e.g., "node bin/foo.cjs" -> "bin/foo.cjs")
        const cmdParts = claim.value.split(/\s+/);
        if (cmdParts.length >= 2 && cmdParts[0] === 'node') {
          const scriptPath = cmdParts[1];
          if (!fs.existsSync(path.join(ROOT, scriptPath))) {
            isBroken = true;
            reason = 'script not found';
          }
        }
      } else if (claim.type === 'dependency') {
        // QUICK-375: System tool allowlist — common CLI tools mentioned in docs that aren't packages
        const SYSTEM_TOOLS = new Set([
          'nvidia-smi', 'docker', 'docker-compose', 'git', 'curl', 'wget', 'make', 'gcc', 'g++',
          'python', 'python3', 'pip', 'pip3', 'node', 'npm', 'npx', 'yarn', 'pnpm', 'bun',
          'cargo', 'rustc', 'go', 'java', 'javac', 'gradle', 'maven', 'mvn',
          'ruby', 'gem', 'bundler', 'brew', 'apt', 'apt-get', 'yum', 'dnf',
          'ssh', 'scp', 'rsync', 'tar', 'zip', 'unzip', 'gzip',
          'psql', 'mysql', 'redis-cli', 'mongosh', 'sqlite3',
          'aws', 'gcloud', 'az', 'kubectl', 'helm', 'terraform',
        ]);
        if (SYSTEM_TOOLS.has(claim.value.toLowerCase())) continue;

        // Verify against all known dependency manifests (#22: multi-ecosystem)
        if (!(claim.value in pkgDeps) && !(claim.value in pkgDevDeps) && !allKnownDeps.has(claim.value.toLowerCase())) {
          // Check infrastructure ignore patterns (#22)
          if (infraIgnorePatterns.some(rx => rx.test(claim.value))) {
            continue; // Skip infrastructure references
          }
          // Heuristic: values not in package.json that match project-internal patterns
          // are project terms, not missing dependencies. Safe here because real deps
          // already passed the package.json check above.
          const isProjectTerm =
            /-\d+$/.test(claim.value) ||                          // slot names (copilot-1, gemini-cli-1)
            /^mcp-/.test(claim.value) ||                          // nForma MCP commands
            /-server$/.test(claim.value) ||                       // MCP server references
            /qnf/.test(claim.value) ||                            // old project name references
            projectCommands.has(claim.value);                     // matches a known command/skill name

          // Context-aware: skip deps in requirement spec text (describes behavior, not claims deps)
          const lineContent = content.split('\n')[claim.line - 1] || '';
          const isInRequirementText = /^\*\*Requirement:\*\*/.test(lineContent.trim());

          // Context-aware: skip deps in example/template files
          const isExampleFile = /\.example\.(md|yml|yaml)$/.test(relativePath);

          // Context-aware: skip deps that appear in enumeration lists (e.g., "one of 5 types: `a`, `b`")
          const isEnumContext = /\b(?:types?|categories|values?|one of|classify|classified)\b/i.test(lineContent);

          if (!isProjectTerm && !isInRequirementText && !isExampleFile && !isEnumContext) {
            isBroken = true;
            reason = 'not in any dependency manifest';
          }
        }
      }

      if (isBroken) {
        // Filter acknowledged false positives
        if (acknowledgedFPs.has(claim.doc_file + ':' + claim.value)) {
          suppressedFpCount++;
          continue;
        }

        // Auto-suppress known rebrand patterns (qnf->nf renames from quick-186)
        const REBRAND_PATTERNS = [
          /qnf-core\//,           // old qnf-core/ directory references
          /qnf[_-](?!.*\.md$)/,  // qnf- or qnf_ prefixes (not in .md filenames which are historical)
          /\/qnf\//,              // /qnf/ path segments
        ];
        if (claim.type === 'file_path') {
          const isRebrandArtifact = REBRAND_PATTERNS.some(rx => rx.test(claim.value));
          if (isRebrandArtifact) {
            suppressedFpCount++;
            continue;
          }
        }

        // Auto-suppress illustrative/example paths in documentation
        // (e.g., "Creates: `.planning/quick/001-add-dark-mode-toggle/PLAN.md`")
        if (claim.type === 'file_path') {
          const lineContent = content.split('\n')[claim.line - 1] || '';
          const isIllustrative =
            /\b(?:creates?|produces?|generates?|outputs?|e\.g\.|for example|such as)\b.*`/i.test(lineContent) ||
            /^\*\*Creates:\*\*/.test(lineContent.trim());
          if (isIllustrative) {
            suppressedFpCount++;
            continue;
          }
        }

        // Filter by pattern-based suppression rules
        let patternSuppressed = false;
        for (const pat of fpPatterns) {
          if (pat.type === claim.type && pat.regex.test(claim.value)) {
            patternSuppressed = true;
            break;
          }
        }
        if (patternSuppressed) {
          suppressedFpCount++;
          continue;
        }

        // Reduce weight for historical/archived docs
        let effectiveCategory = category;
        const docLower = claim.doc_file.toLowerCase();
        if (docLower.includes('changelog') || docLower.includes('history') ||
            docLower.includes('archived/') || docLower.includes('deprecated/')) {
          effectiveCategory = '_historical';
        }

        brokenClaims.push({
          doc_file: claim.doc_file,
          line: claim.line,
          type: claim.type,
          value: claim.value,
          reason: reason,
          category: effectiveCategory === '_historical' ? category : category,
          weight: effectiveCategory === '_historical' ? 0.1 : (CATEGORY_WEIGHT[category] || 1),
        });
      }
    }
  }

  // Scan docs for /nf: slash-command references and verify existence
  // (handles benchmark mutations that inject references to non-existent commands)
  let ghostCommandCount = 0;
  {
    const nfCommandsDir = path.join(ROOT, 'commands');
    const nfCommandPattern = /\/nf:([a-zA-Z0-9_-]+)/g;
    let ghostCommands = 0;
    if (fs.existsSync(nfCommandsDir)) {
      // Build set of known command names from commands/ directory
      const knownCommands = new Set();
      try {
        const walkCommands = (dir) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) walkCommands(path.join(dir, entry.name));
            else if (entry.name.endsWith('.md')) {
              const stem = entry.name.replace(/\.md$/, '');
              knownCommands.add(stem);
            }
          }
        };
        walkCommands(nfCommandsDir);
      } catch (_) { /* fail-open */ }

      // Scan all doc files for /nf: references
      for (const { absPath, category } of docFiles) {
        const nfCmdContent = (() => {
          try { return fs.readFileSync(absPath, 'utf8'); } catch (_) { return ''; }
        })();
        let m;
        nfCommandPattern.lastIndex = 0;
        while ((m = nfCommandPattern.exec(nfCmdContent)) !== null) {
          const cmdName = m[1];
          if (!knownCommands.has(cmdName)) {
            ghostCommands++;
            brokenClaims.push({
              doc_file: path.relative(ROOT, absPath),
              line: null,
              type: 'ghost_command',
              value: '/nf:' + cmdName,
              reason: 'nf: command not found in commands/ directory',
              category,
              weight: CATEGORY_WEIGHT[category] || 1,
            });
          }
        }
      }
    }
    ghostCommandCount = ghostCommands;
  }

  // Weighted residual: user-facing broken claims count more
  let weightedResidual = 0;
  const categoryBreakdown = {};
  for (const bc of brokenClaims) {
    const w = bc.weight !== undefined ? bc.weight : (CATEGORY_WEIGHT[bc.category] || 1);
    weightedResidual += w;
    categoryBreakdown[bc.category] = (categoryBreakdown[bc.category] || 0) + 1;
  }

  // Persist D→C broken claims for manual review.
  // Skipped under --report-only: the residual (weightedResidual) is already
  // computed above from a live doc scan, so this write is pure persistence.
  // Writing it during a diagnostic run mutates the tree and breaks report-only's
  // no-mutation contract (and its run-to-run idempotency).
  try {
    const evidenceDir = path.join(ROOT, '.planning', 'formal', 'evidence');
    if (!reportOnly && fs.existsSync(evidenceDir)) {
      fs.writeFileSync(
        path.join(evidenceDir, 'doc-claims.json'),
        JSON.stringify({
          generated: new Date().toISOString(),
          total_claims_checked: totalClaimsChecked,
          doc_files_scanned: docFiles.length,
          raw_broken_count: brokenClaims.length,
          weighted_residual: Math.ceil(weightedResidual),
          suppressed_fp_count: suppressedFpCount,
          category_breakdown: categoryBreakdown,
          broken_claims: brokenClaims,
        }, null, 2) + '\n'
      );
    }
  } catch (e) {
    // fail-open: persistence is best-effort
  }

  // Fold: fingerprint-drift (code fingerprint drift detection)
  let fingerprintDriftCount = 0;
  let fingerprintDriftDetail = null;
  try {
    const fdPath = path.join(ROOT, 'bin', 'fingerprint-drift.cjs');
    if (fs.existsSync(fdPath)) {
      const fdMod = require(fdPath);
      if (typeof fdMod.fingerprintDrift === 'function') {
        const drift = fdMod.fingerprintDrift();
        if (drift && ((drift.count && drift.count > 0) || (Array.isArray(drift) && drift.length > 0))) {
          fingerprintDriftCount = drift.count || drift.length || 0;
          fingerprintDriftDetail = drift;
        }
      }
    }
  } catch (_) { /* fail-open */ }

  return {
    residual: Math.ceil(weightedResidual) + fingerprintDriftCount,
    detail: {
      broken_claims: brokenClaims,
      total_claims_checked: totalClaimsChecked,
      doc_files_scanned: docFiles.length,
      raw_broken_count: brokenClaims.length,
      weighted_residual: weightedResidual,
      category_breakdown: categoryBreakdown,
      suppressed_fp_count: suppressedFpCount,
      ghost_commands: ghostCommandCount,
      fingerprint_drift: fingerprintDriftDetail,
      scoped: focusSet ? false : undefined,
    },
  };
}

// ── Reverse traceability sweeps ──────────────────────────────────────────────

const MAX_REVERSE_CANDIDATES = 200;

/**
 * C->R: Code to Requirements (reverse).
 * Scans bin/ and hooks/ for source modules not traced to any requirement.
 * Returns { residual: N, detail: { untraced_modules: [{file}], total_modules, traced } }
 */
function sweepCtoR() {
  const reqPath = path.join(ROOT, '.planning', 'formal', 'requirements.json');
  if (!fs.existsSync(reqPath)) {
    return { residual: -1, detail: { skipped: true, reason: 'missing: requirements.json', baseline_hint: 'run sync-baseline-requirements.cjs to populate' } };
  }

  let reqData;
  try {
    reqData = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
  } catch (e) {
    return { residual: -1, detail: { skipped: true, reason: 'missing: requirements.json (parse error)', baseline_hint: 'run sync-baseline-requirements.cjs to populate' } };
  }

  // Flatten requirements
  let requirements = [];
  if (Array.isArray(reqData)) {
    requirements = reqData;
  } else if (reqData.requirements && Array.isArray(reqData.requirements)) {
    requirements = reqData.requirements;
  } else if (reqData.groups && Array.isArray(reqData.groups)) {
    for (const group of reqData.groups) {
      if (group.requirements && Array.isArray(group.requirements)) {
        for (const r of group.requirements) requirements.push(r);
      }
    }
  }

  // Build searchable text from all requirements
  const allReqText = requirements.map(r => {
    const parts = [r.id || '', r.text || '', r.description || '', r.background || ''];
    if (r.provenance && r.provenance.source_file) parts.push(r.provenance.source_file);
    return parts.join(' ');
  }).join('\n');

  // Build Set of valid requirement IDs for header-comment fallback (O(1) lookup)
  const reqIdSet = new Set(requirements.filter(r => r.id).map(r => r.id));

  // Scan bin/ and hooks/ for source modules
  const scanDirs = ['bin', 'hooks'];
  const sourceFiles = [];

  for (const dir of scanDirs) {
    const absDir = path.join(ROOT, dir);
    if (!fs.existsSync(absDir)) continue;

    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (e) {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.cjs') && !entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue;
      // Skip test files, dist copies, and generated files
      if (entry.name.includes('.test.')) continue;
      if (dir === 'hooks' && entry.name === 'dist') continue;

      sourceFiles.push(path.join(dir, entry.name));
    }
  }

  // Also scan hooks/dist/ as separate entry point files
  const distDir = path.join(ROOT, 'hooks', 'dist');
  if (fs.existsSync(distDir)) {
    try {
      const distEntries = fs.readdirSync(distDir, { withFileTypes: true });
      for (const entry of distEntries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.cjs') && !entry.name.endsWith('.js')) continue;
        // dist/ files are copies — skip, they trace through their source in hooks/
      }
    } catch (e) {
      // skip
    }
  }

  const untraced = [];
  let traced = 0;

  // Load code-trace index for fast lookup
  const index = loadCodeTraceIndex();

  for (const file of sourceFiles) {
    const fileName = path.basename(file);
    const fileNoExt = fileName.replace(/\.(cjs|js|mjs)$/, '');

    // First check: code-trace index lookup (if available)
    if (index && (index.traced_files[file] || index.scope_only.includes(file))) {
      traced++;
      continue;
    }

    // Check if any requirement references this file
    if (allReqText.includes(file) || allReqText.includes(fileName) || allReqText.includes(fileNoExt)) {
      traced++;
    } else {
      // Fallback: check if file self-declares requirement IDs in header comment
      let headerTraced = false;
      try {
        const absFile = path.join(ROOT, file);
        const head = fs.readFileSync(absFile, 'utf8').split('\n').slice(0, 30).join('\n');
        const match = head.match(/(?:\/\/|\/?\*)\s*Requirements:\s*(.+)/);
        if (match) {
          const declaredIds = match[1].split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
          headerTraced = declaredIds.some(id => reqIdSet.has(id));
        }
        // Also check for @requirement REQ-ID inline annotations
        if (!headerTraced) {
          const annMatch = head.match(/@requirement\s+([A-Z][A-Z0-9_-]+)/);
          if (annMatch && reqIdSet.has(annMatch[1])) { headerTraced = true; }
        }
      } catch (e) {
        // fail-open: file unreadable, treat as untraced
      }
      if (headerTraced) {
        traced++;
      } else {
        untraced.push({ file });
      }
    }
  }

  // Proximity-based suppression pass: suppress untraced items with high-score proximity edges (fail-open)
  const SUPPRESS_THRESHOLD = 0.6;
  try {
    const piPath = path.join(ROOT, '.planning', 'formal', 'proximity-index.json');
    if (fs.existsSync(piPath) && untraced.length > 0) {
      const { SEMANTIC_WEIGHTS } = require('./formal-proximity.cjs');
      const pi = JSON.parse(fs.readFileSync(piPath, 'utf8'));
      if (pi && pi.nodes) {
        const surviving = [];
        for (const item of untraced) {
          const nodeKey = 'code_file::' + item.file;
          const node = pi.nodes[nodeKey];
          if (node) {
            const suppressEdge = node.edges.find(e =>
              e.to.startsWith('requirement::') &&
              (SEMANTIC_WEIGHTS[e.rel] || 0) >= SUPPRESS_THRESHOLD
            );
            if (suppressEdge) {
              traced++;
              item.suppressed_by = {
                requirement: suppressEdge.to.replace('requirement::', ''),
                score: SEMANTIC_WEIGHTS[suppressEdge.rel],
              };
              continue;
            }
          }
          surviving.push(item);
        }
        untraced.length = 0;
        untraced.push(...surviving);
      }
    }
  } catch (e) { /* fail-open: if proximity-index.json missing or unreadable, skip suppression */ }

  // Enrich untraced items with proximity nearest_req (fail-open)
  // Strategy: BFS graph first, then embedding fallback for items graph can't reach
  try {
    const piPath = path.join(ROOT, '.planning', 'formal', 'proximity-index.json');
    if (fs.existsSync(piPath) && untraced.length > 0) {
      const { reach: reachFn } = require('./formal-query.cjs');
      const pi = JSON.parse(fs.readFileSync(piPath, 'utf8'));
      if (pi && pi.nodes) {
        for (const item of untraced) {
          const nodeKey = 'code_file::' + item.file;
          if (!pi.nodes[nodeKey]) continue;
          const reachable = reachFn(pi, nodeKey, 2, ['requirement']);
          for (const nodes of Object.values(reachable)) {
            if (nodes.length > 0) {
              item.nearest_req = nodes[0].key.split('::').slice(1).join('::');
              break;
            }
          }
          if (!item.nearest_req) {
            const broader = reachFn(pi, nodeKey, 3, null);
            const ctx = [];
            for (const nodes of Object.values(broader)) {
              for (const n of nodes) ctx.push(n.key);
            }
            if (ctx.length > 0) item.proximity_context = ctx.slice(0, 5);
          }
        }
      }
    }
  } catch (e) { /* fail-open */ }

  // Embedding fallback: for items still without nearest_req, use cosine similarity
  try {
    for (const item of untraced) {
      if (item.nearest_req) continue;
      const result = embeddingNearestReq('code_file::' + item.file);
      if (result) {
        item.nearest_req = result.nearest_req;
        item.proximity_context = result.proximity_context;
        item.enrichment_source = 'embedding';
      }
    }
  } catch (e) { /* fail-open */ }

  // CREM-04: Enrich untraced candidates with caller counts (fail-open)
  if (_activeAdapter && untraced.length > 0) {
    try {
      const healthResult = _activeAdapter.healthSync();
      if (healthResult && healthResult.healthy) {
        for (const candidate of untraced) {
          try {
            const filePath = candidate.file || '';
            const result = _activeAdapter.getCallersSync('', filePath);
            const callerCount = (result && Array.isArray(result.callers)) ? result.callers.length : undefined;
            if (callerCount !== undefined) {
              candidate.caller_count = callerCount;
              candidate.dead_code_flag = callerCount === 0;
            }
          } catch (_e) { /* fail-open per candidate */ }
        }
        process.stderr.write(TAG + ' CREM-04: enriched ' + untraced.length + ' C->R candidate(s) with caller counts\n');
      }
    } catch (_e) {
      process.stderr.write(TAG + ' CREM-04 C->R: coderlm unavailable, using heuristics only\n');
    }
  }

  return {
    residual: untraced.length,
    detail: {
      untraced_modules: untraced,
      total_modules: sourceFiles.length,
      traced: traced,
      scoped: focusSet ? false : undefined,
    },
  };
}

/**
 * T->R: Tests to Requirements (reverse).
 * Scans test files for tests without @req annotation or formal-test-sync mapping.
 * Returns { residual: N, detail: { orphan_tests: [file_paths], total_tests, mapped } }
 */
function sweepTtoR() {
  // Discover test files
  const testPatterns = [
    { dir: 'bin', suffix: '.test.cjs' },
    { dir: 'test', suffix: '.test.cjs' },
    { dir: 'test', suffix: '.test.js' },
  ];

  const testFiles = [];
  for (const { dir, suffix } of testPatterns) {
    const absDir = path.join(ROOT, dir);
    if (!fs.existsSync(absDir)) continue;

    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (e) {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(suffix)) continue;
      testFiles.push(path.join(dir, entry.name));
    }
  }

  if (testFiles.length === 0) {
    return { residual: -1, detail: { skipped: true, reason: 'missing: test files', orphan_tests: [], total_tests: 0, mapped: 0 } };
  }

  // Load formal-test-sync data for mapping info
  const syncData = loadFormalTestSync();
  const syncMappedFiles = new Set();
  if (syncData && syncData.coverage_gaps && syncData.coverage_gaps.gaps) {
    for (const gap of syncData.coverage_gaps.gaps) {
      if (gap.test_file) syncMappedFiles.add(gap.test_file);
    }
  }
  // Also check stub files from generated-stubs directory
  if (syncData && syncData.generated_stubs) {
    for (const stub of syncData.generated_stubs) {
      if (stub.source_test) syncMappedFiles.add(stub.source_test);
    }
  }

  const orphans = [];
  let mapped = 0;
  let annotatedCount = 0;

  // Load code-trace index for fast lookup
  const index = loadCodeTraceIndex();

  for (const testFile of testFiles) {
    const absPath = path.join(ROOT, testFile);

    // Check for @req/@requirement annotation in file content (run for ALL files for coverage counting)
    let hasReqAnnotation = false;
    try {
      const content = fs.readFileSync(absPath, 'utf8');
      // Match patterns: @requirement REQ-01, @req REQ-01, // req: STOP-03, // Requirements: REQ-01, REQ-02
      hasReqAnnotation = /@req(?:uirement)?\s+[A-Z]+-\d+/i.test(content) ||
                         /\/\/\s*req(?:uirement)?:\s*[A-Z]+-\d+/i.test(content) ||
                         /\/\/\s*Requirements:\s*[A-Z]+-\d+/i.test(content);
    } catch (e) {
      // Can't read — treat as orphan
    }
    if (hasReqAnnotation) annotatedCount++;

    // First check: code-trace index lookup (if available)
    if (index && index.traced_files[testFile]) {
      mapped++;
      continue;
    }

    // Require-path tracing: map domain-named tests via their require() dependencies
    if (index) {
      try {
        const content = fs.readFileSync(absPath, 'utf8');
        // Match require('../bin/X.cjs') or require('./X.cjs') patterns
        const reqMatches = content.match(/require\(['"]\.\.?\/(bin\/[^'"]+)['"]\)/g);
        if (reqMatches) {
          const hasTrackedDep = reqMatches.some(m => {
            const depMatch = m.match(/require\(['"]\.\.?\/(bin\/[^'"]+)['"]\)/);
            return depMatch && index.traced_files[depMatch[1]];
          });
          if (hasTrackedDep) {
            mapped++;
            continue;
          }
        }
      } catch (e) { /* fail-open */ }
    }

    // Check if formal-test-sync knows about this file
    const inSyncReport = syncMappedFiles.has(testFile) || syncMappedFiles.has(absPath);

    if (hasReqAnnotation || inSyncReport) {
      mapped++;
    } else {
      orphans.push(testFile);
    }
  }

  // Convert orphans to objects and enrich with proximity nearest_req (fail-open)
  // Strategy: BFS graph first, then embedding fallback for items graph can't reach
  let orphanItems = orphans.map(f => ({ file: f }));

  // Proximity-based suppression for test files (parallel to sweepCtoR suppression)
  try {
    const piPath = path.join(ROOT, '.planning', 'formal', 'proximity-index.json');
    if (fs.existsSync(piPath) && orphanItems.length > 0) {
      const { SEMANTIC_WEIGHTS } = require('./formal-proximity.cjs');
      const pi = JSON.parse(fs.readFileSync(piPath, 'utf8'));
      if (pi && pi.nodes) {
        const SUPPRESS_THRESHOLD = 0.6;
        const surviving = [];
        for (const item of orphanItems) {
          const nodeKey = 'code_file::' + item.file;
          const node = pi.nodes[nodeKey];
          if (node) {
            const suppressEdge = node.edges.find(e =>
              e.to.startsWith('requirement::') &&
              (SEMANTIC_WEIGHTS[e.rel] || 0) >= SUPPRESS_THRESHOLD
            );
            if (suppressEdge) {
              mapped++;
              continue;
            }
          }
          surviving.push(item);
        }
        orphanItems = surviving;
      }
    }
  } catch (e) { /* fail-open */ }

  try {
    const piPath = path.join(ROOT, '.planning', 'formal', 'proximity-index.json');
    if (fs.existsSync(piPath) && orphanItems.length > 0) {
      const { reach: reachFn } = require('./formal-query.cjs');
      const pi = JSON.parse(fs.readFileSync(piPath, 'utf8'));
      if (pi && pi.nodes) {
        for (const item of orphanItems) {
          const nodeKey = 'code_file::' + item.file;
          if (!pi.nodes[nodeKey]) continue;
          const reachable = reachFn(pi, nodeKey, 2, ['requirement']);
          for (const nodes of Object.values(reachable)) {
            if (nodes.length > 0) {
              item.nearest_req = nodes[0].key.split('::').slice(1).join('::');
              break;
            }
          }
          if (!item.nearest_req) {
            const broader = reachFn(pi, nodeKey, 3, null);
            const ctx = [];
            for (const nodes of Object.values(broader)) {
              for (const n of nodes) ctx.push(n.key);
            }
            if (ctx.length > 0) item.proximity_context = ctx.slice(0, 5);
          }
        }
      }
    }
  } catch (e) { /* fail-open */ }

  // Embedding fallback: for items still without nearest_req, use cosine similarity
  try {
    for (const item of orphanItems) {
      if (item.nearest_req) continue;
      const result = embeddingNearestReq('code_file::' + item.file);
      if (result) {
        item.nearest_req = result.nearest_req;
        item.proximity_context = result.proximity_context;
        item.enrichment_source = 'embedding';
      }
    }
  } catch (e) { /* fail-open */ }

  // CREM-04: Enrich orphan test candidates with caller counts (fail-open)
  if (_activeAdapter && orphanItems.length > 0) {
    try {
      const healthResult = _activeAdapter.healthSync();
      if (healthResult && healthResult.healthy) {
        for (const item of orphanItems) {
          try {
            const filePath = item.file || '';
            const result = _activeAdapter.getCallersSync('', filePath);
            const callerCount = (result && Array.isArray(result.callers)) ? result.callers.length : undefined;
            if (callerCount !== undefined) {
              item.caller_count = callerCount;
              item.dead_code_flag = callerCount === 0;
            }
          } catch (_e) { /* fail-open per candidate */ }
        }
        process.stderr.write(TAG + ' CREM-04: enriched ' + orphanItems.length + ' T->R candidate(s) with caller counts\n');
      }
    } catch (_e) {
      process.stderr.write(TAG + ' CREM-04 T->R: coderlm unavailable, using heuristics only\n');
    }
  }

  const annotation_coverage_percent = testFiles.length > 0
    ? Math.round((annotatedCount / testFiles.length) * 100)
    : 0;

  return {
    residual: orphanItems.length,
    detail: {
      orphan_tests: orphanItems,
      total_tests: testFiles.length,
      mapped: mapped,
      annotation_coverage_percent: annotation_coverage_percent,
      annotated_count: annotatedCount,
      scoped: focusSet ? false : undefined,
    },
  };
}

/**
 * D->R: Docs to Requirements (reverse).
 * Extracts capability claims from docs and checks if requirements back them.
 * Returns { residual: N, detail: { unbacked_claims: [{doc_file, line, claim_text}], total_claims, backed } }
 */
function sweepDtoR() {
  const reqPath = path.join(ROOT, '.planning', 'formal', 'requirements.json');
  if (!fs.existsSync(reqPath)) {
    return { residual: -1, detail: { skipped: true, reason: 'missing: requirements.json', baseline_hint: 'run sync-baseline-requirements.cjs to populate' } };
  }

  let reqData;
  try {
    reqData = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
  } catch (e) {
    return { residual: -1, detail: { skipped: true, reason: 'missing: requirements.json (parse error)', baseline_hint: 'run sync-baseline-requirements.cjs to populate' } };
  }

  // Flatten requirements and extract keywords per requirement
  let requirements = [];
  if (Array.isArray(reqData)) {
    requirements = reqData;
  } else if (reqData.requirements && Array.isArray(reqData.requirements)) {
    requirements = reqData.requirements;
  } else if (reqData.groups && Array.isArray(reqData.groups)) {
    for (const group of reqData.groups) {
      if (group.requirements && Array.isArray(group.requirements)) {
        for (const r of group.requirements) requirements.push(r);
      }
    }
  }

  const reqKeywordSets = requirements.map(r => {
    const text = (r.text || r.description || '') + ' ' + (r.background || '');
    return extractKeywords(text);
  });

  // Discover doc files
  let docFiles = discoverDocFiles();
  if (docFiles.length === 0) {
    return { residual: -1, detail: { skipped: true, reason: 'missing: doc files' } };
  }

  // Stage A: File exclusion via dr-scanner-config.json
  let drConfig = null;
  let excludedFileCount = 0;
  let suppressPatterns = [];
  try {
    const configPath = path.join(ROOT, '.planning', 'formal', 'dr-scanner-config.json');
    drConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    // Fail-open: no exclusions if config missing or invalid
  }

  if (drConfig && Array.isArray(drConfig.exclude_files)) {
    const beforeCount = docFiles.length;
    docFiles = docFiles.filter(({ absPath }) => {
      const relPath = path.relative(ROOT, absPath).replace(/\\/g, '/');
      for (const pattern of drConfig.exclude_files) {
        if (matchWildcard(pattern, relPath)) return false;
      }
      return true;
    });
    excludedFileCount = beforeCount - docFiles.length;
  }

  // Stage B prep: compile suppress_line_patterns into RegExp array
  if (drConfig && Array.isArray(drConfig.suppress_line_patterns)) {
    for (const pat of drConfig.suppress_line_patterns) {
      try {
        suppressPatterns.push(new RegExp(pat));
      } catch (e) {
        // Skip invalid patterns
      }
    }
  }

  // Action verbs that indicate capability claims
  const ACTION_VERBS = [
    'supports', 'enables', 'provides', 'ensures', 'guarantees',
    'validates', 'enforces', 'detects', 'prevents', 'handles',
    'automates', 'generates', 'monitors', 'verifies', 'dispatches',
  ];
  const verbPattern = new RegExp('\\b(' + ACTION_VERBS.join('|') + ')\\b', 'i');

  const unbacked = [];
  let totalClaims = 0;
  let backed = 0;
  let suppressedLines = 0;

  for (const { absPath } of docFiles) {
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch (e) {
      continue;
    }

    const relativePath = path.relative(ROOT, absPath).replace(/\\/g, '/');
    const lines = content.split('\n');
    let inFencedBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip fenced code blocks
      if (line.trimStart().startsWith('```')) {
        inFencedBlock = !inFencedBlock;
        continue;
      }
      if (inFencedBlock) continue;

      // Skip headings, empty lines, and list markers only
      if (line.match(/^#{1,6}\s/) || line.trim().length === 0) continue;

      // Stage B: Line-level suppression (table rows, definition lists, blockquotes)
      if (suppressPatterns.length > 0) {
        let suppressed = false;
        for (const re of suppressPatterns) {
          if (re.test(line)) { suppressed = true; break; }
        }
        if (suppressed) { suppressedLines++; continue; }
      }

      // Check for action verb
      if (!verbPattern.test(line)) continue;

      totalClaims++;

      // Extract keywords from this claim line
      const claimKeywords = extractKeywords(line);
      if (claimKeywords.length < 2) {
        // Too few keywords to match meaningfully
        backed++;
        continue;
      }

      // Check if any requirement has 3+ keyword overlap
      let hasBacking = false;
      for (const reqKws of reqKeywordSets) {
        let overlap = 0;
        for (const kw of claimKeywords) {
          if (reqKws.includes(kw)) overlap++;
        }
        if (overlap >= 3) {
          hasBacking = true;
          break;
        }
      }

      if (hasBacking) {
        backed++;
      } else {
        unbacked.push({
          doc_file: relativePath,
          line: i + 1,
          claim_text: line.trim().slice(0, 120),
        });
      }
    }
  }

  return {
    residual: unbacked.length,
    detail: {
      unbacked_claims: unbacked,
      total_claims: totalClaims,
      backed: backed,
      excluded_files: excludedFileCount,
      suppressed_lines: suppressedLines,
      scoped: focusSet ? false : undefined,
    },
  };
}

/**
 * Classify a reverse discovery candidate into category A/B/C.
 * Category A (likely requirements): strong requirement language or source modules/tests.
 * Category B (likely documentation): descriptive/documentation language only.
 * Category C (ambiguous): needs human review.
 * @param {object} candidate - Candidate with file_or_claim, evidence, type fields
 * @returns {{ category: string, reason: string, suggestion: string }}
 */
function classifyCandidate(candidate) {
  const text = (candidate.file_or_claim || '').toLowerCase();

  // Category A signals: strong requirement language
  // Use word-boundary regex to avoid false matches (e.g. "mustard" matching "must")
  // Consistent with triageRequirements() which also uses \b boundaries
  const reqSignals = ['must', 'shall', 'ensures', 'invariant', 'constraint', 'enforces', 'guarantees'];
  const hasReqLanguage = reqSignals.some(s => new RegExp('\\b' + s + '\\b', 'i').test(text));

  // Category B signals: weak/descriptive language in doc claims
  const docSignals = ['supports', 'handles', 'provides', 'describes', 'documents', 'explains'];
  const hasDocLanguage = docSignals.some(s => new RegExp('\\b' + s + '\\b', 'i').test(text));

  // Determine infrastructure tier for module/test candidates
  const infraPatterns = [
    /^(install|aggregate-|build-|compute-|validate-|solve-tui|solve-worker|solve-wave-dag|solve-debt-bridge|token-dashboard|config-loader|layer-constants|providers|unified-mcp-server|review-mcp-logs|check-mcp-health|security-sweep)/,
  ];
  const baseName = path.basename(candidate.file_or_claim || '').replace(/\.(test\.)?(cjs|js|mjs)$/, '');
  const isInfra = infraPatterns.some(p => p.test(baseName)) || (candidate.file_or_claim || '').startsWith('hooks/');
  const proposed_tier = isInfra ? 'technical' : 'user';

  // Module and test types are more likely to be real requirements
  if (candidate.type === 'module' || candidate.type === 'test') {
    // Source modules and tests are usually genuine missing requirements
    return {
      category: 'A',
      reason: 'source ' + candidate.type + ' without requirement tracing',
      suggestion: 'approve',
      proposed_tier: proposed_tier
    };
  }

  if (candidate.type === 'claim') {
    if (hasReqLanguage) {
      return { category: 'A', reason: 'strong requirement language in doc claim', suggestion: 'approve' };
    }
    if (hasDocLanguage && !hasReqLanguage) {
      return { category: 'B', reason: 'descriptive/documentation language only', suggestion: 'acknowledge' };
    }
    return { category: 'C', reason: 'ambiguous — review needed', suggestion: 'review' };
  }

  return { category: 'C', reason: 'unclassified candidate type', suggestion: 'review' };
}

/**
 * Proximity pre-filter: suppress reverse-scanner items that are reachable to a
 * requirement node within BFS depth 2 in the proximity-index graph.
 * Fail-open: if proximity-index.json is missing or malformed, all items pass through.
 * @param {Array} candidates - array of {file_or_claim, type, ...}
 * @returns {{ filtered: Array, suppressed: Array, stats: {total, suppressed, passed} }}
 */
function proximityPreFilter(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { filtered: [], suppressed: [], stats: { total: 0, suppressed: 0, passed: 0 } };
  }
  const empty = { filtered: [...candidates], suppressed: [], stats: { total: candidates.length, suppressed: 0, passed: candidates.length } };

  try {
    const indexPath = path.join(ROOT, '.planning', 'formal', 'proximity-index.json');
    if (!fs.existsSync(indexPath)) return empty;

    const { reach } = require('./formal-query.cjs');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (!index || !index.nodes) return empty;

    const filtered = [];
    const suppressed = [];

    for (const c of candidates) {
      // Only module and test types have code_file nodes; claims skip proximity filter
      if (c.type === 'claim') {
        filtered.push(c);
        continue;
      }

      const nodeKey = 'code_file::' + c.file_or_claim;

      // Check if node exists in proximity graph
      if (!index.nodes[nodeKey]) {
        filtered.push(c);
        continue;
      }

      // BFS depth 2 for requirement nodes
      const reachable = reach(index, nodeKey, 2, ['requirement']);
      const reqNodes = [];
      for (const nodes of Object.values(reachable)) {
        for (const n of nodes) reqNodes.push(n);
      }

      if (reqNodes.length > 0) {
        // Suppress: requirement reachable within depth 2 (graph path)
        const reqId = reqNodes[0].key.split('::').slice(1).join('::');
        c.nearest_req = reqId;
        if (verboseMode) {
          process.stderr.write(TAG + ' Proximity suppress: ' + c.file_or_claim + ' covered by ' + reqId + '\n');
        }
        suppressed.push(c);
      } else {
        // Embedding fallback: try cosine similarity before giving up
        const embedResult = embeddingNearestReq(nodeKey);
        if (embedResult && embedResult.similarity >= 0.55) {
          // High-confidence embedding match — suppress
          c.nearest_req = embedResult.nearest_req;
          c.enrichment_source = 'embedding';
          if (verboseMode) {
            process.stderr.write(TAG + ' Embedding suppress: ' + c.file_or_claim + ' covered by ' + embedResult.nearest_req + ' (sim=' + embedResult.similarity + ')\n');
          }
          suppressed.push(c);
        } else {
          // Check depth 3 for broader context (non-requirement nodes)
          const broader = reach(index, nodeKey, 3, null);
          const contextNodes = [];
          for (const nodes of Object.values(broader)) {
            for (const n of nodes) contextNodes.push(n.key);
          }
          if (contextNodes.length > 0) {
            c.nearest_req = null;
            c.proximity_context = contextNodes.slice(0, 5);
          }
          // Enrich with lower-confidence embedding context even if not suppressing
          if (embedResult) {
            c.nearest_req = c.nearest_req || embedResult.nearest_req;
            c.proximity_context = c.proximity_context || embedResult.proximity_context;
            c.enrichment_source = 'embedding';
          }
          filtered.push(c);
        }
      }
    }

    return {
      filtered,
      suppressed,
      stats: { total: candidates.length, suppressed: suppressed.length, passed: filtered.length },
    };
  } catch (e) {
    // fail-open: proximity pre-filter is best-effort
    if (verboseMode) {
      process.stderr.write(TAG + ' Proximity pre-filter error (fail-open): ' + e.message + '\n');
    }
    return empty;
  }
}

/**
 * Assemble and deduplicate reverse traceability candidates from all 3 scanners.
 * Merges C→R, T→R, D→R results, deduplicates, filters, and respects acknowledged-not-required.json.
 * Returns { candidates: [...], total_raw, deduped, filtered, acknowledged, proximity_suppressed }
 */
function assembleReverseCandidates(c_to_r, t_to_r, d_to_r) {
  const raw = [];

  // Gather C→R candidates
  if (c_to_r.residual > 0 && c_to_r.detail.untraced_modules) {
    for (const mod of c_to_r.detail.untraced_modules) {
      const candidate = {
        source_scanners: ['C→R'],
        evidence: mod.file,
        file_or_claim: mod.file,
        type: 'module',
      };
      // Carry through proximity data from sweep enrichment
      if (mod.nearest_req) candidate.nearest_req = mod.nearest_req;
      if (mod.proximity_context) candidate.proximity_context = mod.proximity_context;
      raw.push(candidate);
    }
  }

  // Gather T→R candidates
  if (t_to_r.residual > 0 && t_to_r.detail.orphan_tests) {
    for (const testEntry of t_to_r.detail.orphan_tests) {
      const testFile = typeof testEntry === 'string' ? testEntry : testEntry.file;
      const candidate = {
        source_scanners: ['T→R'],
        evidence: testFile,
        file_or_claim: testFile,
        type: 'test',
      };
      // Carry through proximity data from sweep enrichment
      if (testEntry && typeof testEntry === 'object') {
        if (testEntry.nearest_req) candidate.nearest_req = testEntry.nearest_req;
        if (testEntry.proximity_context) candidate.proximity_context = testEntry.proximity_context;
      }
      raw.push(candidate);
    }
  }

  // Gather D→R candidates
  if (d_to_r.residual > 0 && d_to_r.detail.unbacked_claims) {
    for (const claim of d_to_r.detail.unbacked_claims) {
      raw.push({
        source_scanners: ['D→R'],
        evidence: claim.doc_file + ':' + claim.line,
        file_or_claim: claim.claim_text,
        type: 'claim',
      });
    }
  }

  const totalRaw = raw.length;

  // Deduplicate: merge test files that correspond to source modules
  // e.g., test/foo.test.cjs and bin/foo.cjs → single candidate with both scanners
  const merged = [];
  const testToSource = new Map();

  for (const candidate of raw) {
    if (candidate.type === 'test') {
      // Extract base name: test/foo.test.cjs → foo
      const baseName = path.basename(candidate.file_or_claim)
        .replace(/\.test\.(cjs|js|mjs)$/, '');
      testToSource.set(baseName, candidate);
    }
  }

  const mergedTestBases = new Set();

  for (const candidate of raw) {
    if (candidate.type === 'module') {
      const baseName = path.basename(candidate.file_or_claim)
        .replace(/\.(cjs|js|mjs)$/, '');
      const matchingTest = testToSource.get(baseName);
      if (matchingTest) {
        // Merge: combine scanners
        if (verboseMode) {
          process.stderr.write(TAG + ' Dedup: merged C→R ' + candidate.file_or_claim +
            ' + T→R ' + matchingTest.file_or_claim + '\n');
        }
        merged.push({
          source_scanners: ['C→R', 'T→R'],
          evidence: candidate.file_or_claim + ' + ' + matchingTest.file_or_claim,
          file_or_claim: candidate.file_or_claim,
          type: 'module',
        });
        mergedTestBases.add(baseName);
      } else {
        merged.push(candidate);
      }
    } else if (candidate.type === 'test') {
      const baseName = path.basename(candidate.file_or_claim)
        .replace(/\.test\.(cjs|js|mjs)$/, '');
      if (!mergedTestBases.has(baseName)) {
        merged.push(candidate);
      }
    } else {
      merged.push(candidate);
    }
  }

  const deduped = totalRaw - merged.length;

  // Filter out .planning/ files, generated stubs, node_modules
  let filtered = 0;
  const candidates = [];
  for (const c of merged) {
    if (c.file_or_claim.startsWith('.planning/') ||
        c.file_or_claim.includes('generated-stubs') ||
        c.file_or_claim.includes('node_modules')) {
      filtered++;
      continue;
    }
    candidates.push(c);
  }

  // Load acknowledged-not-required.json and filter out previously rejected
  let acknowledged = 0;
  const ackPath = path.join(ROOT, '.planning', 'formal', 'acknowledged-not-required.json');
  if (fs.existsSync(ackPath)) {
    try {
      const ackData = JSON.parse(fs.readFileSync(ackPath, 'utf8'));
      const ackSet = new Set((ackData.entries || []).map(e => e.file_or_claim));
      const afterAck = [];
      for (const c of candidates) {
        if (ackSet.has(c.file_or_claim)) {
          acknowledged++;
        } else {
          afterAck.push(c);
        }
      }
      candidates.length = 0;
      for (const c of afterAck) candidates.push(c);
    } catch (e) {
      // malformed ack file — fail-open
    }
  }

  // Proximity pre-filter: suppress items reachable to requirements in proximity graph
  const proximityResult = proximityPreFilter(candidates);
  const proximitySuppressed = proximityResult.suppressed.length;
  candidates.length = 0;
  for (const c of proximityResult.filtered) candidates.push(c);

  // Auto-categorize candidates into A/B/C
  for (const c of candidates) {
    const classification = classifyCandidate(c);
    c.category = classification.category;
    c.category_reason = classification.reason;
    c.suggestion = classification.suggestion;
    c.proposed_tier = classification.proposed_tier || 'user';
  }

  // Auto-acknowledge Category B candidates (documentation-only, no human review needed)
  const catBCandidates = candidates.filter(c => c.category === 'B');
  const autoAcknowledgedB = catBCandidates.length;

  if (catBCandidates.length > 0 && !reportOnly) {
    // Write Category B to acknowledged-not-required.json
    const ackNrPath = path.join(ROOT, '.planning', 'formal', 'acknowledged-not-required.json');
    let ackNrData = { entries: [] };
    try {
      ackNrData = JSON.parse(fs.readFileSync(ackNrPath, 'utf8'));
      if (!Array.isArray(ackNrData.entries)) ackNrData.entries = [];
    } catch (e) { /* create fresh */ }

    const existingKeys = new Set(ackNrData.entries.map(e => e.file_or_claim));
    for (const c of catBCandidates) {
      if (!existingKeys.has(c.file_or_claim)) {
        ackNrData.entries.push({
          file_or_claim: c.file_or_claim,
          category: 'B',
          reason: c.category_reason,
          acknowledged_at: new Date().toISOString(),
        });
      }
    }
    try {
      fs.writeFileSync(ackNrPath, JSON.stringify(ackNrData, null, 2) + '\n', 'utf8');
    } catch (e) {
      process.stderr.write(TAG + ' WARNING: could not write acknowledged-not-required.json: ' + e.message + '\n');
    }
  }

  // Remove Category B from candidates (never surface to humans)
  const afterCatB = candidates.filter(c => c.category !== 'B');
  candidates.length = 0;
  for (const c of afterCatB) candidates.push(c);

  // Count by category for summary
  const categoryCounts = { A: 0, B: 0, C: 0 };
  for (const c of candidates) {
    categoryCounts[c.category] = (categoryCounts[c.category] || 0) + 1;
  }

  // Apply max candidate cap (R3.6 improvement from copilot-1)
  if (candidates.length > MAX_REVERSE_CANDIDATES) {
    if (verboseMode) {
      process.stderr.write(TAG + ' Capping reverse candidates from ' +
        candidates.length + ' to ' + MAX_REVERSE_CANDIDATES + '\n');
    }
    candidates.length = MAX_REVERSE_CANDIDATES;
  }

  return {
    candidates: candidates,
    total_raw: totalRaw,
    deduped: deduped,
    filtered: filtered,
    acknowledged: acknowledged,
    proximity_suppressed: proximitySuppressed,
    auto_acknowledged_b: autoAcknowledgedB,
    category_counts: categoryCounts,
  };
}

// ── Layer alignment sweeps ────────────────────────────────────────────────────

/**
 * Memoized aggregate gate loader.
 * Spawns compute-per-model-gates.cjs --aggregate --json once and caches the result.
 * All three sweep functions (L1->L2, L2->L3, L3->TC) share this single call.
 */
let _aggregateCache = null;
function getAggregateGates() {
  if (_aggregateCache) return _aggregateCache;
  const args = ['--aggregate', '--json'];
  if (reportOnly) args.push('--dry-run');
  const result = spawnTool('bin/compute-per-model-gates.cjs', args);
  if (!result.ok && !result.stdout) return null;
  try {
    const data = JSON.parse(result.stdout);
    _aggregateCache = data.aggregate;
    return _aggregateCache;
  } catch { return null; }
}

/**
 * L1->L3: Wiring:Evidence alignment score (L2 collapsed — STRUCT-01).
 * Gate A now evaluates L1 evidence directly against L3 reasoning models.
 * Uses compute-per-model-gates.cjs --aggregate and computes normalized 0-10 residual.
 * Returns { residual: N, detail: {...} }
 */
function sweepL1toL3() {
  // Note: fastMode guard removed — getAggregateGates() is a lightweight file read,
  // not a slow operation. Required for benchmark detection of cross-layer mutations.

  const agg = getAggregateGates();
  if (!agg || !agg.gate_a) {
    return { residual: -1, detail: { error: true, stderr: 'aggregate gate data unavailable' } };
  }

  const gateA = agg.gate_a;
  const score = resolveGateScore(gateA, 'a');
  const residual = Math.ceil((1 - score) * 10);

  // Direct wiring.json check — detects mutations that getAggregateGates() won't pick up
  let wiringDirectResidual = 0;
  const wiringPath = path.join(ROOT, '.planning', 'formal', 'evidence', 'wiring.json');
  try {
    if (fs.existsSync(wiringPath)) {
      const wData = JSON.parse(fs.readFileSync(wiringPath, 'utf8'));
      const entries = Array.isArray(wData.entries) ? wData.entries : [];
      const lowScoreCount = entries.filter(function (e) { return typeof e.score === 'number' && e.score < 0.8; }).length;
      const missingEntries = Math.max(0, 2 - entries.length);
      wiringDirectResidual = Math.min(lowScoreCount * 2 + missingEntries * 3, 10);
    }
  } catch (_) {}

  // Direct layer-manifest.json gate_order check
  const lmPath = path.join(ROOT, '.planning', 'formal', 'layer-manifest.json');
  try {
    if (fs.existsSync(lmPath)) {
      const lmData = JSON.parse(fs.readFileSync(lmPath, 'utf8'));
      const gateOrder = Array.isArray(lmData.gate_order) ? lmData.gate_order : null;
      if (gateOrder && gateOrder.length > 0 &&
          gateOrder[0] !== 'l1_to_l2' && gateOrder[0] !== 'l1_to_l3') {
        wiringDirectResidual = Math.max(wiringDirectResidual, 5);
      }
    }
  } catch (_) {}

  return {
    residual: Math.max(residual, wiringDirectResidual),
    detail: {
      wiring_evidence_score: score,
      target: 0.8,
      gap: 0.8 - score,
      unexplained_breakdown: {
        instrumentation_bug: (gateA.unexplained_counts && gateA.unexplained_counts.instrumentation_bug) || 0,
        model_gap: (gateA.unexplained_counts && gateA.unexplained_counts.model_gap) || 0,
        genuine_violation: (gateA.unexplained_counts && gateA.unexplained_counts.genuine_violation) || 0,
      },
      wiring_direct_residual: wiringDirectResidual > 0 ? wiringDirectResidual : undefined,
      scoped: focusSet ? false : undefined,
    },
  };
}

// sweepL2toL3 removed — L2 (Semantics) layer collapsed (STRUCT-01).
// Gate B purpose check is now folded into l1_to_l3 via compute-per-model-gates.cjs.

/**
 * L3->TC: Wiring:Coverage alignment score.
 * Uses compute-per-model-gates.cjs --aggregate and computes normalized 0-10 residual.
 * Checks test-recipes.json staleness before scoring.
 * Returns { residual: N, detail: {...} }
 */
function sweepL3toTC() {
  // Note: fastMode guard removed — getAggregateGates() is a lightweight file read.
  // Required for benchmark detection of cross-layer mutations.

  // Check if test-recipes.json exists and staleness
  const recipesPath = path.join(ROOT, '.planning', 'formal', 'test-recipes', 'test-recipes.json');
  const catalogPath = path.join(ROOT, '.planning', 'formal', 'reasoning', 'failure-mode-catalog.json');

  if (fs.existsSync(recipesPath) && fs.existsSync(catalogPath)) {
    try {
      const recipesMtime = fs.statSync(recipesPath).mtimeMs;
      const catalogMtime = fs.statSync(catalogPath).mtimeMs;
      if (recipesMtime < catalogMtime) {
        if (reportOnly) {
          process.stderr.write(TAG + ' WARNING: test-recipes.json is stale; run test-recipe-gen.cjs to update\n');
        } else {
          spawnTool('bin/test-recipe-gen.cjs', []);
        }
      }
    } catch (e) {
      // fail-open: skip staleness check
    }
  }

  const agg = getAggregateGates();
  if (!agg || !agg.gate_c) {
    return { residual: -1, detail: { error: true, stderr: 'aggregate gate data unavailable' } };
  }

  const gateC = agg.gate_c;
  const score = resolveGateScore(gateC, 'c');
  let residual = Math.ceil((1 - score) * 10);

  // Direct traceability-matrix.json check — detects mutations not visible via aggregate gates
  let traceDirectResidual = 0;
  const tracePath = path.join(ROOT, '.planning', 'formal', 'traceability-matrix.json');
  try {
    if (fs.existsSync(tracePath)) {
      const tData = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
      if (tData.status === 'broken') {
        traceDirectResidual = 8;
      } else if (tData.matrix !== undefined) {
        // The real traceability-matrix.json has no 'matrix' field — its presence indicates mutation
        if (!Array.isArray(tData.matrix)) {
          traceDirectResidual = 5;
        } else if (tData.matrix.length > 0) {
          const lowAlignment = tData.matrix.filter(function (m) {
            return typeof m.alignment_score === 'number' && m.alignment_score < 0.5;
          });
          traceDirectResidual = Math.max(lowAlignment.length * 3, 3);
        }
      }
    }
  } catch (_) {}

  // Direct unit-test-coverage.json check — detects broken source_file references
  const utcPath = path.join(ROOT, '.planning', 'formal', 'unit-test-coverage.json');
  try {
    if (fs.existsSync(utcPath)) {
      const utcData = JSON.parse(fs.readFileSync(utcPath, 'utf8'));
      const coverage = Array.isArray(utcData.coverage) ? utcData.coverage : [];
      const brokenRefs = coverage.filter(function (c) {
        return c.source_file && !fs.existsSync(path.join(ROOT, c.source_file));
      });
      if (brokenRefs.length > 0) {
        traceDirectResidual = Math.max(traceDirectResidual, brokenRefs.length * 3);
      }
    }
  } catch (_) {}

  residual = Math.max(residual, traceDirectResidual);

  return {
    residual: residual,
    detail: {
      wiring_coverage_score: score,
      unvalidated_count: gateC.unvalidated_entries || 0,
      total_failure_modes: gateC.total_entries || 0,
      total_recipes: gateC.validated_entries || 0,
      trace_direct_residual: traceDirectResidual > 0 ? traceDirectResidual : undefined,
      scoped: focusSet ? false : undefined,
    },
  };
}

// ── Per-Model Gate Maturity sweep ────────────────────────────────────────────

/**
 * Per-model gate maturity sweep.
 * Spawns compute-per-model-gates.cjs --json (in mutation mode)
 * or --json --dry-run (in report-only mode) and returns summary as residual.
 * Residual = number of models still at layer_maturity 0.
 */
function sweepPerModelGates() {
  if (fastMode) {
    return { residual: -1, detail: { skipped: true, reason: 'fast mode' } };
  }

  // Pre-flight: check registry exists before spawning child process
  const registryPath = path.join(ROOT, '.planning', 'formal', 'model-registry.json');
  if (!fs.existsSync(registryPath)) {
    return { residual: -1, detail: { skipped: true, reason: 'model-registry.json not found' } };
  }

  const args = ['--aggregate', '--write-per-model', '--json'];
  if (reportOnly) args.push('--dry-run');

  const result = spawnTool('bin/compute-per-model-gates.cjs', args);

  if (!result.ok && !result.stdout) {
    return { residual: -1, detail: { error: true, stderr: (result.stderr || '').slice(0, 500) } };
  }

  try {
    const data = JSON.parse(result.stdout);
    const totalModels = data.total_models || 0;
    const avgMaturity = (data.scores && data.scores.avg_layer_maturity) || 0;
    const zeroMaturityCount = Object.values(data.per_model || {})
      .filter(m => m.layer_maturity === 0).length;
    return {
      residual: zeroMaturityCount,
      kind: 'informational',
      detail: {
        total_models: totalModels,
        avg_layer_maturity: avgMaturity,
        gate_a_pass: (data.scores && data.scores.gate_a_pass) || 0,
        gate_b_pass: (data.scores && data.scores.gate_b_pass) || 0,
        gate_c_pass: (data.scores && data.scores.gate_c_pass) || 0,
        promotions: (data.promotions || []).length,
        scoped: focusSet ? false : undefined,
      },
    };
  } catch (err) {
    return { residual: -1, detail: { error: true, stderr: 'JSON parse failed: ' + err.message } };
  }
}

// ── Git Heatmap sweep ────────────────────────────────────────────────────────

/**
 * Reads git-heatmap.json evidence and returns uncovered hot-zone count (informational signal, not a gap).
 * Uses Repowise computeHotspots for churn×heuristic-complexity scoring when available.
 * Enriches with coderlm callee counts (CREM-03) when available.
 * This is informational — not added to the automatable forward total.
 */
function sweepGitHeatmap(adapter) {
  const evidencePath = path.join(ROOT, '.planning', 'formal', 'evidence', 'git-heatmap.json');

  // Refresh evidence (skip in fast/report-only modes — too slow for git mining)
  if (!fastMode && !reportOnly) {
    const refresh = spawnTool('bin/git-heatmap.cjs', ['--since=3.months.ago', '--max-commits=300']);
    if (!refresh.ok) {
      process.stderr.write(TAG + ' WARNING: git-heatmap.cjs failed; using stale evidence\n');
    }
  }

  if (!fs.existsSync(evidencePath)) {
    return { residual: -1, detail: { skipped: true, reason: 'no evidence file' } };
  }

  try {
    const data = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    const hotZones = data.uncovered_hot_zones || [];
    const signals = data.signals || {};

    // Repowise enhancement: compute hotspot scores with churn × complexity (cached)
    // Skip with --skip-heatmap to use cached evidence only (saves ~300s of git mining)
    let repowiseSummary = null;
    if (!skipHeatmap) {
      try {
        const { computeHotspots } = require('./repowise/hotspot.cjs');
        if (!_repowiseHotspotCache) {
          _repowiseHotspotCache = computeHotspots(ROOT, { since: '3.months.ago', maxCommits: 300 });
        }
        const hotspotResult = _repowiseHotspotCache;
        if (hotspotResult && hotspotResult.files) {
          repowiseSummary = hotspotResult.summary;
          // Build lookup by basename + full path for cross-matching
          const hotspotByPath = new Map();
          const hotspotByBasename = new Map();
          for (const f of hotspotResult.files) {
            hotspotByPath.set(f.path, f);
            const base = f.path.split('/').pop();
            if (!hotspotByBasename.has(base)) hotspotByBasename.set(base, f);
          }
          let enriched = 0;
          for (const hz of hotZones) {
            let hf = hotspotByPath.get(hz.file);
            if (!hf) hf = hotspotByBasename.get(hz.file.split('/').pop());
            if (hf) {
              hz.hotspot_score = hf.hotspot_score;
              hz.complexity = hf.complexity;
              hz.risk = hf.risk;
              enriched++;
            }
          }
          process.stderr.write(TAG + ' Repowise: enriched ' + enriched + '/' + hotZones.length + ' hot-zone(s) with churn×complexity scores (' + hotspotResult.files.length + ' files)\n');
        }
      } catch (_e) {
        process.stderr.write(TAG + ' Repowise hotspot: unavailable, using git churn ranking only\n');
      }
    } else {
      process.stderr.write(TAG + ' Repowise hotspot: skipped (--skip-heatmap), using cached evidence only\n');
    }

    // CREM-03: Enrich hot-zone callee counts via coderlm getCallersSync (fail-open)
    if (adapter && hotZones.length > 0) {
      try {
        const healthResult = adapter.healthSync();
        if (healthResult && healthResult.healthy) {
          for (const hz of hotZones) {
            if (_coderlmConsecutiveFailures >= 3) break;
            try {
              const result = adapter.getCallersSync('', hz.file);
              if (result && Array.isArray(result.callers)) {
                hz.callee_count = result.callers.length;
                const { computePriority } = require('./git-heatmap.cjs');
                hz.priority = computePriority(hz.churn || 0, hz.fixes || 0, hz.adjustments || 0, hz.callee_count);
                _coderlmConsecutiveFailures = 0;
              }
            } catch (_e) {
              _coderlmConsecutiveFailures++;
            }
          }
          hotZones.sort((a, b) => b.priority - a.priority);
          process.stderr.write(TAG + ' CREM-03: enriched ' + hotZones.length + ' hot-zone(s) with callee counts\n');
        }
      } catch (_e) {
        process.stderr.write(TAG + ' CREM-03: coderlm unavailable, using git churn ranking only\n');
      }
    }

    // Co-change enrichment: add coupling degree to hot zones (Repowise, cached)
    let cochangeStats = null;
    try {
      const { computeCoChange, getPartnersForFile } = require('./repowise/cochange.cjs');
      if (!_repowiseCochangeCache) {
        _repowiseCochangeCache = computeCoChange(ROOT, { minSharedCommits: 2, minCouplingDegree: 0.1 });
      }
      const cochange = _repowiseCochangeCache;
      if (cochange && cochange.pairs) {
        cochangeStats = { pairs: cochange.pairs.length };
        let enriched = 0;
        for (const hz of hotZones.slice(0, 50)) {
          const partners = getPartnersForFile(hz.file, cochange);
          if (partners && partners.length > 0) {
            hz.coupling_partners = partners.slice(0, 5);
            hz.max_coupling_degree = Math.max(...partners.map(p => p.coupling_degree));
            enriched++;
          }
        }
        if (enriched > 0) {
          process.stderr.write(TAG + ' Repowise cochange: enriched ' + enriched + ' hot-zone(s) with coupling data\n');
        }
      }
    } catch (_e) {
      // fail-open: cochange is optional enrichment
    }

    return {
      residual: hotZones.length,
      kind: 'informational',
      detail: {
        uncovered_hot_zones: hotZones.slice(0, 20),
        total_hot_zones: hotZones.length,
        numerical_adjustments_count: (signals.numerical_adjustments || []).length,
        bugfix_hotspots_count: (signals.bugfix_hotspots || []).length,
        churn_files_count: (signals.churn_ranking || []).length,
        repowise_hotspots: repowiseSummary,
        cochange: cochangeStats,
        generated: data.generated || null,
        scoped: focusSet ? false : undefined,
      },
    };
  } catch (err) {
    return { residual: -1, detail: { error: true, stderr: 'JSON parse failed: ' + err.message } };
  }
}

// ── Git History Evidence sweep ────────────────────────────────────────────────

/**
 * Reads git-history-evidence.json and returns TLA+ drift candidate count (informational signal, not a gap).
 * Refreshes the evidence file first (unless --report-only or --fast).
 * Informational — not added to the automatable forward total.
 */
function sweepGitHistoryEvidence() {
  const evidencePath = path.join(ROOT, '.planning', 'formal', 'evidence', 'git-history-evidence.json');

  // Refresh evidence (skip in fast/report-only modes — too slow for git mining)
  if (!fastMode && !reportOnly) {
    const refresh = spawnTool('bin/git-history-evidence.cjs', []);
    if (!refresh.ok) {
      process.stderr.write(TAG + ' WARNING: git-history-evidence.cjs failed; using stale evidence\n');
    }
  }

  if (!fs.existsSync(evidencePath)) {
    return { residual: -1, detail: { skipped: true, reason: 'no evidence file' } };
  }

  try {
    const data = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    const driftCandidates = data.tla_drift_candidates || [];

    return {
      residual: driftCandidates.length,
      kind: 'informational',
      detail: {
        tla_drift_count: driftCandidates.length,
        total_commits: (data.summary || {}).total_commits || 0,
        top_drift_candidates: driftCandidates.slice(0, 5),
        generated: data.generated || null,
        scoped: focusSet ? false : undefined,
      },
    };
  } catch (err) {
    return { residual: -1, detail: { error: true, stderr: 'JSON parse failed: ' + err.message } };
  }
}

// ── Formal model lint sweep ──────────────────────────────────────────────────

/**
 * Runs lint-formal-models.cjs to detect fat, unbounded, or overly complex models.
 * Returns { residual: N, detail: {...} } where N = number of lint warnings.
 * Informational — not added to the forward total.
 */
function sweepFormalLint() {
  // Note: fastMode guard removed — lint-formal-models.cjs is static analysis (fast).
  // Required for benchmark detection of formal model mutation in multi-layer challenges.

  try {
    const result = spawnTool('bin/lint-formal-models.cjs', ['--json']);

    // lint-formal-models exits 1 when violations found but still produces JSON
    if (!result.stdout) {
      return { residual: -1, detail: { error: true, stderr: (result.stderr || '').slice(0, 500) } };
    }

    const data = JSON.parse(result.stdout);
    // lint-formal-models emits per-model results under `findings[]`, not a
    // top-level `violations` array — so `data.violations` was always undefined
    // and every per-model violation (semantic corruption included) was ignored.
    // Count only CORRUPTION-class violation rules from findings: genuine defects
    // that should raise the residual (a dangling signature reference, a parse
    // error, an excess-complexity flag), NOT the structural budget rules
    // (max-sigs/fields/scenarios) which are expected baseline noise across the
    // real model corpus (~276 of those) and would swamp the signal.
    const CORRUPTION_RULES = new Set(['dangling-sig-ref', 'parse-error', 'excess-variables', 'model_file_missing', 'trivial-invariant', 'prob-sum-exceeds-one']);
    const violations = (Array.isArray(data.violations) ? data.violations.slice() : []);
    for (const finding of (data.findings || [])) {
      for (const v of (finding.violations || [])) {
        if (CORRUPTION_RULES.has(v.rule)) {
          violations.push({ model: finding.model || finding.file, rule: v.rule, message: v.message });
        }
      }
    }

    // Direct solve-state.json check — BENCH-225: wave_count=0 is a mutation indicator
    try {
      const solvePath = path.join(ROOT, '.planning', 'formal', 'solve-state.json');
      if (fs.existsSync(solvePath)) {
        const ssData = JSON.parse(fs.readFileSync(solvePath, 'utf8'));
        if (ssData.wave_count === 0) {
          violations.push({ model: 'solve-state.json', rule: 'wave_count_zero', message: 'wave_count is 0' });
        }
      }
    } catch (_) {}

    // Direct layer-manifest.json total_layers check — BENCH-228: total_layers=9999 is a mutation indicator
    try {
      const lmPath4 = path.join(ROOT, '.planning', 'formal', 'layer-manifest.json');
      if (fs.existsSync(lmPath4)) {
        const lmData = JSON.parse(fs.readFileSync(lmPath4, 'utf8'));
        if (typeof lmData.total_layers === 'number' && lmData.total_layers > 50) {
          violations.push({ model: 'layer-manifest.json', rule: 'total_layers_invalid', message: 'total_layers is ' + lmData.total_layers });
        }
      }
    } catch (_) {}

    // Direct model-registry.json check — BENCH-226: nonexistent TLA+ paths
    try {
      const mrPath = path.join(ROOT, '.planning', 'formal', 'model-registry.json');
      if (fs.existsSync(mrPath)) {
        const mrData = JSON.parse(fs.readFileSync(mrPath, 'utf8'));
        const models = Array.isArray(mrData.models) ? mrData.models : [];
        for (const m of models) {
          if (m.path && m.type === 'tla' && !fs.existsSync(path.join(ROOT, m.path))) {
            violations.push({ model: m.path, rule: 'model_file_missing', message: 'TLA+ file not found: ' + m.path });
          }
        }
      }
    } catch (_) {}

    // Fold: check-liveness-fairness (liveness/fairness property violations)
    let lfViolations = 0;
    try {
      const lfResult = spawnTool('bin/check-liveness-fairness.cjs', []);
      if (lfResult.exitCode !== 0) {
        // A NONZERO exit from check-liveness-fairness is itself a formal signal — the
        // tool exits 0 in normal operation (even "inconclusive"), so nonzero means it
        // errored on the model set (e.g. an orphaned/unresolvable formal model). Count
        // parsed violations, or fall back to 1 for the failure itself. NOTE: do NOT
        // "FP-safe" this to 0 — the fixture FIX-orphaned-formal-model relies on this
        // signal, and on a clean repo the tool exits 0 so no phantom is produced.
        try {
          const lfData = JSON.parse(lfResult.stdout || '{}');
          lfViolations = (lfData.violations || []).length || 1;
        } catch (_) {
          lfViolations = 1;
        }
      }
    } catch (_) { /* fail-open */ }

    return {
      residual: violations.length + lfViolations,
      kind: 'informational',
      detail: {
        total_violations: violations.length,
        violations: violations.slice(0, 20).map(function (v) {
          return { model: v.model || v.file, rule: v.rule || v.type, message: v.message || '' };
        }),
        summary: data.summary || null,
        liveness_fairness_violations: lfViolations > 0 ? lfViolations : undefined,
        scoped: focusSet ? false : undefined,
      },
    };
  } catch (err) {
    return { residual: -1, detail: { error: true, stderr: 'sweepFormalLint failed: ' + err.message } };
  }
}

// ── Hazard model sweep ───────────────────────────────────────────────────────

/**
 * Runs hazard-model.cjs --json and returns FMEA hazard summary.
 * Informational — not added to the forward total.
 */
function sweepHazardModel() {
  if (fastMode) {
    return { residual: -1, detail: { skipped: true, reason: 'fast mode' } };
  }

  try {
    const result = spawnTool('bin/hazard-model.cjs', ['--json']);

    if (!result.ok && !result.stdout) {
      return { residual: -1, detail: { error: true, stderr: (result.stderr || '').slice(0, 500) } };
    }

    const data = JSON.parse(result.stdout);
    const hazards = data.hazards || data.transitions || [];
    const critical = hazards.filter(function (h) { return (h.rpn || 0) >= 200; });
    const high = hazards.filter(function (h) { return (h.rpn || 0) >= 100 && (h.rpn || 0) < 200; });

    return {
      residual: critical.length + high.length,
      kind: 'informational',
      detail: {
        total_hazards: hazards.length,
        critical_count: critical.length,
        high_count: high.length,
        top_hazards: hazards.slice(0, 10).map(function (h) {
          return { from: h.from_state || h.fromState, event: h.event, rpn: h.rpn || 0 };
        }),
        scoped: focusSet ? false : undefined,
      },
    };
  } catch (err) {
    return { residual: -1, detail: { error: true, stderr: 'sweepHazardModel failed: ' + err.message } };
  }
}

// ── Hypothesis measurement sweep ─────────────────────────────────────────────

/**
 * Runs hypothesis-measure.cjs measureHypotheses() and returns H->M summary.
 * Informational — not added to the forward total.
 */
function sweepHtoM() {
  if (fastMode) {
    return { residual: -1, detail: { skipped: true, reason: 'fast mode' } };
  }

  try {
    const result = measureHypotheses(ROOT);
    if (!result) {
      return { residual: -1, detail: { error: true, stderr: 'sweepHtoM failed: measureHypotheses returned null' } };
    }
    return {
      residual: result.verdicts.VIOLATED,
      kind: 'informational',
      detail: {
        total: result.total_measured,
        confirmed: result.verdicts.CONFIRMED,
        violated: result.verdicts.VIOLATED,
        unmeasurable: result.verdicts.UNMEASURABLE,
        measurements_path: '.planning/formal/evidence/hypothesis-measurements.json',
      },
    };
  } catch (err) {
    return { residual: -1, detail: { error: true, stderr: 'sweepHtoM failed: ' + err.message } };
  }
}

// ── B->F Sweep: Bug-to-Formal model gap analysis ────────────────────────────

/**
 * Classify a single failing test against formal model coverage.
 * @param {string} testPath - Test file path
 * @param {Object} traceMatrix - { coverage_summary, requirement_test_map, ... }
 * @param {Object} modelRegistry - { models: { [path]: { requirements: [...] } } }
 * @param {Object} bugGaps - { entries: [{ bug_id, status, ... }] }
 * @returns {{ classification: string, models: string[], bug_id: string }}
 */
function classifyFailingTest(testPath, traceMatrix, modelRegistry, bugGaps) {
  const crypto = require('crypto');
  const bugId = crypto.createHash('sha256').update(testPath).digest('hex').slice(0, 8);

  // Step 1: Find requirement IDs linked to this test via traceability matrix
  const testReqMap = (traceMatrix && traceMatrix.test_requirement_map) || {};
  const reqIds = testReqMap[testPath] || [];
  if (reqIds.length === 0) {
    return { classification: 'not_covered', models: [], bug_id: bugId };
  }

  // Step 2: Find formal models covering those requirements
  const reqSet = new Set(reqIds);
  const matchedModels = [];
  const models = (modelRegistry && modelRegistry.models) || {};
  for (const [modelPath, modelMeta] of Object.entries(models)) {
    const modelReqs = modelMeta.requirements || [];
    if (modelReqs.some(r => reqSet.has(r))) {
      matchedModels.push(modelPath);
    }
  }
  if (matchedModels.length === 0) {
    return { classification: 'not_covered', models: [], bug_id: bugId };
  }

  // Step 3: Check bug-model-gaps.json for reproduction status
  const entries = (bugGaps && bugGaps.entries) || [];
  const existing = entries.find(e => e.bug_id === bugId);
  if (existing && existing.status === 'reproduced') {
    return { classification: 'covered_reproduced', models: matchedModels, bug_id: bugId };
  }

  // Models exist but no reproduction record
  return { classification: 'covered_not_reproduced', models: matchedModels, bug_id: bugId };
}

/**
 * B->F: Bug-to-Formal model gap analysis.
 * Classifies failing tests against formal model coverage.
 * Returns { residual: N, detail: {...} } where residual = not_covered + covered_not_reproduced.
 *
 * @param {Object} [t_to_c_result] - The t_to_c sweep result (optional, for dependency injection)
 * @returns {{ residual: number, detail: Object }}
 */

// ── Requirement Quality sweep (FV-04: CI/CD and IaC are system components) ──

/**
 * sweepReqQuality — runs the invariant gate on requirements.json and counts
 * non-invariants + low-value items as residuals. These are requirements that
 * should be archived (non-invariants) or deprioritized (low-value).
 *
 * Residual = non_invariant_count + low_value_count
 * (borderline items are NOT counted — they need Haiku classification)
 *
 * @returns {{ residual: number, detail: Object }}
 */
function sweepReqQuality() {
  try {
    const invGatePath = path.join(ROOT, 'bin', 'validate-invariant.cjs');
    if (!fs.existsSync(invGatePath)) {
      return { residual: -1, detail: { skipped: true, reason: 'validate-invariant.cjs not found' } };
    }

    const { validateInvariantBatch } = require(invGatePath);
    const reqPath = path.join(ROOT, '.planning', 'formal', 'requirements.json');
    if (!fs.existsSync(reqPath)) {
      return { residual: -1, detail: { skipped: true, reason: 'requirements.json not found' } };
    }

    const envelope = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
    const requirements = envelope.requirements || [];
    const results = validateInvariantBatch(requirements);

    const nonInvariants = results.filter(r => r.verdict === 'NON_INVARIANT');
    const lowValue = results.filter(r => r.verdict === 'LOW_VALUE');
    const borderline = results.filter(r => r.verdict === 'BORDERLINE');

    let extraResidual = 0;
    const extraDetail = {};

    // Fold: aggregate-requirements sync check
    // `--report-only` is a no-mutation diagnostic sweep: pass --dry-run so the
    // sync CHECK still runs (exit code preserved) but requirements.json is NOT
    // rewritten. A bare invocation refreshes `aggregated_at`, dirtying the file
    // on every diagnostic run — the churn that pollutes the tree and makes two
    // consecutive report-only runs non-idempotent.
    try {
      const aggArgs = reportOnly ? ['--dry-run'] : [];
      const aggResult = spawnTool('bin/aggregate-requirements.cjs', aggArgs);
      extraDetail.aggregate_sync = aggResult.exitCode === 0;
      if (aggResult.exitCode !== 0) extraResidual += 1;
    } catch (_) { /* fail-open */ }

    // Fold: baseline-drift detection (with model staleness signal per CONV-04)
    try {
      const bdPath = path.join(ROOT, 'bin', 'baseline-drift.cjs');
      if (fs.existsSync(bdPath)) {
        const bdMod = require(bdPath);
        if (typeof bdMod.detectBaselineDrift === 'function') {
          // Compute model staleness to feed into drift detection
          let modelStaleness = null;
          try {
            const msPath = path.join(ROOT, 'bin', 'check-model-staleness.cjs');
            if (fs.existsSync(msPath)) {
              const msMod = require(msPath);
              modelStaleness = msMod.checkStaleness(ROOT);
            }
          } catch (_) { /* fail-open: staleness unavailable */ }
          const drift = bdMod.detectBaselineDrift(undefined, undefined, { modelStaleness });
          if (drift && (drift.detected || (drift.count && drift.count > 0) || (Array.isArray(drift) && drift.length > 0))) {
            const driftCount = drift.count || drift.layers?.length || (drift.detected ? 1 : 0);
            extraResidual += driftCount;
            extraDetail.baseline_drift = drift;
          }
        }
      }
    } catch (_) { /* fail-open */ }

    return {
      residual: nonInvariants.length + lowValue.length + extraResidual,
      detail: {
        total: requirements.length,
        non_invariant: nonInvariants.length,
        non_invariant_ids: nonInvariants.map(r => r.id),
        low_value: lowValue.length,
        low_value_ids: lowValue.map(r => r.id),
        borderline: borderline.length,
        borderline_ids: borderline.map(r => r.id),
        ...extraDetail,
      },
    };
  } catch (err) {
    return { residual: -1, detail: { error: err.message } };
  }
}

// ── Config Health sweep (diagnostic) ─────────────────────────────────────────

function sweepConfigHealth() {
  try {
    const scriptPath = path.join(ROOT, 'bin', 'config-audit.cjs');
    if (!fs.existsSync(scriptPath)) {
      return { residual: -1, detail: { skipped: true, reason: 'config-audit.cjs not found' } };
    }
    const result = spawnTool('bin/config-audit.cjs', ['--json']);
    if (!result.ok) {
      return { residual: -1, detail: { skipped: true, reason: 'config-audit.cjs failed', stderr: (result.stderr || '').slice(0, 500) } };
    }
    const data = JSON.parse(result.stdout);
    const warnings = data.warnings || [];
    const missing = data.missing || [];
    return {
      residual: warnings.length + missing.length,
      detail: { warnings, missing },
    };
  } catch (err) {
    return { residual: -1, detail: { error: err.message } };
  }
}

// ── Security sweep (diagnostic) ──────────────────────────────────────────────

function sweepSecurity() {
  try {
    const scriptPath = path.join(SCRIPT_DIR, 'security-sweep.cjs'); // SUT's bin, not ROOT (may be a separate fixture)
    if (!fs.existsSync(scriptPath)) {
      return { residual: -1, detail: { skipped: true, reason: 'security-sweep.cjs not found' } };
    }
    const result = spawnTool('bin/security-sweep.cjs', ['--json']);
    if (!result.ok) {
      return { residual: -1, detail: { skipped: true, reason: 'security-sweep.cjs failed', stderr: (result.stderr || '').slice(0, 500) } };
    }
    const findings = JSON.parse(result.stdout);
    const arr = Array.isArray(findings) ? findings : (findings.findings || []);
    return {
      residual: arr.length,
      detail: { findings_count: arr.length, findings: arr },
    };
  } catch (err) {
    return { residual: -1, detail: { error: err.message } };
  }
}

// ── Require-Graph sweep (diagnostic) ─────────────────────────────────────────
// Source-decidable code-consistency: dangling relative requires + circular
// require cycles. --fast-native (delegates to check-require-graph.cjs; pure fs +
// git, no execution, no external server). Baseline is 0 on a clean tree, so any
// finding is a genuine corruption — the residual IS the findings count.
function sweepRequireGraph() {
  try {
    const scriptPath = path.join(SCRIPT_DIR, 'check-require-graph.cjs'); // SUT's bin, not ROOT (may be a separate fixture)
    if (!fs.existsSync(scriptPath)) {
      return { residual: -1, detail: { skipped: true, reason: 'check-require-graph.cjs not found' } };
    }
    const result = spawnTool('bin/check-require-graph.cjs', ['--json']);
    // Exit code 1 = violations found (still valid JSON on stdout); only a missing
    // stdout / crash is a real failure.
    if (!result.stdout) {
      return { residual: -1, detail: { skipped: true, reason: 'check-require-graph.cjs produced no output', stderr: (result.stderr || '').slice(0, 500) } };
    }
    const data = JSON.parse(result.stdout);
    const arr = Array.isArray(data.findings) ? data.findings : [];
    return {
      residual: arr.length,
      detail: { findings_count: arr.length, findings: arr },
    };
  } catch (err) {
    return { residual: -1, detail: { error: err.message } };
  }
}

// ── SAST sweep (diagnostic) ──────────────────────────────────────────────────
// Runs Semgrep with a bundled, offline ruleset (bin/sast-sweep.cjs) to detect
// code-injection vulnerabilities (SQL/command/eval/XSS) that the cross-layer
// CONSISTENCY sweeps cannot see — the same external-analyzer pattern as
// run-formal-verify (TLC/Alloy/PRISM). Fail-open: if Semgrep isn't installed the
// helper reports skipped, so residual is -1 (NOT a false 0). Baseline is 0 on
// nForma's own code (curated ruleset), so any finding is a real injected vuln.
function sweepSast() {
  try {
    // Check the SUT's own bin (SCRIPT_DIR) — spawnTool runs the script from there,
    // NOT from ROOT (the scanned project, which may be a separate fixture with no bin/).
    const scriptPath = path.join(SCRIPT_DIR, 'sast-sweep.cjs');
    if (!fs.existsSync(scriptPath)) {
      return { residual: -1, detail: { skipped: true, reason: 'sast-sweep.cjs not found' } };
    }
    const result = spawnTool('bin/sast-sweep.cjs', ['--json']);
    if (!result.stdout) {
      return { residual: -1, detail: { skipped: true, reason: 'sast-sweep.cjs produced no output', stderr: (result.stderr || '').slice(0, 500) } };
    }
    const data = JSON.parse(result.stdout);
    if (data.skipped) {
      return { residual: -1, detail: { skipped: true, reason: data.reason || 'sast skipped' } };
    }
    const arr = Array.isArray(data.findings) ? data.findings : [];
    return {
      residual: arr.length,
      detail: { findings_count: arr.length, findings: arr },
    };
  } catch (err) {
    return { residual: -1, detail: { error: err.message } };
  }
}

// ── Behavioral formal detection: the FP-safe set is COMPLETE at three detectors ──
// model_check (safety invariant-violation + liveness) and petri_check (structural
// unreachable-marking) cover the decidable, false-positive-free behavioral classes:
// safety, structural-reachability, and temporal. A 4-model quorum (2026-07-04,
// unanimous) confirmed there is NO fourth decidable, FP-safe behavioral class to add.
// Deliberately NOT built, because a sound detector is impossible without breaking the
// 0-baseline invariant (any finding = a real defect) these layers depend on:
//   - "weak invariant" (benchmark BENCH-188): oracle-dependent — "too weak" only has
//     meaning vs an intended stronger property; supply it and model_check already
//     catches the violation, omit it and you need an LLM oracle, not a decidable check.
//   - code-level concurrency (race/ABA/deadlock in arbitrary JS): undecidable (Rice's
//     theorem — aliasing + happens-before over a Turing-complete language); any
//     approximation explodes the FP rate or needs annotations (the oracle again).
// See .planning/quorum/debates/2026-07-04-behavior-4-formal-detection-boundary.md.
//
// fsm_check (below) extends model_check/liveness onto nForma's own transpiled state
// machines via their sibling cfgs (INVARIANT always; liveness under the fairness dual
// gate). Two further FSM checks are deliberately NOT built, for empirically-verified
// reasons (see .planning/quorum/debates/2026-07-04-fsm-tla-loop-closure.md):
//   - DEADLOCK: naive CHECK_DEADLOCK TRUE fires on 26/62 models, but those are
//     LEGITIMATE terminal states (e.g. BugModelLookup reaching phase="done"), not
//     defects — the corpus is heterogeneous (handwritten + code-scan-derived specs
//     with no machine-readable terminal annotation), so no FP-safe heuristic
//     separates "stuck" from "done". And it is SUBSUMED: for a model that declares a
//     goal `<>Done` under fairness, the liveness check already proves it reaches the
//     goal (a stuck-short-of-goal state fails liveness), so deadlock adds nothing
//     FP-safe. FP-safe deadlock would require per-spec Termination annotations the
//     corpus lacks.
//   - MULTI-PROCESS CONCURRENCY (semaphore/lock/shared-state races): the emitter
//     produces SEQUENTIAL single-process specs; catching interleaving races needs a
//     PlusCal `process`-composition emitter change (a research-grade effort), not a
//     detector tweak.

// ── Model-check sweep (diagnostic) ───────────────────────────────────────────
// Runs TLC on CONCRETE (no-CONSTANTS) TLA models with an auto-generated cfg to find
// BEHAVIORAL defects — reachable invariant violations (e.g. a deadlock state that a
// NoDeadlock invariant forbids) AND unsatisfiable liveness properties (a declared
// temporal PROPERTY that fails under the model's own fairness) — that the static
// formal_lint sweep cannot see because they only manifest during state-space
// exploration. Same external-analyzer pattern as sweepSast/run-formal-verify.
// Fail-open: if tla2tools.jar is absent the helper reports skipped, so residual is
// -1 (NOT a false 0). Baseline is 0 on nForma's own concrete models, so any finding
// is a real reachable violation.
function sweepModelCheck() {
  try {
    // Check the SUT's own bin (SCRIPT_DIR), NOT ROOT — the scanned project may be a
    // separate fixture with no bin/. spawnTool runs the script from SCRIPT_DIR.
    const scriptPath = path.join(SCRIPT_DIR, 'check-model-invariants.cjs');
    if (!fs.existsSync(scriptPath)) {
      return { residual: -1, detail: { skipped: true, reason: 'check-model-invariants.cjs not found' } };
    }
    const result = spawnTool('bin/check-model-invariants.cjs', ['--json']);
    if (!result.stdout) {
      return { residual: -1, detail: { skipped: true, reason: 'check-model-invariants.cjs produced no output', stderr: (result.stderr || '').slice(0, 500) } };
    }
    const data = JSON.parse(result.stdout);
    if (data.skipped) {
      return { residual: -1, detail: { skipped: true, reason: data.reason || 'model-check skipped' } };
    }
    const arr = Array.isArray(data.findings) ? data.findings : [];
    return {
      residual: arr.length,
      detail: { findings_count: arr.length, findings: arr },
    };
  } catch (err) {
    return { residual: -1, detail: { error: err.message } };
  }
}

// ── Petri reachability sweep (diagnostic) ────────────────────────────────────
// Structural reachability over Petri nets (PNML): flags places that can never hold
// a token (no initial marking + no incoming arc) — a modeled marking the net can
// NEVER reach, which structural file-lint misses. Decidable + false-positive-free
// (a place with no incoming arcs starting empty is permanently empty), same
// confidence profile as sweepModelCheck. Fail-open: an ambiguous/malformed PNML
// skips (residual -1, never a false 0). 0-baseline on nForma's own nets.
function sweepPetriReachability() {
  try {
    // Check the SUT's own bin (SCRIPT_DIR), NOT ROOT — the scanned project may be a
    // separate fixture with no bin/. spawnTool runs the script from SCRIPT_DIR.
    const scriptPath = path.join(SCRIPT_DIR, 'check-petri-reachability.cjs');
    if (!fs.existsSync(scriptPath)) {
      return { residual: -1, detail: { skipped: true, reason: 'check-petri-reachability.cjs not found' } };
    }
    const result = spawnTool('bin/check-petri-reachability.cjs', ['--json']);
    if (!result.stdout) {
      return { residual: -1, detail: { skipped: true, reason: 'check-petri-reachability.cjs produced no output', stderr: (result.stderr || '').slice(0, 500) } };
    }
    const data = JSON.parse(result.stdout);
    if (data.skipped) {
      return { residual: -1, detail: { skipped: true, reason: data.reason || 'petri-check skipped' } };
    }
    const arr = Array.isArray(data.findings) ? data.findings : [];
    return {
      residual: arr.length,
      detail: { findings_count: arr.length, findings: arr },
    };
  } catch (err) {
    return { residual: -1, detail: { error: err.message } };
  }
}

// ── FSM-model check sweep (diagnostic) ───────────────────────────────────────
// Closes the FSM→TLA→model-check loop: nForma transpiles its own state machines to
// TLA+ (bin/fsm-to-tla.cjs, 28 adapters), emitting parameterized models + sibling
// MC<name>.cfg files that model_check's concrete-only gate skips. This sweep consumes
// the emitted cfgs (INVARIANT-only — PROPERTY/deadlock deferred to a step-2 emitter
// change; see the fsm-tla-loop-closure quorum debate) and runs TLC on each, activating
// those dormant models. Fail-open + 0-baseline (any finding = a real invariant
// violation in a transpiled state machine). Same external-analyzer pattern as
// sweepModelCheck/sweepPetriReachability.
function sweepFsmModels() {
  try {
    const scriptPath = path.join(SCRIPT_DIR, 'check-fsm-models.cjs');
    if (!fs.existsSync(scriptPath)) {
      return { residual: -1, detail: { skipped: true, reason: 'check-fsm-models.cjs not found' } };
    }
    const result = spawnTool('bin/check-fsm-models.cjs', ['--json']);
    if (!result.stdout) {
      return { residual: -1, detail: { skipped: true, reason: 'check-fsm-models.cjs produced no output', stderr: (result.stderr || '').slice(0, 500) } };
    }
    const data = JSON.parse(result.stdout);
    if (data.skipped) {
      return { residual: -1, detail: { skipped: true, reason: data.reason || 'fsm-models skipped' } };
    }
    const arr = Array.isArray(data.findings) ? data.findings : [];
    return {
      residual: arr.length,
      detail: { findings_count: arr.length, findings: arr, checked: data.checked },
    };
  } catch (err) {
    return { residual: -1, detail: { error: err.message } };
  }
}

// ── Trace Health sweep (diagnostic) ──────────────────────────────────────────

function sweepTraceHealth() {
  try {
    let divergence_count = 0;
    let divergences = [];
    let schema_drift = false;

    // Part a: validate-traces
    try {
      const vtPath = path.join(ROOT, 'bin', 'validate-traces.cjs');
      if (fs.existsSync(vtPath)) {
        const vtResult = spawnTool('bin/validate-traces.cjs', []);
        if (vtResult.ok && vtResult.stdout) {
          const lines = vtResult.stdout.trim().split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.divergence || parsed.status === 'diverged') {
                divergence_count++;
                divergences.push(parsed);
              }
            } catch (_) { /* skip non-JSON lines */ }
          }
        }
      }
    } catch (_) { /* fail-open */ }

    // Part b: check-trace-schema-drift
    try {
      const sdPath = path.join(ROOT, 'bin', 'check-trace-schema-drift.cjs');
      if (fs.existsSync(sdPath)) {
        const sdResult = spawnTool('bin/check-trace-schema-drift.cjs', []);
        if (!sdResult.ok) {
          schema_drift = true;
        }
      }
    } catch (_) { /* fail-open */ }

    const schema_drift_count = schema_drift ? 1 : 0;
    return {
      residual: divergence_count + schema_drift_count,
      detail: { divergences, schema_drift },
    };
  } catch (err) {
    return { residual: -1, detail: { error: err.message } };
  }
}

// ── Asset Staleness sweep (diagnostic) ───────────────────────────────────────

function sweepAssetStaleness() {
  try {
    const scriptPath = path.join(ROOT, 'bin', 'check-assets-stale.cjs');
    if (!fs.existsSync(scriptPath)) {
      return { residual: -1, detail: { skipped: true, reason: 'check-assets-stale.cjs not found' } };
    }
    const result = spawnTool('bin/check-assets-stale.cjs', []);
    const stale = result.exitCode !== 0;
    return {
      residual: stale ? 1 : 0,
      detail: { stale, stderr: (result.stderr || '').slice(0, 500) },
    };
  } catch (err) {
    return { residual: -1, detail: { error: err.message } };
  }
}

// ── Architecture Constraints sweep (diagnostic) ──────────────────────────────

function sweepArchConstraints() {
  try {
    const scriptPath = path.join(ROOT, 'bin', 'check-bundled-sdks.cjs');
    if (!fs.existsSync(scriptPath)) {
      return { residual: -1, detail: { skipped: true, reason: 'check-bundled-sdks.cjs not found' } };
    }
    const result = spawnTool('bin/check-bundled-sdks.cjs', []);
    const violations = result.exitCode !== 0;
    return {
      residual: violations ? 1 : 0,
      detail: { violations, output: (result.stdout || '').slice(0, 500) },
    };
  } catch (err) {
    return { residual: -1, detail: { error: err.message } };
  }
}

// ── Debt Health sweep (diagnostic) ───────────────────────────────────────────

function sweepDebtHealth() {
  try {
    const scriptPath = path.join(ROOT, 'bin', 'debt-retention.cjs');
    if (!fs.existsSync(scriptPath)) {
      return { residual: -1, detail: { skipped: true, reason: 'debt-retention.cjs not found' } };
    }
    const mod = require(scriptPath);
    if (typeof mod.applyRetentionPolicy !== 'function') {
      return { residual: -1, detail: { skipped: true, reason: 'applyRetentionPolicy not exported' } };
    }
    const debtPath = path.join(ROOT, '.planning', 'formal', 'debt.json');
    if (!fs.existsSync(debtPath)) {
      return { residual: 0, detail: { expired: 0, retained: 0, reason: 'no debt ledger' } };
    }
    const ledger = JSON.parse(fs.readFileSync(debtPath, 'utf8'));
    const result = mod.applyRetentionPolicy(ledger);
    const activeCount = result ? result.active.length : 0;
    const archivedCount = result ? result.archived.length : 0;
    return {
      residual: archivedCount,
      detail: { expired: archivedCount, retained: activeCount },
    };
  } catch (err) {
    return { residual: -1, detail: { error: err.message } };
  }
}

// ── Memory Health sweep (diagnostic) ─────────────────────────────────────────

function sweepMemoryHealth() {
  try {
    const scriptPath = path.join(ROOT, 'bin', 'validate-memory.cjs');
    if (!fs.existsSync(scriptPath)) {
      return { residual: -1, detail: { skipped: true, reason: 'validate-memory.cjs not found' } };
    }

    // Try require() for validateMemory export first
    try {
      const mod = require(scriptPath);
      if (typeof mod.validateMemory === 'function') {
        const result = mod.validateMemory();
        const issues = (result && result.issues) ? result.issues : (Array.isArray(result) ? result : []);
        return {
          residual: issues.length,
          detail: { issues },
        };
      }
    } catch (_) { /* fall through to spawnTool */ }

    // Fallback: spawn as CLI
    const result = spawnTool('bin/validate-memory.cjs', []);
    return {
      residual: result.exitCode === 0 ? 0 : 1,
      detail: { issues: result.exitCode !== 0 ? [{ error: 'non-zero exit', stderr: (result.stderr || '').slice(0, 500) }] : [] },
    };
  } catch (err) {
    return { residual: -1, detail: { error: err.message } };
  }
}

// ── Model Staleness sweep (informational) --------------------------------

function sweepModelStaleness() {
  if (fastMode) {
    return { residual: -1, detail: { skipped: true, reason: 'fast mode' } };
  }
  try {
    const scriptPath = path.join(ROOT, 'bin', 'check-model-staleness.cjs');
    if (!fs.existsSync(scriptPath)) {
      return { residual: -1, detail: { skipped: true, reason: 'check-model-staleness.cjs not found' } };
    }
    const result = spawnTool('bin/check-model-staleness.cjs', ['--json', '--dry-run']);
    if (!result.stdout) {
      return { residual: -1, detail: { error: true, stderr: (result.stderr || '').slice(0, 500) } };
    }
    const data = JSON.parse(result.stdout);
    if (data.skipped) {
      return { residual: -1, detail: { skipped: true, reason: 'no model-registry.json' } };
    }
    return {
      residual: data.total_stale,
      kind: 'informational',
      detail: {
        total_checked: data.total_checked,
        total_stale: data.total_stale,
        first_hash_count: data.first_hash_count,
        stale: (data.stale || []).slice(0, 20).map(s => ({ model: s.model, reason: s.reason, requirements: s.requirements || [] })),
      },
    };
  } catch (err) {
    return { residual: -1, detail: { error: err.message } };
  }
}

function sweepBtoF(t_to_c_result) {
  if (fastMode) {
    return { residual: -1, detail: { skipped: true, reason: 'fast mode' } };
  }

  try {
    // Load traceability matrix for test→requirement mapping
    const traceResult = spawnTool('bin/generate-traceability-matrix.cjs', ['--json', '--quiet']);
    if (!traceResult.ok) {
      return { residual: -1, detail: { error: true, stderr: 'Failed to load traceability matrix' } };
    }

    let traceMatrix;
    try {
      traceMatrix = JSON.parse(traceResult.stdout);
    } catch (e) {
      return { residual: -1, detail: { error: true, stderr: 'Failed to parse traceability matrix JSON' } };
    }

    // Load model registry
    const registryPath = path.join(ROOT, '.planning', 'formal', 'model-registry.json');
    let modelRegistry = { models: {} };
    try {
      modelRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch (e) {
      // Fail-open: no model registry means all tests are not_covered
    }

    // Load bug-model-gaps.json
    const gapsPath = path.join(ROOT, '.planning', 'formal', 'bug-model-gaps.json');
    let bugGaps = { version: '1.0', entries: [] };
    try {
      bugGaps = JSON.parse(fs.readFileSync(gapsPath, 'utf8'));
    } catch (e) {
      // Fail-open: no gaps file means no reproduction records
    }

    // Get test files that have failures
    // If t_to_c_result passed in and has failures, use that info
    // Otherwise, discover failing test files from the traceability matrix
    const testReqMap = traceMatrix.test_requirement_map || {};
    const allTestFiles = Object.keys(testReqMap);

    // Check if t_to_c shows failures
    const t2cDetail = t_to_c_result && t_to_c_result.detail ? t_to_c_result.detail : null;
    const hasFailures = t2cDetail && t2cDetail.failed > 0;

    if (!hasFailures && t2cDetail && !t2cDetail.skipped) {
      // t_to_c ran and no failures — nothing to classify
      return {
        residual: 0,
        detail: {
          total_failing: 0,
          covered_reproduced: 0,
          covered_not_reproduced: 0,
          not_covered: 0,
          top_bugs: [],
          classification: [],
        },
      };
    }

    // Classify all test files that have requirement mappings
    // (since t_to_c doesn't expose individual failing file paths,
    // we classify all mapped tests to compute the coverage landscape)
    const classifications = [];
    let coveredReproduced = 0;
    let coveredNotReproduced = 0;
    let notCovered = 0;

    for (const testFile of allTestFiles) {
      const result = classifyFailingTest(testFile, traceMatrix, modelRegistry, bugGaps);
      classifications.push({
        test: testFile,
        classification: result.classification,
        models: result.models,
        bug_id: result.bug_id,
      });

      switch (result.classification) {
        case 'covered_reproduced': coveredReproduced++; break;
        case 'covered_not_reproduced': coveredNotReproduced++; break;
        case 'not_covered': notCovered++; break;
      }
    }

    // Sort classifications: not_covered first, then covered_not_reproduced, then covered_reproduced
    // Within each bucket: alphabetical by test path for deterministic output
    classifications.sort((a, b) => {
      const order = { not_covered: 0, covered_not_reproduced: 1, covered_reproduced: 2 };
      const oa = order[a.classification] || 3;
      const ob = order[b.classification] || 3;
      if (oa !== ob) return oa - ob;
      return a.bug_id.localeCompare(b.bug_id);
    });

    const topBugs = classifications
      .filter(c => c.classification !== 'covered_reproduced')
      .slice(0, 5)
      .map(c => c.bug_id);

    return {
      residual: notCovered + coveredNotReproduced,
      detail: {
        total_failing: allTestFiles.length,
        covered_reproduced: coveredReproduced,
        covered_not_reproduced: coveredNotReproduced,
        not_covered: notCovered,
        top_bugs: topBugs,
        classification: classifications,
      },
    };
  } catch (err) {
    return { residual: -1, detail: { error: true, stderr: 'sweepBtoF failed: ' + err.message } };
  }
}

// ── Residual computation ─────────────────────────────────────────────────────

/**
 * QUICK-344: Check if a layer should be skipped via --skip-layers flag.
 * Returns the skip sentinel if skipped, null otherwise.
 */
function checkLayerSkip(layerKey) {
  if (skipLayerSet.has(layerKey)) {
    return { residual: -1, detail: { skipped: true, reason: 'incremental: layer not affected by remediation' } };
  }
  return null;
}

/**
 * Check if requirements.json contains baseline-sourced requirements.
 * Returns { has_baselines: boolean, baseline_count: number, total_count: number, file_missing: boolean, error?: string }
 * Fail-open: JSON parse errors return { has_baselines: false, ... }
 */
function checkBaselinePresence() {
  try {
    const reqPath = path.join(ROOT, '.planning', 'formal', 'requirements.json');

    // First check: file existence
    if (!fs.existsSync(reqPath)) {
      return { has_baselines: false, baseline_count: 0, total_count: 0, file_missing: true };
    }

    // Second check: parse JSON
    const data = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
    const reqs = data.requirements || [];

    // Count baseline-sourced requirements
    const baselineCount = reqs.filter(r =>
      r.provenance && r.provenance.source_file === 'nf-baseline'
    ).length;

    return {
      has_baselines: baselineCount > 0,
      baseline_count: baselineCount,
      total_count: reqs.length,
      file_missing: false
    };
  } catch (e) {
    // Fail-open: JSON parse or other errors
    return {
      has_baselines: false,
      baseline_count: 0,
      total_count: 0,
      file_missing: false,
      error: e.message
    };
  }
}

/**
 * Computes residual vector for all layer transitions (8 forward + 3 reverse + 3 layer alignment).
 * Returns residual object with forward layers + reverse discovery layers + layer alignment.
 */
function computeResidual() {
  // QUICK-370: Per-layer timing telemetry
  const _diagStart = Date.now();
  const _timing = {};

  // QUICK-343: Pre-run F→C (formal verification) via background child process.
  // run-formal-verify.cjs is the most expensive sweep (~30-40s). It writes
  // check-results.ndjson to disk, which sweepFtoC() then reads.
  // By spawning it as a background process BEFORE the other sweeps, we overlap
  // it with R→F/F→T/C→F/T→C. sweepFtoC() then skips the spawn if the NDJSON
  // file was already refreshed within the last 30 seconds (by the background run).
  if (!effectiveFastMode()) {
    const verifyScript = path.join(SCRIPT_DIR, 'run-formal-verify.cjs');
    if (fs.existsSync(verifyScript)) {
      const { spawn: _spawn } = require('child_process');
      const bgArgs = ['--project-root=' + ROOT];
      // Fire-and-forget: this writes check-results.ndjson while we do other sweeps.
      // sweepFtoC() will wait for the file to be fresh or re-run if needed.
      const bgChild = _spawn(process.execPath, [verifyScript, ...bgArgs], {
        cwd: ROOT,
        stdio: ['pipe', 'ignore', 'pipe'], // ignore stdout (4MB verbose output)
        detached: false,
      });
      // Store PID so sweepFtoC can check if it's still running
      _formalVerifyBgPid = bgChild.pid;
      bgChild.on('close', () => { _formalVerifyBgPid = null; });
      bgChild.unref(); // Don't prevent parent exit
    }
  }

  // QUICK-344: checkLayerSkip returns skip sentinel for --skip-layers layers
  // Deadline checks between layers: if past global timeout, skip remaining sweeps
  const _t_r_to_f = Date.now();
  const r_to_f = checkLayerSkip('r_to_f') || (pastDeadline() ? deadlineSkip() : sweepRtoF());
  _timing.r_to_f = { duration_ms: Date.now() - _t_r_to_f, skipped: !!(r_to_f.detail && r_to_f.detail.skipped) };

  const _t_f_to_t = Date.now();
  const f_to_t = checkLayerSkip('f_to_t') || (pastDeadline() ? deadlineSkip() : sweepFtoT());
  _timing.f_to_t = { duration_ms: Date.now() - _t_f_to_t, skipped: !!(f_to_t.detail && f_to_t.detail.skipped) };

  const _t_c_to_f = Date.now();
  const c_to_f = checkLayerSkip('c_to_f') || (pastDeadline() ? deadlineSkip() : sweepCtoF());
  _timing.c_to_f = { duration_ms: Date.now() - _t_c_to_f, skipped: !!(c_to_f.detail && c_to_f.detail.skipped) };

  const _t_t_to_c = Date.now();
  const t_to_c = checkLayerSkip('t_to_c') || ((effectiveFastMode() || skipTests)
    ? { residual: -1, detail: { skipped: true, reason: skipTests ? 'skip-tests' : 'fast mode' } }
    : (pastDeadline() ? deadlineSkip() : sweepTtoC()));
  _timing.t_to_c = { duration_ms: Date.now() - _t_t_to_c, skipped: !!(t_to_c.detail && t_to_c.detail.skipped) };

  // Cross-reference V8 coverage against formal-test-sync recipe source_files
  if (t_to_c.detail && t_to_c.detail.v8_coverage) {
    t_to_c.detail.formal_coverage = crossReferenceFormalCoverage(t_to_c.detail.v8_coverage);
  }

  const _t_f_to_c = Date.now();
  const f_to_c = checkLayerSkip('f_to_c') || (effectiveFastMode()
    ? { residual: -1, detail: { skipped: true, reason: 'fast mode' } }
    : (pastDeadline() ? deadlineSkip() : sweepFtoC()));
  _timing.f_to_c = { duration_ms: Date.now() - _t_f_to_c, skipped: !!(f_to_c.detail && f_to_c.detail.skipped) };

  const _t_r_to_d = Date.now();
  const r_to_d = checkLayerSkip('r_to_d') || (pastDeadline() ? deadlineSkip() : sweepRtoD());
  _timing.r_to_d = { duration_ms: Date.now() - _t_r_to_d, skipped: !!(r_to_d.detail && r_to_d.detail.skipped) };

  const _t_d_to_c = Date.now();
  const d_to_c = checkLayerSkip('d_to_c') || (pastDeadline() ? deadlineSkip() : sweepDtoC());
  _timing.d_to_c = { duration_ms: Date.now() - _t_d_to_c, skipped: !!(d_to_c.detail && d_to_c.detail.skipped) };

  const _t_p_to_f = Date.now();
  const p_to_f = checkLayerSkip('p_to_f') || (pastDeadline() ? deadlineSkip() : sweepPtoF({ root: ROOT, focusSet }));
  _timing.p_to_f = { duration_ms: Date.now() - _t_p_to_f, skipped: !!(p_to_f.detail && p_to_f.detail.skipped) };

  // Rebuild code-trace index for reverse sweeps (skip if past deadline)
  const _t_code_trace_rebuild = Date.now();
  if (!effectiveFastMode() && !pastDeadline()) rebuildCodeTraceIndex();
  _timing.code_trace_rebuild = { duration_ms: Date.now() - _t_code_trace_rebuild, skipped: pastDeadline() };

  // Reverse traceability discovery (do NOT add to automatable total)
  const _t_c_to_r = Date.now();
  const c_to_r = checkLayerSkip('c_to_r') || (pastDeadline() ? deadlineSkip() : sweepCtoR());
  _timing.c_to_r = { duration_ms: Date.now() - _t_c_to_r, skipped: !!(c_to_r.detail && c_to_r.detail.skipped) };

  const _t_t_to_r = Date.now();
  const t_to_r = checkLayerSkip('t_to_r') || (pastDeadline() ? deadlineSkip() : sweepTtoR());
  _timing.t_to_r = { duration_ms: Date.now() - _t_t_to_r, skipped: !!(t_to_r.detail && t_to_r.detail.skipped) };

  const _t_d_to_r = Date.now();
  const d_to_r = checkLayerSkip('d_to_r') || (pastDeadline() ? deadlineSkip() : sweepDtoR());
  _timing.d_to_r = { duration_ms: Date.now() - _t_d_to_r, skipped: !!(d_to_r.detail && d_to_r.detail.skipped) };

  const total =
    (r_to_f.residual >= 0 ? r_to_f.residual : 0) +
    (f_to_t.residual >= 0 ? f_to_t.residual : 0) +
    (c_to_f.residual >= 0 ? c_to_f.residual : 0) +
    (t_to_c.residual >= 0 ? t_to_c.residual : 0) +
    (f_to_c.residual >= 0 ? f_to_c.residual : 0) +
    (r_to_d.residual >= 0 ? r_to_d.residual : 0) +
    (d_to_c.residual >= 0 ? d_to_c.residual : 0) +
    (p_to_f.residual >= 0 ? p_to_f.residual : 0);

  const reverse_discovery_total =
    (c_to_r.residual >= 0 ? c_to_r.residual : 0) +
    (t_to_r.residual >= 0 ? t_to_r.residual : 0) +
    (d_to_r.residual >= 0 ? d_to_r.residual : 0);

  // Assemble deduplicated reverse candidates
  const assembled_candidates = assembleReverseCandidates(c_to_r, t_to_r, d_to_r);

  // Layer alignment sweeps (cross-layer gate checks) — skip in fast mode
  const skipLayer = { residual: -1, detail: { skipped: true, reason: 'fast mode' } };

  const _t_l1_to_l3 = Date.now();
  const l1_to_l3 = checkLayerSkip('l1_to_l3') || (pastDeadline() ? skipLayer : sweepL1toL3());
  _timing.l1_to_l3 = { duration_ms: Date.now() - _t_l1_to_l3, skipped: !!(l1_to_l3.detail && l1_to_l3.detail.skipped) };

  const _t_l3_to_tc = Date.now();
  const l3_to_tc = checkLayerSkip('l3_to_tc') || (pastDeadline() ? skipLayer : sweepL3toTC());
  _timing.l3_to_tc = { duration_ms: Date.now() - _t_l3_to_tc, skipped: !!(l3_to_tc.detail && l3_to_tc.detail.skipped) };

  // Per-model gate maturity (informational — not added to layer_total)
  const _t_per_model_gates = Date.now();
  const per_model_gates = (effectiveFastMode() || pastDeadline()) ? skipLayer : sweepPerModelGates();
  _timing.per_model_gates = { duration_ms: Date.now() - _t_per_model_gates, skipped: !!(per_model_gates.detail && per_model_gates.detail.skipped) };

  // PERF-02: Clear aggregate cache after per_model_gates writes new files
  if (!effectiveFastMode()) _aggregateCache = null;

  // Enrich gate files with semantic scores (SEM-03, SEM-04)
  if (!effectiveFastMode() && !reportOnly) {
    process.stderr.write(TAG + ' Enriching gates with semantic scores\n');
    const semResult = spawnTool('bin/compute-semantic-scores.cjs', ['--json']);
    if (!semResult.ok) {
      process.stderr.write(TAG + ' WARNING: semantic scoring failed; gates lack semantic_score (continue)\n');
    }
  }

  const layer_total =
    (l1_to_l3.residual >= 0 ? l1_to_l3.residual : 0) +
    (l3_to_tc.residual >= 0 ? l3_to_tc.residual : 0);

  // Git heatmap sweep (informational — not added to forward total)
  const _t_git_heatmap = Date.now();
  const git_heatmap = sweepGitHeatmap(_activeAdapter);
  _timing.git_heatmap = { duration_ms: Date.now() - _t_git_heatmap, skipped: skipHeatmap };
  const heatmap_total = git_heatmap.residual >= 0 ? git_heatmap.residual : 0;

  // Git history evidence sweep (informational — not added to forward total)
  const _t_git_history = Date.now();
  const git_history = sweepGitHistoryEvidence();
  _timing.git_history = { duration_ms: Date.now() - _t_git_history, skipped: false };

  // Formal model lint sweep (informational — not added to forward total)
  const _t_formal_lint = Date.now();
  const formal_lint = sweepFormalLint();
  _timing.formal_lint = { duration_ms: Date.now() - _t_formal_lint, skipped: false };

  // Hazard model sweep (informational — not added to forward total)
  const _t_hazard_model = Date.now();
  const hazard_model = sweepHazardModel();
  _timing.hazard_model = { duration_ms: Date.now() - _t_hazard_model, skipped: false };

  // Hypothesis measurement sweep (informational — not added to forward total)
  const _t_h_to_m = Date.now();
  const h_to_m = sweepHtoM();
  _timing.h_to_m = { duration_ms: Date.now() - _t_h_to_m, skipped: false };

  // B->F sweep: Bug-to-Formal model gap analysis (automatable — dispatches remediation)
  const _t_b_to_f = Date.now();
  const b_to_f = sweepBtoF(t_to_c);
  _timing.b_to_f = { duration_ms: Date.now() - _t_b_to_f, skipped: false };

  // Requirement quality sweep: non-invariants + low-value (automatable — archive/rephrase)
  const _t_req_quality = Date.now();
  const req_quality = checkLayerSkip('req_quality') || sweepReqQuality();
  _timing.req_quality = { duration_ms: Date.now() - _t_req_quality, skipped: !!(req_quality.detail && req_quality.detail.skipped) };

  // Diagnostic health sweeps (informational — not added to automatable total)
  const _t_config_health = Date.now();
  const config_health = checkLayerSkip('config_health') || sweepConfigHealth();
  _timing.config_health = { duration_ms: Date.now() - _t_config_health, skipped: !!(config_health.detail && config_health.detail.skipped) };

  const _t_security = Date.now();
  const security = checkLayerSkip('security') || sweepSecurity();
  _timing.security = { duration_ms: Date.now() - _t_security, skipped: !!(security.detail && security.detail.skipped) };

  const _t_require_graph = Date.now();
  const require_graph = checkLayerSkip('require_graph') || sweepRequireGraph();
  _timing.require_graph = { duration_ms: Date.now() - _t_require_graph, skipped: !!(require_graph.detail && require_graph.detail.skipped) };

  const _t_sast = Date.now();
  const sast = checkLayerSkip('sast') || sweepSast();
  _timing.sast = { duration_ms: Date.now() - _t_sast, skipped: !!(sast.detail && sast.detail.skipped) };

  const _t_model_check = Date.now();
  const model_check = checkLayerSkip('model_check') || sweepModelCheck();
  _timing.model_check = { duration_ms: Date.now() - _t_model_check, skipped: !!(model_check.detail && model_check.detail.skipped) };

  const _t_petri_check = Date.now();
  const petri_check = checkLayerSkip('petri_check') || sweepPetriReachability();
  _timing.petri_check = { duration_ms: Date.now() - _t_petri_check, skipped: !!(petri_check.detail && petri_check.detail.skipped) };

  const _t_fsm_check = Date.now();
  // Heavyweight full-TLC pass (dozens of transpiled models) — gate behind fast mode /
  // deadline like per_model_gates, so --fast and report-only runs (benchmark, smoke)
  // skip it. It's a real-repo diagnostic, not tied to a --fast benchmark challenge.
  const fsm_check = checkLayerSkip('fsm_check') || ((effectiveFastMode() || pastDeadline()) ? skipLayer : sweepFsmModels());
  _timing.fsm_check = { duration_ms: Date.now() - _t_fsm_check, skipped: !!(fsm_check.detail && fsm_check.detail.skipped) };

  const _t_trace_health = Date.now();
  const trace_health = checkLayerSkip('trace_health') || sweepTraceHealth();
  _timing.trace_health = { duration_ms: Date.now() - _t_trace_health, skipped: !!(trace_health.detail && trace_health.detail.skipped) };

  const _t_asset_stale = Date.now();
  const asset_stale = checkLayerSkip('asset_stale') || sweepAssetStaleness();
  _timing.asset_stale = { duration_ms: Date.now() - _t_asset_stale, skipped: !!(asset_stale.detail && asset_stale.detail.skipped) };

  const _t_arch_constraints = Date.now();
  const arch_constraints = checkLayerSkip('arch_constraints') || sweepArchConstraints();
  _timing.arch_constraints = { duration_ms: Date.now() - _t_arch_constraints, skipped: !!(arch_constraints.detail && arch_constraints.detail.skipped) };

  const _t_debt_health = Date.now();
  const debt_health = checkLayerSkip('debt_health') || sweepDebtHealth();
  _timing.debt_health = { duration_ms: Date.now() - _t_debt_health, skipped: !!(debt_health.detail && debt_health.detail.skipped) };

  const _t_memory_health = Date.now();
  const memory_health = checkLayerSkip('memory_health') || sweepMemoryHealth();
  _timing.memory_health = { duration_ms: Date.now() - _t_memory_health, skipped: !!(memory_health.detail && memory_health.detail.skipped) };

  const _t_model_stale = Date.now();
  const model_stale = checkLayerSkip('model_stale') || sweepModelStaleness();
  _timing.model_stale = { duration_ms: Date.now() - _t_model_stale, skipped: !!(model_stale.detail && model_stale.detail.skipped) };

  // CONV-02: Split residual into three distinct buckets
  const automatable =
    (r_to_f.residual >= 0 ? r_to_f.residual : 0) +
    (f_to_t.residual >= 0 ? f_to_t.residual : 0) +
    (c_to_f.residual >= 0 ? c_to_f.residual : 0) +
    (t_to_c.residual >= 0 ? t_to_c.residual : 0) +
    (f_to_c.residual >= 0 ? f_to_c.residual : 0) +
    (r_to_d.residual >= 0 ? r_to_d.residual : 0) +
    (l1_to_l3.residual >= 0 ? l1_to_l3.residual : 0) +
    (l3_to_tc.residual >= 0 ? l3_to_tc.residual : 0) +
    (b_to_f.residual >= 0 ? b_to_f.residual : 0) +
    (req_quality.detail && req_quality.detail.non_invariant ? req_quality.detail.non_invariant : 0);

  const manual =
    (d_to_c.residual >= 0 ? d_to_c.residual : 0) +
    (c_to_r.residual >= 0 ? c_to_r.residual : 0) +
    (t_to_r.residual >= 0 ? t_to_r.residual : 0) +
    (d_to_r.residual >= 0 ? d_to_r.residual : 0);

  const informational =
    (git_heatmap.residual >= 0 ? git_heatmap.residual : 0) +
    (git_history.residual >= 0 ? git_history.residual : 0) +
    (formal_lint.residual >= 0 ? formal_lint.residual : 0) +
    (hazard_model.residual >= 0 ? hazard_model.residual : 0) +
    (h_to_m.residual >= 0 ? h_to_m.residual : 0) +
    (per_model_gates.residual >= 0 ? per_model_gates.residual : 0) +
    (p_to_f.residual >= 0 ? p_to_f.residual : 0) +
    (config_health.residual >= 0 ? config_health.residual : 0) +
    (security.residual >= 0 ? security.residual : 0) +
    (require_graph.residual >= 0 ? require_graph.residual : 0) +
    (sast.residual >= 0 ? sast.residual : 0) +
    (model_check.residual >= 0 ? model_check.residual : 0) +
    (petri_check.residual >= 0 ? petri_check.residual : 0) +
    (fsm_check.residual >= 0 ? fsm_check.residual : 0) +
    (trace_health.residual >= 0 ? trace_health.residual : 0) +
    (asset_stale.residual >= 0 ? asset_stale.residual : 0) +
    (arch_constraints.residual >= 0 ? arch_constraints.residual : 0) +
    (debt_health.residual >= 0 ? debt_health.residual : 0) +
    (memory_health.residual >= 0 ? memory_health.residual : 0) +
    (model_stale.residual >= 0 ? model_stale.residual : 0) +
    (req_quality.detail && req_quality.detail.low_value ? req_quality.detail.low_value : 0);

  return {
    r_to_f,
    f_to_t,
    c_to_f,
    t_to_c,
    f_to_c,
    r_to_d,
    d_to_c,
    p_to_f,
    c_to_r,
    t_to_r,
    d_to_r,
    l1_to_l3,
    l3_to_tc,
    per_model_gates,
    git_heatmap,
    git_history,
    formal_lint,
    hazard_model,
    h_to_m,
    b_to_f,
    req_quality,
    config_health,
    security,
    require_graph,
    sast,
    model_check,
    petri_check,
    fsm_check,
    trace_health,
    asset_stale,
    arch_constraints,
    debt_health,
    memory_health,
    model_stale,
    assembled_candidates,
    total,
    automatable,
    manual,
    informational,
    layer_total,
    reverse_discovery_total,
    heatmap_total,
    focus: focusPhrase ? { phrase: focusPhrase, matched: focusSet ? focusSet.size : 0 } : null,
    timestamp: new Date().toISOString(),
    timing: _timing,
    total_diagnostic_ms: Date.now() - _diagStart,
  };

  return rv;
}

// ── Auto-close ───────────────────────────────────────────────────────────────

/**
 * Attempts to fix gaps found by the sweep.
 * Returns { actions_taken: [...], stubs_generated: N }
 * @param {Object} residual - residual object from computeResidual()
 * @param {Set<string>} [oscillatingSet] - layer keys detected as oscillating by CycleDetector
 * @param {Array<{wave: number, layers: string[], sequential?: boolean}>} [waveOrder] - wave objects from computeWaves; null/undefined = DEFAULT_WAVES
 */
function autoClose(residual, oscillatingSet, waveOrder) {
  const actions = [];

  // Repowise: load co-change coupling data for coupling-aware remediation (cached)
  let cochangeData = null;
  let getPartnersForFile = null;
  try {
    const cochangeMod = require('./repowise/cochange.cjs');
    if (!_repowiseCochangeCache) {
      _repowiseCochangeCache = cochangeMod.computeCoChange(ROOT, { minSharedCommits: 2, minCouplingDegree: 0.1 });
    }
    cochangeData = _repowiseCochangeCache;
    getPartnersForFile = cochangeMod.getPartnersForFile;
    if (cochangeData && cochangeData.pairs && cochangeData.pairs.length > 0) {
      process.stderr.write(TAG + ' Repowise: using cached ' + cochangeData.pairs.length + ' co-change pairs\n');
    }
  } catch (_e) { /* fail-open */ }

  // Read oscillation verdicts for layer gating (fail-open)
  let verdicts = {};
  try {
    const verdictsPath = path.join(ROOT, '.planning', 'formal', 'oscillation-verdicts.json');
    if (fs.existsSync(verdictsPath)) {
      const raw = JSON.parse(fs.readFileSync(verdictsPath, 'utf8'));
      verdicts = raw.layers || {};
    }
  } catch (_) { /* fail-open */ }

  function isLayerBlocked(layerKey) {
    const v = verdicts[layerKey];
    if (v && v.blocked === true) return true;
    // Also block layers detected as oscillating by CycleDetector (CONV-01)
    if (oscillatingSet && oscillatingSet.has(layerKey)) return true;
    return false;
  }

  // ── LAYER_HANDLERS dispatch map ──────────────────────────────────────────
  // Each handler receives (residual, actions, isLayerBlocked) and appends to actions.
  // Logic is moved verbatim from the original sequential if-chain.

  const LAYER_HANDLERS = {
    f_to_t: (res, acts, blocked) => {
      // F->T gaps: generate test stubs
      if (blocked('f_to_t')) {
        acts.push('OSCILLATION BLOCKED: f_to_t \u2014 automated remediation suspended, human review required');
        return;
      }
      if (res.f_to_t.residual > 0) {
        const result = spawnTool('bin/formal-test-sync.cjs', []);
        if (result.ok) {
          acts.push(
            'Generated test stubs for ' +
              res.f_to_t.residual +
              ' uncovered invariants'
          );
        } else {
          acts.push(
            'Could not auto-generate test stubs for ' +
              res.f_to_t.residual +
              ' invariants (formal-test-sync.cjs failed)'
          );
        }
      }
      // F->T stubs upgrade: implement TODO stubs with real test logic
      if (!blocked('f_to_t') && res.f_to_t.residual > 0) {
        const implPath = path.join(ROOT, '.planning/formal/generated-stubs/_implement-stubs.cjs');
        if (fs.existsSync(implPath)) {
          const implResult = spawnSync(process.execPath, [implPath], {
            encoding: 'utf8', cwd: ROOT, timeout: 60000, stdio: 'pipe'
          });
          if (implResult.status === 0) {
            acts.push('Upgraded TODO stubs: ' + (implResult.stdout || '').trim());
          }
        }
      }
    },

    c_to_f: (res, acts, blocked) => {
      // C->F mismatches: log but do not auto-fix
      if (res.c_to_f.residual > 0) {
        acts.push(
          'Cannot auto-fix ' +
            res.c_to_f.residual +
            ' constant mismatch(es) \u2014 manual review required'
        );
      }
    },

    t_to_c: (res, acts, blocked) => {
      // T->C failures: log but do not auto-fix
      if (res.t_to_c.residual > 0) {
        acts.push(
          res.t_to_c.residual + ' test failure(s) \u2014 manual fix required'
        );
      }
    },

    r_to_f: (res, acts, blocked) => {
      if (res.r_to_f.residual > 0) {
        const triageDetail = res.r_to_f.detail.triage;
        if (triageDetail) {
          acts.push(
            triageDetail.high + ' HIGH + ' + triageDetail.medium +
              ' MEDIUM priority requirements lack formal coverage'
          );
        } else {
          acts.push(
            res.r_to_f.residual +
              ' requirement(s) lack formal model coverage \u2014 manual modeling required'
          );
        }
        // Repowise cochange: flag coupled files that should also be modeled together
        if (cochangeData && getPartnersForFile) {
          try {
            const uncovered = res.r_to_f.detail.uncovered_requirements || [];
            const coupledFiles = new Set();
            for (const req of uncovered.slice(0, 10)) {
              const sourceFiles = req.source_files || req.files || [];
              for (const sf of sourceFiles) {
                const partners = getPartnersForFile(sf, cochangeData);
                if (partners && partners.length > 0) {
                  for (const p of partners.slice(0, 3)) {
                    if (p.coupling_degree >= 0.3) coupledFiles.add(p.partner);
                  }
                }
              }
            }
            if (coupledFiles.size > 0) {
              acts.push('Repowise cochange: ' + coupledFiles.size + ' coupled files should be modeled alongside uncovered requirements');
            }
          } catch (_e) { /* fail-open */ }
        }
      }
    },

    f_to_c: (res, acts, blocked) => {
      // F->C failures: log but do not auto-fix
      if (res.f_to_c.residual > 0) {
        acts.push(
          res.f_to_c.residual +
            ' formal verification failure(s) \u2014 manual fix required'
        );
      }
    },

    r_to_d: (res, acts, blocked) => {
      // R->D gaps: log but do not auto-fix (manual review)
      if (res.r_to_d.residual > 0) {
        acts.push(
          res.r_to_d.residual +
            ' requirement(s) undocumented in developer docs \u2014 manual review required'
        );
      }
    },

    d_to_c: (res, acts, blocked) => {
      if (res.d_to_c.residual > 0) {
        const broken = res.d_to_c.detail && res.d_to_c.detail.broken_claims;
        if (broken && Array.isArray(broken)) {
          const fileNotFound = broken.filter(c => c.reason && c.reason.includes('file not found'));
          if (fileNotFound.length > 0) {
            let fixed = 0;
            for (const claim of fileNotFound) {
              const ref = claim.value || claim.reference || '';
              const base = ref.split('/').pop();
              if (!base || base.length < 3) continue;
              try {
                const result = spawnSync('find', [ROOT, '-name', base, '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*'], {
                  encoding: 'utf8', timeout: 5000
                });
                const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
                if (lines.length === 1) {
                  const resolved = path.relative(ROOT, lines[0]);
                  acts.push('D->C auto-fix: ' + ref + ' -> ' + resolved + ' (fuzzy path resolve)');
                  fixed++;
                }
              } catch (_e) { /* fail-open */ }
            }
            if (fixed > 0) {
              acts.push(fixed + '/' + fileNotFound.length + ' file-not-found claims resolvable (fuzzy match)');
            }
            const unresolved = fileNotFound.length - fixed;
            if (unresolved > 0) {
              acts.push(unresolved + ' stale structural claim(s) in docs — manual review required');
            }
          } else {
            acts.push(res.d_to_c.residual + ' stale structural claim(s) in docs — manual review required');
          }
        } else {
          acts.push(res.d_to_c.residual + ' stale structural claim(s) in docs — manual review required');
        }
      }
    },

    p_to_f: (res, acts, blocked) => {
      // P->F divergence: dispatch parameter updates or flag investigations
      if (blocked('p_to_f')) {
        acts.push('OSCILLATION BLOCKED: p_to_f \u2014 automated remediation suspended, human review required');
      } else if (res.p_to_f && res.p_to_f.residual > 0) {
        const result = autoClosePtoF(res.p_to_f, {
          spawnTool: spawnTool,
        });
        for (const action of result.actions_taken) {
          acts.push(action);
        }
      }
    },

    per_model_gates: (res, acts, blocked) => {
      // Per-model gate maturity: create conditions for promotion (GATE-02)
      // Produces observable signals -- never writes gate_maturity directly.
      if (blocked('per_model_gates')) {
        acts.push('OSCILLATION BLOCKED: per_model_gates \u2014 automated remediation suspended, human review required');
      } else if (res.per_model_gates && res.per_model_gates.residual > 0) {
        try {
          const registryPath = path.join(ROOT, '.planning', 'formal', 'model-registry.json');
          const manifestPath = path.join(ROOT, '.planning', 'formal', 'layer-manifest.json');
          const registryFile = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
          const models = registryFile.models || registryFile;
          const modelKeys = Object.keys(models).filter(k => k.startsWith('.'));

          // Import inferSourceLayer from promote-gate-maturity.cjs
          const { inferSourceLayer: inferLayer } = require('./promote-gate-maturity.cjs');

          // Signal 1: fill missing source_layer via inferSourceLayer heuristic
          let layersFilled = 0;
          for (const modelPath of modelKeys) {
            const model = models[modelPath];
            if (!model.source_layer) {
              const inferred = inferLayer(modelPath);
              if (inferred) {
                model.source_layer = inferred;
                model.last_updated = new Date().toISOString();
                layersFilled++;
              }
            }
          }

          // Signal 2: scan model files for semantic declarations
          const DECL_PATTERNS = {
            '.als': /\b(sig|pred|fact|assert|fun)\b/,
            '.tla': /\b(VARIABLE|CONSTANT|Init|Next|Spec)\b/,
            '.pm':  /\b(module|rewards|endmodule)\b/,
            '.props': /\b(P\s*=|filter|Pmax|Pmin)\b/,
          };

          let manifest = null;
          if (fs.existsSync(manifestPath)) {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          }

          let declsDetected = 0;
          for (const modelPath of modelKeys) {
            const ext = path.extname(modelPath);
            const pattern = DECL_PATTERNS[ext];
            if (!pattern) continue;

            const fullPath = path.join(ROOT, modelPath);
            if (!fs.existsSync(fullPath)) continue;

            try {
              const content = fs.readFileSync(fullPath, 'utf8');
              if (pattern.test(content)) {
                // Update layer-manifest if model is currently ungrounded
                if (manifest) {
                  for (const layer of Object.values(manifest.layers || {})) {
                    for (const entry of (Array.isArray(layer) ? layer : [])) {
                      if (entry.path === modelPath && entry.grounding_status === 'ungrounded') {
                        entry.grounding_status = 'has_semantic_declarations';
                        declsDetected++;
                      }
                    }
                  }
                }
              }
            } catch (e) {
              // fail-open: skip unreadable files
            }
          }

          // Write back only if changes were made
          if (layersFilled > 0) {
            fs.writeFileSync(registryPath, JSON.stringify(registryFile, null, 2) + '\n');
            acts.push('Filled source_layer for ' + layersFilled + ' model(s) via inferSourceLayer');
          }
          if (declsDetected > 0 && manifest) {
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
            acts.push('Detected semantic declarations in ' + declsDetected + ' model(s) \u2014 updated layer-manifest');
          }
          if (layersFilled === 0 && declsDetected === 0) {
            acts.push(res.per_model_gates.residual + ' model(s) at maturity 0 \u2014 no auto-fixable signals found');
          }
        } catch (e) {
          // fail-open: per-model gate remediation is best-effort
          acts.push('Per-model gate remediation failed: ' + e.message);
        }
      }
    },

    // Diagnostic health layers (informational — no auto-remediation)
    config_health: () => {},
    security: () => {},
    trace_health: () => {},
    asset_stale: () => {},
    arch_constraints: () => {},
    debt_health: () => {},
    memory_health: () => {},
  };

  // ── Wave-aware dispatch ────────────────────────────────────────────────────
  // Default wave structure: single wave with original hardcoded sequence
  const DEFAULT_WAVES = [{ wave: 1, layers: ['f_to_t', 'c_to_f', 't_to_c', 'r_to_f', 'f_to_c', 'r_to_d', 'd_to_c', 'p_to_f', 'per_model_gates', 'req_quality', 'config_health', 'security', 'trace_health', 'asset_stale', 'arch_constraints', 'debt_health', 'memory_health'] }];

  const waves = waveOrder || DEFAULT_WAVES;
  for (const w of waves) {
    // Process layers within each wave in order (priority-weighted by computeWaves)
    for (const layerKey of w.layers) {
      const handler = LAYER_HANDLERS[layerKey];
      if (handler) {
        handler(residual, actions, isLayerBlocked);
      }
    }
  }

  // ── Cross-cutting concerns (not layer-specific) ────────────────────────────

  // Evidence readiness check — inform whether evidence supports promotion
  try {
    const evidenceDir = path.join(ROOT, '.planning', 'formal', 'evidence');
    const evidenceFiles = [
      'instrumentation-map.json', 'state-candidates.json',
      'failure-taxonomy.json', 'trace-corpus-stats.json', 'proposed-metrics.json'
    ];
    let ready = 0;
    for (const ef of evidenceFiles) {
      const efPath = path.join(evidenceDir, ef);
      if (fs.existsSync(efPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(efPath, 'utf8'));
          // Check for non-empty primary array
          const arrays = Object.values(data).filter(v => Array.isArray(v));
          if (arrays.some(a => a.length > 0)) ready++;
        } catch (e) { /* fail-open */ }
      }
    }
    if (ready < 3) {
      actions.push(
        'Evidence readiness: ' + ready + '/5 files populated — ' +
        'gate promotion blocked until >= 3 evidence files have content. ' +
        'Run `node bin/refresh-evidence.cjs` to populate from traces.'
      );
    } else {
      actions.push('Evidence readiness: ' + ready + '/5 — sufficient for gate promotion');
    }
  } catch (e) {
    // fail-open: evidence check is informational
  }

  return {
    actions_taken: actions,
    stubs_generated: residual.f_to_t.residual > 0 ? 1 : 0,
  };
}

// ── Health indicator ─────────────────────────────────────────────────────────

/**
 * Returns health string for a residual value.
 */
function healthIndicator(residual) {
  if (residual === -1) return '?  UNKNOWN';
  if (residual === 0) return 'OK GREEN';
  if (residual >= 1 && residual <= 3) return '!! YELLOW';
  return 'XX RED';
}

// ── Report formatting ────────────────────────────────────────────────────────

/**
 * Compute triage breakdown (FP, archived, actionable counts) for a category's items.
 * Reads solve-classifications.json and archived-solve-items.json.
 * catKey: 'dtoc', 'ctor', 'ttor', 'dtor'
 * items: array of item objects with structure matching solve-tui.cjs
 */
function computeTriageBreakdown(catKey, items) {
  const classPath = path.join(ROOT, '.planning', 'formal', 'solve-classifications.json');
  const archivePath = path.join(ROOT, '.planning', 'formal', 'archived-solve-items.json');

  let classifications = {};
  let archiveEntries = [];

  try {
    const classData = JSON.parse(fs.readFileSync(classPath, 'utf8'));
    classifications = classData.classifications?.[catKey] || {};
  } catch (_) {
    // graceful fallback
  }

  try {
    const archiveData = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    archiveEntries = archiveData.entries || [];
  } catch (_) {
    // graceful fallback
  }

  let fp_count = 0;
  let archived_count = 0;
  let actionable_count = 0;

  for (const item of items) {
    // Compute key using same logic as solve-tui.cjs itemKey()
    let key = '';
    if (catKey === 'dtoc') {
      key = `${item.doc_file}:${item.value}`;
    } else if (catKey === 'ctor') {
      key = item.file || item;
    } else if (catKey === 'ttor') {
      key = (typeof item === 'string' ? item : item.file) || item;
    } else if (catKey === 'dtor') {
      key = `${item.doc_file}:${item.line}`;
    } else {
      continue;
    }

    // Check if FP-classified
    if (classifications[key] === 'fp') {
      fp_count++;
    }
    // Check if archived
    else if (archiveEntries.some(e => e.key === key)) {
      archived_count++;
    }
    // Otherwise actionable
    else {
      actionable_count++;
    }
  }

  return { fp_count, archived_count, actionable_count, total: items.length };
}

/**
 * Formats human-readable report.
 */
function formatReport(iterations, finalResidual, converged) {
  const lines = [];

  lines.push('[nf-solve] Consistency Solver Report');
  lines.push('');
  lines.push(
    'Iterations: ' +
      iterations.length +
      '/' +
      maxIterations +
      ' (converged: ' +
      (converged ? 'yes' : 'no') +
      ')'
  );
  lines.push('');

  // Real Impact Summary (leads the report)
  const realImpact = computeRealImpact();
  lines.push('Real Impact Summary:');
  lines.push('  Bugs Fixed: ' + realImpact.bugs_fixed);
  lines.push('  Tests Added: ' + realImpact.tests_added);
  lines.push('  Docs Fixed: ' + realImpact.docs_fixed);
  lines.push('  Dead Code Removed: ' + realImpact.dead_code_removed);
  lines.push('');

  // Unified residual vector table
  lines.push('Layer Transition             Residual  Health');
  lines.push('─────────────────────────────────────────────');

  // Helper to render a single row
  function renderRow(label, residual) {
    const res = residual >= 0 ? residual : '?';
    const health = healthIndicator(residual);
    return label.padEnd(28) + String(res).padStart(4) + '    ' + health;
  }

  // Forward layer transitions
  const forwardRows = [
    { label: 'R -> F (Req->Formal)', residual: finalResidual.r_to_f.residual },
    { label: 'F -> T (Formal->Test)', residual: finalResidual.f_to_t.residual },
    { label: 'C -> F (Code->Formal)', residual: finalResidual.c_to_f.residual },
    { label: 'T -> C (Test->Code)', residual: finalResidual.t_to_c.residual },
    { label: 'F -> C (Formal->Code)', residual: finalResidual.f_to_c.residual },
    { label: 'R -> D (Req->Docs)', residual: finalResidual.r_to_d.residual },
    { label: 'D -> C (Docs->Code)', residual: finalResidual.d_to_c.residual, catKey: 'dtoc', detail: finalResidual.d_to_c?.detail?.broken_claims },
    { label: 'P -> F (Prod->Formal)', residual: finalResidual.p_to_f ? finalResidual.p_to_f.residual : -1 },
  ];

  for (const row of forwardRows) {
    lines.push(renderRow(row.label, row.residual));

    // Add triage breakdown for D->C row
    if (row.label === 'D -> C (Docs->Code)' && row.detail && !finalResidual.d_to_c?.detail?.skipped) {
      const items = row.detail || [];
      const triage = computeTriageBreakdown('dtoc', items);
      if (triage.total > 0) {
        lines.push('\x1b[2m  (' + triage.fp_count + ' FP, ' + triage.archived_count + ' archived, ' + triage.actionable_count + ' actionable)\x1b[0m');
      }
    }
  }
  lines.push('  Forward subtotal:      ' + finalResidual.total);

  // Reverse Discovery section (always rendered)
  lines.push('\u2500 Reverse Discovery (human-gated) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const reverseRows = [
    { label: 'C -> R (Code->Req)', residual: finalResidual.c_to_r ? finalResidual.c_to_r.residual : -1, catKey: 'ctor', detail: finalResidual.c_to_r?.detail?.untraced_modules },
    { label: 'T -> R (Test->Req)', residual: finalResidual.t_to_r ? finalResidual.t_to_r.residual : -1, catKey: 'ttor', detail: finalResidual.t_to_r?.detail?.orphan_tests },
    { label: 'D -> R (Docs->Req)', residual: finalResidual.d_to_r ? finalResidual.d_to_r.residual : -1, catKey: 'dtor', detail: finalResidual.d_to_r?.detail?.unbacked_claims },
  ];

  for (const row of reverseRows) {
    lines.push(renderRow(row.label, row.residual));

    // Add triage breakdown if detail is available and not skipped
    if (row.detail && !finalResidual[row.catKey === 'ctor' ? 'c_to_r' : row.catKey === 'ttor' ? 't_to_r' : 'd_to_r']?.detail?.skipped) {
      let items = row.detail || [];
      // Normalize items: for ttor, strings become {file: item}
      if (row.catKey === 'ttor') {
        items = items.map(item => typeof item === 'string' ? { file: item } : item);
      }
      const triage = computeTriageBreakdown(row.catKey, items);
      if (triage.total > 0) {
        lines.push('\x1b[2m  (' + triage.fp_count + ' FP, ' + triage.archived_count + ' archived, ' + triage.actionable_count + ' actionable)\x1b[0m');
      }
    }
  }

  const rdTotal = finalResidual.reverse_discovery_total || 0;
  lines.push('  Discovery subtotal:    ' + rdTotal);

  if (finalResidual.assembled_candidates && finalResidual.assembled_candidates.candidates &&
      finalResidual.assembled_candidates.candidates.length > 0) {
    const ac = finalResidual.assembled_candidates;
    lines.push('Candidates: ' + ac.candidates.length + ' (raw: ' + ac.total_raw +
      ', deduped: ' + ac.deduped + ', filtered: ' + ac.filtered +
      ', acknowledged: ' + ac.acknowledged + ')');
    if (ac.category_counts) {
      lines.push('  Category A (likely reqs): ' + (ac.category_counts.A || 0) +
        ', Category B (likely docs): ' + (ac.category_counts.B || 0) +
        ', Category C (ambiguous): ' + (ac.category_counts.C || 0));
    }
  }

  // Layer Alignment section (always rendered)
  lines.push('\u2500 Layer Alignment (cross-layer gates) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const layerRows = [
    { label: 'L1 -> L3 (Wiring:Evidence)', residual: finalResidual.l1_to_l3 ? finalResidual.l1_to_l3.residual : -1 },
    { label: 'L3 -> TC (Wiring:Coverage)', residual: finalResidual.l3_to_tc ? finalResidual.l3_to_tc.residual : -1 },
  ];

  for (const row of layerRows) {
    lines.push(renderRow(row.label, row.residual));
  }

  const layerTotal = finalResidual.layer_total || 0;
  lines.push('  Alignment subtotal:    ' + layerTotal);

  // Requirement Hygiene section (automatable)
  lines.push('\u2500 Requirement Hygiene (FV-04) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const rqResidual = finalResidual.req_quality ? finalResidual.req_quality.residual : -1;
  lines.push(renderRow('RQ (Req Quality)', rqResidual));

  if (finalResidual.req_quality && finalResidual.req_quality.detail && !finalResidual.req_quality.detail.skipped) {
    const rqd = finalResidual.req_quality.detail;
    lines.push('  Non-invariant: ' + (rqd.non_invariant || 0) +
      ', Low-value: ' + (rqd.low_value || 0) +
      ', Borderline: ' + (rqd.borderline || 0) +
      ' (of ' + (rqd.total || 0) + ' total)');
    if (rqd.non_invariant_ids && rqd.non_invariant_ids.length > 0) {
      lines.push('\x1b[2m  Non-inv: ' + rqd.non_invariant_ids.join(', ') + '\x1b[0m');
    }
    if (rqd.low_value_ids && rqd.low_value_ids.length > 0) {
      lines.push('\x1b[2m  Low-val: ' + rqd.low_value_ids.join(', ') + '\x1b[0m');
    }
  }

  // Per-Model Gate Maturity section (informational)
  lines.push('\u2500 Per-Model Gates (maturity) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const pmgResidual = finalResidual.per_model_gates ? finalResidual.per_model_gates.residual : -1;
  lines.push(renderRow('PMG (Per-Model Gates)', pmgResidual));

  if (finalResidual.per_model_gates && finalResidual.per_model_gates.detail && !finalResidual.per_model_gates.detail.skipped) {
    const pmgd = finalResidual.per_model_gates.detail;
    lines.push('  Models: ' + (pmgd.total_models || 0) +
      ', Avg maturity: ' + (pmgd.avg_layer_maturity || 0) +
      ', Wiring:Evidence: ' + (pmgd.gate_a_pass || 0) +
      ', Wiring:Purpose: ' + (pmgd.gate_b_pass || 0) +
      ', Wiring:Coverage: ' + (pmgd.gate_c_pass || 0));
    if (pmgd.promotions > 0) {
      lines.push('  Promotions: ' + pmgd.promotions);
    }
  }

  // Git Heatmap section (informational)
  lines.push('\u2500 Git Heatmap (risk signals) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const hmResidual = finalResidual.git_heatmap ? finalResidual.git_heatmap.residual : -1;
  lines.push(renderRow('G -> H (Git->Heatmap)', hmResidual));
  const hmTotal = finalResidual.heatmap_total || 0;
  lines.push('  Heatmap subtotal:      ' + hmTotal);

  if (finalResidual.git_heatmap && finalResidual.git_heatmap.detail && !finalResidual.git_heatmap.detail.skipped) {
    const hd = finalResidual.git_heatmap.detail;
    lines.push('  Signals: ' + (hd.numerical_adjustments_count || 0) + ' adjustments, ' +
      (hd.bugfix_hotspots_count || 0) + ' bugfix hotspots, ' +
      (hd.churn_files_count || 0) + ' churn files');
  }

  // Formal Model Lint section (informational)
  lines.push('\u2500 Formal Model Lint (quality) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const flResidual = finalResidual.formal_lint ? finalResidual.formal_lint.residual : -1;
  lines.push(renderRow('FL (Formal Lint)', flResidual));

  if (finalResidual.formal_lint && finalResidual.formal_lint.detail && !finalResidual.formal_lint.detail.skipped) {
    const fld = finalResidual.formal_lint.detail;
    lines.push('  Violations: ' + (fld.total_violations || 0));
  }

  // Hazard Model section (informational — FMEA RPN scoring)
  lines.push('\u2500 Hazard Model (FMEA) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const hmrResidual = finalResidual.hazard_model ? finalResidual.hazard_model.residual : -1;
  lines.push(renderRow('HM (Hazard Model)', hmrResidual));

  if (finalResidual.hazard_model && finalResidual.hazard_model.detail && !finalResidual.hazard_model.detail.skipped) {
    const hmd = finalResidual.hazard_model.detail;
    lines.push('  Hazards: ' + (hmd.total_hazards || 0) +
      ' total, ' + (hmd.critical_count || 0) + ' critical, ' + (hmd.high_count || 0) + ' high');
  }

  // B->F section (Bug-to-Formal model gap analysis)
  lines.push('\u2500 B \u2192 F (Bug-to-Formal) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const btfResidual = finalResidual.b_to_f ? finalResidual.b_to_f.residual : -1;
  lines.push(renderRow('B \u2192 F', btfResidual));

  if (finalResidual.b_to_f && finalResidual.b_to_f.detail && !finalResidual.b_to_f.detail.skipped && !finalResidual.b_to_f.detail.error) {
    const btfd = finalResidual.b_to_f.detail;
    lines.push('  Classification: ' + (btfd.covered_reproduced || 0) + ' reproduced, ' +
      (btfd.covered_not_reproduced || 0) + ' not reproduced, ' +
      (btfd.not_covered || 0) + ' not covered');
    if (btfd.top_bugs && btfd.top_bugs.length > 0) {
      lines.push('  Top bugs: ' + btfd.top_bugs.join(', '));
    }
  }

  // Diagnostic Health section (informational)
  lines.push('\u2500 Diagnostic Health \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const diagRows = [
    { label: 'CH (Config Health)', key: 'config_health' },
    { label: 'SEC (Security)', key: 'security' },
    { label: 'TH (Trace Health)', key: 'trace_health' },
    { label: 'AS (Asset Stale)', key: 'asset_stale' },
    { label: 'AC (Arch Constraints)', key: 'arch_constraints' },
    { label: 'DH (Debt Health)', key: 'debt_health' },
    { label: 'MH (Memory Health)', key: 'memory_health' },
    { label: 'MS (Model Stale)', key: 'model_stale' },
    { label: 'MC (Model Check)', key: 'model_check' },
    { label: 'PC (Petri Check)', key: 'petri_check' },
    { label: 'FM (FSM Models)', key: 'fsm_check' },
  ];

  for (const row of diagRows) {
    const r = finalResidual[row.key] ? finalResidual[row.key].residual : -1;
    lines.push(renderRow(row.label, r));
  }

  // Cross-Layer Dashboard summary (aggregated view)
  try {
    const dashResult = spawnTool('bin/cross-layer-dashboard.cjs', ['--cached', '--json']);
    if (dashResult.ok && dashResult.stdout) {
      const dashData = JSON.parse(dashResult.stdout);
      lines.push('\u2500 Cross-Layer Dashboard \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
      const layers = dashData.layers || dashData.scores || [];
      for (const layer of (Array.isArray(layers) ? layers : [])) {
        const label = (layer.name || layer.layer || '').padEnd(20);
        const score = layer.score !== undefined ? (layer.score * 100).toFixed(0) + '%' : '?';
        const status = layer.status || layer.health || '';
        lines.push('  ' + label + score.padStart(6) + '  ' + status);
      }
    }
  } catch (e) {
    // fail-open: dashboard is informational
  }

  // PRISM Priority ranking (informational)
  try {
    const prismResult = spawnTool('bin/prism-priority.cjs', []);
    if (prismResult.ok && prismResult.stdout && prismResult.stdout.trim()) {
      lines.push('\u2500 PRISM Priority (failure probability) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
      const prismLines = prismResult.stdout.trim().split('\n');
      for (const pl of prismLines.slice(0, 10)) {
        lines.push('  ' + pl);
      }
    }
  } catch (e) {
    // fail-open: PRISM priority is informational
  }

  // Formalization Candidates (top files to formalize next)
  try {
    const fcResult = spawnTool('bin/formalization-candidates.cjs', ['--json', '--top=5']);
    if (fcResult.ok && fcResult.stdout && fcResult.stdout.trim()) {
      const fcData = JSON.parse(fcResult.stdout);
      if (fcData.candidates && fcData.candidates.length > 0) {
        lines.push('\u2500 Formalization Candidates \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
        for (const c of fcData.candidates.slice(0, 5)) {
          const fileLabel = c.file.length > 40 ? '...' + c.file.slice(-37) : c.file;
          lines.push('  ' + fileLabel.padEnd(42) + 'score: ' + c.score.toFixed(1));
        }
      }
    }
  } catch (e) {
    // fail-open: candidates are informational
  }

  // Model Complexity profile (informational)
  try {
    const profilePath = path.join(ROOT, '.planning', 'formal', 'model-complexity-profile.json');
    if (fs.existsSync(profilePath)) {
      const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      lines.push('\u2500 Model Complexity \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
      const s = profile.summary || {};
      lines.push('  Profiled: ' + (s.total_profiled || 0) + ' models');
      const byClass = s.by_runtime_class || {};
      lines.push('  Runtime: ' + (byClass.FAST || 0) + ' FAST, ' + (byClass.MODERATE || 0) + ' MOD, ' + (byClass.SLOW || 0) + ' SLOW, ' + (byClass.HEAVY || 0) + ' HEAVY');

      // Show split candidates
      const recs = profile.recommendations || {};
      if (recs.split_candidates && recs.split_candidates.length > 0) {
        lines.push('  Split candidates (' + recs.split_candidates.length + '):');
        for (const sc of recs.split_candidates.slice(0, 5)) {
          lines.push('    \u2197 ' + sc.check_id + ' \u2014 ' + sc.reason);
        }
      }

      // Show merge candidates
      if (recs.merge_candidates && recs.merge_candidates.length > 0) {
        lines.push('  Merge candidates (' + recs.merge_candidates.length + '):');
        for (const mc of recs.merge_candidates.slice(0, 5)) {
          lines.push('    \u2198 ' + mc.model_a + ' + ' + mc.model_b + ' \u2014 ' + mc.reason);
        }
      }
    }
  } catch (e) {
    // fail-open: complexity profile is informational
  }

  // Combined total across all sections (heatmap is informational — not in convergence loop's prevTotal)
  const hmTotal2 = finalResidual.heatmap_total || 0;
  const grandTotal = (finalResidual.total || 0) + rdTotal + layerTotal + hmTotal2;
  lines.push('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  lines.push('Grand total:             ' + grandTotal);
  lines.push('  Automatable:           ' + (finalResidual.automatable || 0) + '  (solver can fix)');
  lines.push('  Manual:                ' + (finalResidual.manual || 0) + '  (human review only)');
  lines.push('  Informational:         ' + (finalResidual.informational || 0) + '  (risk signals, no action needed)');
  lines.push('');

  // Oscillation status (from oscillation verdicts)
  try {
    const verdictsPath = path.join(ROOT, '.planning', 'formal', 'oscillation-verdicts.json');
    if (fs.existsSync(verdictsPath)) {
      const verdictData = JSON.parse(fs.readFileSync(verdictsPath, 'utf8'));
      const vLayers = verdictData.layers || {};
      const blockedLayers = Object.entries(vLayers).filter(([_, v]) => v.blocked);
      const oscillatingLayers = Object.entries(vLayers).filter(([_, v]) => v.trend === 'OSCILLATING');

      if (blockedLayers.length > 0 || oscillatingLayers.length > 0) {
        lines.push('## Oscillation Status');
        lines.push('');
        for (const [name, v] of blockedLayers) {
          lines.push('  BLOCKED: ' + name + ' (credits exhausted, trend: ' + v.trend + ')');
        }
        for (const [name, v] of oscillatingLayers) {
          if (!v.blocked) {
            lines.push('  WARNING: ' + name + ' oscillating (credits: ' + v.credits_remaining + ')');
          }
        }
        lines.push('');
      }
    }
  } catch (_) { /* fail-open */ }

  // Per-layer detail sections (only non-zero)
  if (finalResidual.r_to_f.residual > 0) {
    lines.push('## R -> F (Requirements -> Formal)');
    const detail = finalResidual.r_to_f.detail;
    if (detail.uncovered_requirements && detail.uncovered_requirements.length > 0) {
      lines.push('Uncovered requirements:');
      for (const req of detail.uncovered_requirements) {
        lines.push('  - ' + req);
      }
    }
    lines.push('');
  }

  if (finalResidual.f_to_t.residual > 0) {
    lines.push('## F -> T (Formal -> Tests)');
    const detail = finalResidual.f_to_t.detail;
    lines.push('Gap count: ' + detail.gap_count);
    if (detail.gaps && detail.gaps.length > 0) {
      lines.push('Requirements with gaps:');
      for (const gap of detail.gaps.slice(0, 10)) {
        lines.push('  - ' + gap);
      }
      if (detail.gaps.length > 10) {
        lines.push('  ... and ' + (detail.gaps.length - 10) + ' more');
      }
    }
    lines.push('');
  }

  if (finalResidual.c_to_f.residual > 0) {
    lines.push('## C -> F (Code Constants -> Formal)');
    const detail = finalResidual.c_to_f.detail;
    if (detail.mismatches && detail.mismatches.length > 0) {
      lines.push('Mismatches:');
      for (const m of detail.mismatches.slice(0, 5)) {
        lines.push(
          '  - ' +
            m.constant +
            ': formal=' +
            m.formal_value +
            ', config=' +
            m.config_value
        );
      }
      if (detail.mismatches.length > 5) {
        lines.push('  ... and ' + (detail.mismatches.length - 5) + ' more');
      }
    }
    lines.push('');
  }

  if (finalResidual.t_to_c.residual > 0) {
    lines.push('## T -> C (Tests -> Code)');
    const detail = finalResidual.t_to_c.detail;
    const parts = [];
    if (detail.failed > 0) parts.push('\u2717 ' + detail.failed + ' failed');
    if (detail.skipped > 0) parts.push('\u2298 ' + detail.skipped + ' skipped');
    if (detail.todo > 0) parts.push('\u25F7 ' + detail.todo + ' todo');
    lines.push('Tests: ' + parts.join(', ') + ' (of ' + detail.total_tests + ' total)');
    lines.push('');
  }

  // F->T->C coverage summary (shown regardless of T->C residual)
  if (finalResidual.t_to_c.detail && finalResidual.t_to_c.detail.formal_coverage &&
      finalResidual.t_to_c.detail.formal_coverage.available === true) {
    const fc = finalResidual.t_to_c.detail.formal_coverage;
    lines.push('  F->T->C coverage: ' + fc.summary.fully_covered + '/' +
      fc.total_properties + ' properties fully traced (' +
      fc.false_greens.length + ' false greens)');
    lines.push('');
  }

  if (finalResidual.f_to_c.residual > 0 || (finalResidual.f_to_c.detail && finalResidual.f_to_c.detail.inconclusive > 0)) {
    lines.push('## F -> C (Formal -> Code)');
    const detail = finalResidual.f_to_c.detail;
    const parts = [];
    if (detail.passed > 0) parts.push(detail.passed + ' pass');
    if (detail.failed > 0) parts.push(detail.failed + ' fail');
    if (detail.error_count > 0) parts.push(detail.error_count + ' error');
    if (detail.inconclusive > 0) parts.push(detail.inconclusive + ' inconclusive');
    lines.push('Checks: ' + parts.join(', ') + ' (of ' + detail.total_checks + ' total)');
    if (detail.failures && detail.failures.length > 0) {
      lines.push('');
      lines.push('Failures (requirement violations):');
      for (const fail of detail.failures) {
        const f = typeof fail === 'string' ? { check_id: fail, summary: '' } : fail;
        lines.push('  ✗ ' + f.check_id + (f.summary ? ' — ' + f.summary : ''));
        if (f.requirement_ids && f.requirement_ids.length > 0) {
          lines.push('    reqs: ' + f.requirement_ids.join(', '));
        }
      }
    }
    if (detail.errors && detail.errors.length > 0) {
      lines.push('');
      lines.push('Errors (infrastructure/tooling):');
      for (const err of detail.errors) {
        const e = typeof err === 'string' ? { check_id: err, summary: '' } : err;
        lines.push('  ⚙ ' + e.check_id + (e.summary ? ' — ' + e.summary : ''));
      }
    }
    if (detail.inconclusive_checks && detail.inconclusive_checks.length > 0) {
      lines.push('');
      lines.push('Inconclusive:');
      for (const w of detail.inconclusive_checks) {
        lines.push('  ⚠ ' + w.check_id + (w.summary ? ' — ' + w.summary : ''));
      }
    }
    if (detail.stale) {
      lines.push('');
      lines.push('Note: results may be stale (from cached check-results.ndjson)');
    }
    lines.push('');
  }

  if (finalResidual.r_to_d.residual > 0) {
    lines.push('## R -> D (Requirements -> Docs)');
    const detail = finalResidual.r_to_d.detail;
    if (detail.undocumented_requirements && detail.undocumented_requirements.length > 0) {
      lines.push('Undocumented requirements:');
      for (const req of detail.undocumented_requirements.slice(0, 20)) {
        lines.push('  - ' + req);
      }
      if (detail.undocumented_requirements.length > 20) {
        lines.push('  ... and ' + (detail.undocumented_requirements.length - 20) + ' more');
      }
    }
    lines.push('');
  }

  if (finalResidual.d_to_c.residual > 0) {
    lines.push('## D -> C (Docs -> Code)');
    const detail = finalResidual.d_to_c.detail;
    if (detail.broken_claims && detail.broken_claims.length > 0) {
      lines.push('Broken structural claims:');
      for (const claim of detail.broken_claims.slice(0, 20)) {
        lines.push('  - ' + claim.doc_file + ':' + claim.line + ' [' + claim.type + '] `' + claim.value + '` — ' + claim.reason);
      }
      if (detail.broken_claims.length > 20) {
        lines.push('  ... and ' + (detail.broken_claims.length - 20) + ' more');
      }
    }
    lines.push('');
  }

  if (finalResidual.p_to_f && finalResidual.p_to_f.residual > 0) {
    lines.push('## P -> F (Production -> Formal)');
    const detail = finalResidual.p_to_f.detail;
    if (detail.divergent_entries && detail.divergent_entries.length > 0) {
      lines.push('Divergent entries:');
      for (const ent of detail.divergent_entries.slice(0, 20)) {
        lines.push('  - ' + ent.id + ': ' + ent.formal_ref + ' (measured: ' + ent.measured + ', expected: ' + ent.expected + ')');
      }
      if (detail.divergent_entries.length > 20) {
        lines.push('  ... and ' + (detail.divergent_entries.length - 20) + ' more');
      }
    }
    if (detail.skipped_unlinked > 0) {
      lines.push('Skipped (waiting for formal link): ' + detail.skipped_unlinked);
    }
    lines.push('');
  }

  // Reverse traceability detail
  if (finalResidual.c_to_r && finalResidual.c_to_r.residual > 0) {
    lines.push('## C -> R (Code -> Requirements) [reverse discovery]');
    const detail = finalResidual.c_to_r.detail;
    if (detail.untraced_modules && detail.untraced_modules.length > 0) {
      lines.push('Untraced modules (' + detail.untraced_modules.length + ' of ' + detail.total_modules + '):');
      for (const mod of detail.untraced_modules.slice(0, 20)) {
        const deadNote = (mod.dead_code_flag === true) ? ' (0 callers — likely dead code)' :
                         (typeof mod.caller_count === 'number') ? ' (' + mod.caller_count + ' callers)' : '';
        lines.push('  - ' + mod.file + deadNote);
      }
      if (detail.untraced_modules.length > 20) {
        lines.push('  ... and ' + (detail.untraced_modules.length - 20) + ' more');
      }
    }
    lines.push('');
  }

  if (finalResidual.t_to_r && finalResidual.t_to_r.residual > 0) {
    lines.push('## T -> R (Tests -> Requirements) [reverse discovery]');
    const detail = finalResidual.t_to_r.detail;
    if (detail.orphan_tests && detail.orphan_tests.length > 0) {
      lines.push('Orphan tests (' + detail.orphan_tests.length + ' of ' + detail.total_tests + '):');
      for (const t of detail.orphan_tests.slice(0, 20)) {
        const testFile = typeof t === 'string' ? t : (t.file || '');
        const deadNote = (t.dead_code_flag === true) ? ' (0 callers — likely dead code)' :
                         (typeof t.caller_count === 'number') ? ' (' + t.caller_count + ' callers)' : '';
        lines.push('  - ' + testFile + deadNote);
      }
      if (detail.orphan_tests.length > 20) {
        lines.push('  ... and ' + (detail.orphan_tests.length - 20) + ' more');
      }
    }
    lines.push('');
  }

  if (finalResidual.d_to_r && finalResidual.d_to_r.residual > 0) {
    lines.push('## D -> R (Docs -> Requirements) [reverse discovery]');
    const detail = finalResidual.d_to_r.detail;
    if (detail.unbacked_claims && detail.unbacked_claims.length > 0) {
      lines.push('Unbacked doc claims (' + detail.unbacked_claims.length + ' of ' + detail.total_claims + '):');
      for (const c of detail.unbacked_claims.slice(0, 20)) {
        lines.push('  - ' + c.doc_file + ':' + c.line + ' — ' + c.claim_text);
      }
      if (detail.unbacked_claims.length > 20) {
        lines.push('  ... and ' + (detail.unbacked_claims.length - 20) + ' more');
      }
    }
    lines.push('');
  }

  if (finalResidual.git_heatmap && finalResidual.git_heatmap.residual > 0) {
    lines.push('## G -> H (Git Heatmap) [risk signals]');
    const detail = finalResidual.git_heatmap.detail;
    if (detail.uncovered_hot_zones && detail.uncovered_hot_zones.length > 0) {
      lines.push('Uncovered hot zones (' + detail.total_hot_zones + ' total):');
      for (const hz of detail.uncovered_hot_zones.slice(0, 10)) {
        lines.push('  - ' + hz.file + ' (priority: ' + hz.priority + ', signals: ' + (hz.signals || []).join(', ') + ')');
      }
      if (detail.total_hot_zones > 10) {
        lines.push('  ... and ' + (detail.total_hot_zones - 10) + ' more');
      }
    }
    lines.push('');
  }

  if (finalResidual.git_history && finalResidual.git_history.residual > 0) {
    lines.push('## GH (Git History Evidence) [TLA+ drift]');
    const detail = finalResidual.git_history.detail;
    if (detail.top_drift_candidates && detail.top_drift_candidates.length > 0) {
      lines.push('TLA+ drift candidates (' + detail.tla_drift_count + ' total):');
      for (const dc of detail.top_drift_candidates.slice(0, 10)) {
        lines.push('  - ' + dc.file + ' (' + dc.recent_feat_or_fix + ' feat/fix) -> ' + dc.tla_spec);
      }
      if (detail.tla_drift_count > 10) {
        lines.push('  ... and ' + (detail.tla_drift_count - 10) + ' more');
      }
    }
    lines.push('');
  }

  if (finalResidual.formal_lint && finalResidual.formal_lint.residual > 0) {
    lines.push('## FL (Formal Model Lint) [quality]');
    const detail = finalResidual.formal_lint.detail;
    if (detail.violations && detail.violations.length > 0) {
      lines.push('Lint violations (' + detail.total_violations + ' total):');
      for (const v of detail.violations.slice(0, 10)) {
        lines.push('  - ' + (v.model || '?') + ' [' + (v.rule || '?') + ']: ' + (v.message || ''));
      }
      if (detail.total_violations > 10) {
        lines.push('  ... and ' + (detail.total_violations - 10) + ' more');
      }
    }
    lines.push('');
  }

  if (finalResidual.hazard_model && finalResidual.hazard_model.residual > 0) {
    lines.push('## HM (Hazard Model) [FMEA]');
    const detail = finalResidual.hazard_model.detail;
    lines.push('Critical+High hazards: ' + (detail.critical_count || 0) + ' critical, ' + (detail.high_count || 0) + ' high');
    if (detail.top_hazards && detail.top_hazards.length > 0) {
      lines.push('Top hazards by RPN:');
      for (const h of detail.top_hazards.slice(0, 5)) {
        lines.push('  - ' + (h.from || '?') + ' -> ' + (h.event || '?') + ' (RPN: ' + (h.rpn || 0) + ')');
      }
    }
    lines.push('');
  }

  if (finalResidual.b_to_f && finalResidual.b_to_f.residual > 0) {
    lines.push('## B \u2192 F (Bug-to-Formal)');
    const btfDetail = finalResidual.b_to_f.detail;
    lines.push('Classification: {covered_reproduced: ' + (btfDetail.covered_reproduced || 0) +
      ', covered_not_reproduced: ' + (btfDetail.covered_not_reproduced || 0) +
      ', not_covered: ' + (btfDetail.not_covered || 0) + '}');
    if (btfDetail.top_bugs && btfDetail.top_bugs.length > 0) {
      lines.push('Top bug IDs: ' + btfDetail.top_bugs.join(', '));
    }
    lines.push('');
  }

  // FPTUNE-03: Append FP rate table when session history exists
  try {
    const classData = JSON.parse(fs.readFileSync(path.join(ROOT, '.planning', 'formal', 'solve-classifications.json'), 'utf8'));
    const sessionHist = classData.session_history || [];
    if (sessionHist.length > 0) {
      const fpRatesForReport = computeFPRates(sessionHist);
      const tuningForReport = classData.tuning || {};
      lines.push('');
      lines.push(formatFPRateTable(fpRatesForReport, tuningForReport));
    }
  } catch (_) { /* fail-open: no session history yet */ }

  return lines.join('\n');
}

/**
 * Truncate detail arrays in a residual object to keep JSON output within pipe buffer limits.
 * Returns a shallow copy with truncated arrays and a `truncated` flag if applicable.
 */
function truncateResidualDetail(residual) {
  const MAX_DETAIL_ITEMS = 30;
  const copy = {};
  for (const key of Object.keys(residual)) {
    const val = residual[key];
    if (val && typeof val === 'object' && val.detail && typeof val.detail === 'object') {
      const detailCopy = Object.assign({}, val.detail);
      // Truncate large arrays in detail
      for (const dk of Object.keys(detailCopy)) {
        if (Array.isArray(detailCopy[dk]) && detailCopy[dk].length > MAX_DETAIL_ITEMS) {
          const totalCount = detailCopy[dk].length;
          detailCopy[dk] = detailCopy[dk].slice(0, MAX_DETAIL_ITEMS);
          detailCopy[dk + '_truncated'] = true;
          detailCopy[dk + '_total'] = totalCount;
        }
      }
      copy[key] = { residual: val.residual, detail: detailCopy };
    } else {
      copy[key] = val;
    }
  }
  return copy;
}

/**
 * Formats JSON output.
 */
function formatJSON(iterations, finalResidual, converged) {
  const health = {};
  for (const key of LAYER_KEYS) {
    const res = finalResidual[key] ? finalResidual[key].residual : -1;
    health[key] = healthIndicator(res).split(/\s+/)[1]; // Extract GREEN/YELLOW/RED/UNKNOWN
  }

  const truncatedResidual = truncateResidualDetail(finalResidual);

  // Attach complexity profile summary if available
  let complexityProfile = null;
  try {
    const profilePath = path.join(ROOT, '.planning', 'formal', 'model-complexity-profile.json');
    if (fs.existsSync(profilePath)) {
      const raw = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      complexityProfile = {
        summary: raw.summary,
        split_candidates: (raw.recommendations || {}).split_candidates || [],
        merge_candidates: (raw.recommendations || {}).merge_candidates || [],
      };
    }
  } catch (e) { /* fail-open */ }

  // Attach oscillation verdict data if available
  let oscillation = null;
  try {
    const verdictsPath = path.join(ROOT, '.planning', 'formal', 'oscillation-verdicts.json');
    if (fs.existsSync(verdictsPath)) {
      const verdictData = JSON.parse(fs.readFileSync(verdictsPath, 'utf8'));
      oscillation = {
        entry_count: verdictData.entry_count || 0,
        layers: verdictData.layers || {},
      };
    }
  } catch (_) { /* fail-open */ }

  // Repowise context: skeleton views for top hotspot files
  let repowiseContext = null;
  try {
    const { computeHotspots } = require('./repowise/hotspot.cjs');
    const hotspotResult = _repowiseHotspotCache || computeHotspots(ROOT, { since: '3.months.ago', maxCommits: 300 });
    if (hotspotResult && hotspotResult.files) {
      repowiseContext = {
        hotspot_summary: hotspotResult.summary,
        top_risk_files: hotspotResult.files.slice(0, 10).map(f => ({
          path: f.path,
          hotspot_score: f.hotspot_score,
          risk: f.risk,
          churn: f.churn,
          complexity: f.complexity,
        })),
      };
    }
  } catch (_e) { /* fail-open */ }

  try {
    const { computeCoChange } = require('./repowise/cochange.cjs');
    const cochange = _repowiseCochangeCache || computeCoChange(ROOT, { minSharedCommits: 2, minCouplingDegree: 0.1 });
    if (cochange && cochange.pairs && repowiseContext) {
      repowiseContext.cochange_pairs = cochange.pairs.length;
      repowiseContext.top_coupled = cochange.pairs.slice(0, 10).map(p => ({
        file1: p.file1, file2: p.file2,
        shared_commits: p.shared_commits,
        coupling_degree: p.coupling_degree,
      }));
    }
  } catch (_e) { /* fail-open */ }

  return {
    solver_version: '1.2',
    generated_at: new Date().toISOString(),
    fast_mode: fastMode ? true : false,
    iteration_count: iterations.length,
    max_iterations: maxIterations,
    converged: converged,
    has_residual: truncatedResidual.total > 0,
    residual_vector: truncatedResidual,
    real_impact: computeRealImpact(),
    iterations: iterations.map((it) => ({
      iteration: it.iteration,
      residual: truncateResidualDetail(it.residual),
      actions: it.actions || [],
      real_impact: it.real_impact,
    })),
    health: health,
    complexity_profile: complexityProfile,
    oscillation: oscillation,
    repowise: repowiseContext,
    // QUICK-370: Per-layer timing telemetry
    timing: (function () {
      const t = finalResidual.timing || {};
      t.total_diagnostic_ms = finalResidual.total_diagnostic_ms || 0;
      return t;
    })(),
    capped_layers: [],
    baseline_drift: { detected: false, layers: [], warning: null },
  };
}

// ── Clean Session Check (PROMO-02) ──────────────────────────────────────────

/**
 * Checks whether the current solve session is "clean" — all gate wiring scores
 * >= 1.0, all semantic scores >= 0.8, and no formal counterexamples.
 *
 * @returns {boolean} true if the session is clean
 */
function checkCleanSession() {
  const GATE_FILES = {
    A: { file: 'gate-a-grounding.json', wiringKey: 'wiring_evidence_score' },
    B: { file: 'gate-b-abstraction.json', wiringKey: 'wiring_purpose_score' },
    C: { file: 'gate-c-validation.json', wiringKey: 'wiring_coverage_score' },
  };

  const gatesDir = path.join(ROOT, '.planning', 'formal', 'gates');
  const wiring = {};
  const semantic = {};

  for (const [label, cfg] of Object.entries(GATE_FILES)) {
    try {
      const gateData = JSON.parse(fs.readFileSync(path.join(gatesDir, cfg.file), 'utf8'));
      wiring[label] = gateData[cfg.wiringKey] != null ? gateData[cfg.wiringKey] : 0;
      semantic[label] = gateData.semantic_score != null ? gateData.semantic_score : 0;
      // PROMO-03 diagnostic: log whether semantic_score was loaded or defaulted
      if (gateData.semantic_score == null) {
        process.stderr.write(TAG + ' checkCleanSession: gate ' + label + ' semantic_score defaulted to 0 (field missing)\n');
      } else {
        process.stderr.write(TAG + ' checkCleanSession: gate ' + label + ' semantic_score=' + gateData.semantic_score + ' (from file)\n');
      }
    } catch (_) {
      wiring[label] = 0;
      semantic[label] = 0;
    }
  }

  // Check formal results — no counterexamples
  let formalPass = true;
  try {
    const checkResultsPath = path.join(ROOT, '.planning', 'formal', 'check-results.ndjson');
    if (fs.existsSync(checkResultsPath)) {
      const lines = fs.readFileSync(checkResultsPath, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.result === 'counterexample') {
            formalPass = false;
            break;
          }
        } catch (_) { /* skip malformed lines */ }
      }
    }
  } catch (_) { /* fail-open */ }

  const wiringClean = wiring.A >= 1.0 && wiring.B >= 1.0 && wiring.C >= 1.0;
  const semanticClean = semantic.A >= 0.8 && semantic.B >= 0.8 && semantic.C >= 0.8;
  const isClean = wiringClean && semanticClean && formalPass;

  process.stderr.write(
    TAG + ' Clean session check: wiring=[A:' + wiring.A + ',B:' + wiring.B + ',C:' + wiring.C +
    '] semantic=[A:' + semantic.A + ',B:' + semantic.B + ',C:' + semantic.C +
    '] formal=' + (formalPass ? 'pass' : 'fail') + ' -> ' + (isClean ? 'CLEAN' : 'NOT_CLEAN') + '\n'
  );

  return isClean;
}

// ── FPTUNE: Per-scanner FP rate tracking and auto-threshold tuning ───────────

/**
 * FPTUNE-01: Compute per-scanner per-category stats from classifications.
 * @param {Object} classifications - { ctor: {...}, ttor: {...}, dtor: {...}, dtoc: {...} }
 * @returns {Object} Per-scanner stats: { ctor: { total, fp, genuine, review }, ... }
 */
function computeScannerStats(classifications) {
  const stats = {};
  for (const [scannerKey, entries] of Object.entries(classifications || {})) {
    const values = (entries && typeof entries === 'object') ? Object.values(entries) : [];
    stats[scannerKey] = {
      total: values.length,
      fp: values.filter(v => v === 'fp').length,
      genuine: values.filter(v => v === 'genuine').length,
      review: values.filter(v => v === 'review').length,
    };
  }
  return stats;
}

/**
 * FPTUNE-01: Record a session entry to session_history in solve-classifications.json.
 * Rolling window: keeps last 10 sessions.
 * @param {string} classificationsFilePath - Path to solve-classifications.json
 * @param {Object} scannerStats - From computeScannerStats()
 * @returns {Array} Updated session_history array
 */
function recordSessionHistory(classificationsFilePath, scannerStats) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(classificationsFilePath, 'utf8')); } catch (_) {}
  if (!Array.isArray(data.session_history)) data.session_history = [];

  data.session_history.push({
    session_id: new Date().toISOString(),
    scanner_stats: scannerStats,
  });

  // Rolling window: keep last 10 sessions
  if (data.session_history.length > 10) {
    data.session_history = data.session_history.slice(data.session_history.length - 10);
  }

  data.updated_at = new Date().toISOString();
  fs.writeFileSync(classificationsFilePath, JSON.stringify(data, null, 2) + '\n');
  return data.session_history;
}

/**
 * FPTUNE-01: Compute rolling FP rates per scanner from session_history.
 * @param {Array} sessionHistory - Array of session entries
 * @returns {Object} Per-scanner rates: { ctor: { sessions, total_items, total_fp, fp_rate }, ... }
 */
function computeFPRates(sessionHistory) {
  const rates = {};
  const scannerKeys = new Set();
  for (const session of (sessionHistory || [])) {
    for (const key of Object.keys(session.scanner_stats || {})) {
      scannerKeys.add(key);
    }
  }

  for (const key of scannerKeys) {
    let totalItems = 0;
    let totalFP = 0;
    let sessionCount = 0;
    for (const session of sessionHistory) {
      const stats = (session.scanner_stats || {})[key];
      if (stats) {
        totalItems += stats.total;
        totalFP += stats.fp;
        sessionCount++;
      }
    }
    rates[key] = {
      sessions: sessionCount,
      total_items: totalItems,
      total_fp: totalFP,
      fp_rate: totalItems > 0 ? totalFP / totalItems : 0,
    };
  }
  return rates;
}

/**
 * FPTUNE-02: Auto-raise suppression threshold for scanners with FP rate > 60% over 5+ sessions.
 * Threshold increase: +0.1 per tuning cycle, capped at 0.9.
 * @param {string} classificationsFilePath - Path to solve-classifications.json
 * @param {Object} fpRates - From computeFPRates()
 * @returns {Array} Changes applied: [{ scanner, from, to, fp_rate, sessions }]
 */
function applyFPTuning(classificationsFilePath, fpRates) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(classificationsFilePath, 'utf8')); } catch (_) {}
  if (!data.tuning) data.tuning = {};

  const changes = [];

  for (const [scannerKey, rateInfo] of Object.entries(fpRates)) {
    const currentThreshold = data.tuning[scannerKey] || 0.5;
    if (rateInfo.sessions >= 5 && rateInfo.fp_rate > 0.6) {
      const newThreshold = Math.min(currentThreshold + 0.1, 0.9);
      if (newThreshold !== currentThreshold) {
        data.tuning[scannerKey] = parseFloat(newThreshold.toFixed(2));
        changes.push({
          scanner: scannerKey,
          from: currentThreshold,
          to: data.tuning[scannerKey],
          fp_rate: rateInfo.fp_rate,
          sessions: rateInfo.sessions,
        });
      }
    }
    // Ensure scanner has an entry even if no tuning needed
    if (data.tuning[scannerKey] == null) {
      data.tuning[scannerKey] = 0.5;
    }
  }

  data.updated_at = new Date().toISOString();
  fs.writeFileSync(classificationsFilePath, JSON.stringify(data, null, 2) + '\n');
  return changes;
}

/**
 * FPTUNE-03: Format per-scanner FP rate table for diagnostics output.
 * @param {Object} fpRates - From computeFPRates()
 * @param {Object} tuning - From solve-classifications.json tuning section
 * @returns {string} Formatted table
 */
function formatFPRateTable(fpRates, tuning) {
  const lines = [];
  lines.push('');
  lines.push('Per-Scanner FP Rates (last 10 sessions):');
  lines.push('| Scanner | Sessions | FP Rate | Threshold | Status |');
  lines.push('|---------|----------|---------|-----------|--------|');

  const scannerOrder = ['ctor', 'ttor', 'dtor', 'dtoc'];
  const keys = scannerOrder.filter(k => fpRates[k]);
  // Add any keys not in the predefined order
  for (const k of Object.keys(fpRates)) {
    if (!keys.includes(k)) keys.push(k);
  }

  for (const key of keys) {
    const rate = fpRates[key];
    const threshold = (tuning && tuning[key]) || 0.5;
    const fpPct = (rate.fp_rate * 100).toFixed(1) + '%';
    const status = rate.fp_rate > 0.6 && rate.sessions >= 5 ? 'TUNED' : 'OK';
    lines.push('| ' + key.padEnd(7) + ' | ' + String(rate.sessions).padEnd(8) + ' | ' + fpPct.padEnd(7) + ' | ' + threshold.toFixed(2).padEnd(9) + ' | ' + status.padEnd(6) + ' |');
  }

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  // --help must short-circuit BEFORE any work. Without this guard, unknown
  // flags fall through and the full diagnostic sweep runs (and hangs), so
  // `nf-solve.cjs --help` never returns usage.
  if (args.includes('--help') || args.includes('-h')) {
    console.log([
      'Usage: nf-solve.cjs [options]',
      '',
      '  --report-only        run diagnostics only; no remediation',
      '  --json               emit JSON output',
      '  --fast               skip the heavy diagnostic phases',
      '  --plan-only          compute a remediation plan, then stop',
      '  --execute            resume from a saved (planned) session',
      '  --resume             resume an in-progress session',
      '  --max-iterations=N   convergence-loop cap (default 3)',
      '  --focus="<phrase>"   bias the diagnostic sweep toward a phrase',
      '  --skip-layers=a,b    skip named remediation layers',
      '  --project-root=DIR   operate on another repo',
      '  --no-auto-commit     skip the formal-artifacts auto-commit',
      '  --help, -h           show this help',
    ].join('\n'));
    process.exit(0);
  }

  // Step 0: Bootstrap formal infrastructure
  preflight();

  // Read existing solve-state.json for consecutive_clean_sessions (PROMO-02)
  let existingSolveState = {};
  try {
    existingSolveState = JSON.parse(fs.readFileSync(path.join(ROOT, '.planning', 'formal', 'solve-state.json'), 'utf8'));
  } catch (_) { /* first run or corrupt file */ }

  // Ensure consecutive_clean_sessions is initialized (PROMO-02)
  // The || 0 fallback at line ~3816 already handles missing field safely.
  // This explicit guard makes the initialization contract visible at preflight time
  // and prevents edge cases where other code reads existingSolveState.consecutive_clean_sessions
  // before the persistence block.
  if (existingSolveState.consecutive_clean_sessions == null) {
    existingSolveState.consecutive_clean_sessions = 0;
  }

  // Check baseline presence and emit advisory if needed
  const baselineCheck = checkBaselinePresence();
  if (!baselineCheck.has_baselines) {
    if (baselineCheck.file_missing) {
      process.stderr.write(TAG + " ADVISORY: requirements.json not found. Run 'node bin/sync-baseline-requirements.cjs' to create it with baseline requirements.\n");
    } else {
      process.stderr.write(TAG + " ADVISORY: requirements.json contains 0 of " + baselineCheck.total_count + " requirements from baselines. Run 'node bin/sync-baseline-requirements.cjs' to populate baselines and improve coverage.\n");
    }
    if (requireBaselines) {
      process.stderr.write(TAG + " ERROR: --require-baselines set but no baselines found. Aborting.\n");
      process.exit(1);
    }
  }

  const iterations = [];
  let converged = false;
  let prevTotal = null;
  let prevAutomatable = null;

  // Refresh evidence files from recent traces before convergence loop
  if (!reportOnly) {
    const evResult = spawnTool('bin/refresh-evidence.cjs', ['--json']);
    if (evResult.ok) {
      process.stderr.write(TAG + ' Evidence refresh: ' + evResult.stdout.trim() + '\n');
    }
  }

  const cycleDetector = new CycleDetector();

  // CADP-01: Create adapter once per solve run (accumulates metrics across all iterations).
  // resetCache() clears stale data from previous runs before the loop starts.
  // Hoisted here so metrics are non-zero after sync-path queries in queryEdgesSync.
  const _solveAdapter = createAdapter({ enabled: !noCoderlm });
  _solveAdapter.resetCache(); // CADP-01: cleared at loop start
  _activeAdapter = _solveAdapter; // CREM-03: Make adapter available to sweepGitHeatmap()

  // Start coderlm server early so it's available for all modes (including --report-only)
  if (!skipProximity && !noCoderlm) {
    try {
      const lifecycle = ensureRunning({ port: 8787, indexPath: ROOT });
      if (lifecycle.ok) {
        process.stderr.write(TAG + ' coderlm server started (pid=' + lifecycle.pid + ', source=' + lifecycle.source + ')\n');
      } else {
        process.stderr.write(TAG + ' coderlm server: ' + (lifecycle.error || 'unavailable') + ' — fail-open mode\n');
      }
    } catch (e) {
      process.stderr.write(TAG + ' coderlm server start failed: ' + e.message + ' — fail-open mode\n');
    }
  }

  // Pre-flight: log coderlm availability before the first sweep so diagnostics arrive early.
  // Non-blocking — failure routes to fail-open mode throughout the loop.
  try {
    const warmup = _solveAdapter.healthSync();
    process.stderr.write(TAG + ' coderlm pre-flight: ' + (warmup.healthy ? 'healthy — queries enabled' : 'unavailable — fail-open mode') + '\n');
  } catch (_) {
    process.stderr.write(TAG + ' coderlm pre-flight: unreachable — fail-open mode\n');
  }

  for (let i = 1; i <= maxIterations; i++) {
    process.stderr.write(TAG + ' Iteration ' + i + '/' + maxIterations + '\n');

    // Clear formal-test-sync cache so computeResidual() sees fresh data after autoClose() mutations
    formalTestSyncCache = null;

  const residual = computeResidual();
  const actions = [];
  iterations.push({ iteration: i, residual: residual, actions: actions, real_impact: computeRealImpact() });

    // Record per-layer residuals for cycle detection (CONV-01)
    const perLayerResiduals = {};
    for (const key of LAYER_KEYS) {
      if (residual[key] && typeof residual[key].residual === 'number') {
        perLayerResiduals[key] = residual[key].residual;
      }
    }
    cycleDetector.record(i, perLayerResiduals);
    const oscillatingLayers = cycleDetector.detectOscillating();
    if (oscillatingLayers.length > 0) {
      process.stderr.write(TAG + ' Oscillating layers detected: ' + oscillatingLayers.join(', ') + ' — excluding from convergence check and dispatch\n');
    }

    // Compute automatable residual excluding oscillating layers (CONV-01)
    const oscillatingSet = new Set(oscillatingLayers);
    let oscillatingSum = 0;
    for (const layer of oscillatingLayers) {
      if (residual[layer] && typeof residual[layer].residual === 'number' && residual[layer].residual > 0) {
        oscillatingSum += residual[layer].residual;
      }
    }
    const automatableExcludingOsc = residual.automatable - oscillatingSum;
    const effectiveTotal = residual.total - oscillatingSum;

    // Check convergence: automatable residual unchanged from previous iteration
    if (prevAutomatable !== null && automatableExcludingOsc === prevAutomatable) {
      converged = true;
      process.stderr.write(
        TAG +
          ' Converged at iteration ' +
          i +
          ' (automatable residual stable at ' +
          automatableExcludingOsc +
          ', total=' + effectiveTotal +
          (oscillatingLayers.length > 0 ? ', excluding oscillating: ' + oscillatingLayers.join(', ') : '') +
          ')\n'
      );
      break;
    }

    // Check if automatable residual is zero (nothing left the solver can fix)
    if (automatableExcludingOsc === 0) {
      converged = true;
      process.stderr.write(TAG + ' All automatable layers clean — automatable residual is 0' +
        (effectiveTotal > 0 ? ' (remaining ' + effectiveTotal + ' is manual/informational)' : '') +
        (oscillatingLayers.length > 0 ? ' (oscillating: ' + oscillatingLayers.join(', ') + ')' : '') + '\n');
      break;
    }

    // Auto-close if not report-only and not last iteration
    if (!reportOnly) {
      // On final iteration in fast mode, force full sweep for accurate final report
      if (fastMode && i === maxIterations) {
        _forceFullSweep = true;
        process.stderr.write(TAG + ' Final iteration — forcing full sweep for accurate report\n');
      }

      // HTARGET-01/02: Compute hypothesis-driven wave dispatch order
      let waveOrder = null;
      try {
        // coderlm auto-start lifecycle (replaces NF_CODERLM_ENABLED gate)
        // Fail-open: if ensureRunning fails, falls through to heuristic waves
        try {
          const lifecycle = ensureRunning({ port: 8787, indexPath: ROOT });
          if (lifecycle.ok) {
            const adapter = _solveAdapter; // reuse hoisted adapter (accumulates metrics, CADP-03)
            const healthResult = adapter.healthSync();
            if (healthResult.healthy) {
              touchLastQuery();  // Update idle timer
              process.stderr.write(TAG + ' coderlm server healthy, attempting graph-driven wave ordering\n');

              // Collect active layers (residual > 0)
              const activeLayerKeys = [];
              for (const [key, val] of Object.entries(residual)) {
                if (val && typeof val === 'object' && val.residual > 0) {
                  activeLayerKeys.push(key);
                }
              }

              if (activeLayerKeys.length > 0) {
                const discoveredEdges = queryEdgesSync(adapter, activeLayerKeys);
                process.stderr.write(TAG + ' coderlm discovered ' + discoveredEdges.length + ' inter-layer edge(s)\n');

                const graph = {
                  nodes: activeLayerKeys,
                  edges: discoveredEdges
                };

                const transitions = loadHypothesisTransitions(ROOT);
                const priorityWeights = computeLayerPriorityWeights(transitions);
                const graphWaves = computeWavesFromGraph(graph, priorityWeights);

                if (graphWaves.length > 0) {
                  waveOrder = graphWaves;
                  process.stderr.write(TAG + ' coderlm graph-driven wave ordering (' + graphWaves.length + ' waves): ' +
                    graphWaves.map(w => 'W' + w.wave + '[' + w.layers.join(',') + ']' + (w.sequential ? '(seq)' : '')).join(' -> ') + '\n');
                }
              }
            } else {
              process.stderr.write(TAG + ' coderlm unhealthy after start (' + healthResult.error + '), falling back to heuristic waves\n');
            }
          } else {
            process.stderr.write(TAG + ' coderlm lifecycle: ' + (lifecycle.error || 'unavailable') + ', falling back to heuristic waves\n');
          }
        } catch (e) {
          process.stderr.write(TAG + ' WARNING: coderlm integration failed: ' + e.message + ', falling back\n');
        }

        // Fall through to hypothesis-driven wave computation if coderlm path didn't produce a result (always available as fallback)
        if (!waveOrder) {
          const transitions = loadHypothesisTransitions(ROOT);
          const priorityWeights = computeLayerPriorityWeights(transitions);
          const computedWaves = computeWaves(residual, priorityWeights);
          if (computedWaves.length > 0) {
            waveOrder = computedWaves;  // Preserve full wave structure (not flattened)
            process.stderr.write(TAG + ' Wave ordering (' + computedWaves.length + ' waves, ' +
              (transitions.length > 0 ? transitions.length + ' hypothesis transition(s) applied' : 'no transitions') +
              '): ' + computedWaves.map(w => 'W' + w.wave + '[' + w.layers.join(',') + ']' + (w.sequential ? '(seq)' : '')).join(' -> ') + '\n');
          }
        }
      } catch (e) {
        // fail-open: wave ordering failure means autoClose uses default order
        process.stderr.write(TAG + ' WARNING: wave ordering failed: ' + e.message + '\n');
      }

      const closeResult = autoClose(residual, oscillatingSet, waveOrder);
      iterations[iterations.length - 1].actions = closeResult.actions_taken;
      iterations[iterations.length - 1].wave_order = waveOrder;

      // CDIAG-04: Re-index coderlm only when autoClose actually modified files.
      // Guard: actions_taken.length > 0 indicates remediation wrote/changed files.
      // Fail-open: reindex errors are logged to stderr and never bubble to caller.
      if (closeResult.actions_taken && closeResult.actions_taken.length > 0) {
        try {
          const reindexResult = reindex({ port: 8787 });
          if (reindexResult.ok) {
            process.stderr.write(TAG + ' coderlm reindexed after remediation\n');
          } else {
            process.stderr.write(TAG + ' coderlm reindex skipped: ' + (reindexResult.error || 'unavailable') + '\n');
          }
        } catch (e) {
          process.stderr.write(TAG + ' coderlm reindex failed (non-fatal): ' + e.message + '\n');
        }
      }

      // CDIAG-03: In incremental mode (--skip-layers), expand skipLayerSet using call-graph
      // analysis of files written by autoClose. This prevents incorrect skips when a changed
      // utility file's callers map to additional layers not covered by static DOMAIN_MAP matching.
      // Only runs when user requested layer skipping AND adapter is available.
      if (skipLayerSet.size > 0 && _activeAdapter) {
        try {
          const gitOut = spawnSync('git', ['diff', '--name-only'], { encoding: 'utf8', cwd: ROOT });
          const changedFiles = (gitOut.stdout || '').trim().split('\n').filter(Boolean);
          if (changedFiles.length > 0) {
            const { computeAffectedLayers } = require('./solve-incremental-filter.cjs');
            const filterResult = computeAffectedLayers(changedFiles, _activeAdapter);
            let unblocked = 0;
            for (const layer of filterResult.affected_layers) {
              if (skipLayerSet.has(layer)) {
                skipLayerSet.delete(layer);
                unblocked++;
              }
            }
            if (unblocked > 0) {
              process.stderr.write(TAG + ' CDIAG-03: call-graph expansion un-skipped ' + unblocked + ' layer(s) for next iteration\n');
            }
          }
        } catch (e) {
          process.stderr.write(TAG + ' CDIAG-03: call-graph expansion failed (non-fatal): ' + e.message + '\n');
        }
      }

      checkIdleStop();  // Stop coderlm if idle > 5 min
    } else {
      break; // report-only = single sweep, no loop
    }

    prevTotal = effectiveTotal;
    prevAutomatable = automatableExcludingOsc;
  }

  // CADP-03: Emit coderlm session metrics to stderr after solve loop exits
  try {
    if (_solveAdapter && typeof _solveAdapter.getSessionMetrics === 'function') {
      const m = _solveAdapter.getSessionMetrics();
      process.stderr.write(
        TAG + ' coderlm session metrics: ' +
        m.queryCount + ' queries, ' +
        (m.cacheHitRate * 100).toFixed(1) + '% cache hit rate, ' +
        m.totalLatencyMs + 'ms total latency\n'
      );
    }
  } catch (e) { /* fail-open */ }

  const finalResidual = iterations[iterations.length - 1].residual;

  // Write solver state persistence
  const solveState = {
    last_run: new Date().toISOString(),
    converged: converged,
    iteration_count: iterations.length,
    final_residual_total: finalResidual.total,
    reverse_discovery_total: finalResidual.reverse_discovery_total || 0,
    heatmap_total: finalResidual.heatmap_total || 0,
    real_impact: computeRealImpact(),
    real_impact_iterations: iterations.map(it => ({ iteration: it.iteration, real_impact: it.real_impact })),
    known_issues: [],
    r_to_f_progress: {
      total: finalResidual.r_to_f.detail.total || 0,
      covered: finalResidual.r_to_f.detail.covered || 0,
      percentage: finalResidual.r_to_f.detail.percentage || 0,
    },
    focus: focusPhrase || null,
    capped_layers: [],
    baseline_drift: { detected: false, layers: [], warning: null },
  };
  // Collect known issues from non-zero non-error layers
  // -- Load classification cache and archive data for net_residual computation --
  const LAYER_CAT_MAP = {
    d_to_c: { catKey: 'dtoc', detailKey: 'broken_claims' },
    c_to_r: { catKey: 'ctor', detailKey: 'untraced_modules' },
    t_to_r: { catKey: 'ttor', detailKey: 'orphan_tests' },
    d_to_r: { catKey: 'dtor', detailKey: 'unbacked_claims' },
  };

  let classificationsByCategory = {};
  try {
    const cached = JSON.parse(fs.readFileSync(path.join(ROOT, '.planning', 'formal', 'solve-classifications.json'), 'utf8'));
    classificationsByCategory = cached.classifications || {};
  } catch (_) { /* fail-open */ }

  // FPTUNE-01: Record session history and compute FP rates
  const scannerStats = computeScannerStats(classificationsByCategory);
  const classPath = path.join(ROOT, '.planning', 'formal', 'solve-classifications.json');
  if (!reportOnly) {
    recordSessionHistory(classPath, scannerStats);
  }

  // FPTUNE-02: Auto-tune suppression thresholds
  const fpRates = computeFPRates(
    (() => { try { return JSON.parse(fs.readFileSync(classPath, 'utf8')).session_history || []; } catch (_) { return []; } })()
  );
  if (!reportOnly) {
    const tuningChanges = applyFPTuning(classPath, fpRates);
    if (tuningChanges.length > 0) {
      for (const c of tuningChanges) {
        process.stderr.write(TAG + ' FPTUNE: ' + c.scanner + ' threshold raised ' + c.from + ' -> ' + c.to + ' (FP rate: ' + (c.fp_rate * 100).toFixed(1) + '% over ' + c.sessions + ' sessions)\n');
      }
    }
  }

  let archiveEntries = [];
  try {
    const archiveData = JSON.parse(fs.readFileSync(path.join(ROOT, '.planning', 'formal', 'archived-solve-items.json'), 'utf8'));
    archiveEntries = archiveData.entries || [];
  } catch (_) { /* fail-open */ }

  function netResidualItemKey(catKey, item) {
    if (catKey === 'dtoc') return `${item.doc_file}:${item.value}`;
    if (catKey === 'ctor') return typeof item === 'string' ? item : item.file;
    if (catKey === 'ttor') return typeof item === 'string' ? item : item.file;
    if (catKey === 'dtor') return `${item.doc_file}:${item.line}`;
    return JSON.stringify(item).slice(0, 100);
  }

  function netResidualArchiveKey(catKey, item) {
    if (catKey === 'dtoc') return `${item.doc_file}:${item.value}`;
    if (catKey === 'dtor') return `${item.doc_file}:${item.line}`;
    return typeof item === 'string' ? item : (item.file || item.summary);
  }

  for (const [key, val] of Object.entries(finalResidual)) {
    if (val && typeof val === 'object' && val.residual > 0) {
      const mapping = LAYER_CAT_MAP[key];
      if (mapping) {
        const { catKey, detailKey } = mapping;
        const detailItems = (val.detail && val.detail[detailKey]) || [];
        const catClassifications = classificationsByCategory[catKey] || {};

        // Filter out FP-classified items
        const afterFP = detailItems.filter(item => {
          const k = netResidualItemKey(catKey, item);
          return catClassifications[k] !== 'fp';
        });

        // Filter out archived items
        const afterArchive = afterFP.filter(item => {
          const ak = netResidualArchiveKey(catKey, item);
          return !archiveEntries.some(e => e.key === ak);
        });

        solveState.known_issues.push({ layer: key, residual: val.residual, net_residual: afterArchive.length });
      } else {
        solveState.known_issues.push({ layer: key, residual: val.residual });
      }
    }
  }
  // Step 8a: Track consecutive clean sessions for auto-promotion (PROMO-02)
  const isCleanSession = checkCleanSession();
  const prevClean = (existingSolveState && existingSolveState.consecutive_clean_sessions) || 0;
  solveState.consecutive_clean_sessions = isCleanSession ? prevClean + 1 : 0;

  // Report-only is documented as a no-mutation diagnostic sweep. Persisting
  // solve-state.json here violated that and made the measurement non-idempotent:
  // the residual penalizes a stale solve-state (wave_count===0), so a report run
  // rewrote the state and the NEXT report run then measured a lower residual
  // (issue #5 — "Residual unstable: pre=348→post=340" on no-op stability checks).
  // Only persist when actually solving.
  if (!reportOnly) {
    try {
      const stateDir = path.join(ROOT, '.planning', 'formal');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'solve-state.json'),
        JSON.stringify(solveState, null, 2) + '\n'
      );
    } catch (e) {
      process.stderr.write(TAG + ' WARNING: could not write solve-state.json: ' + e.message + '\n');
    }
  }

  // Step 8a: Auto-promote eligible models (PROMO-01)
  if (!reportOnly && solveState.consecutive_clean_sessions >= 3) {
    process.stderr.write(TAG + ' Step 8a: Checking auto-promotion eligibility (clean sessions: ' + solveState.consecutive_clean_sessions + ')\n');
    const promoResult = spawnTool('bin/promote-gate-maturity.cjs', ['--auto-promote', '--json']);
    if (promoResult.ok) {
      try {
        const promoData = JSON.parse(promoResult.stdout);
        if (promoData.promoted && promoData.promoted.length > 0) {
          process.stderr.write(TAG + ' Step 8a: Promoted ' + promoData.promoted.length + ' model(s) SOFT_GATE -> HARD_GATE\n');
          for (const m of promoData.promoted) {
            process.stderr.write(TAG + '   - ' + m + '\n');
          }
        } else {
          process.stderr.write(TAG + ' Step 8a: No models eligible for promotion\n');
        }
      } catch (e) {
        process.stderr.write(TAG + ' Step 8a: Could not parse promotion result: ' + e.message + '\n');
      }
    } else {
      process.stderr.write(TAG + ' Step 8a: promote-gate-maturity.cjs failed: ' + (promoResult.stderr || 'unknown') + '\n');
    }
  } else if (!reportOnly) {
    process.stderr.write(TAG + ' Step 8a: Skipped — consecutive_clean_sessions=' + (solveState.consecutive_clean_sessions || 0) + ' (need 3)\n');
  }

  // Append trend entry to JSONL (after solve-state.json, before session persistence).
  // Report-only is a diagnostic sweep, not a progress-making run — it must not
  // append to the convergence trend log (a mutation that also dirties the tree).
  if (!reportOnly) {
    appendTrendEntry(finalResidual, converged, iterations.length, {
      root: ROOT,
      fastMode: fastMode,
    });
  }

  // Update oscillation verdicts after trend entry is written
  if (!reportOnly) {
    // OSC-03: Read previous verdicts before update for newly-blocked detection
    let prevVerdictsLayers = null;
    try {
      const vPath = path.join(ROOT, '.planning', 'formal', 'oscillation-verdicts.json');
      if (fs.existsSync(vPath)) {
        prevVerdictsLayers = JSON.parse(fs.readFileSync(vPath, 'utf8')).layers || null;
      }
    } catch (_) { /* fail-open */ }

    try {
      const currVerdicts = updateVerdicts({ root: ROOT });

      // OSC-03: Escalation classification when oscillation breaker fires
      const newlyBlocked = detectNewlyBlocked(prevVerdictsLayers, currVerdicts && currVerdicts.layers);
      if (newlyBlocked.length > 0) {
        for (const layer of newlyBlocked) {
          try {
            const classResult = spawnSync(process.execPath, [
              path.join(__dirname, 'escalation-classifier.cjs'),
              '--layer=' + layer,
              '--project-root=' + ROOT,
            ], { encoding: 'utf8', timeout: 15000 });

            if (classResult.status === 0 && classResult.stdout) {
              const parsed = JSON.parse(classResult.stdout);
              process.stderr.write(TAG + ' Escalation: ' + layer + ' -> ' +
                parsed.classification + ' (confidence: ' + parsed.confidence + ')\n');
            }
          } catch (classErr) {
            process.stderr.write(TAG + ' WARNING: escalation classification failed for ' +
              layer + ': ' + classErr.message + '\n');
          }
        }
      }
    } catch (e) {
      process.stderr.write(TAG + ' WARNING: oscillation verdict update failed: ' + e.message + '\n');
    }
  }

  // Update predictive power metrics (bug linking, recall, velocity)
  let predictivePowerResults = null;
  if (!reportOnly) {
    try {
      predictivePowerResults = updatePredictivePower({ root: ROOT });
    } catch (e) {
      process.stderr.write(TAG + ' WARNING: predictive power update failed: ' + e.message + '\n');
    }
  }

  // Pre-compute both outputs for session persistence (avoid redundant formatting)
  let reportText = formatReport(iterations, finalResidual, converged);
  if (predictivePowerResults) {
    reportText += '\n' + formatPredictivePowerSummary(predictivePowerResults);
  }
  const jsonObj = formatJSON(iterations, finalResidual, converged);
  jsonObj.oscillating_layers = cycleDetector.detectOscillating();
  jsonObj.baseline_advisory = baselineCheck.has_baselines ? null : {
    warning: baselineCheck.file_missing
      ? 'requirements.json not found'
      : 'no baseline-sourced requirements in requirements.json',
    suggestion: baselineCheck.file_missing
      ? 'run sync-baseline-requirements.cjs to create baseline requirements'
      : 'run sync-baseline-requirements.cjs to populate baselines',
    file_missing: baselineCheck.file_missing,
    baseline_count: baselineCheck.baseline_count,
    total_count: baselineCheck.total_count
  };
  const jsonText = JSON.stringify(jsonObj, null, 2);

  // Persist session summary before stdout/exit.
  // Report-only is a no-mutation diagnostic sweep: it must not drop a
  // solve-session-*.md file into .planning/formal/solve-sessions/ (a tree
  // mutation, and a per-run one that breaks report-only idempotency).
  if (!reportOnly) {
    persistSessionSummary(reportText, jsonText, converged, iterations);
  }

  const exitCode = 0;
  const outputText = jsonMode ? (jsonText + '\n') : reportText;

  // `--report-only` is a no-mutation diagnostic sweep — it must never create a commit.
  // Auto-committing here meant that simply RUNNING nf-solve to inspect residual (e.g.
  // verifying a fix, or a benchmark measuring the gap) produced a `chore(solve)` commit
  // that swept whatever was in the working tree onto the current branch. Only a real
  // (non-report) solve, which is meant to make and record progress, auto-commits.
  if (!noAutoCommit && !reportOnly) {
    try {
      const commitResult = spawnTool('bin/solve-commit-artifacts.cjs', ['--json']);
      if (commitResult.ok && commitResult.stdout) {
        try {
          const parsed = JSON.parse(commitResult.stdout.trim());
          if (parsed.committed) {
            process.stderr.write(TAG + ' Auto-commit: ' + parsed.hash + ' — ' + parsed.message + '\n');
          } else {
            process.stderr.write(TAG + ' Auto-commit: skipped (' + parsed.reason + ')\n');
          }
        } catch (_) {
          process.stderr.write(TAG + ' Auto-commit: ' + commitResult.stdout.trim() + '\n');
        }
      } else {
        process.stderr.write(TAG + ' Auto-commit: failed (' + (commitResult.stderr || 'unknown').trim() + ')\n');
      }
    } catch (e) {
      process.stderr.write(TAG + ' Auto-commit: error — ' + e.message + '\n');
    }
  }

  process.stdout.write(outputText, () => {
    process.exitCode = exitCode;
    process.stdout.end();
  });
}

// ── Session Persistence ──────────────────────────────────────────────────────

const MAX_SESSION_FILES = 20;

/**
 * Persist a timestamped session summary to disk.
 * Accepts pre-computed strings to avoid redundant formatting calls.
 * @param {string} reportText - Human-readable report from formatReport()
 * @param {string} jsonText - JSON string from formatJSON()
 * @param {boolean} converged - Whether the solver converged
 * @param {Array} iterations - Array of iteration objects with actions
 * @param {string} [sessionsDir] - Override directory (for testing)
 */
function persistSessionSummary(reportText, jsonText, converged, iterations, sessionsDir) {
  try {
    const dir = sessionsDir || path.join(ROOT, '.planning', 'formal', 'solve-sessions');
    fs.mkdirSync(dir, { recursive: true });

    const now = new Date();
    const ts = now.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
    const filename = 'solve-session-' + ts + '.md';

    // Build actions section
    let actionsContent = '';
    for (let i = 0; i < iterations.length; i++) {
      const iter = iterations[i];
      const actions = iter.actions || [];
      actionsContent += '### Iteration ' + (i + 1) + '\n\n';
      if (actions.length === 0) {
        actionsContent += '_No auto-close actions taken._\n\n';
      } else {
        for (const a of actions) {
          actionsContent += '- ' + a + '\n';
        }
        actionsContent += '\n';
      }
    }

    const content =
      '# nf-solve Session Summary\n\n' +
      '**Timestamp:** ' + now.toISOString() + '\n' +
      '**Converged:** ' + (converged ? 'Yes' : 'No') + '\n' +
      '**Iterations:** ' + iterations.length + '\n\n' +
      '## Residual Vector\n\n' +
      reportText + '\n\n' +
      '## Machine State\n\n' +
      '```json\n' + jsonText + '\n```\n\n' +
      '## Actions Taken\n\n' +
      actionsContent;

    fs.writeFileSync(path.join(dir, filename), content);

    // Prune old sessions — keep only the newest MAX_SESSION_FILES
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith('solve-session-') && f.endsWith('.md'))
      .sort();
    if (files.length > MAX_SESSION_FILES) {
      const toDelete = files.slice(0, files.length - MAX_SESSION_FILES);
      for (const f of toDelete) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* ignore */ }
      }
    }
  } catch (e) {
    process.stderr.write(TAG + ' WARNING: could not write session summary: ' + e.message + '\n');
  }
}

// ── Exports (for testing) ────────────────────────────────────────────────────

module.exports = {
  sweep: computeResidual,
  computeResidual,
  autoClose,
  formatReport,
  formatJSON,
  healthIndicator,
  preflight,
  triageRequirements,
  discoverDocFiles,
  extractKeywords,
  extractStructuralClaims,
  sweepRtoF,
  sweepFtoT,
  sweepCtoF,
  sweepTtoC,
  sweepFtoC,
  sweepRtoD,
  sweepDtoC,
  sweepPtoF: function () { return sweepPtoF({ root: ROOT, focusSet }); },
  sweepCtoR,
  sweepTtoR,
  sweepDtoR,
  sweepL1toL3,
  sweepL3toTC,
  sweepPerModelGates,
  sweepGitHeatmap,
  sweepGitHistoryEvidence,
  sweepFormalLint,
  sweepHazardModel,
  sweepHtoM,
  sweepModelStaleness,
  sweepBtoF,
  classifyFailingTest,
  assembleReverseCandidates,
  proximityPreFilter,
  classifyCandidate,
  digestV8Coverage,
  crossReferenceFormalCoverage,
  persistSessionSummary,
  appendTrendEntry,
  readGateSummary,
  updateVerdicts,
  updatePredictivePower,
  checkCleanSession,
  computeScannerStats,
  recordSessionHistory,
  computeFPRates,
  applyFPTuning,
  formatFPRateTable,
  pastDeadline,
  deadlineSkip,
};

// ── Entry point ──────────────────────────────────────────────────────────────

if (require.main === module) {
  main();
}

// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
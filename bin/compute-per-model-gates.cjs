#!/usr/bin/env node
'use strict';

/**
 * compute-per-model-gates.cjs — Per-model gate maturity scoring.
 *
 * Computes which gates (A/B/C) each formal model passes, updates layer_maturity
 * scores (0-3), auto-promotes eligible models, and optionally writes back to
 * model-registry.json.
 *
 * Requirements: GATE-01, GATE-02, GATE-03, GATE-04, STAB-01, STAB-02
 *
 * Usage:
 *   node bin/compute-per-model-gates.cjs              # human-readable summary
 *   node bin/compute-per-model-gates.cjs --json        # machine-readable JSON
 *   node bin/compute-per-model-gates.cjs --dry-run     # compute but don't write
 *   node bin/compute-per-model-gates.cjs --json --dry-run
 *   node bin/compute-per-model-gates.cjs --write-per-model  # persist per-model gate detail
 */

const fs   = require('fs');
const path = require('path');

const ROOT = (() => {
  const idx = process.argv.findIndex(a => a.startsWith('--project-root='));
  return idx >= 0 ? process.argv[idx].split('=')[1] : (process.env.PROJECT_ROOT || path.join(__dirname, '..'));
})();

const FORMAL = path.join(ROOT, '.planning', 'formal');
const REGISTRY_PATH      = path.join(FORMAL, 'model-registry.json');
const LAYER_MANIFEST_PATH = path.join(FORMAL, 'layer-manifest.json');
const TRACE_MATRIX_PATH   = path.join(FORMAL, 'traceability-matrix.json');
const HAZARD_MODEL_PATH   = path.join(FORMAL, 'reasoning', 'hazard-model.json');
const UNIT_TEST_COV_PATH  = path.join(FORMAL, 'unit-test-coverage.json');
const FAILURE_CATALOG_PATH = path.join(FORMAL, 'reasoning', 'failure-mode-catalog.json');
const TEST_RECIPES_PATH   = path.join(FORMAL, 'test-recipes', 'test-recipes.json');

const JSON_FLAG       = process.argv.includes('--json');
const DRY_RUN_FLAG    = process.argv.includes('--dry-run');
const SKIP_EVIDENCE   = process.argv.includes('--skip-evidence');
const AGGREGATE_FLAG  = process.argv.includes('--aggregate');
const WRITE_PER_MODEL_FLAG = process.argv.includes('--write-per-model');

const GATES_DIR = path.join(FORMAL, 'gates');
const PER_MODEL_GATES_PATH = path.join(GATES_DIR, 'per-model-gates.json');

const TAG = '[compute-per-model-gates]';

const EVIDENCE_DIR = path.join(FORMAL, 'evidence');
const CHANGELOG_PATH = path.join(FORMAL, 'promotion-changelog.json');
const CHANGELOG_MAX_ENTRIES = 200;
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Appends a structured entry to promotion-changelog.json.
 * Entry schema: { model, from_level, to_level, timestamp, evidence_readiness, trigger }
 * Enforces retention cap of 200 entries.
 * No-op during dry-run.
 */
function appendChangelog(entry) {
  if (DRY_RUN_FLAG) return;
  try {
    let changelog = [];
    if (fs.existsSync(CHANGELOG_PATH)) {
      try {
        changelog = JSON.parse(fs.readFileSync(CHANGELOG_PATH, 'utf8'));
        if (!Array.isArray(changelog)) changelog = [];
      } catch (_) {
        changelog = [];
      }
    }
    // Write-time dedup guard: reject if a matching entry exists within 5-minute window
    const entryTime = new Date(entry.timestamp).getTime();
    for (let i = changelog.length - 1; i >= 0; i--) {
      const existing = changelog[i];
      const existingTime = new Date(existing.timestamp).getTime();
      // Once we're past the window, stop scanning (entries are chronological)
      if (Math.abs(entryTime - existingTime) >= DEDUP_WINDOW_MS) break;
      if (existing.model === entry.model &&
          existing.from_level === entry.from_level &&
          existing.to_level === entry.to_level) {
        process.stderr.write(TAG + ' DEDUP: skipping duplicate changelog entry for ' + entry.model + ' (' + entry.from_level + ' -> ' + entry.to_level + ')\n');
        return;
      }
    }

    changelog.push(entry);
    // Retention: trim from front to keep last 200 entries
    if (changelog.length > CHANGELOG_MAX_ENTRIES) {
      changelog = changelog.slice(changelog.length - CHANGELOG_MAX_ENTRIES);
    }
    fs.writeFileSync(CHANGELOG_PATH, JSON.stringify(changelog, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(TAG + ' WARNING: changelog write failed: ' + e.message + '\n');
  }
}

// ── Import from gate-stability.cjs ───────────────────────────────────────────

const { detectFlipFlops, isCooldownSatisfied, updateCooldownState, createUnstableEntry } = require('./gate-stability.cjs');

// ── Import from promote-gate-maturity.cjs ────────────────────────────────────

const {
  validateCriteria,
  inferSourceLayer,
  loadCheckResults,
  getModelKeys,
} = require('./promote-gate-maturity.cjs');

// ── Data loaders (fail-open) ─────────────────────────────────────────────────

function loadJSON(filePath, label) {
  if (!fs.existsSync(filePath)) {
    process.stderr.write(TAG + ' WARNING: ' + label + ' not found at ' + filePath + '\n');
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    process.stderr.write(TAG + ' WARNING: failed to parse ' + label + ': ' + e.message + '\n');
    return null;
  }
}

// ── Wiring:Evidence (Grounding L1 → L3, L2 collapsed — STRUCT-01) ───────────

function evaluateGateA(modelPath, model, layerManifest, traceMatrix, checkResults, unitTestCoverage) {
  // Path 1: layer-manifest shows has_semantic_declarations
  if (layerManifest) {
    for (const [layerName, layer] of Object.entries(layerManifest.layers || {})) {
      for (const entry of (Array.isArray(layer) ? layer : [])) {
        if (entry.path === modelPath && entry.grounding_status === 'has_semantic_declarations') {
          return { pass: true, reason: 'semantic_declarations in layer-manifest (layer: ' + layerName + ')' };
        }
      }
    }
  }

  // Path 2: model has source_layer + requirements with passing trace checks
  const sourceLayer = model.source_layer || inferSourceLayer(modelPath);
  if (!sourceLayer) return { pass: false, reason: 'no source_layer and could not infer from path' };

  const reqs = model.requirements || [];
  if (reqs.length === 0) return { pass: false, reason: 'no requirements mapped (source_layer: ' + sourceLayer + ')' };

  if (!traceMatrix || !traceMatrix.requirements) return { pass: false, reason: 'traceability-matrix missing or has no requirements section' };

  for (const reqId of reqs) {
    const reqEntry = traceMatrix.requirements[reqId];
    if (!reqEntry || !reqEntry.properties) continue;
    for (const prop of reqEntry.properties) {
      if (prop.latest_result === 'pass') return { pass: true, reason: 'passing trace for req ' + reqId + ' (property: ' + (prop.name || prop.id || 'unnamed') + ')' };
      if (checkResults.some(cr => cr.result === 'pass' && cr.requirement_ids && cr.requirement_ids.includes(reqId))) {
        return { pass: true, reason: 'passing check-result for req ' + reqId };
      }
    }
  }

  // Path 3: unit-test grounding — if ALL of this model's requirements have passing
  // unit test coverage, the model is grounded through concrete execution evidence.
  // Unit tests ARE L1 evidence (they exercise real code paths).
  if (unitTestCoverage && unitTestCoverage.requirements && reqs.length > 0) {
    const coveredReqs = reqs.filter(r => {
      const entry = unitTestCoverage.requirements[r];
      return entry && entry.covered === true;
    });
    if (coveredReqs.length === reqs.length) {
      return { pass: true, reason: 'all ' + reqs.length + ' requirement(s) grounded by unit test coverage' };
    }
    // Partial coverage: at least one requirement is test-grounded
    if (coveredReqs.length > 0) {
      return { pass: true, reason: coveredReqs.length + '/' + reqs.length + ' requirement(s) grounded by unit test coverage (partial)' };
    }
  }

  return { pass: false, reason: 'no passing traces for reqs [' + reqs.join(', ') + ']' };
}

// ── Wiring:Purpose (L3 models have requirement backing — L2 collapsed, STRUCT-01) ──

function evaluateGateB(modelPath, model, hazardModel) {
  // Path 1 (primary): any model with non-empty requirements passes Gate B.
  // This is the "purpose" check — the model has a reason to exist.
  const reqs = model.requirements || [];
  if (reqs.length > 0) {
    return { pass: true, reason: 'model has ' + reqs.length + ' requirement(s) (purpose check)' };
  }

  return { pass: false, reason: 'no requirements mapped (no purpose backing)' };
}

// ── Wiring:Coverage (Validation L3 → TC) ────────────────────────────────────

function evaluateGateC(modelPath, model, failureCatalog, testRecipes, checkResults) {
  const reqs = model.requirements || [];

  // Path 1: requirements map to failure modes that have test recipes
  if (failureCatalog && testRecipes && reqs.length > 0) {
    const recipeFailureModeIds = new Set(
      (testRecipes.recipes || []).map(r => r.failure_mode_id)
    );
    for (const fm of (failureCatalog.failure_modes || [])) {
      const derivedFrom = Array.isArray(fm.derived_from) ? fm.derived_from : (fm.derived_from ? [fm.derived_from] : []);
      const fmReqOverlap = derivedFrom.some(df =>
        df.ref && reqs.some(r => df.ref.includes(r))
      );
      if (fmReqOverlap && recipeFailureModeIds.has(fm.id)) {
        const matchedReq = reqs.find(r => derivedFrom.some(df => df.ref && df.ref.includes(r)));
        return { pass: true, reason: 'failure-mode ' + fm.id + ' has test recipe (via req ' + (matchedReq || '?') + ')' };
      }
    }
  }

  // Path 2: passing check-result matching the model path
  const modelLower = modelPath.toLowerCase();
  for (const cr of checkResults) {
    if (cr.result !== 'pass') continue;
    const toolMatch = cr.tool && modelLower.includes(cr.tool.toLowerCase());
    const checkIdPart = cr.check_id ? (cr.check_id.split(':')[1] || '') : '';
    const checkIdMatch = checkIdPart && modelLower.includes(checkIdPart.toLowerCase());
    if (toolMatch || checkIdMatch) {
      return { pass: true, reason: 'passing check-result ' + (cr.check_id || cr.tool || 'unknown') };
    }
  }

  // Build specific failure reason
  if (reqs.length === 0) return { pass: false, reason: 'no requirements mapped' };
  if (!failureCatalog) return { pass: false, reason: 'failure-mode-catalog.json missing' };
  if (!testRecipes) return { pass: false, reason: 'test-recipes.json missing' };
  return { pass: false, reason: 'no failure-mode with test recipe for reqs [' + reqs.join(', ') + '], no matching check-results' };
}

// ── Evidence readiness ────────────────────────────────────────────────────────

/**
 * Loads evidence files and scores readiness (0-5).
 * Fail-open: missing or malformed files contribute 0.
 */
function computeEvidenceReadiness() {
  if (SKIP_EVIDENCE) {
    process.stderr.write(TAG + ' Evidence loading skipped (--skip-evidence)\n');
    return { score: 0, total: 5, skipped: true, details: {} };
  }

  const checks = {
    'instrumentation-map': (d) => Array.isArray(d.actions) && d.actions.length > 0,
    'state-candidates': (d) => Array.isArray(d.candidates) && d.candidates.length > 0,
    'failure-taxonomy': (d) =>
      (Array.isArray(d.classifications) && d.classifications.length > 0) ||
      (Array.isArray(d.categories) && d.categories.length > 0),
    'trace-corpus-stats': (d) => Array.isArray(d.sessions) && d.sessions.length > 0,
    'proposed-metrics': (d) => Array.isArray(d.metrics) && d.metrics.length > 0,
  };

  const details = {};
  let score = 0;

  for (const [name, validator] of Object.entries(checks)) {
    const filePath = path.join(EVIDENCE_DIR, name + '.json');
    let ready = false;
    try {
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        ready = validator(data);
      }
    } catch (e) {
      // fail-open: malformed file contributes 0
    }
    details[name] = ready;
    if (ready) score++;
  }

  return { score, total: 5, skipped: false, details };
}

// ── Aggregate score computation ───────────────────────────────────────────────

/**
 * Computes aggregate gate scores from per-model results.
 * Exported for unit testing.
 *
 * @param {Object} perModelResults - Map of modelPath -> { gate_a, gate_b, gate_c, ... }
 * @returns {Object} aggregate - { gate_a: {...}, gate_b: {...}, gate_c: {...} }
 */
function computeAggregate(perModelResults) {
  const keys = Object.keys(perModelResults || {});
  const total = keys.length;

  let gateAPass = 0, gateBPass = 0, gateCPass = 0;
  for (const k of keys) {
    const m = perModelResults[k] || {};
    // Support both { pass, reason } objects and bare booleans (backward compat)
    const aPass = m.gate_a && typeof m.gate_a === 'object' ? m.gate_a.pass : m.gate_a;
    const bPass = m.gate_b && typeof m.gate_b === 'object' ? m.gate_b.pass : m.gate_b;
    const cPass = m.gate_c && typeof m.gate_c === 'object' ? m.gate_c.pass : m.gate_c;
    if (aPass) gateAPass++;
    if (bPass) gateBPass++;
    if (cPass) gateCPass++;
  }

  const groundingScore = total > 0 ? gateAPass / total : 0;
  const gateBScore = total > 0 ? gateBPass / total : 0;
  const gateCScore = total > 0 ? gateCPass / total : 0;

  return {
    gate_a: {
      wiring_evidence_score: groundingScore,
      target: 0.8,
      target_met: groundingScore >= 0.8,
      explained: gateAPass,
      total: total,
      unexplained_counts: {
        instrumentation_bug: 0,
        model_gap: total - gateAPass,
        genuine_violation: 0,
      },
    },
    gate_b: {
      wiring_purpose_score: gateBScore,
      total_entries: total,
      grounded_entries: gateBPass,
      orphaned_entries: total - gateBPass,
      target: 1.0,
      target_met: gateBScore >= 1.0,
    },
    gate_c: {
      wiring_coverage_score: gateCScore,
      total_entries: total,
      validated_entries: gateCPass,
      unvalidated_entries: total - gateCPass,
      target: 0.8,
      target_met: gateCScore >= 0.8,
    },
  };
}

/**
 * Writes aggregate gate results to .planning/formal/gates/ JSON files.
 * Preserves backward compatibility for cached dashboard readers.
 * No-op during --dry-run.
 */
function writeAggregateGateFiles(aggregate) {
  if (DRY_RUN_FLAG) return;

  try {
    if (!fs.existsSync(GATES_DIR)) fs.mkdirSync(GATES_DIR, { recursive: true });
  } catch (_) { /* best effort */ }

  const ts = new Date().toISOString();

  // Read-preserve-write helper: preserve semantic_score fields from prior enrichment
  function readExistingSemanticFields(gatePath) {
    try {
      const existing = JSON.parse(fs.readFileSync(gatePath, 'utf8'));
      if (existing.semantic_score != null) {
        return { semantic_score: existing.semantic_score, semantic_metadata: existing.semantic_metadata || null };
      }
    } catch (_) { /* no existing file or parse error */ }
    return null;
  }

  const gateAPath = path.join(GATES_DIR, 'gate-a-grounding.json');
  const gateBPath = path.join(GATES_DIR, 'gate-b-abstraction.json');
  const gateCPath = path.join(GATES_DIR, 'gate-c-validation.json');

  const gateASemantic = readExistingSemanticFields(gateAPath);
  const gateBSemantic = readExistingSemanticFields(gateBPath);
  const gateCSemantic = readExistingSemanticFields(gateCPath);

  const gateAFile = {
    schema_version: gateASemantic ? '3' : '2',
    generated: ts,
    ...aggregate.gate_a,
    scope: { mode: 'per-model-aggregate' },
  };
  if (gateASemantic) {
    gateAFile.semantic_score = gateASemantic.semantic_score;
    gateAFile.semantic_metadata = gateASemantic.semantic_metadata;
  }

  const gateBFile = {
    schema_version: gateBSemantic ? '3' : '2',
    generated: ts,
    ...aggregate.gate_b,
  };
  if (gateBSemantic) {
    gateBFile.semantic_score = gateBSemantic.semantic_score;
    gateBFile.semantic_metadata = gateBSemantic.semantic_metadata;
  }

  const gateCFile = {
    schema_version: gateCSemantic ? '3' : '2',
    generated: ts,
    ...aggregate.gate_c,
  };
  if (gateCSemantic) {
    gateCFile.semantic_score = gateCSemantic.semantic_score;
    gateCFile.semantic_metadata = gateCSemantic.semantic_metadata;
  }

  try { fs.writeFileSync(gateAPath, JSON.stringify(gateAFile, null, 2) + '\n'); } catch (_) {}
  try { fs.writeFileSync(gateBPath, JSON.stringify(gateBFile, null, 2) + '\n'); } catch (_) {}
  try { fs.writeFileSync(gateCPath, JSON.stringify(gateCFile, null, 2) + '\n'); } catch (_) {}
}

/**
 * Writes per-model gate detail to gates/per-model-gates.json.
 * No-op during --dry-run.
 */
function writePerModelGateFile(perModelResults, evidenceReadiness) {
  if (DRY_RUN_FLAG) return;

  try {
    if (!fs.existsSync(GATES_DIR)) fs.mkdirSync(GATES_DIR, { recursive: true });
  } catch (_) { /* best effort */ }

  // Count unstable models for header
  let unstableCount = 0;
  for (const m of Object.values(perModelResults)) {
    if (m.stability_status === 'UNSTABLE') unstableCount++;
  }

  const output = {
    schema_version: '3',
    generated: new Date().toISOString(),
    total_models: Object.keys(perModelResults).length,
    unstable_models: unstableCount,
    evidence_readiness: { score: evidenceReadiness.score, total: evidenceReadiness.total },
    models: perModelResults,
  };

  try {
    fs.writeFileSync(PER_MODEL_GATES_PATH, JSON.stringify(output, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(TAG + ' WARNING: per-model-gates.json write failed: ' + e.message + '\n');
  }
}

// ── GPROMO: Consecutive pass tracking & promotion gating ─────────────────────

/**
 * Evaluates whether a model passes the current session and computes new
 * consecutive_pass_count. A model passes when:
 *   - maturity >= 1
 *   - Evidence is not regressing (skipped, or score >= threshold for current gate)
 *   - Model is NOT in UNSTABLE or cooling-down state
 *
 * @param {Object} model - The model entry (must have gate_maturity, consecutive_pass_count)
 * @param {number} maturity - Gate maturity score (0-3) for this session
 * @param {Object} evidenceReadiness - { score, total, skipped }
 * @param {boolean} isUnstableOrCooling - Whether model is flagged UNSTABLE or cooling
 * @returns {{ passes: boolean, newCount: number }}
 */
function evaluateConsecutivePass(model, maturity, evidenceReadiness, isUnstableOrCooling) {
  const currentGate = model.gate_maturity || 'ADVISORY';
  const thresholds = { ADVISORY: 0, SOFT_GATE: 0.8, HARD_GATE: 2.5 };
  const threshold = thresholds[currentGate] || 0;

  const evidenceOk = evidenceReadiness.skipped || evidenceReadiness.score >= threshold;
  const passes = maturity >= 1 && evidenceOk && !isUnstableOrCooling;

  const prevCount = model.consecutive_pass_count || 0;
  const newCount = passes ? prevCount + 1 : 0;

  return { passes, newCount };
}

/**
 * Determines if a SOFT_GATE model is eligible for HARD_GATE promotion.
 * Requires maturity >= 3, evidence >= 3 (or skipped), consecutive_pass_count >= 3,
 * and not in UNSTABLE/cooling state.
 *
 * @param {Object} model - The model entry
 * @param {number} maturity - Gate maturity score (0-3)
 * @param {Object} evidenceReadiness - { score, total, skipped }
 * @param {boolean} isUnstableOrCooling - Whether model is flagged UNSTABLE or cooling
 * @returns {boolean}
 */
function shouldPromoteToHardGate(model, maturity, evidenceReadiness, isUnstableOrCooling) {
  if ((model.gate_maturity || 'ADVISORY') !== 'SOFT_GATE') return false;
  if (maturity < 3) return false;
  if (!evidenceReadiness.skipped && evidenceReadiness.score < 3) return false;
  if ((model.consecutive_pass_count || 0) < 3) return false;
  if (isUnstableOrCooling) return false;
  return true;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    process.stderr.write(TAG + ' ERROR: model-registry.json not found\n');
    process.exit(1);
  }

  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const models = registry.models || registry;
  const modelKeys = Object.keys(models).filter(k => k.startsWith('.'));

  const layerManifest  = loadJSON(LAYER_MANIFEST_PATH, 'layer-manifest.json');
  const traceMatrix    = loadJSON(TRACE_MATRIX_PATH, 'traceability-matrix.json');
  const hazardModel    = loadJSON(HAZARD_MODEL_PATH, 'hazard-model.json');
  const failureCatalog = loadJSON(FAILURE_CATALOG_PATH, 'failure-mode-catalog.json');
  const testRecipes    = loadJSON(TEST_RECIPES_PATH, 'test-recipes.json');
  const checkResults   = loadCheckResults();
  const unitTestCov    = loadJSON(UNIT_TEST_COV_PATH, 'unit-test-coverage.json');

  // Evidence readiness scoring
  const evidenceReadiness = computeEvidenceReadiness();

  // ── Flip-flop detection (STAB-01): run BEFORE promotion loop (Pitfall 2) ──
  let changelog = [];
  if (fs.existsSync(CHANGELOG_PATH)) {
    try {
      changelog = JSON.parse(fs.readFileSync(CHANGELOG_PATH, 'utf8'));
      if (!Array.isArray(changelog)) changelog = [];
    } catch (_) {
      changelog = [];
    }
  }
  const unstableModels = detectFlipFlops(changelog);

  // Load previous per-model-gates.json for existing stability/cooldown state
  let previousStability = {};
  if (fs.existsSync(PER_MODEL_GATES_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(PER_MODEL_GATES_PATH, 'utf8'));
      if (prev && prev.models) {
        for (const [mp, md] of Object.entries(prev.models)) {
          if (md.stability_status) {
            previousStability[mp] = {
              stability_status: md.stability_status,
              direction_changes: md.direction_changes || 0,
              flagged_at: md.flagged_at || null,
              cooldown: md.cooldown || null,
            };
          }
        }
      }
    } catch (_) { /* fail-open */ }
  }

  const perModel = {};
  const promotions = [];
  const demotions = [];
  let gateACount = 0, gateBCount = 0, gateCCount = 0;
  let totalMaturity = 0;

  for (const modelPath of modelKeys) {
    const model = models[modelPath];

    const gateAResult = evaluateGateA(modelPath, model, layerManifest, traceMatrix, checkResults, unitTestCov);
    const gateBResult = evaluateGateB(modelPath, model, hazardModel);
    const gateCResult = evaluateGateC(modelPath, model, failureCatalog, testRecipes, checkResults);

    const gateA = gateAResult.pass;
    const gateB = gateBResult.pass;
    const gateC = gateCResult.pass;

    const maturity = (gateA ? 1 : 0) + (gateB ? 1 : 0) + (gateC ? 1 : 0);

    if (gateA) gateACount++;
    if (gateB) gateBCount++;
    if (gateC) gateCCount++;
    totalMaturity += maturity;

    // Update layer_maturity in registry
    const prevMaturity = model.layer_maturity || 0;
    if (maturity > prevMaturity) {
      model.layer_maturity = maturity;
      model.last_updated = new Date().toISOString();
    }

    // Auto-promotion: ADVISORY → SOFT_GATE if maturity >= 1 and has source_layer
    const currentGate = model.gate_maturity || 'ADVISORY';
    let promoted = false;

    // Stability gate: check if model is flagged UNSTABLE or has unresolved cooldown
    const modelUnstable = unstableModels[modelPath];
    const prevStab = previousStability[modelPath];
    const isUnstableOrCooling = modelUnstable || (prevStab && prevStab.stability_status === 'UNSTABLE');

    // GPROMO-01: consecutive_pass_count tracking (increment on pass, reset on fail)
    const passEval = evaluateConsecutivePass(model, maturity, evidenceReadiness, isUnstableOrCooling);
    model.consecutive_pass_count = passEval.newCount;

    if (maturity >= 1 && currentGate === 'ADVISORY' && (evidenceReadiness.skipped || evidenceReadiness.score >= 1)) {
      // STAB-01/STAB-02: gate promotion with stability check
      if (isUnstableOrCooling) {
        const stabInfo = prevStab || (modelUnstable ? createUnstableEntry(modelUnstable.direction_changes) : null);
        if (!isCooldownSatisfied(stabInfo)) {
          const sessions = stabInfo && stabInfo.cooldown ? stabInfo.cooldown.consecutive_stable_sessions : 0;
          const reqSessions = stabInfo && stabInfo.cooldown ? stabInfo.cooldown.required_sessions : 3;
          const elapsed = stabInfo && stabInfo.flagged_at ? (Date.now() - new Date(stabInfo.flagged_at).getTime()) : 0;
          const reqWall = stabInfo && stabInfo.cooldown ? stabInfo.cooldown.required_wall_time_ms : 3600000;
          process.stderr.write(TAG + ' Promotion blocked for ' + modelPath + ': UNSTABLE, cooldown not satisfied (' + sessions + '/' + reqSessions + ' sessions, wall time ' + elapsed + '/' + reqWall + 'ms)\n');
          // Skip promotion — fall through to per-model output below
        } else {
          // Cooldown satisfied — allow promotion and reset stability
          const sourceLayer = model.source_layer || inferSourceLayer(modelPath);
          if (sourceLayer) {
            const v = validateCriteria(modelPath, model, 'SOFT_GATE', checkResults, evidenceReadiness);
            if (v.valid) {
              model.gate_maturity = 'SOFT_GATE';
              if (!model.source_layer) model.source_layer = sourceLayer;
              model.last_updated = new Date().toISOString();
              promotions.push({ model: modelPath, from: 'ADVISORY', to: 'SOFT_GATE' });
              appendChangelog({
                model: modelPath, from_level: 'ADVISORY', to_level: 'SOFT_GATE',
                timestamp: new Date().toISOString(),
                evidence_readiness: { score: evidenceReadiness.score, total: evidenceReadiness.total },
                trigger: 'auto_promotion',
              });
              promoted = true;
              // Reset stability after successful re-promotion
              previousStability[modelPath] = null;
            }
          }
        }
      } else {
        // No stability concern — normal promotion path
        const sourceLayer = model.source_layer || inferSourceLayer(modelPath);
        if (sourceLayer) {
          const v = validateCriteria(modelPath, model, 'SOFT_GATE', checkResults, evidenceReadiness);
          if (v.valid) {
            model.gate_maturity = 'SOFT_GATE';
            if (!model.source_layer) model.source_layer = sourceLayer;
            model.last_updated = new Date().toISOString();
            promotions.push({ model: modelPath, from: 'ADVISORY', to: 'SOFT_GATE' });
            appendChangelog({
              model: modelPath, from_level: 'ADVISORY', to_level: 'SOFT_GATE',
              timestamp: new Date().toISOString(),
              evidence_readiness: { score: evidenceReadiness.score, total: evidenceReadiness.total },
              trigger: 'auto_promotion',
            });
            promoted = true;
          }
        }
      }
    }

    // Auto-promotion: SOFT_GATE → HARD_GATE if maturity >= 3 and has passing check
    if (maturity >= 3 && (model.gate_maturity === 'SOFT_GATE' || (promoted && model.gate_maturity === 'SOFT_GATE')) && (evidenceReadiness.skipped || evidenceReadiness.score >= 3)) {
      // STAB-01/STAB-02: also gate HARD_GATE promotion with stability check
      let allowHardPromo = true;
      if (isUnstableOrCooling) {
        const stabInfo = prevStab || (modelUnstable ? createUnstableEntry(modelUnstable.direction_changes) : null);
        if (!isCooldownSatisfied(stabInfo)) {
          const sessions = stabInfo && stabInfo.cooldown ? stabInfo.cooldown.consecutive_stable_sessions : 0;
          const reqSessions = stabInfo && stabInfo.cooldown ? stabInfo.cooldown.required_sessions : 3;
          const elapsed = stabInfo && stabInfo.flagged_at ? (Date.now() - new Date(stabInfo.flagged_at).getTime()) : 0;
          const reqWall = stabInfo && stabInfo.cooldown ? stabInfo.cooldown.required_wall_time_ms : 3600000;
          process.stderr.write(TAG + ' Promotion blocked for ' + modelPath + ': UNSTABLE, cooldown not satisfied (' + sessions + '/' + reqSessions + ' sessions, wall time ' + elapsed + '/' + reqWall + 'ms)\n');
          allowHardPromo = false;
        }
      }
      // GPROMO-02: require consecutive_pass_count >= 3 for HARD_GATE promotion
      if (allowHardPromo && (model.consecutive_pass_count || 0) >= 3) {
        const v = validateCriteria(modelPath, model, 'HARD_GATE', checkResults, evidenceReadiness);
        if (v.valid) {
          model.gate_maturity = 'HARD_GATE';
          model.last_updated = new Date().toISOString();
          const existingPromo = promotions.find(p => p.model === modelPath);
          appendChangelog({
            model: modelPath, from_level: 'SOFT_GATE', to_level: 'HARD_GATE',
            timestamp: new Date().toISOString(),
            evidence_readiness: { score: evidenceReadiness.score, total: evidenceReadiness.total },
            consecutive_pass_count: model.consecutive_pass_count,
            trigger: 'auto_promotion',
          });
          if (existingPromo) {
            existingPromo.to = 'HARD_GATE';
          } else {
            promotions.push({ model: modelPath, from: 'SOFT_GATE', to: 'HARD_GATE' });
          }
        }
      }
    }

    // Demotion: SOFT_GATE models that no longer meet threshold
    // Hysteresis: promote at score>=1 but demote at score<0.8 to prevent oscillation at boundaries
    if (!promoted && model.gate_maturity === 'SOFT_GATE' && !evidenceReadiness.skipped) {
      if (evidenceReadiness.score < 0.8 || maturity < 0.8) {
        model.gate_maturity = 'ADVISORY';
        model.consecutive_pass_count = 0;
        model.last_updated = new Date().toISOString();
        const demotionEntry = {
          model: modelPath, from_level: 'SOFT_GATE', to_level: 'ADVISORY',
          timestamp: new Date().toISOString(),
          evidence_readiness: { score: evidenceReadiness.score, total: evidenceReadiness.total },
          trigger: 'evidence_regression',
        };
        appendChangelog(demotionEntry);
        demotions.push({ model: modelPath, from: 'SOFT_GATE', to: 'ADVISORY' });
      }
    }

    // Demotion: HARD_GATE models that no longer meet threshold
    // Hysteresis: promote at score>=3 but demote at score<2.5 to prevent oscillation at boundaries
    if (!promoted && model.gate_maturity === 'HARD_GATE' && !evidenceReadiness.skipped) {
      if (evidenceReadiness.score < 2.5 || maturity < 2.5) {
        model.gate_maturity = 'SOFT_GATE';
        model.consecutive_pass_count = 0;
        model.last_updated = new Date().toISOString();
        const demotionEntry = {
          model: modelPath, from_level: 'HARD_GATE', to_level: 'SOFT_GATE',
          timestamp: new Date().toISOString(),
          evidence_readiness: { score: evidenceReadiness.score, total: evidenceReadiness.total },
          trigger: 'evidence_regression',
        };
        appendChangelog(demotionEntry);
        demotions.push({ model: modelPath, from: 'HARD_GATE', to: 'SOFT_GATE' });
      }
    }

    // ── Stability fields (STAB-01/STAB-02) ──
    let stabilityStatus = 'STABLE';
    let directionChanges = 0;
    let cooldownData = null;

    if (modelUnstable) {
      // Freshly detected as unstable this run
      directionChanges = modelUnstable.direction_changes;
      if (prevStab && prevStab.stability_status === 'UNSTABLE') {
        // Update existing cooldown state
        const updated = updateCooldownState(prevStab, maturity, 1);
        stabilityStatus = updated.stability_status;
        cooldownData = updated.cooldown;
      } else {
        // New unstable entry
        const fresh = createUnstableEntry(directionChanges);
        stabilityStatus = fresh.stability_status;
        cooldownData = fresh.cooldown;
      }
    } else if (prevStab && prevStab.stability_status === 'UNSTABLE') {
      // Previously unstable, not flagged this run — update cooldown
      directionChanges = prevStab.direction_changes || 0;
      const updated = updateCooldownState(prevStab, maturity, 1);
      if (isCooldownSatisfied(updated)) {
        stabilityStatus = 'STABLE';
        cooldownData = null;
      } else {
        stabilityStatus = updated.stability_status;
        cooldownData = updated.cooldown;
      }
    }

    perModel[modelPath] = {
      gate_a: { pass: gateA, reason: gateAResult.reason },
      gate_b: { pass: gateB, reason: gateBResult.reason },
      gate_c: { pass: gateC, reason: gateCResult.reason },
      layer_maturity: model.layer_maturity || maturity,
      gate_maturity: model.gate_maturity || 'ADVISORY',
      consecutive_pass_count: model.consecutive_pass_count || 0,
      promoted,
      stability_status: stabilityStatus,
      direction_changes: directionChanges,
      cooldown: cooldownData,
    };
    // Preserve flagged_at for UNSTABLE models
    if (stabilityStatus === 'UNSTABLE') {
      perModel[modelPath].flagged_at = (prevStab && prevStab.flagged_at) || (modelUnstable && modelUnstable.flagged_at) || new Date().toISOString();
    }
  }

  // Write back unless dry-run
  if (!DRY_RUN_FLAG) {
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
  }

  // Compute aggregate gate scores when --aggregate is set
  let aggregate = null;
  if (AGGREGATE_FLAG) {
    aggregate = computeAggregate(perModel);
    writeAggregateGateFiles(aggregate);
  }

  // Persist per-model gate detail when --write-per-model is set
  if (WRITE_PER_MODEL_FLAG) {
    writePerModelGateFile(perModel, evidenceReadiness);
  }

  const avgMaturity = modelKeys.length > 0 ? +(totalMaturity / modelKeys.length).toFixed(2) : 0;

  const output = {
    generated: new Date().toISOString(),
    total_models: modelKeys.length,
    scores: {
      gate_a_pass: gateACount,
      gate_b_pass: gateBCount,
      gate_c_pass: gateCCount,
      avg_layer_maturity: avgMaturity,
    },
    evidence_readiness: evidenceReadiness,
    promotions,
    demotions,
    per_model: perModel,
  };

  if (AGGREGATE_FLAG) {
    output.aggregate = aggregate;
  }

  if (JSON_FLAG) {
    process.stdout.write(JSON.stringify(output));
  } else {
    console.log('Per-Model Gate Maturity Scoring');
    console.log('  Total models: ' + modelKeys.length);
    console.log('  Wiring:Evidence pass: ' + gateACount);
    console.log('  Wiring:Purpose pass: ' + gateBCount);
    console.log('  Wiring:Coverage pass: ' + gateCCount);
    console.log('  Avg layer_maturity: ' + avgMaturity);
    if (promotions.length > 0) {
      console.log('  Promotions:');
      for (const p of promotions) {
        console.log('    ' + p.model + ': ' + p.from + ' -> ' + p.to);
      }
    }
    if (AGGREGATE_FLAG && aggregate) {
      console.log('');
      console.log('  Aggregate Gate Scores:');
      console.log('    Wiring:Evidence score: ' + aggregate.gate_a.wiring_evidence_score.toFixed(4) + ' (target: 0.8, met: ' + aggregate.gate_a.target_met + ')');
      console.log('    Wiring:Purpose score:  ' + aggregate.gate_b.wiring_purpose_score.toFixed(4) + ' (target: 1.0, met: ' + aggregate.gate_b.target_met + ')');
      console.log('    Wiring:Coverage score: ' + aggregate.gate_c.wiring_coverage_score.toFixed(4) + ' (target: 0.8, met: ' + aggregate.gate_c.target_met + ')');
    }
    if (DRY_RUN_FLAG) {
      console.log('  (dry-run: no changes written)');
    }
  }
}

// Export for unit testing when require()'d
if (require.main === module) {
  main();
}

module.exports = { computeAggregate, writePerModelGateFile, evaluateConsecutivePass, shouldPromoteToHardGate };

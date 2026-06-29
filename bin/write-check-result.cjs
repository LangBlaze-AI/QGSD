'use strict';

const fs   = require('fs');
const path = require('path');

const VALID_RESULTS    = ['pass', 'fail', 'error', 'warn', 'inconclusive'];
const VALID_FORMALISMS = ['tla', 'alloy', 'prism', 'trace', 'redaction', 'petri'];

/**
 * Path to the NDJSON output file.
 * Priority: CHECK_RESULTS_PATH (exact path) > CHECK_RESULTS_ROOT (root-relative) > __dirname fallback.
 * Use CHECK_RESULTS_PATH env var to redirect in tests (avoids polluting real output).
 * Use CHECK_RESULTS_ROOT env var when --project-root is set (writes to ROOT/.planning/formal/).
 */
const NDJSON_PATH = process.env.CHECK_RESULTS_PATH ||
  (process.env.CHECK_RESULTS_ROOT
    ? path.join(process.env.CHECK_RESULTS_ROOT, '.planning', 'formal', 'check-results.ndjson')
    : path.join(__dirname, '..', '.planning', 'formal', 'check-results.ndjson'));

/**
 * Append one normalized check result line to .planning/formal/check-results.ndjson.
 *
 * @param {Object} entry
 * @param {string} entry.tool       - Name of the tool/runner (e.g. 'run-tlc')
 * @param {string} entry.formalism  - One of VALID_FORMALISMS
 * @param {string} entry.result     - One of VALID_RESULTS
 * @param {string} entry.check_id   - Unique step identifier (e.g. 'tla:quorum-safety'), required
 * @param {string} entry.surface    - STEPS tool group (e.g. 'tla', 'alloy', 'prism', 'ci'), required
 * @param {string} entry.property   - Human-readable check description, required
 * @param {number} entry.runtime_ms - Wall-clock elapsed milliseconds from tool start to this call, required. Stored as Math.round(runtime_ms) integer.
 * @param {string} entry.summary    - One-line outcome (e.g. 'pass: MCsafety in 1823ms'), required
 * @param {string[]} [entry.triage_tags] - Optional anomaly tags. Defaults to [].
 * @param {object} [entry.observation_window] - Optional stochastic check window metadata (PRISM-critical). Contains { window_start, window_end, n_traces, n_events, window_days }.
 * @param {string[]} [entry.requirement_ids] - Optional array of requirement IDs this check covers. Defaults to [].
 * @param {string} [entry.failure_class] - Optional TLC failure classification ('deadlock', 'sany_semantic', 'fairness_gap', 'invariant_violation', 'syntax_error', 'unknown').
 * @param {Object} [entry.metadata] - Optional extra fields (spec, config, etc.)
 * @throws {Error} On validation failure
 */
function writeCheckResult(entry) {
  if (!entry || typeof entry.tool !== 'string' || entry.tool.length === 0) {
    throw new Error('[write-check-result] tool is required and must be a non-empty string');
  }
  if (!VALID_FORMALISMS.includes(entry.formalism)) {
    throw new Error(
      '[write-check-result] formalism must be one of: ' + VALID_FORMALISMS.join(', ') +
      ' (got: ' + entry.formalism + ')'
    );
  }
  if (!VALID_RESULTS.includes(entry.result)) {
    throw new Error(
      '[write-check-result] result must be one of: ' + VALID_RESULTS.join(', ') +
      ' (got: ' + entry.result + ')'
    );
  }

  // v2.1 required field validations
  if (typeof entry.check_id !== 'string' || entry.check_id.length === 0) {
    throw new Error('[write-check-result] check_id is required and must be a non-empty string');
  }
  if (typeof entry.surface !== 'string' || entry.surface.length === 0) {
    throw new Error('[write-check-result] surface is required and must be a non-empty string');
  }
  if (typeof entry.property !== 'string' || entry.property.length === 0) {
    throw new Error('[write-check-result] property is required and must be a non-empty string');
  }
  if (typeof entry.runtime_ms !== 'number' || !Number.isFinite(entry.runtime_ms)) {
    throw new Error('[write-check-result] runtime_ms is required and must be a finite number');
  }
  if (typeof entry.summary !== 'string' || entry.summary.length === 0) {
    throw new Error('[write-check-result] summary is required and must be a non-empty string');
  }

  // requirement_ids: optional array of requirement IDs this check covers
  if (entry.requirement_ids !== undefined) {
    if (!Array.isArray(entry.requirement_ids)) {
      throw new Error('[write-check-result] requirement_ids must be an array');
    }
    for (const id of entry.requirement_ids) {
      if (typeof id !== 'string') {
        throw new Error('[write-check-result] requirement_ids must contain only strings (got: ' + typeof id + ')');
      }
    }
  }

  // failure_class: optional TLC failure classification
  if (entry.failure_class !== undefined) {
    const VALID_FAILURE_CLASSES = ['deadlock', 'sany_semantic', 'fairness_gap', 'invariant_violation', 'syntax_error', 'unknown'];
    if (!VALID_FAILURE_CLASSES.includes(entry.failure_class)) {
      throw new Error('[write-check-result] failure_class must be one of: ' + VALID_FAILURE_CLASSES.join(', ') + ' (got: ' + entry.failure_class + ')');
    }
  }

  const record = {
    tool:       entry.tool,
    formalism:  entry.formalism,
    result:     entry.result,
    timestamp:  new Date().toISOString(),
    check_id:   entry.check_id,
    surface:    entry.surface,
    property:   entry.property,
    runtime_ms: Math.round(entry.runtime_ms),
    summary:    entry.summary,
    triage_tags: entry.triage_tags || [],
    requirement_ids: Array.isArray(entry.requirement_ids) ? entry.requirement_ids : [],
    metadata:   (entry.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata)) ? entry.metadata : {},
  };

  if (entry.observation_window !== undefined) {
    record.observation_window = entry.observation_window;
  }

  if (entry.failure_class !== undefined) {
    record.failure_class = entry.failure_class;
  }

  fs.mkdirSync(path.dirname(NDJSON_PATH), { recursive: true });
  fs.appendFileSync(NDJSON_PATH, JSON.stringify(record) + '\n', 'utf8');
}

module.exports = { writeCheckResult, NDJSON_PATH, VALID_RESULTS, VALID_FORMALISMS };

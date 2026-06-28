'use strict';

/**
 * TLC failure classifier
 *
 * Classifies TLC check-results.ndjson entries into 6 failure categories:
 * - deadlock
 * - sany_semantic
 * - fairness_gap
 * - invariant_violation
 * - syntax_error
 * - unknown
 */

const FAILURE_CLASSES = [
  'deadlock',
  'sany_semantic',
  'fairness_gap',
  'invariant_violation',
  'syntax_error',
  'unknown',
];

/**
 * Classify a TLC check result entry.
 *
 * @param {Object|null|undefined} entry - A check-results.ndjson entry object
 * @returns {string} One of FAILURE_CLASSES
 */
function classifyTlcFailure(entry) {
  // Defensive: handle null/undefined entry
  if (!entry || typeof entry !== 'object') {
    return 'unknown';
  }

  // Extract fields safely
  const summary = (typeof entry.summary === 'string' ? entry.summary : '').toLowerCase();
  const result = entry.result || '';
  const property = (typeof entry.property === 'string' ? entry.property : '').toLowerCase();
  const metadata = (entry.metadata && typeof entry.metadata === 'object') ? entry.metadata : {};

  // 1. deadlock
  if (summary.includes('deadlock reached') || (summary.includes('deadlock') && result === 'fail')) {
    return 'deadlock';
  }

  // 2. sany_semantic
  if (summary.includes('semantic error') ||
      summary.includes('multiply-defined symbol') ||
      summary.includes('multiply defined') ||
      (metadata.error_type === 'semantic')) {
    return 'sany_semantic';
  }

  // 3. fairness_gap
  if (summary.includes('temporal properties were violated') ||
      ((summary.includes('temporal') || summary.includes('liveness')) &&
       (summary.includes('stuttering') || metadata.trace_type === 'stuttering')) ||
      (property.includes('liveness') && result === 'fail' && summary.includes('stuttering'))) {
    return 'fairness_gap';
  }

  // 4. syntax_error
  if (summary.includes('syntax error') ||
      summary.includes('parse error') ||
      (result === 'error' && summary.includes('sany') && !summary.includes('semantic'))) {
    return 'syntax_error';
  }

  // 5. invariant_violation
  if ((result === 'fail' && summary.includes('invariant')) ||
      (result === 'fail' && summary.includes('counterexample'))) {
    return 'invariant_violation';
  }

  // 6. unknown (fallback)
  return 'unknown';
}

module.exports = {
  classifyTlcFailure,
  FAILURE_CLASSES,
};

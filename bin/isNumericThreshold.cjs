/**
 * Numeric threshold heuristic for P->F residual layer
 * Determines if a formal_ref points to a numeric parameter (auto-updatable)
 * vs a correctness invariant (requires investigation)
 */

'use strict';

const { parseFormalRef } = require('./extractFormalExpected.cjs');
const { extractFormalExpected } = require('./extractFormalExpected.cjs');

/**
 * Check if a formal_ref points to a numeric threshold/parameter
 * @param {string} formalRef - Formal reference string
 * @param {object} [options]
 * @param {string} [options.specDir] - Override spec directory (for testing)
 * @returns {boolean} true if the ref points to a numeric value
 */
function isNumericThreshold(formalRef, options = {}) {
  const parsed = parseFormalRef(formalRef);
  if (!parsed) return false;

  // Requirements are text, not numeric thresholds
  if (parsed.type === 'requirement') return false;

  // Spec without param key = invariant reference
  if (parsed.type === 'spec' && !parsed.param) return false;

  // Try to extract the value and check if it is numeric (fail-open on any error)
  let value;
  try {
    value = extractFormalExpected(formalRef, options);
  } catch {
    return false;
  }
  return Number.isFinite(value);
}

module.exports = { isNumericThreshold };

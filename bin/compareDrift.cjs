/**
 * Drift comparison helper for P->F residual layer
 * Compares a debt entry's production measurement against a formal expected value
 * Fail-open: returns false when either value is null/missing
 */

'use strict';

/**
 * Compare production measurement against formal expected value
 * @param {object} entry - Debt entry with meta.measured_value
 * @param {*} formalExpected - Expected value from formal model
 * @returns {boolean} true if measured differs from expected (divergent), false otherwise
 */
function compareDrift(entry, formalExpected) {
  const measured = entry?.meta?.measured_value;
  if (measured == null || formalExpected == null) return false;
  if (Number.isNaN(measured) || Number.isNaN(formalExpected)) return false;
  return measured !== formalExpected;
}

module.exports = { compareDrift };

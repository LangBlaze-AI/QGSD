'use strict';

/**
 * Resolves the primary score from gate data, handling v1/v2 schema differences.
 * v2 fields are preferred; v1 fields are fallback.
 *
 * @param {Object} gateData - Raw gate JSON data
 * @param {'a'|'b'|'c'} gateName - Which gate to resolve
 * @returns {number} Score value, or 0 if neither field present
 * @see STRUCT-03
 */
function resolveGateScore(gateData, gateName) {
  if (!gateData) return 0;
  switch (gateName) {
    case 'a': return gateData.wiring_evidence_score ?? gateData.grounding_score ?? 0;
    case 'b': return gateData.wiring_purpose_score ?? gateData.gate_b_score ?? 0;
    case 'c': return gateData.wiring_coverage_score ?? gateData.gate_c_score ?? 0;
    default: return 0;
  }
}

module.exports = { resolveGateScore };

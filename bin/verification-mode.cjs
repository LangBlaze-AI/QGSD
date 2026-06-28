#!/usr/bin/env node
'use strict';

/**
 * verification-mode.cjs
 *
 * Verification mode tagging for model checker invocations.
 * Enables Cycle 1 (diagnostic, inverted semantics) and Cycle 2 (validation, normal semantics)
 * to coexist without mode contradiction.
 *
 * Module exports:
 *   { MODES, createVerificationEnvelope, interpretGateResult }
 */

/**
 * Supported verification modes
 */
const MODES = {
  DIAGNOSTIC: 'diagnostic',
  VALIDATION: 'validation'
};

/**
 * Create a verification envelope with mode tagging.
 * Validates that verification_mode (if provided) is one of the supported modes.
 *
 * @param {Object} options - Configuration object
 * @param {string} [options.verification_mode] - 'diagnostic' or 'validation' (default: 'validation')
 * @param {string} options.modelPath - Path to the formal model
 * @param {Object} options.config - Configuration context
 * @param {string} [options.bugContext] - Bug context for diagnostic mode
 * @param {boolean} [options.dumpTrace] - Whether to dump trace
 * @returns {Object} Same object with verification_mode set, defaults to 'validation'
 * @throws {Error} If verification_mode is an invalid non-null value
 */
function createVerificationEnvelope(options) {
  options = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};

  const mode = options.verification_mode || 'validation';

  // Validate mode
  if (mode !== null && mode !== undefined) {
    const validModes = Object.values(MODES);
    if (!validModes.includes(mode)) {
      throw new Error(`Invalid verification_mode: "${mode}". Must be one of: ${validModes.join(', ')}`);
    }
  }

  return {
    ...options,
    verification_mode: mode || 'validation'
  };
}

/**
 * Interpret a checker result based on the verification mode and violation status.
 * Implements the four-cell truth table:
 *   - diagnostic + violation = 'REPRODUCED' (model captures bug — success)
 *   - diagnostic + no violation = 'INCOMPLETE' (model missing the bug — failure)
 *   - validation + violation = 'FAILED' (invariant broken)
 *   - validation + no violation = 'PASSED' (consequence model valid)
 *
 * @param {boolean} hasViolation - Whether the checker found a violation
 * @param {string} verification_mode - 'diagnostic' or 'validation'
 * @returns {string} Semantic outcome: 'REPRODUCED', 'INCOMPLETE', 'FAILED', or 'PASSED'
 * @throws {Error} If verification_mode is unknown
 */
function interpretGateResult(hasViolation, verification_mode) {
  if (typeof hasViolation !== 'boolean') {
    throw new Error(`hasViolation must be a boolean, got: ${typeof hasViolation}`);
  }
  if (verification_mode === MODES.DIAGNOSTIC) {
    return hasViolation ? 'REPRODUCED' : 'INCOMPLETE';
  } else if (verification_mode === MODES.VALIDATION) {
    return hasViolation ? 'FAILED' : 'PASSED';
  } else {
    throw new Error(`Unknown verification_mode: "${verification_mode}"`);
  }
}

// Module exports
module.exports = {
  MODES,
  createVerificationEnvelope,
  interpretGateResult
};

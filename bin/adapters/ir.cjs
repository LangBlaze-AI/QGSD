'use strict';
// bin/adapters/ir.cjs
// MachineIR schema definition and validateIR() validator.
// Shared intermediate representation for all FSM adapters.

/**
 * @typedef {Object} MachineIR
 * @property {string} machineId - e.g. "nf-workflow"
 * @property {string} initial - initial state name
 * @property {string[]} stateNames - all states
 * @property {string[]} finalStates - absorbing states (may be empty)
 * @property {Array<{fromState: string, event: string, guard: string|null, target: string|null, assignedKeys: string[]}>} transitions
 * @property {string[]} ctxVars - context variable names (post skip-filter)
 * @property {Object} ctxDefaults - var -> default value
 * @property {string} sourceFile - relative path to source
 * @property {string} framework - adapter id (e.g. "xstate-v5")
 */

/**
 * Validate a MachineIR object.
 * @param {MachineIR} ir
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateIR(ir) {
  const errors = [];

  if (!ir || typeof ir !== 'object') {
    return { valid: false, errors: ['IR must be a non-null object'] };
  }

  // Required string fields
  for (const field of ['machineId', 'initial', 'sourceFile', 'framework']) {
    if (typeof ir[field] !== 'string' || ir[field].length === 0) {
      errors.push(`"${field}" must be a non-empty string`);
    }
  }

  // Required array fields
  for (const field of ['stateNames', 'finalStates', 'ctxVars']) {
    if (!Array.isArray(ir[field])) {
      errors.push(`"${field}" must be an array`);
    }
  }

  // transitions must be an array
  if (!Array.isArray(ir.transitions)) {
    errors.push('"transitions" must be an array');
  }

  // ctxDefaults must be an object
  if (!ir.ctxDefaults || typeof ir.ctxDefaults !== 'object' || Array.isArray(ir.ctxDefaults)) {
    errors.push('"ctxDefaults" must be a plain object');
  }

  // Stop here if structural errors — further checks depend on valid structure
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // initial must be in stateNames
  if (!ir.stateNames.includes(ir.initial)) {
    errors.push(`"initial" ("${ir.initial}") is not in stateNames`);
  }

  // finalStates must all be in stateNames
  for (const fs of ir.finalStates) {
    if (!ir.stateNames.includes(fs)) {
      errors.push(`finalState "${fs}" is not in stateNames`);
    }
  }

  // Validate each transition
  for (let i = 0; i < ir.transitions.length; i++) {
    const t = ir.transitions[i];
    if (!t || typeof t !== 'object') {
      errors.push(`transitions[${i}] must be an object`);
      continue;
    }
    if (typeof t.fromState !== 'string') {
      errors.push(`transitions[${i}].fromState must be a string`);
    } else if (!ir.stateNames.includes(t.fromState)) {
      errors.push(`transitions[${i}].fromState "${t.fromState}" is not in stateNames`);
    }
    if (typeof t.event !== 'string') {
      errors.push(`transitions[${i}].event must be a string`);
    }
    if (t.target !== null && typeof t.target !== 'string') {
      errors.push(`transitions[${i}].target must be a string or null`);
    } else if (t.target !== null && !ir.stateNames.includes(t.target)) {
      errors.push(`transitions[${i}].target "${t.target}" is not in stateNames`);
    }
    if (t.guard !== null && typeof t.guard !== 'string') {
      errors.push(`transitions[${i}].guard must be a string or null`);
    }
    if (!Array.isArray(t.assignedKeys)) {
      errors.push(`transitions[${i}].assignedKeys must be an array`);
    } else if (t.assignedKeys.some(k => typeof k !== 'string')) {
      errors.push(`transitions[${i}].assignedKeys must contain only strings`);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateIR };

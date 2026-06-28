'use strict';
// bin/adapters/scaffold-config.cjs
// Generates starter config JSON from a MachineIR.

/**
 * Generate a starter config object matching the guards/vars config format.
 * @param {import('./ir.cjs').MachineIR} ir
 * @returns {Object} config object with guards and vars keys
 */
function scaffoldConfig(ir) {
  const guards = {};
  const vars = {};

  if (!ir || typeof ir !== 'object') return { guards, vars };

  // Collect unique guard names from transitions
  const transitions = Array.isArray(ir.transitions) ? ir.transitions : [];
  const guardNames = new Set();
  for (const t of transitions) {
    if (t && t.guard) guardNames.add(t.guard);
  }
  for (const g of guardNames) {
    guards[g] = 'TRUE  \\* FIXME: provide TLA+ expression for ' + g;
  }

  // Generate var entries for each ctxVar
  const ctxVars = Array.isArray(ir.ctxVars) ? ir.ctxVars : [];
  for (const v of ctxVars) {
    vars[v] = "FIXME: 'skip' | 'const' | 'event' | TLA+ expression";
  }

  return { guards, vars };
}

module.exports = { scaffoldConfig };

'use strict';
// bin/adapters/emitter-tla.cjs
// TLA+ emitter consuming MachineIR.
// Extracted from bin/xstate-to-tla.cjs — generates .tla and .cfg files.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

// ── Helpers ─────────────────────────────────────────────────────────────────

function toCamel(s) {
  return s.toLowerCase()
    .split(/[_\s]+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

function genUnchanged(ctxVars, assignedInThisTrans) {
  const unchanged = ctxVars.filter(v => !assignedInThisTrans.includes(v));
  if (unchanged.length === 0) return null;
  if (unchanged.length === 1) return unchanged[0];
  return '<<' + unchanged.join(', ') + '>>';
}

function genAssignLine(varName, isParam, userVars) {
  if (isParam) return "    /\\ " + varName + "' = " + varName + '  \\* param from event';
  const ann = userVars[varName];
  if (ann && ann !== 'const' && ann !== 'event' && ann !== 'skip') {
    return "    /\\ " + varName + "' = " + ann;
  }
  return "    /\\ " + varName + "' = " + varName + '  \\* FIXME: XState assign for ' + varName;
}

// Bug #1 fix: short aliases for event params to avoid shadowing module-level VARIABLES
const paramAliasMap = {};
let aliasCounter = 0;
function getParamAlias(varName) {
  if (!paramAliasMap[varName]) {
    const initials = varName.replace(/[a-z]/g, '').toLowerCase() ||
                     varName.slice(0, 2);
    paramAliasMap[varName] = initials || ('p' + aliasCounter++);
  }
  return paramAliasMap[varName];
}

function genAction(t, ctxVars, userVars, userGuards) {
  const lines = [];
  const cc = t.actionName;

  const params = t.assignedKeys.filter(k => userVars[k] === 'event');
  const nonParamAssigned = t.assignedKeys.filter(k => userVars[k] !== 'event' && userVars[k] !== 'skip');

  const aliases = params.map(p => getParamAlias(p));
  const paramStr = aliases.length > 0 ? '(' + aliases.join(', ') + ')' : '';

  lines.push('\\* ' + t.fromState + ' -[' + t.event + (t.guard ? ' / ' + t.guard : '') + ']-> ' + (t.target || '?'));
  lines.push(cc + paramStr + ' ==');
  lines.push('    /\\ state = "' + t.fromState + '"');

  if (t.guard) {
    let tlaGuard = userGuards[t.guard];
    if (tlaGuard) {
      for (let i = 0; i < params.length; i++) {
        tlaGuard = tlaGuard.replace(new RegExp('\\b' + params[i] + '\\b', 'g'), aliases[i]);
      }
      lines.push('    /\\ ' + tlaGuard);
    } else {
      lines.push('    /\\ TRUE  \\* FIXME: guard ' + t.guard + ' — add to config guards');
    }
  }

  if (t.target) {
    lines.push("    /\\ state' = \"" + t.target + '"');
  } else {
    lines.push("    /\\ state' = state  \\* FIXME: unknown target");
  }

  for (let i = 0; i < params.length; i++) {
    lines.push("    /\\ " + params[i] + "' = " + aliases[i] + '  \\* param from event');
  }
  for (const v of nonParamAssigned) {
    lines.push(genAssignLine(v, false, userVars));
  }

  const unch = genUnchanged(ctxVars, t.assignedKeys);
  if (unch) lines.push('    /\\ UNCHANGED ' + unch);

  return lines.join('\n');
}

function genFinalStateOps(stateName, ir, ctxVars) {
  const result = [];
  const unchangedStr = ctxVars.length > 0
    ? '    /\\ UNCHANGED <<' + ctxVars.join(', ') + '>>'
    : null;

  // Check if there are transitions from this final state (self-loops)
  const finalTrans = ir.transitions.filter(t => t.fromState === stateName);
  const eventNames = [...new Set(finalTrans.map(t => t.event))];

  for (const eventName of eventNames) {
    const opName = toCamel(stateName) + toCamel(eventName);
    const lines = [
      '\\* ' + stateName + ' -[' + eventName + ']-> ' + stateName + ' (self-loop in final state)',
      opName + ' ==',
      '    /\\ state = "' + stateName + '"',
      "    /\\ state' = \"" + stateName + '"',
    ];
    if (unchangedStr) lines.push(unchangedStr);
    result.push({ name: opName, tla: lines.join('\n') });
  }

  // Catch-all self-loop
  const catchAll = [
    '\\* ' + stateName + ' is a final (absorbing) state',
    'Stay' + stateName + ' ==',
    '    /\\ state = "' + stateName + '"',
    "    /\\ state' = \"" + stateName + '"',
  ];
  if (unchangedStr) catchAll.push(unchangedStr);
  result.push({ name: 'Stay' + stateName, tla: catchAll.join('\n') });

  return result;
}

// ── Main emitter ────────────────────────────────────────────────────────────

/**
 * Emit TLA+ spec and .cfg from a MachineIR.
 * @param {import('./ir.cjs').MachineIR} ir
 * @param {Object} options
 * @param {string} [options.moduleName]
 * @param {string} [options.configPath]
 * @param {Object} [options.userGuards]
 * @param {Object} [options.userVars]
 * @param {string} [options.outDir]
 * @param {boolean} [options.dry]
 * @param {string} [options.sourceFile]
 * @returns {{ tlaContent: string, cfgContent: string, tlaOutPath: string, cfgOutPath: string }}
 */
function emitTLA(ir, options = {}) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) options = {};

  // Validate IR
  const validation = validateIR(ir);
  if (!validation.valid) {
    throw new Error('Invalid MachineIR: ' + validation.errors.join('; '));
  }

  const {
    moduleName: moduleNameOpt,
    userGuards: userGuardsOpt,
    userVars: userVarsOpt,
    outDir: outDirOpt,
    dry = false,
    sourceFile = ir.sourceFile,
  } = options;

  const userGuards = userGuardsOpt && typeof userGuardsOpt === 'object' && !Array.isArray(userGuardsOpt) ? userGuardsOpt : {};
  const userVars = userVarsOpt && typeof userVarsOpt === 'object' && !Array.isArray(userVarsOpt) ? userVarsOpt : {};

  const moduleName = moduleNameOpt || ir.machineId
    .split(/[-_\s]+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');

  const ctxVars = ir.ctxVars;
  const ctxDefaults = ir.ctxDefaults;
  const stateNames = ir.stateNames;
  const finalStates = ir.finalStates;
  const allTransitions = ir.transitions;

  // ── Action name derivation ──────────────────────────────────────────────
  const branchCount = {};
  for (const t of allTransitions) {
    const k = t.fromState + '::' + t.event;
    branchCount[k] = (branchCount[k] || 0) + 1;
  }

  const eventStateSet = {};
  for (const t of allTransitions) {
    if (!eventStateSet[t.event]) eventStateSet[t.event] = new Set();
    eventStateSet[t.event].add(t.fromState);
  }

  const seenActionNames = {};
  for (const t of allTransitions) {
    const cc          = toCamel(t.event);
    const multiState  = eventStateSet[t.event].size > 1;
    const statePrefix = multiState ? toCamel(t.fromState) : '';
    const k           = t.fromState + '::' + t.event;
    const multiBranch = branchCount[k] > 1;

    if (multiBranch) {
      let name = statePrefix + cc + 'To' + (t.target || 'Unknown');
      if (seenActionNames[name]) {
        if (t.guard) {
          name = name + toCamel(t.guard);
        } else {
          name = name.replace(/To(\w+)$/, 'FallbackTo$1');
        }
      }
      seenActionNames[name] = true;
      t.actionName = name;
    } else {
      t.actionName = statePrefix + cc;
      seenActionNames[t.actionName] = true;
    }
  }

  // ── TLA+ generation ───────────────────────────────────────────────────────
  const ts_date = new Date().toISOString().split('T')[0];
  const outDir = outDirOpt
    ? path.resolve(outDirOpt)
    : path.join(__dirname, '..', '..', '.planning', 'formal', 'tla');

  const varsTuple = ['state', ...ctxVars].length === 1
    ? 'state'
    : '<<state, ' + ctxVars.join(', ') + '>>';

  const lines = [
    '---- MODULE ' + moduleName + '_xstate ----',
    '(*',
    ' * .planning/formal/tla/' + moduleName + '_xstate.tla',
    ' * GENERATED by bin/fsm-to-tla.cjs',
    ' * Source: ' + sourceFile,
    ' * Regenerate: node bin/fsm-to-tla.cjs ' + sourceFile +
        ' --module=' + moduleName,
    ' * Generated: ' + ts_date,
    ' *',
    ' * Machine id: ' + ir.machineId,
    ' * Framework:  ' + ir.framework,
    ' * Initial state:     ' + ir.initial,
    ' * States (' + stateNames.length + '):          ' + stateNames.join(', '),
    ' * Final states:      ' + (finalStates.length ? finalStates.join(', ') : '(none)'),
    '*)',
    'EXTENDS Naturals, FiniteSets, TLC',
    '',
    '\\* ── Constants (model-checking bounds) ────────────────────────────────────────',
    'CONSTANTS MaxBound  \\* upper bound for event parameter quantifiers',
    '',
    '\\* ── Variables ────────────────────────────────────────────────────────────────',
    'VARIABLES',
    '    state' + (ctxVars.length > 0 ? ',' : '') + '  \\* FSM state',
    ...ctxVars.map((v, i) => {
      const ann  = userVars[v] || '(no annotation)';
      const dflt = ctxDefaults[v];
      return '    ' + v + (i < ctxVars.length - 1 ? ',' : '') +
        '  \\* default: ' + JSON.stringify(dflt) + '  annotation: ' + ann;
    }),
    '',
    'vars == ' + varsTuple,
    '',
    '\\* ── Type invariant ────────────────────────────────────────────────────────────',
    '\\* @requirement QUORUM-01',
    'TypeOK ==',
    '    /\\ state \\in {' + stateNames.map(s => '"' + s + '"').join(', ') + '}',
    ...ctxVars.map(v => {
      const dflt = ctxDefaults[v];
      if (typeof dflt === 'number')  return '    /\\ ' + v + ' \\in Nat  \\* FIXME: tighten bound if needed';
      if (typeof dflt === 'string')  return '    /\\ ' + v + ' \\in STRING';
      if (typeof dflt === 'boolean') return '    /\\ ' + v + ' \\in BOOLEAN';
      return '    /\\ TRUE  \\* FIXME: type for ' + v;
    }),
    '',
    '\\* ── Initial state ─────────────────────────────────────────────────────────────',
    'Init ==',
    '    /\\ state = "' + ir.initial + '"',
    ...ctxVars.map(v => {
      const dflt = ctxDefaults[v];
      if (typeof dflt === 'string')  return '    /\\ ' + v + " = \"" + dflt + '"';
      if (typeof dflt === 'number')  return '    /\\ ' + v + ' = ' + dflt;
      if (typeof dflt === 'boolean') return '    /\\ ' + v + ' = ' + (dflt ? 'TRUE' : 'FALSE');
      return '    /\\ ' + v + ' = 0  \\* FIXME: initial value';
    }),
    '',
    '\\* ── Actions ────────────────────────────────────────────────────────────────────',
  ];

  // Non-final state transitions
  for (const stateName of stateNames) {
    if (!finalStates.includes(stateName)) {
      const stateTrans = allTransitions.filter(t => t.fromState === stateName);
      for (const t of stateTrans) {
        lines.push('');
        lines.push(genAction(t, ctxVars, userVars, userGuards));
      }
    }
  }

  // Final state self-loops
  const finalStateOps = {};
  for (const s of finalStates) {
    finalStateOps[s] = genFinalStateOps(s, ir, ctxVars);
  }

  for (const stateName of finalStates) {
    for (const op of finalStateOps[stateName]) {
      lines.push('');
      lines.push(op.tla);
    }
  }

  // All unique action names
  const actionNames = [];
  for (const t of allTransitions) {
    if (!actionNames.includes(t.actionName)) actionNames.push(t.actionName);
  }
  for (const s of finalStates) {
    for (const op of finalStateOps[s]) {
      if (!actionNames.includes(op.name)) actionNames.push(op.name);
    }
  }

  // Next
  lines.push('');
  lines.push('\\* ── Next ──────────────────────────────────────────────────────────────────────');
  lines.push('Next ==');
  for (const t of allTransitions) {
    if (finalStates.includes(t.fromState)) continue;
    const params = t.assignedKeys.filter(k => userVars[k] === 'event');
    if (params.length > 0) {
      const aliases = params.map(p => getParamAlias(p));
      lines.push('    \\/ \\E ' + aliases.map(a => a + ' \\in 0..MaxBound').join(', ') + ' : ' + t.actionName + '(' + aliases.join(', ') + ')');
    } else {
      lines.push('    \\/ ' + t.actionName);
    }
  }
  for (const s of finalStates) {
    for (const op of finalStateOps[s]) {
      lines.push('    \\/ ' + op.name);
    }
  }

  // Spec
  lines.push('');
  lines.push('\\* ── Specification ─────────────────────────────────────────────────────────────');
  lines.push('Spec == Init /\\ [][Next]_vars');

  lines.push('');
  lines.push('\\* ── Invariants (add domain-specific properties here) ──────────────────────────');
  lines.push('\\* TypeOK is the structural baseline. Add semantic invariants below.');
  lines.push('');
  lines.push('====');
  lines.push('');

  const tlaContent = lines.join('\n');

  // ── Generate .cfg ───────────────────────────────────────────────────────────
  const cfgName = 'MC' + moduleName;
  const cfgContent = [
    '\\* .planning/formal/tla/' + cfgName + '.cfg',
    '\\* GENERATED by bin/fsm-to-tla.cjs',
    '\\* Regenerate: node bin/fsm-to-tla.cjs ' + sourceFile + ' --module=' + moduleName,
    '\\* Generated: ' + ts_date,
    '',
    'CONSTANT MaxBound = 4',
    '',
    'SPECIFICATION Spec',
    'INVARIANT TypeOK',
    'CHECK_DEADLOCK FALSE',
    '',
  ].join('\n');

  const tlaOutPath = path.join(outDir, moduleName + '_xstate.tla');
  const cfgOutPath = path.join(outDir, cfgName + '.cfg');

  if (!dry) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(tlaOutPath, tlaContent, 'utf8');
    fs.writeFileSync(cfgOutPath, cfgContent, 'utf8');

    // Try to update model registry (fail-open)
    try {
      const { updateModelRegistry } = require('./registry-update.cjs');
      updateModelRegistry(tlaOutPath, { dry, projectRoot: path.join(__dirname, '..', '..') });
    } catch (_) {
      // registry-update not yet created — fail-open
    }
  }

  return { tlaContent, cfgContent, tlaOutPath, cfgOutPath, actionNames, stateNames };
}

module.exports = { emitTLA, toCamel, genUnchanged, genAssignLine, genAction, genFinalStateOps };

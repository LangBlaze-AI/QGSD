'use strict';
// bin/adapters/stately.cjs
// Stately (SCXML-JSON) adapter — parses Stately's XState-compatible JSON format.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'stately';
const name = 'Stately (SCXML-JSON)';
const extensions = ['.json'];

function detect(filePath, content) {
  try {
    const parsed = JSON.parse(content);
    // Must NOT match ASL (no capital-S States, no StartAt)
    if (parsed.States || parsed.StartAt) return 0;
    if (parsed.id && parsed.initial && parsed.states) {
      const firstState = Object.values(parsed.states)[0];
      if (firstState && firstState.on) return 85;
    }
  } catch (_) {}
  return 0;
}

function extract(filePath, options = {}) {
  const { userVars = {} } = options;
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) throw new Error('File not found: ' + absInput);

  const content = fs.readFileSync(absInput, 'utf8');
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !parsed.states || typeof parsed.states !== 'object' || Array.isArray(parsed.states)) {
    throw new Error('Stately: invalid machine — expected an object with a "states" object');
  }

  const machineId = parsed.id || path.basename(filePath, '.json');
  const initial = String(parsed.initial);
  const stateNames = Object.keys(parsed.states);
  const finalStates = stateNames.filter(s => {
    const sd = parsed.states[s];
    return sd && sd.type === 'final';
  });

  const transitions = [];
  for (const [stateName, stateDef] of Object.entries(parsed.states)) {
    if (!stateDef || !stateDef.on) continue;
    for (const [eventName, transVal] of Object.entries(stateDef.on)) {
      const branches = Array.isArray(transVal) ? transVal : [transVal];
      for (const branch of branches) {
        if (!branch) continue;
        let guard = null;
        let target = null;
        if (typeof branch === 'string') {
          target = branch;
        } else if (typeof branch === 'object') {
          guard = typeof branch.guard === 'string' ? branch.guard : null;
          target = branch.target ? String(branch.target) : null;
        }
        transitions.push({ fromState: stateName, event: eventName, guard, target, assignedKeys: [] });
      }
    }
  }

  // Context
  const ctxDefaults = parsed.context || {};
  const allCtxKeys = Object.keys(ctxDefaults);
  const ctxVars = allCtxKeys.filter(k => userVars[k] !== 'skip');

  const ir = {
    machineId,
    initial,
    stateNames,
    finalStates,
    transitions,
    ctxVars,
    ctxDefaults,
    sourceFile: path.relative(process.cwd(), absInput),
    framework: id,
  };

  const validation = validateIR(ir);
  if (!validation.valid) throw new Error('Stately IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

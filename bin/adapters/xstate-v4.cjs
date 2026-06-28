'use strict';
// bin/adapters/xstate-v4.cjs
// XState v4 adapter — parses XState v4 machine definitions into MachineIR.

const { buildSync } = require('esbuild');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'xstate-v4';
const name = 'XState v4';
const extensions = ['.ts', '.js', '.tsx', '.jsx'];

function detect(filePath, content) {
  // v4 uses Machine() (not createMachine which is v5).
  // Key differentiator: v4 had `Machine({` while v5 has `createMachine({`
  const hasMachineFn = /\bMachine\s*\(/.test(content) && !/createMachine/.test(content);
  if (hasMachineFn && /states\s*:/.test(content) &&
      /from\s+['"]xstate['"]/.test(content)) return 85;
  if (hasMachineFn && /from\s+['"]xstate['"]/.test(content)) return 60;
  return 0;
}

function extract(filePath, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const userVars = opts.userVars && typeof opts.userVars === 'object' ? opts.userVars : {};
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) {
    throw new Error('File not found: ' + absInput);
  }

  const tmpBundle = path.join(os.tmpdir(), 'xstate-v4-adapter-' + Date.now() + '.cjs');
  let mod;
  try {
    buildSync({
      entryPoints: [absInput],
      bundle: true,
      format: 'cjs',
      outfile: tmpBundle,
      platform: 'node',
      logLevel: 'silent',
    });
    mod = require(tmpBundle);
  } catch (e) {
    try { fs.unlinkSync(tmpBundle); } catch (_) {}
    throw new Error('Failed to compile/load XState v4 machine: ' + e.message);
  } finally {
    try { fs.unlinkSync(tmpBundle); } catch (_) {}
  }

  // Duck-type: find export with .states directly (not .config.states)
  // Also handle Machine() result which has .initialState
  // Check both the module itself and its named exports
  let machineObj = null;
  const candidates = [mod, ...Object.values(mod)];
  for (const v of candidates) {
    if (v && typeof v === 'object') {
      if (v.states && typeof v.states === 'object' && v.initial && !v.config) {
        machineObj = v;
        break;
      }
      if (v.initialState && v.states) {
        machineObj = v;
        break;
      }
    }
  }

  if (!machineObj) {
    throw new Error('No XState v4 machine export found in: ' + filePath);
  }

  const machineId = machineObj.id || path.basename(filePath, '.js').replace('.machine', '');
  const initial = String(machineObj.initial || '');
  const ctxDefaults = machineObj.context || {};
  const allCtxKeys = Object.keys(ctxDefaults);
  const ctxVars = allCtxKeys.filter(k => userVars[k] !== 'skip');
  const stateNames = Object.keys(machineObj.states);
  const finalStates = stateNames.filter(s => {
    const sd = machineObj.states[s];
    return sd && sd.type === 'final';
  });

  const transitions = [];
  for (const stateName of stateNames) {
    const stateDef = machineObj.states[stateName];
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
          guard = typeof branch.guard === 'string' ? branch.guard
                : (typeof branch.cond === 'string' ? branch.cond : null);
          target = branch.target ? String(branch.target) : null;
        }
        transitions.push({ fromState: stateName, event: eventName, guard, target, assignedKeys: [] });
      }
    }
  }

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
  if (!validation.valid) {
    throw new Error('XState v4 IR validation failed: ' + validation.errors.join('; '));
  }

  return ir;
}

module.exports = { id, name, extensions, detect, extract };

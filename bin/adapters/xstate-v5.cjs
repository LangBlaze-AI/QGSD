'use strict';
// bin/adapters/xstate-v5.cjs
// XState v5 adapter — parses XState v5 machine definitions into MachineIR.
// Extracted from bin/xstate-to-tla.cjs.

const { buildSync } = require('esbuild');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'xstate-v5';
const name = 'XState v5';
const extensions = ['.ts', '.js', '.tsx', '.jsx'];

/**
 * Detect if file content is an XState v5 machine.
 * @param {string} filePath
 * @param {string} content
 * @returns {number} confidence 0-100
 */
function detect(filePath, content) {
  const hasCreateMachine = /createMachine/.test(content);
  const hasConfigStates = /\.config\.states/.test(content) || /export\b/.test(content);

  if (hasCreateMachine && /\.config\.states/.test(content)) return 90;
  if (hasCreateMachine && /from\s+['"]xstate['"]/.test(content)) return 70;
  if (hasCreateMachine && hasConfigStates) return 70;
  if (/\.machine\.(ts|js)$/.test(filePath)) return 50;
  return 0;
}

/**
 * Extract MachineIR from an XState v5 machine file.
 * @param {string} filePath
 * @param {Object} [options]
 * @param {Object} [options.userVars] - var annotations for skip filtering
 * @param {string} [options.configPath] - path to guards/vars config
 * @returns {import('./ir.cjs').MachineIR}
 */
function extract(filePath, options = {}) {
  const { userVars = {} } = options;
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) {
    throw new Error('File not found: ' + absInput);
  }

  const tmpBundle = path.join(os.tmpdir(), 'xstate-v5-adapter-' + Date.now() + '.cjs');
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
    throw new Error('Failed to compile/load XState v5 machine: ' + e.message);
  } finally {
    try { fs.unlinkSync(tmpBundle); } catch (_) {}
  }

  // Find the XState machine export: an object with .config.states
  const machine = Object.values(mod).find(v =>
    v && typeof v === 'object' && v.config && v.config.states
  );
  if (!machine) {
    throw new Error('No XState v5 machine export found in: ' + filePath);
  }

  const cfg = machine.config;
  const machineId = cfg.id || path.basename(filePath, '.ts').replace('.machine', '');
  const initial = String(cfg.initial);
  const ctxDefaults = cfg.context || {};

  // Context variables (excluding 'skip' ones)
  const allCtxKeys = Object.keys(ctxDefaults);
  const ctxVars = allCtxKeys.filter(k => userVars[k] !== 'skip');

  // State list
  const stateNames = Object.keys(cfg.states);
  const finalStates = stateNames.filter(s => cfg.states[s] && cfg.states[s].type === 'final');

  // Parse transitions
  const transitions = [];
  for (const stateName of stateNames) {
    const stateDef = cfg.states[stateName];
    if (!stateDef || !stateDef.on) continue;

    for (const [eventName, transVal] of Object.entries(stateDef.on)) {
      const branches = Array.isArray(transVal) ? transVal : [transVal];

      for (const branch of branches) {
        if (!branch) continue;
        const guard  = typeof branch.guard === 'string' ? branch.guard : null;
        const target = branch.target ? String(branch.target) : null;

        const assignedKeys = [];
        const actions = branch.actions
          ? (Array.isArray(branch.actions) ? branch.actions : [branch.actions])
          : [];
        for (const act of actions) {
          if (act && act.type === 'xstate.assign' && act.assignment) {
            for (const k of Object.keys(act.assignment)) {
              if (!assignedKeys.includes(k)) assignedKeys.push(k);
            }
          }
        }

        transitions.push({ fromState: stateName, event: eventName, guard, target, assignedKeys });
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
    throw new Error('XState v5 IR validation failed: ' + validation.errors.join('; '));
  }

  return ir;
}

module.exports = { id, name, extensions, detect, extract };

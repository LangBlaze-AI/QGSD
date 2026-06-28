'use strict';
// bin/adapters/jsm.cjs
// javascript-state-machine adapter.

const { buildSync } = require('esbuild');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'jsm';
const name = 'javascript-state-machine';
const extensions = ['.js', '.ts', '.mjs'];

function detect(filePath, content) {
  if (/transitions\s*:\s*\[/.test(content) && /\{\s*name\s*:/.test(content) &&
      /from\s*:/.test(content) && /to\s*:/.test(content)) return 85;
  if (/require\s*\(\s*['"]javascript-state-machine['"]\s*\)/.test(content) ||
      /from\s+['"]javascript-state-machine['"]/.test(content)) return 70;
  return 0;
}

function extract(filePath, options = {}) {
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) throw new Error('File not found: ' + absInput);

  const tmpBundle = path.join(os.tmpdir(), 'jsm-adapter-' + Date.now() + '.cjs');
  let mod;
  try {
    buildSync({
      entryPoints: [absInput],
      bundle: true,
      format: 'cjs',
      outfile: tmpBundle,
      platform: 'node',
      logLevel: 'silent',
      external: ['javascript-state-machine'],
    });
    mod = require(tmpBundle);
  } catch (e) {
    try { fs.unlinkSync(tmpBundle); } catch (_) {}
    throw new Error('Failed to compile/load JSM machine: ' + e.message);
  } finally {
    try { fs.unlinkSync(tmpBundle); } catch (_) {}
  }

  // Duck-type: find export with .transitions array where items have { name, from, to }
  // Check both the module itself and its named exports
  let machineObj = null;
  const candidates = [mod, ...Object.values(mod)];
  for (const v of candidates) {
    if (v && typeof v === 'object' && Array.isArray(v.transitions)) {
      const first = v.transitions[0];
      if (first && typeof first === 'object' && 'name' in first && ('from' in first || 'to' in first)) {
        machineObj = v;
        break;
      }
    }
  }

  if (!machineObj) {
    throw new Error('No JSM machine config found in: ' + filePath);
  }

  const initial = String(machineObj.init || '');
  const stateSet = new Set();
  const transitions = [];

  for (const t of machineObj.transitions) {
    if (!t || typeof t !== 'object') continue;
    const fromArr = Array.isArray(t.from) ? t.from : [t.from];
    const target = String(t.to);
    stateSet.add(target);
    for (const from of fromArr) {
      stateSet.add(String(from));
      transitions.push({
        fromState: String(from),
        event: String(t.name),
        guard: null,
        target,
        assignedKeys: [],
      });
    }
  }

  if (initial) stateSet.add(initial);
  const stateNames = [...stateSet];

  const ir = {
    machineId: machineObj.name || path.basename(filePath, path.extname(filePath)),
    initial,
    stateNames,
    finalStates: [],
    transitions,
    ctxVars: [],
    ctxDefaults: {},
    sourceFile: path.relative(process.cwd(), absInput),
    framework: id,
  };

  const validation = validateIR(ir);
  if (!validation.valid) throw new Error('JSM IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

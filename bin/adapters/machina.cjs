'use strict';
// bin/adapters/machina.cjs
// Machina.js adapter — regex-based extraction.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'machina';
const name = 'Machina.js';
const extensions = ['.js', '.ts', '.mjs', '.cjs'];

function detect(filePath, content) {
  if (/require\s*\(\s*['"]machina['"]\s*\)/.test(content) && /initialState\s*:/.test(content)) return 90;
  if (/from\s+['"]machina['"]/.test(content) && /initialState\s*:/.test(content)) return 90;
  if (/machina\.Fsm/.test(content)) return 80;
  if (/require\s*\(\s*['"]machina['"]\s*\)/.test(content)) return 60;
  if (/from\s+['"]machina['"]/.test(content)) return 60;
  return 0;
}

function extract(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Machina.js adapter: filePath must be a non-empty string');
  }
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) throw new Error('File not found: ' + absInput);

  const content = fs.readFileSync(absInput, 'utf8');

  // Initial state: initialState: "stateName"
  let initial = '';
  const initialMatch = content.match(/initialState\s*:\s*['"](\w+)['"]/);
  if (initialMatch) initial = initialMatch[1];

  const stateSet = new Set();
  const transitions = [];

  // Find the states block and extract state names
  // states: { stateName: { ... }, stateName2: { ... } }
  const statesBlockMatch = content.match(/states\s*:\s*\{/);
  if (statesBlockMatch) {
    const afterStates = content.slice(statesBlockMatch.index + statesBlockMatch[0].length);

    // Match top-level state keys: stateName: { or "stateName": {
    const stateKeyPattern = /(?:^|[,\n])\s*['"]?(\w+)['"]?\s*:\s*\{/g;
    let sk;
    while ((sk = stateKeyPattern.exec(afterStates)) !== null) {
      const stateName = sk[1];
      // Skip common non-state keys
      if (['initialize', '_', 'inputHandlers'].includes(stateName)) continue;
      stateSet.add(stateName);
    }
  }

  // Find transitions: this.transition("targetState") or this.transition( "targetState" )
  const transPattern = /this\.transition\s*\(\s*['"](\w+)['"]\s*\)/g;
  let tm;
  while ((tm = transPattern.exec(content)) !== null) {
    const target = tm[1];
    stateSet.add(target);

    // Walk backwards to find which state block this is in
    const before = content.slice(0, tm.index);
    const stateKeys = [...before.matchAll(/(?:^|[,\n])\s*['"]?(\w+)['"]?\s*:\s*\{/g)];
    let fromState = '';
    if (stateKeys.length > 0) {
      // Find the last state key that is in our stateSet
      for (let i = stateKeys.length - 1; i >= 0; i--) {
        const candidate = stateKeys[i][1];
        if (stateSet.has(candidate) || candidate === initial) {
          fromState = candidate;
          break;
        }
      }
    }

    // Try to find the event/handler name: handlerName: function() { ... this.transition
    const handlerMatch = before.match(/['"]?(\w+)['"]?\s*:\s*function\s*\([^)]*\)\s*\{[^}]*$/);
    const eventName = handlerMatch ? handlerMatch[1] : 'transition';

    if (fromState) {
      stateSet.add(fromState);
      transitions.push({
        fromState,
        event: eventName,
        guard: null,
        target,
        assignedKeys: [],
      });
    }
  }

  // Also match this.handle("eventName") patterns to find events
  const handlePattern = /this\.handle\s*\(\s*['"](\w+)['"]\s*\)/g;
  let hm;
  while ((hm = handlePattern.exec(content)) !== null) {
    // events found via handle are already captured if they cause transitions
  }

  if (initial) stateSet.add(initial);
  const stateNames = [...stateSet];
  // machina allows omitting initialState; fall back to the first discovered
  // state so a valid FSM still produces a usable IR (matches robot/jssm adapters).
  if (!initial && stateNames.length > 0) initial = stateNames[0];

  const ir = {
    machineId: path.basename(filePath, path.extname(filePath)),
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
  if (!validation.valid) throw new Error('Machina.js IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

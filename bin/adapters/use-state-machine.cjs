'use strict';
// bin/adapters/use-state-machine.cjs
// useStateMachine React hook adapter — regex-based extraction.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'use-state-machine';
const name = 'useStateMachine (React)';
const extensions = ['.js', '.ts', '.jsx', '.tsx'];

function detect(filePath, content) {
  if (/from\s+['"]@cassiozen\/usestatemachine['"]/.test(content)) return 90;
  if (/from\s+['"]use-state-machine['"]/.test(content)) return 90;
  if (/require\s*\(\s*['"]@cassiozen\/usestatemachine['"]\s*\)/.test(content)) return 85;
  if (/require\s*\(\s*['"]use-state-machine['"]\s*\)/.test(content)) return 85;
  if (/useStateMachine\s*\(/.test(content) && /initial\s*:/.test(content) && /states\s*:/.test(content)) return 60;
  return 0;
}

function extract(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('File not found: ' + String(filePath));
  }
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput) || !fs.statSync(absInput).isFile()) {
    throw new Error('File not found: ' + absInput);
  }

  const content = fs.readFileSync(absInput, 'utf8');

  // Initial state: initial: "idle" or initial: 'idle'
  let initial = '';
  const initialMatch = content.match(/initial\s*:\s*['"](\w+)['"]/);
  if (initialMatch) initial = initialMatch[1];

  const stateSet = new Set();
  const transitions = [];

  // Find states block and extract state names with their events
  // states: { idle: { on: { START: "running" } }, running: { on: { STOP: "idle" } } }
  const statePattern = /['"]?(\w+)['"]?\s*:\s*\{\s*on\s*:\s*\{([^}]*)\}/g;
  let sm;
  while ((sm = statePattern.exec(content)) !== null) {
    const stateName = sm[1];
    stateSet.add(stateName);

    const eventsBlock = sm[2];
    // Match event: "target" or EVENT: "target"
    const eventPattern = /['"]?(\w+)['"]?\s*:\s*['"](\w+)['"]/g;
    let em;
    while ((em = eventPattern.exec(eventsBlock)) !== null) {
      const eventName = em[1];
      const target = em[2];
      stateSet.add(target);
      transitions.push({
        fromState: stateName,
        event: eventName,
        guard: null,
        target,
        assignedKeys: [],
      });
    }
  }

  if (initial) stateSet.add(initial);
  const stateNames = [...stateSet];

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
  if (!validation.valid) throw new Error('useStateMachine IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

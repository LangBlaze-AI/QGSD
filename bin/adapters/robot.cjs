'use strict';
// bin/adapters/robot.cjs
// Robot state machine adapter — regex-based extraction.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'robot';
const name = 'Robot';
const extensions = ['.js', '.ts', '.mjs'];

function detect(filePath, content) {
  if (/createMachine/.test(content) && /state\s*\(/.test(content) && /transition\s*\(/.test(content)) return 80;
  if (/from\s+['"]robot3['"]/.test(content) || /require\s*\(\s*['"]robot3['"]\s*\)/.test(content)) return 70;
  return 0;
}

function extract(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Robot extract: filePath must be a non-empty string');
  }
  const absInput = path.resolve(filePath);
  let stat = null;
  try { stat = fs.statSync(absInput); } catch (_) { stat = null; }
  if (!stat || !stat.isFile()) throw new Error('File not found: ' + absInput);

  const content = fs.readFileSync(absInput, 'utf8');

  const stateNames = [];
  const transitions = [];

  // Find state names: keys before state( calls
  const statePattern = /(\w+)\s*:\s*state\s*\(/g;
  let m;
  while ((m = statePattern.exec(content)) !== null) {
    stateNames.push(m[1]);
  }

  // For each state, find its block boundary and extract transitions
  // Use position-based slicing: from the state's pattern match to the next state or end
  for (let i = 0; i < stateNames.length; i++) {
    const stateName = stateNames[i];
    const startRegex = new RegExp(stateName + '\\s*:\\s*state\\s*\\(');
    const startMatch = startRegex.exec(content);
    if (!startMatch) continue;

    // Slice from the start of this state to the next state or a reasonable boundary
    const startIdx = startMatch.index;
    let endIdx = content.length;
    for (let j = 0; j < stateNames.length; j++) {
      if (j === i) continue;
      const nextRegex = new RegExp(stateNames[j] + '\\s*:\\s*state\\s*\\(');
      const nextMatch = nextRegex.exec(content.slice(startIdx + startMatch[0].length));
      if (nextMatch) {
        const candidate = startIdx + startMatch[0].length + nextMatch.index;
        if (candidate < endIdx) endIdx = candidate;
      }
    }

    const block = content.slice(startIdx, endIdx);
    const transPattern = /transition\s*\(\s*['"]([\w-]+)['"]\s*,\s*['"]([\w-]+)['"]/g;
    let tm;
    while ((tm = transPattern.exec(block)) !== null) {
      transitions.push({
        fromState: stateName,
        event: tm[1],
        guard: null,
        target: tm[2],
        assignedKeys: [],
      });
    }
  }

  const initial = stateNames[0] || '';

  // Ensure all target states are in stateNames
  for (const t of transitions) {
    if (t.target && !stateNames.includes(t.target)) {
      stateNames.push(t.target);
    }
  }

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
  if (!validation.valid) throw new Error('Robot IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

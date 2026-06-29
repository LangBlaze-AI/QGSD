'use strict';
// bin/adapters/python-transitions.cjs
// Python transitions library adapter — regex-based extraction.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'py-transitions';
const name = 'Python transitions';
const extensions = ['.py'];

function detect(filePath, content) {
  if (/from\s+transitions\s+import\s+Machine/.test(content) || /import\s+transitions/.test(content)) return 85;
  if (/Machine\s*\(/.test(content) && /transitions\s*=/.test(content) && /states\s*=/.test(content)) return 70;
  return 0;
}

function extract(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Python transitions adapter: filePath must be a non-empty string');
  }
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) throw new Error('File not found: ' + absInput);

  const content = fs.readFileSync(absInput, 'utf8');

  // Extract states: states = ['idle', 'processing', 'done']
  const stateNames = [];
  const statesMatch = content.match(/\bstates\s*=\s*\[([^\]]+)\]/);
  if (statesMatch) {
    const statesStr = statesMatch[1];
    const statePattern = /['"](\w+)['"]/g;
    let sm;
    while ((sm = statePattern.exec(statesStr)) !== null) {
      stateNames.push(sm[1]);
    }
  }

  // Extract initial state: initial='idle'
  let initial = '';
  const initialMatch = content.match(/initial\s*=\s*['"](\w+)['"]/);
  if (initialMatch) initial = initialMatch[1];

  // Extract transitions: list of dicts
  const transitions = [];
  const transBlockMatch = content.match(/\btransitions\s*=\s*\[([\s\S]*)\]/);
  if (transBlockMatch) {
    const transBlock = transBlockMatch[1];
    // Match individual dicts
    const dictPattern = /\{\s*['"]trigger['"]\s*:\s*['"](\w+)['"]\s*,\s*['"]source['"]\s*:\s*['"](\w+)['"]\s*,\s*['"]dest['"]\s*:\s*['"](\w+)['"]/g;
    let dm;
    while ((dm = dictPattern.exec(transBlock)) !== null) {
      transitions.push({
        fromState: dm[2],
        event: dm[1],
        guard: null,
        target: dm[3],
        assignedKeys: [],
      });
    }

    // Also try list format: ['trigger', 'source', 'dest']
    if (transitions.length === 0) {
      const listPattern = /\[\s*['"](\w+)['"]\s*,\s*['"](\w+)['"]\s*,\s*['"](\w+)['"]\s*\]/g;
      let lm;
      while ((lm = listPattern.exec(transBlock)) !== null) {
        transitions.push({
          fromState: lm[2],
          event: lm[1],
          guard: null,
          target: lm[3],
          assignedKeys: [],
        });
      }
    }
  }

  if (initial && !stateNames.includes(initial)) stateNames.push(initial);
  for (const t of transitions) {
    if (!stateNames.includes(t.fromState)) stateNames.push(t.fromState);
    if (t.target && !stateNames.includes(t.target)) stateNames.push(t.target);
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
  if (!validation.valid) throw new Error('Python transitions IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

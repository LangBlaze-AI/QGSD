'use strict';
// bin/adapters/jssm.cjs
// jssm adapter — regex-based extraction of jssm template literal FSMs.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'jssm';
const name = 'jssm';
const extensions = ['.js', '.ts', '.mjs', '.cjs'];

function detect(filePath, content) {
  if (/require\s*\(\s*['"]jssm['"]\s*\)/.test(content) && /sm\s*`/.test(content)) return 90;
  if (/from\s+['"]jssm['"]/.test(content) && /sm\s*`/.test(content)) return 90;
  if (/require\s*\(\s*['"]jssm['"]\s*\)/.test(content)) return 70;
  if (/from\s+['"]jssm['"]/.test(content)) return 70;
  if (/sm\s*`[^`]*->/.test(content)) return 50;
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

  const stateSet = new Set();
  const transitions = [];

  // Extract template literal content: sm`...`
  const tmplPattern = /sm\s*`([^`]+)`/g;
  let tmplMatch;
  while ((tmplMatch = tmplPattern.exec(content)) !== null) {
    const tmplContent = tmplMatch[1];

    // Parse arrow transitions: state1 -> state2 or state1 => state2
    // Also handles labeled: 'event' : state1 -> state2
    const lines = tmplContent.split(';');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Match chains: a -> b -> c or a => b => c
      // First check for labeled transitions: 'label' : a -> b
      const labeledMatch = trimmed.match(/['"](\w+)['"]\s*:\s*(.+)/);
      let eventName = 'transition';
      let arrowPart = trimmed;
      if (labeledMatch) {
        eventName = labeledMatch[1];
        arrowPart = labeledMatch[2];
      }

      // Split on arrow operators: ->, =>, <-, <=, <->
      const arrowParts = arrowPart.split(/\s*(->|=>|<->|<-|<=)\s*/);
      // arrowParts alternates: [state, arrow, state, arrow, state, ...]
      for (let i = 0; i < arrowParts.length - 2; i += 2) {
        const src = arrowParts[i].trim().replace(/['"]/g, '');
        const arrow = arrowParts[i + 1];
        const dst = arrowParts[i + 2].trim().replace(/['"]/g, '');

        if (!src || !dst || !arrow) continue;

        // Filter out non-identifier tokens
        if (!/^\w+$/.test(src) || !/^\w+$/.test(dst)) continue;

        stateSet.add(src);
        stateSet.add(dst);

        if (arrow === '->' || arrow === '=>') {
          transitions.push({
            fromState: src,
            event: eventName,
            guard: null,
            target: dst,
            assignedKeys: [],
          });
        } else if (arrow === '<-' || arrow === '<=') {
          transitions.push({
            fromState: dst,
            event: eventName,
            guard: null,
            target: src,
            assignedKeys: [],
          });
        } else if (arrow === '<->') {
          transitions.push({
            fromState: src,
            event: eventName,
            guard: null,
            target: dst,
            assignedKeys: [],
          });
          transitions.push({
            fromState: dst,
            event: eventName,
            guard: null,
            target: src,
            assignedKeys: [],
          });
        }
      }
    }
  }

  // First state encountered is initial
  const stateNames = [...stateSet];
  const initial = stateNames.length > 0 ? stateNames[0] : '';

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
  if (!validation.valid) throw new Error('jssm IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

'use strict';
// bin/adapters/looplab-fsm.cjs
// looplab/fsm Go adapter — regex-based extraction.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'looplab-fsm';
const name = 'looplab/fsm (Go)';
const extensions = ['.go'];

function detect(filePath, content) {
  if (/["']github\.com\/looplab\/fsm["']/.test(content) && /fsm\.NewFSM\s*\(/.test(content)) return 85;
  if (/fsm\.NewFSM\s*\(/.test(content)) return 60;
  return 0;
}

function extract(filePath, options = {}) {
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) throw new Error('File not found: ' + absInput);
  if (!fs.statSync(absInput).isFile()) throw new Error('Path is not a file: ' + absInput);

  const content = fs.readFileSync(absInput, 'utf8');

  // Initial state: first arg to fsm.NewFSM("initial")
  let initial = '';
  const initialMatch = content.match(/fsm\.NewFSM\s*\(\s*"([^"]+)"/);
  if (initialMatch) initial = initialMatch[1];

  // Events: {Name: "start", Src: []string{"idle"}, Dst: "running"}
  const stateSet = new Set();
  const transitions = [];

  const eventPattern = /\{?\s*Name\s*:\s*"([^"]+)"\s*,\s*Src\s*:\s*\[\]string\s*\{([^}]+)\}\s*,\s*Dst\s*:\s*"([^"]+)"/g;
  let em;
  while ((em = eventPattern.exec(content)) !== null) {
    const eventName = em[1];
    const srcStr = em[2];
    const dst = em[3];
    stateSet.add(dst);

    const srcPattern = /"([^"]+)"/g;
    let sm;
    while ((sm = srcPattern.exec(srcStr)) !== null) {
      const src = sm[1];
      stateSet.add(src);
      transitions.push({
        fromState: src,
        event: eventName,
        guard: null,
        target: dst,
        assignedKeys: [],
      });
    }
  }

  if (initial) stateSet.add(initial);
  const stateNames = [...stateSet];

  const ir = {
    machineId: path.basename(filePath, '.go'),
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
  if (!validation.valid) throw new Error('looplab/fsm IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

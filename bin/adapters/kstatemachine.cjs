'use strict';
// bin/adapters/kstatemachine.cjs
// kstatemachine (Kotlin) adapter — regex-based extraction.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'kstatemachine';
const name = 'kstatemachine (Kotlin)';
const extensions = ['.kt', '.kts'];

function detect(filePath, content) {
  if (/import\s+ru\.nsk\.kstatemachine/.test(content) && /createStateMachine/.test(content)) return 90;
  if (/import\s+ru\.nsk\.kstatemachine/.test(content)) return 70;
  if (/createStateMachine/.test(content) && /addInitialState/.test(content)) return 60;
  return 0;
}

function extract(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('kstatemachine extract: filePath must be a non-empty string');
  }
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput) || !fs.statSync(absInput).isFile()) throw new Error('File not found: ' + absInput);

  const content = fs.readFileSync(absInput, 'utf8');

  const stateSet = new Set();
  const transitions = [];
  let initial = '';
  const finalStates = [];

  // Extract initial state: addInitialState(StateA) or addInitialState(State.Idle)
  const initialPattern = /addInitialState\s*\(\s*(?:\w+\.)?(\w+)\s*\)/g;
  let im;
  while ((im = initialPattern.exec(content)) !== null) {
    const state = im[1];
    stateSet.add(state);
    if (!initial) initial = state;
  }

  // Extract regular states: addState(StateB) or addState(State.Running)
  const statePattern = /addState\s*\(\s*(?:\w+\.)?(\w+)\s*\)/g;
  let sm;
  while ((sm = statePattern.exec(content)) !== null) {
    stateSet.add(sm[1]);
  }

  // Extract final states: addFinalState(StateDone) or setFinalState(...)
  const finalPattern = /addFinalState\s*\(\s*(?:\w+\.)?(\w+)\s*\)/g;
  let fm;
  while ((fm = finalPattern.exec(content)) !== null) {
    stateSet.add(fm[1]);
    finalStates.push(fm[1]);
  }

  // Extract transitions: transition<Event> { targetState = Target }
  // or transition<Event>("name") { targetState = Target }
  const transPattern = /transition\s*<\s*(\w+)\s*>\s*(?:\(\s*["'][^"']*["']\s*\)\s*)?\{\s*[^}]*targetState\s*=\s*(?:\w+\.)?(\w+)/g;
  let tm;
  while ((tm = transPattern.exec(content)) !== null) {
    const event = tm[1];
    const target = tm[2];
    stateSet.add(target);

    // Walk backwards to find which state block this transition is in
    const before = content.slice(0, tm.index);
    let fromState = '';

    // Look for the nearest addInitialState or addState before this transition
    const stateRefs = [...before.matchAll(/(?:addInitialState|addState|addFinalState)\s*\(\s*(?:\w+\.)?(\w+)\s*\)/g)];
    if (stateRefs.length > 0) {
      fromState = stateRefs[stateRefs.length - 1][1];
    }

    if (fromState) {
      transitions.push({
        fromState,
        event,
        guard: null,
        target,
        assignedKeys: [],
      });
    }
  }

  // Also try: transitionOn<Event> { ... targetState = ... }
  const transOnPattern = /transitionOn\s*<\s*(\w+)\s*>\s*(?:\(\s*["'][^"']*["']\s*\)\s*)?\{[^}]*targetState\s*=\s*(?:\w+\.)?(\w+)/g;
  let tom;
  while ((tom = transOnPattern.exec(content)) !== null) {
    const event = tom[1];
    const target = tom[2];
    stateSet.add(target);

    const before = content.slice(0, tom.index);
    const stateRefs = [...before.matchAll(/(?:addInitialState|addState|addFinalState)\s*\(\s*(?:\w+\.)?(\w+)\s*\)/g)];
    let fromState = '';
    if (stateRefs.length > 0) {
      fromState = stateRefs[stateRefs.length - 1][1];
    }

    if (fromState) {
      const exists = transitions.some(t =>
        t.fromState === fromState && t.event === event && t.target === target
      );
      if (!exists) {
        transitions.push({
          fromState,
          event,
          guard: null,
          target,
          assignedKeys: [],
        });
      }
    }
  }

  if (initial) stateSet.add(initial);
  const stateNames = [...stateSet];

  const ir = {
    machineId: path.basename(filePath, path.extname(filePath)),
    initial,
    stateNames,
    finalStates,
    transitions,
    ctxVars: [],
    ctxDefaults: {},
    sourceFile: path.relative(process.cwd(), absInput),
    framework: id,
  };

  const validation = validateIR(ir);
  if (!validation.valid) throw new Error('kstatemachine IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

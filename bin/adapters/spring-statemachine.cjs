'use strict';
// bin/adapters/spring-statemachine.cjs
// Spring Statemachine (Java) adapter — regex-based extraction.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'spring-statemachine';
const name = 'Spring Statemachine (Java)';
const extensions = ['.java', '.kt'];

function detect(filePath, content) {
  if (/import\s+org\.springframework\.statemachine/.test(content) && /\.withStates\s*\(/.test(content)) return 90;
  if (/import\s+org\.springframework\.statemachine/.test(content)) return 70;
  if (/\.withStates\s*\(/.test(content) && /\.withTransitions\s*\(/.test(content)) return 60;
  return 0;
}

function extract(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Invalid filePath: expected a non-empty string, received ' + (filePath === null ? 'null' : typeof filePath));
  }
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) throw new Error('File not found: ' + absInput);
  if (!fs.statSync(absInput).isFile()) throw new Error('Not a file: ' + absInput);

  const content = fs.readFileSync(absInput, 'utf8');

  const stateSet = new Set();
  const transitions = [];
  let initial = '';
  const finalStates = [];

  // Extract initial state: .initial(States.S1) or .initial(S1)
  const initialMatch = content.match(/\.initial\s*\(\s*(?:\w+\.)?(\w+)\s*\)/);
  if (initialMatch) initial = initialMatch[1];

  // Extract states from .states(EnumSet.allOf(...)) or .state(States.S1)
  const statePattern = /\.state\s*\(\s*(?:\w+\.)?(\w+)\s*\)/g;
  let sm;
  while ((sm = statePattern.exec(content)) !== null) {
    stateSet.add(sm[1]);
  }

  // Extract states from .states(EnumSet.of(S1, S2, S3))
  const enumSetMatch = content.match(/\.states\s*\(\s*EnumSet\.(?:allOf|of)\s*\(\s*([^)]+)\)/);
  if (enumSetMatch) {
    const statesStr = enumSetMatch[1];
    const stateRefPattern = /(?:\w+\.)?(\w+)/g;
    let sr;
    while ((sr = stateRefPattern.exec(statesStr)) !== null) {
      // Skip the class name in allOf(States.class)
      if (sr[1] === 'class') continue;
      stateSet.add(sr[1]);
    }
  }

  // Extract end/final states: .end(States.SF)
  const endPattern = /\.end\s*\(\s*(?:\w+\.)?(\w+)\s*\)/g;
  let em;
  while ((em = endPattern.exec(content)) !== null) {
    stateSet.add(em[1]);
    finalStates.push(em[1]);
  }

  // Extract transitions: .source(S1).target(S2).event(E1)
  const transPattern = /\.source\s*\(\s*(?:\w+\.)?(\w+)\s*\)\s*\.target\s*\(\s*(?:\w+\.)?(\w+)\s*\)\s*\.event\s*\(\s*(?:\w+\.)?(\w+)\s*\)/g;
  let tm;
  while ((tm = transPattern.exec(content)) !== null) {
    const fromState = tm[1];
    const target = tm[2];
    const event = tm[3];

    stateSet.add(fromState);
    stateSet.add(target);

    // Check for guard: .guard(guardFn)
    const afterTrans = content.slice(tm.index + tm[0].length, tm.index + tm[0].length + 200);
    const guardMatch = afterTrans.match(/^\s*\.guard\s*\(\s*(\w+)\s*\)/);
    const guard = guardMatch ? guardMatch[1] : null;

    transitions.push({
      fromState,
      event,
      guard,
      target,
      assignedKeys: [],
    });
  }

  // Also try: .withExternal().source(S1).target(S2).event(E1)
  const extTransPattern = /\.withExternal\s*\(\s*\)\s*\.source\s*\(\s*(?:\w+\.)?(\w+)\s*\)\s*\.target\s*\(\s*(?:\w+\.)?(\w+)\s*\)\s*\.event\s*\(\s*(?:\w+\.)?(\w+)\s*\)/g;
  let etm;
  while ((etm = extTransPattern.exec(content)) !== null) {
    const fromState = etm[1];
    const target = etm[2];
    const event = etm[3];

    stateSet.add(fromState);
    stateSet.add(target);

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
  if (!validation.valid) throw new Error('Spring Statemachine IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

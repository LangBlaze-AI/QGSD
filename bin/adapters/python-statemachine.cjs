'use strict';
// bin/adapters/python-statemachine.cjs
// python-statemachine adapter — regex-based extraction.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'python-statemachine';
const name = 'python-statemachine';
const extensions = ['.py'];

function detect(filePath, content) {
  if (/from\s+statemachine\s+import/.test(content) && /StateMachine/.test(content) && /State\s*\(/.test(content)) return 90;
  if (/from\s+statemachine\s+import/.test(content) && /StateMachine/.test(content)) return 75;
  if (/from\s+statemachine\s+import/.test(content)) return 60;
  return 0;
}

function extract(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('python-statemachine: filePath must be a non-empty string');
  }
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) throw new Error('File not found: ' + absInput);
  if (!fs.statSync(absInput).isFile()) {
    throw new Error('python-statemachine: not a regular file: ' + absInput);
  }

  const content = fs.readFileSync(absInput, 'utf8');

  const stateSet = new Set();
  const transitions = [];
  let initial = '';

  // Extract state declarations: state_name = State(initial=True) or State("Label")
  const statePattern = /(\w+)\s*=\s*State\s*\(([^)]*)\)/g;
  let sm;
  while ((sm = statePattern.exec(content)) !== null) {
    const stateName = sm[1];
    const stateArgs = sm[2];
    stateSet.add(stateName);

    if (/initial\s*=\s*True/.test(stateArgs)) {
      initial = stateName;
    }
  }

  // Extract transitions: event_name = source_state.to(target_state)
  // Also handles: event_name = source.to(target, cond="guard_fn")
  const transPattern = /(\w+)\s*=\s*(\w+)\.to\s*\(\s*(\w+)(?:\s*,\s*([^)]*))?\)/g;
  let tm;
  while ((tm = transPattern.exec(content)) !== null) {
    const eventName = tm[1];
    const fromState = tm[2];
    const target = tm[3];
    const extraArgs = tm[4] || '';

    stateSet.add(fromState);
    stateSet.add(target);

    const guardMatch = extraArgs.match(/cond\s*=\s*['"](\w+)['"]/);
    const guard = guardMatch ? guardMatch[1] : null;

    transitions.push({
      fromState,
      event: eventName,
      guard,
      target,
      assignedKeys: [],
    });
  }

  // Also handle multi-source: event = source1.to(target) | source2.to(target)
  const multiTransPattern = /(\w+)\s*=\s*((?:\w+\.to\s*\(\s*\w+[^)]*\)\s*\|\s*)*\w+\.to\s*\(\s*\w+[^)]*\))/g;
  let mtm;
  while ((mtm = multiTransPattern.exec(content)) !== null) {
    const eventName = mtm[1];
    const chain = mtm[2];

    const segPattern = /(\w+)\.to\s*\(\s*(\w+)(?:\s*,\s*([^)]*))?\)/g;
    let seg;
    while ((seg = segPattern.exec(chain)) !== null) {
      const fromState = seg[1];
      const target = seg[2];
      const extraArgs = seg[3] || '';

      // Skip if already added by the single-transition pattern
      const exists = transitions.some(t =>
        t.fromState === fromState && t.event === eventName && t.target === target
      );
      if (exists) continue;

      stateSet.add(fromState);
      stateSet.add(target);

      const guardMatch = extraArgs.match(/cond\s*=\s*['"](\w+)['"]/);
      const guard = guardMatch ? guardMatch[1] : null;

      transitions.push({
        fromState,
        event: eventName,
        guard,
        target,
        assignedKeys: [],
      });
    }
  }

  if (initial) stateSet.add(initial);
  const stateNames = [...stateSet];

  // Detect final states (states with no outgoing transitions and named 'final', 'done', 'completed', etc.)
  const finalStates = [];

  const ir = {
    machineId: path.basename(filePath, '.py'),
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
  if (!validation.valid) throw new Error('python-statemachine IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

'use strict';
// bin/adapters/swift-state.cjs
// SwiftState (Swift) adapter — regex-based extraction.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'swift-state';
const name = 'SwiftState (Swift)';
const extensions = ['.swift'];

function detect(filePath, content) {
  if (/import\s+SwiftState/.test(content) && /StateMachine\s*</.test(content)) return 90;
  if (/import\s+SwiftState/.test(content)) return 70;
  if (/StateMachine\s*<[^>]+>\s*\(\s*state\s*:/.test(content) && /addRoute/.test(content)) return 65;
  if (/addRoute\s*\(/.test(content) && /=>/.test(content) && /\.swift$/.test(filePath)) return 50;
  return 0;
}

function extract(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('SwiftState extract: filePath must be a non-empty string');
  }
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) throw new Error('File not found: ' + absInput);

  const content = fs.readFileSync(absInput, 'utf8');

  const stateSet = new Set();
  const transitions = [];
  let initial = '';

  // Extract initial state: StateMachine<State, Event>(state: .idle)
  // or StateMachine<MyState, MyEvent>(state: .idle)
  const initMatch = content.match(/StateMachine\s*<[^>]+>\s*\(\s*state\s*:\s*(?:\w+\s*)?\.(\w+)\s*\)/);
  if (initMatch) {
    initial = initMatch[1];
    stateSet.add(initial);
  }

  // Also try: StateMachine<String, String>(state: "idle")
  if (!initial) {
    const initStrMatch = content.match(/StateMachine\s*<[^>]+>\s*\(\s*state\s*:\s*["'](\w+)["']\s*\)/);
    if (initStrMatch) {
      initial = initStrMatch[1];
      stateSet.add(initial);
    }
  }

  // Extract routes: addRoute(.idle => .running)
  // or machine.addRoute(.idle => .running)
  const routePattern = /addRoute\s*\(\s*\.(\w+)\s*=>\s*\.(\w+)\s*\)/g;
  let rm;
  while ((rm = routePattern.exec(content)) !== null) {
    const fromState = rm[1];
    const target = rm[2];
    stateSet.add(fromState);
    stateSet.add(target);
    transitions.push({
      fromState,
      event: 'route',
      guard: null,
      target,
      assignedKeys: [],
    });
  }

  // Also try string-based routes: addRoute("idle" => "running")
  const routeStrPattern = /addRoute\s*\(\s*["'](\w+)["']\s*=>\s*["'](\w+)["']\s*\)/g;
  let rsm;
  while ((rsm = routeStrPattern.exec(content)) !== null) {
    const fromState = rsm[1];
    const target = rsm[2];
    stateSet.add(fromState);
    stateSet.add(target);

    const exists = transitions.some(t =>
      t.fromState === fromState && t.target === target
    );
    if (!exists) {
      transitions.push({
        fromState,
        event: 'route',
        guard: null,
        target,
        assignedKeys: [],
      });
    }
  }

  // Extract event-based routes: addRoute(.idle => .running, event: .start)
  const eventRoutePattern = /addRoute\s*\(\s*\.(\w+)\s*=>\s*\.(\w+)\s*,\s*event\s*:\s*\.(\w+)\s*\)/g;
  let erm;
  while ((erm = eventRoutePattern.exec(content)) !== null) {
    const fromState = erm[1];
    const target = erm[2];
    const event = erm[3];
    stateSet.add(fromState);
    stateSet.add(target);

    // Replace any generic 'route' transition we already added for this pair
    const existingIdx = transitions.findIndex(t =>
      t.fromState === fromState && t.target === target && t.event === 'route'
    );
    if (existingIdx >= 0) {
      transitions[existingIdx].event = event;
    } else {
      transitions.push({
        fromState,
        event,
        guard: null,
        target,
        assignedKeys: [],
      });
    }
  }

  // Extract enum states: enum State { case idle, running, done }
  // or enum State: StateType { case idle; case running; case done }
  const enumPattern = /enum\s+\w+\s*(?::\s*\w+\s*)?\{([^}]+)\}/g;
  let enm;
  while ((enm = enumPattern.exec(content)) !== null) {
    const body = enm[1];
    const casePattern = /case\s+(\w+)/g;
    let cm;
    while ((cm = casePattern.exec(body)) !== null) {
      stateSet.add(cm[1]);
    }
  }

  if (initial) stateSet.add(initial);
  const stateNames = [...stateSet];

  const ir = {
    machineId: path.basename(filePath, '.swift'),
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
  if (!validation.valid) throw new Error('SwiftState IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

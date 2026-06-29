'use strict';
// bin/adapters/automatonymous.cjs
// Automatonymous / MassTransit (C#) adapter — regex-based extraction.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'automatonymous';
const name = 'Automatonymous/MassTransit (C#)';
const extensions = ['.cs'];

function detect(filePath, content) {
  if (/using\s+MassTransit/.test(content) && /MassTransitStateMachine/.test(content)) return 90;
  if (/using\s+Automatonymous/.test(content) && /\.During\s*\(/.test(content)) return 90;
  if (/MassTransitStateMachine/.test(content) && /\.During\s*\(/.test(content)) return 80;
  if (/using\s+MassTransit/.test(content) && /\.During\s*\(/.test(content)) return 75;
  if (/using\s+Automatonymous/.test(content)) return 60;
  return 0;
}

function extract(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Automatonymous extract: filePath must be a non-empty string');
  }
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) throw new Error('File not found: ' + absInput);
  if (!fs.statSync(absInput).isFile()) throw new Error('Not a file: ' + absInput);

  const content = fs.readFileSync(absInput, 'utf8');

  const stateSet = new Set();
  const transitions = [];
  let initial = '';
  const finalStates = [];

  // Extract state declarations: State(() => Submitted) or public State Submitted { get; set; }
  const stateLambdaPattern = /State\s*\(\s*\(\s*\)\s*=>\s*(\w+)\s*\)/g;
  let slm;
  while ((slm = stateLambdaPattern.exec(content)) !== null) {
    stateSet.add(slm[1]);
  }

  // public State StateName { get; private set; }
  const statePropPattern = /(?:public|private|protected)\s+State\s+(\w+)\s*\{/g;
  let spm;
  while ((spm = statePropPattern.exec(content)) !== null) {
    stateSet.add(spm[1]);
  }

  // Extract events: Event(() => EventName) or public Event<T> EventName { get; set; }
  const eventLambdaPattern = /Event\s*\(\s*\(\s*\)\s*=>\s*(\w+)\s*\)/g;
  const events = new Set();
  let elm;
  while ((elm = eventLambdaPattern.exec(content)) !== null) {
    events.add(elm[1]);
  }

  // Initially(When(Event).TransitionTo(State))
  const initiallyPattern = /Initially\s*\(\s*(?:[\s\S]*?)When\s*\(\s*(\w+)\s*\)[\s\S]*?\.TransitionTo\s*\(\s*(\w+)\s*\)/g;
  let initm;
  while ((initm = initiallyPattern.exec(content)) !== null) {
    const event = initm[1];
    const target = initm[2];
    stateSet.add(target);

    // Initially implies a synthetic "Initial" state
    if (!initial) initial = 'Initial';
    stateSet.add('Initial');

    transitions.push({
      fromState: 'Initial',
      event,
      guard: null,
      target,
      assignedKeys: [],
    });
  }

  // During(State, When(Event).TransitionTo(NextState))
  const duringPattern = /During\s*\(\s*(\w+)\s*,/g;
  let dm;
  while ((dm = duringPattern.exec(content)) !== null) {
    const duringState = dm[1];
    stateSet.add(duringState);

    // Find all When().TransitionTo() in this During block
    const afterDuring = content.slice(dm.index + dm[0].length);
    // Get the balanced block (approximate: until the next During or end of method)
    const blockEnd = afterDuring.search(/\n\s*(?:During|Initially|Finally|DuringAny)\s*\(/);
    const block = blockEnd > 0 ? afterDuring.slice(0, blockEnd) : afterDuring.slice(0, 500);

    const whenTransPattern = /When\s*\(\s*(\w+)\s*\)(?:(?!\bWhen\s*\()[\s\S])*?\.TransitionTo\s*\(\s*(\w+)\s*\)/g;
    let wtm;
    while ((wtm = whenTransPattern.exec(block)) !== null) {
      const event = wtm[1];
      const target = wtm[2];
      stateSet.add(target);
      transitions.push({
        fromState: duringState,
        event,
        guard: null,
        target,
        assignedKeys: [],
      });
    }

    // When(Event).Finalize() — transition to final
    const finalizePattern = /When\s*\(\s*(\w+)\s*\)(?:(?!\bWhen\s*\()[\s\S])*?\.Finalize\s*\(\s*\)/g;
    let fzm;
    while ((fzm = finalizePattern.exec(block)) !== null) {
      const event = fzm[1];
      const finalState = 'Final';
      stateSet.add(finalState);
      if (!finalStates.includes(finalState)) finalStates.push(finalState);
      transitions.push({
        fromState: duringState,
        event,
        guard: null,
        target: finalState,
        assignedKeys: [],
      });
    }
  }

  // If no initial found from Initially block, try to infer from InstanceState
  if (!initial) {
    const instanceMatch = content.match(/InstanceState\s*\(\s*[^,]+,\s*(\w+)\s*\)/);
    if (instanceMatch) {
      initial = instanceMatch[1];
      stateSet.add(initial);
    }
  }

  // Fallback: first state
  if (!initial && stateSet.size > 0) {
    initial = [...stateSet][0];
  }

  const stateNames = [...stateSet];

  const ir = {
    machineId: path.basename(filePath, '.cs'),
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
  if (!validation.valid) throw new Error('Automatonymous IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

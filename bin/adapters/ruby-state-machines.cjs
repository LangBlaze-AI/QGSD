'use strict';
// bin/adapters/ruby-state-machines.cjs
// state_machines gem (Ruby) adapter — regex-based extraction.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'ruby-state-machines';
const name = 'state_machines (Ruby)';
const extensions = ['.rb'];

function detect(filePath, content) {
  if (/state_machine\s+:\w+\s+do/.test(content) && /transition/.test(content)) return 90;
  if (/state_machine\s+:\w+\s+do/.test(content)) return 75;
  if (/state_machine\s+do/.test(content) && /transition/.test(content)) return 70;
  return 0;
}

function extract(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Invalid filePath: expected non-empty string, got ' + (filePath === null ? 'null' : typeof filePath));
  }
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) throw new Error('File not found: ' + absInput);

  const content = fs.readFileSync(absInput, 'utf8');

  const stateSet = new Set();
  const transitions = [];
  let initial = '';

  // Extract initial state: state_machine :state, initial: :pending do
  // or state_machine initial: :pending do
  const smMatch = content.match(/state_machine\s+(?::(\w+)\s*,\s*)?initial\s*:\s*:(\w+)/);
  if (smMatch) {
    initial = smMatch[2];
  }

  // Extract state declarations: state :pending, :submitted, :completed
  // or state :pending, value: 0
  const statePattern = /state\s+((?::(\w+)(?:\s*,\s*)?)+)/g;
  let sm;
  while ((sm = statePattern.exec(content)) !== null) {
    const stateStr = sm[1];
    const symPattern = /:(\w+)/g;
    let symMatch;
    while ((symMatch = symPattern.exec(stateStr)) !== null) {
      // Skip options like :value, :if, :unless
      if (['value', 'if', 'unless', 'human_name'].includes(symMatch[1])) continue;
      stateSet.add(symMatch[1]);
    }
  }

  // Extract events and transitions:
  // event :submit do
  //   transition pending: :submitted
  //   transition [:draft, :pending] => :submitted
  //   transition :pending => :submitted, if: :can_submit?
  // end
  const eventPattern = /event\s+:(\w+)\s+do([\s\S]*?)\bend\b/g;
  let em;
  while ((em = eventPattern.exec(content)) !== null) {
    const eventName = em[1];
    const eventBlock = em[2];

    // Hash-style: transition pending: :submitted or transition :pending => :submitted
    // Also: transition [:a, :b] => :c
    const transLines = eventBlock.split('\n');
    for (const line of transLines) {
      const trimmed = line.trim();
      if (!/transition/.test(trimmed)) continue;

      // Extract guard: if: :guard_fn
      const guardMatch = trimmed.match(/(?:if|guard)\s*:\s*:(\w+\??)/);
      const guard = guardMatch ? guardMatch[1] : null;

      // Pattern: transition [:a, :b] => :c
      const arrayTransMatch = trimmed.match(/transition\s+\[([^\]]+)\]\s*=>\s*:(\w+)/);
      if (arrayTransMatch) {
        const target = arrayTransMatch[2];
        stateSet.add(target);
        const srcPattern = /:(\w+)/g;
        let srcMatch;
        while ((srcMatch = srcPattern.exec(arrayTransMatch[1])) !== null) {
          stateSet.add(srcMatch[1]);
          transitions.push({
            fromState: srcMatch[1],
            event: eventName,
            guard,
            target,
            assignedKeys: [],
          });
        }
        continue;
      }

      // Pattern: transition :pending => :submitted or transition pending: :submitted
      const singleTransMatch = trimmed.match(/transition\s+:?(\w+)\s*(?:=>|:)\s*:(\w+)/);
      if (singleTransMatch) {
        const fromState = singleTransMatch[1];
        const target = singleTransMatch[2];
        if (['all', 'any', 'same'].includes(fromState)) continue;
        stateSet.add(fromState);
        stateSet.add(target);
        transitions.push({
          fromState,
          event: eventName,
          guard,
          target,
          assignedKeys: [],
        });
      }
    }
  }

  if (initial) stateSet.add(initial);
  for (const t of transitions) {
    if (!stateSet.has(t.fromState)) stateSet.add(t.fromState);
    if (t.target && !stateSet.has(t.target)) stateSet.add(t.target);
  }
  const stateNames = [...stateSet];

  const ir = {
    machineId: path.basename(filePath, '.rb'),
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
  if (!validation.valid) throw new Error('state_machines IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

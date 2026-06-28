'use strict';
// bin/adapters/statig.cjs
// statig (Rust) adapter — regex-based extraction.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'statig';
const name = 'statig (Rust)';
const extensions = ['.rs'];

function detect(filePath, content) {
  if (/use\s+statig/.test(content) && /#\[state_machine/.test(content)) return 90;
  if (/use\s+statig/.test(content) && /#\[transition/.test(content)) return 85;
  if (/use\s+statig/.test(content)) return 65;
  if (/#\[state_machine\s*\(/.test(content) && /#\[transition/.test(content)) return 60;
  return 0;
}

function extract(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('statig adapter: filePath must be a non-empty string');
  }
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) throw new Error('File not found: ' + absInput);

  const content = fs.readFileSync(absInput, 'utf8');

  const stateSet = new Set();
  const transitions = [];
  let initial = '';

  // Extract initial state from #[state_machine(initial = "State::Idle")] or #[state_machine(initial = "idle")]
  const smAttrMatch = content.match(/#\[state_machine\s*\(\s*(.+?)\)\s*\]/);
  if (smAttrMatch) {
    const attrs = smAttrMatch[1];
    const initialMatch = attrs.match(/initial\s*=\s*["'](?:\w+::)?(\w+)(?:\s*\([^)]*\))?["']/);
    if (initialMatch) {
      initial = initialMatch[1];
      stateSet.add(initial);
    }
  }

  // Extract #[transition] attributes:
  // #[transition(from = "StateA", to = "StateB", event = "EventName")]
  // #[transition(from = "State::A", to = "State::B", event = "E")]
  const transPattern = /#\[transition\s*\(\s*(.+?)\)\s*\]/g;
  let tm;
  while ((tm = transPattern.exec(content)) !== null) {
    const attrs = tm[1];

    const fromMatch = attrs.match(/from\s*=\s*["'](?:\w+::)?(\w+)(?:\s*\([^)]*\))?["']/);
    const toMatch = attrs.match(/to\s*=\s*["'](?:\w+::)?(\w+)(?:\s*\([^)]*\))?["']/);
    const eventMatch = attrs.match(/event\s*=\s*["'](\w+)["']/);

    const fromState = fromMatch ? fromMatch[1] : '';
    const target = toMatch ? toMatch[1] : null;
    const event = eventMatch ? eventMatch[1] : 'transition';

    // Check for guard
    const guardMatch = attrs.match(/guard\s*=\s*["'](\w+)["']/);
    const guard = guardMatch ? guardMatch[1] : null;

    if (fromState) stateSet.add(fromState);
    if (target) stateSet.add(target);

    if (fromState) {
      transitions.push({
        fromState,
        event,
        guard,
        target,
        assignedKeys: [],
      });
    }
  }

  // Also extract states from enum definitions:
  // enum State { Idle, Running, Done }
  const enumPattern = /enum\s+State\s*\{([^}]+)\}/g;
  let enm;
  while ((enm = enumPattern.exec(content)) !== null) {
    // Strip data payloads `(...)`, struct payloads `{...}`, and discriminant
    // values `= 0` so only variant identifiers remain.
    const variants = enm[1]
      .replace(/\([^)]*\)/g, '')
      .replace(/\{[^}]*\}/g, '')
      .replace(/=\s*[^,]+/g, '');
    const variantPattern = /(\w+)/g;
    let vm;
    while ((vm = variantPattern.exec(variants)) !== null) {
      stateSet.add(vm[1]);
    }
  }

  // Extract superstate attributes for hierarchical states
  // #[superstate(superstate = "ParentState")]
  // (just add them as states)
  const superstatePattern = /#\[superstate\s*\(\s*superstate\s*=\s*["'](?:\w+::)?(\w+)["']/g;
  let ssm;
  while ((ssm = superstatePattern.exec(content)) !== null) {
    stateSet.add(ssm[1]);
  }

  if (initial) stateSet.add(initial);
  const stateNames = [...stateSet];

  const ir = {
    machineId: path.basename(filePath, '.rs'),
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
  if (!validation.valid) throw new Error('statig IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

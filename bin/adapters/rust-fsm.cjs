'use strict';
// bin/adapters/rust-fsm.cjs
// rust-fsm adapter — regex-based extraction.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'rust-fsm';
const name = 'rust-fsm (Rust)';
const extensions = ['.rs'];

function detect(filePath, content) {
  if (/use\s+rust_fsm/.test(content) && /state_machine\s*!/.test(content)) return 90;
  if (/state_machine\s*!\s*\{/.test(content)) return 70;
  if (/use\s+rust_fsm/.test(content)) return 60;
  return 0;
}

function extract(filePath, options = {}) {
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) throw new Error('File not found: ' + absInput);
  if (!fs.statSync(absInput).isFile()) throw new Error('Not a file: ' + absInput);

  const content = fs.readFileSync(absInput, 'utf8');

  const stateSet = new Set();
  const transitions = [];
  let initial = '';

  // Extract state_machine! blocks using brace-depth counting.
  // The naive regex /([\s\S]*?)\}/ fails because event sub-blocks contain
  // their own { }, so the first } terminates the match prematurely.
  //
  // state_machine! {
  //   derive(Debug, Clone)
  //   MachineName(InitialState)
  //   EventName [Guard] {
  //     StateA => StateB,
  //     StateC => StateD
  //   }
  // }
  const smStarts = [];
  const smStartPattern = /state_machine\s*!\s*\{/g;
  let ssm;
  while ((ssm = smStartPattern.exec(content)) !== null) {
    smStarts.push(ssm.index + ssm[0].length);
  }

  for (const bodyStart of smStarts) {
    // Walk forward counting brace depth to find the matching }
    let depth = 1;
    let pos = bodyStart;
    while (pos < content.length && depth > 0) {
      if (content[pos] === '{') depth++;
      else if (content[pos] === '}') depth--;
      if (depth > 0) pos++;
    }
    const block = content.slice(bodyStart, pos);

    // Machine name and initial state: MachineName(InitialState)
    // Scan and skip the derive(...) attribute so a single-trait derive
    // (e.g. derive(Clone)) is never mistaken for the machine declaration.
    const machineDeclPattern = /(\w+)\s*\(\s*(\w+)\s*\)/g;
    let machineMatch = null;
    let mdm;
    while ((mdm = machineDeclPattern.exec(block)) !== null) {
      if (mdm[1] === 'derive') continue;
      machineMatch = mdm;
      break;
    }
    if (machineMatch && !initial) {
      initial = machineMatch[2];
      stateSet.add(initial);
    }
    const machineName = machineMatch ? machineMatch[1] : null;

    // Extract event blocks using brace-depth counting for inner blocks too.
    // Pattern: EventName [Guard] { ... }
    const eventHeaderPattern = /(\w+)\s*(?:\[(\w+)\]\s*)?\{/g;
    let ehm;
    while ((ehm = eventHeaderPattern.exec(block)) !== null) {
      const eventName = ehm[1];
      const guard = ehm[2] || null;

      // Skip derive(...) and the machine declaration itself
      if (eventName === 'derive' || eventName === machineName) continue;

      // Find the matching } for this event block
      const innerStart = ehm.index + ehm[0].length;
      let innerDepth = 1;
      let innerPos = innerStart;
      while (innerPos < block.length && innerDepth > 0) {
        if (block[innerPos] === '{') innerDepth++;
        else if (block[innerPos] === '}') innerDepth--;
        if (innerDepth > 0) innerPos++;
      }
      const transBlock = block.slice(innerStart, innerPos);

      // Parse transitions: StateA => StateB
      const arrowPattern = /(\w+)\s*=>\s*(\w+)/g;
      let am;
      while ((am = arrowPattern.exec(transBlock)) !== null) {
        stateSet.add(am[1]);
        stateSet.add(am[2]);
        transitions.push({
          fromState: am[1],
          event: eventName,
          guard,
          target: am[2],
          assignedKeys: [],
        });
      }
    }
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
  if (!validation.valid) throw new Error('rust-fsm IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

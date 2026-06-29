'use strict';
// bin/adapters/machinery.cjs
// Machinery (Elixir) adapter — regex-based extraction.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'machinery';
const name = 'Machinery (Elixir)';
const extensions = ['.ex', '.exs'];

function detect(filePath, content) {
  if (/use\s+Machinery/.test(content) && /states\s*:/.test(content)) return 90;
  if (/use\s+Machinery/.test(content)) return 70;
  if (/Machinery\.transition_to/.test(content)) return 50;
  return 0;
}

function extract(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Machinery extract requires a non-empty file path');
  }
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) throw new Error('File not found: ' + absInput);
  if (!fs.statSync(absInput).isFile()) throw new Error('Not a file: ' + absInput);

  const content = fs.readFileSync(absInput, 'utf8');

  const stateSet = new Set();
  const transitions = [];
  let initial = '';

  // Extract states: states: [:created, :partial, :completed]
  // or states: ["created", "partial", "completed"]
  const statesMatch = content.match(/states\s*:\s*\[([^\]]+)\]/);
  if (statesMatch) {
    const statesStr = statesMatch[1];
    const statePattern = /[:"](\w+)"?/g;
    let sm;
    while ((sm = statePattern.exec(statesStr)) !== null) {
      stateSet.add(sm[1]);
    }
  }

  // First state in the list is the initial state (Machinery convention)
  const stateNames = [...stateSet];
  if (stateNames.length > 0) {
    initial = stateNames[0];
  }

  // Extract transitions: transitions: %{ "created" => "partial", "partial" => "completed" }
  // or transitions: %{ "created" => ["partial", "completed"], ... }
  const transBlockMatch = content.match(/transitions\s*:\s*%\{([^}]+)\}/);
  if (transBlockMatch) {
    const transBlock = transBlockMatch[1];

    // Match "source" => "target" or "source" => ["target1", "target2"]
    const transPattern = /["'](\w+)["']\s*=>\s*(?:["'](\w+)["']|\[([^\]]+)\])/g;
    let tm;
    while ((tm = transPattern.exec(transBlock)) !== null) {
      const fromState = tm[1];
      stateSet.add(fromState);

      if (tm[2]) {
        // Single target
        const target = tm[2];
        stateSet.add(target);
        transitions.push({
          fromState,
          event: 'transition',
          guard: null,
          target,
          assignedKeys: [],
        });
      } else if (tm[3]) {
        // Multiple targets
        const targetsStr = tm[3];
        const targetPattern = /["'](\w+)["']/g;
        let tgm;
        while ((tgm = targetPattern.exec(targetsStr)) !== null) {
          const target = tgm[1];
          stateSet.add(target);
          transitions.push({
            fromState,
            event: 'transition',
            guard: null,
            target,
            assignedKeys: [],
          });
        }
      }
    }
  }

  // Also check for atom-style transitions: %{ created: :partial, partial: :completed }
  // or %{ created: [:partial, :completed] }
  if (transitions.length === 0) {
    const atomTransMatch = content.match(/transitions\s*:\s*%\{([^}]+)\}/);
    if (atomTransMatch) {
      const transBlock = atomTransMatch[1];

      const atomTransPattern = /(\w+)\s*:\s*(?::(\w+)|\[([^\]]+)\])/g;
      let atm;
      while ((atm = atomTransPattern.exec(transBlock)) !== null) {
        const fromState = atm[1];
        stateSet.add(fromState);

        if (atm[2]) {
          const target = atm[2];
          stateSet.add(target);
          transitions.push({
            fromState,
            event: 'transition',
            guard: null,
            target,
            assignedKeys: [],
          });
        } else if (atm[3]) {
          const targetsStr = atm[3];
          const targetPattern = /:(\w+)/g;
          let tgm;
          while ((tgm = targetPattern.exec(targetsStr)) !== null) {
            const target = tgm[1];
            stateSet.add(target);
            transitions.push({
              fromState,
              event: 'transition',
              guard: null,
              target,
              assignedKeys: [],
            });
          }
        }
      }
    }
  }

  // Rebuild stateNames after all states are collected
  const allStateNames = [...stateSet];
  if (initial && !allStateNames.includes(initial)) allStateNames.unshift(initial);

  const ir = {
    machineId: path.basename(filePath, path.extname(filePath)),
    initial,
    stateNames: allStateNames,
    finalStates: [],
    transitions,
    ctxVars: [],
    ctxDefaults: {},
    sourceFile: path.relative(process.cwd(), absInput),
    framework: id,
  };

  const validation = validateIR(ir);
  if (!validation.valid) throw new Error('Machinery IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

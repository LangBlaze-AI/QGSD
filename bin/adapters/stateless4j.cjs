'use strict';
// bin/adapters/stateless4j.cjs
// stateless4j (Java) adapter — regex-based extraction.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'stateless4j';
const name = 'stateless4j (Java)';
const extensions = ['.java'];

function detect(filePath, content) {
  if (/import\s+com\.github\.oxo42\.stateless4j/.test(content) && /StateMachineConfig/.test(content)) return 90;
  if (/import\s+com\.github\.oxo42\.stateless4j/.test(content)) return 70;
  if (/StateMachineConfig\s*</.test(content) && /\.configure\s*\(/.test(content) && /\.permit\s*\(/.test(content)) return 60;
  return 0;
}

function extract(filePath, options = {}) {
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) throw new Error('File not found: ' + absInput);

  const content = fs.readFileSync(absInput, 'utf8');

  const stateSet = new Set();
  const transitions = [];
  let initial = '';

  // Parse const/enum values for resolution
  const constMap = Object.create(null);
  const enumPattern = /(\w+)\s*(?:=\s*"(\w+)"|\(["'](\w+)["']\))/g;
  let cm;
  while ((cm = enumPattern.exec(content)) !== null) {
    constMap[cm[1]] = cm[2] || cm[3] || cm[1];
  }

  function resolve(name) {
    // Handle State.X or Trigger.Y -> X or Y
    const dotMatch = name.match(/^(?:\w+)\.(\w+)$/);
    const base = dotMatch ? dotMatch[1] : name;
    return constMap[base] || base;
  }

  // Extract initial state: new StateMachine<>(State.INIT, config) or new StateMachine<>(..., initial)
  const initMatch = content.match(/new\s+StateMachine\s*<[^>]*>\s*\(\s*(?:\w+\.)?(\w+)/);
  if (initMatch) initial = resolve(initMatch[1]);

  // Find .configure(State.X) blocks
  const configPattern = /\.configure\s*\(\s*(?:\w+\.)?(\w+)\s*\)/g;
  let configMatch;
  while ((configMatch = configPattern.exec(content)) !== null) {
    const configState = resolve(configMatch[1]);
    stateSet.add(configState);

    const afterConfig = content.slice(configMatch.index + configMatch[0].length);

    // Get the chain of method calls (until next .configure or end of statement)
    const chainMatch = afterConfig.match(/^((?:\s*\.\w+\s*\([^)]*\))*)/);
    if (!chainMatch) continue;
    const chain = chainMatch[1];

    // .permit(Trigger.X, State.Y)
    const permitPattern = /\.permit\s*\(\s*(?:\w+\.)?(\w+)\s*,\s*(?:\w+\.)?(\w+)\s*\)/g;
    let pm;
    while ((pm = permitPattern.exec(chain)) !== null) {
      const trigger = resolve(pm[1]);
      const target = resolve(pm[2]);
      stateSet.add(target);
      transitions.push({
        fromState: configState,
        event: trigger,
        guard: null,
        target,
        assignedKeys: [],
      });
    }

    // .permitIf(Trigger.X, State.Y, guard)
    const permitIfPattern = /\.permitIf\s*\(\s*(?:\w+\.)?(\w+)\s*,\s*(?:\w+\.)?(\w+)\s*,\s*([^)]+)\)/g;
    let pim;
    while ((pim = permitIfPattern.exec(chain)) !== null) {
      const trigger = resolve(pim[1]);
      const target = resolve(pim[2]);
      const guard = pim[3].trim().replace(/^new\s+\w+\([^)]*\)/, '').replace(/['"]/g, '') || 'guard';
      stateSet.add(target);
      transitions.push({
        fromState: configState,
        event: trigger,
        guard,
        target,
        assignedKeys: [],
      });
    }
  }

  if (initial) stateSet.add(initial);
  const stateNames = [...stateSet];

  const ir = {
    machineId: path.basename(filePath, '.java'),
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
  if (!validation.valid) throw new Error('stateless4j IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

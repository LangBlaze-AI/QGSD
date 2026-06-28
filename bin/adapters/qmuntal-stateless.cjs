'use strict';
// bin/adapters/qmuntal-stateless.cjs
// qmuntal/stateless Go adapter — regex-based extraction.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'stateless';
const name = 'qmuntal/stateless (Go)';
const extensions = ['.go'];

function detect(filePath, content) {
  if (/["']github\.com\/qmuntal\/stateless["']/.test(content) && /\.Configure\s*\(/.test(content)) return 85;
  if (/\.Configure\s*\(/.test(content) && /\.Permit\s*\(/.test(content)) return 60;
  return 0;
}

function extract(filePath, options = {}) {
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) throw new Error('File not found: ' + absInput);

  const content = fs.readFileSync(absInput, 'utf8');

  // Parse const blocks to build name->value mapping
  // Object.create(null) avoids inherited Object.prototype members (constructor,
  // toString, valueOf, __proto__) leaking through resolve() for identifiers that
  // are not declared as consts.
  const constMap = Object.create(null);
  const constPattern = /(\w+)\s*=\s*"(\w+)"/g;
  let cm;
  while ((cm = constPattern.exec(content)) !== null) {
    constMap[cm[1]] = cm[2];
  }

  function resolve(constName) {
    return constMap[constName] || constName;
  }

  // Initial state: stateless.NewStateMachine(stateIdle)
  let initial = '';
  const initMatch = content.match(/stateless\.NewStateMachine\s*\(\s*(\w+)/);
  if (initMatch) {
    initial = resolve(initMatch[1]);
  }

  const stateSet = new Set();
  const transitions = [];

  // Find all .Configure(state) blocks and their chained .Permit calls
  const configPattern = /\.Configure\s*\(\s*(\w+)\s*\)/g;
  let configMatch;
  while ((configMatch = configPattern.exec(content)) !== null) {
    const configState = resolve(configMatch[1]);
    stateSet.add(configState);

    const afterConfig = content.slice(configMatch.index + configMatch[0].length);

    // Get the chain of method calls
    const chainMatch = afterConfig.match(/^((?:\s*\.\w+\s*\([^)]*\))*)/);
    if (!chainMatch) continue;
    const chain = chainMatch[1];

    // .Permit(trigger, target)
    const permitPattern = /\.Permit\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/g;
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

    // .PermitIf(guard, trigger, target)
    const permitIfPattern = /\.PermitIf\s*\(\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*\)/g;
    let pim;
    while ((pim = permitIfPattern.exec(chain)) !== null) {
      const guard = resolve(pim[1]);
      const trigger = resolve(pim[2]);
      const target = resolve(pim[3]);
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
    machineId: path.basename(filePath, '.go'),
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
  if (!validation.valid) throw new Error('qmuntal/stateless IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

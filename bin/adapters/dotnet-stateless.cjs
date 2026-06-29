'use strict';
// bin/adapters/dotnet-stateless.cjs
// .NET Stateless (C#) adapter — regex-based extraction.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'dotnet-stateless';
const name = '.NET Stateless (C#)';
const extensions = ['.cs'];

function detect(filePath, content) {
  if (/using\s+Stateless/.test(content) && /\.Configure\s*\(/.test(content)) return 90;
  if (/using\s+Stateless/.test(content)) return 70;
  if (/StateMachine\s*<[^>]+>\s*\(/.test(content) && /\.Configure\s*\(/.test(content) && /\.Permit\s*\(/.test(content)) return 60;
  return 0;
}

function extract(filePath, options = {}) {
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) throw new Error('File not found: ' + absInput);

  const content = fs.readFileSync(absInput, 'utf8');

  const stateSet = new Set();
  const transitions = [];
  let initial = '';

  // Extract initial state: new StateMachine<State, Trigger>(State.Idle) or (initialState)
  const initMatch = content.match(/new\s+StateMachine\s*<[^>]+>\s*\(\s*(?:\w+\.)?(\w+)\s*\)/);
  if (initMatch) initial = initMatch[1];

  // Find .Configure(State.X) blocks
  const configPattern = /\.Configure\s*\(\s*(?:\w+\.)?(\w+)\s*\)/g;
  let configMatch;
  while ((configMatch = configPattern.exec(content)) !== null) {
    const configState = configMatch[1];
    stateSet.add(configState);

    const afterConfig = content.slice(configMatch.index + configMatch[0].length);

    // Get the chain of method calls up to the statement terminator. The prior
    // paren-bounded regex stopped at the first ')', so a lambda like
    // `.OnEntry(() => Foo())` truncated the chain and dropped every Permit after it.
    const semicolonIdx = afterConfig.indexOf(';');
    const chain = semicolonIdx === -1 ? afterConfig : afterConfig.slice(0, semicolonIdx);

    // .Permit(Trigger.X, State.Y)
    const permitPattern = /\.Permit\s*\(\s*(?:\w+\.)?(\w+)\s*,\s*(?:\w+\.)?(\w+)\s*\)/g;
    let pm;
    while ((pm = permitPattern.exec(chain)) !== null) {
      const trigger = pm[1];
      const target = pm[2];
      stateSet.add(target);
      transitions.push({
        fromState: configState,
        event: trigger,
        guard: null,
        target,
        assignedKeys: [],
      });
    }

    // .PermitIf(Trigger.X, State.Y, guard) or .PermitIf(guard, Trigger.X, State.Y)
    const permitIfPattern = /\.PermitIf\s*\(\s*(?:\w+\.)?(\w+)\s*,\s*(?:\w+\.)?(\w+)\s*(?:,\s*([^)]+))?\)/g;
    let pim;
    while ((pim = permitIfPattern.exec(chain)) !== null) {
      const trigger = pim[1];
      const target = pim[2];
      const guard = pim[3] ? pim[3].trim().replace(/['"]/g, '') : null;
      stateSet.add(target);
      transitions.push({
        fromState: configState,
        event: trigger,
        guard,
        target,
        assignedKeys: [],
      });
    }

    // .PermitReentry(Trigger.X)
    const reentryPattern = /\.PermitReentry\s*\(\s*(?:\w+\.)?(\w+)\s*\)/g;
    let rm;
    while ((rm = reentryPattern.exec(chain)) !== null) {
      transitions.push({
        fromState: configState,
        event: rm[1],
        guard: null,
        target: configState,
        assignedKeys: [],
      });
    }
  }

  if (initial) stateSet.add(initial);
  const stateNames = [...stateSet];

  const ir = {
    machineId: path.basename(filePath, '.cs'),
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
  if (!validation.valid) throw new Error('.NET Stateless IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

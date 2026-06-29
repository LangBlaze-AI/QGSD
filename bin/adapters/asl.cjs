'use strict';
// bin/adapters/asl.cjs
// AWS Step Functions (ASL) adapter — parses Amazon States Language JSON.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'asl';
const name = 'AWS Step Functions (ASL)';
const extensions = ['.json', '.asl.json'];

function detect(filePath, content) {
  try {
    const parsed = JSON.parse(content);
    if (parsed.States && typeof parsed.States === 'object') {
      const firstState = Object.values(parsed.States)[0];
      if (firstState && firstState.Type) return 90;
    }
  } catch (_) {}
  if (/\.asl\.json$/.test(filePath)) return 80;
  return 0;
}

function extract(filePath, options = {}) {
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) throw new Error('File not found: ' + absInput);

  const content = fs.readFileSync(absInput, 'utf8');
  const parsed = JSON.parse(content);

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      !parsed.States || typeof parsed.States !== 'object' || Array.isArray(parsed.States)) {
    throw new Error('Not a valid ASL machine (missing or invalid "States" object): ' + absInput);
  }

  const initial = parsed.StartAt;
  const stateNames = Object.keys(parsed.States);
  const finalStates = [];
  const transitions = [];

  for (const [stateName, stateDef] of Object.entries(parsed.States)) {
    if (!stateDef || typeof stateDef !== 'object') continue;
    const type = stateDef.Type;

    if (type === 'Succeed' || type === 'Fail') {
      finalStates.push(stateName);
      continue;
    }

    if (stateDef.End === true) {
      finalStates.push(stateName);
    }

    if (type === 'Choice') {
      // Each choice becomes a guarded transition
      if (Array.isArray(stateDef.Choices)) {
        for (const choice of stateDef.Choices) {
          // Derive guard name from Variable + condition
          let guardName = 'choice';
          if (choice.Variable) {
            const varPart = choice.Variable.replace(/^\$\./, '');
            // Find condition type
            const condKey = Object.keys(choice).find(k => k !== 'Variable' && k !== 'Next');
            if (condKey) {
              guardName = varPart + condKey.replace('StringEquals', 'Equals').replace('NumericEquals', 'Equals');
            } else {
              guardName = varPart;
            }
          }
          if (choice.Next) {
            transitions.push({
              fromState: stateName,
              event: 'Choice',
              guard: guardName,
              target: choice.Next,
              assignedKeys: [],
            });
          }
        }
      }
      // Default branch
      if (stateDef.Default) {
        transitions.push({
          fromState: stateName,
          event: 'Choice',
          guard: null,
          target: stateDef.Default,
          assignedKeys: [],
        });
      }
    } else if (type === 'Wait') {
      if (stateDef.Next) {
        transitions.push({
          fromState: stateName,
          event: 'WaitComplete',
          guard: null,
          target: stateDef.Next,
          assignedKeys: [],
        });
      }
    } else {
      // Task, Pass, Parallel, Map — all use Next
      if (stateDef.Next) {
        transitions.push({
          fromState: stateName,
          event: 'Next',
          guard: null,
          target: stateDef.Next,
          assignedKeys: [],
        });
      }
    }
  }

  const ir = {
    machineId: parsed.Comment || path.basename(filePath, '.json').replace('.asl', ''),
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
  if (!validation.valid) throw new Error('ASL IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

'use strict';
// bin/adapters/django-fsm.cjs
// django-fsm Python adapter — regex-based extraction.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'django-fsm';
const name = 'django-fsm (Python)';
const extensions = ['.py'];

function detect(filePath, content) {
  if (/from\s+django_fsm\s+import/.test(content) && /@transition/.test(content)) return 90;
  if (/from\s+django_fsm\s+import/.test(content)) return 70;
  if (/FSMField/.test(content) && /@transition/.test(content)) return 65;
  return 0;
}

function extract(filePath, options = {}) {
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) throw new Error('File not found: ' + absInput);

  const content = fs.readFileSync(absInput, 'utf8');

  const stateSet = new Set();
  const transitions = [];
  const wildcardTransitions = [];

  // Initial state from FSMField: FSMField(default='pending') or FSMField(default="pending")
  let initial = '';
  const fsmFieldMatch = content.match(/FSMField\s*\([^)]*default\s*=\s*['"](\w+)['"]/);
  if (fsmFieldMatch) initial = fsmFieldMatch[1];

  // Extract transitions: @transition(field=state, source='a', target='b')
  // Also handles source=['a', 'b'] (multiple sources) and source='*'
  const transPattern = /@transition\s*\(\s*([^)]+)\)/g;
  let tm;
  while ((tm = transPattern.exec(content)) !== null) {
    const args = tm[1];

    // Extract target
    const targetMatch = args.match(/target\s*=\s*['"](\w+)['"]/);
    const target = targetMatch ? targetMatch[1] : null;
    if (target) stateSet.add(target);

    // Extract source (single string or list)
    const sourceSingleMatch = args.match(/source\s*=\s*['"](\w+|\*)['"]/);
    const sourceListMatch = args.match(/source\s*=\s*\[([^\]]+)\]/);

    // Find the method name from the def line after the decorator
    const afterDecorator = content.slice(tm.index + tm[0].length);
    const defMatch = afterDecorator.match(/\s*def\s+(\w+)/);
    const eventName = defMatch ? defMatch[1] : 'transition';

    // Extract conditions as guard
    const conditionMatch = args.match(/conditions\s*=\s*\[([^\]]+)\]/);
    const guard = conditionMatch
      ? conditionMatch[1].replace(/['"]/g, '').trim()
      : null;

    if (sourceSingleMatch) {
      const src = sourceSingleMatch[1];
      if (src === '*') {
        wildcardTransitions.push({ event: eventName, guard, target });
      } else {
        stateSet.add(src);
        transitions.push({
          fromState: src,
          event: eventName,
          guard,
          target,
          assignedKeys: [],
        });
      }
    } else if (sourceListMatch) {
      const srcStr = sourceListMatch[1];
      const srcPattern = /['"](\w+)['"]/g;
      let srcMatch;
      while ((srcMatch = srcPattern.exec(srcStr)) !== null) {
        stateSet.add(srcMatch[1]);
        transitions.push({
          fromState: srcMatch[1],
          event: eventName,
          guard,
          target,
          assignedKeys: [],
        });
      }
    }
  }

  for (const w of wildcardTransitions) {
    for (const s of stateSet) {
      if (s === w.target) continue;
      transitions.push({ fromState: s, event: w.event, guard: w.guard, target: w.target, assignedKeys: [] });
    }
  }

  if (initial) stateSet.add(initial);
  const stateNames = [...stateSet];
  // Fall back to the first discovered state when no FSMField default is declared
  if (!initial && stateNames.length > 0) initial = stateNames[0];

  const ir = {
    machineId: path.basename(filePath, '.py'),
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
  if (!validation.valid) throw new Error('django-fsm IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

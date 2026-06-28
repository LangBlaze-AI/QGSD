'use strict';
// bin/adapters/sismic.cjs
// sismic YAML statechart adapter.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'sismic';
const name = 'sismic (YAML statechart)';
const extensions = ['.yaml', '.yml'];

function detect(filePath, content) {
  try {
    const yaml = require('js-yaml');
    const parsed = yaml.load(content);
    if (parsed && parsed.statechart && parsed.statechart.root &&
        parsed.statechart.root.initial && parsed.statechart.root.states) return 85;
  } catch (_) {}
  if (/\.statechart\.(yaml|yml)$/.test(filePath)) return 60;
  return 0;
}

function extract(filePath, options = {}) {
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) throw new Error('File not found: ' + absInput);

  const yaml = require('js-yaml');
  const content = fs.readFileSync(absInput, 'utf8');
  const parsed = yaml.load(content);

  if (!parsed || !parsed.statechart || !parsed.statechart.root) {
    throw new Error('Invalid sismic YAML: missing statechart.root');
  }

  const root = parsed.statechart.root;
  const initial = root.initial || '';

  // Recursively collect states
  const stateNames = [];
  const finalStates = [];
  const transitions = [];

  const seenStates = new WeakSet();
  function collectStates(stateList) {
    if (!Array.isArray(stateList)) return;
    for (const s of stateList) {
      if (!s || typeof s !== 'object' || !s.name) continue;
      if (seenStates.has(s)) continue;
      seenStates.add(s);
      stateNames.push(s.name);
      if (s.type === 'final') finalStates.push(s.name);

      // Collect transitions from this state
      if (Array.isArray(s.transitions)) {
        for (const t of s.transitions) {
          if (!t || typeof t !== 'object') continue;
          transitions.push({
            fromState: s.name,
            event: t.event || 'auto',
            guard: t.guard || null,
            target: t.target || null,
            assignedKeys: [],
          });
        }
      }

      // Recurse into nested states
      if (Array.isArray(s.states)) {
        collectStates(s.states);
      }
    }
  }

  collectStates(root.states);

  // Ensure initial and all targets are in stateNames
  if (initial && !stateNames.includes(initial)) stateNames.push(initial);
  for (const t of transitions) {
    if (t.target && !stateNames.includes(t.target)) stateNames.push(t.target);
  }

  const machineId = (parsed.statechart && parsed.statechart.name) ||
                    path.basename(filePath, path.extname(filePath));

  const ir = {
    machineId,
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
  if (!validation.valid) throw new Error('sismic IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

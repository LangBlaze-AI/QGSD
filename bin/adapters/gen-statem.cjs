'use strict';
// bin/adapters/gen-statem.cjs
// gen_statem (Erlang/Elixir) adapter — regex-based extraction.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'gen-statem';
const name = 'gen_statem (Erlang/Elixir)';
const extensions = ['.erl', '.ex', '.exs'];

function detect(filePath, content) {
  // Erlang
  if (/-behaviour\s*\(\s*gen_statem\s*\)/.test(content)) return 90;
  if (/-behavior\s*\(\s*gen_statem\s*\)/.test(content)) return 90;
  // Elixir
  if (/use\s+GenStateMachine/.test(content)) return 90;
  if (/:gen_statem/.test(content) && /handle_event/.test(content)) return 70;
  if (/gen_statem/.test(content) && /next_state/.test(content)) return 50;
  return 0;
}

function extract(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('gen_statem extract requires a non-empty file path');
  }
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) throw new Error('File not found: ' + absInput);

  const content = fs.readFileSync(absInput, 'utf8');
  const ext = path.extname(filePath);

  const stateSet = new Set();
  const transitions = [];
  let initial = '';

  if (ext === '.erl') {
    // Erlang extraction

    // Initial state from init/1: {ok, initial_state, Data}
    const initMatch = content.match(/init\s*\([^)]*\)\s*->\s*\{ok\s*,\s*(\w+)/);
    if (initMatch) {
      initial = initMatch[1];
      stateSet.add(initial);
    }

    // handle_event(cast, EventAtom, StateAtom, Data) -> {next_state, TargetAtom, Data}
    // handle_event({call, From}, Event, State, Data) -> {next_state, Target, Data}
    const handlePattern = /handle_event\s*\(\s*(?:cast|info|\{call\s*,\s*\w+\})\s*,\s*(\w+)\s*,\s*(\w+)\s*,\s*\w+\s*\)\s*->\s*(?:(?!handle_event\s*\()[\s\S])*?\{next_state\s*,\s*(\w+)/g;
    let hm;
    while ((hm = handlePattern.exec(content)) !== null) {
      const event = hm[1];
      const fromState = hm[2];
      const target = hm[3];

      stateSet.add(fromState);
      stateSet.add(target);
      transitions.push({
        fromState,
        event,
        guard: null,
        target,
        assignedKeys: [],
      });
    }

    // State function style: state_name(EventType, EventContent, Data) -> {next_state, Target, Data}
    const stateFnPattern = /(\w+)\s*\(\s*(?:cast|info|\{call\s*,\s*\w+\})\s*,\s*(\w+)\s*,\s*\w+\s*\)\s*->\s*[\s\S]*?\{next_state\s*,\s*(\w+)/g;
    let sfm;
    while ((sfm = stateFnPattern.exec(content)) !== null) {
      const fromState = sfm[1];
      const event = sfm[2];
      const target = sfm[3];

      // Skip common non-state function names
      if (['handle_event', 'init', 'callback_mode', 'terminate', 'code_change', 'format_status'].includes(fromState)) continue;

      stateSet.add(fromState);
      stateSet.add(target);

      const exists = transitions.some(t =>
        t.fromState === fromState && t.event === event && t.target === target
      );
      if (!exists) {
        transitions.push({
          fromState,
          event,
          guard: null,
          target,
          assignedKeys: [],
        });
      }
    }
  } else {
    // Elixir extraction (.ex, .exs)

    // Initial state: {:ok, :initial_state, data} or {:ok, :state, %{}}
    const initMatch = content.match(/\{\s*:ok\s*,\s*:(\w+)\s*,/);
    if (initMatch) {
      initial = initMatch[1];
      stateSet.add(initial);
    }

    // def handle_event(:cast, :event, :state, data) do {:next_state, :target, data}
    const handlePattern = /def\s+handle_event\s*\(\s*:(?:cast|info|call)\s*,\s*:(\w+)\s*,\s*:(\w+)\s*,\s*\w+\s*\)\s+do(?:(?!def\s+handle_event)[\s\S])*?\{\s*:next_state\s*,\s*:(\w+)/g;
    let hm;
    while ((hm = handlePattern.exec(content)) !== null) {
      const event = hm[1];
      const fromState = hm[2];
      const target = hm[3];

      stateSet.add(fromState);
      stateSet.add(target);
      transitions.push({
        fromState,
        event,
        guard: null,
        target,
        assignedKeys: [],
      });
    }

    // Also try pattern with atoms in variables: def handle_event(:cast, event, state, data)
    // where the body has pattern matching
    const handlePatternAlt = /def\s+handle_event\s*\(\s*:(?:cast|info)\s*,\s*:(\w+)\s*,\s*:(\w+)\s*,[^)]+\)(?:(?!def\s+handle_event)[\s\S])*?\{\s*:next_state\s*,\s*:(\w+)/g;
    let ham;
    while ((ham = handlePatternAlt.exec(content)) !== null) {
      const event = ham[1];
      const fromState = ham[2];
      const target = ham[3];

      stateSet.add(fromState);
      stateSet.add(target);

      const exists = transitions.some(t =>
        t.fromState === fromState && t.event === event && t.target === target
      );
      if (!exists) {
        transitions.push({
          fromState,
          event,
          guard: null,
          target,
          assignedKeys: [],
        });
      }
    }
  }

  if (initial) stateSet.add(initial);
  const stateNames = [...stateSet];

  const ir = {
    machineId: path.basename(filePath, path.extname(filePath)),
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
  if (!validation.valid) throw new Error('gen_statem IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

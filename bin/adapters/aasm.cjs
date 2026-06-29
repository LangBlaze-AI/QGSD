'use strict';
// bin/adapters/aasm.cjs
// AASM (Ruby) adapter — regex-based extraction.

const fs   = require('fs');
const path = require('path');
const { validateIR } = require('./ir.cjs');

const id = 'aasm';
const name = 'AASM (Ruby)';
const extensions = ['.rb'];

function detect(filePath, content) {
  if (/include\s+AASM/.test(content) && /aasm\s+do/.test(content)) return 90;
  if (/include\s+AASM/.test(content)) return 70;
  if (/aasm\s+do/.test(content) && /state\s+:/.test(content)) return 65;
  return 0;
}

function extract(filePath, options = {}) {
  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) throw new Error('File not found: ' + absInput);

  const rawContent = fs.readFileSync(absInput, 'utf8');
  // Strip Ruby line/trailing comments so the do/end depth counter (and the
  // transition regexes) never treat the words "do"/"end" inside a comment as
  // block delimiters.
  const content = rawContent.replace(/#.*$/gm, '');

  const stateSet = new Set();
  const transitions = [];
  let initial = '';

  // Extract state declarations: state :pending, initial: true
  // Also: state :submitted
  const statePattern = /state\s+:(\w+)(?:\s*,\s*([^#\n]+))?/g;
  let sm;
  while ((sm = statePattern.exec(content)) !== null) {
    const stateName = sm[1];
    stateSet.add(stateName);

    const options = sm[2] || '';
    if (/initial\s*:\s*true/.test(options)) {
      initial = stateName;
    }
  }

  // Extract events and transitions:
  // event :submit do
  //   transitions from: :pending, to: :submitted
  //   transitions from: :pending, to: :submitted, guard: :can_submit?
  // end
  //
  // Bug fix: the naive regex /event\s+:(\w+)\s+do([\s\S]*?)end/g matches the
  // first "end" it sees — which can be inside state names like :pending or inside
  // nested Ruby blocks. Instead, we use a brace/do-end depth counter to find
  // the matching "end" for each "event ... do".
  const eventStarts = [];
  const eventStartPattern = /event\s+:(\w+)\s+do\b/g;
  let esm;
  while ((esm = eventStartPattern.exec(content)) !== null) {
    eventStarts.push({ eventName: esm[1], startIdx: esm.index, bodyStart: esm.index + esm[0].length });
  }

  for (const ev of eventStarts) {
    // Walk forward from bodyStart, counting nested do/end pairs
    let depth = 1;
    let pos = ev.bodyStart;
    const endKeyword = /\b(do|end)\b/g;
    endKeyword.lastIndex = pos;
    let match;
    let blockEnd = content.length;
    while ((match = endKeyword.exec(content)) !== null) {
      if (match[1] === 'do') {
        depth++;
      } else { // 'end'
        depth--;
        if (depth === 0) {
          blockEnd = match.index;
          break;
        }
      }
    }
    const eventBlock = content.slice(ev.bodyStart, blockEnd);
    const eventName = ev.eventName;

    // Match transitions within event block
    const transPattern = /transitions?\s+from\s*:\s*(?::(\w+)|\[([^\]]+)\])\s*,\s*to\s*:\s*:(\w+)(?:\s*,\s*guard\s*:\s*:(\w+\??))?/g;
    let tm;
    while ((tm = transPattern.exec(eventBlock)) !== null) {
      const singleFrom = tm[1];
      const multiFrom = tm[2];
      const target = tm[3];
      const guard = tm[4] || null;

      stateSet.add(target);

      if (singleFrom) {
        stateSet.add(singleFrom);
        transitions.push({
          fromState: singleFrom,
          event: eventName,
          guard,
          target,
          assignedKeys: [],
        });
      } else if (multiFrom) {
        // Parse [:a, :b, :c]
        const srcPattern = /:(\w+)/g;
        let srcMatch;
        while ((srcMatch = srcPattern.exec(multiFrom)) !== null) {
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
  }

  if (initial) stateSet.add(initial);
  const stateNames = [...stateSet];
  // AASM uses the first declared state as the initial state when none is
  // marked `initial: true`. Without this, validateIR rejects the empty
  // `initial` and extract throws on perfectly valid AASM source.
  if (!initial && stateNames.length > 0) initial = stateNames[0];

  const ir = {
    machineId: path.basename(filePath, '.rb'),
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
  if (!validation.valid) throw new Error('AASM IR validation failed: ' + validation.errors.join('; '));
  return ir;
}

module.exports = { id, name, extensions, detect, extract };

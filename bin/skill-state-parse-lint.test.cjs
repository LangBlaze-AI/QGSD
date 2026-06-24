'use strict';
// bin/skill-state-parse-lint.test.cjs
// Tests Rule 7 (enforced by lint-isolation): every inline
// JSON.parse(readFileSync(...)) in a skill/workflow must be inside a try/catch.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { findUnguardedParses, tryRanges } = require('./skill-state-parse-lint.cjs');

describe('skill-state-parse-lint detector', () => {
  it('flags an unguarded JSON.parse(fs.readFileSync(...))', () => {
    const v = findUnguardedParses("const x = JSON.parse(fs.readFileSync(p, 'utf8'));", 'f.md');
    assert.equal(v.length, 1);
    assert.equal(v[0].file, 'f.md');
  });

  it('flags the destructured form JSON.parse(readFileSync(...))', () => {
    assert.equal(findUnguardedParses("const x = JSON.parse(readFileSync(p));", 'f.md').length, 1);
  });

  it('accepts a parse inside a try/catch', () => {
    const code = "try { const x = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}";
    assert.equal(findUnguardedParses(code, 'f.md').length, 0);
  });

  it('still flags an existsSync-guarded parse with NO try/catch (existsSync ≠ malformed-safe)', () => {
    const code = "if (fs.existsSync(p)) { const x = JSON.parse(fs.readFileSync(p, 'utf8')); }";
    assert.equal(findUnguardedParses(code, 'f.md').length, 1, 'existsSync does not guard a malformed file');
  });

  it('handles a try block with nested braces (brace-matched, not first-brace)', () => {
    const code = "try { if (a) { for (;;) {} } const x = JSON.parse(fs.readFileSync(p)); } catch (e) {}";
    assert.equal(findUnguardedParses(code, 'f.md').length, 0, 'parse after nested braces is still inside the try');
  });

  it('does NOT treat a try WITHOUT catch/finally as a guard', () => {
    // (not valid JS, but defensive) a `try {` with no catch must not shield a parse
    const ranges = tryRanges("try { foo(); } bar();");
    assert.deepEqual(ranges, [], 'a try without catch/finally is not a guarding range');
  });

  it('flags a parse that sits AFTER a closed try/catch', () => {
    const code = "try { a(); } catch (e) {}\nconst x = JSON.parse(fs.readFileSync(p));";
    assert.equal(findUnguardedParses(code, 'f.md').length, 1);
  });
});

describe('the live skill/workflow tree satisfies Rule 7', () => {
  it('has zero unguarded JSON.parse(readFileSync) across commands/nf + core/workflows', () => {
    const dirs = ['commands/nf', 'core/workflows'].map((d) => path.join(__dirname, '..', d));
    const all = [];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
        all.push(...findUnguardedParses(fs.readFileSync(path.join(dir, f), 'utf8'), f));
      }
    }
    assert.deepEqual(all, [], `unguarded parses found (wrap each in try/catch):\n${JSON.stringify(all, null, 2)}`);
  });
});

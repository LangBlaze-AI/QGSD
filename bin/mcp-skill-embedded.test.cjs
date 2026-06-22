#!/usr/bin/env node
'use strict';
// bin/mcp-skill-embedded.test.cjs
// Regression guards for embedded-JS bugs in the mcp-* skill command files
// (found by dogfooding). These snippets run inside the skill at runtime, so a
// stale variable name or an always-false guard fails silently.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CMD = path.join(__dirname, '..', 'commands', 'nf');
const read = (f) => fs.readFileSync(path.join(CMD, f), 'utf8');

describe('mcp-setup.md Composition Screen (F35)', () => {
  const text = read('mcp-setup.md');
  it('reads quorum_active off the parsed config var (nfCfg), not an undefined `nf`', () => {
    // The block parses into `nfCfg`; referencing `nf.quorum_active` throws a
    // ReferenceError (caught → screen silently shows fail-open "ON (all)").
    assert.ok(!/\bnf\.quorum_active\b/.test(text),
      'mcp-setup.md references undefined `nf.quorum_active` — should be `nfCfg.quorum_active`');
    assert.ok(/nfCfg\.quorum_active/.test(text), 'expected nfCfg.quorum_active to be present');
  });
});

describe('mcp-repair.md binary-check guard (F39)', () => {
  const text = read('mcp-repair.md');
  it('does not gate the CLI-binary check on the always-null `p.cli`', () => {
    // providers.json carries `cli: null` (path resolved via mainTool), so
    // `if (p.cli && p.mainTool)` is always false → the fallback `which` probe
    // is dead code. The guard must be `if (p.mainTool)`.
    assert.ok(!/if\s*\(\s*p\.cli\s*&&\s*p\.mainTool\s*\)/.test(text),
      'mcp-repair.md still gates the binary check on the always-null p.cli');
    assert.ok(/if\s*\(\s*p\.mainTool\s*\)/.test(text), 'expected the guard to be `if (p.mainTool)`');
  });
});

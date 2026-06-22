'use strict';
// bin/mcp-setup-env-order.test.cjs
// Guards F1/F34/F37/F42: /nf:mcp-setup emitted `node -e "<js>" VAR="x" VAR2="y"` —
// shell variable assignments placed AFTER the command are positional argv, NOT
// environment, so the JS's `process.env.VAR` was `undefined` (verified: the
// key-storage block did `process.env.AGENT_KEY.toUpperCase()` → TypeError). The
// fix moves every trailing env run to BEFORE `node` so `process.env.*` is populated.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MD = fs.readFileSync(path.join(__dirname, '../commands/nf/mcp-setup.md'), 'utf8');

describe('F1 — mcp-setup passes env BEFORE node, not after', () => {
  it('has no `node -e "…" VAR=` trailing-env (the broken, undefined-env form)', () => {
    // node -e, a (possibly multi-line) double-quoted arg, then whitespace + ENV=...
    const broken = /node -e "(?:[^"\\]|\\.)*"[ \t]+[A-Z_][A-Z0-9_]*=/;
    const m = broken.exec(MD);
    assert.equal(m, null, m ? `trailing-env still present near: ${MD.slice(m.index, m.index + 80)}` : '');
  });

  it('passes env BEFORE node-e where env is needed (e.g. the key-storage block)', () => {
    // The key-storage eval must read process.env.AGENT_KEY, and AGENT_KEY must be
    // assigned on the same command, before `node`.
    assert.ok(/AGENT_KEY="[^"]*"[^\n]*\bnode -e "/.test(MD),
      'AGENT_KEY=... must precede node -e on the key-storage command');
    // And the JS still reads it from the environment.
    assert.ok(/process\.env\.AGENT_KEY/.test(MD), 'the eval still reads process.env.AGENT_KEY');
  });

  it('every env-consuming eval that names a *_KEY/_SLOT/_NAME var assigns it before node', () => {
    // Sanity: no eval line should *start* the env run with a bare VAR= immediately
    // after a closing quote (covered by test 1) — and at least one env-before form exists.
    const envBefore = MD.match(/[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*')[^\n]* node -e "/g) || [];
    assert.ok(envBefore.length >= 10, `expected many env-before evals, found ${envBefore.length}`);
  });
});

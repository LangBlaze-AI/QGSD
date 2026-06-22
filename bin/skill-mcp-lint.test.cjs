'use strict';
// bin/skill-mcp-lint.test.cjs
// Tests the MCP-tool-name standard enforced by lint-isolation Rule 6 (required
// "Lint" CI check): CLI-slot tool references must use the real `<family>-<N>`
// slot name and a tool the server exposes; install-specific/external slots and
// templates are not validated; the live tree must already be clean.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { findMcpToolViolations } = require('./skill-mcp-lint.cjs');

const v = (s) => findMcpToolViolations(s, 'f.md');

describe('skill-mcp-lint detector', () => {
  it('flags stale CLI slot names (the F18/F19 class)', () => {
    assert.equal(v('mcp__gemini-cli__gemini')[0].rule, 'mcp-stale-slot');
    assert.equal(v('mcp__opencode__opencode')[0].rule, 'mcp-stale-slot');      // bare, no -N
    assert.equal(v('mcp__codex-cli-1__review')[0].rule, 'mcp-stale-slot');
  });

  it('flags a tool the slot family does not expose (the F24 `ask` class)', () => {
    const r = v('mcp__copilot-1__ask');
    assert.equal(r.length, 1);
    assert.equal(r[0].rule, 'mcp-bad-tool');
  });

  it('accepts real `<family>-<N>` slots with real tools', () => {
    assert.deepEqual(v('mcp__codex-1__codex'), []);
    assert.deepEqual(v('mcp__gemini-1__gemini'), []);
    assert.deepEqual(v('mcp__copilot-1__copilot'), []);
    assert.deepEqual(v('mcp__opencode-1__opencode'), []);
    assert.deepEqual(v('mcp__codex-1__identity'), []); // shared tools too
  });

  it('does NOT validate install-specific / external slots', () => {
    assert.deepEqual(v('mcp__claude-1__claude'), []);
    assert.deepEqual(v('mcp__claude-z-ai__identity'), []);
    assert.deepEqual(v('mcp__ccr-1__identity'), []);
    assert.deepEqual(v('mcp__context7__resolve-library-id'), []);
    assert.deepEqual(v('mcp__sentry__search_issues'), []);
  });

  it('skips templates/placeholders (they contain < or $)', () => {
    assert.deepEqual(v('mcp__<slot>__identity'), []);
    assert.deepEqual(v('mcp__<$AGENT>__identity'), []);
  });
});

describe('the live skill/workflow tree satisfies the MCP-tool standard', () => {
  it('has zero stale-slot / bad-tool MCP references', () => {
    const dirs = ['commands/nf', 'core/workflows'].map(d => path.join(__dirname, '..', d));
    const all = [];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.md'))) {
        all.push(...findMcpToolViolations(fs.readFileSync(path.join(dir, f), 'utf8'), f));
      }
    }
    assert.deepEqual(all, [], `unexpected violations: ${JSON.stringify(all, null, 2)}`);
  });
});

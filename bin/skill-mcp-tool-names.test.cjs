#!/usr/bin/env node
'use strict';
// bin/skill-mcp-tool-names.test.cjs
// Regression guard for stale MCP worker tool names in skill command files.
//
// nForma quorum/debug/quorum-test skills dispatch sub-agents that call MCP
// tools like `mcp__codex-1__codex`. The server names follow the `<slot>-N`
// convention (codex-1, gemini-1, copilot-1, opencode-1) and each server
// exposes a fixed tool set. Drift here is silent and catastrophic: every
// worker fails to find its tool and the consensus table renders all-UNAVAIL.
//
// Observed bugs this guards against:
//   - debug.md used `mcp__gemini-cli__`, `mcp__opencode__`, `mcp__copilot-cli__ask`,
//     `mcp__codex-cli__codex` (CLI-suffixed / un-suffixed server names).
//   - quorum-test.md used `mcp__copilot-1__ask` (copilot exposes copilot/suggest/
//     explain — there is no `ask` tool).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CMD_DIR = path.join(__dirname, '..', 'commands', 'nf');

// Known MCP tool surface per slot family (from the installed servers).
const VALID_TOOLS = {
  codex: ['codex', 'review', 'identity', 'health_check', 'deep_health_check', 'help', 'ping'],
  gemini: ['gemini', 'identity', 'health_check', 'deep_health_check', 'help', 'ping'],
  copilot: ['copilot', 'suggest', 'explain', 'identity', 'health_check', 'deep_health_check', 'help', 'ping'],
  opencode: ['opencode', 'opencode_check_update', 'identity', 'health_check', 'deep_health_check', 'help', 'ping'],
};

function allCommandFiles() {
  return fs.readdirSync(CMD_DIR).filter(f => f.endsWith('.md')).map(f => path.join(CMD_DIR, f));
}

// Matches mcp__<server>__<tool>
const MCP_REF = /mcp__([a-z0-9-]+)__([a-z_]+)/gi;

describe('skill MCP tool name hygiene (commands/nf/*.md)', () => {
  it('uses no CLI-suffixed or un-suffixed CLI server names (codex/gemini/copilot/opencode must be <slot>-N)', () => {
    const offenders = [];
    for (const file of allCommandFiles()) {
      const text = fs.readFileSync(file, 'utf8');
      let m;
      MCP_REF.lastIndex = 0;
      while ((m = MCP_REF.exec(text)) !== null) {
        const server = m[1];
        // Bare family name (e.g. "opencode") or "-cli" suffix → stale
        if (/^(codex|gemini|copilot|opencode)(-cli)?$/.test(server)) {
          offenders.push(`${path.basename(file)}: mcp__${server}__${m[2]}`);
        }
      }
    }
    assert.deepEqual(offenders, [], `Stale CLI server names (use <slot>-N):\n${offenders.join('\n')}`);
  });

  it('references only real tools on each CLI slot family', () => {
    const offenders = [];
    for (const file of allCommandFiles()) {
      const text = fs.readFileSync(file, 'utf8');
      let m;
      MCP_REF.lastIndex = 0;
      while ((m = MCP_REF.exec(text)) !== null) {
        const fam = m[1].replace(/-\d+$/, '');
        const tool = m[2];
        if (VALID_TOOLS[fam] && !VALID_TOOLS[fam].includes(tool)) {
          offenders.push(`${path.basename(file)}: mcp__${m[1]}__${tool} (no '${tool}' on ${fam})`);
        }
      }
    }
    assert.deepEqual(offenders, [], `Unknown MCP tool names:\n${offenders.join('\n')}`);
  });
});

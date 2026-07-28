'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MCP_BLOCK_BEGIN,
  MCP_BLOCK_END,
  convertMarkdownToCodexAgent,
  convertMarkdownToCodexSkill,
  ensureCodexProviders,
  normalizeDetectedProvider,
  replaceManagedMcpBlock,
} = require('./codex-install.cjs');

test('converts a Claude command into a minimal Codex skill', () => {
  const source = `---
name: nf:plan-phase
description: Plan a phase with /nf:verify-work
argument-hint: "[N]"
allowed-tools:
  - Read
  - Task
---
Run /nf:verify-work with $ARGUMENTS.
Task(subagent_type="nf-planner")
`;
  const skill = convertMarkdownToCodexSkill(source.replace(/\/nf:/g, '$nf:'), 'plan-phase');

  assert.equal(skill.name, 'nf:plan-phase');
  assert.equal(skill.description, 'Plan a phase with $nf:verify-work');
  assert.match(skill.content, /name: "nf:plan-phase"/);
  assert.doesNotMatch(skill.content, /allowed-tools|argument-hint/);
  assert.match(skill.content, /native Codex subagent delegation/);
  assert.match(skill.content, /\$nf:verify-work/);
});

test('normalizes unprefixed command names for Codex skill discovery', () => {
  const skill = convertMarkdownToCodexSkill(`---
name: close-formal-gaps
description: Close gaps
---
Do it.
`, 'close-formal-gaps');
  assert.equal(skill.name, 'nf:close-formal-gaps');
});

test('converts folded Markdown agent metadata to valid TOML string fields', () => {
  const source = `---
name: nf-reviewer
description: >
  Review correctness and
  preserve safety gates.
tools: Read, Bash
---
Follow the role.
`;
  const toml = convertMarkdownToCodexAgent(source, 'nf-reviewer');

  assert.match(toml, /^name = "nf-reviewer"$/m);
  assert.match(toml, /^description = "Review correctness and preserve safety gates\."$/m);
  assert.match(toml, /^developer_instructions = "/m);
  assert.doesNotMatch(toml, /^tools =/m);
});

test('replaces only the nForma-managed MCP TOML block idempotently', () => {
  const userConfig = 'model = "gpt-5.4"\n\n[features]\nhooks = true\n';
  const block = `${MCP_BLOCK_BEGIN}
[mcp_servers."nforma-gemini-1"]
command = "node"
${MCP_BLOCK_END}`;
  const first = replaceManagedMcpBlock(userConfig, block);
  const second = replaceManagedMcpBlock(first, block);

  assert.equal(first, second);
  assert.match(first, /model = "gpt-5\.4"/);
  assert.match(first, /\[features\]/);
  assert.equal(first.split(MCP_BLOCK_BEGIN).length - 1, 1);
});

test('normalizes an auto-detected CLI into an nForma provider slot', () => {
  const provider = normalizeDetectedProvider({
    name: 'codex',
    cli: 'codex',
    resolvedPath: '/usr/local/bin/codex',
  });

  assert.equal(provider.name, 'nforma-codex-1');
  assert.equal(provider.mainTool, 'codex');
  assert.equal(provider.cli, '/usr/local/bin/codex');
  assert.deepEqual(provider.args_template, ['exec', '{prompt}']);
  assert.equal(provider.extraTools[0].name, 'review');
});

test('keeps an explicitly selected numbered slot after adding the managed prefix', t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-codex-provider-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const providersPath = path.join(tmpDir, 'providers.json');
  fs.writeFileSync(providersPath, JSON.stringify({
    providers: [{
      name: 'gemini-1',
      mainTool: 'gemini',
      cli: 'gemini',
      args_template: ['-p', '{prompt}'],
    }],
  }));

  const active = ensureCodexProviders(providersPath, [], ['gemini-1']);

  assert.deepEqual(active.map(provider => provider.name), ['nforma-gemini-1']);
});

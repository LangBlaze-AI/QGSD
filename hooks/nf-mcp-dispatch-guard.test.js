#!/usr/bin/env node
// hooks/nf-mcp-dispatch-guard.test.js
// Tests for nf-mcp-dispatch-guard PreToolUse hook

'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const HOOK = path.join(__dirname, 'nf-mcp-dispatch-guard.js');

// Minimal test runner
const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

function run(input) {
  const result = spawnSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, NF_HOOK_PROFILE: 'standard' },
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
  };
}

function makeInput(toolName, toolInput) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput || {},
    cwd: process.cwd(),
  };
}

// TC1: Non-MCP tool calls pass through
test('TC1: Non-MCP tool calls are allowed', () => {
  const result = run(makeInput('Bash', { command: 'ls' }));
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout, '', 'stdout must be empty (no block)');
});

// TC2-TC6: Allowlisted suffixes pass through
test('TC2: ping tool is allowlisted', () => {
  const result = run(makeInput('mcp__codex-1__ping'));
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout, '');
});

test('TC3: health_check tool is allowlisted', () => {
  const result = run(makeInput('mcp__gemini-1__health_check'));
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout, '');
});

test('TC4: identity tool is allowlisted', () => {
  const result = run(makeInput('mcp__codex-1__identity'));
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout, '');
});

test('TC5: deep_health_check tool is allowlisted', () => {
  const result = run(makeInput('mcp__claude-1__deep_health_check'));
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout, '');
});

test('TC6: help tool is allowlisted', () => {
  const result = run(makeInput('mcp__opencode-1__help'));
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout, '');
});

// TC7-TC11: Quorum dispatch tools are BLOCKED
test('TC7: codex-1 review is BLOCKED', () => {
  const result = run(makeInput('mcp__codex-1__review'));
  assert.strictEqual(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout);
  assert.strictEqual(parsed.decision, 'block', 'decision must be "block"');
  assert.ok(parsed.reason.includes('R3.2'), 'reason must cite R3.2');
  assert.ok(parsed.reason.includes('mcp__codex-1__review'), 'reason must name the tool');
});

test('TC8: gemini-1 gemini is BLOCKED', () => {
  const result = run(makeInput('mcp__gemini-1__gemini'));
  const parsed = JSON.parse(result.stdout);
  assert.strictEqual(parsed.decision, 'block');
  assert.ok(parsed.reason.includes('nf-quorum-slot-worker'));
});

test('TC9: opencode-1 opencode is BLOCKED', () => {
  const result = run(makeInput('mcp__opencode-1__opencode'));
  const parsed = JSON.parse(result.stdout);
  assert.strictEqual(parsed.decision, 'block');
});

test('TC10: copilot-1 ask is BLOCKED', () => {
  const result = run(makeInput('mcp__copilot-1__ask'));
  const parsed = JSON.parse(result.stdout);
  assert.strictEqual(parsed.decision, 'block');
});

test('TC11: claude-1 claude is BLOCKED', () => {
  const result = run(makeInput('mcp__claude-1__claude'));
  const parsed = JSON.parse(result.stdout);
  assert.strictEqual(parsed.decision, 'block');
});

// TC12-TC13: Dual-subscription slots are also blocked
test('TC12: codex-2 review is BLOCKED (dual-sub slot)', () => {
  const result = run(makeInput('mcp__codex-2__review'));
  const parsed = JSON.parse(result.stdout);
  assert.strictEqual(parsed.decision, 'block');
});

test('TC13: gemini-2 gemini is BLOCKED (dual-sub slot)', () => {
  const result = run(makeInput('mcp__gemini-2__gemini'));
  const parsed = JSON.parse(result.stdout);
  assert.strictEqual(parsed.decision, 'block');
});

// TC14: Unknown MCP servers pass through (not quorum slots from providers.json)
test('TC14: unknown MCP server passes through (not in providers.json)', () => {
  const result = run(makeInput('mcp__my-custom-server__query'));
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout, '');
});

// TC15: Empty stdin fails open
test('TC15: empty stdin fails open', () => {
  const result = spawnSync('node', [HOOK], {
    input: '',
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '');
});

// TC16: Malformed JSON fails open
test('TC16: malformed JSON fails open', () => {
  const result = spawnSync('node', [HOOK], {
    input: 'not json',
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '');
});

// TC17: codex-1 codex (non-review suffix) is also BLOCKED
test('TC17: codex-1 codex tool is BLOCKED', () => {
  const result = run(makeInput('mcp__codex-1__codex'));
  const parsed = JSON.parse(result.stdout);
  assert.strictEqual(parsed.decision, 'block');
});

// TC18: KNOWN_FAMILIES is populated from providers.json with all expected families
test('TC18: KNOWN_FAMILIES contains expected families from providers.json', () => {
  const { KNOWN_FAMILIES } = require('./nf-mcp-dispatch-guard');
  assert.strictEqual(KNOWN_FAMILIES.has('codex'), true, 'codex family should be present');
  assert.strictEqual(KNOWN_FAMILIES.has('gemini'), true, 'gemini family should be present');
  assert.strictEqual(KNOWN_FAMILIES.has('opencode'), true, 'opencode family should be present');
  assert.strictEqual(KNOWN_FAMILIES.has('copilot'), true, 'copilot family should be present');
  assert.strictEqual(KNOWN_FAMILIES.has('claude'), true, 'claude family should be present');
  assert.ok(KNOWN_FAMILIES.size >= 5, 'should have at least 5 families');
});

// TC19: KNOWN_FAMILIES does NOT contain numbered slots, only derived families
test('TC19: KNOWN_FAMILIES correctly derives families by stripping -N suffix', () => {
  const { KNOWN_FAMILIES, loadKnownFamilies } = require('./nf-mcp-dispatch-guard');
  // Verify numbered slots are NOT in the set
  assert.strictEqual(KNOWN_FAMILIES.has('codex-1'), false, 'codex-1 should NOT be in set (only codex)');
  assert.strictEqual(KNOWN_FAMILIES.has('codex-2'), false, 'codex-2 should NOT be in set');
  assert.strictEqual(KNOWN_FAMILIES.has('gemini-1'), false, 'gemini-1 should NOT be in set (only gemini)');
  assert.strictEqual(KNOWN_FAMILIES.has('gemini-2'), false, 'gemini-2 should NOT be in set');
  assert.strictEqual(KNOWN_FAMILIES.has('claude-1'), false, 'claude-1 should NOT be in set (only claude)');
  assert.strictEqual(KNOWN_FAMILIES.has('claude-4'), false, 'claude-4 should NOT be in set');
  // Verify loadKnownFamilies works (returns a Set)
  const families = loadKnownFamilies();
  assert.ok(families instanceof Set, 'loadKnownFamilies should return a Set');
  assert.ok(families.size >= 5, 'derived families should be at least 5');
});

// ADVERSARIAL: MCP tool name with slot family NOT in SLOT_TOOL_SUFFIX falls back to 'claude'
// Slots like "ccr-1" or "custom-1" derive family "ccr"/"custom" which aren't in the suffix map.
// This test verifies the fallback behavior — such slots are NOT blocked even if they're in KNOWN_FAMILIES.
test('ADVERSARIAL: slot family not in SLOT_TOOL_SUFFIX fallback behavior', () => {
  // 'custom-family-1' is not in KNOWN_FAMILIES, so it passes through
  const result = run(makeInput('mcp__custom-family-1__ask'));
  assert.strictEqual(result.exitCode, 0, 'mcp__custom-family-1__ask should pass through (custom-family not in KNOWN_FAMILIES)');
  assert.strictEqual(result.stdout, '', 'stdout must be empty — not blocked');
});

// DG-1 ADVERSARIAL: null/non-object provider entry must not nuke the whole family set
test('ADVERSARIAL: null/non-object provider entry does not nuke the family set', () => {
  const fs = require('fs');
  const resolveBin = require('./nf-resolve-bin');
  const { loadKnownFamilies } = require('./nf-mcp-dispatch-guard');
  const providersPath = resolveBin('providers.json');
  const backup = fs.readFileSync(providersPath, 'utf8');
  try {
    fs.writeFileSync(providersPath, JSON.stringify({
      providers: [null, 'not-an-object', { name: 'codex-1' }, { name: 'gemini-1' }],
    }));
    const families = loadKnownFamilies();
    assert.ok(families instanceof Set, 'should still return a Set');
    assert.strictEqual(families.has('codex'), true, 'codex family must survive a null sibling entry');
    assert.strictEqual(families.has('gemini'), true, 'gemini family must survive a null sibling entry');
  } finally {
    fs.writeFileSync(providersPath, backup);
  }
});

// Run all tests
for (const t of tests) {
  try {
    t.fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${t.name}`);
    console.log(`    ${e.message}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env node
// Test suite for hooks/nf-stop.js
// Uses Node.js built-in test runner: node --test hooks/nf-stop.test.js
//
// Each test spawns the hook as a child process with mock stdin and a synthetic
// JSONL transcript written to a temp file. Captures stdout + exit code.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK_PATH = path.join(__dirname, 'nf-stop.js');

// Helper: write a temp JSONL file and return its path
function writeTempTranscript(lines) {
  const tmpFile = path.join(os.tmpdir(), `nf-stop-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(tmpFile, lines.join('\n') + '\n', 'utf8');
  return tmpFile;
}

// Helper: run the hook with a given stdin JSON payload, return { stdout, exitCode }
function runHook(stdinPayload) {
  const result = spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify(stdinPayload),
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
  };
}

// Helper: run the hook with a given stdin JSON payload and additional env vars
// Used for TC11-TC13 to inject NF_CLAUDE_JSON for deterministic MCP availability testing.
// Also accepts an optional cwd to isolate from the project's .claude/nf.json.
function runHookWithEnv(stdinPayload, extraEnv, hookCwd) {
  const opts = {
    input: JSON.stringify(stdinPayload),
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, ...extraEnv },
  };
  if (hookCwd) opts.cwd = hookCwd;
  const result = spawnSync('node', [HOOK_PATH], opts);
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
  };
}

// Helper: run the hook with a given stdin JSON payload, env vars, and cwd override
// Used for profile guard tests to place nf.json config in a temp directory
function runHookWithCwd(stdinPayload, hookCwd, extraEnv) {
  const result = spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify(stdinPayload),
    encoding: 'utf8',
    timeout: 5000,
    cwd: hookCwd,
    env: { ...process.env, ...(extraEnv || {}) },
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
  };
}

// JSONL builder helpers
function userLine(content, uuid = 'user-1') {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    timestamp: '2026-02-20T00:00:00Z',
    uuid,
  });
}

function assistantLine(contentBlocks, uuid = 'assistant-1') {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: contentBlocks,
      stop_reason: contentBlocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    },
    timestamp: '2026-02-20T00:01:00Z',
    uuid,
  });
}

function toolUseBlock(name) {
  return { type: 'tool_use', id: `toolu_${name}`, name, input: { content: 'test plan' } };
}

function bashCommitBlock(commitCmd) {
  return { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: commitCmd } };
}

// --- Test Cases ---

// Test 1: stop_hook_active: true → exit 0, no stdout (infinite loop guard)
test('TC1: stop_hook_active true exits immediately with no output', () => {
  const tmpFile = writeTempTranscript([userLine('/nf:plan-phase 1')]);
  try {
    const { stdout, exitCode } = runHook({
      stop_hook_active: true,
      hook_event_name: 'Stop',
      transcript_path: tmpFile,
      last_assistant_message: 'Here is the plan',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty (no block decision)');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// Test 2: hook_event_name SubagentStop → exit 0, no stdout (subagent exclusion)
test('TC2: SubagentStop exits immediately with no output', () => {
  const tmpFile = writeTempTranscript([userLine('/nf:plan-phase 1')]);
  try {
    const { stdout, exitCode } = runHook({
      stop_hook_active: false,
      hook_event_name: 'SubagentStop',
      transcript_path: tmpFile,
      last_assistant_message: 'SubagentStop response',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// Test 3: transcript_path nonexistent → exit 0, no stdout (fail-open)
test('TC3: nonexistent transcript_path exits 0 with no output (fail-open)', () => {
  const { stdout, exitCode } = runHook({
    stop_hook_active: false,
    hook_event_name: 'Stop',
    transcript_path: '/nonexistent/path/that/does/not/exist.jsonl',
    last_assistant_message: '',
  });
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  assert.strictEqual(stdout, '', 'stdout must be empty');
});

// Test 4: transcript with no planning command in current turn → exit 0, no stdout
test('TC4: no planning command in current turn passes (no block)', () => {
  const tmpFile = writeTempTranscript([
    userLine('What time is it?'),
    assistantLine([{ type: 'text', text: 'It is noon.' }]),
  ]);
  try {
    const { stdout, exitCode } = runHook({
      stop_hook_active: false,
      hook_event_name: 'Stop',
      transcript_path: tmpFile,
      last_assistant_message: 'It is noon.',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty (no block needed)');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// Test 5: /nf:plan-phase in current turn + all 3 quorum tool_use blocks → exit 0, no stdout
test('TC5: planning command with all three quorum tool calls passes', () => {
  const tmpFile = writeTempTranscript([
    userLine('/nf:plan-phase 1'),
    assistantLine([
      toolUseBlock('mcp__codex-cli__review'),
      toolUseBlock('mcp__gemini-cli__gemini'),
      toolUseBlock('mcp__opencode__opencode'),
    ]),
    assistantLine([{ type: 'text', text: 'Here is the plan.' }], 'assistant-2'),
  ]);
  try {
    const { stdout, exitCode } = runHook({
      stop_hook_active: false,
      hook_event_name: 'Stop',
      transcript_path: tmpFile,
      last_assistant_message: 'Here is the plan.',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty (quorum complete)');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// Test 5b: /qnf:plan-phase — quorum present → pass (mirrors TC5 with /qnf: prefix)
test('TC5b: /qnf:plan-phase — quorum present → pass', () => {
  const tmpFile = writeTempTranscript([
    userLine('/qnf:plan-phase 1'),
    assistantLine([
      toolUseBlock('mcp__codex-cli__review'),
      toolUseBlock('mcp__gemini-cli__gemini'),
      toolUseBlock('mcp__opencode__opencode'),
    ]),
    assistantLine([{ type: 'text', text: 'Here is the plan.' }], 'assistant-2'),
  ]);
  try {
    const { stdout, exitCode } = runHook({
      stop_hook_active: false,
      hook_event_name: 'Stop',
      transcript_path: tmpFile,
      last_assistant_message: 'Here is the plan.',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty — /qnf: prefix recognized and quorum complete');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// Test 6: /nf:plan-phase in current turn + only codex tool_use → block with decision:block
// TC6 updated (step 1a): includes a PLAN.md artifact commit so GUARD 5 classifies this as a
// decision turn, preserving the invariant: quorum-command + decision-turn + partial quorum = block.
// TC6 uses runHookWithEnv to isolate from ~/.claude/nf.json (which may override DEFAULT_CONFIG
// prefixes with -1 suffixes). HOME points to an empty temp dir so loadConfig() uses DEFAULT_CONFIG.
// NF_CLAUDE_JSON points to a temp file listing gemini-cli and opencode as available MCP servers
// so they appear in the missing list and satisfy the string assertions.
test('TC6: planning command with only codex tool call triggers block', () => {
  // Create a temp HOME dir with no nf.json — forces DEFAULT_CONFIG usage
  const homeDir = path.join(os.tmpdir(), `nf-home-tc6-${Date.now()}`);
  fs.mkdirSync(homeDir, { recursive: true });

  // Create a temp ~/.claude.json listing gemini-cli and opencode as available MCP servers
  const claudeJsonTmp = path.join(os.tmpdir(), `nf-claude-tc6-${Date.now()}.json`);
  fs.writeFileSync(claudeJsonTmp, JSON.stringify({
    mcpServers: {
      'codex-cli': {},
      'gemini-cli': {},
      'opencode': {},
    },
  }), 'utf8');

  const tmpFile = writeTempTranscript([
    userLine('/nf:plan-phase 1'),
    assistantLine([
      toolUseBlock('mcp__codex-cli__review'),
    ]),
    assistantLine([
      bashCommitBlock('node /path/nf-tools.cjs commit "feat: plan" --files 04-01-PLAN.md'),
    ], 'assistant-commit'),
    assistantLine([{ type: 'text', text: 'Here is the plan.' }], 'assistant-2'),
  ]);
  try {
    const { stdout, exitCode } = runHookWithEnv(
      {
        stop_hook_active: false,
        hook_event_name: 'Stop',
        transcript_path: tmpFile,
        last_assistant_message: 'Here is the plan.',
      },
      {
        HOME: homeDir,           // No ~/.claude/nf.json → loadConfig() uses DEFAULT_CONFIG
        NF_CLAUDE_JSON: claudeJsonTmp, // Deterministic MCP server list
      },
      homeDir // Isolate cwd from project .claude/nf.json
    );
    assert.strictEqual(exitCode, 0, 'exit code must be 0 even when blocking');
    assert.ok(stdout.length > 0, 'stdout must contain block decision JSON');
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.decision, 'block', 'decision must be "block"');
    assert.ok(parsed.reason.startsWith('QUORUM REQUIRED:'), 'reason must start with QUORUM REQUIRED:');
    // Should name the missing tools (DEFAULT_CONFIG prefixes)
    assert.ok(parsed.reason.includes('mcp__gemini-cli__'), 'reason must name missing gemini tool');
    assert.ok(parsed.reason.includes('mcp__opencode__'), 'reason must name missing opencode tool');
  } finally {
    fs.unlinkSync(tmpFile);
    fs.unlinkSync(claudeJsonTmp);
  }
});

// Test 7: /nf:plan-phase in OLD turn (before current turn boundary) → exit 0, no stdout (scope filter)
test('TC7: planning command only in old turn (before boundary) is not in scope', () => {
  const tmpFile = writeTempTranscript([
    // Old turn: planning command + assistant response (but no quorum)
    userLine('/nf:plan-phase 1', 'old-user'),
    assistantLine([{ type: 'text', text: 'Old response, no quorum done.' }], 'old-assistant'),
    // New turn: unrelated user message (this becomes the current turn boundary)
    userLine('Thanks, looks good.', 'new-user'),
    assistantLine([{ type: 'text', text: 'Great!' }], 'new-assistant'),
  ]);
  try {
    const { stdout, exitCode } = runHook({
      stop_hook_active: false,
      hook_event_name: 'Stop',
      transcript_path: tmpFile,
      last_assistant_message: 'Great!',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty (old turn planning not in scope)');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// Test 8: malformed JSONL lines → skip gracefully, hook still works
test('TC8: malformed JSONL lines are skipped gracefully', () => {
  const tmpFile = writeTempTranscript([
    'this is not valid json',
    userLine('/nf:plan-phase 1'),
    '{broken json: [',
    assistantLine([
      toolUseBlock('mcp__codex-cli__review'),
      toolUseBlock('mcp__gemini-cli__gemini'),
      toolUseBlock('mcp__opencode__opencode'),
    ]),
    'another bad line',
  ]);
  try {
    const { stdout, exitCode } = runHook({
      stop_hook_active: false,
      hook_event_name: 'Stop',
      transcript_path: tmpFile,
      last_assistant_message: 'Here is the plan.',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty (quorum found despite malformed lines)');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// Test 9: config file missing → DEFAULT_CONFIG used, hook still works
// TC9 updated (step 1a): includes a RESEARCH.md artifact commit so GUARD 5 classifies this as a
// decision turn, preserving the invariant: quorum-command + decision-turn + no quorum = block.
// TC9 uses runHookWithEnv to isolate from ~/.claude/nf.json (which may override DEFAULT_CONFIG
// prefixes with -1 suffixes). HOME points to an empty temp dir so loadConfig() uses DEFAULT_CONFIG.
// NF_CLAUDE_JSON points to a non-existent path so getAvailableMcpPrefixes() returns null,
// meaning all models are treated as available (conservative enforcement) and DEFAULT_CONFIG names appear.
test('TC9: missing config file falls back to DEFAULT_CONFIG', () => {
  // Create a temp HOME dir with no nf.json — forces DEFAULT_CONFIG usage
  const homeDir = path.join(os.tmpdir(), `nf-home-tc9-${Date.now()}`);
  fs.mkdirSync(homeDir, { recursive: true });

  // Point NF_CLAUDE_JSON to a non-existent file → getAvailableMcpPrefixes() returns null
  // → all models treated as available (conservative) → DEFAULT_CONFIG names appear in block reason
  const nonExistentClaudeJson = path.join(os.tmpdir(), `nf-claude-tc9-nonexistent-${Date.now()}.json`);

  const tmpFile = writeTempTranscript([
    userLine('/nf:research-phase 1'),
    assistantLine([
      bashCommitBlock('node /path/nf-tools.cjs commit "docs: research" --files 04-RESEARCH.md'),
    ], 'assistant-commit'),
    assistantLine([{ type: 'text', text: 'No quorum calls here.' }]),
  ]);
  try {
    const { stdout, exitCode } = runHookWithEnv(
      {
        stop_hook_active: false,
        hook_event_name: 'Stop',
        transcript_path: tmpFile,
        last_assistant_message: 'No quorum calls here.',
      },
      {
        HOME: homeDir,                         // No ~/.claude/nf.json → DEFAULT_CONFIG
        NF_CLAUDE_JSON: nonExistentClaudeJson, // Missing → null prefixes → conservative enforcement
      },
      homeDir // Isolate cwd from project .claude/nf.json
    );
    assert.strictEqual(exitCode, 0, 'exit code must be 0 even when blocking');
    assert.ok(stdout.length > 0, 'stdout must contain block decision');
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.decision, 'block');
    assert.ok(parsed.reason.includes('QUORUM REQUIRED:'), 'reason must include QUORUM REQUIRED');
    // Default config model tool prefixes should be in the reason
    assert.ok(
      parsed.reason.includes('mcp__codex-cli__') ||
      parsed.reason.includes('mcp__gemini-cli__') ||
      parsed.reason.includes('mcp__opencode__'),
      'reason must name at least one default model tool'
    );
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// Test 10: Regression — quorum calls interleaved with tool_result user messages
// This reproduces the live false-positive: getCurrentTurnLines() must skip
// tool_result user messages and use the human text message as the boundary.
function toolResultLine(toolUseId, resultContent, uuid) {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: resultContent }],
    },
    timestamp: '2026-02-20T00:01:00Z',
    uuid: uuid || `tr-${toolUseId}`,
  });
}

test('TC10: quorum calls interleaved with tool_result user messages are in scope', () => {
  // Simulates a multi-tool turn: human message → tool calls → tool_results → more calls
  // The quorum calls appear between intermediate tool_result user messages.
  // getCurrentTurnLines() must find the human message as the boundary, not a tool_result.
  const tmpFile = writeTempTranscript([
    // Human turn starts here
    userLine('/nf:plan-phase 1', 'human-msg'),
    // First batch of tool calls (non-quorum — e.g., Task/Bash)
    assistantLine([toolUseBlock('Bash')], 'assistant-1'),
    toolResultLine('toolu_Bash', 'bash output', 'tr-1'),
    // Second batch — quorum calls
    assistantLine([
      toolUseBlock('mcp__codex-cli__review'),
    ], 'assistant-2'),
    toolResultLine('toolu_codex', 'codex review result', 'tr-2'),
    assistantLine([
      toolUseBlock('mcp__gemini-cli__gemini'),
    ], 'assistant-3'),
    toolResultLine('toolu_gemini', 'gemini result', 'tr-3'),
    assistantLine([
      toolUseBlock('mcp__opencode__opencode'),
    ], 'assistant-4'),
    // Final tool_result before the final assistant text
    toolResultLine('toolu_opencode', 'opencode result', 'tr-4'),
    assistantLine([{ type: 'text', text: 'Here is the plan with quorum complete.' }], 'assistant-5'),
  ]);
  try {
    const { stdout, exitCode } = runHook({
      stop_hook_active: false,
      hook_event_name: 'Stop',
      transcript_path: tmpFile,
      last_assistant_message: 'Here is the plan with quorum complete.',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty — quorum calls are in scope despite tool_result boundaries');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// ── TC11-TC13: Fail-open unavailability detection ──────────────────────────────
//
// These tests use NF_CLAUDE_JSON env var to inject a deterministic ~/.claude.json
// substitute. The hook must read this env var via:
//   const claudeJsonPath = process.env.NF_CLAUDE_JSON || path.join(os.homedir(), '.claude.json');
// This env var is for testing only — production always uses ~/.claude.json.
//
// TC11: Model prefix not in mcpServers → unavailable → fail-open (pass)
// TC12: Partial availability — one model unavailable (pass), one available+missing (block)
// TC13: MCP-06 regression — renamed prefix matched correctly (pass)

// TC11: opencode prefix not in mcpServers (empty servers) → unavailable → pass (fail-open)
test('TC11: model prefix not in mcpServers → unavailable → fail-open pass', () => {
  // Create temp ~/.claude.json substitute with empty mcpServers
  const claudeJsonTmp = path.join(os.tmpdir(), `nf-claude-tc11-${Date.now()}.json`);
  fs.writeFileSync(claudeJsonTmp, JSON.stringify({ mcpServers: {} }), 'utf8');

  // Transcript: quorum command issued, but no quorum tool_use calls at all
  const tmpFile = writeTempTranscript([
    userLine('/nf:plan-phase 1', 'human-msg'),
    assistantLine([{ type: 'text', text: 'Here is the plan.' }], 'assistant-1'),
  ]);

  try {
    // Config requires codex-cli prefix; empty mcpServers → codex-cli unavailable → pass
    const configPayload = JSON.stringify({
      quorum_commands: ['plan-phase'],
      fail_mode: 'open',
      required_models: {
        codex: { tool_prefix: 'mcp__codex-cli__', required: true },
      },
    });
    const configTmp = path.join(os.tmpdir(), `nf-cfg-tc11-${Date.now()}.json`);
    const nfConfigDir = path.join(os.tmpdir(), `nf-home-tc11-${Date.now()}`);
    fs.mkdirSync(nfConfigDir, { recursive: true });
    fs.writeFileSync(path.join(nfConfigDir, 'nf.json'), configPayload, 'utf8');

    const { stdout, exitCode } = runHookWithEnv(
      {
        stop_hook_active: false,
        hook_event_name: 'Stop',
        transcript_path: tmpFile,
        last_assistant_message: 'Here is the plan.',
      },
      {
        NF_CLAUDE_JSON: claudeJsonTmp,
        HOME: nfConfigDir,
      },
      nfConfigDir // Isolate cwd from project .claude/nf.json
    );
    assert.strictEqual(exitCode, 0, 'exit code must be 0 — unavailable model → fail-open pass');
    assert.strictEqual(stdout, '', 'stdout must be empty — no block for unavailable model');
  } finally {
    fs.unlinkSync(tmpFile);
    fs.unlinkSync(claudeJsonTmp);
  }
});

// TC12: Partial availability — gemini not in mcpServers (unavailable → skip), codex IS in mcpServers but not called → block
// TC12 updated (step 1a): includes a PLAN.md artifact commit so GUARD 5 classifies this as a
// decision turn, preserving the invariant: quorum-command + decision-turn + available-but-missing = block.
test('TC12: partial availability — unavailable model skipped, available-but-missing model blocks', () => {
  // Create temp ~/.claude.json with only codex-cli in mcpServers (gemini absent)
  const claudeJsonTmp = path.join(os.tmpdir(), `nf-claude-tc12-${Date.now()}.json`);
  fs.writeFileSync(claudeJsonTmp, JSON.stringify({ mcpServers: { 'codex-cli': {} } }), 'utf8');

  // Transcript: quorum command issued, PLAN.md artifact commit, no quorum calls
  const tmpFile = writeTempTranscript([
    userLine('/nf:plan-phase 1', 'human-msg'),
    assistantLine([
      bashCommitBlock('node /path/nf-tools.cjs commit "feat: plan" --files 04-01-PLAN.md'),
    ], 'assistant-commit'),
    assistantLine([{ type: 'text', text: 'Here is the plan.' }], 'assistant-1'),
  ]);

  try {
    const configPayload = JSON.stringify({
      quorum_commands: ['plan-phase'],
      fail_mode: 'open',
      required_models: {
        codex:  { tool_prefix: 'mcp__codex-cli__',  required: true },
        gemini: { tool_prefix: 'mcp__gemini-cli__', required: true },
      },
    });
    const nfConfigDir = path.join(os.tmpdir(), `nf-home-tc12-${Date.now()}`);
    fs.mkdirSync(nfConfigDir, { recursive: true });
    fs.writeFileSync(path.join(nfConfigDir, 'nf.json'), configPayload, 'utf8');

    const { stdout, exitCode } = runHookWithEnv(
      {
        stop_hook_active: false,
        hook_event_name: 'Stop',
        transcript_path: tmpFile,
        last_assistant_message: 'Here is the plan.',
      },
      {
        NF_CLAUDE_JSON: claudeJsonTmp,
        HOME: nfConfigDir,
      },
      nfConfigDir // Isolate cwd from project .claude/nf.json
    );
    // codex IS in mcpServers but was not called → block
    assert.strictEqual(exitCode, 0, 'exit code must be 0 — hook communicates via stdout JSON, not exit code');
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.decision, 'block', 'should block — codex available+missing');
    assert.ok(parsed.reason.includes('codex') || parsed.reason.includes('mcp__codex-cli__'), 'block reason should name codex');
  } finally {
    fs.unlinkSync(tmpFile);
    fs.unlinkSync(claudeJsonTmp);
  }
});

// TC13: MCP-06 regression — renamed prefix matched correctly (pass when called)
test('TC13: MCP-06 regression — renamed prefix detected and matched correctly', () => {
  // Config has a custom prefix (renamed MCP server); mcpServers has that server; transcript has a call
  const claudeJsonTmp = path.join(os.tmpdir(), `nf-claude-tc13-${Date.now()}.json`);
  fs.writeFileSync(claudeJsonTmp, JSON.stringify({ mcpServers: { 'my-custom-codex': {} } }), 'utf8');

  const tmpFile = writeTempTranscript([
    userLine('/nf:plan-phase 1', 'human-msg'),
    assistantLine([toolUseBlock('mcp__my-custom-codex__review')], 'assistant-1'),
    assistantLine([{ type: 'text', text: 'Plan with custom codex.' }], 'assistant-2'),
  ]);

  try {
    const configPayload = JSON.stringify({
      quorum_commands: ['plan-phase'],
      fail_mode: 'open',
      required_models: {
        custom: { tool_prefix: 'mcp__my-custom-codex__', required: true },
      },
    });
    const nfConfigDir = path.join(os.tmpdir(), `nf-home-tc13-${Date.now()}`);
    fs.mkdirSync(nfConfigDir, { recursive: true });
    fs.writeFileSync(path.join(nfConfigDir, 'nf.json'), configPayload, 'utf8');

    const { stdout, exitCode } = runHookWithEnv(
      {
        stop_hook_active: false,
        hook_event_name: 'Stop',
        transcript_path: tmpFile,
        last_assistant_message: 'Plan with custom codex.',
      },
      {
        NF_CLAUDE_JSON: claudeJsonTmp,
        HOME: nfConfigDir,
      },
      nfConfigDir // Isolate cwd from project .claude/nf.json
    );
    // custom prefix IS in mcpServers AND was called → pass
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty — renamed prefix found evidence → pass');
  } finally {
    fs.unlinkSync(tmpFile);
    fs.unlinkSync(claudeJsonTmp);
  }
});

// ── TC-COPILOT: deriveMissingToolName returns 'ask' for modelKey 'copilot' ──────────────────────
//
// Verifies that when copilot is a required model and is not called on a decision turn,
// the block reason correctly names mcp__copilot-cli__ask (not mcp__copilot-cli__copilot).
//
// Uses NF_CLAUDE_JSON with copilot-cli in mcpServers to force it to be treated as available,
// so it triggers a block (not unavailable skip).

test('TC-COPILOT: deriveMissingToolName returns "ask" for copilot — block reason names mcp__copilot-cli__ask', () => {
  // claude.json with copilot-cli in mcpServers → available
  const claudeJsonTmp = path.join(os.tmpdir(), `nf-claude-tc-copilot-${Date.now()}.json`);
  fs.writeFileSync(claudeJsonTmp, JSON.stringify({ mcpServers: { 'copilot-cli': {} } }), 'utf8');

  // Config: only copilot required
  const configPayload = JSON.stringify({
    quorum_commands: ['plan-phase'],
    fail_mode: 'open',
    required_models: {
      copilot: { tool_prefix: 'mcp__copilot-cli__', required: true },
    },
  });
  const nfConfigDir = path.join(os.tmpdir(), `nf-home-tc-copilot-${Date.now()}`);
  fs.mkdirSync(nfConfigDir, { recursive: true });
  fs.writeFileSync(path.join(nfConfigDir, 'nf.json'), configPayload, 'utf8');

  // Transcript: plan-phase command + PLAN.md artifact commit + no copilot tool call
  const tmpFile = writeTempTranscript([
    userLine('/nf:plan-phase 1', 'human-msg'),
    assistantLine([
      bashCommitBlock('node /path/nf-tools.cjs commit "feat: plan" --files 04-01-PLAN.md'),
    ], 'assistant-commit'),
    assistantLine([{ type: 'text', text: 'Here is the plan.' }], 'assistant-1'),
  ]);

  try {
    const { stdout, exitCode } = runHookWithEnv(
      {
        stop_hook_active: false,
        hook_event_name: 'Stop',
        transcript_path: tmpFile,
        last_assistant_message: 'Here is the plan.',
      },
      {
        NF_CLAUDE_JSON: claudeJsonTmp,
        HOME: nfConfigDir,
      },
      nfConfigDir // Isolate cwd from project .claude/nf.json
    );
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.length > 0, 'stdout must contain block decision');
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.decision, 'block', 'should block — copilot available+missing');
    assert.ok(
      parsed.reason.includes('mcp__copilot-cli__ask'),
      'block reason must name mcp__copilot-cli__ask (not mcp__copilot-cli__copilot)'
    );
  } finally {
    fs.unlinkSync(tmpFile);
    fs.unlinkSync(claudeJsonTmp);
  }
});

// ── TC14-TC19: GUARD 5 — Decision turn detection (SCOPE-01/02/03/05/06/07) ─────────────────────
//
// TC14: intermediate plan-phase turn (no artifact commit, no marker) → PASS (not a decision turn)
// TC15: final plan-phase turn with PLAN.md artifact committed → QUORUM REQUIRED (decision turn)
// TC16: map-codebase turn (codebase/*.md commit, no artifact pattern match) → PASS
// TC17: new-project routing turn (no artifact commit, no marker) → PASS
// TC18: discuss-phase final turn with CONTEXT.md artifact committed → QUORUM REQUIRED
// TC19: verify-work turn with <!-- NF_DECISION --> marker in last text block → QUORUM REQUIRED

// TC14: intermediate plan-phase turn — assistant spawns an agent, no artifact commit, no marker
test('TC14: intermediate plan-phase turn (no artifact commit, no marker) passes without quorum block', () => {
  const tmpFile = writeTempTranscript([
    userLine('/nf:plan-phase 1'),
    assistantLine([{ type: 'text', text: 'Spawning researcher agent...' }]),
  ]);
  try {
    const { stdout, exitCode } = runHook({
      stop_hook_active: false,
      hook_event_name: 'Stop',
      transcript_path: tmpFile,
      last_assistant_message: 'Spawning researcher agent...',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty — intermediate turn is not a decision turn');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// TC15: final plan-phase turn — PLAN.md artifact committed + no quorum calls → QUORUM REQUIRED
test('TC15: final plan-phase turn with PLAN.md artifact committed blocks when quorum missing', () => {
  const tmpFile = writeTempTranscript([
    userLine('/nf:plan-phase 1'),
    assistantLine([
      bashCommitBlock('node /path/nf-tools.cjs commit "feat: plan" --files 04-01-PLAN.md'),
    ], 'assistant-commit'),
    assistantLine([{ type: 'text', text: 'Here is the plan.' }], 'assistant-2'),
  ]);
  try {
    const { stdout, exitCode } = runHook({
      stop_hook_active: false,
      hook_event_name: 'Stop',
      transcript_path: tmpFile,
      last_assistant_message: 'Here is the plan.',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0 even when blocking');
    assert.ok(stdout.length > 0, 'stdout must contain block decision JSON');
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.decision, 'block', 'decision must be "block"');
    assert.ok(parsed.reason.startsWith('QUORUM REQUIRED:'), 'reason must start with QUORUM REQUIRED:');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// TC16: map-codebase turn — commits codebase/STACK.md (no artifact pattern match) → PASS
// Guards against Pitfall 2 from RESEARCH.md: bare STACK.md must NOT trigger artifact detection.
test('TC16: map-codebase turn with codebase/*.md commit passes without quorum block', () => {
  const tmpFile = writeTempTranscript([
    userLine('/nf:plan-phase 1'),
    assistantLine([
      bashCommitBlock('node /path/nf-tools.cjs commit "docs: codebase" --files .planning/codebase/STACK.md'),
    ], 'assistant-commit'),
    assistantLine([{ type: 'text', text: 'Codebase mapped.' }], 'assistant-2'),
  ]);
  try {
    const { stdout, exitCode } = runHook({
      stop_hook_active: false,
      hook_event_name: 'Stop',
      transcript_path: tmpFile,
      last_assistant_message: 'Codebase mapped.',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty — codebase/*.md is not a planning artifact');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// TC17: new-project routing turn — assistant asks a question, no artifact commit, no marker → PASS
test('TC17: new-project routing turn (questioning step) passes without quorum block', () => {
  const tmpFile = writeTempTranscript([
    userLine('/nf:new-project'),
    assistantLine([{ type: 'text', text: 'What do you want to build?' }]),
  ]);
  try {
    const { stdout, exitCode } = runHook({
      stop_hook_active: false,
      hook_event_name: 'Stop',
      transcript_path: tmpFile,
      last_assistant_message: 'What do you want to build?',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty — routing/questioning turn is not a decision turn');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// TC18: discuss-phase final turn — CONTEXT.md artifact committed + no quorum calls → QUORUM REQUIRED
test('TC18: discuss-phase final turn with CONTEXT.md artifact committed blocks when quorum missing', () => {
  const tmpFile = writeTempTranscript([
    userLine('/nf:discuss-phase 4'),
    assistantLine([
      bashCommitBlock('node /path/nf-tools.cjs commit "docs: context" --files 04-CONTEXT.md'),
    ], 'assistant-commit'),
    assistantLine([{ type: 'text', text: 'Here are the filtered questions.' }], 'assistant-2'),
  ]);
  try {
    const { stdout, exitCode } = runHook({
      stop_hook_active: false,
      hook_event_name: 'Stop',
      transcript_path: tmpFile,
      last_assistant_message: 'Here are the filtered questions.',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0 even when blocking');
    assert.ok(stdout.length > 0, 'stdout must contain block decision JSON');
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.decision, 'block', 'decision must be "block"');
    assert.ok(parsed.reason.startsWith('QUORUM REQUIRED:'), 'reason must start with QUORUM REQUIRED:');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// TC19: verify-work turn with <!-- NF_DECISION --> in last assistant text block → QUORUM REQUIRED
test('TC19: verify-work turn with decision marker in last assistant text block blocks when quorum missing', () => {
  const tmpFile = writeTempTranscript([
    userLine('/nf:verify-work'),
    assistantLine([{ type: 'text', text: 'Verification complete.\n\n<!-- NF_DECISION -->' }]),
  ]);
  try {
    const { stdout, exitCode } = runHook({
      stop_hook_active: false,
      hook_event_name: 'Stop',
      transcript_path: tmpFile,
      last_assistant_message: 'Verification complete.\n\n<!-- NF_DECISION -->',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0 even when blocking');
    assert.ok(stdout.length > 0, 'stdout must contain block decision JSON');
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.decision, 'block', 'decision must be "block"');
    assert.ok(parsed.reason.startsWith('QUORUM REQUIRED:'), 'reason must start with QUORUM REQUIRED:');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// ── TC20/TC20b/TC20c: @file-expansion false-positive regression ───────────────────────────────
//
// When Claude Code expands a workflow file (e.g. quick.md) via @-reference, the expanded content
// is appended to the user message body. Workflow files often mention other /qnf: commands by name
// (e.g. "If you meant /qnf:new-project, run that instead."). The old JSON.stringify full-body
// scan would match these mentions and trigger a false-positive GUARD 4 hit.
//
// Fix: hasQuorumCommand reads the <command-name> XML tag first. This tag is injected by Claude
// Code only for real slash command invocations — never in @file-expanded content. When the tag
// is present, only the tag value is tested; the body is never scanned.
//
// TC20  — false-positive regression: /qnf:quick tag, body mentions /qnf:new-project → pass
// TC20b — positive control: /qnf:new-project real tag, questioning turn → pass (GUARD 5)
// TC20c — end-to-end: /qnf:new-project real tag + decision turn + no quorum → block

// Helper: build a user JSONL line whose message.content begins with the <command-name> XML tag
// (simulating Claude Code's injection for real slash command invocations) followed by the body.
function userLineWithTag(commandTag, bodyText, uuid) {
  const content = '<command-name>' + commandTag + '</command-name>\n\n' + bodyText;
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    timestamp: '2026-02-20T00:00:00Z',
    uuid: uuid || 'user-tagged',
  });
}

// TC20 — The false-positive regression:
// User invokes /qnf:quick (tag = "/qnf:quick"); body contains "new-project" text from
// expanded quick.md workflow. With the fix, the tag is read first ("/qnf:quick" is not in
// quorum_commands) → GUARD 4 returns false → exit 0. Body is never scanned.
test('TC20: @file-expanded body containing /qnf:new-project text does not false-positive when real command is /qnf:quick', () => {
  const expandedBody =
    'Execute the quick task.\n\n' +
    'If you meant /qnf:new-project, run that instead. ' +
    'See /qnf:new-project documentation for details.';
  const tmpFile = writeTempTranscript([
    userLineWithTag('/qnf:quick', expandedBody, 'user-quick'),
    assistantLine([{ type: 'text', text: 'Running quick task.' }], 'assistant-1'),
  ]);
  try {
    const { stdout, exitCode } = runHook({
      stop_hook_active: false,
      hook_event_name: 'Stop',
      transcript_path: tmpFile,
      last_assistant_message: 'Running quick task.',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0 — /qnf:quick is not a quorum command');
    assert.strictEqual(stdout, '', 'stdout must be empty — new-project in body must not trigger GUARD 4');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// TC20b — Positive control: new-project IS the real command (tag present), but no artifact commit
// and no decision marker — GUARD 5 passes (routing/questioning turn).
// Verifies the XML tag strategy correctly identifies real /qnf:new-project invocations.
test('TC20b: real /qnf:new-project tag on a questioning turn passes (GUARD 5 — not a decision turn)', () => {
  const tmpFile = writeTempTranscript([
    userLineWithTag('/qnf:new-project', 'I want to start a new project.', 'user-np'),
    assistantLine([{ type: 'text', text: 'What do you want to build?' }], 'assistant-1'),
  ]);
  try {
    const { stdout, exitCode } = runHook({
      stop_hook_active: false,
      hook_event_name: 'Stop',
      transcript_path: tmpFile,
      last_assistant_message: 'What do you want to build?',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0 — questioning turn is not a decision turn');
    assert.strictEqual(stdout, '', 'stdout must be empty — GUARD 5 passes, no artifact or marker');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// TC20c — End-to-end: new-project IS real (tag) + ROADMAP.md artifact commit (decision turn) + no quorum → block
// Verifies real /qnf:new-project invocations still trigger quorum enforcement on decision turns.
test('TC20c: real /qnf:new-project tag on a decision turn blocks when quorum missing', () => {
  const tmpFile = writeTempTranscript([
    userLineWithTag('/qnf:new-project', 'Build a task management app.', 'user-np2'),
    assistantLine([
      bashCommitBlock('node /path/nf-tools.cjs commit "docs: roadmap" --files ROADMAP.md'),
    ], 'assistant-commit'),
    assistantLine([{ type: 'text', text: 'Here is the roadmap.' }], 'assistant-2'),
  ]);
  try {
    const { stdout, exitCode } = runHook({
      stop_hook_active: false,
      hook_event_name: 'Stop',
      transcript_path: tmpFile,
      last_assistant_message: 'Here is the roadmap.',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0 even when blocking');
    assert.ok(stdout.length > 0, 'stdout must contain block decision JSON');
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.decision, 'block', 'decision must be "block"');
    assert.ok(parsed.reason.startsWith('QUORUM REQUIRED:'), 'reason must start with QUORUM REQUIRED:');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// ── TC-CEIL-1/2/3: Hard ceiling and error-response exclusion ──────────────────────────────────
//
// TC-CEIL-1: ceiling passes with exactly 5 successful calls out of an 11-agent pool
// TC-CEIL-2: ceiling blocks when only 4 of 5 required agents have been called
// TC-CEIL-3: error response does not count — 5 calls made but one is error → still blocks
//
// These tests use quorum_active (not required_models) and maxSize config to exercise
// the success-counter loop in nf-stop.js main().

// Helper: build a user JSONL line with a tool_result that has is_error:true
// Simulates an agent returning a quota/error response.
function toolResultErrorLine(toolUseId, errorText, uuid) {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        is_error: true,
        content: [{ type: 'text', text: errorText }],
      }],
    },
    timestamp: '2026-02-20T00:02:00Z',
    uuid: uuid || `tr-err-${toolUseId}`,
  });
}

// Helper: build a user JSONL line with a successful (non-error) tool_result
function toolResultSuccessLine(toolUseId, resultText, uuid) {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: [{ type: 'text', text: resultText }],
      }],
    },
    timestamp: '2026-02-20T00:02:00Z',
    uuid: uuid || `tr-ok-${toolUseId}`,
  });
}

// TC-CEIL-1: 11-agent pool, maxSize=5, preferSub=true
// First 5 sorted agents (4 sub + 1 api) all have successful responses → ceiling satisfied → pass
test('TC-CEIL-1: ceiling passes with exactly 5 successful calls out of 11-agent pool', () => {
  // Build config: 11 slots (4 sub + 7 api), maxSize = 5, preferSub = true
  const slots = [
    'slot-sub-1', 'slot-sub-2', 'slot-sub-3', 'slot-sub-4',  // sub agents
    'slot-api-1', 'slot-api-2', 'slot-api-3', 'slot-api-4',
    'slot-api-5', 'slot-api-6', 'slot-api-7',               // api agents
  ];
  const agentConfig = {};
  for (const s of slots) {
    agentConfig[s] = { auth_type: s.startsWith('slot-sub') ? 'sub' : 'api' };
  }
  const configPayload = JSON.stringify({
    quorum_commands: ['plan-phase'],
    quorum_active: slots,
    agent_config: agentConfig,
    quorum: { maxSize: 5, preferSub: true },
  });
  const homeDir = path.join(os.tmpdir(), `nf-home-ceil1-${Date.now()}`);
  const claudeDir = path.join(homeDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'nf.json'), configPayload, 'utf8');

  // ~/.claude.json lists all 11 slots as available MCP servers
  const claudeJsonTmp = path.join(os.tmpdir(), `nf-claude-ceil1-${Date.now()}.json`);
  const mcpServers = {};
  for (const s of slots) mcpServers[s] = {};
  fs.writeFileSync(claudeJsonTmp, JSON.stringify({ mcpServers }), 'utf8');

  // Transcript: plan-phase command + PLAN.md commit + first 5 agents called with successful results
  // Sorted order (sub-first): slot-sub-1, slot-sub-2, slot-sub-3, slot-sub-4, slot-api-1
  const first5 = ['slot-sub-1', 'slot-sub-2', 'slot-sub-3', 'slot-sub-4', 'slot-api-1'];
  const transcriptLines = [
    userLine('/qnf:plan-phase 1', 'human-ceil1'),
    assistantLine([
      bashCommitBlock('node /path/nf-tools.cjs commit "docs: plan" --files 04-01-PLAN.md'),
    ], 'assistant-commit'),
  ];
  for (const slot of first5) {
    const toolName = `mcp__${slot}__review`;
    transcriptLines.push(
      assistantLine([toolUseBlock(toolName)], `assistant-${slot}`),
      toolResultSuccessLine(`toolu_${toolName}`, `${slot} review OK`, `tr-${slot}`)
    );
  }
  transcriptLines.push(
    assistantLine([{ type: 'text', text: 'Plan complete with ceiling satisfied.' }], 'assistant-final')
  );

  const tmpFile = writeTempTranscript(transcriptLines);

  try {
    const { stdout, exitCode } = runHookWithEnv(
      {
        stop_hook_active: false,
        hook_event_name: 'Stop',
        transcript_path: tmpFile,
        last_assistant_message: 'Plan complete with ceiling satisfied.',
      },
      { HOME: homeDir, NF_CLAUDE_JSON: claudeJsonTmp },
      homeDir // Isolate cwd from project .claude/nf.json
    );
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty — 5 successful responses satisfies ceiling');
  } finally {
    fs.unlinkSync(tmpFile);
    fs.unlinkSync(claudeJsonTmp);
  }
});

// TC-CEIL-2: Same 11-agent pool, maxSize=5, but only 4 of the first 5 agents called → block
test('TC-CEIL-2: ceiling blocks when only 4 of 5 required agents have been called', () => {
  const slots = [
    'slot-sub-1', 'slot-sub-2', 'slot-sub-3', 'slot-sub-4',
    'slot-api-1', 'slot-api-2', 'slot-api-3', 'slot-api-4',
    'slot-api-5', 'slot-api-6', 'slot-api-7',
  ];
  const agentConfig = {};
  for (const s of slots) {
    agentConfig[s] = { auth_type: s.startsWith('slot-sub') ? 'sub' : 'api' };
  }
  const configPayload = JSON.stringify({
    quorum_commands: ['plan-phase'],
    quorum_active: slots,
    agent_config: agentConfig,
    quorum: { maxSize: 5, preferSub: true },
  });
  const homeDir = path.join(os.tmpdir(), `nf-home-ceil2-${Date.now()}`);
  const claudeDir = path.join(homeDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'nf.json'), configPayload, 'utf8');

  const claudeJsonTmp = path.join(os.tmpdir(), `nf-claude-ceil2-${Date.now()}.json`);
  const mcpServers = {};
  for (const s of slots) mcpServers[s] = {};
  fs.writeFileSync(claudeJsonTmp, JSON.stringify({ mcpServers }), 'utf8');

  // Only 4 of the first 5 sorted agents called (skip slot-api-1 — the 5th)
  const only4 = ['slot-sub-1', 'slot-sub-2', 'slot-sub-3', 'slot-sub-4'];
  const transcriptLines = [
    userLine('/qnf:plan-phase 1', 'human-ceil2'),
    assistantLine([
      bashCommitBlock('node /path/nf-tools.cjs commit "docs: plan" --files 04-01-PLAN.md'),
    ], 'assistant-commit'),
  ];
  for (const slot of only4) {
    const toolName = `mcp__${slot}__review`;
    transcriptLines.push(
      assistantLine([toolUseBlock(toolName)], `assistant-${slot}`),
      toolResultSuccessLine(`toolu_${toolName}`, `${slot} review OK`, `tr-${slot}`)
    );
  }
  transcriptLines.push(
    assistantLine([{ type: 'text', text: 'Plan with only 4 agents.' }], 'assistant-final')
  );

  const tmpFile = writeTempTranscript(transcriptLines);

  try {
    const { stdout, exitCode } = runHookWithEnv(
      {
        stop_hook_active: false,
        hook_event_name: 'Stop',
        transcript_path: tmpFile,
        last_assistant_message: 'Plan with only 4 agents.',
      },
      { HOME: homeDir, NF_CLAUDE_JSON: claudeJsonTmp },
      homeDir // Isolate cwd from project .claude/nf.json
    );
    assert.strictEqual(exitCode, 0, 'exit code must be 0 even when blocking');
    assert.ok(stdout.length > 0, 'stdout must contain block decision JSON');
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.decision, 'block', 'decision must be block — only 4 of 5 required');
    assert.ok(parsed.reason.startsWith('QUORUM REQUIRED:'), 'reason must start with QUORUM REQUIRED:');
    // The 5th agent (slot-api-1) should be named as missing
    assert.ok(parsed.reason.includes('slot-api-1'), 'block reason must name slot-api-1 as missing');
  } finally {
    fs.unlinkSync(tmpFile);
    fs.unlinkSync(claudeJsonTmp);
  }
});

// TC-CEIL-3: error response does not count toward ceiling
// 6 slots active, maxSize=5 (so failover scenario: 5 calls made but slot-3 returns error → only 4 successful → block)
test('TC-CEIL-3: error response does not count toward ceiling — still blocks when one call errored', () => {
  // 6 slots configured (>= maxSize) to test the failover-beyond-ceiling scenario
  // maxSize = 5, but one of the 5 calls returns an error → successCount = 4 → block
  const slots = [
    'slot-api-1', 'slot-api-2', 'slot-api-3',
    'slot-api-4', 'slot-api-5', 'slot-api-6',
  ];
  const agentConfig = {};
  for (const s of slots) {
    agentConfig[s] = { auth_type: 'api' };
  }
  const configPayload = JSON.stringify({
    quorum_commands: ['plan-phase'],
    quorum_active: slots,
    agent_config: agentConfig,
    quorum: { maxSize: 5, preferSub: false },
  });
  const homeDir = path.join(os.tmpdir(), `nf-home-ceil3-${Date.now()}`);
  const claudeDir = path.join(homeDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'nf.json'), configPayload, 'utf8');

  const claudeJsonTmp = path.join(os.tmpdir(), `nf-claude-ceil3-${Date.now()}.json`);
  const mcpServers = {};
  for (const s of slots) mcpServers[s] = {};
  fs.writeFileSync(claudeJsonTmp, JSON.stringify({ mcpServers }), 'utf8');

  // Transcript: all 5 first agents called, but slot-api-3's tool_result is an error
  // toolUseBlock(name) uses id: `toolu_${name}` pattern
  const firstFive = ['slot-api-1', 'slot-api-2', 'slot-api-3', 'slot-api-4', 'slot-api-5'];
  const transcriptLines = [
    userLine('/qnf:plan-phase 1', 'human-ceil3'),
    assistantLine([
      bashCommitBlock('node /path/nf-tools.cjs commit "docs: plan" --files 04-01-PLAN.md'),
    ], 'assistant-commit'),
  ];
  for (const slot of firstFive) {
    const toolName = `mcp__${slot}__review`;
    transcriptLines.push(
      assistantLine([toolUseBlock(toolName)], `assistant-${slot}`)
    );
    if (slot === 'slot-api-3') {
      // Slot 3 returns quota error — does NOT count toward ceiling
      transcriptLines.push(
        toolResultErrorLine(`toolu_${toolName}`, 'quota exceeded', `tr-${slot}`)
      );
    } else {
      transcriptLines.push(
        toolResultSuccessLine(`toolu_${toolName}`, `${slot} review OK`, `tr-${slot}`)
      );
    }
  }
  transcriptLines.push(
    assistantLine([{ type: 'text', text: 'Plan with one errored agent.' }], 'assistant-final')
  );

  const tmpFile = writeTempTranscript(transcriptLines);

  try {
    const { stdout, exitCode } = runHookWithEnv(
      {
        stop_hook_active: false,
        hook_event_name: 'Stop',
        transcript_path: tmpFile,
        last_assistant_message: 'Plan with one errored agent.',
      },
      { HOME: homeDir, NF_CLAUDE_JSON: claudeJsonTmp },
      homeDir // Isolate cwd from project .claude/nf.json
    );
    // Only 4 successful responses (slot-api-3 errored) — ceiling requires 5 → block
    assert.strictEqual(exitCode, 0, 'exit code must be 0 even when blocking');
    assert.ok(stdout.length > 0, 'stdout must contain block decision JSON');
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.decision, 'block', 'decision must be block — error response does not count');
    assert.ok(parsed.reason.startsWith('QUORUM REQUIRED:'), 'reason must start with QUORUM REQUIRED:');
  } finally {
    fs.unlinkSync(tmpFile);
    fs.unlinkSync(claudeJsonTmp);
  }
});

// ── TC-DEFAULT-CEIL: Ceiling = 2 (explicit quorum.maxSize=2) ────────
//
// TC-DEFAULT-CEIL-PASS: 3-slot pool, maxSize=2.
//   First 2 slots (sub-first) called successfully → ceiling satisfied → pass.
// TC-DEFAULT-CEIL-BLOCK: Same pool, only 1 successful call → block.

test('TC-DEFAULT-CEIL-PASS: default ceiling=2 passes with 2 successful calls', () => {
  const slots = ['slot-sub-1', 'slot-sub-2', 'slot-api-1'];
  const agentConfig = {};
  for (const s of slots) agentConfig[s] = { auth_type: s.startsWith('slot-sub') ? 'sub' : 'api' };
  const configPayload = JSON.stringify({
    quorum_commands: ['quick'],
    quorum_active: slots,
    agent_config: agentConfig,
    quorum: { maxSize: 2 },
  });
  const homeDir = path.join(os.tmpdir(), `nf-home-dceil-pass-${Date.now()}`);
  const claudeDir = path.join(homeDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'nf.json'), configPayload);

  const claudeJsonTmp = path.join(os.tmpdir(), `nf-claude-dceil-pass-${Date.now()}.json`);
  const mcpServers = {};
  for (const s of slots) mcpServers[s] = {};
  fs.writeFileSync(claudeJsonTmp, JSON.stringify({ mcpServers }));

  // 2 successful calls (sub-1 and sub-2, sorted sub-first by default preferSub=true)
  const transcriptLines = [
    userLine('/qnf:quick add something', 'human-dceil-pass'),
    assistantLine([bashCommitBlock('node /path/nf-tools.cjs commit "docs: plan" --files quick-115-PLAN.md')], 'assistant-commit'),
    assistantLine([toolUseBlock('mcp__slot-sub-1__review')], 'assistant-sub1'),
    toolResultSuccessLine('toolu_mcp__slot-sub-1__review', 'sub-1 OK'),
    assistantLine([toolUseBlock('mcp__slot-sub-2__review')], 'assistant-sub2'),
    toolResultSuccessLine('toolu_mcp__slot-sub-2__review', 'sub-2 OK'),
    assistantLine([{ type: 'text', text: 'Done.' }], 'assistant-final'),
  ];
  const tmpFile = writeTempTranscript(transcriptLines);
  try {
    const { stdout, exitCode } = runHookWithEnv(
      { stop_hook_active: false, hook_event_name: 'Stop', transcript_path: tmpFile, last_assistant_message: 'Done.' },
      { HOME: homeDir, NF_CLAUDE_JSON: claudeJsonTmp },
      homeDir // Isolate cwd from project .claude/nf.json
    );
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(stdout, '', 'default ceiling=2 satisfied by 2 calls — must not block');
  } finally {
    fs.unlinkSync(tmpFile);
    fs.unlinkSync(claudeJsonTmp);
  }
});

test('TC-DEFAULT-CEIL-BLOCK: default ceiling=2 blocks with only 1 successful call', () => {
  const slots = ['slot-sub-1', 'slot-sub-2', 'slot-api-1'];
  const agentConfig = {};
  for (const s of slots) agentConfig[s] = { auth_type: s.startsWith('slot-sub') ? 'sub' : 'api' };
  const configPayload = JSON.stringify({
    quorum_commands: ['quick'],
    quorum_active: slots,
    agent_config: agentConfig,
    quorum: { maxSize: 2 },
  });
  const homeDir = path.join(os.tmpdir(), `nf-home-dceil-block-${Date.now()}`);
  const claudeDir = path.join(homeDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'nf.json'), configPayload);

  const claudeJsonTmp = path.join(os.tmpdir(), `nf-claude-dceil-block-${Date.now()}.json`);
  const mcpServers = {};
  for (const s of slots) mcpServers[s] = {};
  fs.writeFileSync(claudeJsonTmp, JSON.stringify({ mcpServers }));

  // Only 1 successful call (sub-1) — needs 2 → block
  const transcriptLines = [
    userLine('/qnf:quick add something', 'human-dceil-block'),
    assistantLine([bashCommitBlock('node /path/nf-tools.cjs commit "docs: plan" --files quick-115-PLAN.md')], 'assistant-commit'),
    assistantLine([toolUseBlock('mcp__slot-sub-1__review')], 'assistant-sub1'),
    toolResultSuccessLine('toolu_mcp__slot-sub-1__review', 'sub-1 OK'),
    assistantLine([{ type: 'text', text: 'Done.' }], 'assistant-final'),
  ];
  const tmpFile = writeTempTranscript(transcriptLines);
  try {
    const { stdout, exitCode } = runHookWithEnv(
      { stop_hook_active: false, hook_event_name: 'Stop', transcript_path: tmpFile, last_assistant_message: 'Done.' },
      { HOME: homeDir, NF_CLAUDE_JSON: claudeJsonTmp },
      homeDir // Isolate cwd from project .claude/nf.json
    );
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.length > 0, 'must block — only 1 of 2 required calls made');
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.decision, 'block');
  } finally {
    fs.unlinkSync(tmpFile);
    fs.unlinkSync(claudeJsonTmp);
  }
});

// ── TC-SOLO-STOP: --n 1 triggers GUARD 6 solo bypass ─────────────────────────
//
// User prompt contains --n 1. Stop hook detects solo mode and exits 0
// even with zero external slot calls and a decision turn present.

test('TC-SOLO-STOP: --n 1 solo mode bypasses quorum enforcement (GUARD 6)', () => {
  const slots = ['slot-sub-1', 'slot-sub-2'];
  const agentConfig = {};
  for (const s of slots) agentConfig[s] = { auth_type: 'sub' };
  const configPayload = JSON.stringify({
    quorum_commands: ['quick'],
    quorum_active: slots,
    agent_config: agentConfig,
    quorum: { maxSize: 2 },
  });
  const homeDir = path.join(os.tmpdir(), `nf-home-solo-${Date.now()}`);
  const claudeDir = path.join(homeDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'nf.json'), configPayload);

  const claudeJsonTmp = path.join(os.tmpdir(), `nf-claude-solo-${Date.now()}.json`);
  const mcpServers = {};
  for (const s of slots) mcpServers[s] = {};
  fs.writeFileSync(claudeJsonTmp, JSON.stringify({ mcpServers }));

  // No external slot calls — but prompt has --n 1 → solo bypass
  const transcriptLines = [
    userLine('/qnf:quick add something --n 1', 'human-solo'),
    assistantLine([bashCommitBlock('node /path/nf-tools.cjs commit "docs: plan" --files quick-115-PLAN.md')], 'assistant-commit'),
    assistantLine([{ type: 'text', text: 'Done solo.' }], 'assistant-final'),
  ];
  const tmpFile = writeTempTranscript(transcriptLines);
  try {
    const { stdout, exitCode } = runHookWithEnv(
      { stop_hook_active: false, hook_event_name: 'Stop', transcript_path: tmpFile, last_assistant_message: 'Done solo.' },
      { HOME: homeDir, NF_CLAUDE_JSON: claudeJsonTmp },
      homeDir // Isolate cwd from project .claude/nf.json
    );
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(stdout, '', '--n 1 solo mode must not block even with zero external calls');
  } finally {
    fs.unlinkSync(tmpFile);
    fs.unlinkSync(claudeJsonTmp);
  }
});

// ── TC-N-OVERRIDE: --n N overrides config maxSize ────────────────────────────
//
// TC-N-OVERRIDE-PASS: config maxSize=5, --n 3 overrides to N-1=2 external required.
//   2 successful calls → ceiling satisfied at 2 → pass.
// TC-N-OVERRIDE-BLOCK: config maxSize=5, --n 3 overrides to 2 required.
//   1 successful call → block (1 < 2).

test('TC-N-OVERRIDE-PASS: --n 3 overrides maxSize=5 config, 2 calls satisfy N-1=2', () => {
  const slots = ['slot-sub-1', 'slot-sub-2', 'slot-api-1', 'slot-api-2', 'slot-api-3'];
  const agentConfig = {};
  for (const s of slots) agentConfig[s] = { auth_type: s.startsWith('slot-sub') ? 'sub' : 'api' };
  const configPayload = JSON.stringify({
    quorum_commands: ['quick'],
    quorum_active: slots,
    agent_config: agentConfig,
    quorum: { maxSize: 5 },
  });
  const homeDir = path.join(os.tmpdir(), `nf-home-nov-pass-${Date.now()}`);
  const claudeDir = path.join(homeDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'nf.json'), configPayload);

  const claudeJsonTmp = path.join(os.tmpdir(), `nf-claude-nov-pass-${Date.now()}.json`);
  const mcpServers = {};
  for (const s of slots) mcpServers[s] = {};
  fs.writeFileSync(claudeJsonTmp, JSON.stringify({ mcpServers }));

  // --n 3 → need N-1=2 external calls. Only 2 sub slots called (satisfies override).
  const transcriptLines = [
    userLine('/qnf:quick add something --n 3', 'human-nov-pass'),
    assistantLine([bashCommitBlock('node /path/nf-tools.cjs commit "docs: plan" --files quick-115-PLAN.md')], 'assistant-commit'),
    assistantLine([toolUseBlock('mcp__slot-sub-1__review')], 'assistant-sub1'),
    toolResultSuccessLine('toolu_mcp__slot-sub-1__review', 'sub-1 OK'),
    assistantLine([toolUseBlock('mcp__slot-sub-2__review')], 'assistant-sub2'),
    toolResultSuccessLine('toolu_mcp__slot-sub-2__review', 'sub-2 OK'),
    assistantLine([{ type: 'text', text: 'Done n3.' }], 'assistant-final'),
  ];
  const tmpFile = writeTempTranscript(transcriptLines);
  try {
    const { stdout, exitCode } = runHookWithEnv(
      { stop_hook_active: false, hook_event_name: 'Stop', transcript_path: tmpFile, last_assistant_message: 'Done n3.' },
      { HOME: homeDir, NF_CLAUDE_JSON: claudeJsonTmp },
      homeDir // Isolate cwd from project .claude/nf.json
    );
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(stdout, '', '--n 3 override: 2 calls satisfy N-1=2 ceiling — must not block');
  } finally {
    fs.unlinkSync(tmpFile);
    fs.unlinkSync(claudeJsonTmp);
  }
});

test('TC-N-OVERRIDE-BLOCK: --n 3 requires 2 calls; 1 call blocks despite config maxSize=5', () => {
  const slots = ['slot-sub-1', 'slot-sub-2', 'slot-api-1', 'slot-api-2', 'slot-api-3'];
  const agentConfig = {};
  for (const s of slots) agentConfig[s] = { auth_type: s.startsWith('slot-sub') ? 'sub' : 'api' };
  const configPayload = JSON.stringify({
    quorum_commands: ['quick'],
    quorum_active: slots,
    agent_config: agentConfig,
    quorum: { maxSize: 5 },
  });
  const homeDir = path.join(os.tmpdir(), `nf-home-nov-block-${Date.now()}`);
  const claudeDir = path.join(homeDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'nf.json'), configPayload);

  const claudeJsonTmp = path.join(os.tmpdir(), `nf-claude-nov-block-${Date.now()}.json`);
  const mcpServers = {};
  for (const s of slots) mcpServers[s] = {};
  fs.writeFileSync(claudeJsonTmp, JSON.stringify({ mcpServers }));

  // --n 3 → need N-1=2 external calls. Only 1 call made → block.
  const transcriptLines = [
    userLine('/qnf:quick add something --n 3', 'human-nov-block'),
    assistantLine([bashCommitBlock('node /path/nf-tools.cjs commit "docs: plan" --files quick-115-PLAN.md')], 'assistant-commit'),
    assistantLine([toolUseBlock('mcp__slot-sub-1__review')], 'assistant-sub1'),
    toolResultSuccessLine('toolu_mcp__slot-sub-1__review', 'sub-1 OK'),
    assistantLine([{ type: 'text', text: 'Done n3 one call.' }], 'assistant-final'),
  ];
  const tmpFile = writeTempTranscript(transcriptLines);
  try {
    const { stdout, exitCode } = runHookWithEnv(
      { stop_hook_active: false, hook_event_name: 'Stop', transcript_path: tmpFile, last_assistant_message: 'Done n3 one call.' },
      { HOME: homeDir, NF_CLAUDE_JSON: claudeJsonTmp },
      homeDir // Isolate cwd from project .claude/nf.json
    );
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.length > 0, 'must block — only 1 of 2 required calls made (--n 3 override)');
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.decision, 'block');
  } finally {
    fs.unlinkSync(tmpFile);
    fs.unlinkSync(claudeJsonTmp);
  }
});

// ── TC-PARSE-N: parseQuorumSizeFlag edge cases via integration ─────────────────
//
// These tests exercise parseQuorumSizeFlag indirectly through the hook's --n flag
// handling in the prompt text (GUARD 6 solo mode bypass, N-OVERRIDE path).

// TC-PARSE-N-EDGE: --n=5 (equals sign instead of space) is NOT recognized
// The parseQuorumSizeFlag regex is /\s+--n\s+(\d+)/ — requires whitespace before --n
// If a user types --n=5 (with equals), the flag is not detected and solo mode
// is NOT triggered. This tests that --n=5 does NOT trigger --n 1 solo bypass.
test('TC-PARSE-N-EDGE: --n=5 (equals sign) is NOT recognized as solo mode trigger', () => {
  const tmpFile = writeTempTranscript([
    userLine('/qnf:plan-phase 1 --n=5', 'human-eq'),
    assistantLine([bashCommitBlock('node /path/nf-tools.cjs commit "docs: plan" --files 04-01-PLAN.md')], 'assistant-commit'),
    assistantLine([{ type: 'text', text: 'Plan with equals syntax.' }], 'assistant-final'),
  ]);
  try {
    const { stdout, exitCode } = runHook({
      stop_hook_active: false,
      hook_event_name: 'Stop',
      transcript_path: tmpFile,
      last_assistant_message: 'Plan with equals syntax.',
    });
    // --n=5 is not recognized, so solo mode (--n 1) is NOT triggered
    // The prompt contains a quorum command + decision turn + no quorum calls
    // → should block (not pass silently)
    assert.strictEqual(exitCode, 0, 'exit code must be 0 even when blocking');
    assert.ok(stdout.length > 0, 'stdout must contain block decision — --n=5 not recognized as --n flag');
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.decision, 'block', 'decision must be block — --n=5 does not trigger solo bypass');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// TC-PARSE-N-ZERO: --n 0 should NOT trigger solo mode (n must be >= 1)
// GUARD 6 solo mode requires quorumSizeOverride === 1. --n 0 → n=0 → null (fails n>=1 check)
test('TC-PARSE-N-ZERO: --n 0 is invalid and does NOT trigger solo mode bypass', () => {
  const tmpFile = writeTempTranscript([
    userLine('/qnf:plan-phase 1 --n 0', 'human-zero'),
    assistantLine([bashCommitBlock('node /path/nf-tools.cjs commit "docs: plan" --files 04-01-PLAN.md')], 'assistant-commit'),
    assistantLine([{ type: 'text', text: 'Plan with --n 0.' }], 'assistant-final'),
  ]);
  try {
    const { stdout, exitCode } = runHook({
      stop_hook_active: false,
      hook_event_name: 'Stop',
      transcript_path: tmpFile,
      last_assistant_message: 'Plan with --n 0.',
    });
    // --n 0 → parseQuorumSizeFlag returns null (n=0 fails n>=1 check)
    // Solo mode not triggered, and no quorum calls made → should block
    assert.strictEqual(exitCode, 0, 'exit code must be 0 even when blocking');
    assert.ok(stdout.length > 0, 'stdout must contain block decision — --n 0 is invalid');
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.decision, 'block', 'decision must be block — --n 0 is not valid solo mode');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// ── Profile Guard Tests ─────────────────────────────────────────────────────

// TC-PROFILE-MINIMAL-EXIT: hook_profile=minimal → nf-stop exits 0 with no output (profile guard)
test('TC-PROFILE-MINIMAL-EXIT: hook_profile=minimal exits 0 with no output', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-stop-profile-'));
  try {
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ hook_profile: 'minimal' }),
      'utf8'
    );

    // Build a transcript that would normally trigger a block (planning command + no quorum)
    const transcriptLines = [
      userLine('/nf:plan-phase 03'),
      assistantLine([
        bashCommitBlock('node nf-tools.cjs commit -m "docs: plan" --files .planning/phases/03-PLAN.md'),
      ]),
    ];
    const tmpFile = writeTempTranscript(transcriptLines);

    try {
      const { stdout, exitCode } = runHookWithCwd(
        { stop_hook_active: false, hook_event_name: 'Stop', transcript_path: tmpFile },
        tempDir
      );
      assert.strictEqual(exitCode, 0, 'exit code must be 0');
      assert.strictEqual(stdout, '', 'stdout must be empty — minimal profile skips nf-stop entirely');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-PROFILE-STANDARD-RUNS: hook_profile=standard → nf-stop proceeds normally (not exited by guard)
test('TC-PROFILE-STANDARD-RUNS: hook_profile=standard does NOT exit early', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-stop-std-'));
  try {
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ hook_profile: 'standard' }),
      'utf8'
    );

    // A planning command with decision marker but no quorum → would block if not guarded
    const transcriptLines = [
      userLine('/nf:plan-phase 03'),
      assistantLine([
        bashCommitBlock('node nf-tools.cjs commit -m "docs: plan" --files .planning/phases/03-PLAN.md'),
        { type: 'text', text: '<!-- NF_DECISION -->' },
      ]),
    ];
    const tmpFile = writeTempTranscript(transcriptLines);

    try {
      const { stdout, exitCode } = runHookWithCwd(
        { stop_hook_active: false, hook_event_name: 'Stop', transcript_path: tmpFile },
        tempDir
      );
      assert.strictEqual(exitCode, 0, 'exit code must be 0');
      // Standard profile should proceed to quorum check and block (no quorum evidence)
      assert.ok(stdout.length > 0, 'stdout must contain block output — standard profile proceeds normally');
      const parsed = JSON.parse(stdout);
      assert.strictEqual(parsed.decision, 'block', 'must block — no quorum evidence');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-STRICT-NON-QUORUM-ENFORCED: hook_profile=strict → /nf:execute-phase (non-quorum command) IS enforced
test('TC-STRICT-NON-QUORUM-ENFORCED: strict mode enforces quorum on non-quorum command /nf:execute-phase', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-stop-strict-'));
  try {
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ hook_profile: 'strict' }),
      'utf8'
    );

    // /nf:execute-phase is NOT in the default quorum_commands list
    // In strict mode, it should still be matched and enforced
    const transcriptLines = [
      userLine('/nf:execute-phase 03'),
      assistantLine([
        bashCommitBlock('node nf-tools.cjs commit -m "docs: exec" --files .planning/phases/03-PLAN.md'),
        { type: 'text', text: '<!-- NF_DECISION -->' },
      ]),
    ];
    const tmpFile = writeTempTranscript(transcriptLines);

    try {
      const { stdout, exitCode } = runHookWithCwd(
        { stop_hook_active: false, hook_event_name: 'Stop', transcript_path: tmpFile },
        tempDir
      );
      assert.strictEqual(exitCode, 0, 'exit code must be 0');
      // Strict mode should match /nf:execute-phase and enforce quorum → block
      assert.ok(stdout.length > 0, 'stdout must contain block output — strict mode matches execute-phase');
      const parsed = JSON.parse(stdout);
      assert.strictEqual(parsed.decision, 'block', 'must block — strict mode enforces quorum on execute-phase');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-STANDARD-NON-QUORUM-NOT-ENFORCED: hook_profile=standard → /nf:execute-phase is NOT enforced
test('TC-STANDARD-NON-QUORUM-NOT-ENFORCED: standard mode does NOT enforce /nf:execute-phase', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-stop-stdnoq-'));
  try {
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ hook_profile: 'standard' }),
      'utf8'
    );

    // /nf:execute-phase is NOT in quorum_commands → standard mode should NOT match it
    const transcriptLines = [
      userLine('/nf:execute-phase 03'),
      assistantLine([
        bashCommitBlock('node nf-tools.cjs commit -m "docs: exec" --files .planning/phases/03-PLAN.md'),
        { type: 'text', text: '<!-- NF_DECISION -->' },
      ]),
    ];
    const tmpFile = writeTempTranscript(transcriptLines);

    try {
      const { stdout, exitCode } = runHookWithCwd(
        { stop_hook_active: false, hook_event_name: 'Stop', transcript_path: tmpFile },
        tempDir
      );
      assert.strictEqual(exitCode, 0, 'exit code must be 0');
      // Standard mode should NOT match /nf:execute-phase → silent pass (no output)
      assert.strictEqual(stdout, '', 'stdout must be empty — standard mode does not enforce execute-phase');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ── FALLBACK-01 Structured Checkpoint Tests (issue #172) ────────────────────
//
// The FALLBACK-01 gate now reads a schema-validated JSON file at
// .planning/quorum/checkpoints/round-<N>.json instead of regex-parsing an
// HTML comment in the transcript. These tests confirm:
//   - a valid structured checkpoint clears the gate,
//   - a missing / malformed / unsatisfying / stale checkpoint blocks,
//   - HTML-comment stylistic variation can neither bypass nor trigger the gate.

// A slot-worker Task dispatch block for a given slot + round.
function slotWorkerTask(id, slot, round) {
  return {
    type: 'tool_use',
    id,
    name: 'Task',
    input: {
      subagent_type: 'nf-quorum-slot-worker',
      model: 'haiku',
      description: `${slot} quorum R${round}`,
      prompt: `node "$HOME/.claude/nf-bin/quorum-slot-dispatch.cjs" --slot ${slot} --mode A --round ${round} --question "test"`,
    },
  };
}

// A Bash block that runs quorum-checkpoint.cjs for a given round.
function checkpointBash(id, round) {
  return {
    type: 'tool_use',
    id,
    name: 'Bash',
    input: {
      command: `node "$HOME/.claude/nf-bin/quorum-checkpoint.cjs" --round ${round} ` +
        `--unavail-primaries "codex-1" --fallback-dispatched true --t1-slots "opencode-1" ` +
        `--t2-slots "none" --all-tiers-exhausted false --proceed-reason "T1 fallback succeeded"`,
    },
  };
}

// Create a temp project dir with a standard-profile nf.json.
function setupFallbackDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nf-stop-fb-${label}-`));
  const claudeDir = path.join(dir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'nf.json'),
    JSON.stringify({ hook_profile: 'standard', quorum_commands: ['plan-phase'] }),
    'utf8'
  );
  return dir;
}

// Write a checkpoint file under a project dir.
function writeCheckpointFile(dir, round, obj) {
  const cpDir = path.join(dir, '.planning', 'quorum', 'checkpoints');
  fs.mkdirSync(cpDir, { recursive: true });
  fs.writeFileSync(
    path.join(cpDir, `round-${round}.json`),
    typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2),
    'utf8'
  );
}

function freshCheckpoint(overrides) {
  return Object.assign({
    round: 1,
    unavail_primaries: ['codex-1'],
    fallback_dispatched: true,
    t1_slots_tried: ['opencode-1'],
    t2_slots_tried: [],
    all_tiers_exhausted: false,
    proceed_reason: 'T1 fallback opencode-1 returned APPROVE',
    timestamp: '2026-02-20T00:05:00Z', // after userLine() turn-start timestamp
    schema_version: 1,
  }, overrides || {});
}

// Transcript: /nf:plan-phase, one slot-worker round with a UNAVAIL verdict,
// optionally a checkpoint Bash call, then a decision-marker final message.
function fallbackTranscript({ withCheckpointBash = true, extraTextBlock = null } = {}) {
  const lines = [
    userLine('/nf:plan-phase 1', 'human-fb'),
    assistantLine([
      slotWorkerTask('toolu_codex', 'codex-1', 1),
      slotWorkerTask('toolu_gemini', 'gemini-1', 1),
    ], 'a-dispatch'),
    toolResultSuccessLine('toolu_codex', 'verdict: UNAVAIL\nreasoning: slot unavailable', 'tr-codex'),
    toolResultSuccessLine('toolu_gemini', 'verdict: APPROVE\nreasoning: looks good', 'tr-gemini'),
  ];
  if (withCheckpointBash) {
    lines.push(
      assistantLine([checkpointBash('toolu_ckpt', 1)], 'a-ckpt'),
      toolResultSuccessLine('toolu_ckpt', 'FALLBACK-01 checkpoint written: round-1.json', 'tr-ckpt')
    );
  }
  const finalBlocks = [];
  if (extraTextBlock) finalBlocks.push({ type: 'text', text: extraTextBlock });
  finalBlocks.push({ type: 'text', text: 'Quorum complete.\n\n<!-- NF_DECISION -->' });
  lines.push(assistantLine(finalBlocks, 'a-final'));
  return lines;
}

// TC-FB-1: UNAVAIL + valid fresh structured checkpoint → PASS (no block)
test('TC-FB-1: valid structured checkpoint clears the FALLBACK-01 gate', () => {
  const dir = setupFallbackDir('ok');
  try {
    writeCheckpointFile(dir, 1, freshCheckpoint());
    const tmpFile = writeTempTranscript(fallbackTranscript());
    try {
      const { stdout, exitCode } = runHookWithCwd(
        { stop_hook_active: false, hook_event_name: 'Stop', transcript_path: tmpFile },
        dir
      );
      assert.strictEqual(exitCode, 0, 'exit code must be 0');
      assert.strictEqual(stdout, '', 'no block — valid checkpoint clears the gate');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// TC-FB-2: UNAVAIL + no checkpoint at all → BLOCK
test('TC-FB-2: UNAVAIL with no structured checkpoint blocks', () => {
  const dir = setupFallbackDir('none');
  try {
    const tmpFile = writeTempTranscript(fallbackTranscript({ withCheckpointBash: false }));
    try {
      const { stdout, exitCode } = runHookWithCwd(
        { stop_hook_active: false, hook_event_name: 'Stop', transcript_path: tmpFile },
        dir
      );
      assert.strictEqual(exitCode, 0);
      const parsed = JSON.parse(stdout);
      assert.strictEqual(parsed.decision, 'block');
      assert.ok(/FALLBACK-01 VIOLATION/.test(parsed.reason), parsed.reason);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// TC-FB-3: UNAVAIL + checkpoint Bash ran but file is malformed JSON → BLOCK
test('TC-FB-3: malformed checkpoint file blocks (schema validation)', () => {
  const dir = setupFallbackDir('malformed');
  try {
    writeCheckpointFile(dir, 1, '{ not valid json');
    const tmpFile = writeTempTranscript(fallbackTranscript());
    try {
      const { stdout, exitCode } = runHookWithCwd(
        { stop_hook_active: false, hook_event_name: 'Stop', transcript_path: tmpFile },
        dir
      );
      assert.strictEqual(exitCode, 0);
      assert.strictEqual(JSON.parse(stdout).decision, 'block');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// TC-FB-4: checkpoint valid but fallback_dispatched=false & all_tiers_exhausted=false → BLOCK
test('TC-FB-4: unsatisfying checkpoint (no fallback, not exhausted) blocks', () => {
  const dir = setupFallbackDir('unsat');
  try {
    writeCheckpointFile(dir, 1, freshCheckpoint({ fallback_dispatched: false, all_tiers_exhausted: false }));
    const tmpFile = writeTempTranscript(fallbackTranscript());
    try {
      const { stdout, exitCode } = runHookWithCwd(
        { stop_hook_active: false, hook_event_name: 'Stop', transcript_path: tmpFile },
        dir
      );
      assert.strictEqual(exitCode, 0);
      assert.strictEqual(JSON.parse(stdout).decision, 'block');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// TC-FB-5: all_tiers_exhausted=true (fallback_dispatched=false) clears the gate
test('TC-FB-5: all_tiers_exhausted checkpoint clears the gate', () => {
  const dir = setupFallbackDir('exhausted');
  try {
    writeCheckpointFile(dir, 1, freshCheckpoint({ fallback_dispatched: false, all_tiers_exhausted: true }));
    const tmpFile = writeTempTranscript(fallbackTranscript());
    try {
      const { stdout, exitCode } = runHookWithCwd(
        { stop_hook_active: false, hook_event_name: 'Stop', transcript_path: tmpFile },
        dir
      );
      assert.strictEqual(exitCode, 0);
      assert.strictEqual(stdout, '', 'all_tiers_exhausted=true clears the gate');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// TC-FB-6: a stale checkpoint (timestamp before the turn started) → BLOCK
test('TC-FB-6: stale checkpoint from a previous turn does not clear the gate', () => {
  const dir = setupFallbackDir('stale');
  try {
    writeCheckpointFile(dir, 1, freshCheckpoint({ timestamp: '2026-01-01T00:00:00Z' }));
    const tmpFile = writeTempTranscript(fallbackTranscript());
    try {
      const { stdout, exitCode } = runHookWithCwd(
        { stop_hook_active: false, hook_event_name: 'Stop', transcript_path: tmpFile },
        dir
      );
      assert.strictEqual(exitCode, 0);
      assert.strictEqual(JSON.parse(stdout).decision, 'block');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// TC-FB-7: HTML-comment stylistic variation cannot BYPASS the gate.
// A perfectly-formed FALLBACK_CHECKPOINT comment in a text block, with no
// structured file, must still BLOCK — the comment is no longer the gate.
test('TC-FB-7: HTML comment in transcript cannot bypass the gate (no file)', () => {
  const dir = setupFallbackDir('bypass');
  try {
    const htmlComment = [
      '<!-- FALLBACK_CHECKPOINT',
      '  unavail_primaries: [codex-1]',
      '  fallback_dispatched: true',
      '  t1_slots_tried: [opencode-1]',
      '  all_tiers_exhausted: false',
      '  proceed_reason: handled',
      '-->',
    ].join('\n');
    // checkpoint Bash present (so the comment looks legitimate) but NO file on disk
    const tmpFile = writeTempTranscript(fallbackTranscript({ extraTextBlock: htmlComment }));
    try {
      const { stdout, exitCode } = runHookWithCwd(
        { stop_hook_active: false, hook_event_name: 'Stop', transcript_path: tmpFile },
        dir
      );
      assert.strictEqual(exitCode, 0);
      assert.strictEqual(JSON.parse(stdout).decision, 'block',
        'a transcript HTML comment must not satisfy the gate without the structured file');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// TC-FB-8: HTML-comment stylistic variation cannot TRIGGER a false block.
// Fallback was handled correctly (valid structured file); the transcript also
// carries a code-fenced, oddly-spaced HTML comment that the old regex would
// have failed to parse. The gate must still PASS.
test('TC-FB-8: mangled HTML comment cannot trigger a false block when file is valid', () => {
  const dir = setupFallbackDir('falsepos');
  try {
    writeCheckpointFile(dir, 1, freshCheckpoint());
    const mangled = [
      '```',
      '<!--   FALLBACK_CHECKPOINT',
      '  fallback_dispatched : [ true ]',
      '  all_tiers_exhausted=false',
      '-->',
      '```',
    ].join('\n');
    const tmpFile = writeTempTranscript(fallbackTranscript({ extraTextBlock: mangled }));
    try {
      const { stdout, exitCode } = runHookWithCwd(
        { stop_hook_active: false, hook_event_name: 'Stop', transcript_path: tmpFile },
        dir
      );
      assert.strictEqual(exitCode, 0);
      assert.strictEqual(stdout, '',
        'mangled HTML comment must not over-block when the structured file is valid');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// TC-FB-9: UNAVAIL cleared by a later fallback dispatch round → PASS (no checkpoint needed)
test('TC-FB-9: UNAVAIL cleared by a subsequent fallback dispatch round passes', () => {
  const dir = setupFallbackDir('nextround');
  try {
    const lines = [
      userLine('/nf:plan-phase 1', 'human-fb'),
      assistantLine([slotWorkerTask('toolu_codex', 'codex-1', 1)], 'a-r1'),
      toolResultSuccessLine('toolu_codex', 'verdict: UNAVAIL', 'tr-codex'),
      // a later dispatch round (round 2) with a successful verdict, no UNAVAIL
      assistantLine([slotWorkerTask('toolu_oc', 'opencode-1', 2)], 'a-r2'),
      toolResultSuccessLine('toolu_oc', 'verdict: APPROVE\nreasoning: ok', 'tr-oc'),
      assistantLine([{ type: 'text', text: 'Quorum complete.\n\n<!-- NF_DECISION -->' }], 'a-final'),
    ];
    const tmpFile = writeTempTranscript(lines);
    try {
      const { stdout, exitCode } = runHookWithCwd(
        { stop_hook_active: false, hook_event_name: 'Stop', transcript_path: tmpFile },
        dir
      );
      assert.strictEqual(exitCode, 0);
      assert.strictEqual(stdout, '', 'fallback dispatched as a later round clears the gate');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// TC-FB-10: when the dispatch round number cannot be parsed from the slot-worker
// Task, the gate fails CLOSED — a checkpoint written for some other round must
// not clear an UNAVAIL whose round is unknown.
test('TC-FB-10: unparseable dispatch round fails closed even with a checkpoint present', () => {
  const dir = setupFallbackDir('noround');
  try {
    writeCheckpointFile(dir, 1, freshCheckpoint()); // a valid checkpoint for round 1
    // slot-worker Task whose prompt carries NO --round flag → protocolRound = null
    const noRoundTask = {
      type: 'tool_use',
      id: 'toolu_codex',
      name: 'Task',
      input: {
        subagent_type: 'nf-quorum-slot-worker',
        model: 'haiku',
        description: 'codex-1 quorum',
        prompt: 'node "$HOME/.claude/nf-bin/quorum-slot-dispatch.cjs" --slot codex-1 --mode A --question "test"',
      },
    };
    const lines = [
      userLine('/nf:plan-phase 1', 'human-fb'),
      assistantLine([noRoundTask], 'a-dispatch'),
      toolResultSuccessLine('toolu_codex', 'verdict: UNAVAIL', 'tr-codex'),
      assistantLine([checkpointBash('toolu_ckpt', 1)], 'a-ckpt'),
      toolResultSuccessLine('toolu_ckpt', 'FALLBACK-01 checkpoint written', 'tr-ckpt'),
      assistantLine([{ type: 'text', text: 'Quorum complete.\n\n<!-- NF_DECISION -->' }], 'a-final'),
    ];
    const tmpFile = writeTempTranscript(lines);
    try {
      const { stdout, exitCode } = runHookWithCwd(
        { stop_hook_active: false, hook_event_name: 'Stop', transcript_path: tmpFile },
        dir
      );
      assert.strictEqual(exitCode, 0);
      const parsed = JSON.parse(stdout);
      assert.strictEqual(parsed.decision, 'block',
        'unknown dispatch round must fail closed, not borrow another round\'s checkpoint');
      assert.ok(/could not be determined/.test(parsed.reason), parsed.reason);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// TC-FB-11: a checkpoint Bash call that FAILED (error tool_result) does not
// count as a written checkpoint — the round is not freshness-anchored → BLOCK.
test('TC-FB-11: failed checkpoint Bash call does not clear the gate', () => {
  const dir = setupFallbackDir('ckptfail');
  try {
    writeCheckpointFile(dir, 1, freshCheckpoint()); // a valid file may exist on disk
    const lines = [
      userLine('/nf:plan-phase 1', 'human-fb'),
      assistantLine([slotWorkerTask('toolu_codex', 'codex-1', 1)], 'a-dispatch'),
      toolResultSuccessLine('toolu_codex', 'verdict: UNAVAIL', 'tr-codex'),
      assistantLine([checkpointBash('toolu_ckpt', 1)], 'a-ckpt'),
      toolResultErrorLine('toolu_ckpt', 'checkpoint script exited 1', 'tr-ckpt'),
      assistantLine([{ type: 'text', text: 'Quorum complete.\n\n<!-- NF_DECISION -->' }], 'a-final'),
    ];
    const tmpFile = writeTempTranscript(lines);
    try {
      const { stdout, exitCode } = runHookWithCwd(
        { stop_hook_active: false, hook_event_name: 'Stop', transcript_path: tmpFile },
        dir
      );
      assert.strictEqual(exitCode, 0);
      assert.strictEqual(JSON.parse(stdout).decision, 'block',
        'a failed checkpoint write must not freshness-anchor the round');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

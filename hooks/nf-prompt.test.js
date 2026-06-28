#!/usr/bin/env node
// Test suite for hooks/nf-prompt.js
// Uses Node.js built-in test runner: node --test hooks/nf-prompt.test.js
//
// Each test spawns the hook as a child process with mock stdin.
// The hook reads JSON from stdin and writes JSON to stdout.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK_PATH = path.join(__dirname, 'nf-prompt.js');

// Helper: run the hook with a given stdin payload, return { stdout, stderr, exitCode }
// When the payload contains a `cwd` field, HOME is overridden to the cwd so that
// the hook's loadConfig reads only the project-level nf.json (no global config leak).
// NF_SKIP_PREFLIGHT=1 is set by default to bypass quorum-preflight.cjs CLI probes and
// keep tests fast. Pass { NF_SKIP_PREFLIGHT: '0' } in extraEnv to test the preflight path.
function runHook(stdinPayload, extraEnv) {
  const payload = typeof stdinPayload === 'string' ? stdinPayload : JSON.stringify(stdinPayload);
  const cwdFromPayload = typeof stdinPayload === 'object' && stdinPayload.cwd;
  const env = { ...process.env, NF_SKIP_PREFLIGHT: '1', ...(extraEnv || {}) };
  if (cwdFromPayload) {
    env.HOME = cwdFromPayload; // isolate from ~/.claude/nf.json
  }
  const result = spawnSync('node', [HOOK_PATH], {
    input: payload,
    encoding: 'utf8',
    // Generous timeout so a cold hook subprocess under heavy parallel test:ci
    // load (measured ~9s for the git-walking hooks) isn't killed at 5s, which
    // yields status=null and a spurious assertion failure. Healthy run ~1s.
    timeout: 30000,
    env,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
  };
}

// TC1: non-planning command exits 0 with no stdout output
// /qnf:execute-phase is NOT in default quorum_commands → silent pass
test('TC1: non-planning command (/qnf:execute-phase) exits 0 with no stdout', () => {
  const { stdout, exitCode } = runHook({
    prompt: '/qnf:execute-phase',
    cwd: process.cwd(),
  });
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  assert.strictEqual(stdout, '', 'stdout must be empty for non-planning command');
});

// TC2: planning command triggers quorum injection
// /qnf:plan-phase is in quorum_commands → should inject additionalContext with "QUORUM REQUIRED"
test('TC2: planning command (/qnf:plan-phase) triggers quorum injection', () => {
  const { stdout, exitCode } = runHook({
    prompt: '/qnf:plan-phase 03-auth',
    cwd: process.cwd(),
  });
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  assert.ok(stdout.length > 0, 'stdout must contain quorum injection JSON');
  const parsed = JSON.parse(stdout);
  assert.ok(parsed.hookSpecificOutput, 'output must have hookSpecificOutput');
  assert.ok(
    parsed.hookSpecificOutput.additionalContext.includes('QUORUM REQUIRED'),
    'additionalContext must include "QUORUM REQUIRED"'
  );
});

// TC3: /nf:plan-phase (NF prefix) also triggers injection
// The hook accepts both /nf: and /qnf: prefixes via the ^\\s*\\/q?nf: pattern
test('TC3: /nf:plan-phase (NF prefix) also triggers quorum injection', () => {
  const { stdout, exitCode } = runHook({
    prompt: '/nf:plan-phase 03-auth',
    cwd: process.cwd(),
  });
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  assert.ok(stdout.length > 0, 'stdout must contain quorum injection JSON');
  const parsed = JSON.parse(stdout);
  assert.ok(
    parsed.hookSpecificOutput.additionalContext.includes('QUORUM REQUIRED'),
    'additionalContext must include "QUORUM REQUIRED"'
  );
});

// TC4: /qnf:research-phase triggers injection
test('TC4: /qnf:research-phase triggers quorum injection', () => {
  const { stdout, exitCode } = runHook({
    prompt: '/qnf:research-phase',
    cwd: process.cwd(),
  });
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  assert.ok(stdout.length > 0, 'stdout must contain quorum injection JSON');
  const parsed = JSON.parse(stdout);
  assert.ok(
    parsed.hookSpecificOutput.additionalContext.includes('QUORUM REQUIRED'),
    'additionalContext must include "QUORUM REQUIRED"'
  );
});

// TC5: /qnf:verify-work triggers injection
test('TC5: /qnf:verify-work triggers quorum injection', () => {
  const { stdout, exitCode } = runHook({
    prompt: '/qnf:verify-work',
    cwd: process.cwd(),
  });
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  assert.ok(stdout.length > 0, 'stdout must contain quorum injection JSON');
  const parsed = JSON.parse(stdout);
  assert.ok(
    parsed.hookSpecificOutput.additionalContext.includes('QUORUM REQUIRED'),
    'additionalContext must include "QUORUM REQUIRED"'
  );
});

// TC6: /qnf:discuss-phase triggers injection
test('TC6: /qnf:discuss-phase triggers quorum injection', () => {
  const { stdout, exitCode } = runHook({
    prompt: '/qnf:discuss-phase',
    cwd: process.cwd(),
  });
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  assert.ok(stdout.length > 0, 'stdout must contain quorum injection JSON');
  const parsed = JSON.parse(stdout);
  assert.ok(
    parsed.hookSpecificOutput.additionalContext.includes('QUORUM REQUIRED'),
    'additionalContext must include "QUORUM REQUIRED"'
  );
});

// TC7: malformed JSON stdin exits 0 with no output (fail-open)
test('TC7: malformed JSON stdin exits 0 with no output (fail-open)', () => {
  const { stdout, exitCode } = runHook('not json');
  assert.strictEqual(exitCode, 0, 'exit code must be 0 — fail-open on malformed input');
  assert.strictEqual(stdout, '', 'stdout must be empty — fail-open produces no output');
});

// TC8: prefix boundary — /qnf:plan-phase-extra does NOT trigger (trailing non-space after command)
// The regex uses (\s|$) word boundary, so "plan-phase-extra" must not match "plan-phase"
test('TC8: /qnf:plan-phase-extra does NOT trigger injection (word boundary enforced)', () => {
  const { stdout, exitCode } = runHook({
    prompt: '/qnf:plan-phase-extra something',
    cwd: process.cwd(),
  });
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  assert.strictEqual(stdout, '', 'stdout must be empty — word boundary prevents false match');
});

// TC9: circuit breaker active in temp dir → injects resolution context
// Creates a temp git repo with .claude/circuit-breaker-state.json { active: true }
test('TC9: circuit breaker active → injects CIRCUIT BREAKER ACTIVE context', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-tc9-'));
  try {
    // Init git repo so isBreakerActive can find the git root
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });

    // Write circuit breaker state file
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'circuit-breaker-state.json'),
      JSON.stringify({ active: true }),
      'utf8'
    );

    const { stdout, exitCode } = runHook({
      prompt: '/qnf:execute-phase',
      cwd: tempDir,
    });

    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.length > 0, 'stdout must contain circuit breaker injection JSON');
    const parsed = JSON.parse(stdout);
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes('CIRCUIT BREAKER ACTIVE'),
      'additionalContext must include "CIRCUIT BREAKER ACTIVE"'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC11: activeSlots path — instructions use Task dispatch syntax, not direct MCP calls
// When quorum_active is configured, the step list must contain nf-quorum-slot-worker Tasks
// and must NOT contain mcp__*__* tool names (the escape hatch must be absent).
test('TC11: activeSlots path uses Task dispatch syntax (not direct MCP calls)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-tc11-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ quorum_active: ['codex-1', 'gemini-1'] }),
      'utf8'
    );
    const { stdout } = runHook({ prompt: '/qnf:plan-phase', cwd: tempDir });
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.ok(
      ctx.includes('nf-quorum-slot-worker'),
      'instructions must contain nf-quorum-slot-worker Task dispatch syntax'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC12: activeSlots path — no mcp__*__* tool names in injected instructions
// The escape hatch "fall back to direct MCP calls" must be absent entirely.
test('TC12: activeSlots path has no mcp__*__* tool names in instructions', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-tc12-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ quorum_active: ['codex-1', 'gemini-1'] }),
      'utf8'
    );
    const { stdout } = runHook({ prompt: '/qnf:plan-phase', cwd: tempDir });
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    // The escape hatch was "fall back to direct MCP calls" + a step list of "Call mcp__X__Y".
    // The NEVER directive legitimately contains "mcp__*__*" as a warning, so we test for
    // the actual escape hatch phrases, not a generic mcp__ regex.
    assert.ok(
      !ctx.includes('fall back to direct MCP calls'),
      'instructions must NOT contain the fallback escape hatch phrase'
    );
    assert.ok(
      !(/\bCall mcp__[a-z]/.test(ctx)),
      'instructions must NOT contain "Call mcp__<slot>" step lines'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC13: activeSlots path — model_preferences override block is suppressed
// Even when model_preferences is configured, mcp__*__* names must not appear
// (the !activeSlots guard must prevent the AGENT_TOOL_MAP block from running).
test('TC13: activeSlots path suppresses model_preferences override (no mcp__ leak)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-tc13-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({
        quorum_active: ['codex-1', 'gemini-1'],
        model_preferences: { 'codex-1': 'gpt-5-turbo' },
      }),
      'utf8'
    );
    const { stdout } = runHook({ prompt: '/qnf:plan-phase', cwd: tempDir });
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    // The AGENT_TOOL_MAP block generates "When calling mcp__<slot>__<tool>, include model=..."
    // This must not appear when activeSlots is configured.
    assert.ok(
      !(/When calling mcp__[a-z]/.test(ctx)),
      'model_preferences override block must not inject "When calling mcp__<slot>" when activeSlots is configured'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC10: circuit breaker disabled flag → does NOT inject resolution context
// Same temp dir setup but state = { active: true, disabled: true }
test('TC10: circuit breaker disabled flag → no injection (silent pass)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-tc10-'));
  try {
    // Init git repo
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });

    // Write circuit breaker state with disabled: true
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'circuit-breaker-state.json'),
      JSON.stringify({ active: true, disabled: true }),
      'utf8'
    );

    const { stdout, exitCode } = runHook({
      prompt: '/qnf:execute-phase',
      cwd: tempDir,
    });

    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty — disabled breaker produces no injection');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-PROMPT-N-CAP: --n 3 caps injected slot list to N-1=2 external slots
test('TC-PROMPT-N-CAP: --n 3 caps injected slot list to N-1=2 external slots', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-nc-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ quorum_active: ['codex-1', 'gemini-1', 'opencode-1', 'copilot-1', 'claude-1'] }),
      'utf8'
    );
    const { stdout } = runHook({ prompt: '/qnf:plan-phase --n 3', cwd: tempDir });
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    // Must announce the override
    assert.ok(ctx.includes('--n 3') && ctx.includes('QUORUM REQUIRED'), 'must announce --n 3 override in QUORUM REQUIRED header');
    // Must cap to 2 numbered step Task lines (N-1 = 2). Regex matches numbered steps, not header prose.
    const taskLineCount = (ctx.match(/\d+\. Task\(subagent_type="nf-quorum-slot-worker"/g) || []).length;
    assert.strictEqual(taskLineCount, 2, '--n 3 must produce exactly 2 slot-worker Task lines (N-1=2)');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-PROMPT-SOLO: --n 1 injects SOLO MODE ACTIVE, no Task slot lines
test('TC-PROMPT-SOLO: --n 1 injects SOLO MODE ACTIVE, no Task slot lines', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-solo-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ quorum_active: ['codex-1', 'gemini-1'] }),
      'utf8'
    );
    const { stdout } = runHook({ prompt: '/qnf:plan-phase --n 1', cwd: tempDir });
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('SOLO MODE ACTIVE (--n 1)'), 'must inject SOLO MODE ACTIVE marker');
    assert.ok(ctx.includes('<!-- NF_SOLO_MODE -->'), 'must include NF_SOLO_MODE XML comment');
    const taskLineCount = (ctx.match(/\d+\. Task\(subagent_type="nf-quorum-slot-worker"/g) || []).length;
    assert.strictEqual(taskLineCount, 0, '--n 1 solo mode must produce zero slot-worker Task lines');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-PROMPT-PREFER-SUB-DEFAULT: no preferSub config → defaults true, sub slots appear before api slots
test('TC-PROMPT-PREFER-SUB-DEFAULT: preferSub=true reorders sub slots before api slots', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-psub-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    // sub-1 listed AFTER api-1 in quorum_active — preferSub must reorder
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({
        quorum_active: ['api-slot-1', 'sub-slot-1'],
        agent_config: {
          'api-slot-1': { auth_type: 'api' },
          'sub-slot-1': { auth_type: 'sub' },
        },
        quorum: { preferSub: true },
      }),
      'utf8'
    );
    const { stdout } = runHook({ prompt: '/qnf:plan-phase', cwd: tempDir });
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    const subPos = ctx.indexOf('sub-slot-1');
    const apiPos = ctx.indexOf('api-slot-1');
    assert.ok(subPos !== -1, 'sub-slot-1 must appear in step list');
    assert.ok(apiPos !== -1, 'api-slot-1 must appear in step list');
    assert.ok(subPos < apiPos, 'sub slot must appear before api slot (preferSub=true)');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-PROMPT-FAILOVER-RULE: injected context must instruct Claude to skip UNAVAIL slots.
// This is the runtime bridge that determines polledCount in NFQuorum.tla: Claude
// follows these injected instructions to skip unresponsive slot-workers, reducing
// polledCount from MaxSize to however many slots actually responded.
test('TC-PROMPT-FAILOVER-RULE: injected context includes skip-if-UNAVAIL failover rule', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-fr-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ quorum_active: ['gemini-1', 'opencode-1', 'copilot-1'] }),
      'utf8'
    );
    const { stdout } = runHook({ prompt: '/qnf:plan-phase', cwd: tempDir });
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    // Two variants: simple "Failover rule: ...skip..." or structured "SLOT DISPATCH SEQUENCE (FALLBACK-01)..."
    // Both must reference UNAVAIL and contain "skip" (skip individual unavail slots or skip to next step).
    assert.ok(
      ctx.includes('Failover rule') || ctx.includes('SLOT DISPATCH SEQUENCE'),
      'injected context must contain a failover rule (simple or FALLBACK-01 structured)'
    );
    assert.ok(ctx.includes('UNAVAIL'), 'failover rule must reference UNAVAIL state');
    // Both variants instruct to "skip" unavail slots (simple: "skip it"; structured: "skip UNAVAIL").
    assert.ok(ctx.includes('skip'), 'failover rule must instruct to skip unresponsive slots');
    // Verify the rule explicitly says errors do not count toward the required total,
    // confirming that a failed slot does not reduce the consensus threshold.
    assert.ok(
      ctx.includes('do not count toward'),
      'failover rule must state that errors do not count toward required total'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-PROMPT-FALLBACK-T1-PRIORITY: when sub-CLI slots exceed the fan-out cap, the injected
// instructions must name the unused sub-CLI slots (T1) in the Failover rule before any
// ccr/api slots (T2). This regression test prevents the bug where both primary slots
// (codex-1, gemini-1) were UNAVAIL and the fallback jumped directly to claude-1/claude-2
// instead of trying opencode-1 and copilot-1 first.
test('TC-PROMPT-FALLBACK-T1-PRIORITY: unused sub-CLI slots listed as T1 before ccr in Failover rule', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-t1-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    // 4 sub slots, maxSize=3 → externalSlotCap=2 → 2 are dispatched, 2 are T1 unused
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({
        quorum_active: ['codex-1', 'gemini-1', 'opencode-1', 'copilot-1'],
        quorum: { maxSize: 3 },
        agent_config: {
          'codex-1':    { auth_type: 'sub' },
          'gemini-1':   { auth_type: 'sub' },
          'opencode-1': { auth_type: 'sub' },
          'copilot-1':  { auth_type: 'sub' },
        },
      }),
      'utf8'
    );
    const { stdout } = runHook({ prompt: '/qnf:plan-phase', cwd: tempDir });
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;

    // Must use the FALLBACK-01 tiered rule, not the simple skip rule
    assert.ok(ctx.includes('FALLBACK-01'), 'Must use tiered FALLBACK-01 rule when T1 slots are unused');

    // T1 unused slots (opencode-1, copilot-1) must be named explicitly in the failover rule
    assert.ok(ctx.includes('opencode-1'), 'T1 unused slot opencode-1 must appear in failover rule');
    assert.ok(ctx.includes('copilot-1'), 'T1 unused slot copilot-1 must appear in failover rule');

    // The dispatched steps (1., 2.) must only contain the first 2 capped sub slots
    const dispatchedSlots = [...ctx.matchAll(/\d+\. Task\(subagent_type="nf-quorum-slot-worker", prompt="slot: (\S+)\\n/g)]
      .map(m => m[1]);
    assert.equal(dispatchedSlots.length, 2, 'Exactly 2 slots should be in the dispatch list (externalSlotCap=2)');
    assert.ok(!dispatchedSlots.includes('opencode-1'), 'opencode-1 should NOT be in initial dispatch (it is T1 unused)');
    assert.ok(!dispatchedSlots.includes('copilot-1'), 'copilot-1 should NOT be in initial dispatch (it is T1 unused)');

    // T1 step must appear BEFORE T2 step in the structured dispatch sequence
    const t1Pos = ctx.indexOf('Step 2 T1');
    const t2Pos = ctx.indexOf('Step 3 T2');
    assert.ok(t1Pos !== -1, 'Step 2 T1 label must appear in the structured sequence');
    assert.ok(t2Pos !== -1, 'Step 3 T2 label must appear in the structured sequence');
    assert.ok(t1Pos < t2Pos, 'T1 tier (Step 2) must appear before T2 tier (Step 3)');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-PROMPT-FALLBACK-ROUTINE: FAN_OUT_COUNT=2 (routine risk, 1 external slot) leaves 3 sub
// slots unused as T1. The structured sequence must name all 3 in Step 2.
test('TC-PROMPT-FALLBACK-ROUTINE: routine risk_level → FAN_OUT_COUNT=2, 3 T1 slots in sequence', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-routine-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({
        quorum_active: ['codex-1', 'gemini-1', 'opencode-1', 'copilot-1'],
        quorum: { maxSize: 5 },
        agent_config: {
          'codex-1':    { auth_type: 'sub' },
          'gemini-1':   { auth_type: 'sub' },
          'opencode-1': { auth_type: 'sub' },
          'copilot-1':  { auth_type: 'sub' },
        },
      }),
      'utf8'
    );
    // Simulate routine risk_level via context_yaml in the hook payload
    const payload = {
      prompt: '/qnf:plan-phase',
      cwd: tempDir,
      context_yaml: 'risk_level: routine\n',
    };
    const { stdout } = runHook(payload);
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;

    // FAN_OUT_COUNT=2 → externalSlotCap=1 → 1 primary, 3 T1 unused
    assert.ok(ctx.includes('FALLBACK-01'), 'Must use FALLBACK-01 when T1 slots exist');
    const dispatchedSlots = [...ctx.matchAll(/\d+\. Task\(subagent_type="nf-quorum-slot-worker", prompt="slot: (\S+)\\n/g)]
      .map(m => m[1]);
    assert.equal(dispatchedSlots.length, 1, 'Only 1 external slot dispatched for routine risk');

    // The 3 unused sub slots must appear in Step 2 T1 line
    assert.ok(ctx.includes('Step 2 T1 sub-CLI'), 'Step 2 T1 label must appear in sequence');
    const t1LineMatch = ctx.match(/Step 2 T1 sub-CLI:\s+\[([^\]]+)\]/);
    assert.ok(t1LineMatch, 'Step 2 T1 must list slots in brackets');
    const t1Slots = t1LineMatch[1].split(',').map(s => s.trim());
    assert.equal(t1Slots.length, 3, 'Step 2 T1 must have 3 unused slots');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-PROMPT-FALLBACK-NO-T1: all sub slots fit within the cap → no T1 unused → simple rule.
test('TC-PROMPT-FALLBACK-NO-T1: all sub slots dispatched → no FALLBACK-01, simple rule', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-not1-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    // 2 sub slots, maxSize=5 → externalSlotCap=4 → both sub slots fit, no T1 unused
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({
        quorum_active: ['gemini-1', 'opencode-1'],
        quorum: { maxSize: 5 },
        agent_config: {
          'gemini-1':   { auth_type: 'sub' },
          'opencode-1': { auth_type: 'sub' },
        },
      }),
      'utf8'
    );
    const { stdout } = runHook({ prompt: '/qnf:plan-phase', cwd: tempDir });
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;

    // No T1 unused → should NOT emit FALLBACK-01 or Step 2 T1
    assert.ok(!ctx.includes('FALLBACK-01'), 'Must NOT use FALLBACK-01 when all sub slots are dispatched');
    assert.ok(!ctx.includes('Step 2 T1'), 'Must NOT emit Step 2 T1 when no T1 slots exist');
    // Should use the simple failover rule
    assert.ok(ctx.includes('Failover rule'), 'Simple Failover rule must appear');
    assert.ok(ctx.includes('do not count toward'), 'Must still state errors don\'t count');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-PROMPT-FALLBACK-T1-EXCLUDES-PRIMARIES: T1 list must not include slots already dispatched.
// Regression: if opencode-1 is in the primary dispatch, it must not also appear in Step 2 T1.
test('TC-PROMPT-FALLBACK-T1-EXCLUDES-PRIMARIES: T1 list excludes slots already in primary dispatch', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-excl-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    // 4 sub slots, maxSize=4 → externalSlotCap=3 → 3 dispatched, 1 T1 unused (copilot-1)
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({
        quorum_active: ['codex-1', 'gemini-1', 'opencode-1', 'copilot-1'],
        quorum: { maxSize: 4 },
        agent_config: {
          'codex-1':    { auth_type: 'sub' },
          'gemini-1':   { auth_type: 'sub' },
          'opencode-1': { auth_type: 'sub' },
          'copilot-1':  { auth_type: 'sub' },
        },
      }),
      'utf8'
    );
    const { stdout } = runHook({ prompt: '/qnf:plan-phase', cwd: tempDir });
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;

    assert.ok(ctx.includes('FALLBACK-01'), 'FALLBACK-01 must fire (1 T1 unused)');

    // The dispatched primary slots (Step 1) must NOT appear in the T1 line (Step 2)
    const t1LineMatch = ctx.match(/Step 2 T1 sub-CLI:\s+\[([^\]]+)\]/);
    assert.ok(t1LineMatch, 'Step 2 T1 must list slots');
    const t1Slots = new Set(t1LineMatch[1].split(',').map(s => s.trim()));

    const primaryLineMatch = ctx.match(/Step 1 PRIMARY:\s+\[([^\]]+)\]/);
    assert.ok(primaryLineMatch, 'Step 1 PRIMARY must list slots');
    const primarySlots = primaryLineMatch[1].split(',').map(s => s.trim());

    for (const primary of primarySlots) {
      assert.ok(!t1Slots.has(primary), `Primary slot "${primary}" must NOT appear in T1 list`);
    }
    // Only copilot-1 should be in T1
    assert.deepEqual([...t1Slots], ['copilot-1']);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-PROMPT-FALLBACK-AUTHTYPE-DYNAMIC: T1/T2 classification must be driven by runtime auth_type,
// NOT by slot naming convention. A "ccr" named slot with auth_type=sub must land in T1;
// a "native CLI" named slot with auth_type=api must land in T2.
test('TC-PROMPT-FALLBACK-AUTHTYPE-DYNAMIC: T1/T2 classification driven by auth_type, not slot name', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-authtype-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    // Non-standard config: claude-1 (typically T2 name) → auth_type=sub (→ T1)
    //                      codex-1 (typically T1 name) → auth_type=api (→ T2)
    // maxSize=3 → externalSlotCap=2 → dispatch gemini-1 + claude-1 (ordered by sub-first preference)
    // T1 unused = sub slots not in dispatch: none extra sub here
    // Actually: orderedSlots = sub-first: gemini-1(sub), claude-1(sub), codex-1(api)
    // cappedSlots (externalSlotCap=2) = [gemini-1, claude-1]
    // T1_UNUSED = sub slots not in capped = [] (both sub slots are dispatched)
    // T2 = [codex-1] (api)
    // Result: no FALLBACK-01, simple Failover rule (no T1 unused)
    //
    // Better scenario for the test: add a third sub slot to ensure T1 unused exists.
    // quorum_active: [gemini-1(sub), claude-1(sub), claude-2(sub), codex-1(api)]
    // maxSize=3 → externalSlotCap=2 → dispatch [gemini-1, claude-1]
    // T1_UNUSED = [claude-2] (sub, not dispatched)
    // T2 = [codex-1] (api)
    // FALLBACK-01 must fire with claude-2 in Step 2 T1 and codex-1 in Step 3 T2
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({
        quorum_active: ['gemini-1', 'claude-1', 'claude-2', 'codex-1'],
        quorum: { maxSize: 3 },
        agent_config: {
          'gemini-1': { auth_type: 'sub' },
          'claude-1': { auth_type: 'sub' },  // normally api — overridden to sub
          'claude-2': { auth_type: 'sub' },  // normally api — overridden to sub
          'codex-1':  { auth_type: 'api' },  // normally sub — overridden to api
        },
      }),
      'utf8'
    );
    const { stdout } = runHook({ prompt: '/qnf:plan-phase', cwd: tempDir });
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;

    // FALLBACK-01 must fire — claude-2 is an unused sub slot
    assert.ok(ctx.includes('FALLBACK-01'), 'FALLBACK-01 must fire when unused sub slot (claude-2) exists');

    // claude-2 is sub but not dispatched → must appear in Step 2 T1
    const t1LineMatch = ctx.match(/Step 2 T1 sub-CLI:\s+\[([^\]]+)\]/);
    assert.ok(t1LineMatch, 'Step 2 T1 must list slots');
    const t1Slots = t1LineMatch[1].split(',').map(s => s.trim());
    assert.ok(t1Slots.includes('claude-2'), 'claude-2 (auth_type=sub) must appear in T1 despite its "ccr" name');

    // codex-1 is api → must appear in Step 3 T2, NOT in Step 2 T1
    assert.ok(!t1Slots.includes('codex-1'), 'codex-1 (auth_type=api) must NOT appear in T1 despite its "native CLI" name');
    const t2LineMatch = ctx.match(/Step 3 T2 ccr:\s+\[([^\]]+)\]/);
    assert.ok(t2LineMatch, 'Step 3 T2 must list slots');
    const t2Slots = t2LineMatch[1].split(',').map(s => s.trim());
    assert.ok(t2Slots.includes('codex-1'), 'codex-1 (auth_type=api) must appear in T2 despite its "native CLI" name');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-PROMPT-FALLBACK-T2-EXCLUDES-PRIMARIES: an api slot dispatched as primary must NOT
// appear in Step 3 T2. Regression for the bug where t2Slots filtered all non-sub slots
// without excluding cappedSlots, causing primary api slots to appear in both Step 1 and Step 3.
test('TC-PROMPT-FALLBACK-T2-EXCLUDES-PRIMARIES: api slots dispatched as primary excluded from T2 list', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-t2excl-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    // Config: api-slot-A dispatched as primary (externalSlotCap=1); sub-slot-B is T1 unused;
    // api-slot-C is the only genuine T2. api-slot-A must NOT appear in T2.
    // quorum_active: ['api-slot-A', 'sub-slot-B', 'api-slot-C']
    // preferSub: false → orderedSlots order preserved: api-slot-A, sub-slot-B, api-slot-C
    // maxSize=2 → externalSlotCap=1 → cappedSlots=[api-slot-A]
    // t1Unused = sub slots not in capped = [sub-slot-B]
    // t2Slots (correct) = api slots not in capped = [api-slot-C]   (excludes api-slot-A)
    // t2Slots (buggy)   = all api slots           = [api-slot-A, api-slot-C]  (includes primary!)
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({
        quorum_active: ['api-slot-A', 'sub-slot-B', 'api-slot-C'],
        quorum: { maxSize: 2, preferSub: false },
        agent_config: {
          'api-slot-A': { auth_type: 'api' },
          'sub-slot-B': { auth_type: 'sub' },
          'api-slot-C': { auth_type: 'api' },
        },
      }),
      'utf8'
    );
    const { stdout } = runHook({ prompt: '/qnf:plan-phase', cwd: tempDir });
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;

    assert.ok(ctx.includes('FALLBACK-01'), 'FALLBACK-01 must fire (sub-slot-B is T1 unused)');

    const t2LineMatch = ctx.match(/Step 3 T2 ccr:\s+\[([^\]]+)\]/);
    assert.ok(t2LineMatch, 'Step 3 T2 must be present');
    const t2Slots = t2LineMatch[1].split(',').map(s => s.trim());

    assert.ok(!t2Slots.includes('api-slot-A'), 'api-slot-A is primary — must NOT appear in Step 3 T2');
    assert.ok(t2Slots.includes('api-slot-C'), 'api-slot-C is the only genuine T2 slot');

    const primaryLineMatch = ctx.match(/Step 1 PRIMARY:\s+\[([^\]]+)\]/);
    assert.ok(primaryLineMatch, 'Step 1 PRIMARY must be present');
    const primarySlots = primaryLineMatch[1].split(',').map(s => s.trim());
    assert.ok(primarySlots.includes('api-slot-A'), 'api-slot-A must appear in Step 1 PRIMARY');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-PROMPT-FALLBACK-EMPTY-AGENTCONFIG: when agent_config is {} (empty), all slots
// default to auth_type='api'. With maxSize high enough to fit all slots, t1Unused
// is empty AND no T2 overflow → simple failover rule, no FALLBACK-01.
// The test verifies: (a) no FALLBACK-01 label appears, (b) the simple failover rule
// IS present, (c) dispatched slot names appear in Task() lines.
test('TC-PROMPT-FALLBACK-EMPTY-AGENTCONFIG: empty agent_config → no T1, simple failover rule', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-emptyac-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    // quorum_active set with known slots but agent_config is empty {}
    // All slots default to auth_type='api' — no sub slots → no T1 unused
    // maxSize=5 ensures all 4 slots fit within the cap (no T2 overflow)
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({
        quorum_active: ['codex-1', 'gemini-1', 'opencode-1', 'copilot-1'],
        quorum: { maxSize: 5 },
        agent_config: {},
      }),
      'utf8'
    );
    const { stdout, exitCode } = runHook({ prompt: '/qnf:plan-phase', cwd: tempDir });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.length > 0, 'stdout must contain quorum injection');

    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;

    // (a) No FALLBACK-01 — all api slots fit within fan-out cap, no overflow
    assert.ok(!ctx.includes('FALLBACK-01'), 'Must NOT use FALLBACK-01 when all slots fit (no T1/T2 overflow)');

    // (b) Simple failover rule must be present
    assert.ok(ctx.includes('Failover rule'), 'Simple Failover rule must appear when no fallback tiers exist');
    assert.ok(ctx.includes('do not count toward'), 'Failover rule must state errors do not count');

    // (c) Dispatched slot names must appear in Task() lines
    const taskLines = ctx.match(/Task\(subagent_type="nf-quorum-slot-worker"/g) || [];
    assert.ok(taskLines.length > 0, 'At least one slot-worker Task must be dispatched');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ── Profile Guard Tests ─────────────────────────────────────────────────────

// TC-PROFILE-MINIMAL-EXIT: hook_profile=minimal → nf-prompt exits 0 with no output
test('TC-PROFILE-MINIMAL-EXIT: hook_profile=minimal exits 0 with no output', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-profile-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ hook_profile: 'minimal' }),
      'utf8'
    );

    // A planning command that would normally trigger quorum injection
    const { stdout, exitCode } = runHook({
      prompt: '/nf:plan-phase 03',
      cwd: tempDir,
    });

    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty — minimal profile skips nf-prompt entirely');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-STRICT-QUORUM-ON-NON-QUORUM-CMD: hook_profile=strict → /nf:execute-phase gets quorum injection
test('TC-STRICT-QUORUM-ON-NON-QUORUM-CMD: strict mode injects quorum for non-quorum command', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-strict-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({
        hook_profile: 'strict',
        quorum_active: ['codex-1', 'gemini-1'],
      }),
      'utf8'
    );

    // /nf:execute-phase is NOT in default quorum_commands list
    // Strict mode should still inject quorum instructions
    const { stdout, exitCode } = runHook({
      prompt: '/nf:execute-phase 03',
      cwd: tempDir,
    });

    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.length > 0, 'stdout must contain quorum injection — strict mode matches execute-phase');
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.hookSpecificOutput, 'output must have hookSpecificOutput');
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes('QUORUM REQUIRED'),
      'additionalContext must include "QUORUM REQUIRED" for strict mode'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-PREFLIGHT-1: runPreflightFilter fail-open when preflight is bypassed (NF_SKIP_PREFLIGHT=1)
// Verifies that when NF_SKIP_PREFLIGHT=1 (the default in runHook), the hook proceeds
// to normal dispatch without probing or short-circuiting.
test('TC-PREFLIGHT-1: runPreflightFilter fail-open — hook dispatches normally when preflight bypassed', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-pf1-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.clone');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ quorum_active: ['codex-1', 'gemini-1'], quorum_commands: ['/nf:plan-phase'] }),
      'utf8'
    );
    // runHook defaults to NF_SKIP_PREFLIGHT=1 — verifies fail-open path dispatches normally
    const { stdout, exitCode } = runHook({ prompt: '/nf:plan-phase test', cwd: tempDir });
    assert.strictEqual(exitCode, 0, 'exit code must be 0 — fail-open path proceeds normally');
    assert.ok(stdout.length > 0, 'stdout must contain dispatch instructions (fail-open dispatches normally)');
    assert.ok(!stdout.includes('NF_ALL_SLOTS_DOWN'), 'fail-open must not produce NF_ALL_SLOTS_DOWN marker');
    const pf1Parsed = JSON.parse(stdout);
    assert.ok(pf1Parsed.hookSpecificOutput, 'output must have hookSpecificOutput');
    assert.ok(
      pf1Parsed.hookSpecificOutput.additionalContext.includes('QUORUM REQUIRED'),
      'fail-open must still inject QUORUM REQUIRED dispatch instructions'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-PREFLIGHT-2: NF_SKIP_PREFLIGHT=0 with real preflight present does not crash
// Ensures that when NF_SKIP_PREFLIGHT is disabled and quorum-preflight.cjs is available,
// the hook completes without crashing (fail-open behavior on probe results).
test('TC-PREFLIGHT-2: NF_SKIP_PREFLIGHT=0 with real preflight present does not crash', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-pf2-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ quorum_active: ['codex-1', 'gemini-1'] }),
      'utf8'
    );
    // Run with NF_SKIP_PREFLIGHT=0 and extended timeout to allow real probe to complete.
    // HOME overridden to tempDir so no global ~/.claude/nf.json is loaded.
    // With an isolated HOME, preflight binary probes will fail (no real CLIs configured),
    // and the hook must fail-open and still emit valid dispatch instructions.
    const payload = JSON.stringify({ prompt: '/nf:plan-phase test', cwd: tempDir });
    const pf2Env = { ...process.env, NF_SKIP_PREFLIGHT: '0', HOME: tempDir };
    const pf2Result = spawnSync('node', [HOOK_PATH], {
      input: payload,
      encoding: 'utf8',
      timeout: 12000, // longer timeout to allow up to 6s preflight probe
      env: pf2Env,
    });
    assert.strictEqual(pf2Result.status, 0, 'exit code must be 0 — fail-open on probe failure or unavail result');
    assert.ok(typeof pf2Result.stdout === 'string', 'stdout must be a string');
    assert.ok(pf2Result.stdout.length > 0, 'stdout must be non-empty (dispatch or all-down message)');
    // Either normal dispatch or NF_ALL_SLOTS_DOWN — both are valid outcomes
    const hasDispatch = pf2Result.stdout.includes('QUORUM REQUIRED') || pf2Result.stdout.includes('NF_ALL_SLOTS_DOWN');
    assert.ok(hasDispatch, 'must emit either QUORUM REQUIRED dispatch or NF_ALL_SLOTS_DOWN message');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-PROMPT-ALLDOWN-PROMOTES-T2: T2 slots promoted when sub-type primaries fail preflight
// Tests that when externalSlotCap only caps sub-type slots and they all fail preflight,
// remaining api-type slots from orderedSlots are promoted and used if they survive preflight.
test('TC-PROMPT-ALLDOWN-PROMOTES-T2: allDown triggers promotion of remaining T2 slots', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prompt-alldown-t2-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    // Set up bin directory with mock quorum-preflight that reports sub-slots as unavailable
    const binDir = path.join(tempDir, 'mock-bin');
    fs.mkdirSync(binDir, { recursive: true });

    // Create a mock quorum-preflight.cjs that simulates:
    // - codex-1 and gemini-1 are DOWN (sub-type slots that failed)
    // - claude-1 is UP (api-type slot that survived)
    // This simulates the scenario where sub-type primaries fail but T2 can be promoted
    const mockPreflight = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--all')) {
  console.log(JSON.stringify({
    "quorum_active": ["codex-1", "gemini-1", "claude-1"],
    "max_quorum_size": 3,
    "team": {},
    "available_slots": ["claude-1"],
    "unavailable_slots": [
      { "name": "codex-1", "reason": "layer1: binary not found: codex" },
      { "name": "gemini-1", "reason": "layer1: binary not found: gemini" }
    ]
  }));
  process.exit(0);
}
process.exit(1);
`;
    const mockPreflightPath = path.join(binDir, 'quorum-preflight.cjs');
    fs.writeFileSync(mockPreflightPath, mockPreflight, 'utf8');
    fs.chmodSync(mockPreflightPath, 0o755);

    // nf.json: 3 slots with maxSize=3 means externalSlotCap=2
    // With preferSub=true: cappedSlots=[codex-1, gemini-1], remaining=[claude-1]
    const nfConfig = {
      quorum_active: ['codex-1', 'gemini-1', 'claude-1'],
      quorum: { maxSize: 3 },
      agent_config: {
        'codex-1': { auth_type: 'sub' },
        'gemini-1': { auth_type: 'sub' },
        'claude-1': { auth_type: 'api' }
      }
    };
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify(nfConfig),
      'utf8'
    );

    // Override bin/quorum-preflight.cjs temporarily with our mock
    const realPreflight = path.join(__dirname, '..', 'bin', 'quorum-preflight.cjs');
    const backupPath = realPreflight + '.backup';
    fs.copyFileSync(realPreflight, backupPath);
    fs.writeFileSync(realPreflight, mockPreflight, 'utf8');

    try {
      // Run hook with NF_SKIP_PREFLIGHT=0 to actually run preflight
      const payload = JSON.stringify({ prompt: '/nf:plan-phase test', cwd: tempDir });
      const promoteEnv = { ...process.env, NF_SKIP_PREFLIGHT: '0', HOME: tempDir };
      const promoteResult = spawnSync('node', [HOOK_PATH], {
        input: payload,
        encoding: 'utf8',
        timeout: 12000,
        env: promoteEnv,
      });

      assert.strictEqual(promoteResult.status, 0, 'exit code must be 0');
      assert.ok(typeof promoteResult.stdout === 'string', 'stdout must be a string');
      assert.ok(promoteResult.stdout.length > 0, 'stdout must be non-empty');

      // Check for promotion log in stderr
      const stderr = promoteResult.stderr || '';
      const hasPromoteLog = stderr.includes('ALLDOWN-PROMOTE');
      assert.ok(hasPromoteLog, `stderr must contain ALLDOWN-PROMOTE; got: ${stderr}`);

      // Output should contain QUORUM REQUIRED (dispatch proceeded), not NF_ALL_SLOTS_DOWN
      assert.ok(
        !promoteResult.stdout.includes('NF_ALL_SLOTS_DOWN'),
        'output must not contain NF_ALL_SLOTS_DOWN (promoted slots survived)'
      );
      assert.ok(
        promoteResult.stdout.includes('QUORUM REQUIRED'),
        'output must contain QUORUM REQUIRED (dispatch proceeded with promoted slots)'
      );
    } finally {
      // Restore real preflight
      fs.copyFileSync(backupPath, realPreflight);
      fs.unlinkSync(backupPath);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// ── SESSION STATE INJECTION TESTS (SESSION-01, SESSION-02, SESSION-03) ────────
// ──────────────────────────────────────────────────────────────────────────────

test('SESSION-01: isFirstMessageOfSession creates sentinel flag on first call', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-session-01-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ quorum_active: ['codex-1'] }),
      'utf8'
    );

    // Create a minimal STATE.md
    fs.mkdirSync(path.join(tempDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, '.planning', 'STATE.md'),
      '## Current Position\nPhase: v0.40-01\nStatus: Ready\n',
      'utf8'
    );

    const sessionId = 'test-session-123';
    const { stdout } = runHook({
      prompt: '/nf:plan-phase',
      cwd: tempDir,
      session_id: sessionId,
    });

    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.ok(
      ctx.includes('SESSION CONTEXT'),
      'SESSION-01: first message should include SESSION CONTEXT'
    );

    // Verify sentinel flag was created
    const flagPath = path.join(claudeDir, `nf-session-seen-${sessionId}.flag`);
    assert.ok(fs.existsSync(flagPath), 'SESSION-01: sentinel flag file must be created');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('SESSION-02: isFirstMessageOfSession idempotency — second call returns false', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-session-02-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ quorum_active: ['codex-1'] }),
      'utf8'
    );

    fs.mkdirSync(path.join(tempDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, '.planning', 'STATE.md'),
      '## Current Position\nPhase: v0.40-01\n',
      'utf8'
    );

    const sessionId = 'test-session-idempotent';

    // First call
    const { stdout: out1 } = runHook({
      prompt: '/nf:plan-phase',
      cwd: tempDir,
      session_id: sessionId,
    });
    const ctx1 = JSON.parse(out1).hookSpecificOutput.additionalContext;
    assert.ok(ctx1.includes('SESSION CONTEXT'), 'First call must include SESSION CONTEXT');

    // Second call with the SAME sessionId
    const { stdout: out2 } = runHook({
      prompt: '/nf:plan-phase',
      cwd: tempDir,
      session_id: sessionId,
    });
    const ctx2 = JSON.parse(out2).hookSpecificOutput.additionalContext;
    assert.ok(
      !ctx2.includes('SESSION CONTEXT'),
      'SESSION-02: second call with same sessionId must NOT include SESSION CONTEXT (idempotency)'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('SESSION-03: session injection fails gracefully when .planning/STATE.md missing', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-session-03-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ quorum_active: ['codex-1'] }),
      'utf8'
    );

    // No STATE.md file — fail-open path
    const sessionId = 'test-session-missing';
    const { stdout, exitCode } = runHook({
      prompt: '/nf:plan-phase',
      cwd: tempDir,
      session_id: sessionId,
    });

    assert.strictEqual(exitCode, 0, 'SESSION-03: must not crash on missing STATE.md');
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.ok(
      !ctx.includes('SESSION CONTEXT'),
      'SESSION-03: missing STATE.md must not inject SESSION CONTEXT (fail-open)'
    );
    assert.ok(
      ctx.includes('QUORUM REQUIRED'),
      'SESSION-03: must still continue to quorum injection (fail-open)'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// ── ROOT CAUSE TEMPLATE INJECTION TESTS (ROOT-01, ROOT-03) ────────────────────
// ──────────────────────────────────────────────────────────────────────────────

test('ROOT-01: debug/fix prompts receive ROOT CAUSE ENFORCEMENT template', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-root-01-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ quorum_active: ['codex-1'] }),
      'utf8'
    );

    // Test multiple debug/fix patterns
    const testCases = [
      'fix the authentication bug',
      'debug this issue',
      'why is it not working',
      'the bug is in the parser',
      'investigate the failure',
      'error when running tests',
    ];

    for (const prompt of testCases) {
      const { stdout } = runHook({
        prompt: `/nf:plan-phase ${prompt}`,
        cwd: tempDir,
      });
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      assert.ok(
        ctx.includes('ROOT CAUSE ENFORCEMENT'),
        `ROOT-01: prompt "${prompt}" must receive ROOT CAUSE ENFORCEMENT template`
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('ROOT-03: non-debug/fix prompts do NOT receive ROOT CAUSE ENFORCEMENT', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-root-03-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ quorum_active: ['codex-1'] }),
      'utf8'
    );

    const testCases = [
      'add a new feature',
      'create a dashboard',
      'update the README',
      '/nf:plan-phase v0.40-02',
    ];

    for (const prompt of testCases) {
      const { stdout } = runHook({
        prompt: `/nf:plan-phase ${prompt}`,
        cwd: tempDir,
      });
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      assert.ok(
        !ctx.includes('ROOT CAUSE ENFORCEMENT'),
        `ROOT-03: non-debug prompt "${prompt}" must NOT receive ROOT CAUSE ENFORCEMENT`
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// ── EDIT CONSTRAINT INJECTION TESTS (CONST-01, CONST-02) ──────────────────────
// ──────────────────────────────────────────────────────────────────────────────

test('CONST-01: edit prompts (not debug, not new-feature) receive EDIT CONSTRAINT', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-const-01-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ quorum_active: ['codex-1'] }),
      'utf8'
    );

    const testCases = [
      'update the README',
      'change the color to red',
      'rewrite the header',
      'modify the config',
      'replace foo with bar',
    ];

    for (const prompt of testCases) {
      const { stdout } = runHook({
        prompt: `/nf:plan-phase ${prompt}`,
        cwd: tempDir,
      });
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      assert.ok(
        ctx.includes('EDIT CONSTRAINT'),
        `CONST-01: edit prompt "${prompt}" must receive EDIT CONSTRAINT`
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CONST-02: debug/fix prompts do NOT receive EDIT CONSTRAINT (priority)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-const-02a-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ quorum_active: ['codex-1'] }),
      'utf8'
    );

    // Prompt that matches both debug/fix AND edit patterns
    // Should get ROOT CAUSE, NOT EDIT CONSTRAINT (debug takes priority)
    const { stdout } = runHook({
      prompt: '/nf:plan-phase fix the broken link in the README',
      cwd: tempDir,
    });
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.ok(
      ctx.includes('ROOT CAUSE ENFORCEMENT'),
      'CONST-02: prompt matching both debug and edit should get ROOT CAUSE'
    );
    assert.ok(
      !ctx.includes('EDIT CONSTRAINT'),
      'CONST-02: prompt matching both debug and edit should NOT get EDIT CONSTRAINT (mutual exclusion)'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CONST-02: new-feature prompts do NOT receive EDIT CONSTRAINT', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-const-02b-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ quorum_active: ['codex-1'] }),
      'utf8'
    );

    const testCases = [
      'create a new component',
      'add a new endpoint',
      'build a new feature',
      'implement a new file',
    ];

    for (const prompt of testCases) {
      const { stdout } = runHook({
        prompt: `/nf:plan-phase ${prompt}`,
        cwd: tempDir,
      });
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      assert.ok(
        !ctx.includes('EDIT CONSTRAINT'),
        `CONST-02: new-feature prompt "${prompt}" must NOT receive EDIT CONSTRAINT`
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CONST-02: non-matching prompts receive neither template', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-const-02c-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ quorum_active: ['codex-1'] }),
      'utf8'
    );

    const { stdout } = runHook({
      prompt: '/nf:plan-phase v0.40-02',
      cwd: tempDir,
    });
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.ok(
      !ctx.includes('ROOT CAUSE ENFORCEMENT'),
      'CONST-02: non-matching prompt must not receive ROOT CAUSE'
    );
    assert.ok(
      !ctx.includes('EDIT CONSTRAINT'),
      'CONST-02: non-matching prompt must not receive EDIT CONSTRAINT'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// ── QUORUM GATE PRESERVATION TEST ────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────

test('Quorum gate preservation: ROOT CAUSE injection does NOT suppress GSD_DECISION marker', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-quorum-gate-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ quorum_active: ['codex-1'] }),
      'utf8'
    );

    const { stdout } = runHook({
      prompt: '/nf:plan-phase fix the authentication bug',
      cwd: tempDir,
    });
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;

    // Both ROOT CAUSE and quorum markers must be present (no early exit)
    assert.ok(
      ctx.includes('ROOT CAUSE ENFORCEMENT'),
      'Quorum gate: ROOT CAUSE must be injected'
    );
    // The Stop hook checks for <!-- GSD_DECISION --> — while nf-prompt doesn't emit it,
    // we verify that quorum instructions (which reference it) are still present.
    assert.ok(
      ctx.includes('QUORUM REQUIRED'),
      'Quorum gate: QUORUM REQUIRED must be present (no early exit suppressed quorum)'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// ── ADVERSARIAL: PRIORITY ORDERING / QUEUED-TASK / BREAKER / OUTPUT / FAIL-OPEN ─
// (covers the three non-quorum-injection responsibilities + cross-cutting safety;
//  trigger-detection & fan-out-cap probes are intentionally NOT duplicated here)
// ──────────────────────────────────────────────────────────────────────────────

// ADV-PRIORITY: breaker active AND a queued task AND a quorum command all hold at once.
// Priority 1 (breaker) must win. The other two jobs must be DEFERRED, not silently
// dropped: the pending-task file MUST remain on disk (it is consumed-and-discarded
// only by Priority 2, which never runs when the breaker short-circuits first), and
// quorum injection must be absent for this turn. A refactor that ran consumePendingTask
// before the breaker gate would silently destroy the user's queued command (data loss).
test('ADV-PRIORITY: breaker wins; queued task preserved on disk, not consumed or dropped', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-adv-prio-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    // Breaker active
    fs.writeFileSync(
      path.join(claudeDir, 'circuit-breaker-state.json'),
      JSON.stringify({ active: true }),
      'utf8'
    );
    // A queued task ALSO pending
    const pendingFile = path.join(claudeDir, 'pending-task.txt');
    fs.writeFileSync(pendingFile, '/nf:execute-phase 04-do-the-thing', 'utf8');

    // …and the prompt itself is a quorum planning command
    const { stdout, exitCode } = runHook({ prompt: '/nf:plan-phase 03-auth', cwd: tempDir });

    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;

    // Priority 1 wins
    assert.ok(ctx.includes('CIRCUIT BREAKER ACTIVE'), 'breaker recovery must be injected (Priority 1)');
    // Priority 2 + 3 deferred (not double-injected)
    assert.ok(!ctx.includes('PENDING QUEUED TASK'), 'queued task must NOT be injected this turn (deferred behind breaker)');
    assert.ok(!ctx.includes('QUORUM REQUIRED'), 'quorum injection must NOT appear this turn (deferred behind breaker)');

    // CRITICAL: the queued task must survive on disk — NOT silently consumed/dropped.
    assert.ok(fs.existsSync(pendingFile), 'pending-task.txt must remain on disk (breaker exits before consumePendingTask)');
    assert.ok(!fs.existsSync(pendingFile + '.claimed'), 'pending task must not be left in a half-claimed state');
    assert.strictEqual(
      fs.readFileSync(pendingFile, 'utf8'),
      '/nf:execute-phase 04-do-the-thing',
      'queued task content must be intact for delivery on a later (post-breaker) turn'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ADV-QUEUE-ONCE: a queued task must be consumed EXACTLY ONCE. The same payload sent
// twice must inject "PENDING QUEUED TASK" only on the first prompt; the second prompt
// must fall through to normal quorum injection. A re-injecting queued task (file never
// claimed/removed) would replay the queued command on every subsequent prompt forever.
test('ADV-QUEUE-ONCE: queued task is consumed once and not re-injected on the next prompt', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-adv-once-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const pendingFile = path.join(claudeDir, 'pending-task.txt');
    fs.writeFileSync(pendingFile, '/nf:resume-work', 'utf8');

    // First prompt — must deliver the queued task (Priority 2 short-circuits before quorum)
    const r1 = runHook({ prompt: '/nf:plan-phase', cwd: tempDir });
    assert.strictEqual(r1.exitCode, 0, 'first run exit 0');
    const ctx1 = JSON.parse(r1.stdout).hookSpecificOutput.additionalContext;
    assert.ok(ctx1.includes('PENDING QUEUED TASK'), 'first prompt must inject the queued task');
    assert.ok(ctx1.includes('/nf:resume-work'), 'queued task content must be delivered');
    assert.ok(!fs.existsSync(pendingFile), 'pending-task.txt must be claimed/removed after delivery');

    // Second identical prompt — task is gone, must NOT re-inject; falls through to quorum
    const r2 = runHook({ prompt: '/nf:plan-phase', cwd: tempDir });
    assert.strictEqual(r2.exitCode, 0, 'second run exit 0');
    const ctx2 = JSON.parse(r2.stdout).hookSpecificOutput.additionalContext;
    assert.ok(!ctx2.includes('PENDING QUEUED TASK'), 'second prompt must NOT re-inject the consumed queued task');
    assert.ok(ctx2.includes('QUORUM REQUIRED'), 'second prompt must fall through to normal quorum injection');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ADV-QUEUE-EMPTY: an empty / whitespace-only pending-task file must NOT inject a hollow
// "PENDING QUEUED TASK" block, must be cleaned up (claimed+removed, not left to loop), and
// the hook must fall through to normal quorum handling. Probes the `if (task) return task`
// guard plus the best-effort cleanup of the .claimed file.
test('ADV-QUEUE-EMPTY: whitespace-only pending file injects nothing, is cleaned up, falls through', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-adv-empty-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const pendingFile = path.join(claudeDir, 'pending-task.txt');
    fs.writeFileSync(pendingFile, '   \n\t  \n', 'utf8'); // trims to empty

    const { stdout, exitCode } = runHook({ prompt: '/nf:plan-phase', cwd: tempDir });
    assert.strictEqual(exitCode, 0, 'exit 0');
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;

    assert.ok(!ctx.includes('PENDING QUEUED TASK'), 'empty queued task must NOT inject a hollow block');
    assert.ok(ctx.includes('QUORUM REQUIRED'), 'must fall through to normal quorum injection');
    // Empty file must not survive to re-trigger on every future prompt
    assert.ok(!fs.existsSync(pendingFile), 'empty pending file must be consumed/removed');
    assert.ok(!fs.existsSync(pendingFile + '.claimed'), 'no orphan .claimed file left behind');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ADV-BREAKER-CORRUPT: a corrupt / wrong-shape circuit-breaker-state.json must NOT crash
// the hook and must NOT trigger recovery injection (fail-open clean). isBreakerActive wraps
// JSON.parse in try/catch and requires `active === true`; a garbage file or a wrong-typed
// `active` must be treated as inactive, letting the planning command proceed to quorum.
test('ADV-BREAKER-CORRUPT: corrupt/wrong-shape breaker state fails open (no crash, no injection)', () => {
  // Case A: unparseable JSON
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-adv-cbA-'));
  try {
    spawnSync('git', ['init'], { cwd: dirA, encoding: 'utf8', timeout: 5000 });
    fs.mkdirSync(path.join(dirA, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dirA, '.claude', 'circuit-breaker-state.json'), '{ active: true, ', 'utf8');
    const { stdout, exitCode } = runHook({ prompt: '/nf:plan-phase', cwd: dirA });
    assert.strictEqual(exitCode, 0, 'corrupt JSON must not crash (exit 0)');
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.ok(!ctx.includes('CIRCUIT BREAKER ACTIVE'), 'corrupt state must NOT inject breaker recovery');
    assert.ok(ctx.includes('QUORUM REQUIRED'), 'corrupt state must fall through to quorum (fail-open)');
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
  }

  // Case B: parseable but wrong-shaped `active` (string, not boolean true)
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-adv-cbB-'));
  try {
    spawnSync('git', ['init'], { cwd: dirB, encoding: 'utf8', timeout: 5000 });
    fs.mkdirSync(path.join(dirB, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(dirB, '.claude', 'circuit-breaker-state.json'),
      JSON.stringify({ active: 'true' }), 'utf8'
    );
    const { stdout, exitCode } = runHook({ prompt: '/nf:plan-phase', cwd: dirB });
    assert.strictEqual(exitCode, 0, 'wrong-shape active must not crash (exit 0)');
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.ok(!ctx.includes('CIRCUIT BREAKER ACTIVE'), 'active:"true" (string) must NOT trip the breaker (=== true required)');
  } finally {
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

// ADV-OUTPUT-CONTRACT: every injection path must emit context via
// hookSpecificOutput.additionalContext, NEVER systemMessage (systemMessage only shows a UI
// warning and would silently lose the injected context). stdout must be exactly one parseable
// JSON object with no debug leakage (stdout is the decision channel). Verified on the
// queued-task path (Priority 2).
test('ADV-OUTPUT-CONTRACT: pending-task path uses additionalContext, never systemMessage; stdout is pure JSON', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-adv-out-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'pending-task.txt'), '/nf:check-todos', 'utf8');

    const { stdout, exitCode } = runHook({ prompt: 'just a normal message', cwd: tempDir });
    assert.strictEqual(exitCode, 0, 'exit 0');

    // stdout must be exactly one JSON object (no stray debug text on the decision channel)
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(stdout); }, 'stdout must be pure parseable JSON');
    assert.ok(parsed.hookSpecificOutput, 'must use hookSpecificOutput envelope');
    assert.strictEqual(typeof parsed.hookSpecificOutput.additionalContext, 'string', 'context must ride additionalContext');
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes('/nf:check-todos'), 'queued task must be present in additionalContext');
    assert.strictEqual(parsed.systemMessage, undefined, 'must NEVER use top-level systemMessage for context delivery');
    assert.strictEqual(parsed.hookSpecificOutput.systemMessage, undefined, 'must NEVER nest systemMessage either');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ADV-FAILOPEN: degenerate stdin must fail open — exit 0 with NO stdout (no spurious
// injection). Covers empty stdin, whitespace-only stdin (JSON.parse throws SyntaxError),
// and a structurally-valid object that is MISSING the required `prompt` field
// (validateHookInput rejects → fail-open before any business logic).
test('ADV-FAILOPEN: empty/whitespace stdin and missing-prompt input exit 0 with no output', () => {
  // Empty stdin
  const empty = runHook('');
  assert.strictEqual(empty.exitCode, 0, 'empty stdin must exit 0');
  assert.strictEqual(empty.stdout, '', 'empty stdin must produce no stdout');

  // Whitespace-only stdin
  const ws = runHook('   \n  ');
  assert.strictEqual(ws.exitCode, 0, 'whitespace stdin must exit 0');
  assert.strictEqual(ws.stdout, '', 'whitespace stdin must produce no stdout');

  // Valid JSON object but missing required `prompt`
  const noPrompt = runHook(JSON.stringify({ cwd: process.cwd(), session_id: 'x' }));
  assert.strictEqual(noPrompt.exitCode, 0, 'missing-prompt input must exit 0 (fail-open)');
  assert.strictEqual(noPrompt.stdout, '', 'missing-prompt input must produce no stdout');
});

// ADVERSARIAL TEST: parseQuorumSizeFlag silently ignores trailing non-numeric chars
// --n 2abc captures "2" via \d+ and returns 2 (valid). This could cause confusion
// if a user mistakenly types "--n 2.5" expecting 2.5 but getting 2 (or null if we fix it).
// This test documents the current behavior: trailing chars after digits are silently dropped.
test('ADVERSARIAL: parseQuorumSizeFlag drops trailing non-digit characters like --n 2abc', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-adv-parse-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ quorum_active: ['codex-1', 'gemini-1', 'opencode-1', 'copilot-1', 'claude-1'] }),
      'utf8'
    );

    // --n 2abc: \d+ matches "2", parseInt("2")=2, n>=1 → returns 2
    // The "abc" is silently ignored. This is arguably wrong UX.
    const { stdout } = runHook({ prompt: '/qnf:plan-phase --n 2abc', cwd: tempDir });
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    // The quorum instruction should reference --n 2 (not --n 2abc)
    // Current buggy behavior: "2abc" is silently truncated to "2"
    assert.ok(
      ctx.includes('--n 2'),
      'parseQuorumSizeFlag should handle --n 2abc by truncating to 2 (documenting current behavior)'
    );
    // Task lines should show only 1 external slot (N-1 = 1) since fanOutCount=2
    const taskLineCount = (ctx.match(/\d+\. Task\(subagent_type="nf-quorum-slot-worker"/g) || []).length;
    assert.strictEqual(taskLineCount, 1, '--n 2abc with 2→1 external slot should produce exactly 1 Task line');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── ADVERSARIAL: FAN-OUT CAP INTEGRITY (SC-4 over-dispatch probes) ────────────
// ══════════════════════════════════════════════════════════════════════════════
//
// The fan-out budget is: total participants = fanOutCount (Claude is the +1, so
// externalSlotCap = fanOutCount - 1 external slot-workers). When the risk math or
// a small maxSize yields fanOutCount === 1, externalSlotCap is 0 → Claude is the
// *whole* quorum (solo by budget). The hook MUST dispatch 0 external slot-workers.
//
// REAL DEFECT (line ~730, "SC-4: Graceful fallback"): the restore guard is
//   if (cappedSlots.length === 0 && orderedSlots.length > 0) { cappedSlots = [slot] }
// It does NOT check that externalSlotCap > 0. So whenever externalSlotCap is a
// *legitimate* 0, SC-4 force-restores one slot, dispatching a fleet that exceeds
// the computed budget — and, for maxSize=1, exceeds maxSize itself.

// ADV-FANOUT-MAXSIZE1-OVERDISPATCH: maxSize=1 means a 1-participant quorum (Claude only,
// 0 external). FIXED: a 0-external budget now routes to SOLO MODE (the same NF_SOLO_MODE
// marker the empty-roster and --n 1 paths use, which the Stop hook recognises so it does
// NOT floor-block on 0 external voters) with ZERO slot-worker Task lines — instead of the
// old SC-4 fallback restoring a slot (Claude + 1 = a fleet of 2 > maxSize=1, over-dispatch).
// EXPECTED: PASSES — engages solo-mode quorum, dispatches 0 external. Regression guard.
test('ADV-FANOUT-MAXSIZE1-OVERDISPATCH: maxSize=1 must dispatch 0 external slots (fleet must not exceed maxSize)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-adv-fan1-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({
        quorum_active: ['codex-1', 'gemini-1'],
        quorum: { maxSize: 1 },
        agent_config: { 'codex-1': { auth_type: 'api' }, 'gemini-1': { auth_type: 'api' } },
      }),
      'utf8'
    );
    const { stdout, exitCode } = runHook({ prompt: '/qnf:plan-phase', cwd: tempDir });
    assert.strictEqual(exitCode, 0, 'exit 0');
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    // Quorum must be ENGAGED (not silently skipped) — as SOLO MODE, the correct
    // representation of a 1-participant quorum (Claude only). Not a QUORUM REQUIRED
    // block that lists slot-worker Tasks (that would over-dispatch and, with
    // min_live_voters=2, deadlock the Stop hook on 0 external voters).
    assert.match(ctx, /NF_SOLO_MODE|SOLO MODE/, 'maxSize=1 must engage solo-mode quorum, not skip it or full-dispatch');

    const taskLineCount = (ctx.match(/\d+\. Task\(subagent_type="nf-quorum-slot-worker"/g) || []).length;
    // maxSize=1 → externalSlotCap = fanOutCount-1 = 0 → fleet (Claude + external) must be ≤ 1.
    assert.strictEqual(
      taskLineCount, 0,
      `maxSize=1 must produce 0 external slot-worker Task lines (Claude is the whole quorum); ` +
      `got ${taskLineCount} → fleet of ${taskLineCount + 1} EXCEEDS maxSize=1 (SC-4 over-dispatch)`
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ADV-FANOUT-ROUTINE-HEADER-CONTRADICTION: with maxSize=3 + risk_level=routine,
// mapRiskLevelToCount → ceil(3/3) = 1 → fanOutCount=1 → externalSlotCap=0. FIXED: a
// 0-external budget now renders as SOLO MODE with ZERO Task lines — so there is no
// "→ N external slots" header for the body to contradict. (Previously SC-4 restored one
// slot, so the header said 0 external but the body listed 1 Task — a self-contradiction.)
// EXPECTED: PASSES — solo mode, 0 Task lines, and any announced external count equals
// the dispatched count.
test('ADV-FANOUT-ROUTINE-HEADER-CONTRADICTION: announced external count must equal dispatched Task lines', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-adv-fanrt-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({
        quorum_active: ['codex-1', 'gemini-1'],
        quorum: { maxSize: 3 },
        agent_config: { 'codex-1': { auth_type: 'api' }, 'gemini-1': { auth_type: 'api' } },
      }),
      'utf8'
    );
    const { stdout } = runHook({
      prompt: '/qnf:plan-phase',
      cwd: tempDir,
      context_yaml: 'risk_level: routine\n',
    });
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;

    const taskLineCount = (ctx.match(/\d+\. Task\(subagent_type="nf-quorum-slot-worker"/g) || []).length;
    // A 0-external (routine) fan-out renders as solo mode with zero Task lines — no
    // over-dispatch, no header/body contradiction.
    assert.match(ctx, /NF_SOLO_MODE|SOLO MODE/, 'a 0-external (routine) fan-out must render as solo mode');
    assert.strictEqual(taskLineCount, 0, `solo mode must dispatch 0 slot-worker Task lines, got ${taskLineCount}`);
    // Defensive: if any "N external slot(s)" count is announced, it must equal the
    // dispatched Task-line count (no self-contradiction).
    const announced = ctx.match(/(\d+)\s+external\s+slot/);
    if (announced) {
      assert.strictEqual(
        parseInt(announced[1], 10), taskLineCount,
        `header advertises ${announced[1]} external slot(s) but body dispatches ${taskLineCount}`
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── ADVERSARIAL: pure-helper boundary invariants (no subprocess) ─────────────
// ══════════════════════════════════════════════════════════════════════════════

const nfPrompt = require('./nf-prompt.js');

// ADV-PARSE-N-BOUNDARY: parseQuorumSizeFlag must never yield 0, negative, or a
// value from a malformed/space-less flag. Only `--n <space> <digits≥1>` is valid;
// everything else is null (→ caller falls back to risk-driven fan-out). A regression
// that returned 0 or -1 here would feed externalSlotCap = -1 → over/under-dispatch.
test('ADV-PARSE-N-BOUNDARY: parseQuorumSizeFlag rejects 0/neg/malformed, accepts valid, first-match wins', () => {
  const p = nfPrompt.parseQuorumSizeFlag;
  // invalid → null
  for (const bad of ['--n -1', '--n 0', '--n0', '--n abc', '--n', 'no flag here', '--n  ', '--nn 3']) {
    assert.strictEqual(p(bad), null, `"${bad}" must parse to null (invalid/absent)`);
  }
  // valid → integer ≥ 1
  assert.strictEqual(p('/qnf:plan-phase --n 3'), 3, '"--n 3" → 3');
  assert.strictEqual(p('--n 999'), 999, '"--n 999" → 999 (clamped downstream by min(risk,N))');
  assert.strictEqual(p('foo --n 2 bar'), 2, 'flag may appear mid-prompt');
  // first match wins (consistent, deterministic)
  assert.strictEqual(p('--n 2 --n 5'), 2, 'first --n wins (deterministic)');
});

// ADV-RISK-CLAMP-INVARIANT: mapRiskLevelToCount must ALWAYS return an integer in
// [1..maxSize] for every reachable (risk, maxSize) pair — never 0, never > maxSize.
// Also pins the fail-open contract: unknown/missing risk → full pool (maxSize).
test('ADV-RISK-CLAMP-INVARIANT: mapRiskLevelToCount stays within [1..maxSize] and fails open to maxSize', () => {
  const map = nfPrompt.mapRiskLevelToCount;
  const risks = ['low', 'routine', 'medium', 'high', 'unknown', '', null, undefined, 'HIGH'];
  for (let maxSize = 1; maxSize <= 6; maxSize++) {
    for (const r of risks) {
      const c = map(r, maxSize);
      assert.ok(Number.isInteger(c), `count must be integer (risk=${r}, maxSize=${maxSize}) → ${c}`);
      assert.ok(c >= 1, `count must be ≥ 1 (risk=${r}, maxSize=${maxSize}) → ${c}`);
      assert.ok(c <= maxSize, `count must be ≤ maxSize=${maxSize} (risk=${r}) → ${c}`);
    }
    // Fail-open: anything that is not a recognized low/routine/medium tier → full pool.
    for (const failOpen of ['high', 'unknown', '', null, undefined, 'HIGH', 'LOW']) {
      assert.strictEqual(
        map(failOpen, maxSize), maxSize,
        `unrecognized/absent risk "${failOpen}" must fail open to maxSize=${maxSize} (conservative)`
      );
    }
    // Tiered reductions match the documented formula.
    assert.strictEqual(map('routine', maxSize), Math.max(1, Math.ceil(maxSize / 3)), 'routine = ceil(n/3) clamped');
    assert.strictEqual(map('medium', maxSize), Math.max(1, Math.ceil(2 * maxSize / 3)), 'medium = ceil(2n/3) clamped');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── ADVERSARIAL ROUND 2: SOLO-BOUNDARY / FAN-OUT MATRIX (post-SC-4-fix) ────────
// ══════════════════════════════════════════════════════════════════════════════
//
// Round 1 routed a 0-external budget (externalSlotCap <= 0) to SOLO MODE. These
// probes verify the fix did NOT over-reach: a cap of EXACTLY 1 external must still
// dispatch 1 slot-worker (not get swallowed by the `<= 0` guard), the whole
// (maxSize × risk × --n) matrix dispatches max(0, fanOutCount-1) externals, and the
// non-solo SC-4 restore + corrupt-state fail-open paths stay coherent.

// Helper: write a project nf.json roster, run the hook, return the injected context.
function _fanoutCtx(slots, quorumCfg, prompt, contextYaml, extra) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-adv-fo-'));
  spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
  const claudeDir = path.join(tempDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const agent_config = {};
  for (const s of slots) agent_config[s] = { auth_type: 'api' }; // no model → never model-dedup
  fs.writeFileSync(
    path.join(claudeDir, 'nf.json'),
    JSON.stringify(Object.assign({ quorum_active: slots, quorum: quorumCfg, agent_config }, extra || {})),
    'utf8'
  );
  try {
    const payload = { prompt, cwd: tempDir };
    if (contextYaml) payload.context_yaml = contextYaml;
    const { stdout, exitCode } = runHook(payload);
    assert.strictEqual(exitCode, 0, 'hook must exit 0');
    const parsed = JSON.parse(stdout);
    return parsed.hookSpecificOutput.additionalContext;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
function _countTaskLines(ctx) {
  return (ctx.match(/\d+\. Task\(subagent_type="nf-quorum-slot-worker"/g) || []).length;
}

// ADV-FANOUT-CAP1-NOT-SWALLOWED (CRITICAL REGRESSION on the solo boundary):
// externalSlotCap === 1 (fanOutCount === 2) sits one step above the `<= 0` solo
// guard. It MUST still dispatch exactly 1 external slot-worker — NOT be swallowed
// into solo mode and NOT escalate to 0/2. maxSize=2 + risk medium → ceil(4/3)=2 →
// cap 1. Contrast: maxSize=2 + routine → ceil(2/3)=1 → solo (0). If the `<= 0`
// guard ever became `< 1`-on-fanOut or `<= 1`, the 1-external case would vanish.
test('ADV-FANOUT-CAP1-NOT-SWALLOWED: externalSlotCap===1 dispatches exactly 1 external (not solo, not 0/2)', () => {
  // medium → fanOutCount 2 → 1 external. Must be a real QUORUM block, not solo.
  const medium = _fanoutCtx(['codex-1', 'gemini-1'], { maxSize: 2 }, '/qnf:plan-phase', 'risk_level: medium\n');
  assert.ok(!/NF_SOLO_MODE|SOLO MODE/.test(medium), 'cap===1 must NOT degrade to solo mode');
  assert.ok(/QUORUM REQUIRED/.test(medium), 'cap===1 must emit a QUORUM REQUIRED block');
  assert.strictEqual(
    _countTaskLines(medium), 1,
    'maxSize=2 + medium (cap===1) must dispatch EXACTLY 1 external slot-worker (the `<= 0` guard must not swallow the 1-external case)'
  );
  // routine → fanOutCount 1 → solo (the contrast boundary).
  const routine = _fanoutCtx(['codex-1', 'gemini-1'], { maxSize: 2 }, '/qnf:plan-phase', 'risk_level: routine\n');
  assert.match(routine, /NF_SOLO_MODE|SOLO MODE/, 'maxSize=2 + routine (fanOut 1) must be solo');
  assert.strictEqual(_countTaskLines(routine), 0, 'maxSize=2 + routine must dispatch 0 externals');
});

// ADV-FANOUT-MATRIX-INVARIANT: across maxSize × risk × --n, dispatched external
// Task lines == max(0, fanOutCount-1), solo-mode iff fanOutCount===1, and the count
// never exceeds maxSize-1 nor the roster size. model_routing_enabled:false isolates
// pure fan-out math from tier-based slot filtering. A single off-by-one in the
// externalSlotCap slice, the `<= 0` guard, or mapRiskLevelToCount fails a cell here.
test('ADV-FANOUT-MATRIX-INVARIANT: dispatched externals == max(0, fanOutCount-1), solo iff fanOut===1', () => {
  const ROSTER = ['codex-1', 'gemini-1', 'opencode-1', 'copilot-1', 'claude-1']; // 5 distinct
  const ceil = Math.ceil;
  const riskCount = (risk, n) => {
    if (risk === 'routine' || risk === 'low') return Math.max(1, ceil(n / 3));
    if (risk === 'medium') return Math.max(1, ceil(2 * n / 3));
    return n; // high / absent → full pool
  };
  // [maxSize, risk(null=absent), nOverride(null=none)]
  const cells = [
    [1, null, null],   // fanOut 1 → solo
    [2, 'routine', null], // 1 → solo
    [2, 'medium', null],  // 2 → 1 ext
    [2, 'high', null],    // 2 → 1 ext
    [3, 'routine', null], // 1 → solo
    [3, 'medium', null],  // 2 → 1 ext
    [3, 'high', null],    // 3 → 2 ext
    [3, null, null],      // absent → 3 → 2 ext
    [5, 'routine', null], // ceil(5/3)=2 → 1 ext
    [5, 'medium', null],  // ceil(10/3)=4 → 3 ext
    [5, 'high', null],    // 5 → 4 ext
    [3, 'high', 99],      // min(3,99)=3 → 2 ext (override is a cap, not a floor)
    [5, 'high', 2],       // min(5,2)=2 → 1 ext (override caps below risk)
  ];
  for (const [maxSize, risk, nOverride] of cells) {
    const riskDriven = riskCount(risk, maxSize);
    const fanOut = nOverride !== null ? Math.min(riskDriven, nOverride) : riskDriven;
    const expectedExt = Math.max(0, fanOut - 1);
    const prompt = nOverride !== null ? `/qnf:plan-phase --n ${nOverride}` : '/qnf:plan-phase';
    const ctx = _fanoutCtx(
      ROSTER, { maxSize },
      prompt,
      risk ? `risk_level: ${risk}\n` : null,
      { model_routing_enabled: false }
    );
    const got = _countTaskLines(ctx);
    const label = `maxSize=${maxSize} risk=${risk || 'absent'} --n=${nOverride || 'none'} (fanOut=${fanOut})`;
    assert.strictEqual(got, expectedExt, `${label}: expected ${expectedExt} external Task lines, got ${got}`);
    assert.ok(got <= maxSize - 1, `${label}: dispatched ${got} exceeds maxSize-1=${maxSize - 1}`);
    assert.ok(got <= ROSTER.length, `${label}: dispatched ${got} exceeds roster size`);
    if (fanOut === 1) {
      assert.match(ctx, /NF_SOLO_MODE|SOLO MODE/, `${label}: fanOut===1 must be solo mode`);
    } else {
      assert.ok(!/NF_SOLO_MODE|SOLO MODE/.test(ctx), `${label}: fanOut>1 must NOT be solo mode`);
      assert.ok(/QUORUM REQUIRED/.test(ctx), `${label}: fanOut>1 must emit QUORUM REQUIRED`);
    }
  }
});

// ADV-FANOUT-N-OVERRIDE-INTERACTION: --n interacts with risk as a MAX cap.
//   --n 1 on a high-risk task → still solo (the cap wins; early --n 1 branch).
//   --n 5 with maxSize=3 high → capped at maxSize → 2 externals (NOT 4), and the
//   announced "Claude + N external" count equals the dispatched Task lines.
test('ADV-FANOUT-N-OVERRIDE-INTERACTION: --n caps but never inflates; header count matches body', () => {
  // --n 1 beats a high-risk escalation → solo, 0 externals.
  const solo = _fanoutCtx(['codex-1', 'gemini-1', 'opencode-1'], { maxSize: 3 },
    '/qnf:plan-phase --n 1', 'risk_level: high\n', { model_routing_enabled: false });
  assert.match(solo, /NF_SOLO_MODE|SOLO MODE/, '--n 1 must force solo even on high risk (cap wins)');
  assert.strictEqual(_countTaskLines(solo), 0, '--n 1 must dispatch 0 externals regardless of risk');

  // --n 5 with maxSize=3 high → min(3,5)=3 → 2 externals, capped at maxSize, not 4.
  const capped = _fanoutCtx(['codex-1', 'gemini-1', 'opencode-1', 'copilot-1', 'claude-1'], { maxSize: 3 },
    '/qnf:plan-phase --n 5', 'risk_level: high\n', { model_routing_enabled: false });
  assert.ok(!/NF_SOLO_MODE|SOLO MODE/.test(capped), '--n 5 high must not be solo');
  assert.strictEqual(
    _countTaskLines(capped), 2,
    '--n 5 with maxSize=3 must cap at maxSize → 2 externals (NOT 4 from --n 5)'
  );
  // Header count must equal body count (no over/under announcement).
  const announced = capped.match(/(\d+)\s+external\s+slot/);
  assert.ok(announced, 'header must announce an external slot count');
  assert.strictEqual(parseInt(announced[1], 10), 2, `header announces ${announced && announced[1]} but body dispatches 2`);
});

// ADV-FANOUT-SC4-RESTORE-CONSISTENCY: on the NON-solo path (externalSlotCap > 0),
// when the recently-failed filter empties cappedSlots, SC-4 restores exactly 1 slot.
// The round-1 change kept SC-4 gated behind `externalSlotCap > 0`, so it must STILL
// restore here — and the announced "N external slot" header must equal the 1
// dispatched Task line (no NEW header/body contradiction introduced by the fix).
// maxSize=3 + medium → fanOut 2 → cap 1 → header advertises "1 external slot".
test('ADV-FANOUT-SC4-RESTORE-CONSISTENCY: cap>0 all-filtered → SC-4 restores 1, header matches body', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-adv-sc4-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({
        quorum_active: ['codex-1', 'gemini-1'],
        quorum: { maxSize: 3 },
        model_routing_enabled: false,
        agent_config: { 'codex-1': { auth_type: 'api' }, 'gemini-1': { auth_type: 'api' } },
      }),
      'utf8'
    );
    // Mark BOTH slots as failed < 5min ago so the recent-failure filter empties cappedSlots.
    const planningDir = path.join(tempDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    const nowIso = new Date().toISOString();
    fs.writeFileSync(
      path.join(planningDir, 'quorum-failures.json'),
      JSON.stringify([
        { slot: 'codex-1', error_type: 'TIMEOUT', pattern: 'x', last_seen: nowIso },
        { slot: 'gemini-1', error_type: 'AUTH', pattern: 'y', last_seen: nowIso },
      ]),
      'utf8'
    );
    const { stdout, exitCode } = runHook({ prompt: '/qnf:plan-phase', cwd: tempDir, context_yaml: 'risk_level: medium\n' });
    assert.strictEqual(exitCode, 0, 'exit 0');
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    // externalSlotCap=1 > 0 → solo guard must NOT engage; SC-4 restores 1.
    assert.ok(!/NF_SOLO_MODE|SOLO MODE/.test(ctx), 'cap>0 must not degrade to solo even when all slots are filtered');
    const taskLines = _countTaskLines(ctx);
    assert.strictEqual(taskLines, 1, 'SC-4 must restore exactly 1 slot when cap>0 and all slots filtered');
    const announced = ctx.match(/(\d+)\s+external\s+slot/);
    assert.ok(announced, 'medium fan-out header must announce an external slot count');
    assert.strictEqual(
      parseInt(announced[1], 10), taskLines,
      `header advertises ${announced && announced[1]} external slot(s) but body dispatches ${taskLines} (round-1 fix must not introduce a contradiction)`
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ADV-FANOUT-CORRUPT-STATE-FAILOPEN: corrupt scoreboard + corrupt failures file must
// never crash dispatch. On the now-reachable SOLO path (maxSize=1) the hook still
// injects NF_SOLO_MODE; on the NON-solo cap===1 path it still dispatches exactly 1
// external. Both must yield exit 0 and pure JSON (fail-open contract).
test('ADV-FANOUT-CORRUPT-STATE-FAILOPEN: corrupt scoreboard/failures → no crash, solo+non-solo both coherent', () => {
  const mk = (maxSize) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-adv-corrupt-'));
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({
        quorum_active: ['codex-1', 'gemini-1'],
        quorum: { maxSize },
        model_routing_enabled: false,
        agent_config: { 'codex-1': { auth_type: 'api' }, 'gemini-1': { auth_type: 'api' } },
      }),
      'utf8'
    );
    const planningDir = path.join(tempDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'quorum-scoreboard.json'), '{{{ not json', 'utf8');
    fs.writeFileSync(path.join(planningDir, 'quorum-failures.json'), 'NOPE not json either', 'utf8');
    return tempDir;
  };

  // Solo path: maxSize=1 → externalSlotCap=0 → solo, despite corrupt state.
  const soloDir = mk(1);
  try {
    const { stdout, exitCode } = runHook({ prompt: '/qnf:plan-phase', cwd: soloDir });
    assert.strictEqual(exitCode, 0, 'solo path: corrupt state must fail open (exit 0)');
    const parsed = JSON.parse(stdout); // must be pure JSON — no crash spew on stdout
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.match(ctx, /NF_SOLO_MODE|SOLO MODE/, 'solo path must still inject solo marker under corrupt state');
    assert.strictEqual(_countTaskLines(ctx), 0, 'solo path dispatches 0 externals under corrupt state');
  } finally {
    fs.rmSync(soloDir, { recursive: true, force: true });
  }

  // Non-solo path: maxSize=2 + medium → cap 1 → 1 external, despite corrupt state.
  const dispatchDir = mk(2);
  try {
    const { stdout, exitCode } = runHook({ prompt: '/qnf:plan-phase', cwd: dispatchDir, context_yaml: 'risk_level: medium\n' });
    assert.strictEqual(exitCode, 0, 'non-solo path: corrupt state must fail open (exit 0)');
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.ok(!/NF_SOLO_MODE|SOLO MODE/.test(ctx), 'non-solo cap=1 must dispatch, not degrade to solo, under corrupt state');
    assert.strictEqual(_countTaskLines(ctx), 1, 'non-solo cap=1 must still dispatch exactly 1 external under corrupt state');
  } finally {
    fs.rmSync(dispatchDir, { recursive: true, force: true });
  }
});

// ADV-NO-FALSE-INJECTION: a NON-command prompt that merely MENTIONS a planning
// command mid-sentence (prose / not at start) must be a silent pass — exit 0, no
// stdout — even with quorum_active configured. The anchored allowlist requires the
// command at the start (after optional whitespace); prose-leading must not trigger
// a spurious QUORUM REQUIRED injection.
test('ADV-NO-FALSE-INJECTION: prose mentioning /nf:plan-phase mid-sentence does not trigger quorum', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-adv-noinj-'));
  try {
    spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ quorum_active: ['codex-1', 'gemini-1'] }),
      'utf8'
    );
    const { stdout, exitCode } = runHook({
      prompt: 'Should I run /nf:plan-phase now or wait until the refactor lands?',
      cwd: tempDir,
    });
    assert.strictEqual(exitCode, 0, 'exit 0');
    assert.strictEqual(
      stdout, '',
      'prose mentioning the command (not at prompt start) must NOT inject quorum (no false trigger)'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── ADVERSARIAL ROUND 3: exported-helper shape/type guards (no subprocess) ─────
// ══════════════════════════════════════════════════════════════════════════════

// ADV-DEDUP-NULL-PROVIDER: a corrupt providers.json shape ({"providers":[null,...]})
// flows verbatim through findProviders() into deduplicateByModel. A null/non-object
// element must be skipped (treated as unknown provider), not crash — otherwise the
// throw propagates to the stdin-handler catch and the entire QUORUM REQUIRED
// injection is silently dropped.
test('ADV-DEDUP-NULL-PROVIDER: deduplicateByModel tolerates null/non-object entries in providersList', () => {
  const dedup = nfPrompt.deduplicateByModel;
  const slots = [{ slot: 'codex-1', authType: 'api' }, { slot: 'gemini-1', authType: 'api' }];
  // Corrupt providers.json shape: a null element (and a non-object) in the providers array.
  const badProviders = [null, 42, { name: 'gemini-1', model: 'gemini-2.5' }];
  assert.doesNotThrow(
    () => dedup(slots, {}, badProviders),
    'a null/non-object entry in providersList must not crash deduplicateByModel'
  );
  const res = dedup(slots, {}, badProviders);
  assert.deepEqual(res.unique.map(s => s.slot), ['codex-1', 'gemini-1'], 'both distinct slots survive as unique');
  assert.deepEqual(res.duplicates, [], 'no duplicates when models differ/unknown');
});

// ADV-PARSE-N-NONSTRING: parseQuorumSizeFlag is an exported helper called directly.
// A non-string argument (null/undefined/number/object/array/bool) must return the
// null sentinel (invalid/absent) rather than throwing on .match — consistent with
// every other invalid case, so the caller falls back to risk-driven fan-out.
test('ADV-PARSE-N-NONSTRING: parseQuorumSizeFlag returns null on non-string input (no crash)', () => {
  const p = nfPrompt.parseQuorumSizeFlag;
  for (const bad of [null, undefined, 42, {}, [], true]) {
    assert.doesNotThrow(() => p(bad), `parseQuorumSizeFlag(${String(bad)}) must not throw`);
    assert.strictEqual(p(bad), null, `non-string input ${String(bad)} must yield null (invalid/absent)`);
  }
  // sanity: valid string path unchanged
  assert.strictEqual(p('/qnf:plan-phase --n 3'), 3);
});

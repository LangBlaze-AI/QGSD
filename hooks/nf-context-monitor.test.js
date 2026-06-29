#!/usr/bin/env node
// Test suite for hooks/nf-context-monitor.js
// Uses Node.js built-in test runner: node --test hooks/nf-context-monitor.test.js
//
// Spawns the hook as a child process with mock stdin JSON payloads.
// Verifies threshold logic, additionalContext injection, and fail-open behavior.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK_PATH = path.join(__dirname, 'nf-context-monitor.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = path.join(os.tmpdir(), 'nf-cm-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runHook(payload, cwd) {
  const result = spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify(payload),
    cwd: cwd || os.tmpdir(),
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
    parsed: (() => { try { return JSON.parse(result.stdout); } catch { return null; } })(),
  };
}

function writeNfConfig(dir, config) {
  const claudeDir = path.join(dir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'nf.json'), JSON.stringify(config), 'utf8');
}

// ─── Below-threshold tests ────────────────────────────────────────────────────

test('below warn threshold: exits 0 with no stdout', () => {
  const { exitCode, stdout } = runHook({
    tool_name: 'Bash',
    context_window: { remaining_percentage: 40 }, // used = 60%, below default 70%
    cwd: os.tmpdir(),
  });
  assert.equal(exitCode, 0);
  assert.equal(stdout, '', 'No output when below threshold');
});

test('exactly at warn boundary (used = 70%): emits WARNING', () => {
  const { exitCode, parsed } = runHook({
    tool_name: 'Bash',
    context_window: { remaining_percentage: 30 }, // used = 70%
    cwd: os.tmpdir(),
  });
  assert.equal(exitCode, 0);
  assert.ok(parsed, 'should emit JSON');
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes('WARNING'));
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes('70%'));
});

test('above warn threshold (used = 80%): emits WARNING message', () => {
  const { exitCode, parsed } = runHook({
    tool_name: 'Bash',
    context_window: { remaining_percentage: 20 }, // used = 80%
    cwd: os.tmpdir(),
  });
  assert.equal(exitCode, 0);
  assert.ok(parsed);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('WARNING'), 'Should be WARNING not CRITICAL at 80%');
  assert.ok(!ctx.includes('CRITICAL'), 'Should not be CRITICAL at 80%');
  assert.ok(ctx.includes('/nf:pause-work'), 'Should mention pause-work');
});

// ─── Critical threshold tests ─────────────────────────────────────────────────

test('at critical threshold (used = 90%): emits CRITICAL message', () => {
  const { exitCode, parsed } = runHook({
    tool_name: 'Bash',
    context_window: { remaining_percentage: 10 }, // used = 90%
    cwd: os.tmpdir(),
  });
  assert.equal(exitCode, 0);
  assert.ok(parsed);
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('CRITICAL'), 'Should be CRITICAL at 90%');
  assert.ok(ctx.includes('STOP'), 'Should instruct to stop');
});

test('above critical threshold (used = 95%): emits CRITICAL', () => {
  const { exitCode, parsed } = runHook({
    tool_name: 'Bash',
    context_window: { remaining_percentage: 5 }, // used = 95%
    cwd: os.tmpdir(),
  });
  assert.equal(exitCode, 0);
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('CRITICAL'));
  assert.ok(ctx.includes('95%'));
});

// ─── Fail-open tests ──────────────────────────────────────────────────────────

test('missing context_window field: exits 0, no output', () => {
  const { exitCode, stdout } = runHook({ tool_name: 'Read', cwd: os.tmpdir() });
  assert.equal(exitCode, 0);
  assert.equal(stdout, '');
});

test('null remaining_percentage: exits 0, no output', () => {
  const { exitCode, stdout } = runHook({
    tool_name: 'Bash',
    context_window: { remaining_percentage: null },
    cwd: os.tmpdir(),
  });
  assert.equal(exitCode, 0);
  assert.equal(stdout, '');
});

test('invalid JSON stdin: exits 0 (fail-open)', () => {
  const result = spawnSync('node', [HOOK_PATH], {
    input: 'not json {{{',
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0);
});

test('empty stdin: exits 0 (fail-open)', () => {
  const result = spawnSync('node', [HOOK_PATH], {
    input: '',
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0);
});

// ─── Custom threshold tests ───────────────────────────────────────────────────

test('custom warn_pct=50 in config: warns at 55% used', () => {
  const tmpDir = makeTmpDir();
  writeNfConfig(tmpDir, { context_monitor: { warn_pct: 50, critical_pct: 90 } });

  const { parsed } = runHook({
    tool_name: 'Bash',
    context_window: { remaining_percentage: 45 }, // used = 55%
    cwd: tmpDir,
  });
  assert.ok(parsed, 'Should emit output with custom lower threshold');
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes('WARNING'));
});

test('custom critical_pct=80 in config: CRITICAL at 85% used', () => {
  const tmpDir = makeTmpDir();
  writeNfConfig(tmpDir, { context_monitor: { warn_pct: 70, critical_pct: 80 } });

  const { parsed } = runHook({
    tool_name: 'Bash',
    context_window: { remaining_percentage: 15 }, // used = 85%
    cwd: tmpDir,
  });
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes('CRITICAL'));
});

test('custom thresholds: below custom warn_pct=80 → no output', () => {
  const tmpDir = makeTmpDir();
  writeNfConfig(tmpDir, { context_monitor: { warn_pct: 80, critical_pct: 95 } });

  const { stdout } = runHook({
    tool_name: 'Bash',
    context_window: { remaining_percentage: 25 }, // used = 75%, below custom 80%
    cwd: tmpDir,
  });
  assert.equal(stdout, '', 'No output when below custom threshold');
});

// ─── Budget warning tests ────────────────────────────────────────────────────

test('budget warning injected at 60% budget', () => {
  const tmpDir = makeTmpDir();
  writeNfConfig(tmpDir, { budget: { session_limit_tokens: 200000, warn_pct: 60, downgrade_pct: 85 } });

  const { parsed } = runHook({
    tool_name: 'Bash',
    context_window: { remaining_percentage: 40 }, // used = 60% => 120000 tokens => 60% of 200K budget
    cwd: tmpDir,
  });
  assert.ok(parsed, 'Should emit output with budget warning');
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes('BUDGET WARNING'));
});

test('budget downgrade message at 85% budget', () => {
  const tmpDir = makeTmpDir();
  writeNfConfig(tmpDir, { budget: { session_limit_tokens: 200000, warn_pct: 60, downgrade_pct: 85 } });
  // Create .planning/config.json for downgrade
  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({ model_profile: 'quality' }), 'utf8');

  const { parsed } = runHook({
    tool_name: 'Bash',
    context_window: { remaining_percentage: 15 }, // used = 85% => 170000 tokens => 85% of 200K budget
    cwd: tmpDir,
  });
  assert.ok(parsed, 'Should emit output with budget alert');
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes('BUDGET ALERT'));
});

test('no budget message when disabled', () => {
  const tmpDir = makeTmpDir();
  writeNfConfig(tmpDir, { budget: { session_limit_tokens: null }, context_monitor: { warn_pct: 99, critical_pct: 100 } });

  const { stdout } = runHook({
    tool_name: 'Bash',
    context_window: { remaining_percentage: 15 }, // used = 85% but budget disabled
    cwd: tmpDir,
  });
  // With warn_pct=99, no context warning, and budget disabled => no output
  assert.equal(stdout, '', 'No output when budget disabled');
});

// ─── Smart compact tests ─────────────────────────────────────────────────────

test('smart compact suggestion at phase_complete boundary', () => {
  const tmpDir = makeTmpDir();
  writeNfConfig(tmpDir, { smart_compact: { enabled: true, context_warn_pct: 60 }, context_monitor: { warn_pct: 99, critical_pct: 100 } });

  const { parsed } = runHook({
    context_window: { remaining_percentage: 35 }, // used = 65%
    tool_name: 'Bash',
    tool_input: { command: 'node nf-tools.cjs phase-complete v0.28-03' },
    cwd: tmpDir,
  });
  assert.ok(parsed, 'Should emit output');
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('SMART COMPACT SUGGESTION'));
  assert.ok(ctx.includes('phase_complete'));
  assert.ok(ctx.includes('What survives'));
  assert.ok(ctx.includes('What will be lost'));
});

test('no smart compact when below threshold', () => {
  const tmpDir = makeTmpDir();
  writeNfConfig(tmpDir, { smart_compact: { enabled: true, context_warn_pct: 60 }, context_monitor: { warn_pct: 99, critical_pct: 100 } });

  const { stdout } = runHook({
    context_window: { remaining_percentage: 75 }, // used = 25%, below compact threshold
    tool_name: 'Bash',
    tool_input: { command: 'node nf-tools.cjs phase-complete v0.28-03' },
    cwd: tmpDir,
  });
  assert.equal(stdout, '', 'No output when below compact threshold');
});

test('no smart compact when disabled', () => {
  const tmpDir = makeTmpDir();
  writeNfConfig(tmpDir, { smart_compact: { enabled: false }, context_monitor: { warn_pct: 99, critical_pct: 100 } });

  const { stdout } = runHook({
    context_window: { remaining_percentage: 35 }, // used = 65%
    tool_name: 'Bash',
    tool_input: { command: 'node nf-tools.cjs phase-complete v0.28-03' },
    cwd: tmpDir,
  });
  assert.equal(stdout, '', 'No output when smart compact disabled');
});

test('no smart compact at non-boundary tool call', () => {
  const tmpDir = makeTmpDir();
  writeNfConfig(tmpDir, { smart_compact: { enabled: true, context_warn_pct: 60 }, context_monitor: { warn_pct: 99, critical_pct: 100 } });

  const { stdout } = runHook({
    context_window: { remaining_percentage: 35 }, // used = 65%
    tool_name: 'Read',
    cwd: tmpDir,
  });
  assert.equal(stdout, '', 'No output at non-boundary tool call');
});

// ─── Wave barrier and plan_complete boundary tests ─────────────────────────

test('smart compact at wave_barrier boundary', () => {
  const tmpDir = makeTmpDir();
  writeNfConfig(tmpDir, { smart_compact: { enabled: true, context_warn_pct: 60 }, smart_compact_threshold_pct: 65, context_monitor: { warn_pct: 99, critical_pct: 100 } });

  const { parsed } = runHook({
    context_window: { remaining_percentage: 30 }, // used = 70%
    tool_name: 'Bash',
    tool_input: { command: 'node execute-plan.js --wave 2' },
    cwd: tmpDir,
  });
  assert.ok(parsed, 'Should emit output');
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('SMART COMPACT SUGGESTION'));
  assert.ok(ctx.includes('wave_barrier'));
});

test('smart compact at plan_complete boundary (nf-tools.cjs SUMMARY)', () => {
  const tmpDir = makeTmpDir();
  writeNfConfig(tmpDir, { smart_compact: { enabled: true, context_warn_pct: 60 }, smart_compact_threshold_pct: 65, context_monitor: { warn_pct: 99, critical_pct: 100 } });

  const { parsed } = runHook({
    context_window: { remaining_percentage: 30 }, // used = 70%
    tool_name: 'Bash',
    tool_input: { command: 'node nf-tools.cjs commit "docs: SUMMARY.md"' },
    cwd: tmpDir,
  });
  assert.ok(parsed, 'Should emit output');
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('SMART COMPACT SUGGESTION'));
  assert.ok(ctx.includes('plan_complete'));
});

// ─── Quorum-in-progress lockout tests ────────────────────────────────────────

test('compaction suppressed when quorum-in-progress flag exists', () => {
  const tmpDir = makeTmpDir();
  writeNfConfig(tmpDir, { smart_compact: { enabled: true, context_warn_pct: 60 }, smart_compact_threshold_pct: 65, context_monitor: { warn_pct: 99, critical_pct: 100 } });
  // Create quorum-in-progress flag
  const claudeDir = path.join(tmpDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'quorum-in-progress'), '', 'utf8');

  const { stdout } = runHook({
    context_window: { remaining_percentage: 30 }, // used = 70%, above threshold
    tool_name: 'Bash',
    tool_input: { command: 'node nf-tools.cjs phase-complete v0.28-03' },
    cwd: tmpDir,
  });
  assert.equal(stdout, '', 'No output when quorum is in progress');
});

// ─── 65% threshold from config tests ─────────────────────────────────────────

test('compaction triggers at 65% threshold from smart_compact_threshold_pct config', () => {
  const tmpDir = makeTmpDir();
  writeNfConfig(tmpDir, { smart_compact: { enabled: true, context_warn_pct: 60 }, smart_compact_threshold_pct: 65, context_monitor: { warn_pct: 99, critical_pct: 100 } });

  const { parsed } = runHook({
    context_window: { remaining_percentage: 35 }, // used = 65%, exactly at threshold
    tool_name: 'Bash',
    tool_input: { command: 'node nf-tools.cjs phase-complete v0.28-03' },
    cwd: tmpDir,
  });
  assert.ok(parsed, 'Should emit output at 65% threshold');
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('SMART COMPACT SUGGESTION'));
  assert.ok(ctx.includes('threshold: 65%'));
});

test('no compaction below 65% threshold', () => {
  const tmpDir = makeTmpDir();
  writeNfConfig(tmpDir, { smart_compact: { enabled: true, context_warn_pct: 60 }, smart_compact_threshold_pct: 65, context_monitor: { warn_pct: 99, critical_pct: 100 } });

  const { stdout } = runHook({
    context_window: { remaining_percentage: 36 }, // used = 64%, below 65% threshold
    tool_name: 'Bash',
    tool_input: { command: 'node nf-tools.cjs phase-complete v0.28-03' },
    cwd: tmpDir,
  });
  assert.equal(stdout, '', 'No output below 65% threshold');
});

// ─── Budget downgrade cooldown integration test ──────────────────────────────

test('budget downgrade skipped when cooldown is active', () => {
  const tmpDir = makeTmpDir();
  writeNfConfig(tmpDir, { budget: { session_limit_tokens: 200000, warn_pct: 60, downgrade_pct: 85 }, context_monitor: { warn_pct: 99, critical_pct: 100 } });
  // Create .planning/config.json with recent downgrade_history
  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({
    model_profile: 'quality',
    downgrade_history: [{ ts: new Date().toISOString(), from: 'balanced', to: 'budget' }],
  }), 'utf8');

  const { parsed } = runHook({
    tool_name: 'Bash',
    context_window: { remaining_percentage: 15 }, // used = 85% => triggers downgrade threshold
    cwd: tmpDir,
  });
  // With cooldown active, shouldDowngrade should be false, but shouldWarn may still fire
  if (parsed) {
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.ok(!ctx.includes('BUDGET ALERT'), 'Should NOT show BUDGET ALERT when cooldown is active');
  }
  // Also verify config was NOT modified (no downgrade happened)
  const cfg = JSON.parse(fs.readFileSync(path.join(planningDir, 'config.json'), 'utf8'));
  assert.equal(cfg.model_profile, 'quality', 'Profile should not change during cooldown');
});

test('double loadConfig bug is fixed: hook runs without error', () => {
  const { exitCode } = runHook({
    tool_name: 'Bash',
    context_window: { remaining_percentage: 50 },
    cwd: os.tmpdir(),
  });
  assert.equal(exitCode, 0, 'Hook should exit cleanly (double const config bug fixed)');
});

// --- Continuous verification tests ---

test('verification: hook does not crash on Write tool with verification enabled', () => {
  const tmpDir = makeTmpDir();
  writeNfConfig(tmpDir, { continuous_verify_enabled: true, context_monitor: { warn_pct: 99, critical_pct: 100 } });

  // Create continuous-verify.json state
  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'continuous-verify.json'), JSON.stringify({
    version: 1, phase: 'test', max_runs: 3, runs_used: 0,
    timeout_ms: 5000, accumulated_files: [], last_run: null, runs: [],
  }), 'utf8');

  const { exitCode } = runHook({
    context_window: { remaining_percentage: 90 },
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/foo.test.js' },
    cwd: tmpDir,
  });
  assert.equal(exitCode, 0, 'Hook exits 0 with verification enabled on Write tool');
});

test('verification: skipped when budget exhausted', () => {
  const tmpDir = makeTmpDir();
  writeNfConfig(tmpDir, { continuous_verify_enabled: true, context_monitor: { warn_pct: 99, critical_pct: 100 } });

  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'continuous-verify.json'), JSON.stringify({
    version: 1, phase: 'test', max_runs: 3, runs_used: 3,
    timeout_ms: 5000, accumulated_files: [], last_run: null, runs: [],
  }), 'utf8');

  const { exitCode, stdout } = runHook({
    context_window: { remaining_percentage: 90 },
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/foo.test.js' },
    cwd: tmpDir,
  });
  assert.equal(exitCode, 0);
  assert.ok(!stdout.includes('VERIFICATION'), 'No VERIFICATION when budget exhausted');
});

test('verification: skipped when disabled via config', () => {
  const tmpDir = makeTmpDir();
  writeNfConfig(tmpDir, { continuous_verify_enabled: false, context_monitor: { warn_pct: 99, critical_pct: 100 } });

  const { exitCode, stdout } = runHook({
    context_window: { remaining_percentage: 90 },
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/foo.test.js' },
    cwd: tmpDir,
  });
  assert.equal(exitCode, 0);
  assert.ok(!stdout.includes('VERIFICATION'), 'No VERIFICATION when disabled');
});

test('verification: skipped for non-write tools', () => {
  const tmpDir = makeTmpDir();
  writeNfConfig(tmpDir, { continuous_verify_enabled: true, context_monitor: { warn_pct: 99, critical_pct: 100 } });

  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'continuous-verify.json'), JSON.stringify({
    version: 1, phase: 'test', max_runs: 3, runs_used: 0,
    timeout_ms: 5000, accumulated_files: [], last_run: null, runs: [],
  }), 'utf8');

  const { exitCode, stdout } = runHook({
    context_window: { remaining_percentage: 90 },
    tool_name: 'Read',
    cwd: tmpDir,
  });
  assert.equal(exitCode, 0);
  assert.ok(!stdout.includes('VERIFICATION'), 'No VERIFICATION for Read tool');
});

test('verification: fail-open when continuous-verify.cjs not loadable (implicit)', () => {
  // When running in tmpdir without the module, the dual-path require returns null
  // and verification is skipped. This test verifies the hook still exits 0.
  const { exitCode } = runHook({
    tool_name: 'Write',
    context_window: { remaining_percentage: 90 },
    tool_input: { file_path: '/tmp/foo.test.js' },
    cwd: os.tmpdir(),
  });
  assert.equal(exitCode, 0, 'Hook exits 0 even when continuous-verify not loadable');
});

// ─── Non-string command type-coercion (ncm-1) ────────────────────────────────

test('non-string tool_input.command does not suppress CRITICAL context warning', () => {
  const tmpDir = makeTmpDir();
  // Default thresholds (critical 90, compact 65) so both branches engage.
  const { exitCode, parsed } = runHook({
    tool_name: 'Bash',
    context_window: { remaining_percentage: 5 }, // used = 95%, CRITICAL
    tool_input: { command: 12345 }, // adversarial non-string command
    cwd: tmpDir,
  });
  assert.equal(exitCode, 0);
  assert.ok(parsed, 'CRITICAL warning must still be emitted despite non-string command');
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('CRITICAL'), 'Should still emit CRITICAL context warning');
  assert.ok(!ctx.includes('SMART COMPACT'), 'Smart compact correctly skipped for non-string command');
});

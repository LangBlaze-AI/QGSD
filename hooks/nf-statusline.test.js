#!/usr/bin/env node
// Test suite for hooks/nf-statusline.js
// Uses Node.js built-in test runner: node --test hooks/nf-statusline.test.js
//
// Each test spawns the hook as a child process with mock stdin (JSON payload).
// Captures stdout + exit code. The hook reads JSON from stdin and writes
// formatted statusline text to stdout.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK_PATH = path.join(__dirname, 'nf-statusline.js');

// Helper: run the hook with a given stdin JSON payload and optional extra env vars
function runHook(stdinPayload, extraEnv) {
  const input = typeof stdinPayload === 'string'
    ? stdinPayload
    : JSON.stringify(stdinPayload);

  const result = spawnSync('node', [HOOK_PATH], {
    input,
    encoding: 'utf8',
    timeout: 5000,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
  };
}

// Helper: create a temp directory structure, write a file inside it, return tempDir
function makeTempDir(suffix) {
  const dir = path.join(os.tmpdir(), `nf-sl-test-${Date.now()}-${suffix}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// --- Test Cases ---

// TC1: Minimal payload — stdout contains model name and directory basename
test('TC1: minimal payload includes model name and directory name', () => {
  const { stdout, exitCode } = runHook({
    model: { display_name: 'TestModel' },
    workspace: { current_dir: '/tmp/myproject' },
  });
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  assert.ok(stdout.includes('TestModel'), 'stdout must include model name "TestModel"');
  assert.ok(stdout.includes('myproject'), 'stdout must include directory basename "myproject"');
});

// TC2: Context at 100% remaining (0% used) → green bar, 0%
// rawUsed = 100 - 100 = 0; scaled = round(0 / 80 * 100) = 0; filled = 0 → all empty blocks
test('TC2: context at 100% remaining shows all-empty bar at 0%', () => {
  const { stdout, exitCode } = runHook({
    model: { display_name: 'M' },
    context_window: { remaining_percentage: 100 },
  });
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  assert.ok(stdout.includes('░░░░░░░░░░'), 'stdout must include all-empty bar (0% used)');
  assert.ok(stdout.includes('0%'), 'stdout must include 0%');
});

// TC2b: 85% remaining (15% used) with no current_usage and unknown tier → percentage-only display (no token label)
test('TC2b: 15% used without tier shows percentage-only (no token label)', () => {
  const { stdout, exitCode } = runHook({
    model: { display_name: 'M' },
    context_window: { remaining_percentage: 85 },
  });
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  assert.ok(stdout.includes('15%'), 'stdout must include 15%');
  assert.ok(!stdout.match(/\d+K\)/), 'stdout must NOT include token labels like 150K)');
  assert.ok(stdout.includes('\x1b[32m'), 'stdout must include green ANSI code (15% used < 30%)');
});

// TC3: 80% used (20% remaining) with 400K tokens → blinking red (>350K) for 1M context
test('TC3: 80% used with 400K tokens shows blinking red', () => {
  const { stdout, exitCode } = runHook({
    model: { display_name: 'M (with 1M context)' },
    context_window: { remaining_percentage: 20, current_usage: { input_tokens: 400000 } },
  });
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  assert.ok(stdout.includes('80%'), 'stdout must include 80%');
  assert.ok(stdout.includes('400K'), 'stdout must include token count 400K');
  assert.ok(stdout.includes('\x1b[5;31m'), 'stdout must include blinking red ANSI code');
});

// TC4: 49% used (51% remaining) with 50K tokens → green (<100K) for 1M context
test('TC4: 49% used with 50K tokens shows green', () => {
  const { stdout, exitCode } = runHook({
    model: { display_name: 'M (with 1M context)' },
    context_window: { remaining_percentage: 51, current_usage: { input_tokens: 50000 } },
  });
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  assert.ok(stdout.includes('49%'), 'stdout must include 49%');
  assert.ok(stdout.includes('50K'), 'stdout must include token count 50K');
  assert.ok(stdout.includes('\x1b[32m'), 'stdout must include green ANSI code \\x1b[32m');
});

// TC5: 64% used (36% remaining) with 150K tokens → yellow (100K-200K) for 1M context
test('TC5: 64% used with 150K tokens shows yellow', () => {
  const { stdout, exitCode } = runHook({
    model: { display_name: 'M (with 1M context)' },
    context_window: { remaining_percentage: 36, current_usage: { input_tokens: 150000 } },
  });
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  assert.ok(stdout.includes('64%'), 'stdout must include 64%');
  assert.ok(stdout.includes('150K'), 'stdout must include token count 150K');
  assert.ok(stdout.includes('\x1b[33m'), 'stdout must include yellow ANSI code \\x1b[33m');
});

// TC6: Malformed JSON input → exits 0, stdout is empty (silent fail)
test('TC6: malformed JSON input exits 0 with empty stdout (silent fail)', () => {
  const { stdout, exitCode } = runHook('this is not valid json');
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  assert.strictEqual(stdout, '', 'stdout must be empty on malformed JSON input');
});

// TC7: Update available — output includes '/nf:update'
test('TC7: update available banner shows /nf:update in output', () => {
  const tempHome = makeTempDir('tc7');
  const cacheDir = path.join(tempHome, '.claude', 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, 'nf-update-check.json');
  fs.writeFileSync(cacheFile, JSON.stringify({ update_available: true, latest: '1.0.1' }), 'utf8');

  try {
    const { stdout, exitCode } = runHook(
      { model: { display_name: 'M' } },
      { HOME: tempHome }
    );
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.includes('/nf:update'), 'stdout must include /nf:update when update is available');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// TC8: Task in progress — output includes the task's activeForm text
test('TC8: in-progress task is shown in statusline output', () => {
  const tempHome = makeTempDir('tc8');
  const todosDir = path.join(tempHome, '.claude', 'todos');
  fs.mkdirSync(todosDir, { recursive: true });

  const sessionId = 'sess123';
  const todosFile = path.join(todosDir, `${sessionId}-agent-0.json`);
  fs.writeFileSync(
    todosFile,
    JSON.stringify([{ status: 'in_progress', activeForm: 'Fix the thing' }]),
    'utf8'
  );

  try {
    const { stdout, exitCode } = runHook(
      { model: { display_name: 'M' }, session_id: sessionId },
      { HOME: tempHome }
    );
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.includes('Fix the thing'), 'stdout must include the in-progress task activeForm text');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// TC9: "200K context detected from display_name scales thresholds correctly"
test('TC9: 200K context detected from display_name scales thresholds correctly', () => {
  const { stdout, exitCode } = runHook({
    model: { display_name: 'Opus 4.6 (200K context)' },
    context_window: { remaining_percentage: 85 },
  });
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  // 15% used of 200K = 30K estimated tokens
  // 30K is above t1 (20K) but below t2 (40K) → YELLOW
  assert.ok(stdout.includes('15%'), 'stdout must include 15%');
  assert.ok(stdout.includes('30K'), 'stdout must include estimated 30K tokens');
  assert.ok(stdout.includes('\x1b[33m'), 'stdout must include yellow ANSI code');
});

// TC10: "1M context detected from display_name preserves existing thresholds"
test('TC10: 1M context detected from display_name preserves existing thresholds', () => {
  const { stdout, exitCode } = runHook({
    model: { display_name: 'Opus 4.6 (with 1M context)' },
    context_window: { remaining_percentage: 85 },
  });
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  // 15% used of 1M = 150K estimated tokens → YELLOW (same as old TC2b)
  assert.ok(stdout.includes('15%'), 'stdout must include 15%');
  assert.ok(stdout.includes('150K'), 'stdout must include estimated 150K tokens');
  assert.ok(stdout.includes('\x1b[33m'), 'stdout must include yellow ANSI code');
});

// TC11: "explicit context_window_size takes priority over display_name"
test('TC11: explicit context_window_size takes priority over display_name', () => {
  const { stdout, exitCode } = runHook({
    model: { display_name: 'Opus 4.6 (with 1M context)' },
    context_window: { remaining_percentage: 85, context_window_size: 200000 },
  });
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  // 15% used of 200K = 30K → YELLOW
  assert.ok(stdout.includes('15%'), 'stdout must include 15%');
  assert.ok(stdout.includes('30K'), 'stdout must include 30K (NOT 150K — proving explicit size wins)');
  assert.ok(stdout.includes('\x1b[33m'), 'stdout must include yellow ANSI code');
});

// TC12: "unknown context tier with no current_usage shows percentage-only (no token label)"
test('TC12: unknown context tier with no current_usage shows percentage-only (no token label)', () => {
  const { stdout, exitCode } = runHook({
    model: { display_name: 'SomeModel' },
    context_window: { remaining_percentage: 85 },
  });
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  // No context_window_size, no tier in display_name, no current_usage → tokenLabel is null
  assert.ok(stdout.includes('15%'), 'stdout must include 15%');
  assert.ok(!stdout.match(/\d+K\)/), 'stdout must NOT include token labels like 150K)');
});

// TC13: "200K session with actual token usage uses real tokens for color"
test('TC13: 200K session with actual token usage uses real tokens for color', () => {
  const { stdout, exitCode } = runHook({
    model: { display_name: 'Opus 4.6 (200K context)' },
    context_window: { remaining_percentage: 50, context_window_size: 200000, current_usage: { input_tokens: 80000 } },
  });
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  // 80K tokens with 200K context → above t3 (70K) → BLINKING RED
  assert.ok(stdout.includes('80K'), 'stdout must include 80K tokens');
  assert.ok(stdout.includes('\x1b[5;31m'), 'stdout must include blinking red ANSI code');
});

// TC14: "200K session with 15K tokens shows green (below 20K threshold)"
test('TC14: 200K session with 15K tokens shows green (below 20K threshold)', () => {
  const { stdout, exitCode } = runHook({
    model: { display_name: 'Opus 4.6 (200K context)' },
    context_window: { remaining_percentage: 90, current_usage: { input_tokens: 15000 } },
  });
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  // 15K tokens with 200K context → below t1 (20K) → GREEN
  assert.ok(stdout.includes('15K'), 'stdout must include 15K tokens');
  assert.ok(stdout.includes('\x1b[32m'), 'stdout must include green ANSI code');
});

// --- Bandit (JS Q-learning) Phase Indicator Tests ---

// TC15: Q-Learn exploring — arm with visits below minExplore
test('TC15: Q-Learn exploring when arm visits below minExplore', () => {
  const tempDir = makeTempDir('tc15');
  const stateFile = path.join(tempDir, '.nf-river-state.json');
  const nowIso = new Date().toISOString();
  fs.writeFileSync(stateFile, JSON.stringify({
    qTable: {
      implement: {
        'codex-1': { q: 0.5, visits: 5, lastUpdate: nowIso },
        'gemini-1': { q: 0.3, visits: 2, lastUpdate: nowIso },
      },
    },
  }), 'utf8');

  try {
    const { stdout, exitCode } = runHook({
      model: { display_name: 'M' },
      workspace: { current_dir: tempDir },
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.includes('● Q-Learn'), 'stdout must include "● Q-Learn"');
    assert.ok(stdout.includes('\x1b[36m'), 'stdout must include cyan ANSI code');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC16: Q-Learn active — all arms above minExplore
test('TC16: Q-Learn active when all arms above minExplore', () => {
  const tempDir = makeTempDir('tc16');
  const stateFile = path.join(tempDir, '.nf-river-state.json');
  const nowIso = new Date().toISOString();
  fs.writeFileSync(stateFile, JSON.stringify({
    qTable: {
      implement: {
        'codex-1': { q: 0.8, visits: 25, lastUpdate: nowIso },
        'gemini-1': { q: 0.6, visits: 30, lastUpdate: nowIso },
      },
    },
  }), 'utf8');

  try {
    const { stdout, exitCode } = runHook({
      model: { display_name: 'M' },
      workspace: { current_dir: tempDir },
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.includes('● Q-Learn'), 'stdout must include "● Q-Learn"');
    assert.ok(stdout.includes('\x1b[32m'), 'stdout must include green ANSI code');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC16b: Q-Learn has visits but learned long ago → idle ·, NOT active ● (recency fix)
test('TC16b: stale Q-Learn (old lastUpdate) shows idle, not active', () => {
  const tempDir = makeTempDir('tc16b');
  const stateFile = path.join(tempDir, '.nf-river-state.json');
  const oldIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
  fs.writeFileSync(stateFile, JSON.stringify({
    qTable: { implement: { 'codex-1': { q: 0.8, visits: 25, lastUpdate: oldIso } } },
  }), 'utf8');
  try {
    const { stdout, exitCode } = runHook({ model: { display_name: 'M' }, workspace: { current_dir: tempDir } });
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('· Q-Learn'), `stale Q-Learn must show idle ·; got: ${JSON.stringify(stdout)}`);
    assert.ok(!stdout.includes('● Q-Learn'), `stale Q-Learn must NOT show active ●; got: ${JSON.stringify(stdout)}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC17: No state file — idle Q-Learn indicator (tools line shows dim · Q-Learn)
test('TC17: No state file shows idle Q-Learn (no active indicator form)', () => {
  const tempDir = makeTempDir('tc17');

  try {
    const { stdout, exitCode } = runHook({
      model: { display_name: 'M' },
      workspace: { current_dir: tempDir },
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    // stdout must NOT include 'Q-Learn:' shadow form — tools line shows dim · Q-Learn not ● Q-Learn
    assert.ok(!stdout.includes('Q-Learn:'), 'stdout must NOT include "Q-Learn:"');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC18: Malformed state file — idle Q-Learn indicator (fail-open fallback)
test('TC18: Malformed state file shows idle Q-Learn (fail-open fallback)', () => {
  const tempDir = makeTempDir('tc18');
  // Write malformed state file
  const stateFile = path.join(tempDir, '.nf-river-state.json');
  fs.writeFileSync(stateFile, 'not valid json', 'utf8');

  try {
    const { stdout, exitCode } = runHook({
      model: { display_name: 'M' },
      workspace: { current_dir: tempDir },
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(!stdout.includes('Q-Learn:'), 'stdout must NOT include "Q-Learn:"');
    assert.ok(stdout.includes('Q-Learn'), 'stdout must include Q-Learn as fail-open fallback');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC19: Mixed task types — one exploring, one active
test('TC19: Mixed task types shows exploring when any arm below minExplore', () => {
  const tempDir = makeTempDir('tc19');
  const stateFile = path.join(tempDir, '.nf-river-state.json');
  const nowIso = new Date().toISOString();
  fs.writeFileSync(stateFile, JSON.stringify({
    qTable: {
      implement: {
        'codex-1': { q: 0.8, visits: 25, lastUpdate: nowIso },
        'gemini-1': { q: 0.6, visits: 30, lastUpdate: nowIso },
      },
      review: {
        'codex-1': { q: 0.1, visits: 3, lastUpdate: nowIso },
      },
    },
  }), 'utf8');

  try {
    const { stdout, exitCode } = runHook({
      model: { display_name: 'M' },
      workspace: { current_dir: tempDir },
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.includes('● Q-Learn'), 'stdout must include "● Q-Learn"');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC20: Empty qTable — no Q-Learn indicator
test('TC20: Empty qTable produces no Q-Learn indicator', () => {
  const tempDir = makeTempDir('tc20');
  const stateFile = path.join(tempDir, '.nf-river-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ qTable: {} }), 'utf8');

  try {
    const { stdout, exitCode } = runHook({
      model: { display_name: 'M' },
      workspace: { current_dir: tempDir },
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(!stdout.includes('Q-Learn:'), 'stdout must NOT include "Q-Learn:"');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// --- Shadow Recommendation Display Tests ---

// TC21: Shadow recommendation displayed when lastShadow present
test('TC21: Shadow recommendation displayed when lastShadow present', () => {
  const tempDir = makeTempDir('tc21');
  const stateFile = path.join(tempDir, '.nf-river-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    qTable: {
      implement: {
        'codex-1': { q: 0.8, visits: 25, lastUpdate: new Date().toISOString() },
        'gemini-1': { q: 0.6, visits: 30, lastUpdate: new Date().toISOString() },
      },
    },
    lastShadow: {
      recommendation: 'gemini-1',
      confidence: 0.85,
      taskType: 'implement',
    },
  }), 'utf8');

  try {
    const { stdout, exitCode } = runHook({
      model: { display_name: 'M' },
      workspace: { current_dir: tempDir },
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.includes('● Q-Learn: gemini-1'), 'stdout must include "● Q-Learn: gemini-1"');
    assert.ok(stdout.includes('\x1b[33m'), 'stdout must include yellow ANSI code');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC21b: stale shadow recommendation (old timestamp) must NOT render the shadow
// form — an old lastShadow lingering in state file should not keep River green.
test('TC21b: stale shadow (old timestamp) does not show shadow recommendation', () => {
  const tempDir = makeTempDir('tc21b');
  const stateFile = path.join(tempDir, '.nf-river-state.json');
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
  fs.writeFileSync(stateFile, JSON.stringify({
    qTable: {
      implement: {
        'codex-1': { q: 0.8, visits: 25, lastUpdate: old },
        'gemini-1': { q: 0.6, visits: 30, lastUpdate: old },
      },
    },
    lastShadow: {
      recommendation: 'gemini-1',
      confidence: 0.85,
      taskType: 'implement',
      timestamp: old,
    },
  }), 'utf8');

  try {
    const { stdout, exitCode } = runHook({
      model: { display_name: 'M' },
      workspace: { current_dir: tempDir },
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(!stdout.includes('Q-Learn: gemini-1'), 'stale shadow must NOT render "Q-Learn: gemini-1"');
    assert.ok(stdout.includes('· Q-Learn'), 'stale state shows idle · Q-Learn');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC22: No shadow — falls back to Q-Learn: active
test('TC22: No shadow falls back to Q-Learn: active', () => {
  const tempDir = makeTempDir('tc22');
  const stateFile = path.join(tempDir, '.nf-river-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    qTable: {
      implement: {
        'codex-1': { q: 0.8, visits: 25, lastUpdate: new Date().toISOString() },
        'gemini-1': { q: 0.6, visits: 30, lastUpdate: new Date().toISOString() },
      },
    },
  }), 'utf8');

  try {
    const { stdout, exitCode } = runHook({
      model: { display_name: 'M' },
      workspace: { current_dir: tempDir },
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.includes('● Q-Learn'), 'stdout must include "● Q-Learn" (not shadow)');
    assert.ok(!stdout.includes('shadow'), 'stdout must NOT include "shadow"');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC23: Shadow with empty recommendation falls back to normal indicator
test('TC23: Shadow with null recommendation falls back to normal indicator', () => {
  const tempDir = makeTempDir('tc23');
  const stateFile = path.join(tempDir, '.nf-river-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    qTable: {
      implement: {
        'codex-1': { q: 0.8, visits: 25, lastUpdate: new Date().toISOString() },
        'gemini-1': { q: 0.6, visits: 30, lastUpdate: new Date().toISOString() },
      },
    },
    lastShadow: { recommendation: null },
  }), 'utf8');

  try {
    const { stdout, exitCode } = runHook({
      model: { display_name: 'M' },
      workspace: { current_dir: tempDir },
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.includes('● Q-Learn'),
      'stdout must include "● Q-Learn" (not shadow)');
    assert.ok(!stdout.includes('shadow'), 'stdout must NOT include "shadow"');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// --- Tools Status Second Line Tests ---

// TC24: coderlm binary absent → dim · coderlm (not installed, always shown)
test('TC24: coderlm binary absent shows dim not-installed indicator', () => {
  const tempHome = makeTempDir('tc24');
  const tempDir = makeTempDir('tc24-dir');
  // Do NOT create ~/.claude/nf-bin/coderlm — binary absent
  try {
    const { stdout, exitCode } = runHook(
      { model: { display_name: 'M' }, workspace: { current_dir: tempDir } },
      { HOME: tempHome }
    );
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.includes('coderlm'), 'stdout must include coderlm (always shown)');
    assert.ok(stdout.includes('\x1b[2m· coderlm\x1b[0m'), 'stdout must show dim · coderlm when not installed');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC25: coderlm binary present but no PID file → ○ coderlm (idle)
test('TC25: coderlm binary present but no PID → hollow idle indicator', () => {
  const tempHome = makeTempDir('tc25');
  const tempDir = makeTempDir('tc25-dir');
  const binDir = path.join(tempHome, '.claude', 'nf-bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'coderlm'), '#!/bin/sh\n', 'utf8');
  // No .pid file → not alive
  try {
    const { stdout, exitCode } = runHook(
      { model: { display_name: 'M' }, workspace: { current_dir: tempDir } },
      { HOME: tempHome }
    );
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.includes('coderlm'), 'stdout must include coderlm when binary present');
    assert.ok(stdout.includes('○ coderlm'), 'stdout must show hollow ○ coderlm when idle');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC27: coderlm binary present AND PID alive → bright green ● coderlm
test('TC27: coderlm binary present with alive PID shows green active indicator', () => {
  const tempHome = makeTempDir('tc27');
  const tempDir = makeTempDir('tc27-dir');
  const binDir = path.join(tempHome, '.claude', 'nf-bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'coderlm'), '#!/bin/sh\n', 'utf8');
  // Use current process PID — guaranteed alive
  fs.writeFileSync(path.join(binDir, 'coderlm.pid'), String(process.pid), 'utf8');
  try {
    const { stdout, exitCode } = runHook(
      { model: { display_name: 'M' }, workspace: { current_dir: tempDir } },
      { HOME: tempHome }
    );
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.includes('\x1b[32m● coderlm\x1b[0m'), 'stdout must include green active coderlm indicator');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC26: embed package present, no cache → ○ embed (idle)
test('TC26: embed package present shows hollow idle indicator', () => {
  const tempHome = makeTempDir('tc26-home');
  const tempDir = makeTempDir('tc26-dir');
  // Install transformers stub in the correct nf-bin location
  const pkgDir = path.join(tempHome, '.claude', 'nf-bin', 'node_modules', '@huggingface', 'transformers');
  fs.mkdirSync(pkgDir, { recursive: true });
  // No embedding-cache.json → idle (not active)
  try {
    const { stdout, exitCode } = runHook(
      { model: { display_name: 'M' }, workspace: { current_dir: tempDir } },
      { HOME: tempHome }
    );
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.includes('embed'), 'stdout must include embed when package present');
    assert.ok(stdout.includes('○ embed'), 'stdout must show hollow ○ embed when idle');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// --- Quorum Slots Line Tests (added in PR #141 follow-up — issue from CodeRabbit on #141) ---
//
// buildSlotsLine reads three files (all under HOME) and renders one glyph per provider:
//   ~/.claude/nf-bin/providers.json  — the configured-slot inventory (required)
//   ~/.claude.json                    — mcpServers (which slots are MCP-registered)
//   ~/.claude/nf/slot-health.json    — cached probe results (optional; staleness-aware)
//
// Glyph rules:
//   · dim    — listed in providers.json but NOT registered as MCP server
//   ○ normal — registered, but no fresh probe data (cache missing or > 5min stale)
//   ● green  — recent probe OK
//   ⊘ red    — recent probe FAILED
//
// Helper: lay down all three files for a slot scenario.
function setupSlotsHome(suffix, opts) {
  const tempHome = makeTempDir(suffix);
  const providersDir = path.join(tempHome, '.claude', 'nf-bin');
  fs.mkdirSync(providersDir, { recursive: true });
  fs.writeFileSync(path.join(providersDir, 'providers.json'),
    JSON.stringify({ providers: opts.providers || [] }), 'utf8');
  if (opts.mcpServers !== undefined) {
    fs.writeFileSync(path.join(tempHome, '.claude.json'),
      JSON.stringify({ mcpServers: opts.mcpServers }), 'utf8');
  }
  if (opts.health !== undefined) {
    const nfDir = path.join(tempHome, '.claude', 'nf');
    fs.mkdirSync(nfDir, { recursive: true });
    fs.writeFileSync(path.join(nfDir, 'slot-health.json'),
      JSON.stringify(opts.health), 'utf8');
  }
  return tempHome;
}

// TC30: provider in providers.json but NOT in mcpServers → dim · indicator
test('TC30: provider not in mcpServers → dim · indicator', () => {
  const tempHome = setupSlotsHome('tc30', {
    providers: [{ name: 'codex-1' }],
    mcpServers: {}, // not registered
  });
  const tempDir = makeTempDir('tc30-dir');
  try {
    const { stdout, exitCode } = runHook(
      { model: { display_name: 'M' }, workspace: { current_dir: tempDir } },
      { HOME: tempHome }
    );
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('\x1b[2m· codex-1\x1b[0m'),
      `stdout must include dim · codex-1 when not in mcpServers; got: ${JSON.stringify(stdout)}`);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC31: registered + recent OK probe → green ●
test('TC31: registered + recent OK probe → green ● indicator', () => {
  const tempHome = setupSlotsHome('tc31', {
    providers: [{ name: 'claude-1' }],
    mcpServers: { 'claude-1': { command: 'node' } },
    health: {
      checked_at: new Date().toISOString(), // fresh
      slots: { 'claude-1': { ok: true, latency_ms: 100 } },
    },
  });
  const tempDir = makeTempDir('tc31-dir');
  try {
    const { stdout, exitCode } = runHook(
      { model: { display_name: 'M' }, workspace: { current_dir: tempDir } },
      { HOME: tempHome }
    );
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('\x1b[32m● claude-1\x1b[0m'),
      `stdout must include green ● claude-1 when recent probe OK; got: ${JSON.stringify(stdout)}`);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC32: registered + recent FAILED probe → red ⊘
test('TC32: registered + recent failed probe → red ⊘ indicator', () => {
  const tempHome = setupSlotsHome('tc32', {
    providers: [{ name: 'gemini-1' }],
    mcpServers: { 'gemini-1': { command: 'node' } },
    health: {
      checked_at: new Date().toISOString(), // fresh
      slots: { 'gemini-1': { ok: false, latency_ms: 5000, error: 'timeout' } },
    },
  });
  const tempDir = makeTempDir('tc32-dir');
  try {
    const { stdout, exitCode } = runHook(
      { model: { display_name: 'M' }, workspace: { current_dir: tempDir } },
      { HOME: tempHome }
    );
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('\x1b[31m⊘ gemini-1\x1b[0m'),
      `stdout must include red ⊘ gemini-1 when recent probe failed; got: ${JSON.stringify(stdout)}`);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC33: registered, but no slot-health cache → hollow ○ (no fresh data)
test('TC33: registered + no health cache → hollow ○ indicator', () => {
  const tempHome = setupSlotsHome('tc33', {
    providers: [{ name: 'opencode-1' }],
    mcpServers: { 'opencode-1': { command: 'node' } },
    // no health file
  });
  const tempDir = makeTempDir('tc33-dir');
  try {
    const { stdout, exitCode } = runHook(
      { model: { display_name: 'M' }, workspace: { current_dir: tempDir } },
      { HOME: tempHome }
    );
    assert.strictEqual(exitCode, 0);
    // ○ has no color escape on either side — match the bare token followed by reset
    assert.ok(/○ opencode-1\x1b\[0m/.test(stdout),
      `stdout must include hollow ○ opencode-1 when no fresh health data; got: ${JSON.stringify(stdout)}`);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC34: registered + STALE probe (older than 5min) → hollow ○
test('TC34: registered + stale (>5min) probe → hollow ○ indicator', () => {
  const stale = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6 min ago
  const tempHome = setupSlotsHome('tc34', {
    providers: [{ name: 'copilot-1' }],
    mcpServers: { 'copilot-1': { command: 'node' } },
    health: { checked_at: stale, slots: { 'copilot-1': { ok: true, latency_ms: 100 } } },
  });
  const tempDir = makeTempDir('tc34-dir');
  try {
    const { stdout, exitCode } = runHook(
      { model: { display_name: 'M' }, workspace: { current_dir: tempDir } },
      { HOME: tempHome }
    );
    assert.strictEqual(exitCode, 0);
    assert.ok(/○ copilot-1\x1b\[0m/.test(stdout),
      `stdout must show hollow ○ for stale probe (>5min); got: ${JSON.stringify(stdout)}`);
    // It must NOT be green (the OK state is stale, so don't trust it)
    assert.ok(!stdout.includes('\x1b[32m● copilot-1\x1b[0m'),
      'stale OK probe must NOT render green');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC35: providers.json absent entirely → no slots line emitted (skips silently)
test('TC35: providers.json absent → no slots line', () => {
  const tempHome = makeTempDir('tc35');
  // intentionally do NOT create providers.json
  fs.mkdirSync(path.join(tempHome, '.claude'), { recursive: true });
  const tempDir = makeTempDir('tc35-dir');
  try {
    const { stdout, exitCode } = runHook(
      { model: { display_name: 'M' }, workspace: { current_dir: tempDir } },
      { HOME: tempHome }
    );
    assert.strictEqual(exitCode, 0);
    // No slot tokens (·, ●, ⊘, ○) should appear before the existing tools-line indicators.
    // Tools line still renders coderlm/Q-Learn/embed — that's fine.
    // The slots line is preceded/followed by the same separator as tools line (\x1b[2m│\x1b[0m).
    // Strategy: check that the FIRST line after the main statusline doesn't have any slot glyphs
    // alongside tool glyphs (slot indicators include actual slot names, never "coderlm"/"River"/"embed").
    const lines = stdout.split('\n').filter(l => l.length > 0);
    // Last line should be the tools line. Everything else is the main line. No middle slots line.
    const hasSlotsLine = lines.some(l => /[·●⊘○] [a-z]+-\d+/.test(l) && !l.includes('coderlm'));
    assert.ok(!hasSlotsLine, 'no slots line should be emitted when providers.json is absent');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC36: multiple providers preserve declaration order (statusline reads .providers array as-is)
test('TC36: slots line preserves providers.json declaration order', () => {
  const tempHome = setupSlotsHome('tc36', {
    providers: [{ name: 'codex-1' }, { name: 'gemini-1' }, { name: 'claude-1' }],
    mcpServers: {
      'codex-1': { command: 'node' },
      'gemini-1': { command: 'node' },
      'claude-1': { command: 'node' },
    },
    health: {
      checked_at: new Date().toISOString(),
      slots: {
        'codex-1': { ok: true, latency_ms: 80 },
        'gemini-1': { ok: true, latency_ms: 90 },
        'claude-1': { ok: true, latency_ms: 100 },
      },
    },
  });
  const tempDir = makeTempDir('tc36-dir');
  try {
    const { stdout, exitCode } = runHook(
      { model: { display_name: 'M' }, workspace: { current_dir: tempDir } },
      { HOME: tempHome }
    );
    assert.strictEqual(exitCode, 0);
    // Expect order: codex-1 → gemini-1 → claude-1 (not alphabetical)
    const codexIdx = stdout.indexOf('codex-1');
    const geminiIdx = stdout.indexOf('gemini-1');
    const claudeIdx = stdout.indexOf('claude-1');
    assert.ok(codexIdx >= 0 && geminiIdx >= 0 && claudeIdx >= 0, 'all three slots must render');
    assert.ok(codexIdx < geminiIdx && geminiIdx < claudeIdx,
      `slots must render in providers.json declaration order, got indices [codex=${codexIdx}, gemini=${geminiIdx}, claude=${claudeIdx}]`);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC37: malformed slot-health.json → fail-open (treat as no fresh data)
test('TC37: malformed slot-health.json falls back to ○ (fail-open)', () => {
  const tempHome = setupSlotsHome('tc37', {
    providers: [{ name: 'claude-1' }],
    mcpServers: { 'claude-1': { command: 'node' } },
  });
  // Corrupt the health file
  const nfDir = path.join(tempHome, '.claude', 'nf');
  fs.mkdirSync(nfDir, { recursive: true });
  fs.writeFileSync(path.join(nfDir, 'slot-health.json'), 'not json {{{', 'utf8');
  const tempDir = makeTempDir('tc37-dir');
  try {
    const { stdout, exitCode } = runHook(
      { model: { display_name: 'M' }, workspace: { current_dir: tempDir } },
      { HOME: tempHome }
    );
    assert.strictEqual(exitCode, 0, 'malformed cache must NOT crash the statusline (fail-open)');
    assert.ok(/○ claude-1\x1b\[0m/.test(stdout),
      `malformed cache must render ○ (no fresh data); got: ${JSON.stringify(stdout)}`);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC38: tools (coderlm/Q-Learn/embed) now render on LINE 1 (visible even on short
// terminals); the per-slot quorum detail moved to line 2 below them.
test('TC38: tools render on line 1, per-slot quorum detail on line 2 below', () => {
  const tempHome = setupSlotsHome('tc38', {
    providers: [{ name: 'codex-1' }],
    mcpServers: { 'codex-1': { command: 'node' } },
    health: {
      checked_at: new Date().toISOString(),
      slots: { 'codex-1': { ok: true, latency_ms: 100 } },
    },
  });
  const tempDir = makeTempDir('tc38-dir');
  try {
    const { stdout, exitCode } = runHook(
      { model: { display_name: 'M' }, workspace: { current_dir: tempDir } },
      { HOME: tempHome }
    );
    assert.strictEqual(exitCode, 0);
    const lines = stdout.split('\n');
    assert.ok(lines[0].includes('coderlm'), `tools must be on line 1; got line1=${JSON.stringify(lines[0])}`);
    assert.ok((lines[1] || '').includes('codex-1'), `per-slot detail must be on line 2; got line2=${JSON.stringify(lines[1])}`);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ── Line-1 compact quorum indicator (buildQuorumSummary) ────────────────────
// Reuses setupSlotsHome(); the indicator is the LAST element of stdout line 1.
function line1(stdout) { return (stdout.split('\n')[0] || ''); }
const qsFreshIso = () => new Date(Date.now() - 1000).toISOString();
const qsStaleIso = () => new Date(Date.now() - 10 * 60 * 1000).toISOString();

test('QS1: all MCP slots healthy + fresh -> green N dot quorum on line 1', () => {
  const tempHome = setupSlotsHome('qs1', {
    providers: [{ name: 'codex-1' }, { name: 'gemini-1' }, { name: 'claude-1' }],
    mcpServers: { 'codex-1': {}, 'gemini-1': {}, 'claude-1': {} },
    health: { checked_at: qsFreshIso(), slots: { 'codex-1': { ok: true }, 'gemini-1': { ok: true }, 'claude-1': { ok: true } } },
  });
  const tempDir = makeTempDir('qs1-dir');
  try {
    const { stdout, exitCode } = runHook({ model: { display_name: 'M' }, workspace: { current_dir: tempDir } }, { HOME: tempHome });
    assert.strictEqual(exitCode, 0);
    assert.ok(line1(stdout).includes('\x1b[32m3● quorum\x1b[0m'), `expected green 3 dot quorum; got: ${JSON.stringify(line1(stdout))}`);
  } finally { fs.rmSync(tempHome, { recursive: true, force: true }); fs.rmSync(tempDir, { recursive: true, force: true }); }
});

test('QS2: exactly one slot down -> red count + /nf:mcp-restart <slot> CTA', () => {
  const tempHome = setupSlotsHome('qs2', {
    providers: [{ name: 'codex-1' }, { name: 'gemini-1' }, { name: 'claude-1' }],
    mcpServers: { 'codex-1': {}, 'gemini-1': {}, 'claude-1': {} },
    health: { checked_at: qsFreshIso(), slots: { 'codex-1': { ok: true }, 'gemini-1': { ok: false }, 'claude-1': { ok: true } } },
  });
  const tempDir = makeTempDir('qs2-dir');
  try {
    const { stdout } = runHook({ model: { display_name: 'M' }, workspace: { current_dir: tempDir } }, { HOME: tempHome });
    assert.ok(line1(stdout).includes('\x1b[31m2/3⊘\x1b[0m'), `expected red 2/3 count; got: ${JSON.stringify(line1(stdout))}`);
    assert.ok(line1(stdout).includes('\x1b[33m/nf:mcp-restart gemini-1\x1b[0m'), `expected restart CTA for the single down slot; got: ${JSON.stringify(line1(stdout))}`);
  } finally { fs.rmSync(tempHome, { recursive: true, force: true }); fs.rmSync(tempDir, { recursive: true, force: true }); }
});

test('QS2b: multiple slots down -> /nf:mcp-repair CTA', () => {
  const tempHome = setupSlotsHome('qs2b', {
    providers: [{ name: 'codex-1' }, { name: 'gemini-1' }, { name: 'claude-1' }],
    mcpServers: { 'codex-1': {}, 'gemini-1': {}, 'claude-1': {} },
    health: { checked_at: qsFreshIso(), slots: { 'codex-1': { ok: true }, 'gemini-1': { ok: false }, 'claude-1': { ok: false } } },
  });
  const tempDir = makeTempDir('qs2b-dir');
  try {
    const { stdout } = runHook({ model: { display_name: 'M' }, workspace: { current_dir: tempDir } }, { HOME: tempHome });
    assert.ok(line1(stdout).includes('\x1b[31m1/3⊘\x1b[0m'), `expected red 1/3 count; got: ${JSON.stringify(line1(stdout))}`);
    assert.ok(line1(stdout).includes('\x1b[33m/nf:mcp-repair\x1b[0m'), `expected repair CTA for multiple down; got: ${JSON.stringify(line1(stdout))}`);
  } finally { fs.rmSync(tempHome, { recursive: true, force: true }); fs.rmSync(tempDir, { recursive: true, force: true }); }
});

test('QS3: stale cache -> dim N circle quorum', () => {
  const tempHome = setupSlotsHome('qs3', {
    providers: [{ name: 'codex-1' }, { name: 'gemini-1' }],
    mcpServers: { 'codex-1': {}, 'gemini-1': {} },
    health: { checked_at: qsStaleIso(), slots: { 'codex-1': { ok: true }, 'gemini-1': { ok: true } } },
  });
  const tempDir = makeTempDir('qs3-dir');
  try {
    const { stdout } = runHook({ model: { display_name: 'M' }, workspace: { current_dir: tempDir } }, { HOME: tempHome });
    assert.ok(line1(stdout).includes('2○ quorum'), `expected dim 2 circle quorum; got: ${JSON.stringify(line1(stdout))}`);
  } finally { fs.rmSync(tempHome, { recursive: true, force: true }); fs.rmSync(tempDir, { recursive: true, force: true }); }
});

test('QS4: missing cache -> dim N circle quorum (no crash)', () => {
  const tempHome = setupSlotsHome('qs4', {
    providers: [{ name: 'codex-1' }],
    mcpServers: { 'codex-1': {} },
  });
  const tempDir = makeTempDir('qs4-dir');
  try {
    const { stdout, exitCode } = runHook({ model: { display_name: 'M' }, workspace: { current_dir: tempDir } }, { HOME: tempHome });
    assert.strictEqual(exitCode, 0);
    assert.ok(line1(stdout).includes('1○ quorum'), `expected dim 1 circle quorum; got: ${JSON.stringify(line1(stdout))}`);
  } finally { fs.rmSync(tempHome, { recursive: true, force: true }); fs.rmSync(tempDir, { recursive: true, force: true }); }
});

test('QS5: null/invalid provider entries are dropped, not crashed (robustness)', () => {
  const tempHome = setupSlotsHome('qs5', {
    providers: [null, { name: 'codex-1' }, { foo: 'bar' }],
    mcpServers: { 'codex-1': {} },
    health: { checked_at: qsFreshIso(), slots: { 'codex-1': { ok: true } } },
  });
  const tempDir = makeTempDir('qs5-dir');
  try {
    const { stdout, exitCode } = runHook({ model: { display_name: 'M' }, workspace: { current_dir: tempDir } }, { HOME: tempHome });
    assert.strictEqual(exitCode, 0);
    assert.ok(line1(stdout).includes('\x1b[32m1● quorum\x1b[0m'), `expected green 1 dot quorum; got: ${JSON.stringify(line1(stdout))}`);
  } finally { fs.rmSync(tempHome, { recursive: true, force: true }); fs.rmSync(tempDir, { recursive: true, force: true }); }
});

// ── Background self-refresh (maybeRefreshSlotCache) ─────────────────────────
test('QS6: stale/missing cache + probe present -> creates throttle marker, throttled on 2nd render', () => {
  const tempHome = setupSlotsHome('qs6', {
    providers: [{ name: 'codex-1' }],
    mcpServers: { 'codex-1': {} },
    // no health file -> not fresh -> should kick a refresh
  });
  const hooksDir = path.join(tempHome, '.claude', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'nf-slot-health-probe.js'), 'process.exit(0)\n', 'utf8');
  const markerPath = path.join(tempHome, '.claude', 'nf', '.slot-probe-spawned');
  const tempDir = makeTempDir('qs6-dir');
  try {
    runHook({ model: { display_name: 'M' }, workspace: { current_dir: tempDir } }, { HOME: tempHome });
    assert.ok(fs.existsSync(markerPath), 'throttle marker must be created on stale/missing cache');
    const m1 = fs.statSync(markerPath).mtimeMs;
    runHook({ model: { display_name: 'M' }, workspace: { current_dir: tempDir } }, { HOME: tempHome });
    const m2 = fs.statSync(markerPath).mtimeMs;
    assert.strictEqual(m1, m2, 'marker must not be rewritten within the throttle window (no re-spawn)');
  } finally { fs.rmSync(tempHome, { recursive: true, force: true }); fs.rmSync(tempDir, { recursive: true, force: true }); }
});

test('QS7: no provider inventory -> no probe spawn / no marker (no churn)', () => {
  const tempHome = makeTempDir('qs7-home');
  const hooksDir = path.join(tempHome, '.claude', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'nf-slot-health-probe.js'), 'process.exit(0)\n', 'utf8');
  const markerPath = path.join(tempHome, '.claude', 'nf', '.slot-probe-spawned');
  const tempDir = makeTempDir('qs7-dir');
  try {
    const { exitCode } = runHook({ model: { display_name: 'M' }, workspace: { current_dir: tempDir } }, { HOME: tempHome });
    assert.strictEqual(exitCode, 0);
    assert.ok(!fs.existsSync(markerPath), 'no probe marker when there is no provider inventory (readSlotHealth null)');
  } finally { fs.rmSync(tempHome, { recursive: true, force: true }); fs.rmSync(tempDir, { recursive: true, force: true }); }
});

test('QS2c: fresh cache but a slot is MISSING its entry -> dim count, NO false repair CTA', () => {
  const tempHome = setupSlotsHome('qs2c', {
    providers: [{ name: 'codex-1' }, { name: 'gemini-1' }, { name: 'claude-1' }],
    mcpServers: { 'codex-1': {}, 'gemini-1': {}, 'claude-1': {} },
    // claude-1 added since last probe → no cache entry; codex-1/gemini-1 healthy. None FAILED.
    health: { checked_at: qsFreshIso(), slots: { 'codex-1': { ok: true }, 'gemini-1': { ok: true } } },
  });
  const tempDir = makeTempDir('qs2c-dir');
  try {
    const { stdout } = runHook({ model: { display_name: 'M' }, workspace: { current_dir: tempDir } }, { HOME: tempHome });
    assert.ok(line1(stdout).includes('2/3○ quorum'), `expected dim 2/3○ quorum (no failure); got: ${JSON.stringify(line1(stdout))}`);
    assert.ok(!line1(stdout).includes('/nf:mcp-repair') && !line1(stdout).includes('/nf:mcp-restart'),
      `must NOT show a repair/restart CTA when slots are merely unprobed; got: ${JSON.stringify(line1(stdout))}`);
  } finally { fs.rmSync(tempHome, { recursive: true, force: true }); fs.rmSync(tempDir, { recursive: true, force: true }); }
});

// SL-1: non-string model.display_name must not blank the whole statusline (fail-open contract)
test('SL-1: non-string model.display_name with context_window still renders (no blank statusline)', () => {
  const { stdout, exitCode } = runHook({
    model: { display_name: { nested: 'oops' } },
    workspace: { current_dir: '/tmp/projA' },
    context_window: { remaining_percentage: 50 },
  });
  assert.strictEqual(exitCode, 0, 'exit code must be 0');
  assert.ok(stdout.length > 0, `statusline must not be blank on corrupt display_name; got: ${JSON.stringify(stdout)}`);
  assert.ok(stdout.includes('projA'), `must still show directory basename; got: ${JSON.stringify(stdout)}`);
});

// SL-2: provider name colliding with Object.prototype member must not be falsely MCP-registered
test('SL-2: provider name colliding with Object.prototype (toString) is not falsely MCP-registered', () => {
  const tempHome = setupSlotsHome('sl2-proto', {
    providers: [{ name: 'toString' }],
    mcpServers: {}, // genuinely NOT registered
  });
  const tempDir = makeTempDir('sl2-dir');
  try {
    const { stdout, exitCode } = runHook(
      { model: { display_name: 'M' }, workspace: { current_dir: tempDir } },
      { HOME: tempHome }
    );
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('\x1b[2m· toString\x1b[0m'),
      `unregistered slot must render dim ·; got: ${JSON.stringify(stdout)}`);
    assert.ok(!stdout.includes('quorum'),
      `must not count an unregistered (inherited-name) slot toward quorum; got: ${JSON.stringify(stdout)}`);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

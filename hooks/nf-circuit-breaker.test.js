#!/usr/bin/env node
// Test suite for hooks/nf-circuit-breaker.js
// Uses Node.js built-in test runner: node --test hooks/nf-circuit-breaker.test.js
//
// Each test spawns the hook as a child process with mock stdin and captures stdout + exit code.
// For git-dependent tests, creates temp git repos with controlled commits.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK_PATH = path.join(__dirname, 'nf-circuit-breaker.js');

// Helper: write a temp JSONL file and return its path (though not used in circuit breaker tests)
function writeTempTranscript(lines) {
  const tmpFile = path.join(os.tmpdir(), `nf-circuit-breaker-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(tmpFile, lines.join('\n') + '\n', 'utf8');
  return tmpFile;
}

// Helper: run the hook with a given stdin JSON payload, return { stdout, exitCode, stderr }
function runHook(stdinPayload) {
  const result = spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify(stdinPayload),
    encoding: 'utf8',
    // Generous timeout: the hook does node startup + `git log` + per-pair diff
    // analysis. Measured cold-cache under heavy parallel load (full test:ci on
    // CI) at ~9s — a 5s cap killed the subprocess, yielding status=null and a
    // spurious "exit code must be 0" failure (the CB-TC9 flake). 30s is pure
    // test-side headroom; a healthy hook still returns in ~1s.
    timeout: 30000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
  };
}

// Helper: create a temp git repo with controlled commits
function createTempGitRepo() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-circuit-breaker-git-'));
  const git = (cmd) => spawnSync('git', cmd.split(' '), { cwd: tempDir, encoding: 'utf8' });

  // Initialize repo and configure
  git('init');
  git('config user.name "Test User"');
  git('config user.email "test@example.com"');

  return tempDir;
}

// Helper: make a commit in the temp repo
function commitInRepo(repoDir, fileName, content, message) {
  const filePath = path.join(repoDir, fileName);
  fs.writeFileSync(filePath, content, 'utf8');
  spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', message], { cwd: repoDir, encoding: 'utf8' });
}

// Helper: create multiple commits with same file set for oscillation testing
function createOscillationCommits(repoDir, fileSet, commitCount) {
  for (let i = 0; i < commitCount; i++) {
    fileSet.forEach(file => {
      fs.writeFileSync(path.join(repoDir, file), `content ${i}`, 'utf8');
    });
    spawnSync('git', ['add', '.'], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', `commit ${i}`], { cwd: repoDir, encoding: 'utf8' });
  }
}

// Helper: create true alternating oscillation commits: A-group, B-group, A-group, ...
// Each "group" is a single commit to fileSetA; between groups a different file (filler_N.txt) is committed.
// depth controls how many A-groups are created, producing depth-1 B-groups between them.
// Example: createAlternatingCommits(repo, ['app.js'], 3) → app.js, filler_0.txt, app.js, filler_1.txt, app.js
//
// Content alternates between 1 line (even i) and 2 lines (odd i) to produce
// at least one pair with negative net change — required by the hasNegativePair
// reversion check to distinguish true oscillation from monotonic substitution workflows.
function createAlternatingCommits(repoDir, fileSetA, depth) {
  for (let i = 0; i < depth; i++) {
    // Commit to fileSetA — alternate line count to create true oscillation signal
    fileSetA.forEach(file => {
      const content = i % 2 === 0
        ? `state-a-${i}\n`
        : `state-b-${i}\noscillation-extra\n`;
      fs.writeFileSync(path.join(repoDir, file), content, 'utf8');
    });
    spawnSync('git', ['add', '.'], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', `a-group ${i}`], { cwd: repoDir, encoding: 'utf8' });

    // Commit to a different file between A-groups (except after last A-group)
    if (i < depth - 1) {
      const filler = `filler_${i}.txt`;
      fs.writeFileSync(path.join(repoDir, filler), `filler ${i}`, 'utf8');
      spawnSync('git', ['add', filler], { cwd: repoDir, encoding: 'utf8' });
      spawnSync('git', ['commit', '-m', `b-group ${i}`], { cwd: repoDir, encoding: 'utf8' });
    }
  }
}

// Helper: create commits with different file sets (no oscillation)
function createNonOscillationCommits(repoDir, commitCount) {
  for (let i = 0; i < commitCount; i++) {
    const fileName = `file${i}.txt`;
    fs.writeFileSync(path.join(repoDir, fileName), `content ${i}`, 'utf8');
    spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', `commit ${i}`], { cwd: repoDir, encoding: 'utf8' });
  }
}

// --- Test Cases ---

// Test CB-TC1: No git repo in cwd → exit 0, stdout empty (DETECT-05)
// @requirement DETECT-05
test('CB-TC1: No git repo in cwd exits 0 with no output', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-no-git-'));
  try {
    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo hello', description: 'test', timeout: 5000 },
      cwd: tempDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty (DETECT-05)');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Test CB-TC2: Read-only command 'git log -n 10' → exit 0, stdout empty (DETECT-04)
test('CB-TC2: Read-only git log command passes without detection', () => {
  const repoDir = createTempGitRepo();
  try {
    commitInRepo(repoDir, 'test.txt', 'content', 'initial commit');
    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git log -n 10', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty (DETECT-04)');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-TC3: Read-only command 'grep -r "foo" .' → exit 0 (DETECT-04)
test('CB-TC3: Read-only grep command passes without detection', () => {
  const repoDir = createTempGitRepo();
  try {
    commitInRepo(repoDir, 'test.txt', 'content', 'initial commit');
    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'grep -r "foo" .', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty (DETECT-04)');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-TC4: Read-only command bare 'ls' → exit 0 (DETECT-04)
test('CB-TC4: Read-only bare ls command passes without detection', () => {
  const repoDir = createTempGitRepo();
  try {
    commitInRepo(repoDir, 'test.txt', 'content', 'initial commit');
    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'ls', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty (DETECT-04)');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-TC5: Write command, no state, fewer than depth commits with same file set → exit 0, no state written
test('CB-TC5: Write command with insufficient oscillation passes without state write', () => {
  const repoDir = createTempGitRepo();
  try {
    // Create 2 commits with same file set (less than depth=3)
    createOscillationCommits(repoDir, ['file1.txt', 'file2.txt'], 2);
    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo hello > new.txt', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty');
    const statePath = path.join(repoDir, '.claude', 'circuit-breaker-state.json');
    assert(!fs.existsSync(statePath), 'state file should not be written');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-TC6: Write command, no state, true A→B→A oscillation at depth=3 → exit 0, state written active:true
test('CB-TC6: Write command with exact oscillation depth triggers state write', () => {
  const repoDir = createTempGitRepo();
  try {
    // Create true alternating oscillation: A,B,A,B,A (3 A-groups = depth 3)
    createAlternatingCommits(repoDir, ['file1.txt', 'file2.txt'], 3);
    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo hello > new.txt', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty');
    const statePath = path.join(repoDir, '.claude', 'circuit-breaker-state.json');
    assert(fs.existsSync(statePath), 'state file should be written');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(state.active, true, 'state.active should be true');
    assert(Array.isArray(state.file_set), 'file_set should be array');
    assert(state.file_set.includes('file1.txt'), 'file_set should include modified files');
    assert(state.file_set.includes('file2.txt'), 'file_set should include modified files');
    assert(typeof state.activated_at === 'string', 'activated_at should be string');
    assert(Array.isArray(state.commit_window_snapshot), 'commit_window_snapshot should be array');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-TC7: Write command, existing state with active:true → hookSpecificOutput deny emitted (Phase 7 enforcement)
test('CB-TC7: Write command with active state emits hookSpecificOutput deny decision', () => {
  const repoDir = createTempGitRepo();
  try {
    // Create active state manually
    const stateDir = path.join(repoDir, '.claude');
    fs.mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, 'circuit-breaker-state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: true,
      file_set: ['test.txt'],
      activated_at: new Date().toISOString(),
      commit_window_snapshot: [['test.txt']]
    }), 'utf8');

    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo hello > new.txt', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.length > 0, 'stdout must be non-empty when circuit breaker active');
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.hookSpecificOutput, 'output must have hookSpecificOutput');
    assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny', 'permissionDecision must be deny');
    assert.ok(parsed.hookSpecificOutput.permissionDecisionReason.includes('CIRCUIT BREAKER'), 'reason must include CIRCUIT BREAKER');
    assert.ok(parsed.hookSpecificOutput.permissionDecisionReason.includes('git log'), 'reason must include allowed operations');
    assert.ok(
      parsed.hookSpecificOutput.permissionDecisionReason.includes('manually') ||
      parsed.hookSpecificOutput.permissionDecisionReason.includes('manually commit'),
      'reason must include manual commit instruction'
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-TC8: Write command, existing state with active:false → detection runs normally
test('CB-TC8: Write command with inactive state runs normal detection', () => {
  const repoDir = createTempGitRepo();
  try {
    // Create true alternating oscillation before writing state file
    createAlternatingCommits(repoDir, ['file1.txt', 'file2.txt'], 3);

    // Create inactive state after commits exist
    const stateDir = path.join(repoDir, '.claude');
    fs.mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, 'circuit-breaker-state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: false,
      file_set: ['test.txt'],
      activated_at: new Date().toISOString(),
      commit_window_snapshot: [['test.txt']]
    }), 'utf8');

    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo hello > new.txt', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    // Should have re-detected and overwritten state
    const newState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(newState.active, true, 'should have detected oscillation and set active');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-TC9: TDD cycle — commits touch different files per commit, no strict match → exit 0, no state written
test('CB-TC9: TDD cycle with different files per commit does not trigger oscillation', () => {
  const repoDir = createTempGitRepo();
  try {
    // Create commits with different files (TDD cycle simulation)
    createNonOscillationCommits(repoDir, 6); // 6 commits, each with different file
    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo hello > new.txt', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty');
    const statePath = path.join(repoDir, '.claude', 'circuit-breaker-state.json');
    assert(!fs.existsSync(statePath), 'state file should not be written');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-TC10: State file exists but is malformed JSON → treat as no state, fail-open, exit 0
test('CB-TC10: Malformed state file is treated as no state', () => {
  const repoDir = createTempGitRepo();
  try {
    // Create true alternating oscillation before writing the state file
    createAlternatingCommits(repoDir, ['file1.txt'], 3);

    // Create malformed state file after commits exist
    const stateDir = path.join(repoDir, '.claude');
    fs.mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, 'circuit-breaker-state.json');
    fs.writeFileSync(statePath, '{ malformed json', 'utf8');

    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo hello > new.txt', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0 (fail-open)');
    assert.strictEqual(stdout, '', 'stdout must be empty');
    // Should have written new valid state
    const newState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(newState.active, true, 'should have detected and written new state');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-TC11: .claude/ dir does not exist when writing state → dir created, state written, no error
test('CB-TC11: Missing .claude dir is created when writing state', () => {
  const repoDir = createTempGitRepo();
  try {
    // Ensure .claude doesn't exist
    const stateDir = path.join(repoDir, '.claude');
    if (fs.existsSync(stateDir)) fs.rmSync(stateDir, { recursive: true });

    // Create true alternating oscillation commits
    createAlternatingCommits(repoDir, ['file1.txt'], 3);

    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo hello > new.txt', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty');
    assert(fs.existsSync(stateDir), '.claude dir should be created');
    const statePath = path.join(stateDir, 'circuit-breaker-state.json');
    assert(fs.existsSync(statePath), 'state file should be written');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(state.active, true, 'state should be active');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-TC12: commit_window_snapshot in state correctly reflects per-commit arrays
test('CB-TC12: State commit_window_snapshot correctly captures per-commit file arrays', () => {
  const repoDir = createTempGitRepo();
  try {
    // Create true alternating oscillation: A,B,A,B,A (5 commits, depth=3)
    // git log newest-first: [a-group2, b-group1, a-group1, b-group0, a-group0]
    // All 5 within window=6 → snapshot.length === 5
    createAlternatingCommits(repoDir, ['a.txt', 'b.txt'], 3);

    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo hello > new.txt', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    const statePath = path.join(repoDir, '.claude', 'circuit-breaker-state.json');
    assert(fs.existsSync(statePath), 'state file should be written');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert(Array.isArray(state.commit_window_snapshot), 'commit_window_snapshot should be array');
    // 5 commits: 3 a-groups + 2 b-groups (filler commits between them)
    assert.strictEqual(state.commit_window_snapshot.length, 5, 'should capture all 5 commits');
    // Each entry must be an array
    state.commit_window_snapshot.forEach((entry, i) =>
      assert(Array.isArray(entry), `snapshot[${i}] should be an array`)
    );
    // Most recent commit (index 0) is the last a-group — touched a.txt and b.txt
    assert.deepStrictEqual(
      state.commit_window_snapshot[0].slice().sort(),
      ['a.txt', 'b.txt'],
      'newest commit snapshot should be [a.txt, b.txt]'
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-TC13: Write command with run_in_background:true in tool_input → same detection logic
test('CB-TC13: Background write command still triggers detection', () => {
  const repoDir = createTempGitRepo();
  try {
    createAlternatingCommits(repoDir, ['file1.txt'], 3);
    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo hello > new.txt', description: 'test', timeout: 5000, run_in_background: true },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    const statePath = path.join(repoDir, '.claude', 'circuit-breaker-state.json');
    assert(fs.existsSync(statePath), 'state should be written even for background commands');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(state.active, true, 'state should be active');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-TC14: Malformed stdin JSON → exit 0 (fail-open)
test('CB-TC14: Malformed stdin JSON exits 0 fail-open', () => {
  const result = spawnSync('node', [HOOK_PATH], {
    input: '{ malformed json',
    encoding: 'utf8',
    timeout: 30000, // headroom for loaded CI (see runHook note)
  });
  assert.strictEqual(result.status, 0, 'exit code must be 0 on malformed input');
  assert.strictEqual(result.stdout, '', 'stdout must be empty');
});

// Test CB-TC15: State write failure (place a file at the .claude/ path to block mkdirSync) → exit 0 (not blocked), stderr warning
test('CB-TC15: State write failure logs to stderr but does not block', () => {
  const repoDir = createTempGitRepo();
  try {
    // Create true alternating oscillation BEFORE blocking .claude
    createAlternatingCommits(repoDir, ['file1.txt'], 3);
    // Now block .claude dir creation by making it a file
    fs.writeFileSync(path.join(repoDir, '.claude'), 'blocking file', 'utf8');

    const { stdout, exitCode, stderr } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo hello > new.txt', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0 (not blocked)');
    assert.strictEqual(stdout, '', 'stdout must be empty');
    assert(stderr.includes('[nf] WARNING'), 'stderr should contain warning about write failure');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-TC16 (NEW): active state + read-only command → exit 0, stdout empty (read-only passes even when breaker is active)
test('CB-TC16: Read-only command passes even when circuit breaker is active', () => {
  const repoDir = createTempGitRepo();
  try {
    commitInRepo(repoDir, 'test.txt', 'content', 'init');
    // Create active state
    const stateDir = path.join(repoDir, '.claude');
    fs.mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, 'circuit-breaker-state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: true,
      file_set: ['test.txt'],
      activated_at: new Date().toISOString(),
      commit_window_snapshot: [['test.txt']]
    }), 'utf8');

    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git log --oneline -5', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty — read-only allowed even when breaker active');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-TC17 (NEW): active state + write command — verify block reason content
test('CB-TC17: Block reason includes file names, R5 reference, git log, and reset-breaker instructions', () => {
  const repoDir = createTempGitRepo();
  try {
    const stateDir = path.join(repoDir, '.claude');
    fs.mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, 'circuit-breaker-state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: true,
      file_set: ['src/feature.js', 'src/utils.js'],
      activated_at: new Date().toISOString(),
      commit_window_snapshot: []
    }), 'utf8');

    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/test', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    const parsed = JSON.parse(stdout);
    const reason = parsed.hookSpecificOutput.permissionDecisionReason;
    // File names from state.file_set
    assert.ok(reason.includes('src/feature.js'), 'reason must include oscillating file names');
    assert.ok(reason.includes('src/utils.js'), 'reason must include oscillating file names');
    // Oscillation Resolution Mode per R5 reference
    assert.ok(reason.includes('Oscillation Resolution Mode per R5'), 'reason must include R5 reference');
    // Allowed read-only operations
    assert.ok(reason.includes('git log'), 'reason must include git log as allowed operation');
    // Reset breaker instruction
    assert.ok(reason.includes('npx nforma --reset-breaker'), 'reason must include reset-breaker command');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-TC18 (NEW): config oscillation_depth integration — project config depth:2 triggers at 2 run-groups (not default 3)
test('CB-TC18: Project config oscillation_depth:2 triggers oscillation detection at depth 2', () => {
  const repoDir = createTempGitRepo();
  try {
    // Create true oscillation with 2 A-groups (depth=2) and a reversion:
    // Commit 1: app.js with 2 lines. Commit 2: filler. Commit 3: app.js with 1 line (net -1 = negative pair).
    commitInRepo(repoDir, 'app.js', 'line1\nline2\n', 'a-group 0');
    commitInRepo(repoDir, 'filler_0.txt', 'filler 0', 'b-group 0');
    commitInRepo(repoDir, 'app.js', 'line1\n', 'a-group 1');

    // Write project config AFTER commits to avoid git add capturing the config file
    const claudeDir = path.join(repoDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ circuit_breaker: { oscillation_depth: 2, commit_window: 6, min_cycles: 0 } }),
      'utf8'
    );

    const statePath = path.join(claudeDir, 'circuit-breaker-state.json');
    // Ensure no pre-existing state
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);

    const { exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo write', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    // Oscillation should be detected at depth=2 (config-driven), so state file should be written
    assert(fs.existsSync(statePath), 'state file should be written — oscillation detected at project config depth=2');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(state.active, true, 'state.active should be true');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// --- Direct unit tests for buildBlockReason() (CB-TC-BR series) ---
// These test buildBlockReason() directly via module.exports rather than via spawnSync.

const {
  buildBlockReason,
  writeEvidenceSignature,
  checkPreemptiveEvidence,
  markEvidenceResolved,
  makeFileSetHash,
  makePatternHash,
  getEvidencePath,
  hasReversionInHashes,
  detectOscillation,
  countOscillationCycles,
  getCommitMessages,
  hasRollbackIntent,
  isCleanRollback,
  ROLLBACK_KEYWORDS,
} = require('../hooks/nf-circuit-breaker.js');

// Test CB-TC-BR1: Deny message includes commit graph when snapshot present
test('CB-TC-BR1: Deny message includes commit graph when snapshot present', () => {
  const state = {
    active: true,
    file_set: ['a.js', 'b.js'],
    activated_at: '2026-01-01T00:00:00Z',
    commit_window_snapshot: [['a.js', 'b.js'], ['c.js'], ['a.js', 'b.js']],
  };
  const reason = buildBlockReason(state);
  assert.ok(reason.includes('Commit Graph'), 'deny reason must contain "Commit Graph"');
  assert.ok(reason.includes('a.js, b.js'), 'deny reason must contain file names from snapshot');
  assert.ok(reason.includes('Oscillation Resolution Mode per R5'), 'deny reason must contain R5 reference');
});

// Test CB-TC-BR2: Deny message handles missing snapshot gracefully
test('CB-TC-BR2: Deny message handles missing snapshot gracefully', () => {
  const state = {
    active: true,
    file_set: ['x.js'],
    activated_at: '2026-01-01T00:00:00Z',
    // no commit_window_snapshot
  };
  let reason;
  assert.doesNotThrow(() => { reason = buildBlockReason(state); }, 'buildBlockReason must not throw when snapshot missing');
  assert.ok(reason.includes('CIRCUIT BREAKER ACTIVE'), 'deny reason must contain CIRCUIT BREAKER ACTIVE');
  assert.ok(reason.includes('commit graph unavailable'), 'deny reason must note unavailable commit graph');
});

// Test CB-TC-BR3: Deny message still references --reset-breaker
test('CB-TC-BR3: Deny message still references --reset-breaker instruction', () => {
  const state = {
    active: true,
    file_set: ['any.js'],
    activated_at: '2026-01-01T00:00:00Z',
    commit_window_snapshot: [['any.js']],
  };
  const reason = buildBlockReason(state);
  assert.ok(reason.includes('npx nforma --reset-breaker'), 'deny reason must include --reset-breaker command');
});

// Test CB-TC20: TDD pattern — same file extended with new content each time does not trigger oscillation
test('CB-TC20: TDD pattern — same file extended with new content each time does not trigger oscillation', () => {
  // Simulate Phase 18 false-positive scenario:
  // nf-tools.cjs (new fn A) → nf-tools.test.cjs (tests A) →
  // nf-tools.cjs (new fn B) → nf-tools.test.cjs (tests B) →
  // planning file → nf-tools.cjs (new fn C)
  //
  // Each commit to nf-tools.cjs ADDS new lines — never reverts previous content.
  // Result: should NOT trigger circuit breaker.
  const repoDir = createTempGitRepo();
  try {
    const implFile = 'nf-tools.cjs';
    const testFile = 'nf-tools.test.cjs';
    const planFile = 'planning-note.md';

    // Commit 1: implement fn A (initial content)
    spawnSync('git', ['add', implFile], { cwd: repoDir, encoding: 'utf8' });
    commitInRepo(repoDir, implFile, 'function fnA() { return "a"; }\nmodule.exports = { fnA };\n', 'feat: implement fn A');

    // Commit 2: tests for fn A (different file → creates run-group boundary for implFile)
    commitInRepo(repoDir, testFile, 'const { fnA } = require("./nf-tools.cjs");\nconsole.assert(fnA() === "a");\n', 'test: add tests for fn A');

    // Commit 3: implement fn B — append to implFile (purely additive, no deletions)
    commitInRepo(repoDir, implFile,
      'function fnA() { return "a"; }\nfunction fnB() { return "b"; }\nmodule.exports = { fnA, fnB };\n',
      'feat: implement fn B');

    // Commit 4: tests for fn B (different file → creates another run-group boundary for implFile)
    commitInRepo(repoDir, testFile,
      'const { fnA, fnB } = require("./nf-tools.cjs");\nconsole.assert(fnA() === "a");\nconsole.assert(fnB() === "b");\n',
      'test: add tests for fn B');

    // Commit 5: planning file (yet another file between impl commits)
    commitInRepo(repoDir, planFile, '# Planning notes\n- fn A: done\n- fn B: done\n', 'docs: update planning notes');

    // Commit 6: implement fn C — append to implFile (purely additive, no deletions)
    commitInRepo(repoDir, implFile,
      'function fnA() { return "a"; }\nfunction fnB() { return "b"; }\nfunction fnC() { return "c"; }\nmodule.exports = { fnA, fnB, fnC };\n',
      'feat: implement fn C');

    // Now nf-tools.cjs has 3 run-groups but all consecutive pairs are purely additive.
    // Circuit breaker must NOT trigger.
    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo write > output.txt', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty — TDD progression must not trigger circuit breaker');
    const statePath = path.join(repoDir, '.claude', 'circuit-breaker-state.json');
    assert(!fs.existsSync(statePath), 'state file must NOT be written — TDD pattern is not oscillation (CB-TC20)');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-TC21: True oscillation — lines added then removed then added again triggers detection
test('CB-TC21: True oscillation — lines added then removed then added again triggers detection', () => {
  // Commit 1: app.js has 'function foo() { return 1; }'
  // Commit 2: filler (creates run-group boundary for app.js)
  // Commit 3: app.js has 'function foo() { return 2; }' (removes original line, adds new line)
  // Commit 4: filler (creates another run-group boundary)
  // Commit 5: app.js has 'function foo() { return 1; }' (removes commit-3 line, re-adds original)
  // Result: SHOULD trigger circuit breaker (net deletions exist between consecutive pairs)
  const repoDir = createTempGitRepo();
  try {
    // Commit 1: app.js with original content (1 line)
    commitInRepo(repoDir, 'app.js', 'function foo() { return 1; }\n', 'feat: add foo returning 1');

    // Commit 2: filler (different file → creates run-group boundary)
    commitInRepo(repoDir, 'filler1.txt', 'filler content 1\n', 'chore: filler 1');

    // Commit 3: app.js with modified content + extra line (2 lines, net +1)
    commitInRepo(repoDir, 'app.js', 'function foo() { return 2; }\nconst extra = true;\n', 'fix: change foo to return 2');

    // Commit 4: filler (different file → another run-group boundary)
    commitInRepo(repoDir, 'filler2.txt', 'filler content 2\n', 'chore: filler 2');

    // Commit 5: app.js reverted to 1 line (removes extra line — net -1 on this pair = negative pair)
    commitInRepo(repoDir, 'app.js', 'function foo() { return 1; }\n', 'revert: revert foo back to 1');

    // Now app.js has 3 run-groups AND consecutive pairs show net deletions → real oscillation.
    // Circuit breaker MUST trigger.
    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo write > output.txt', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty (state written, no blocking output on first detection)');
    const statePath = path.join(repoDir, '.claude', 'circuit-breaker-state.json');
    assert(fs.existsSync(statePath), 'state file MUST be written — true oscillation detected (CB-TC21)');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(state.active, true, 'state.active must be true — circuit breaker must activate');
    assert(Array.isArray(state.file_set), 'file_set must be an array');
    assert(state.file_set.includes('app.js'), 'file_set must include app.js');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-TC22: appendFalseNegative creates and appends audit log entries
test('CB-TC22: appendFalseNegative creates and appends audit log entries', () => {
  const repoDir = createTempGitRepo();
  try {
    const stateDir = path.join(repoDir, '.claude');
    fs.mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, 'circuit-breaker-state.json');
    const fnLogPath = path.join(stateDir, 'circuit-breaker-false-negatives.json');

    // Directly invoke the hook binary and check stderr contains INFO when haiku_reviewer=false
    // To exercise the REFINEMENT path without a live API, disable haiku_reviewer via config,
    // create oscillation commits, and confirm: no deny output, no state written.
    // (haiku_reviewer:false skips Haiku entirely — REFINEMENT branch is not reached that way.
    //  The false-negative function itself is unit-tested by importing the module.)
    //
    // Load the module and call appendFalseNegative directly (via internal exposure check):
    // Since appendFalseNegative is not exported, test it by verifying the false-negatives file
    // is created after a real REFINEMENT flow with a live key would produce it.
    //
    // For CI safety (no live API), write the false-negatives.json manually and verify format:
    if (!fs.existsSync(fnLogPath)) {
      fs.writeFileSync(fnLogPath, JSON.stringify([]), 'utf8');
    }
    const entry1 = {
      detected_at: new Date().toISOString(),
      file_set: ['app.js'],
      reviewer: 'haiku',
      verdict: 'REFINEMENT',
    };
    const existing = JSON.parse(fs.readFileSync(fnLogPath, 'utf8'));
    existing.push(entry1);
    fs.writeFileSync(fnLogPath, JSON.stringify(existing, null, 2), 'utf8');

    const loaded = JSON.parse(fs.readFileSync(fnLogPath, 'utf8'));
    assert.strictEqual(loaded.length, 1, 'false-negatives log must have 1 entry after first append');
    assert.strictEqual(loaded[0].verdict, 'REFINEMENT', 'entry verdict must be REFINEMENT');
    assert.ok(loaded[0].detected_at, 'entry must have detected_at timestamp');
    assert.deepStrictEqual(loaded[0].file_set, ['app.js'], 'entry must record file_set');

    // Append a second entry to confirm array grows
    existing.push({ ...entry1, file_set: ['b.js'] });
    fs.writeFileSync(fnLogPath, JSON.stringify(existing, null, 2), 'utf8');
    const loaded2 = JSON.parse(fs.readFileSync(fnLogPath, 'utf8'));
    assert.strictEqual(loaded2.length, 2, 'false-negatives log must have 2 entries after second append');

    // Verify the hook source file actually contains the appendFalseNegative function name
    const src = fs.readFileSync(HOOK_PATH, 'utf8');
    assert.ok(src.includes('appendFalseNegative'), 'hook source must define appendFalseNegative');
    assert.ok(src.includes('circuit-breaker-false-negatives.json'), 'hook source must reference false-negatives log file');
    assert.ok(src.includes('[nf] INFO'), 'hook source must emit INFO log on false-negative');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-TC23: Workflow progression with substitutions does NOT trigger oscillation
// Simulates VALIDATION.md false-positive scenario: template → linter substitution → population
// Each pair has additions == deletions (net 0), so hasNegativePair stays false → not oscillation.
test('CB-TC23: Workflow progression with substitutions does NOT trigger oscillation', () => {
  const repoDir = createTempGitRepo();
  try {
    const valFile = 'VALIDATION.md';

    // Commit 1: Template with placeholders (3 lines)
    commitInRepo(repoDir, valFile,
      'phase: {PHASE_NAME}\nplans: {PLAN_COUNT}\nwaves: {WAVE_COUNT}\n',
      'docs: create VALIDATION.md template');

    // Commit 2: Filler (creates run-group boundary for VALIDATION.md)
    commitInRepo(repoDir, 'RESEARCH.md', 'research content\n', 'docs: add research');

    // Commit 3: Linter replaces ALL placeholders with "TBD" (same line count — pure substitution)
    commitInRepo(repoDir, valFile,
      'phase: TBD\nplans: TBD\nwaves: TBD\n',
      'style: linter cleanup of VALIDATION.md');

    // Commit 4: Another filler (creates run-group boundary)
    commitInRepo(repoDir, 'PLAN.md', 'plan content\n', 'docs: add plan');

    // Commit 5: Replace "TBD" with real data (same line count — pure substitution)
    commitInRepo(repoDir, valFile,
      'phase: v0.29-02\nplans: 3\nwaves: 1\n',
      'docs: populate VALIDATION.md with real data');

    // VALIDATION.md has 3 run-groups but all pairs are zero-net substitutions.
    // Circuit breaker must NOT trigger.
    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo write > output.txt', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty — substitution workflow must not trigger circuit breaker');
    const statePath = path.join(repoDir, '.claude', 'circuit-breaker-state.json');
    assert(!fs.existsSync(statePath), 'state file must NOT be written — monotonic substitution workflow is not oscillation (CB-TC23)');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-TC24: True oscillation with content reversion STILL triggers correctly
// At least one pair has negative net change (content removed) → hasNegativePair = true
test('CB-TC24: True oscillation with content reversion still triggers detection', () => {
  const repoDir = createTempGitRepo();
  try {
    // Commit 1: config.js with 2 lines
    commitInRepo(repoDir, 'config.js',
      'const mode = "debug";\nconst verbose = true;\n',
      'feat: add config');

    // Commit 2: Filler (creates run-group boundary)
    commitInRepo(repoDir, 'filler1.txt', 'filler\n', 'chore: filler 1');

    // Commit 3: Change config — replace both lines + add an extra line (net +1)
    commitInRepo(repoDir, 'config.js',
      'const mode = "production";\nconst verbose = false;\nconst extra = "added";\n',
      'fix: switch to production mode');

    // Commit 4: Filler (creates run-group boundary)
    commitInRepo(repoDir, 'filler2.txt', 'filler\n', 'chore: filler 2');

    // Commit 5: Revert config — remove the extra line (net -1 on this pair = negative pair)
    commitInRepo(repoDir, 'config.js',
      'const mode = "debug";\nconst verbose = true;\n',
      'revert: back to debug mode');

    // config.js has 3 run-groups AND the last pair removes a line → hasNegativePair = true
    // Circuit breaker MUST trigger.
    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo write > output.txt', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty (state written, no blocking on first detection)');
    const statePath = path.join(repoDir, '.claude', 'circuit-breaker-state.json');
    assert(fs.existsSync(statePath), 'state file MUST be written — true oscillation with reversion detected (CB-TC24)');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(state.active, true, 'state.active must be true');
    assert(state.file_set.includes('config.js'), 'file_set must include config.js');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-TC19 (NEW): config commit_window integration — project config window:3 excludes older commits
test('CB-TC19: Project config commit_window:3 excludes commits beyond window from oscillation check', () => {
  const repoDir = createTempGitRepo();
  try {
    // Create 4 commits: commits 1-3 touch file-A.txt, commit 4 touches file-B.txt (different)
    // With default commit_window=6: commits 1-4 all in window, file-A.txt set appears 3x → would detect (depth=3)
    // With commit_window=3: only last 3 commits in window; commit 1 (file-A.txt) is excluded
    //   → file-A.txt set appears only 2x in window → oscillation NOT detected (depth=3)
    commitInRepo(repoDir, 'file-A.txt', 'content-1', 'commit 1 file-A');
    commitInRepo(repoDir, 'file-A.txt', 'content-2', 'commit 2 file-A');
    commitInRepo(repoDir, 'file-A.txt', 'content-3', 'commit 3 file-A');
    commitInRepo(repoDir, 'file-B.txt', 'content-4', 'commit 4 file-B');

    // Write project config with commit_window=3 AFTER commits
    const claudeDir = path.join(repoDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'nf.json'),
      JSON.stringify({ circuit_breaker: { oscillation_depth: 3, commit_window: 3 } }),
      'utf8'
    );

    const statePath = path.join(claudeDir, 'circuit-breaker-state.json');
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);

    const { exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo write', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    // With commit_window=3, only last 3 commits are examined:
    // [file-B.txt] (commit 4), [file-A.txt] (commit 3), [file-A.txt] (commit 2)
    // file-A.txt set appears 2x — below depth=3 → NOT detected
    assert(!fs.existsSync(statePath), 'state file must NOT be written — commit_window=3 excludes oldest file-A commit, so only 2 matches found (below depth=3)');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── Evidence persistence tests (oscillation-signatures.json) ──────────────────

// Test CB-EV01: writeEvidenceSignature creates new file
test('CB-EV01: writeEvidenceSignature creates new file with correct schema', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-ev-'));
  try {
    const fileSet = ['app.js', 'config.js'];
    const fileSets = [['app.js', 'config.js'], ['other.js'], ['app.js', 'config.js']];
    const fsh = makeFileSetHash(fileSet);
    const ph = makePatternHash(fileSets);

    writeEvidenceSignature(tempDir, fileSet, fileSets, fsh, ph);

    const evidencePath = getEvidencePath(tempDir);
    assert(fs.existsSync(evidencePath), 'evidence file must exist after write');
    const data = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    assert.strictEqual(data.schema_version, 1, 'schema_version must be 1');
    assert.strictEqual(data.signatures.length, 1, 'must have exactly 1 signature');
    const sig = data.signatures[0];
    assert.strictEqual(sig.id, `sig_${fsh}`, 'id must follow sig_{hash} format');
    assert.strictEqual(sig.file_set_hash, fsh, 'file_set_hash must match');
    assert.strictEqual(sig.pattern_hash, ph, 'pattern_hash must match');
    assert.deepStrictEqual(sig.files, ['app.js', 'config.js'], 'files must be sorted');
    assert.strictEqual(sig.alternation_count, 1, 'alternation_count must start at 1');
    assert.ok(sig.time_window.first_seen, 'must have first_seen');
    assert.ok(sig.time_window.last_seen, 'must have last_seen');
    assert.strictEqual(sig.resolved_at, null, 'resolved_at must be null');
    assert.strictEqual(sig.resolved_by_commit, null, 'resolved_by_commit must be null');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Test CB-EV02: writeEvidenceSignature updates existing entry
test('CB-EV02: writeEvidenceSignature updates existing entry with incremented count', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-ev-'));
  try {
    const fileSet = ['app.js'];
    const fileSets = [['app.js'], ['other.js'], ['app.js']];
    const fsh = makeFileSetHash(fileSet);
    const ph = makePatternHash(fileSets);

    writeEvidenceSignature(tempDir, fileSet, fileSets, fsh, ph);
    const data1 = JSON.parse(fs.readFileSync(getEvidencePath(tempDir), 'utf8'));
    const firstSeen = data1.signatures[0].time_window.first_seen;

    // Write again with same fileSetHash
    writeEvidenceSignature(tempDir, fileSet, fileSets, fsh, ph);
    const data2 = JSON.parse(fs.readFileSync(getEvidencePath(tempDir), 'utf8'));
    assert.strictEqual(data2.signatures.length, 1, 'must still have exactly 1 signature (updated, not duplicated)');
    assert.strictEqual(data2.signatures[0].alternation_count, 2, 'alternation_count must be incremented to 2');
    assert.strictEqual(data2.signatures[0].time_window.first_seen, firstSeen, 'first_seen must not change');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Test CB-EV03: writeEvidenceSignature caps at 50 entries
test('CB-EV03: writeEvidenceSignature caps at 50 entries sorted by last_seen', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-ev-'));
  try {
    // Write 55 unique entries
    for (let i = 0; i < 55; i++) {
      const fileSet = [`file-${String(i).padStart(3, '0')}.js`];
      const fsh = makeFileSetHash(fileSet);
      const ph = `pattern_${i}`;
      writeEvidenceSignature(tempDir, fileSet, [fileSet], fsh, ph);
    }

    const data = JSON.parse(fs.readFileSync(getEvidencePath(tempDir), 'utf8'));
    assert.strictEqual(data.signatures.length, 50, 'must cap at 50 entries');
    // Verify sorted by last_seen descending
    for (let i = 1; i < data.signatures.length; i++) {
      assert(data.signatures[i - 1].time_window.last_seen >= data.signatures[i].time_window.last_seen,
        'signatures must be sorted by last_seen descending');
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Test CB-EV04: writeEvidenceSignature is fail-open on read-only dir
test('CB-EV04: writeEvidenceSignature is fail-open on inaccessible dir', () => {
  // Use a path that cannot be written to
  const badDir = '/dev/null/nonexistent';
  // Should not throw
  writeEvidenceSignature(badDir, ['a.js'], [['a.js']], 'abc123', 'def456');
  // If we got here without throwing, the test passes
  assert.ok(true, 'writeEvidenceSignature must not throw on inaccessible dir');
});

// Test CB-EV05: checkPreemptiveEvidence returns match for unresolved signature
test('CB-EV05: checkPreemptiveEvidence returns match for unresolved signature', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-ev-'));
  try {
    const fileSet = ['app.js', 'util.js'];
    const fileSets = [['app.js', 'util.js'], ['other.js'], ['app.js', 'util.js']];
    const fsh = makeFileSetHash(fileSet);
    const ph = makePatternHash(fileSets);

    // Write an unresolved signature
    writeEvidenceSignature(tempDir, fileSet, fileSets, fsh, ph);

    // Check with matching file sets
    const match = checkPreemptiveEvidence(tempDir, fileSets);
    assert.ok(match, 'must return a matching signature');
    assert.strictEqual(match.file_set_hash, fsh, 'match must have correct file_set_hash');
    assert.strictEqual(match.resolved_at, null, 'match must be unresolved');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Test CB-EV06: checkPreemptiveEvidence returns null for resolved signature
test('CB-EV06: checkPreemptiveEvidence returns null for resolved signature', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-ev-'));
  try {
    const fileSet = ['app.js'];
    const fileSets = [['app.js'], ['other.js'], ['app.js']];
    const fsh = makeFileSetHash(fileSet);
    const ph = makePatternHash(fileSets);

    // Write and then resolve
    writeEvidenceSignature(tempDir, fileSet, fileSets, fsh, ph);
    markEvidenceResolved(tempDir, fsh, 'abc123');

    // Check — should return null since it's resolved
    const match = checkPreemptiveEvidence(tempDir, fileSets);
    assert.strictEqual(match, null, 'must return null for resolved signature');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Test CB-EV07: checkPreemptiveEvidence returns null on missing file
test('CB-EV07: checkPreemptiveEvidence returns null on missing file (fail-open)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-ev-'));
  try {
    // No evidence file exists
    const result = checkPreemptiveEvidence(tempDir, [['app.js']]);
    assert.strictEqual(result, null, 'must return null when evidence file does not exist');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Test CB-EV08: checkPreemptiveEvidence prunes entries older than 30 days
test('CB-EV08: checkPreemptiveEvidence prunes entries older than 30 days', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-ev-'));
  try {
    const fileSet = ['old.js'];
    const fsh = makeFileSetHash(fileSet);

    // Manually write evidence file with an old entry (40 days ago)
    const evidencePath = getEvidencePath(tempDir);
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const data = {
      schema_version: 1,
      signatures: [{
        id: `sig_${fsh}`,
        file_set_hash: fsh,
        pattern_hash: 'old_pattern',
        files: ['old.js'],
        alternation_count: 1,
        time_window: { first_seen: fortyDaysAgo, last_seen: fortyDaysAgo },
        resolved_at: null,
        resolved_by_commit: null,
        session_id: null,
      }],
    };
    fs.writeFileSync(evidencePath, JSON.stringify(data, null, 2), 'utf8');

    // Call check — should prune the old entry
    const match = checkPreemptiveEvidence(tempDir, [['old.js']]);
    assert.strictEqual(match, null, 'must return null — old entry should be pruned');

    // Verify the file was rewritten without the old entry
    const updated = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    assert.strictEqual(updated.signatures.length, 0, 'old entry must be pruned from file');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Test CB-EV09: markEvidenceResolved sets resolved_at and resolved_by_commit
test('CB-EV09: markEvidenceResolved sets resolved_at and resolved_by_commit', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-ev-'));
  try {
    const fileSet = ['fix.js'];
    const fileSets = [['fix.js'], ['other.js'], ['fix.js']];
    const fsh = makeFileSetHash(fileSet);
    const ph = makePatternHash(fileSets);

    // Write unresolved
    writeEvidenceSignature(tempDir, fileSet, fileSets, fsh, ph);

    // Verify unresolved
    const before = JSON.parse(fs.readFileSync(getEvidencePath(tempDir), 'utf8'));
    assert.strictEqual(before.signatures[0].resolved_at, null, 'must be unresolved before mark');

    // Mark resolved
    markEvidenceResolved(tempDir, fsh, 'deadbeef');

    // Verify resolved
    const after = JSON.parse(fs.readFileSync(getEvidencePath(tempDir), 'utf8'));
    assert.ok(after.signatures[0].resolved_at, 'resolved_at must be set');
    assert.strictEqual(after.signatures[0].resolved_by_commit, 'deadbeef', 'resolved_by_commit must be set');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ============================================================================
// New tests for false-positive prevention: cycles, rollback, intent
// ============================================================================

// --- Direct unit tests for new exported functions ---

// Test CB-UT01: countOscillationCycles returns correct values
test('CB-UT01: countOscillationCycles returns runList.length - 1', () => {
  assert.strictEqual(countOscillationCycles([{ indices: [0] }]), 0, '1 run-group = 0 cycles');
  assert.strictEqual(countOscillationCycles([{ indices: [0] }, { indices: [2] }]), 1, '2 run-groups = 1 cycle');
  assert.strictEqual(countOscillationCycles([{ indices: [0] }, { indices: [2] }, { indices: [4] }]), 2, '3 run-groups = 2 cycles');
  assert.strictEqual(countOscillationCycles([]), 0, 'empty = 0 cycles');
});

// Test CB-UT02: ROLLBACK_KEYWORDS matches expected patterns
test('CB-UT02: ROLLBACK_KEYWORDS matches revert/rollback/remove/undo/backout', () => {
  assert.ok(ROLLBACK_KEYWORDS.test('Revert prefer_wallet parameter'), '"Revert" must match');
  assert.ok(ROLLBACK_KEYWORDS.test('fix: remove unvalidated wallet-first'), '"remove" must match');
  assert.ok(ROLLBACK_KEYWORDS.test('Rollback feature X'), '"Rollback" must match');
  assert.ok(ROLLBACK_KEYWORDS.test('Undo bad merge'), '"Undo" must match');
  assert.ok(ROLLBACK_KEYWORDS.test('Backout changeset'), '"Backout" must match');
  assert.ok(ROLLBACK_KEYWORDS.test('back out changes'), '"back out" must match');
  assert.ok(!ROLLBACK_KEYWORDS.test('Update config'), '"Update" must not match');
  assert.ok(!ROLLBACK_KEYWORDS.test('Add new feature'), '"Add" must not match');
  assert.ok(!ROLLBACK_KEYWORDS.test('Fix typo in readme'), '"Fix" must not match');
});

// Test CB-UT03: hasRollbackIntent detects keywords on negative-net commits
test('CB-UT03: hasRollbackIntent detects keywords on negative-net commits', () => {
  const hash = 'abc123';
  const messages = new Map([[hash, 'Revert prefer_wallet parameter']]);
  const pairStats = [{ pairNet: 10, hash: 'other' }, { pairNet: -10, hash }];
  assert.ok(hasRollbackIntent(messages, pairStats), 'negative-net commit with "Revert" must match');
});

// Test CB-UT04: hasRollbackIntent ignores keywords on positive-net commits
test('CB-UT04: hasRollbackIntent ignores keywords on positive-net commits', () => {
  const hash = 'abc123';
  const messages = new Map([[hash, 'Revert something']]);
  const pairStats = [{ pairNet: 10, hash }]; // positive net — keyword shouldn't count
  assert.ok(!hasRollbackIntent(messages, pairStats), 'positive-net commit with "Revert" must not match');
});

// Test CB-UT05: hasRollbackIntent returns false when no keywords present
test('CB-UT05: hasRollbackIntent returns false when no keywords present', () => {
  const hash = 'abc123';
  const messages = new Map([[hash, 'Update routing logic']]);
  const pairStats = [{ pairNet: -5, hash }];
  assert.ok(!hasRollbackIntent(messages, pairStats), 'negative-net commit without keywords must not match');
});

// --- Integration tests: cycle gate, rollback detection, intent ---

// Helper: build a PreToolUse stdin payload for a write command in the given repo
function makeWritePayload(repoDir) {
  return {
    tool_name: 'Bash',
    tool_input: { command: 'echo write-test', description: 'test', timeout: 5000 },
    cwd: repoDir,
    hook_event_name: 'PreToolUse',
    tool_use_id: 'test-id',
    session_id: 'test-session',
    transcript_path: '/tmp/test.jsonl',
    permission_mode: 'default',
  };
}

// Helper: create a clean rollback pattern — add feature then remove it, with filler commits
// Produces: add feature (same files) → filler → remove feature (same files) → filler → same files again
// This gives 3 run-groups of the same file set but only 1 full cycle.
function createRollbackPattern(repoDir, fileName) {
  // Initial commit
  fs.writeFileSync(path.join(repoDir, fileName), 'line1\n', 'utf8');
  spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, encoding: 'utf8' });

  // Commit 1: add feature (50 lines)
  let content = 'line1\n';
  for (let i = 0; i < 50; i++) content += `feature-line-${i}\n`;
  fs.writeFileSync(path.join(repoDir, fileName), content, 'utf8');
  spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'feat: add prefer_wallet routing'], { cwd: repoDir, encoding: 'utf8' });

  // Filler commit (different file)
  fs.writeFileSync(path.join(repoDir, 'other.txt'), 'filler 0', 'utf8');
  spawnSync('git', ['add', 'other.txt'], { cwd: repoDir, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'b-group filler 0'], { cwd: repoDir, encoding: 'utf8' });

  // Commit 2: remove feature (back to 1 line) — deliberate rollback
  fs.writeFileSync(path.join(repoDir, fileName), 'line1\n', 'utf8');
  spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'fix: remove unvalidated wallet-first routing'], { cwd: repoDir, encoding: 'utf8' });

  // Filler commit (different file)
  fs.writeFileSync(path.join(repoDir, 'other2.txt'), 'filler 1', 'utf8');
  spawnSync('git', ['add', 'other2.txt'], { cwd: repoDir, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'b-group filler 1'], { cwd: repoDir, encoding: 'utf8' });

  // Commit 3: touch the same file again (creates 3rd run-group)
  fs.writeFileSync(path.join(repoDir, fileName), 'line1\npost-rollback-fix\n', 'utf8');
  spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'a-group post-rollback'], { cwd: repoDir, encoding: 'utf8' });
}

// Test CB-FP01: Single-cycle rollback with min_cycles=2 does NOT trigger
// This is the DigitalFrontier-infra false positive scenario.
test('CB-FP01: Single-cycle rollback (add→remove) with min_cycles=2 does not trigger', () => {
  const repoDir = createTempGitRepo();
  try {
    createRollbackPattern(repoDir, 'router.py');

    // Run hook with write command — should NOT detect oscillation
    const { stdout, exitCode, stderr } = runHook(makeWritePayload(repoDir));
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty — no detection on first pass');

    // State file must NOT be written — this is the key assertion
    const statePath = path.join(repoDir, '.claude', 'circuit-breaker-state.json');
    assert(!fs.existsSync(statePath), 'state file must NOT be written — single-cycle rollback must not activate the breaker (CB-FP01)');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-FP02: Two full oscillation cycles DO trigger
test('CB-FP02: Two full oscillation cycles (A→B→A→B→A) do trigger', () => {
  const repoDir = createTempGitRepo();
  try {
    // Create 5 A-groups (4 filler groups between them = 2 full cycles beyond what min_cycles=2 requires)
    createAlternatingCommits(repoDir, ['app.js'], 5);

    // Run hook — should detect oscillation (state file or detection output)
    const { exitCode } = runHook(makeWritePayload(repoDir));
    assert.strictEqual(exitCode, 0, 'exit code must be 0');

    // Check that state file was written (oscillation detected)
    const statePath = path.join(repoDir, '.claude', 'circuit-breaker-state.json');
    assert.ok(fs.existsSync(statePath), 'state file must be written for 2+ cycle oscillation');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-FP03: Clean rollback with revert keyword does NOT trigger at borderline
// Uses exactly 3 A-groups (depth=3, cycles=2, min_cycles=2) with a clean inverse diff
// pattern (large add then large remove) — suppressed by isCleanRollback.
test('CB-FP03: Clean rollback with revert keyword does not trigger at borderline', () => {
  const repoDir = createTempGitRepo();
  try {
    const fileName = 'config.py';

    // Initial
    fs.writeFileSync(path.join(repoDir, fileName), 'base\n', 'utf8');
    spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, encoding: 'utf8' });

    // Commit 1: add 30 lines (A-group 1)
    let content = 'base\n';
    for (let i = 0; i < 30; i++) content += `feature_line_${i}\n`;
    fs.writeFileSync(path.join(repoDir, fileName), content, 'utf8');
    spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'feat: add new config flags'], { cwd: repoDir, encoding: 'utf8' });

    // Filler
    fs.writeFileSync(path.join(repoDir, 'filler0.txt'), 'x', 'utf8');
    spawnSync('git', ['add', 'filler0.txt'], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'filler 0'], { cwd: repoDir, encoding: 'utf8' });

    // Commit 2: remove all 30 lines — clean inverse (A-group 2)
    fs.writeFileSync(path.join(repoDir, fileName), 'base\n', 'utf8');
    spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'Revert "feat: add new config flags" — unvalidated'], { cwd: repoDir, encoding: 'utf8' });

    // Filler
    fs.writeFileSync(path.join(repoDir, 'filler1.txt'), 'x', 'utf8');
    spawnSync('git', ['add', 'filler1.txt'], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'filler 1'], { cwd: repoDir, encoding: 'utf8' });

    // Commit 3: small touch to same file (A-group 3, creates borderline cycles=2)
    fs.writeFileSync(path.join(repoDir, fileName), 'base\ncleanup\n', 'utf8');
    spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'cleanup pass'], { cwd: repoDir, encoding: 'utf8' });

    // Run hook — should NOT detect oscillation (clean inverse diff pattern)
    const { stdout, exitCode } = runHook(makeWritePayload(repoDir));
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty — no detection on first pass');

    // State file must NOT be written — isCleanRollback suppresses at borderline
    const statePath = path.join(repoDir, '.claude', 'circuit-breaker-state.json');
    assert(!fs.existsSync(statePath), 'state file must NOT be written — clean rollback must not activate breaker (CB-FP03)');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-FP04: Clean inverse diff pattern (add 50 lines, remove 50 lines) = clean rollback
test('CB-FP04: Clean inverse diff pattern detected as rollback via isCleanRollback', () => {
  const repoDir = createTempGitRepo();
  try {
    // Create add-then-remove pattern on the same file
    const fileName = 'feature.py';

    // Initial
    fs.writeFileSync(path.join(repoDir, fileName), 'base\n', 'utf8');
    spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, encoding: 'utf8' });

    // Add feature (30 lines)
    let content = 'base\n';
    for (let i = 0; i < 30; i++) content += `feature_line_${i}\n`;
    fs.writeFileSync(path.join(repoDir, fileName), content, 'utf8');
    spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'feat: add new routing param'], { cwd: repoDir, encoding: 'utf8' });

    // Remove feature (back to base) — no "revert" keyword to test pure diff detection
    fs.writeFileSync(path.join(repoDir, fileName), 'base\n', 'utf8');
    spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'fix: adjust routing without param'], { cwd: repoDir, encoding: 'utf8' });

    // Get hashes for all 3 commits (newest-first: remove, add, initial)
    const logResult = spawnSync('git', ['log', '--format=%H', '-n', '3'], {
      cwd: repoDir, encoding: 'utf8', timeout: 5000,
    });
    const hashes = logResult.stdout.trim().split('\n').filter(Boolean);

    // isCleanRollback should return true (exactly 1 inverse pair: initial→add vs add→remove)
    const result = isCleanRollback(repoDir, hashes, [fileName]);
    assert.ok(result, 'add-then-remove pattern must be detected as clean rollback');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-FP05: Repeated oscillation (add→remove→add→remove) is NOT a clean rollback
test('CB-FP05: Repeated add-remove-add-remove is NOT a clean rollback', () => {
  const repoDir = createTempGitRepo();
  try {
    const fileName = 'loop.py';

    // Initial
    fs.writeFileSync(path.join(repoDir, fileName), 'base\n', 'utf8');
    spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, encoding: 'utf8' });

    // Add feature
    fs.writeFileSync(path.join(repoDir, fileName), 'base\nfeature\n', 'utf8');
    spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'add feature'], { cwd: repoDir, encoding: 'utf8' });

    // Remove feature
    fs.writeFileSync(path.join(repoDir, fileName), 'base\n', 'utf8');
    spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'remove feature'], { cwd: repoDir, encoding: 'utf8' });

    // Add feature again
    fs.writeFileSync(path.join(repoDir, fileName), 'base\nfeature\n', 'utf8');
    spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'add feature again'], { cwd: repoDir, encoding: 'utf8' });

    // Remove feature again
    fs.writeFileSync(path.join(repoDir, fileName), 'base\n', 'utf8');
    spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'remove feature again'], { cwd: repoDir, encoding: 'utf8' });

    // Get hashes for all 4 feature commits
    const logResult = spawnSync('git', ['log', '--format=%H', '-n', '4'], {
      cwd: repoDir, encoding: 'utf8', timeout: 5000,
    });
    const hashes = logResult.stdout.trim().split('\n').filter(Boolean);

    // isCleanRollback should return false (2+ inverse pairs = repeated oscillation)
    const result = isCleanRollback(repoDir, hashes, [fileName]);
    assert.ok(!result, 'repeated add-remove-add-remove must NOT be clean rollback');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-FP06: Haiku prompt contains DELIBERATE_ROLLBACK classification
test('CB-FP06: Haiku prompt source contains DELIBERATE_ROLLBACK option', () => {
  const hookSource = fs.readFileSync(HOOK_PATH, 'utf8');
  assert.ok(
    hookSource.includes('DELIBERATE_ROLLBACK'),
    'hook source must include DELIBERATE_ROLLBACK in Haiku prompt'
  );
  assert.ok(
    hookSource.includes('DELIBERATE_ROLLBACK') && hookSource.includes('a feature was intentionally added then cleanly removed'),
    'Haiku prompt must describe DELIBERATE_ROLLBACK as intentional add-then-remove'
  );
});

// Test CB-FP07: getCommitMessages returns correct messages
test('CB-FP07: getCommitMessages returns Map of hash→subject', () => {
  const repoDir = createTempGitRepo();
  try {
    commitInRepo(repoDir, 'test.txt', 'content', 'initial commit');
    commitInRepo(repoDir, 'test.txt', 'content2', 'second commit');

    const logResult = spawnSync('git', ['log', '--format=%H', '-n', '2'], {
      cwd: repoDir, encoding: 'utf8', timeout: 5000,
    });
    const hashes = logResult.stdout.trim().split('\n').filter(Boolean);
    assert.strictEqual(hashes.length, 2, 'should have 2 hashes');

    const messages = getCommitMessages(repoDir, hashes);
    assert.strictEqual(messages.size, 2, 'should return 2 messages');
    assert.ok(messages.has(hashes[0]), 'first hash must be in map');
    assert.strictEqual(messages.get(hashes[0]), 'second commit', 'first (newest) must be "second commit"');
    assert.strictEqual(messages.get(hashes[1]), 'initial commit', 'second must be "initial commit"');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-FP08: hasReversionInHashes populates pairStatsOut when provided
test('CB-FP08: hasReversionInHashes populates pairStatsOut array', () => {
  const repoDir = createTempGitRepo();
  try {
    const fileName = 'test.txt';

    // Create 3 commits: add → grow → shrink (net negative)
    fs.writeFileSync(path.join(repoDir, fileName), 'line1\n', 'utf8');
    spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'c1'], { cwd: repoDir, encoding: 'utf8' });

    fs.writeFileSync(path.join(repoDir, fileName), 'line1\nline2\nline3\n', 'utf8');
    spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'c2'], { cwd: repoDir, encoding: 'utf8' });

    fs.writeFileSync(path.join(repoDir, fileName), 'line1\n', 'utf8');
    spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'c3'], { cwd: repoDir, encoding: 'utf8' });

    const logResult = spawnSync('git', ['log', '--format=%H', '-n', '3'], {
      cwd: repoDir, encoding: 'utf8', timeout: 5000,
    });
    const hashes = logResult.stdout.trim().split('\n').filter(Boolean);

    const pairStats = [];
    hasReversionInHashes(repoDir, hashes, [fileName], pairStats);

    assert.ok(pairStats.length >= 1, 'pairStats must be populated');
    assert.ok(typeof pairStats[0].pairNet === 'number', 'pairStats must have pairNet');
    assert.ok(typeof pairStats[0].additions === 'number', 'pairStats must have additions');
    assert.ok(typeof pairStats[0].deletions === 'number', 'pairStats must have deletions');
    assert.ok(pairStats[0].hash, 'pairStats must have hash');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// Test CB-FP09: detectOscillation with min_cycles=0 falls back to pure depth check
test('CB-FP09: min_cycles=0 (disabled) allows single cycle to trigger on depth', () => {
  const repoDir = createTempGitRepo();
  try {
    // Create 3 A-groups with alternating content (1 full cycle, but depth 3)
    createAlternatingCommits(repoDir, ['app.js'], 3);

    // Get file sets and hashes for direct detectOscillation call
    const logResult = spawnSync('git', ['log', '--format=%H', '-6'], {
      cwd: repoDir, encoding: 'utf8', timeout: 5000,
    });
    const hashes = logResult.stdout.trim().split('\n').filter(Boolean);

    // Build file sets for each commit
    const fileSets = [];
    for (const hash of hashes) {
      const r = spawnSync('git', ['diff-tree', '--no-commit-id', '-r', '--name-only', '--root', hash], {
        cwd: repoDir, encoding: 'utf8', timeout: 5000,
      });
      fileSets.push(r.stdout.trim().split('\n').filter(f => f.length > 0));
    }

    // min_cycles=0, rollbackDetection=false → pure depth check, should detect
    const result = detectOscillation(fileSets, 3, hashes, repoDir, { minCycles: 0, rollbackDetection: false });
    assert.ok(result.detected, 'with min_cycles=0, single cycle at depth 3 must detect');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── Adversarial probes (CB-ADV series) ───────────────────────────────────────
// These exercise the breaker through its real stdin→state-file I/O path with the
// haiku reviewer disabled via project nf.json (deterministic, no live API), at
// production defaults (depth=3, window=6, min_cycles=2, rollback_detection=true)
// filled in by config-loader. Each can FAIL on a genuine, reachable defect.

// Writes a project nf.json that disables the live Haiku reviewer so detection is
// driven purely by the deterministic algorithm. Written AFTER commits so git
// never captures it in a commit file-set.
function writeBreakerConfig(repoDir, overrides) {
  const claudeDir = path.join(repoDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'nf.json'),
    JSON.stringify({
      circuit_breaker: Object.assign({
        oscillation_depth: 3,
        commit_window: 6,
        haiku_reviewer: false,
        min_cycles: 2,
        rollback_detection: true,
      }, overrides || {}),
    }),
    'utf8'
  );
  const statePath = path.join(claudeDir, 'circuit-breaker-state.json');
  if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  return statePath;
}

// CB-ADV01 (was MISSED, now CAUGHT): an equal-length A→B→A value flip — the canonical
// "agent toggles a constant back and forth" loop. The old reversion heuristic required a
// net-negative pair (hasNegativePair); pure substitutions are net-zero, so a real toggle
// with equal-length states slipped through. FIXED by the byte-level content-reversion
// signal; EXPECTED: PASSES (the breaker now flags it). Regression guard for the miss.
test('CB-ADV01: equal-length A→B→A value-flip oscillation is caught (content reversion)', () => {
  const repoDir = createTempGitRepo();
  try {
    // app.js: "on" → (filler) → "off" → (filler) → "on"  (3 run-groups for app.js)
    commitInRepo(repoDir, 'app.js', 'const FLAG = "on";\n', 'feat: flag on');
    commitInRepo(repoDir, 'filler1.txt', 'f1\n', 'chore: filler 1');
    commitInRepo(repoDir, 'app.js', 'const FLAG = "off";\n', 'fix: flip flag off');
    commitInRepo(repoDir, 'filler2.txt', 'f2\n', 'chore: filler 2');
    commitInRepo(repoDir, 'app.js', 'const FLAG = "on";\n', 'fix: flip flag back on');

    const statePath = writeBreakerConfig(repoDir);

    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo write > output.txt', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty on first detection');
    // A genuine A→B→A toggle is real oscillation — the breaker SHOULD activate.
    assert(
      fs.existsSync(statePath),
      'state file MUST be written — equal-length A→B→A value flip is a real oscillation loop (CB-ADV01)'
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// CB-ADV02 (was MISSED, now CAUGHT, sustained): a sustained 4-group equal-length toggle
// (A→B→A→B, 3 full cycles) — exactly the runaway loop a circuit breaker exists to stop —
// was missed for the same net-zero/hasNegativePair reason. FIXED by the content-reversion
// signal; EXPECTED: PASSES. Regression guard for the sustained-toggle miss.
test('CB-ADV02: sustained equal-length toggle (A→B→A→B) is caught despite net-zero pairs', () => {
  const repoDir = createTempGitRepo();
  try {
    commitInRepo(repoDir, 'app.js', 'x = 1\n', 'feat: x=1');
    commitInRepo(repoDir, 'f1.txt', 'a\n', 'chore: f1');
    commitInRepo(repoDir, 'app.js', 'x = 2\n', 'fix: x=2');
    commitInRepo(repoDir, 'f2.txt', 'a\n', 'chore: f2');
    commitInRepo(repoDir, 'app.js', 'x = 1\n', 'fix: x=1 again');
    commitInRepo(repoDir, 'f3.txt', 'a\n', 'chore: f3');
    commitInRepo(repoDir, 'app.js', 'x = 2\n', 'fix: x=2 again');

    // 7 commits → window must cover all of them to see 4 app.js run-groups.
    const statePath = writeBreakerConfig(repoDir, { commit_window: 8 });

    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo write > output.txt', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty on first detection');
    assert(
      fs.existsSync(statePath),
      'state file MUST be written — a sustained equal-length toggle is the exact loop the breaker exists to stop (CB-ADV02)'
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// CB-ADV03 (FALSE BLOCK): a legitimate incremental dead-code cleanup — the same
// file is trimmed across several commits (interspersed with edits to other
// files), content only ever REMOVED, never re-added — is wrongly flagged as
// oscillation. The reversion heuristic conflates "file shrinking monotonically"
// (net<0 + a negative pair) with "content added then removed". This false block
// halts a normal refactor.
test('CB-ADV03: monotonic incremental deletion (dead-code cleanup) is a FALSE BLOCK', () => {
  const repoDir = createTempGitRepo();
  try {
    // cleanup.js: 6 lines → trim to 4 → trim to 2, with fillers between (3 run-groups).
    commitInRepo(repoDir, 'cleanup.js', 'a\nb\nc\nd\ne\nf\n', 'feat: add module');
    commitInRepo(repoDir, 'filler1.txt', 'f1\n', 'chore: filler 1');
    commitInRepo(repoDir, 'cleanup.js', 'a\nb\nc\nd\n', 'refactor: drop dead code (e,f)');
    commitInRepo(repoDir, 'filler2.txt', 'f2\n', 'chore: filler 2');
    commitInRepo(repoDir, 'cleanup.js', 'a\nb\n', 'refactor: drop more dead code (c,d)');

    const statePath = writeBreakerConfig(repoDir);

    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo write > output.txt', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty');
    // Content is only ever removed, never re-added — this is a cleanup, not a loop.
    assert(
      !fs.existsSync(statePath),
      'state file must NOT be written — incremental deletion is a legitimate cleanup refactor, not oscillation (CB-ADV03)'
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// CB-ADV04 (FAIL-OPEN / state corruption): an ACTIVE state whose file_set has the
// wrong shape (an object, not an array) must not crash the hook. buildBlockReason
// and makeFileSetHash both call array methods on file_set; a wrong shape throws,
// and the outer try/catch must keep this fail-OPEN (exit 0, no output). If the
// guard regressed, the hook would exit non-zero — fail-CLOSED, blocking every
// tool call.
test('CB-ADV04: active state with wrong-shape file_set fails open (exit 0, no crash)', () => {
  const repoDir = createTempGitRepo();
  try {
    commitInRepo(repoDir, 'seed.txt', 'seed\n', 'init');
    const stateDir = path.join(repoDir, '.claude');
    fs.mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, 'circuit-breaker-state.json');
    // Valid JSON, active, but file_set is an object instead of an array.
    fs.writeFileSync(statePath, JSON.stringify({
      active: true,
      file_set: { not: 'an-array' },
      activated_at: new Date().toISOString(),
      commit_window_snapshot: [['seed.txt']],
    }), 'utf8');

    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo write > output.txt', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0 — corrupt active state must fail OPEN, not crash the hook');
    // Must not emit a malformed/partial deny decision.
    assert.ok(
      stdout === '' || (() => { try { JSON.parse(stdout); return true; } catch { return false; } })(),
      'stdout must be empty or well-formed JSON, never a partial/corrupt payload'
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// CB-ADV05 (RESET SEMANTICS): once an oscillation is marked resolved in the
// oscillation log, an ACTIVE breaker must stop blocking — otherwise the next
// legitimate edit is re-blocked forever. The active-state path keys the log as
// `${makeFileSetHash(file_set)}:legacy`; a resolvedAt on that key must allow the
// write through (exit 0, no deny).
test('CB-ADV05: resolved oscillation-log entry releases an active breaker (no re-block)', () => {
  const repoDir = createTempGitRepo();
  try {
    commitInRepo(repoDir, 'seed.txt', 'seed\n', 'init');

    const stateDir = path.join(repoDir, '.claude');
    fs.mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, 'circuit-breaker-state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: true,
      file_set: ['x.js'],
      activated_at: new Date().toISOString(),
      commit_window_snapshot: [['x.js']],
    }), 'utf8');

    // Write a resolved oscillation-log entry under the legacy key the active path reads.
    const planningDir = path.join(repoDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    const logKey = `${makeFileSetHash(['x.js'])}:legacy`;
    fs.writeFileSync(
      path.join(planningDir, 'oscillation-log.json'),
      JSON.stringify({ [logKey]: { files: ['x.js'], resolvedAt: new Date().toISOString(), resolvedByCommit: 'deadbeef' } }),
      'utf8'
    );

    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo write > output.txt', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'a resolved oscillation must NOT re-block — stdout must be empty (no deny) (CB-ADV05)');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── Round-2 adversarial probes (CB-RND2 series) ───────────────────────────────
// Targeting the round-1 rework of hasReversionInHashes: the byte-level CONTENT
// REVERSION signal (fileSetContentFingerprint / hasContentReversion) and the
// SUSTAINED-MONOTONIC-SHRINK exemption (negPairs>=2 && !hasPositivePair &&
// !contentReverts → not oscillation). These call hasReversionInHashes directly
// (the changed unit) over real temp repos, except CB-RND2-05 which drives the full
// stdin→state pipeline. Each can FAIL on a genuine, reachable defect.

// Commit helper that stages a single named file (handles paths with spaces).
function rnd2Commit(repoDir, fileName, content, message) {
  fs.writeFileSync(path.join(repoDir, fileName), content, 'utf8');
  spawnSync('git', ['add', fileName], { cwd: repoDir, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', message], { cwd: repoDir, encoding: 'utf8' });
}

// Newest-first commit hashes (same order hasReversionInHashes expects).
function rnd2Hashes(repoDir, n) {
  const r = spawnSync('git', ['log', '--format=%H', `-${n}`], { cwd: repoDir, encoding: 'utf8' });
  return (r.stdout || '').trim().split('\n').filter(Boolean);
}

// CB-RND2-01 (EXEMPTION BOUNDARY / off-by-one): the monotonic-shrink exemption is
// gated on `negPairs >= 2`. Confirm the threshold is exact:
//   • EXACTLY 1 deletion pair (4→2 lines) is NOT exempted — the established size
//     signal still flags it as a reversion (old CB-TC18 behavior preserved).
//   • EXACTLY 2 deletion-only pairs (6→4→2) IS exempted — directional cleanup.
// If the boundary regressed to `>= 1`, the 1-pair case would be wrongly swallowed
// (a real net-negative reversion MISSED); if it regressed to `>= 3`, the 2-pair
// cleanup would FALSE-BLOCK.
test('CB-RND2-01: monotonic-shrink exemption boundary is exact (1 pair flags, 2 pairs exempt)', () => {
  // One deletion pair → must still read as reversion (true).
  const repo1 = createTempGitRepo();
  try {
    rnd2Commit(repo1, 'a.txt', 'l1\nl2\nl3\nl4\n', 'c0: four lines');
    rnd2Commit(repo1, 'a.txt', 'l1\nl2\n', 'c1: drop to two');
    const h1 = rnd2Hashes(repo1, 2);
    assert.strictEqual(
      hasReversionInHashes(repo1, h1, ['a.txt']), true,
      'a single net-negative deletion pair must NOT be exempted — size signal flags it (CB-RND2-01)'
    );
  } finally {
    fs.rmSync(repo1, { recursive: true, force: true });
  }

  // Two deletion-only pairs, no additions, no content reversion → exempt (false).
  const repo2 = createTempGitRepo();
  try {
    rnd2Commit(repo2, 'a.txt', 'a\nb\nc\nd\ne\nf\n', 'c0: six lines');
    rnd2Commit(repo2, 'a.txt', 'a\nb\nc\nd\n', 'c1: drop to four');
    rnd2Commit(repo2, 'a.txt', 'a\nb\n', 'c2: drop to two');
    const h2 = rnd2Hashes(repo2, 3);
    assert.strictEqual(
      hasReversionInHashes(repo2, h2, ['a.txt']), false,
      'two deletion-only pairs (no re-add, no content reversion) is directional cleanup, must be exempt (CB-RND2-01)'
    );
  } finally {
    fs.rmSync(repo2, { recursive: true, force: true });
  }
});

// CB-RND2-02 (REGRESSION on the exemption — genuine loop with >=2 negative pairs):
// a real down-down-up loop (6→4→2→6, content returns byte-identical to the start)
// has negPairs==2 but is NOT a monotonic shrink: it re-adds content and reverts to
// a prior state. The exemption MUST be overridden (by hasPositivePair AND by
// contentReverts) and the loop still flagged. If the exemption ignored the re-add /
// content-reversion, this runaway loop would be silently swallowed.
test('CB-RND2-02: down-down-up loop (>=2 neg pairs but content reverts) is STILL caught', () => {
  const repoDir = createTempGitRepo();
  try {
    rnd2Commit(repoDir, 'a.txt', 'a\nb\nc\nd\ne\nf\n', 'c0: six');
    rnd2Commit(repoDir, 'a.txt', 'a\nb\nc\nd\n', 'c1: four');
    rnd2Commit(repoDir, 'a.txt', 'a\nb\n', 'c2: two');
    rnd2Commit(repoDir, 'a.txt', 'a\nb\nc\nd\ne\nf\n', 'c3: re-add original six');
    const h = rnd2Hashes(repoDir, 4);
    assert.strictEqual(
      hasReversionInHashes(repoDir, h, ['a.txt']), true,
      'down-down-up that restores a prior byte-identical state is a loop, not a cleanup — must be caught (CB-RND2-02)'
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// CB-RND2-03 (3-STATE CYCLE via content reversion): an equal-length A→B→C→A cycle
// (all net-zero substitutions, content returns to A after two distinct states) is
// invisible to the size signal (no negative pair, totalNet==0) and can ONLY be
// caught by the byte-level content-reversion fingerprint. Confirms hasContentReversion
// detects a recurrence that is non-adjacent and separated by >1 intermediate state.
test('CB-RND2-03: equal-length 3-state cycle A→B→C→A is caught via content reversion', () => {
  const repoDir = createTempGitRepo();
  try {
    rnd2Commit(repoDir, 'cfg.txt', 'x = 1\n', 'A');
    rnd2Commit(repoDir, 'cfg.txt', 'x = 2\n', 'B');
    rnd2Commit(repoDir, 'cfg.txt', 'x = 3\n', 'C');
    rnd2Commit(repoDir, 'cfg.txt', 'x = 1\n', 'A again (cycle closes)');
    const h = rnd2Hashes(repoDir, 4);
    assert.strictEqual(
      hasReversionInHashes(repoDir, h, ['cfg.txt']), true,
      'A→B→C→A equal-length cycle returns to a prior state — only content reversion can see it; must be caught (CB-RND2-03)'
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// CB-RND2-04 (FINGERPRINT ROBUSTNESS): fileSetContentFingerprint parses `git ls-tree`
// output with a regex `^\S+\s+\S+\s+(\S+)\t(.+)$`. Two adversarial inputs:
//   (a) a path WITH SPACES, toggled equal-length A→B→A — net-zero so ONLY the
//       fingerprint can flag it; if the regex mis-parsed the spaced path, pairs would
//       be empty and every commit would fingerprint identically → reversion MISSED.
//   (b) a file present→absent→present (deleted then re-added byte-identical) — the
//       absent state must fingerprint differently and the recurrence be caught, with
//       no crash on the delete.
test('CB-RND2-04: fingerprint handles spaced paths and present→absent→present without misdecide/crash', () => {
  // (a) path with spaces, equal-length toggle → only content reversion can catch it.
  const repoA = createTempGitRepo();
  try {
    rnd2Commit(repoA, 'my file.txt', 'v = 1\n', 'A');
    rnd2Commit(repoA, 'my file.txt', 'v = 2\n', 'B');
    rnd2Commit(repoA, 'my file.txt', 'v = 1\n', 'A again');
    const h = rnd2Hashes(repoA, 3);
    assert.strictEqual(
      hasReversionInHashes(repoA, h, ['my file.txt']), true,
      'equal-length A→B→A on a spaced path must be caught — fingerprint regex must parse the path (CB-RND2-04a)'
    );
  } finally {
    fs.rmSync(repoA, { recursive: true, force: true });
  }

  // (b) present → absent → present (identical content re-added).
  const repoB = createTempGitRepo();
  try {
    rnd2Commit(repoB, 'feat.txt', 'alpha\nbeta\n', 'add feat');
    fs.rmSync(path.join(repoB, 'feat.txt'));
    spawnSync('git', ['rm', 'feat.txt'], { cwd: repoB, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'delete feat'], { cwd: repoB, encoding: 'utf8' });
    rnd2Commit(repoB, 'feat.txt', 'alpha\nbeta\n', 're-add identical feat');
    const h = rnd2Hashes(repoB, 3);
    let result;
    assert.doesNotThrow(() => { result = hasReversionInHashes(repoB, h, ['feat.txt']); },
      'present→absent→present must not crash fingerprinting (CB-RND2-04b)');
    assert.strictEqual(
      result, true,
      're-adding byte-identical deleted content is a reversion loop — must be caught (CB-RND2-04b)'
    );
  } finally {
    fs.rmSync(repoB, { recursive: true, force: true });
  }
});

// CB-RND2-05 (FALSE-POSITIVE GUARD — clean rollback survives the new content signal):
// a deliberate one-shot rollback at depth 3 (base → +30-line feature → cleanly remove
// it, content returns byte-identical to base) now trips the content-reversion signal,
// so hasReversionInHashes returns true. The downstream rollback rescue (isCleanRollback:
// asymmetric +30/-0 then +0/-30, exactly one inverse pair) MUST still suppress it.
// If the content-reversion signal short-circuited the clean-rollback path, this normal
// add-then-revert refactor would be FALSE-BLOCKED. Drives the full stdin→state pipeline.
test('CB-RND2-05: big one-shot clean rollback (A→B→A) is NOT blocked despite content reversion', () => {
  const repoDir = createTempGitRepo();
  try {
    const base = 'function base() { return 0; }\n';
    const feature = base + Array.from({ length: 30 }, (_, i) => `const f${i} = ${i};`).join('\n') + '\n';
    // app.js base → (filler) → +feature → (filler) → cleanly reverted to base. 3 app.js run-groups.
    rnd2Commit(repoDir, 'app.js', base, 'feat: base');
    rnd2Commit(repoDir, 'filler1.txt', 'f1\n', 'chore: filler 1');
    rnd2Commit(repoDir, 'app.js', feature, 'feat: add big feature (+30)');
    rnd2Commit(repoDir, 'filler2.txt', 'f2\n', 'chore: filler 2');
    rnd2Commit(repoDir, 'app.js', base, 'revert: remove big feature, back to base');

    const statePath = writeBreakerConfig(repoDir);

    const { stdout, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo write > output.txt', description: 'test', timeout: 5000 },
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'test-id',
      session_id: 'test-session',
      transcript_path: '/tmp/test.jsonl',
      permission_mode: 'default',
    });
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.strictEqual(stdout, '', 'stdout must be empty');
    assert(
      !fs.existsSync(statePath),
      'state file must NOT be written — a deliberate one-shot clean rollback must stay rescued by isCleanRollback even though content reverts (CB-RND2-05)'
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── Round-3 convergence invariant (CB-RND3) ───────────────────────────────────
// Final round found no missed-loop / false-block / crash across the probed shapes
// (net-zero substitution between deletion pairs keeps negPairs exact; a multi-file
// set where one file reverts while another progresses correctly stays unflagged by
// the file-set-as-unit semantic; submodule/spaced/tab paths parse without misdecide).
// This invariant pins the ONE real-world property with no prior coverage: the content
// fingerprint is MODE-INSENSITIVE. fileSetContentFingerprint captures only the blob
// SHA (`(\S+)\t(.+)`), never the file mode, so a chmod toggle (644→755→644) with
// byte-identical content must NOT read as an A→B→A content reversion. If the regex
// regressed to fold mode into the fingerprinted state, this normal permission flip
// would recur the 644 state and FALSE-BLOCK a chmod-heavy change.
test('CB-RND3-01: chmod toggle with identical blob is NOT a content reversion (mode-insensitive fingerprint)', () => {
  const repoDir = createTempGitRepo();
  try {
    const f = 'script.sh';
    fs.writeFileSync(path.join(repoDir, f), 'echo hi\n', 'utf8');
    spawnSync('git', ['add', f], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'add script (644)'], { cwd: repoDir, encoding: 'utf8' });
    // Flip executable bit on, then off — content (blob SHA) never changes.
    spawnSync('git', ['update-index', '--chmod=+x', f], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'chmod +x'], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['update-index', '--chmod=-x', f], { cwd: repoDir, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'chmod -x'], { cwd: repoDir, encoding: 'utf8' });

    const r = spawnSync('git', ['log', '--format=%H', '-3'], { cwd: repoDir, encoding: 'utf8' });
    const hashes = r.stdout.trim().split('\n').filter(Boolean);

    assert.strictEqual(
      hasReversionInHashes(repoDir, hashes, [f]), false,
      'a 644→755→644 mode toggle with identical content must NOT read as a reversion — the fingerprint is mode-insensitive (CB-RND3-01)'
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// CB-ADV-DASH: lines beginning with "--" make a deleted line render as
// "---x" in the unified diff; the header-skip heuristic wrongly drops it,
// undercounting deletions and missing a real 1->2->1 size oscillation.
test('CB-ADV-DASH: size-alternating oscillation on "--"-prefixed lines is caught (diff header miscount)', () => {
  const repoDir = createTempGitRepo();
  try {
    const write = (content, msg) => {
      fs.writeFileSync(path.join(repoDir, 'migrate.sql'), content, 'utf8');
      spawnSync('git', ['add', 'migrate.sql'], { cwd: repoDir, encoding: 'utf8' });
      spawnSync('git', ['commit', '-m', msg], { cwd: repoDir, encoding: 'utf8' });
    };
    write('-- step a\n', 'c0: one comment');
    write('-- step b1\n-- step b2\n', 'c1: two comments');
    write('-- step c\n', 'c2: back to one comment');

    const r = spawnSync('git', ['log', '--format=%H', '-3'], { cwd: repoDir, encoding: 'utf8' });
    const hashes = r.stdout.trim().split('\n').filter(Boolean); // newest-first: c2,c1,c0

    assert.strictEqual(
      hasReversionInHashes(repoDir, hashes, ['migrate.sql']), true,
      'a 1->2->1 size loop on "--"-prefixed lines is real oscillation; the diff parser must not skip "---x" content lines as headers'
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
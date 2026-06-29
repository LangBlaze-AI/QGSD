'use strict';
// hooks/nf-destructive-git-guard.test.js
// Tests for the destructive git guard PreToolUse hook.

const { describe, it, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK_PATH = path.join(__dirname, 'nf-destructive-git-guard.js');
const { getGitRoot } = require('./nf-destructive-git-guard.js');

function runHook(input) {
  const result = spawnSync('node', [HOOK_PATH], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    exitCode: result.status,
  };
}

function setupRepo() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-dg-test-'));
  spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tempDir, timeout: 5000 });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir, timeout: 5000 });
  // Initial commit so git status works
  fs.writeFileSync(path.join(tempDir, 'init.txt'), 'init\n', 'utf8');
  spawnSync('git', ['add', '.'], { cwd: tempDir, timeout: 5000 });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir, timeout: 5000 });
  return tempDir;
}

// TC-DG-01: Empty stdin -> exits 0 (fail-open)
test('TC-DG-01: empty stdin exits 0 with no stdout (fail-open)', () => {
  const result = spawnSync('node', [HOOK_PATH], {
    input: '',
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.strictEqual(result.status, 0, 'must exit 0');
  assert.strictEqual((result.stdout || '').trim(), '', 'stdout must be empty');
});

// TC-DG-02: Non-Bash tool -> exits 0 (no action)
test('TC-DG-02: non-Bash tool exits 0 silently', () => {
  const { stdout, stderr, exitCode } = runHook({
    tool_name: 'Read',
    tool_input: { file_path: '/tmp/test.txt' },
    hook_event_name: 'PreToolUse',
  });
  assert.strictEqual(exitCode, 0);
  assert.strictEqual(stdout, '');
});

// TC-DG-03: Read-only git command (git log) -> exits 0
test('TC-DG-03: read-only git command (git log) exits 0 silently', () => {
  const tempDir = setupRepo();
  try {
    const { stdout, stderr, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git log --oneline' },
      cwd: tempDir,
      hook_event_name: 'PreToolUse',
    });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(stdout, '');
    assert.ok(!stderr.includes('Destructive git operation'), 'no warning for read-only');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-DG-04: git stash with clean working tree -> exits 0, no warning
test('TC-DG-04: git stash with clean tree exits 0 without warning', () => {
  const tempDir = setupRepo();
  try {
    const { stdout, stderr, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git stash' },
      cwd: tempDir,
      hook_event_name: 'PreToolUse',
    });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(stdout, '');
    assert.ok(!stderr.includes('Destructive git operation'), 'no warning for clean tree');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-DG-05: git stash with dirty working tree -> exits 0 with stderr warning
test('TC-DG-05: git stash with dirty tree exits 0 with stderr warning', () => {
  const tempDir = setupRepo();
  try {
    // Make dirty tree
    fs.writeFileSync(path.join(tempDir, 'dirty.txt'), 'uncommitted\n', 'utf8');
    const { stdout, stderr, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git stash' },
      cwd: tempDir,
      hook_event_name: 'PreToolUse',
    });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(stdout, '', 'stdout must be empty -- warn-only');
    assert.ok(stderr.includes('Destructive git operation'), 'stderr must contain warning');
    assert.ok(stderr.includes('git stash'), 'stderr must mention the command');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-DG-06: git reset --hard with dirty tree -> exits 0 with stderr warning
test('TC-DG-06: git reset --hard with dirty tree exits 0 with stderr warning', () => {
  const tempDir = setupRepo();
  try {
    fs.writeFileSync(path.join(tempDir, 'dirty.txt'), 'uncommitted\n', 'utf8');
    const { stdout, stderr, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git reset --hard HEAD' },
      cwd: tempDir,
      hook_event_name: 'PreToolUse',
    });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(stdout, '', 'stdout must be empty -- warn-only');
    assert.ok(stderr.includes('Destructive git operation'), 'stderr must contain warning');
    assert.ok(stderr.includes('git reset'), 'stderr must mention git reset');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-DG-07: git checkout -- . with dirty tree -> exits 0 with stderr warning
test('TC-DG-07: git checkout -- . with dirty tree exits 0 with stderr warning', () => {
  const tempDir = setupRepo();
  try {
    fs.writeFileSync(path.join(tempDir, 'init.txt'), 'modified\n', 'utf8');
    const { stdout, stderr, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git checkout -- .' },
      cwd: tempDir,
      hook_event_name: 'PreToolUse',
    });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(stdout, '', 'stdout must be empty -- warn-only');
    assert.ok(stderr.includes('Destructive git operation'), 'stderr must contain warning');
    assert.ok(stderr.includes('git checkout'), 'stderr must mention git checkout');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-DG-08: git clean -f with dirty tree -> exits 0 with stderr warning
test('TC-DG-08: git clean -f with dirty tree exits 0 with stderr warning', () => {
  const tempDir = setupRepo();
  try {
    fs.writeFileSync(path.join(tempDir, 'untracked.txt'), 'new file\n', 'utf8');
    const { stdout, stderr, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git clean -f' },
      cwd: tempDir,
      hook_event_name: 'PreToolUse',
    });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(stdout, '', 'stdout must be empty -- warn-only');
    assert.ok(stderr.includes('Destructive git operation'), 'stderr must contain warning');
    assert.ok(stderr.includes('git clean'), 'stderr must mention git clean');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-DG-09: malformed JSON input -> exits 0 (fail-open)
test('TC-DG-09: malformed JSON exits 0 (fail-open)', () => {
  const result = spawnSync('node', [HOOK_PATH], {
    input: '{invalid json',
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.strictEqual(result.status, 0, 'must exit 0');
  assert.strictEqual((result.stdout || '').trim(), '', 'stdout must be empty');
});

// TC-DG-10: chained destructive git (X && git reset --hard) with dirty tree warns
test('TC-DG-10: chained destructive git with dirty tree exits 0 with stderr warning', () => {
  const tempDir = setupRepo();
  try {
    fs.writeFileSync(path.join(tempDir, 'dirty.txt'), 'uncommitted\n', 'utf8');
    const { stdout, stderr, exitCode } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git add -A && git reset --hard HEAD~1' },
      cwd: tempDir,
      hook_event_name: 'PreToolUse',
    });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(stdout, '', 'stdout must be empty -- warn-only');
    assert.ok(
      stderr.includes('Destructive git operation'),
      'must warn when destructive git is chained after another command'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-DG-11: getGitRoot tolerates non-string cwd (returns null, no throw)
test('TC-DG-11: getGitRoot with non-string cwd returns null without throwing', () => {
  assert.strictEqual(getGitRoot(12345), null);
  assert.strictEqual(getGitRoot({}), null);
  assert.strictEqual(getGitRoot([]), null);
});

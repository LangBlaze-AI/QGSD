#!/usr/bin/env node
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const {
  PATHSPECS,
  COMMIT_MSG,
  isGitRepo,
  currentBranch,
  isProtectedBranch,
  stagePaths,
  hasStagedChanges,
  doCommit,
} = require('./solve-commit-artifacts.cjs');

const ROOT = path.resolve(__dirname, '..');

function createTempRepo() {
  const tmp = path.join(os.tmpdir(), 'solve-commit-test-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(path.join(tmp, '.planning', 'formal'), { recursive: true });
  spawnSync('git', ['init'], { encoding: 'utf8', cwd: tmp });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { encoding: 'utf8', cwd: tmp });
  spawnSync('git', ['config', 'user.name', 'Test'], { encoding: 'utf8', cwd: tmp });
  fs.writeFileSync(path.join(tmp, '.planning', 'formal', 'solve-state.json'), '{}');
  spawnSync('git', ['add', '-A'], { encoding: 'utf8', cwd: tmp });
  spawnSync('git', ['commit', '-m', 'init', '--no-verify'], { encoding: 'utf8', cwd: tmp });
  // Work on a non-protected branch so the default-branch guard allows commits.
  spawnSync('git', ['checkout', '-b', 'feature-work'], { encoding: 'utf8', cwd: tmp });
  return tmp;
}

// A temp repo checked out on a normalized "main" branch, for exercising the
// protected-branch guard. `checkout -B main` is deterministic regardless of
// git's init default (main vs master).
function createTempRepoOnMain() {
  const tmp = createTempRepo();
  spawnSync('git', ['checkout', '-B', 'main'], { encoding: 'utf8', cwd: tmp });
  return tmp;
}

function cleanup(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

test('TC-COMMIT-1: PATHSPECS includes .planning/formal/', () => {
  assert.ok(PATHSPECS.some(p => p.includes('.planning/formal')));
});

test('TC-COMMIT-2: COMMIT_MSG is non-empty string', () => {
  assert.ok(typeof COMMIT_MSG === 'string' && COMMIT_MSG.length > 0);
});

test('TC-COMMIT-3: isGitRepo returns true in actual repo', () => {
  assert.equal(isGitRepo(), true);
});

test('TC-COMMIT-4: isGitRepo returns false in non-git dir', () => {
  const tmp = path.join(os.tmpdir(), 'solve-commit-notrepo-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  try {
    assert.equal(isGitRepo({ cwd: tmp }), false);
  } finally {
    cleanup(tmp);
  }
});

test('TC-COMMIT-5: stagePaths stages new file in .planning/formal/', () => {
  const tmp = createTempRepo();
  try {
    fs.writeFileSync(path.join(tmp, '.planning', 'formal', 'test.json'), '{"test":true}');
    stagePaths({ cwd: tmp });
    assert.ok(hasStagedChanges({ cwd: tmp }), 'should have staged changes');
  } finally {
    cleanup(tmp);
  }
});

test('TC-COMMIT-6: hasStagedChanges returns false with no changes', () => {
  const tmp = createTempRepo();
  try {
    assert.equal(hasStagedChanges({ cwd: tmp }), false);
  } finally {
    cleanup(tmp);
  }
});

test('TC-COMMIT-7: --dry-run lists files without committing', () => {
  const tmp = createTempRepo();
  try {
    fs.writeFileSync(path.join(tmp, '.planning', 'formal', 'new-evidence.json'), '{}');
    const r = spawnSync(process.execPath, [
      path.join(ROOT, 'bin', 'solve-commit-artifacts.cjs'),
      '--dry-run',
      '--project-root=' + tmp,
    ], { encoding: 'utf8', cwd: tmp, timeout: 15000 });
    const output = (r.stdout || '').trim();
    assert.ok(output.length > 0, 'dry-run should list files');
    assert.ok(output.includes('new-evidence.json'), 'should mention the new file');
  } finally {
    cleanup(tmp);
  }
});

test('TC-COMMIT-8: --json outputs valid JSON on commit', () => {
  const tmp = createTempRepo();
  try {
    fs.writeFileSync(path.join(tmp, '.planning', 'formal', 'auto-commit-test.json'), '{"committed":true}');
    const r = spawnSync(process.execPath, [
      path.join(ROOT, 'bin', 'solve-commit-artifacts.cjs'),
      '--json',
      '--project-root=' + tmp,
    ], { encoding: 'utf8', cwd: tmp, timeout: 15000 });
    assert.equal(r.status, 0, 'should exit 0');
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.committed, true);
    assert.ok(parsed.hash, 'should have commit hash');
  } finally {
    cleanup(tmp);
  }
});

test('TC-COMMIT-9: --json outputs committed=false when nothing to commit', () => {
  const tmp = createTempRepo();
  try {
    const r = spawnSync(process.execPath, [
      path.join(ROOT, 'bin', 'solve-commit-artifacts.cjs'),
      '--json',
      '--project-root=' + tmp,
    ], { encoding: 'utf8', cwd: tmp, timeout: 15000 });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.committed, false);
    assert.equal(parsed.reason, 'nothing to commit');
  } finally {
    cleanup(tmp);
  }
});

test('TC-COMMIT-11: stagePaths excludes test/golden/ snapshots', () => {
  const tmp = createTempRepo();
  try {
    fs.mkdirSync(path.join(tmp, 'test', 'golden'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'test', 'golden', 'tui-x.txt'), '/Users/local/abs/path\n');
    fs.writeFileSync(path.join(tmp, '.planning', 'formal', 'e.json'), '{}');
    stagePaths({ cwd: tmp });
    const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8', cwd: tmp }).stdout || '';
    assert.ok(staged.includes('.planning/formal/e.json'), 'formal artifact should be staged');
    assert.ok(!staged.includes('test/golden/'), 'golden snapshot must NOT be staged (local-path leak guard)');
  } finally {
    cleanup(tmp);
  }
});

test('TC-COMMIT-12: isProtectedBranch is true on main, false on a feature branch', () => {
  const main = createTempRepoOnMain();
  const feat = createTempRepo();
  try {
    assert.equal(currentBranch({ cwd: main }), 'main');
    assert.equal(isProtectedBranch({ cwd: main }), true);
    assert.equal(isProtectedBranch({ cwd: feat }), false);
  } finally {
    cleanup(main);
    cleanup(feat);
  }
});

test('TC-COMMIT-13: --json refuses to commit on a protected branch and leaves index clean', () => {
  const tmp = createTempRepoOnMain();
  try {
    fs.writeFileSync(path.join(tmp, '.planning', 'formal', 'should-not-commit.json'), '{}');
    const r = spawnSync(process.execPath, [
      path.join(ROOT, 'bin', 'solve-commit-artifacts.cjs'),
      '--json',
      '--project-root=' + tmp,
    ], { encoding: 'utf8', cwd: tmp, timeout: 15000 });
    assert.equal(r.status, 0, 'should exit 0 (non-blocking)');
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.committed, false);
    assert.match(parsed.reason, /protected branch/);
    const staged = (spawnSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8', cwd: tmp }).stdout || '').trim();
    assert.equal(staged, '', 'index must remain clean on a protected branch');
  } finally {
    cleanup(tmp);
  }
});

test('TC-COMMIT-10: nf-solve --no-auto-commit skips commit call', {
  // Heavy: spins up the full nf-solve pipeline, which needs quorum slots and
  // otherwise hits the 90s spawn timeout (status null). Opt-in only so it never
  // destabilizes test:ci (local or CI). Run with RUN_HEAVY_SOLVE_TESTS=1.
  skip: process.env.RUN_HEAVY_SOLVE_TESTS ? false : 'heavy nf-solve integration; set RUN_HEAVY_SOLVE_TESTS=1 to run',
}, () => {
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'bin', 'nf-solve.cjs'),
    '--json', '--report-only', '--fast', '--skip-proximity',
    '--max-iterations=1', '--no-auto-commit',
  ], { encoding: 'utf8', cwd: ROOT, timeout: 90000, maxBuffer: 10 * 1024 * 1024 });
  assert.ok(r.status === 0 || r.status === 1);
  assert.ok(!(r.stderr || '').includes('Auto-commit'), 'should not mention auto-commit');
});

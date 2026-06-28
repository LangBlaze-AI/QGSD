'use strict';
// bin/worktree-merge.test.cjs
// Tests for worktree merge orchestration module.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ensureCleanState,
  mergeBranches,
  verifyMergedState,
  cleanupWorktreeBranches,
  MERGE_TIMEOUT_MS,
} = require('./worktree-merge.cjs');

/**
 * Create a temporary git repo for testing.
 * Returns { dir, cleanup }.
 */
function createTmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-merge-test-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, encoding: 'utf8' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, encoding: 'utf8' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'init.txt'), 'init');
  execFileSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, encoding: 'utf8' });
  return {
    dir,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} },
  };
}

describe('worktree-merge', () => {

  describe('constants', () => {
    it('MERGE_TIMEOUT_MS is 30000', () => {
      assert.equal(MERGE_TIMEOUT_MS, 30000);
    });
  });

  describe('ensureCleanState', () => {
    it('throws when uncommitted changes detected', () => {
      const { dir, cleanup } = createTmpRepo();
      try {
        fs.writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted');
        assert.throws(
          () => ensureCleanState(dir, 'main'),
          { message: 'Uncommitted changes detected -- commit or stash before merge' }
        );
      } finally {
        cleanup();
      }
    });

    it('throws when current branch does not match targetBranch', () => {
      const { dir, cleanup } = createTmpRepo();
      try {
        assert.throws(
          () => ensureCleanState(dir, 'develop'),
          { message: 'Expected branch develop, got main' }
        );
      } finally {
        cleanup();
      }
    });

    it('passes when clean and on correct branch', () => {
      const { dir, cleanup } = createTmpRepo();
      try {
        // Should not throw
        ensureCleanState(dir, 'main');
      } finally {
        cleanup();
      }
    });
  });

  describe('mergeBranches', () => {
    it('returns empty array for empty branches input', () => {
      const result = mergeBranches('/tmp', [], { targetBranch: 'main' });
      assert.deepEqual(result, { branches: [], checkpoint: null });
    });

    it('returns empty array for undefined branches input', () => {
      const result = mergeBranches('/tmp', undefined, { targetBranch: 'main' });
      assert.deepEqual(result, { branches: [], checkpoint: null });
    });

    it('merges branches successfully and records checkpoint (Q-R3.6-3)', () => {
      const { dir, cleanup } = createTmpRepo();
      try {
        const checkpoint = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

        // Create a branch with changes
        execFileSync('git', ['checkout', '-b', 'feature-1'], { cwd: dir, encoding: 'utf8' });
        fs.writeFileSync(path.join(dir, 'feature1.txt'), 'feature 1');
        execFileSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' });
        execFileSync('git', ['commit', '-m', 'add feature 1'], { cwd: dir, encoding: 'utf8' });

        // Go back to main
        execFileSync('git', ['checkout', 'main'], { cwd: dir, encoding: 'utf8' });

        const result = mergeBranches(dir, ['feature-1'], { targetBranch: 'main' });

        assert.equal(result.branches.length, 1);
        assert.equal(result.branches[0].branch, 'feature-1');
        assert.equal(result.branches[0].status, 'merged');
        assert.equal(result.checkpoint, checkpoint);
      } finally {
        cleanup();
      }
    });

    it('calls ensureCleanState before merging (Q-R3.6-2)', () => {
      const { dir, cleanup } = createTmpRepo();
      try {
        // Make the repo dirty
        fs.writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted');

        assert.throws(
          () => mergeBranches(dir, ['some-branch'], { targetBranch: 'main' }),
          { message: 'Uncommitted changes detected -- commit or stash before merge' }
        );
      } finally {
        cleanup();
      }
    });

    it('passes targetBranch to ensureCleanState', () => {
      const { dir, cleanup } = createTmpRepo();
      try {
        // On main but passing wrong target
        assert.throws(
          () => mergeBranches(dir, ['some-branch'], { targetBranch: 'develop' }),
          { message: 'Expected branch develop, got main' }
        );
      } finally {
        cleanup();
      }
    });

    it('handles merge conflict with abort', () => {
      const { dir, cleanup } = createTmpRepo();
      try {
        // Create conflicting branch
        execFileSync('git', ['checkout', '-b', 'conflict-branch'], { cwd: dir, encoding: 'utf8' });
        fs.writeFileSync(path.join(dir, 'init.txt'), 'conflict version');
        execFileSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' });
        execFileSync('git', ['commit', '-m', 'conflicting change'], { cwd: dir, encoding: 'utf8' });

        // Modify same file on main
        execFileSync('git', ['checkout', 'main'], { cwd: dir, encoding: 'utf8' });
        fs.writeFileSync(path.join(dir, 'init.txt'), 'main version');
        execFileSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' });
        execFileSync('git', ['commit', '-m', 'main change'], { cwd: dir, encoding: 'utf8' });

        const result = mergeBranches(dir, ['conflict-branch'], { targetBranch: 'main' });

        assert.equal(result.branches.length, 1);
        assert.equal(result.branches[0].branch, 'conflict-branch');
        assert.equal(result.branches[0].status, 'conflict');
        assert.ok(result.checkpoint);

        // Verify merge was aborted (no merge in progress)
        const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim();
        assert.equal(status, '');
      } finally {
        cleanup();
      }
    });

    it('handles general git error as failed status', () => {
      const { dir, cleanup } = createTmpRepo();
      try {
        const result = mergeBranches(dir, ['nonexistent-branch'], { targetBranch: 'main' });

        assert.equal(result.branches.length, 1);
        assert.equal(result.branches[0].branch, 'nonexistent-branch');
        assert.equal(result.branches[0].status, 'failed');
      } finally {
        cleanup();
      }
    });

    it('does not misclassify a failed merge of a CONFLICT-named branch as a conflict', () => {
      const { dir, cleanup } = createTmpRepo();
      try {
        // Branch does not exist; its name merely contains the substring CONFLICT.
        const result = mergeBranches(dir, ['CONFLICT-marker'], { targetBranch: 'main' });
        assert.equal(result.branches.length, 1);
        assert.equal(result.branches[0].branch, 'CONFLICT-marker');
        assert.equal(result.branches[0].status, 'failed');
      } finally {
        cleanup();
      }
    });

    it('treats a non-array (string) branches argument as a no-op, not char iteration', () => {
      const { dir, cleanup } = createTmpRepo();
      try {
        const result = mergeBranches(dir, 'feature-1', { targetBranch: 'main' });
        assert.deepEqual(result, { branches: [], checkpoint: null });
      } finally {
        cleanup();
      }
    });
  });

  describe('verifyMergedState', () => {
    it('returns pass: true when npm test succeeds', () => {
      const { dir, cleanup } = createTmpRepo();
      try {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
          name: 'test-project',
          scripts: { test: 'echo "pass"' }
        }));
        execFileSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' });
        execFileSync('git', ['commit', '-m', 'add pkg'], { cwd: dir, encoding: 'utf8' });
        const checkpoint = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

        const result = verifyMergedState(dir, checkpoint);
        assert.equal(result.pass, true);
      } finally {
        cleanup();
      }
    });

    it('returns pass: false with rollback when npm test fails (Q-R3.6-3)', () => {
      const { dir, cleanup } = createTmpRepo();
      try {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
          name: 'test-project',
          scripts: { test: 'exit 1' }
        }));
        execFileSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' });
        execFileSync('git', ['commit', '-m', 'add pkg'], { cwd: dir, encoding: 'utf8' });
        const checkpoint = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

        // Make a new commit so rollback has something to revert to
        fs.writeFileSync(path.join(dir, 'extra.txt'), 'extra');
        execFileSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' });
        execFileSync('git', ['commit', '-m', 'extra'], { cwd: dir, encoding: 'utf8' });

        const result = verifyMergedState(dir, checkpoint);
        assert.equal(result.pass, false);
        assert.equal(result.rolledBack, true);
        assert.equal(result.checkpoint, checkpoint);

        // Verify rollback occurred -- HEAD should be at checkpoint
        const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
        assert.equal(currentHead, checkpoint);
      } finally {
        cleanup();
      }
    });
  });

  describe('cleanupWorktreeBranches', () => {
    it('best-effort cleanup -- errors do not throw', () => {
      const { dir, cleanup } = createTmpRepo();
      try {
        const results = cleanupWorktreeBranches(dir, ['nonexistent-1', 'nonexistent-2']);
        assert.equal(results.length, 2);
        assert.equal(results[0].status, 'failed');
        assert.equal(results[1].status, 'failed');
      } finally {
        cleanup();
      }
    });

    it('successfully deletes merged branches and runs worktree prune', () => {
      const { dir, cleanup } = createTmpRepo();
      try {
        // Create and merge a branch
        execFileSync('git', ['checkout', '-b', 'to-delete'], { cwd: dir, encoding: 'utf8' });
        fs.writeFileSync(path.join(dir, 'feature.txt'), 'feature');
        execFileSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' });
        execFileSync('git', ['commit', '-m', 'feature'], { cwd: dir, encoding: 'utf8' });
        execFileSync('git', ['checkout', 'main'], { cwd: dir, encoding: 'utf8' });
        execFileSync('git', ['merge', '--no-ff', 'to-delete', '-m', 'merge'], { cwd: dir, encoding: 'utf8' });

        const results = cleanupWorktreeBranches(dir, ['to-delete']);
        assert.equal(results.length, 1);
        assert.equal(results[0].branch, 'to-delete');
        assert.equal(results[0].status, 'deleted');
      } finally {
        cleanup();
      }
    });

    it('treats a non-array (string) branches argument as a no-op, not char iteration', () => {
      const { dir, cleanup } = createTmpRepo();
      try {
        const results = cleanupWorktreeBranches(dir, 'to-delete');
        assert.deepEqual(results, []);
      } finally {
        cleanup();
      }
    });
  });

  describe('CLI interface', () => {
    it('unknown command exits 0 (fail-open)', () => {
      const result = spawnSync('node', ['bin/worktree-merge.cjs', 'unknown-cmd'], {
        encoding: 'utf8',
        cwd: process.cwd(),
      });
      assert.equal(result.status, 0);
    });

    it('no arguments exits 0', () => {
      const result = spawnSync('node', ['bin/worktree-merge.cjs'], {
        encoding: 'utf8',
        cwd: process.cwd(),
      });
      assert.equal(result.status, 0);
    });

    it('--help exits 0', () => {
      const result = spawnSync('node', ['bin/worktree-merge.cjs', '--help'], {
        encoding: 'utf8',
        cwd: process.cwd(),
      });
      assert.equal(result.status, 0);
    });
  });
});

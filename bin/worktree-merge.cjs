'use strict';
// bin/worktree-merge.cjs
// Merge orchestration for parallel worktree branches.
// Collects branches from parallel worktree executors and merges them
// back into the working branch with conflict detection and fail-open fallback.

const { execFileSync } = require('child_process');

const MERGE_TIMEOUT_MS = 30000; // 30s per merge operation

/**
 * Run a git command with timeout.
 * @param {string} cwd - Working directory
 * @param {string[]} args - Git arguments
 * @returns {string} stdout
 */
function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    timeout: MERGE_TIMEOUT_MS,
    encoding: 'utf8',
  }).trim();
}

/**
 * Ensure the working tree is clean and on the expected branch.
 * Q-R3.6-2: explicit precondition check before any merge operations.
 * @param {string} cwd - Working directory
 * @param {string} targetBranch - Expected branch name
 * @throws {Error} If uncommitted changes or wrong branch
 */
function ensureCleanState(cwd, targetBranch) {
  const status = runGit(cwd, ['status', '--porcelain']);
  if (status.length > 0) {
    throw new Error('Uncommitted changes detected -- commit or stash before merge');
  }

  const actual = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (actual !== targetBranch) {
    throw new Error(`Expected branch ${targetBranch}, got ${actual}`);
  }
}

/**
 * Merge worktree branches into the current branch.
 * Q-R3.6-2: calls ensureCleanState as precondition.
 * Q-R3.6-3: records pre-merge checkpoint for rollback.
 * @param {string} cwd - Working directory
 * @param {string[]} branches - Branch names to merge
 * @param {object} [options] - Options
 * @param {string} [options.targetBranch] - Target branch (defaults to current branch)
 * @returns {{ branches: Array<{branch: string, status: string, error?: string}>, checkpoint: string }}
 */
function mergeBranches(cwd, branches, options) {
  if (!Array.isArray(branches) || branches.length === 0) {
    return { branches: [], checkpoint: null };
  }

  const opts = options || {};
  const targetBranch = opts.targetBranch || runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);

  // Q-R3.6-2: precondition check
  ensureCleanState(cwd, targetBranch);

  // Q-R3.6-3: record pre-merge checkpoint for rollback
  const checkpoint = runGit(cwd, ['rev-parse', 'HEAD']);

  const results = [];

  for (const branch of branches) {
    try {
      runGit(cwd, ['merge', '--no-ff', branch, '-m', `merge: parallel task from ${branch}`]);
      results.push({ branch, status: 'merged' });
    } catch (err) {
      const stderr = err.stderr ? err.stderr.toString() : '';
      const stdout = err.stdout ? err.stdout.toString() : '';
      const combined = stderr + stdout + (err.message || '');
      // Detect real content conflicts via git's specific markers, NOT the bare
      // substring 'CONFLICT' which also appears when the branch NAME contains it.
      if (combined.includes('Automatic merge failed') || combined.includes('CONFLICT (')) {
        // Abort the conflicting merge (git outputs CONFLICT to stdout)
        try { runGit(cwd, ['merge', '--abort']); } catch (_) { /* best-effort */ }
        results.push({ branch, status: 'conflict', error: combined.slice(0, 500) });
      } else {
        results.push({ branch, status: 'failed', error: (stderr || err.message).slice(0, 500) });
      }
    }
  }

  return { branches: results, checkpoint };
}

/**
 * Verify the merged state by running tests.
 * Q-R3.6-3: rolls back to checkpoint on failure.
 * @param {string} cwd - Working directory
 * @param {string} checkpoint - Git commit hash to roll back to on failure
 * @returns {{ pass: boolean, error?: string, rolledBack?: boolean, checkpoint?: string }}
 */
function verifyMergedState(cwd, checkpoint) {
  try {
    execFileSync('npm', ['test'], { cwd, timeout: 120000, encoding: 'utf8' });
    return { pass: true };
  } catch (err) {
    const error = err.stderr ? err.stderr.toString().slice(0, 500) : (err.message || 'test failure');
    process.stderr.write(`[worktree-merge] Verification failed, rolling back to ${checkpoint}\n`);
    try {
      execFileSync('git', ['reset', '--hard', checkpoint], { cwd, encoding: 'utf8' });
    } catch (resetErr) {
      process.stderr.write(`[worktree-merge] Rollback failed: ${resetErr.message}\n`);
    }
    return { pass: false, error, rolledBack: true, checkpoint };
  }
}

/**
 * Clean up worktree branches after merge (best-effort).
 * @param {string} cwd - Working directory
 * @param {string[]} branches - Branch names to delete
 * @returns {Array<{branch: string, status: string, error?: string}>}
 */
function cleanupWorktreeBranches(cwd, branches) {
  const results = [];

  for (const branch of (Array.isArray(branches) ? branches : [])) {
    try {
      runGit(cwd, ['branch', '-d', branch]);
      results.push({ branch, status: 'deleted' });
    } catch (err) {
      results.push({ branch, status: 'failed', error: (err.message || '').slice(0, 200) });
    }
  }

  // Prune stale worktree entries
  try {
    runGit(cwd, ['worktree', 'prune']);
  } catch (_) { /* best-effort */ }

  return results;
}

module.exports = {
  ensureCleanState,
  mergeBranches,
  verifyMergedState,
  cleanupWorktreeBranches,
  MERGE_TIMEOUT_MS,
};

// CLI interface
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const command = args[0];
    const cwd = process.cwd();

    switch (command) {
      case 'merge': {
        const branches = args.slice(1);
        const result = mergeBranches(cwd, branches);
        process.stdout.write(JSON.stringify(result) + '\n');
        break;
      }
      case 'verify': {
        const checkpoint = args[1];
        if (!checkpoint) {
          process.stderr.write('Usage: worktree-merge.cjs verify <checkpoint-hash>\n');
          process.exit(0);
        }
        const result = verifyMergedState(cwd, checkpoint);
        process.stdout.write(JSON.stringify(result) + '\n');
        break;
      }
      case 'cleanup': {
        const branches = args.slice(1);
        const result = cleanupWorktreeBranches(cwd, branches);
        process.stdout.write(JSON.stringify(result) + '\n');
        break;
      }
      case 'ensure-clean': {
        const targetBranch = args[1];
        if (!targetBranch) {
          process.stderr.write('Usage: worktree-merge.cjs ensure-clean <target-branch>\n');
          process.exit(0);
        }
        ensureCleanState(cwd, targetBranch);
        process.stdout.write('Clean state verified\n');
        break;
      }
      case '--help':
      case '-h': {
        process.stderr.write('Usage: worktree-merge.cjs <merge|verify|cleanup|ensure-clean> [args...]\n');
        process.exit(0);
        break;
      }
      default:
        process.stderr.write('Usage: worktree-merge.cjs <merge|verify|cleanup|ensure-clean> [args...]\n');
        process.exit(0);
    }
  } catch (e) {
    process.stderr.write('[worktree-merge] Error: ' + e.message + '\n');
    process.exit(0); // Fail open
  }
}

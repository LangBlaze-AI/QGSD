#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const PATHSPECS = [
  '.planning/formal/',
  '.planning/upstream-state.json',
  'docs/dev/requirements-coverage.md',
  'bin/',
  'test/',
];

// Machine-local / generated snapshots that get regenerated per-developer (golden
// TUI snapshots embed absolute `/Users/...` paths) — never real solve artifacts,
// so they must not be swept into the auto-commit. Applied by un-staging after the
// broad `git add` (mixing `:(exclude)` pathspecs with `git add -A` is unreliable —
// it can silently stage nothing — so we stage then `git reset` these paths out).
const STAGE_EXCLUDE_PATHS = ['test/golden/'];

// Branches the auto-commit must never write to. Solve commits its formal-artifact
// churn (and its own code fixes) on a working branch; committing directly to the
// default branch pollutes it with unpushed churn and breaks branches cut from it.
const PROTECTED_BRANCHES = new Set(['main', 'master']);

const COMMIT_MSG = `chore(solve): update formal verification artifacts

Automated commit from nf-solve — includes layer manifests, gate results,
evidence snapshots, model registry, and requirements coverage updates.`;

function git(args, opts) {
  return spawnSync('git', args, {
    encoding: 'utf8',
    cwd: (opts && opts.cwd) || ROOT,
    timeout: (opts && opts.timeout) || 30000,
    stdio: 'pipe',
  });
}

function isGitRepo(opts) {
  const r = git(['rev-parse', '--is-inside-work-tree'], opts);
  return r.status === 0 && (r.stdout || '').trim() === 'true';
}

function currentBranch(opts) {
  const r = git(['rev-parse', '--abbrev-ref', 'HEAD'], opts);
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

// The repo's default branch via origin/HEAD (e.g. "origin/main" -> "main").
// Returns null when there is no remote (e.g. a fresh test repo).
function defaultBranch(opts) {
  const r = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], opts);
  if (r.status !== 0) return null;
  const name = (r.stdout || '').trim().replace(/^origin\//, '');
  return name || null;
}

// True when committing here would write to a protected/default branch.
// Detached HEAD ("HEAD") is treated as not-protected (allow).
function isProtectedBranch(opts) {
  const cur = currentBranch(opts);
  if (!cur || cur === 'HEAD') return false;
  if (PROTECTED_BRANCHES.has(cur)) return true;
  return cur === defaultBranch(opts);
}

function stagePaths(opts) {
  const cwd = (opts && opts.cwd) || ROOT;
  for (const spec of PATHSPECS) {
    spawnSync('git', ['add', '-A', '--', spec], {
      encoding: 'utf8', cwd, timeout: 15000, stdio: 'pipe',
    });
  }
  // Un-stage machine-local snapshots that the broad add may have swept in.
  for (const ex of STAGE_EXCLUDE_PATHS) {
    spawnSync('git', ['reset', '-q', '--', ex], {
      encoding: 'utf8', cwd, timeout: 15000, stdio: 'pipe',
    });
  }
}

function hasStagedChanges(opts) {
  const r = git(['diff', '--cached', '--quiet'], opts);
  return r.status !== 0;
}

function doCommit(opts) {
  const cwd = (opts && opts.cwd) || ROOT;
  const r = spawnSync('git', ['commit', '-m', COMMIT_MSG, '--no-verify'], {
    encoding: 'utf8', cwd, timeout: 30000, stdio: 'pipe',
  });
  if (r.status !== 0) {
    if ((r.stderr || '').includes('nothing to commit')) {
      return { committed: false, reason: 'nothing staged' };
    }
    return {
      committed: false,
      reason: 'commit failed',
      stderr: (r.stderr || '').trim(),
    };
  }
  const hash = (r.stdout || '').match(/([0-9a-f]{7,})\]/);
  return { committed: true, hash: hash ? hash[1] : null };
}

function main() {
  const argv = process.argv.slice(2);
  const jsonMode = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  const projectRoot = argv.find(a => a.startsWith('--project-root='));
  const cwd = projectRoot ? projectRoot.split('=').slice(1).join('=') : ROOT;
  const opts = { cwd };

  if (!isGitRepo(opts)) {
    const result = { committed: false, reason: 'not a git repo' };
    if (jsonMode) console.log(JSON.stringify(result));
    else process.stderr.write('[solve-commit] Skipping: not a git repo\n');
    process.exit(0);
  }

  if (dryRun) {
    for (const spec of PATHSPECS) {
      const r = spawnSync('git', ['add', '-A', '--dry-run', '--', spec], {
        encoding: 'utf8', cwd, timeout: 15000, stdio: 'pipe',
      });
      if (r.stdout && r.stdout.trim()) {
        // Drop excluded paths from the preview so it matches what actually commits.
        const lines = r.stdout.trim().split('\n')
          .filter(line => !STAGE_EXCLUDE_PATHS.some(ex => line.includes(ex)));
        if (lines.length) console.log(lines.join('\n'));
      }
    }
    process.exit(0);
  }

  if (isProtectedBranch(opts)) {
    const branch = currentBranch(opts);
    const result = { committed: false, reason: 'on protected branch "' + branch + '" — refusing to auto-commit to the default branch' };
    if (jsonMode) console.log(JSON.stringify(result));
    else process.stderr.write('[solve-commit] Skipping: refusing to auto-commit on protected branch "' + branch + '". Run solve on a working branch.\n');
    process.exit(0);
  }

  stagePaths(opts);

  if (!hasStagedChanges(opts)) {
    const result = { committed: false, reason: 'nothing to commit' };
    if (jsonMode) console.log(JSON.stringify(result));
    else process.stderr.write('[solve-commit] Nothing to commit\n');
    process.exit(0);
  }

  const commitResult = doCommit(opts);

  if (!commitResult.committed) {
    if (jsonMode) console.log(JSON.stringify(commitResult));
    else process.stderr.write('[solve-commit] Commit failed: ' + (commitResult.stderr || commitResult.reason) + '\n');
    process.exit(1);
  }

  const result = {
    committed: true,
    hash: commitResult.hash,
    message: COMMIT_MSG.split('\n')[0],
  };

  if (jsonMode) {
    console.log(JSON.stringify(result));
  } else {
    process.stderr.write('[solve-commit] Committed ' + (result.hash || '') + ' — ' + result.message + '\n');
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  PATHSPECS, STAGE_EXCLUDE_PATHS, PROTECTED_BRANCHES, COMMIT_MSG,
  isGitRepo, currentBranch, defaultBranch, isProtectedBranch,
  stagePaths, hasStagedChanges, doCommit,
};

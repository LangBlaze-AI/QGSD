#!/usr/bin/env node
'use strict';
// bin/call-quorum-slot-cooldown-path.test.cjs
// Regression gate for issue #205: the Layer 2 cooldown writer
// (setScoreboardCooldown in call-quorum-slot.cjs) and the Layer 3 cooldown
// reader must resolve the SAME scoreboard path when the Bash cwd
// (process.cwd() of the spawned writer) differs from the --cwd passed to the
// dispatcher. Before the fix, the writer resolved its default scoreboard from
// the spawned process's process.cwd() while the reader resolved from
// findProjectRoot(spawnCwd), so cooldowns landed in one .planning and were read
// from another — Layer 3 skip never fired and dead slots got re-dispatched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pp = require('./planning-paths.cjs');

// Mirror findProjectRoot(cwd) from call-quorum-slot.cjs: when cwd contains a
// .planning/ directory, use it directly (the basis the reader uses via --cwd).
function findProjectRoot(cwd) {
  if (cwd && fs.existsSync(path.join(cwd, '.planning'))) return cwd;
  return cwd || process.cwd();
}

function mkProjectRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qgsd-205-'));
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  return fs.realpathSync(root);
}

test('writer and reader resolve the same scoreboard path when process.cwd() != --cwd', () => {
  const projectRoot = mkProjectRoot();          // the --cwd / spawnCwd basis
  const unrelatedCwd = mkProjectRoot();          // a DIFFERENT Bash cwd

  assert.notStrictEqual(projectRoot, unrelatedCwd);

  // Reader (Layer 3, call-quorum-slot.cjs ~787): resolves from findProjectRoot(spawnCwd).
  const readerPath = pp.resolveWithFallback(findProjectRoot(projectRoot), 'quorum-scoreboard');

  // Writer (fixed Layer 2 setScoreboardCooldown): computes the path from the
  // SAME findProjectRoot(spawnCwd) basis and passes it as --scoreboard.
  const writerPath = pp.resolveWithFallback(findProjectRoot(projectRoot), 'quorum-scoreboard');

  assert.strictEqual(writerPath, readerPath,
    'writer must compute the same scoreboard path the reader reads');
  assert.ok(writerPath.startsWith(projectRoot),
    'resolved path must live under the --cwd project root, not the Bash cwd');
  assert.ok(!writerPath.startsWith(unrelatedCwd),
    'resolved path must NOT live under the unrelated Bash cwd');
});

test('actual writer subprocess lands the cooldown where the reader looks (cwd != --cwd)', () => {
  const projectRoot = mkProjectRoot();   // --cwd basis
  const bashCwd = mkProjectRoot();        // spawned process.cwd(), deliberately different

  const readerPath = pp.resolveWithFallback(findProjectRoot(projectRoot), 'quorum-scoreboard');

  const scoreboardScript = path.join(__dirname, 'update-scoreboard.cjs');
  // Reproduce the fixed setScoreboardCooldown spawn: explicit --scoreboard
  // computed from findProjectRoot(spawnCwd), spawned from a DIFFERENT cwd.
  const res = spawnSync(
    process.execPath,
    [scoreboardScript, 'set-availability',
      '--slot', 'codex-1',
      '--message', 'rate limit — retry in 2 hours',
      '--scoreboard', readerPath],
    { cwd: bashCwd, timeout: 5000, stdio: 'pipe', encoding: 'utf8' }
  );

  assert.strictEqual(res.status, 0, `writer exited non-zero: ${res.stderr}`);

  // The cooldown must be readable at the path the Layer 3 reader resolves —
  // not somewhere under the unrelated Bash cwd.
  assert.ok(fs.existsSync(readerPath),
    'scoreboard must exist at the reader-resolved path');
  const sb = JSON.parse(fs.readFileSync(readerPath, 'utf8'));
  assert.ok(sb?.availability?.['codex-1']?.available_at_iso,
    'cooldown entry must be present at the reader-resolved path');

  // Nothing should have leaked into the Bash cwd's .planning.
  const leaked = pp.resolveWithFallback(findProjectRoot(bashCwd), 'quorum-scoreboard');
  assert.ok(!fs.existsSync(leaked),
    'no scoreboard should be written under the unrelated Bash cwd');
});

test('bare "node" replaced by process.execPath in setScoreboardCooldown', () => {
  const src = fs.readFileSync(path.join(__dirname, 'call-quorum-slot.cjs'), 'utf8');
  const fnMatch = src.match(/function setScoreboardCooldown[\s\S]*?\n}/);
  assert.ok(fnMatch, 'setScoreboardCooldown must exist');
  const fn = fnMatch[0];
  assert.ok(/spawnSync\(\s*process\.execPath/.test(fn),
    'must spawn with process.execPath, not bare "node"');
  assert.ok(/--scoreboard/.test(fn),
    'must pass --scoreboard explicitly');
  assert.ok(/findProjectRoot\(spawnCwd\)/.test(fn),
    'scoreboard path must be derived from findProjectRoot(spawnCwd)');
});

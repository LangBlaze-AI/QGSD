#!/usr/bin/env node
// Test suite for hooks/nf-session-start.js
// Uses Node.js built-in test runner: node --test hooks/nf-session-start.test.js
//
// All tests spawn the hook as a child process with a mock stdin JSON payload.
// The hook has no exports — only subprocess integration tests are possible.
// Timeout is 8000ms to account for async operations (bootstrap secrets sync).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK_PATH = path.join(__dirname, 'nf-session-start.js');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = path.join(
    os.tmpdir(),
    'nf-ss-' + Date.now() + '-' + Math.random().toString(36).slice(2)
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runHook(stdinPayload, opts = {}) {
  const input = stdinPayload === null ? '' : JSON.stringify(stdinPayload);
  const result = spawnSync('node', [HOOK_PATH], {
    input,
    encoding: 'utf8',
    timeout: 8000,
    ...opts,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
    parsed: (() => { try { return JSON.parse(result.stdout); } catch { return null; } })(),
  };
}

// Write a minimal package.json to the given dir.
function writePackageJson(dir, name) {
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name }, null, 2),
    'utf8'
  );
}

// Write pending-fixes.json under .planning/telemetry/ in the given dir.
function writePendingFixes(dir, issues) {
  const telemetryDir = path.join(dir, '.planning', 'telemetry');
  fs.mkdirSync(telemetryDir, { recursive: true });
  fs.writeFileSync(
    path.join(telemetryDir, 'pending-fixes.json'),
    JSON.stringify({ issues }, null, 2),
    'utf8'
  );
}

// Read pending-fixes.json back from disk.
function readPendingFixes(dir) {
  const fixesPath = path.join(dir, '.planning', 'telemetry', 'pending-fixes.json');
  return JSON.parse(fs.readFileSync(fixesPath, 'utf8'));
}

// Write the precompact continuation sidecar under .claude/ in the given dir.
function writeContinuation(dir, content) {
  const claudeDir = path.join(dir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const p = path.join(claudeDir, 'precompact-continuation.txt');
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

function continuationExists(dir) {
  return fs.existsSync(path.join(dir, '.claude', 'precompact-continuation.txt'));
}

// ─── Post-compaction continuation sidecar (CONT-01) ─────────────────────────

test('continuation: source=compact + fresh sidecar → injected via SessionStart channel and consumed', () => {
  const tmpDir = makeTmpDir(); // non-nForma repo: only the continuation piece is present
  writeContinuation(tmpDir, 'nForma CONTINUATION CONTEXT\n\n## Current Position\nPhase: v0.19-05');

  const { exitCode, parsed } = runHook({ cwd: tmpDir, source: 'compact' });

  assert.equal(exitCode, 0, 'hook must exit 0');
  assert.ok(parsed && parsed.hookSpecificOutput, 'must emit SessionStart additionalContext');
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(
    parsed.hookSpecificOutput.additionalContext.includes('nForma CONTINUATION CONTEXT'),
    'continuation context must be injected'
  );
  assert.ok(!continuationExists(tmpDir), 'sidecar must be consumed (deleted) after injection');
});

test('continuation: absent source (post-compact event without source) → still injected', () => {
  const tmpDir = makeTmpDir();
  writeContinuation(tmpDir, 'nForma CONTINUATION CONTEXT\n\nResume at Task 4.');

  const { exitCode, parsed } = runHook({ cwd: tmpDir }); // no source field

  assert.equal(exitCode, 0);
  assert.ok(
    parsed && parsed.hookSpecificOutput.additionalContext.includes('Resume at Task 4'),
    'continuation injected when source is omitted'
  );
  assert.ok(!continuationExists(tmpDir), 'sidecar consumed');
});

test('continuation: source=startup → NOT injected but sidecar cleaned up (one-shot)', () => {
  const tmpDir = makeTmpDir();
  writeContinuation(tmpDir, 'STALE continuation from a prior crashed compaction');

  const { exitCode, stdout } = runHook({ cwd: tmpDir, source: 'startup' });

  assert.equal(exitCode, 0);
  assert.equal(stdout.trim(), '', 'must not inject continuation on a fresh startup');
  assert.ok(!continuationExists(tmpDir), 'stale sidecar must be cleaned up even when not injected');
});

test('continuation: stale sidecar (mtime > 6h) → NOT injected, deleted', () => {
  const tmpDir = makeTmpDir();
  const p = writeContinuation(tmpDir, 'nForma CONTINUATION CONTEXT — too old to use');
  const sevenHoursAgo = (Date.now() - 7 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(p, sevenHoursAgo, sevenHoursAgo);

  const { exitCode, stdout } = runHook({ cwd: tmpDir, source: 'compact' });

  assert.equal(exitCode, 0);
  assert.equal(stdout.trim(), '', 'stale continuation must not be injected');
  assert.ok(!continuationExists(tmpDir), 'stale sidecar deleted');
});

// ─── Subprocess integration tests ───────────────────────────────────────────

test('valid empty JSON stdin → exits 0 (secrets not found, silently skips)', () => {
  // Pass a cwd that is not a nForma repo so telemetry branch also skips.
  const tmpDir = makeTmpDir();
  const { exitCode, stderr } = runHook({ cwd: tmpDir });
  assert.equal(exitCode, 0, 'hook must exit 0 even when secrets module is absent');
  // There should be no hard error in stderr (sync errors are expected-silent here)
  // We allow stderr to contain debug notes but must not crash.
  assert.ok(
    !stderr.includes('TypeError') && !stderr.includes('ReferenceError'),
    'should not throw a JS error on stderr: ' + stderr
  );
});

test('invalid JSON stdin → exits 0 (fail-open)', () => {
  const result = spawnSync('node', [HOOK_PATH], {
    input: 'not valid json {{{',
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.equal(result.status, 0, 'hook must exit 0 on JSON parse failure');
});

test('empty stdin → exits 0 (fail-open)', () => {
  const result = spawnSync('node', [HOOK_PATH], {
    input: '',
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.equal(result.status, 0, 'hook must exit 0 when stdin is empty');
});

test('telemetry: unsurfaced issue with priority >= 50 → outputs additionalContext and marks issue surfaced', () => {
  const tmpDir = makeTmpDir();
  writePackageJson(tmpDir, 'nforma');
  writePendingFixes(tmpDir, [
    {
      id: 'fix-001',
      description: 'Quorum scoreboard drift detected in last 3 sessions',
      action: 'Run node bin/update-scoreboard.cjs --repair',
      priority: 80,
      surfaced: false,
    },
  ]);

  const { exitCode, parsed } = runHook({ cwd: tmpDir });

  assert.equal(exitCode, 0, 'hook must exit 0');
  assert.ok(parsed !== null, 'stdout should be valid JSON');
  assert.ok(parsed.hookSpecificOutput, 'output must have hookSpecificOutput');
  assert.equal(
    parsed.hookSpecificOutput.hookEventName,
    'SessionStart',
    'hookEventName must be SessionStart'
  );

  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.ok(typeof ctx === 'string' && ctx.length > 0, 'additionalContext must be a non-empty string');
  assert.ok(
    ctx.includes('Quorum scoreboard drift detected'),
    'additionalContext must include the issue description'
  );
  assert.ok(
    ctx.includes('priority=80'),
    'additionalContext must include the priority'
  );
  assert.ok(
    ctx.includes('node bin/update-scoreboard.cjs --repair'),
    'additionalContext must include the suggested action'
  );

  // Verify the file was updated on disk to mark the issue surfaced.
  const updated = readPendingFixes(tmpDir);
  const issue = updated.issues[0];
  assert.equal(issue.surfaced, true, 'issue.surfaced must be set to true after surfacing');
  assert.ok(
    typeof issue.surfacedAt === 'string' && issue.surfacedAt.length > 0,
    'issue.surfacedAt must be an ISO timestamp string'
  );
});

test('telemetry: issue already surfaced (surfaced=true) → no additionalContext output', () => {
  const tmpDir = makeTmpDir();
  writePackageJson(tmpDir, 'nforma');
  writePendingFixes(tmpDir, [
    {
      id: 'fix-002',
      description: 'Old issue already surfaced',
      action: 'Nothing to do',
      priority: 90,
      surfaced: true,
      surfacedAt: '2026-02-01T00:00:00.000Z',
    },
  ]);

  const { exitCode, stdout } = runHook({ cwd: tmpDir });

  assert.equal(exitCode, 0, 'hook must exit 0');
  // When no telemetry issue is surfaced the hook writes nothing to stdout.
  assert.equal(stdout.trim(), '', 'stdout must be empty when issue is already surfaced');
});

test('telemetry: priority below 50 → no additionalContext output', () => {
  const tmpDir = makeTmpDir();
  writePackageJson(tmpDir, 'nforma');
  writePendingFixes(tmpDir, [
    {
      id: 'fix-003',
      description: 'Low priority noise item',
      action: 'Ignore for now',
      priority: 30,
      surfaced: false,
    },
  ]);

  const { exitCode, stdout } = runHook({ cwd: tmpDir });

  assert.equal(exitCode, 0, 'hook must exit 0');
  assert.equal(stdout.trim(), '', 'stdout must be empty when issue priority is below 50');
});

test('telemetry: priority exactly 50 → outputs additionalContext (boundary value)', () => {
  const tmpDir = makeTmpDir();
  writePackageJson(tmpDir, 'nforma');
  writePendingFixes(tmpDir, [
    {
      id: 'fix-004',
      description: 'Boundary priority issue at exactly 50',
      action: 'Check threshold logic',
      priority: 50,
      surfaced: false,
    },
  ]);

  const { exitCode, parsed } = runHook({ cwd: tmpDir });

  assert.equal(exitCode, 0, 'hook must exit 0');
  assert.ok(parsed !== null, 'stdout should be valid JSON at boundary priority=50');
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.ok(
    ctx.includes('Boundary priority issue at exactly 50'),
    'additionalContext must include the boundary issue description'
  );
});

test('non-nForma repo (package.json name != "nforma") → no telemetry output', () => {
  const tmpDir = makeTmpDir();
  writePackageJson(tmpDir, 'some-other-project');
  writePendingFixes(tmpDir, [
    {
      id: 'fix-005',
      description: 'Should never be surfaced in non-nForma repo',
      action: 'N/A',
      priority: 99,
      surfaced: false,
    },
  ]);

  const { exitCode, stdout } = runHook({ cwd: tmpDir });

  assert.equal(exitCode, 0, 'hook must exit 0');
  assert.equal(stdout.trim(), '', 'stdout must be empty for non-nForma repo');

  // Verify the file was NOT modified (issue.surfaced remains false).
  const unchanged = readPendingFixes(tmpDir);
  assert.equal(
    unchanged.issues[0].surfaced,
    false,
    'issue.surfaced must remain false when repo is not nForma'
  );
});

test('missing .planning/telemetry/pending-fixes.json → exits 0 silently', () => {
  const tmpDir = makeTmpDir();
  writePackageJson(tmpDir, 'nforma');
  // Do NOT write pending-fixes.json — directory does not even exist.

  const { exitCode, stdout, stderr } = runHook({ cwd: tmpDir });

  assert.equal(exitCode, 0, 'hook must exit 0 when pending-fixes.json is absent');
  assert.equal(stdout.trim(), '', 'stdout must be empty when pending-fixes.json is absent');
  assert.ok(
    !stderr.includes('TypeError') && !stderr.includes('ReferenceError'),
    'no JS error on stderr when telemetry file is absent: ' + stderr
  );
});

test('telemetry: multiple issues, only first unsurfaced high-priority one is surfaced', () => {
  const tmpDir = makeTmpDir();
  writePackageJson(tmpDir, 'nforma');
  writePendingFixes(tmpDir, [
    {
      id: 'fix-low',
      description: 'Low priority skipped item',
      action: 'Skip me',
      priority: 20,
      surfaced: false,
    },
    {
      id: 'fix-surfaced',
      description: 'Already surfaced item',
      action: 'Already done',
      priority: 95,
      surfaced: true,
      surfacedAt: '2026-02-01T00:00:00.000Z',
    },
    {
      id: 'fix-high',
      description: 'High priority unsurfaced item that should be picked',
      action: 'Fix the high priority thing',
      priority: 75,
      surfaced: false,
    },
    {
      id: 'fix-second-high',
      description: 'Second high priority item that should NOT be picked this session',
      action: 'Fix the second thing',
      priority: 70,
      surfaced: false,
    },
  ]);

  const { exitCode, parsed } = runHook({ cwd: tmpDir });

  assert.equal(exitCode, 0, 'hook must exit 0');
  assert.ok(parsed !== null, 'stdout should be valid JSON');
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.ok(
    ctx.includes('High priority unsurfaced item that should be picked'),
    'additionalContext must include the first eligible unsurfaced issue'
  );
  assert.ok(
    !ctx.includes('Second high priority item that should NOT be picked'),
    'additionalContext must NOT include the second unsurfaced issue'
  );

  // Verify only fix-high was marked surfaced on disk.
  const updated = readPendingFixes(tmpDir);
  const fixHigh = updated.issues.find(i => i.id === 'fix-high');
  const fixSecond = updated.issues.find(i => i.id === 'fix-second-high');
  assert.equal(fixHigh.surfaced, true, 'fix-high must be marked surfaced');
  assert.equal(fixSecond.surfaced, false, 'fix-second-high must remain unsurfaced');
});

test('cwd field absent in stdin JSON → exits 0 (defaults to process.cwd, no crash)', () => {
  // Pass an object with no cwd field. The hook should default to process.cwd()
  // and not crash regardless of whether that directory has a nForma package.json.
  const { exitCode } = runHook({});
  assert.equal(exitCode, 0, 'hook must exit 0 when cwd is absent from stdin');
});

// ─── State Reminder Unit Tests ──────────────────────────────────────────────

// Import parseStateForReminder — the require triggers the async IIFE + stdin listener,
// but for unit test purposes we only need the exported function.
const { parseStateForReminder } = require('./nf-session-start.js');

test('parseStateForReminder returns reminder for in-progress phase', () => {
  const content = [
    '## Current Position',
    'Phase: v0.28-04 (Safety & Diagnostics)',
    'Status: In Progress',
    'Plan: 2 of 3',
    'Last activity: 2026-03-06 - Implementing security sweep',
  ].join('\n');
  const result = parseStateForReminder(content);
  assert.ok(result !== null, 'should return a reminder');
  assert.ok(result.includes('SESSION STATE REMINDER'), 'should contain SESSION STATE REMINDER');
  assert.ok(result.includes('v0.28-04'), 'should contain phase number');
  assert.ok(result.includes('2 of 3'), 'should contain plan info');
  assert.ok(result.includes('2026-03-06'), 'should contain last activity');
});

test('parseStateForReminder returns null for completed phase', () => {
  const content = [
    'Phase: v0.28-03',
    'Status: Complete',
    'Plan: 3 of 3',
    'Last activity: 2026-03-05',
  ].join('\n');
  const result = parseStateForReminder(content);
  assert.equal(result, null, 'should return null for completed phase');
});

test('parseStateForReminder returns null for not-started phase', () => {
  const content = [
    'Phase: v0.28-05',
    'Status: Not started',
  ].join('\n');
  const result = parseStateForReminder(content);
  assert.equal(result, null, 'should return null for not-started phase');
});

test('parseStateForReminder returns null for missing Phase field', () => {
  const content = [
    'Status: In Progress',
    'Plan: 1 of 2',
  ].join('\n');
  const result = parseStateForReminder(content);
  assert.equal(result, null, 'should return null when Phase is missing');
});

test('parseStateForReminder handles partial content (no Plan or Last activity)', () => {
  const content = [
    'Phase: v0.28-04',
    'Status: In Progress',
  ].join('\n');
  const result = parseStateForReminder(content);
  assert.ok(result !== null, 'should return a reminder even with partial content');
  assert.ok(result.includes('unknown plan'), 'should use "unknown plan" fallback');
  assert.ok(result.includes('unknown'), 'should use "unknown" for last activity');
});

test('parseStateForReminder returns null for null/undefined input', () => {
  assert.equal(parseStateForReminder(null), null);
  assert.equal(parseStateForReminder(undefined), null);
  assert.equal(parseStateForReminder(''), null);
});

// ─── coderlm auto-start tests ───────────────────────────────────────────────

test('coderlm auto-start: skipped silently when binary absent → exits 0, stdout clean', () => {
  // Point HOME at a tmpdir that has no nf-bin/coderlm binary.
  // The hook must exit 0 and not corrupt stdout.
  const tmpDir = makeTmpDir();
  const { exitCode, stdout, stderr } = runHook({ cwd: tmpDir }, {
    env: { ...process.env, HOME: tmpDir },
  });
  assert.equal(exitCode, 0, 'hook must exit 0 when coderlm binary is absent');
  assert.ok(!stderr.includes('Error'), 'no error output when coderlm is absent');
  // stdout is either empty or valid JSON — not corrupted by the spawn attempt
  if (stdout.trim().length > 0) {
    let parsed;
    try { parsed = JSON.parse(stdout); } catch (e) {
      assert.fail('stdout corrupted by coderlm spawn path: ' + stdout);
    }
    assert.ok(parsed && typeof parsed === 'object', 'parsed stdout must be an object');
  }
});

test('coderlm auto-start: when binary exists, hook still exits 0 and stdout is valid JSON', () => {
  // Create a fake coderlm binary (executable shell script that exits immediately).
  const tmpDir = makeTmpDir();
  const nfBinDir = path.join(tmpDir, '.claude', 'nf-bin');
  fs.mkdirSync(nfBinDir, { recursive: true });
  const fakeBin = path.join(nfBinDir, 'coderlm');
  fs.writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n', 'utf8');
  fs.chmodSync(fakeBin, 0o755);
  // Also create a fake lifecycle script that exits immediately (no actual server spawn).
  const fakeLifecycle = path.join(nfBinDir, 'coderlm-lifecycle.cjs');
  fs.writeFileSync(fakeLifecycle, '#!/usr/bin/env node\nprocess.exit(0);\n', 'utf8');

  const { exitCode, stdout, stderr } = runHook({ cwd: tmpDir }, {
    env: { ...process.env, HOME: tmpDir },
  });
  assert.equal(exitCode, 0, 'hook must exit 0 when coderlm binary exists');
  assert.ok(!stderr.includes('Error'), 'no error output when coderlm is present');
  if (stdout.trim().length > 0) {
    let parsed;
    try { parsed = JSON.parse(stdout); } catch (e) {
      assert.fail('stdout corrupted when coderlm binary is present: ' + stdout);
    }
    assert.ok(parsed && typeof parsed === 'object');
  }
});

test('stdout is either empty or valid JSON (never partial/corrupt output)', () => {
  const tmpDir = makeTmpDir();
  // Repo with a surfaceable issue to exercise the stdout write path.
  writePackageJson(tmpDir, 'nforma');
  writePendingFixes(tmpDir, [
    {
      id: 'fix-json-integrity',
      description: 'Test JSON output integrity',
      action: 'Verify output is parseable',
      priority: 60,
      surfaced: false,
    },
  ]);

  const { stdout, exitCode } = runHook({ cwd: tmpDir });

  assert.equal(exitCode, 0);
  if (stdout.trim().length > 0) {
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      assert.fail('stdout is non-empty but not valid JSON: ' + stdout);
    }
    assert.ok(
      parsed && typeof parsed === 'object',
      'parsed stdout must be an object'
    );
  }
});

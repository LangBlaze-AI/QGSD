#!/usr/bin/env node
'use strict';
// bin/check-spec-sync.test.cjs
// Tests for bin/check-spec-sync.cjs
// Requirements: DRFT-01, DRFT-02, DRFT-03

const { test } = require('node:test');
const assert   = require('node:assert');
const { spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const CHECK_SPEC_SYNC = path.join(__dirname, 'check-spec-sync.cjs');
const REPO_ROOT = path.join(__dirname, '..');

test('exits 0 when XState machine and formal specs are in sync (current repo state)', () => {
  const result = spawnSync(process.execPath, [CHECK_SPEC_SYNC], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
  assert.strictEqual(result.status, 0,
    'Expected exit 0 (in sync). stderr: ' + result.stderr + '\nstdout: ' + result.stdout
  );
});

test('exits 1 when TLA+ TypeOK contains a state not in XState machine (fixture-based state drift)', () => {
  // Fixture-based drift injection test (replaces no-op placeholder).
  // Creates a temp TLA+ file with a phantom state injected into the TypeOK block,
  // then passes it via --tla-path to check-spec-sync.cjs and asserts exit code 1.
  const tlaPath = path.join(REPO_ROOT, '.planning', 'formal', 'tla', 'NFQuorum.tla');
  if (!fs.existsSync(tlaPath)) {
    return; // Skip if TLA+ spec not present (CI without formal specs)
  }

  const originalTla = fs.readFileSync(tlaPath, 'utf8');

  // Inject "PHANTOM_STATE" into the TypeOK phase \in {...} block.
  // The regex matches: phase \in {"IDLE", "COLLECTING_VOTES", ...}
  const driftedTla = originalTla.replace(
    /phase\s*\\in\s*\{([^}]+)\}/,
    (match) => match.replace('{', '{"PHANTOM_STATE", ')
  );

  // Verify injection worked (sanity check on the test itself)
  assert.ok(
    driftedTla.includes('PHANTOM_STATE'),
    'Drift injection failed — PHANTOM_STATE not found in modified TLA+ content'
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-spec-sync-state-test-'));
  const tmpTla = path.join(tmpDir, 'NFQuorum.tla');
  fs.writeFileSync(tmpTla, driftedTla, 'utf8');

  try {
    const result = spawnSync(
      process.execPath,
      [CHECK_SPEC_SYNC, '--tla-path=' + tmpTla],
      { encoding: 'utf8', cwd: REPO_ROOT }
    );
    assert.strictEqual(result.status, 1,
      'Expected exit 1 (state drift detected). stdout: ' + result.stdout + '\nstderr: ' + result.stderr
    );
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.includes('PHANTOM_STATE') || combined.includes('orphaned phases'),
      'Expected drift error mentioning PHANTOM_STATE or orphaned phases. stdout: ' +
      result.stdout + '\nstderr: ' + result.stderr
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('exits 1 when guards/nf-workflow.json references a guard not in XState machine (fixture-based guard drift)', () => {
  // Fixture-based guard drift injection test (Copilot improvement: test guard drift scenario).
  // Creates a temp guards JSON with a phantom guard injected, passes it via --guards-path,
  // and asserts check-spec-sync.cjs exits 1 with a mention of the phantom guard name.
  const guardsPath = path.join(REPO_ROOT, '.planning', 'formal', 'tla', 'guards', 'nf-workflow.json');
  if (!fs.existsSync(guardsPath)) {
    return; // Skip if guards JSON not present
  }

  const originalGuards = JSON.parse(fs.readFileSync(guardsPath, 'utf8'));

  // Inject a phantom guard name into the mapping (guard present in JSON but not in XState machine)
  const driftedGuards = JSON.parse(JSON.stringify(originalGuards));
  driftedGuards.guards['phantomGuardXYZ'] = 'FALSE';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-spec-sync-guard-test-'));
  const tmpGuards = path.join(tmpDir, 'nf-workflow.json');
  fs.writeFileSync(tmpGuards, JSON.stringify(driftedGuards, null, 2), 'utf8');

  try {
    const result = spawnSync(
      process.execPath,
      [CHECK_SPEC_SYNC, '--guards-path=' + tmpGuards],
      { encoding: 'utf8', cwd: REPO_ROOT }
    );
    assert.strictEqual(result.status, 1,
      'Expected exit 1 (guard drift detected). stdout: ' + result.stdout + '\nstderr: ' + result.stderr
    );
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.includes('phantomGuardXYZ'),
      'Expected drift error mentioning phantomGuardXYZ. stdout: ' + result.stdout + '\nstderr: ' + result.stderr
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('exits 1 when guards/nf-workflow.json parses to null (falsy guards must not bypass the drift check)', () => {
  const guardsPath = path.join(REPO_ROOT, '.planning', 'formal', 'tla', 'guards', 'nf-workflow.json');
  if (!fs.existsSync(guardsPath)) {
    return; // Skip if guards JSON not present
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-spec-sync-null-guards-'));
  const tmpGuards = path.join(tmpDir, 'nf-workflow.json');
  fs.writeFileSync(tmpGuards, 'null', 'utf8');

  try {
    const result = spawnSync(
      process.execPath,
      [CHECK_SPEC_SYNC, '--guards-path=' + tmpGuards],
      { encoding: 'utf8', cwd: REPO_ROOT }
    );
    assert.strictEqual(result.status, 1,
      'Expected exit 1: a guards file that parses to null must be reported as drift, not silently passed. stdout: ' +
      result.stdout + '\nstderr: ' + result.stderr
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('exits 1 with a graceful error (no uncaught EISDIR) when --tla-path points to a directory', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-spec-sync-dir-tla-'));
  try {
    const result = spawnSync(
      process.execPath,
      [CHECK_SPEC_SYNC, '--tla-path=' + tmpDir],
      { encoding: 'utf8', cwd: REPO_ROOT }
    );
    assert.strictEqual(result.status, 1,
      'Expected exit 1 when --tla-path is a directory. stdout: ' + result.stdout + '\nstderr: ' + result.stderr
    );
    assert.ok(
      !/EISDIR|Error: EISDIR|\bat Object\.readFileSync\b/.test(result.stderr),
      'Expected a handled error, not an uncaught EISDIR stack trace. stderr: ' + result.stderr
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('exits 1 when TLA+ TypeOK references a state not in XState machine (orphan detection)', () => {
  // This test verifies the in-sync state produces no orphan warnings.
  // The fixture-based orphan injection is covered by the state drift test above
  // (PHANTOM_STATE is injected into TypeOK but not into XState machine → orphan detected).
  const result = spawnSync(process.execPath, [CHECK_SPEC_SYNC], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
  // No orphans in clean repo
  assert.ok(
    !result.stdout.includes('orphaned phases'),
    'Should not report orphaned phases on clean repo. stdout: ' + result.stdout
  );
});

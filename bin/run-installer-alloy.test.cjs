#!/usr/bin/env node
'use strict';
// bin/run-installer-alloy.test.cjs
// Wave 0 RED stubs for bin/run-installer-alloy.cjs error paths.
// All tests check error conditions only — no Java or Alloy JAR invocation.
// Requirements: GAP-7, GAP-8

const { test } = require('node:test');
const assert   = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const { resolveAlloyJar } = require('./resolve-formal-tools.cjs');

const RUN_INSTALLER_ALLOY = path.join(__dirname, 'run-installer-alloy.cjs');

test('exits non-zero and prints JAVA_HOME error when JAVA_HOME points to nonexistent path', () => {
  const result = spawnSync(process.execPath, [RUN_INSTALLER_ALLOY], {
    encoding: 'utf8',
    env: { ...process.env, JAVA_HOME: '/nonexistent/java/path' },
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /JAVA_HOME|java/i);
});

test('exits non-zero and prints Alloy JAR download URL when JAR not found', () => {
  // Need valid Java so run-installer-alloy.cjs passes Java check and reaches JAR check.
  // Detect system Java home: on macOS /usr/libexec/java_home, fallback to JAVA_HOME env.
  const javaHome = process.env.JAVA_HOME ||
    (() => { const r = spawnSync('/usr/libexec/java_home', [], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; })() ||
    null;
  if (!javaHome) { return; }  // skip if no Java — cannot reach JAR check without Java

  if (resolveAlloyJar(path.join(__dirname, '..'))) { return; }  // skip — can't test absent-JAR path when any supported install is present

  const result = spawnSync(process.execPath, [RUN_INSTALLER_ALLOY], {
    encoding: 'utf8',
    env: { ...process.env, JAVA_HOME: javaHome },
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /alloy.*jar|org\.alloytools|download/i);
});

test('exits non-zero with descriptive message for unknown --spec value', () => {
  const result = spawnSync(process.execPath, [RUN_INSTALLER_ALLOY, '--spec=bogus'], {
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /Unknown spec|bogus/i);
});

test('exits non-zero and lists valid specs (install-scope, taxonomy-safety) in error for invalid spec', () => {
  const result = spawnSync(process.execPath, [RUN_INSTALLER_ALLOY, '--spec=invalid'], {
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /install-scope|taxonomy-safety/i);
});

test('records invalid-spec error for prototype-key --spec (no swallowed writeCheckResult)', () => {
  const os = require('os');
  const outPath = path.join(os.tmpdir(), 'nf-alloy-proto-' + process.pid + '-' + Date.now() + '.ndjson');
  try { fs.unlinkSync(outPath); } catch (_) {}
  const result = spawnSync(process.execPath, [RUN_INSTALLER_ALLOY, '--spec=__proto__'], {
    encoding: 'utf8',
    env: { ...process.env, CHECK_RESULTS_PATH: outPath },
  });
  assert.strictEqual(result.status, 1);
  // fail-open writeCheckResult must succeed, not throw on a polluted check_id/property
  assert.doesNotMatch(result.stderr, /failed to write check result/i);
  assert.ok(fs.existsSync(outPath), 'expected an NDJSON error record to be written');
  const rec = JSON.parse(fs.readFileSync(outPath, 'utf8').trim().split('\n').pop());
  assert.strictEqual(rec.check_id, 'alloy:__proto__');
  assert.strictEqual(rec.result, 'error');
  try { fs.unlinkSync(outPath); } catch (_) {}
});

test('records invalid-spec error for empty --spec= value (non-empty property)', () => {
  const os = require('os');
  const outPath = path.join(os.tmpdir(), 'nf-alloy-empty-' + process.pid + '-' + Date.now() + '.ndjson');
  try { fs.unlinkSync(outPath); } catch (_) {}
  const result = spawnSync(process.execPath, [RUN_INSTALLER_ALLOY, '--spec='], {
    encoding: 'utf8',
    env: { ...process.env, CHECK_RESULTS_PATH: outPath },
  });
  assert.strictEqual(result.status, 1);
  assert.doesNotMatch(result.stderr, /failed to write check result/i);
  assert.ok(fs.existsSync(outPath), 'expected an NDJSON error record for empty spec');
  const rec = JSON.parse(fs.readFileSync(outPath, 'utf8').trim().split('\n').pop());
  assert.strictEqual(rec.result, 'error');
  assert.ok(typeof rec.property === 'string' && rec.property.length > 0, 'property must be non-empty');
  try { fs.unlinkSync(outPath); } catch (_) {}
});

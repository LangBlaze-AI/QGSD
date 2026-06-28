#!/usr/bin/env node
'use strict';
// bin/run-audit-alloy.test.cjs
// Wave 0 RED stubs for bin/run-audit-alloy.cjs error paths.
// All tests check error conditions only — no Java or Alloy JAR invocation.
// Requirements: GAP-3, GAP-9

const { test } = require('node:test');
const assert   = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const RUN_AUDIT_ALLOY = path.join(__dirname, 'run-audit-alloy.cjs');
const { resolveAlloyJar } = require('./resolve-formal-tools.cjs');

test('exits non-zero and prints JAVA_HOME error when JAVA_HOME points to nonexistent path', () => {
  const result = spawnSync(process.execPath, [RUN_AUDIT_ALLOY], {
    encoding: 'utf8',
    env: { ...process.env, JAVA_HOME: '/nonexistent/java/path' },
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /JAVA_HOME|java/i);
});

test('exits non-zero and prints Alloy JAR download URL when JAR not found', () => {
  // Need valid Java so run-audit-alloy.cjs passes Java check and reaches JAR check.
  // Detect system Java home: on macOS /usr/libexec/java_home, fallback to JAVA_HOME env.
  const javaHome = process.env.JAVA_HOME ||
    (() => { const r = spawnSync('/usr/libexec/java_home', [], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; })() ||
    null;
  if (!javaHome) { return; }  // skip if no Java — cannot reach JAR check without Java

  if (resolveAlloyJar(path.join(__dirname, '..'))) { return; }  // skip if any supported Alloy JAR resolution path exists

  const result = spawnSync(process.execPath, [RUN_AUDIT_ALLOY], {
    encoding: 'utf8',
    env: { ...process.env, JAVA_HOME: javaHome },
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /alloy.*jar|org\.alloytools|download/i);
});

test('exits non-zero with descriptive message for unknown --spec value', () => {
  const result = spawnSync(process.execPath, [RUN_AUDIT_ALLOY, '--spec=bogus'], {
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /Unknown spec|bogus/i);
});

test('exits non-zero and lists valid specs (scoreboard-recompute, availability-parsing) in error for invalid spec', () => {
  const result = spawnSync(process.execPath, [RUN_AUDIT_ALLOY, '--spec=invalid'], {
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /scoreboard-recompute|availability-parsing/i);
});

test('unknown --spec that is a prototype key (constructor) still records a string check_id error result', () => {
  const os = require('os');
  const outPath = path.join(os.tmpdir(), 'run-audit-alloy-proto-' + process.pid + '.ndjson');
  try { fs.unlinkSync(outPath); } catch (_) {}
  const result = spawnSync(process.execPath, [RUN_AUDIT_ALLOY, '--spec=constructor'], {
    encoding: 'utf8',
    env: { ...process.env, CHECK_RESULTS_PATH: outPath },
  });
  assert.strictEqual(result.status, 1);
  // Fail-open: the unknown-spec path must still write an audit record, never drop the trail.
  const written = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8').trim() : '';
  assert.ok(written.length > 0, 'expected an error check-result to be recorded for prototype-key spec');
  const record = JSON.parse(written.split('\n')[0]);
  assert.strictEqual(typeof record.check_id, 'string');
  assert.strictEqual(record.check_id, 'alloy:constructor');
  try { fs.unlinkSync(outPath); } catch (_) {}
});

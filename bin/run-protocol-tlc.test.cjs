#!/usr/bin/env node
'use strict';
// bin/run-protocol-tlc.test.cjs
// Wave 0 RED stubs for bin/run-protocol-tlc.cjs error paths.
// All tests check error conditions only — no Java or TLC invocation.
// Requirements: GAP-2, GAP-6

const { test } = require('node:test');
const assert   = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');
const { resolveTlaJar } = require('./resolve-formal-tools.cjs');

const RUN_PROTOCOL_TLC = path.join(__dirname, 'run-protocol-tlc.cjs');

test('exits non-zero and prints clear error when JAVA_HOME points to nonexistent path', () => {
  const result = spawnSync(process.execPath, [RUN_PROTOCOL_TLC], {
    encoding: 'utf8',
    env: { ...process.env, JAVA_HOME: '/nonexistent/java/path' },
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /JAVA_HOME|java/i);
});

test('exits non-zero and prints download URL when tla2tools.jar is not found', () => {
  // Need valid Java so run-protocol-tlc.cjs passes Java check and reaches JAR check.
  // Detect system Java home: on macOS /usr/libexec/java_home, fallback to JAVA_HOME env.
  const javaHome = process.env.JAVA_HOME ||
    (() => { const r = spawnSync('/usr/libexec/java_home', [], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; })() ||
    null;
  // If no Java available, skip this test — it cannot reach JAR check without Java.
  if (!javaHome) { return; }  // test is skipped, not failed
  // If the JAR is present on disk (gitignored but downloaded), skip — cannot test absence.
  if (resolveTlaJar(path.join(__dirname, '..'))) { return; }  // test is skipped, not failed
  const result = spawnSync(process.execPath, [RUN_PROTOCOL_TLC], {
    encoding: 'utf8',
    env: { ...process.env, JAVA_HOME: javaHome },
    // No JAR exists in the repo (gitignored) — JAR check fires
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /tla2tools\.jar|github\.com\/tlaplus/i);
});

test('exits non-zero with descriptive message for unknown --config value', () => {
  const result = spawnSync(process.execPath, [RUN_PROTOCOL_TLC, '--config=bogus'], {
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /Unknown config|bogus/i);
});

test('exits non-zero and lists valid configs (MCdeliberation, MCprefilter) in error output for invalid config', () => {
  const result = spawnSync(process.execPath, [RUN_PROTOCOL_TLC, '--config=invalid'], {
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /MCdeliberation|MCprefilter/i);
});

test('MCdeliberation and MCprefilter configs both use -workers 1 (liveness property)', () => {
  const fs = require('fs');
  if (!fs.existsSync(RUN_PROTOCOL_TLC)) {
    assert.fail('run-protocol-tlc.cjs not yet implemented — Wave 0 RED stub');
  }
  const src = fs.readFileSync(RUN_PROTOCOL_TLC, 'utf8');
  // Both configs use workers '1' (both have liveness properties)
  assert.match(src, /workers.*['"]1['"]/s);
  // Verify it does NOT use 'auto' for protocol specs
  assert.doesNotMatch(src, /workers.*['"]auto['"]/s);
});

// LIVE-02: liveness wiring tests (Wave 0 RED stubs — fail until implementation in Wave 1)

test('run-protocol-tlc.cjs requires run-tlc.cjs and destructures detectLivenessProperties', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, 'run-protocol-tlc.cjs'), 'utf8');
  assert.match(src, /require\(['"]\.\/run-tlc\.cjs['"]\)/,
    'run-protocol-tlc.cjs must require ./run-tlc.cjs');
  assert.match(src, /\{\s*detectLivenessProperties\s*\}\s*=\s*require\(['"]\.\/run-tlc\.cjs['"]\)/,
    'run-protocol-tlc.cjs must destructure detectLivenessProperties from ./run-tlc.cjs');
});

test('run-protocol-tlc.cjs calls detectLivenessProperties with configName and cfgPath', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, 'run-protocol-tlc.cjs'), 'utf8');
  assert.match(src, /detectLivenessProperties\s*\(\s*configName\s*,\s*cfgPath\s*\)/,
    'run-protocol-tlc.cjs must call detectLivenessProperties(configName, cfgPath)');
});

test('run-protocol-tlc.cjs has inconclusive writeCheckResult call in source', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, 'run-protocol-tlc.cjs'), 'utf8');
  assert.match(src, /result\s*:\s*['"]inconclusive['"]/,
    'run-protocol-tlc.cjs must have result=inconclusive in writeCheckResult call');
});

test('writes a clean error record for prototype-pollution config names (__proto__) instead of dropping it', () => {
  const fs = require('fs');
  const os = require('os');
  const ndjsonPath = path.join(os.tmpdir(), 'rpt-proto-' + process.pid + '-' + Date.now() + '.ndjson');
  try {
    const result = spawnSync(process.execPath, [RUN_PROTOCOL_TLC, '--config=__proto__'], {
      encoding: 'utf8',
      env: { ...process.env, CHECK_RESULTS_PATH: ndjsonPath },
    });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /Unknown config/i);
    // BUG: CHECK_ID_MAP['__proto__'] === Object.prototype (truthy non-string) makes
    // writeCheckResult throw, so the error audit record is silently dropped.
    assert.doesNotMatch(result.stderr, /failed to write check result/i,
      'error record for __proto__ config must be written, not dropped');
    assert.ok(fs.existsSync(ndjsonPath), 'check-result ndjson must be written for __proto__ config');
    const line = fs.readFileSync(ndjsonPath, 'utf8').trim().split('\n').filter(Boolean).pop();
    const rec = JSON.parse(line);
    assert.strictEqual(rec.result, 'error');
    assert.strictEqual(rec.check_id, 'tla:__proto__');
    assert.strictEqual(typeof rec.property, 'string');
  } finally {
    try { fs.unlinkSync(ndjsonPath); } catch (_) {}
  }
});

test('writes a clean error record for an empty --config= value instead of dropping it', () => {
  const fs = require('fs');
  const os = require('os');
  const ndjsonPath = path.join(os.tmpdir(), 'rpt-empty-' + process.pid + '-' + Date.now() + '.ndjson');
  try {
    const result = spawnSync(process.execPath, [RUN_PROTOCOL_TLC, '--config='], {
      encoding: 'utf8',
      env: { ...process.env, CHECK_RESULTS_PATH: ndjsonPath },
    });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /Unknown config/i);
    // BUG: empty property string makes writeCheckResult throw -> record dropped.
    assert.doesNotMatch(result.stderr, /failed to write check result/i,
      'error record for empty config must be written, not dropped');
    assert.ok(fs.existsSync(ndjsonPath), 'check-result ndjson must be written for empty config');
    const line = fs.readFileSync(ndjsonPath, 'utf8').trim().split('\n').filter(Boolean).pop();
    const rec = JSON.parse(line);
    assert.strictEqual(rec.result, 'error');
    assert.ok(typeof rec.property === 'string' && rec.property.length > 0,
      'property must be a non-empty string');
  } finally {
    try { fs.unlinkSync(ndjsonPath); } catch (_) {}
  }
});

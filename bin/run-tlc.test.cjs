#!/usr/bin/env node
'use strict';
// bin/run-tlc.test.cjs
// Wave 0 RED stubs for bin/run-tlc.cjs error paths.
// All tests check error conditions only — no Java or TLC invocation.
// Requirements: TLA-04

const { test } = require('node:test');
const assert   = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { resolveTlaJar } = require('./resolve-formal-tools.cjs');

const RUN_TLC = path.join(__dirname, 'run-tlc.cjs');

test('exits non-zero and prints clear error when JAVA_HOME points to nonexistent path', () => {
  const result = spawnSync(process.execPath, [RUN_TLC], {
    encoding: 'utf8',
    env: { ...process.env, JAVA_HOME: '/nonexistent/java/path' },
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /JAVA_HOME|java/i);
});

test('exits non-zero and prints download URL when tla2tools.jar is not found', () => {
  // Need valid Java so run-tlc.cjs passes Java check and reaches JAR check.
  // Detect system Java home: on macOS /usr/libexec/java_home, fallback to JAVA_HOME env.
  const javaHome = process.env.JAVA_HOME ||
    (() => { const r = spawnSync('/usr/libexec/java_home', [], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; })() ||
    null;
  // If no Java available, skip this test — it cannot reach JAR check without Java.
  if (!javaHome) { return; }  // test is skipped, not failed
  if (resolveTlaJar(path.join(__dirname, '..'))) { return; }  // skip — can't test absent-JAR path when any supported install is present
  const result = spawnSync(process.execPath, [RUN_TLC], {
    encoding: 'utf8',
    env: { ...process.env, JAVA_HOME: javaHome },
    // No JAR exists in the repo (gitignored) — JAR check fires
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /tla2tools\.jar|github\.com\/tlaplus/i);
});

test('exits non-zero with descriptive message for unknown --config value', () => {
  const result = spawnSync(process.execPath, [RUN_TLC, '--config=bogus'], {
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /Unknown config|bogus/i);
});

test('exits non-zero and reports config file not found for invalid config', () => {
  const result = spawnSync(process.execPath, [RUN_TLC, '--config=invalid'], {
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /Config file not found|invalid\.cfg/i);
});

test('detectLivenessProperties returns [] for config with no PROPERTY lines (safety config)', () => {
  const { detectLivenessProperties } = require('./run-tlc.cjs');
  // MCsafety.cfg has PROPERTY lines but is not in SURFACE_MAP — returns [] for unknown surface
  const cfgPath = path.join(__dirname, '..', '.planning', 'formal', 'tla', 'MCsafety.cfg');
  const result = detectLivenessProperties('MCsafety', cfgPath);
  assert.deepStrictEqual(result, []);
});

test('detectLivenessProperties returns missing property names when invariants.md does not exist', () => {
  const { detectLivenessProperties } = require('./run-tlc.cjs');
  const cfgPath = path.join(__dirname, '..', '.planning', 'formal', 'tla', 'MCliveness.cfg');
  // Use a non-existent specDir to simulate missing invariants.md
  const missingSpecDir = path.join(os.tmpdir(), 'no-such-dir-' + Date.now());
  const result = detectLivenessProperties('MCliveness', cfgPath, missingSpecDir);
  assert.ok(result.includes('EventualConsensus'), 'Expected EventualConsensus in missing list');
});

test('detectLivenessProperties returns [] when invariants.md has matching ## header', () => {
  const { detectLivenessProperties } = require('./run-tlc.cjs');
  const cfgPath = path.join(__dirname, '..', '.planning', 'formal', 'tla', 'MCliveness.cfg');
  // Use the actual .planning/formal/spec/quorum/invariants.md created in Plan 01
  const specDir = path.join(__dirname, '..', '.planning', 'formal', 'spec');
  const result = detectLivenessProperties('MCliveness', cfgPath, specDir);
  assert.deepStrictEqual(result, [], 'Expected no missing declarations when invariants.md is present with correct header');
});

test('detectLivenessProperties returns property name when invariants.md exists but header is missing', () => {
  const { detectLivenessProperties } = require('./run-tlc.cjs');
  const cfgPath = path.join(__dirname, '..', '.planning', 'formal', 'tla', 'MCliveness.cfg');
  // Create a tmp invariants.md with wrong/no header
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlc-test-'));
  const quorumDir = path.join(tmpDir, 'quorum');
  fs.mkdirSync(quorumDir, { recursive: true });
  fs.writeFileSync(path.join(quorumDir, 'invariants.md'), '# Liveness Fairness Declarations\n\n(empty — no entries yet)\n');
  const result = detectLivenessProperties('MCliveness', cfgPath, tmpDir);
  assert.ok(result.includes('EventualConsensus'), 'Expected EventualConsensus in missing list when header absent from invariants.md');
  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('detectLivenessProperties returns [] for MCMCPEnv when invariants.md has ## EventualDecision header', () => {
  const { detectLivenessProperties } = require('./run-tlc.cjs');
  const cfgPath = path.join(__dirname, '..', '.planning', 'formal', 'tla', 'MCMCPEnv.cfg');
  const specDir = path.join(__dirname, '..', '.planning', 'formal', 'spec');
  // MCMCPEnv.cfg should exist (created in v0.19-05); invariants.md with EventualDecision created in this plan
  if (!fs.existsSync(cfgPath)) { return; } // skip if .cfg not present
  // Three-part assertion: SURFACE_MAP resolves the path, the file exists with the section,
  // and detectLivenessProperties returns [] — distinguishes path-miss from declared property.
  const src = fs.readFileSync(path.join(__dirname, 'run-tlc.cjs'), 'utf8');
  assert.match(src, /'MCMCPEnv'.*'mcp-calls'/, 'SURFACE_MAP must have MCMCPEnv -> mcp-calls before testing return value');
  const invPath = path.join(specDir, 'mcp-calls', 'invariants.md');
  assert.ok(fs.existsSync(invPath), '.planning/formal/spec/mcp-calls/invariants.md must exist at the SURFACE_MAP-resolved path');
  const content = fs.readFileSync(invPath, 'utf8');
  assert.ok(content.includes('## EventualDecision'), 'invariants.md must contain ## EventualDecision — absence causes false [] return');
  const result = detectLivenessProperties('MCMCPEnv', cfgPath, specDir);
  assert.deepStrictEqual(result, [], 'MCMCPEnv should have 0 missing fairness declarations');
});

test('detectLivenessProperties does not crash for inherited Object property names as configName', () => {
  const { detectLivenessProperties } = require('./run-tlc.cjs');
  const cfgPath = path.join(__dirname, '..', '.planning', 'formal', 'tla', 'MCliveness.cfg');
  const specDir = path.join(__dirname, '..', '.planning', 'formal', 'spec');
  for (const evil of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    assert.doesNotThrow(
      () => detectLivenessProperties(evil, cfgPath, specDir),
      'configName=' + evil + ' must not throw (SURFACE_MAP[evil] resolves via prototype to a function/object)'
    );
    assert.deepStrictEqual(
      detectLivenessProperties(evil, cfgPath, specDir),
      [],
      'configName=' + evil + ' is an unknown surface — must fail-open to []'
    );
  }
});

test('detectLivenessProperties does not crash when configName is null/undefined/non-string', () => {
  const { detectLivenessProperties } = require('./run-tlc.cjs');
  const cfgPath = path.join(__dirname, '..', '.planning', 'formal', 'tla', 'MCliveness.cfg');
  const specDir = path.join(__dirname, '..', '.planning', 'formal', 'spec');
  for (const bad of [null, undefined, 42]) {
    assert.doesNotThrow(
      () => detectLivenessProperties(bad, cfgPath, specDir),
      'configName=' + String(bad) + ' must not throw on configName.startsWith'
    );
    assert.deepStrictEqual(detectLivenessProperties(bad, cfgPath, specDir), []);
  }
});

test('SURFACE_MAP in run-tlc.cjs contains MCMCPEnv -> mcp-calls entry', () => {
  // Verify SURFACE_MAP has the mcp-calls mapping by checking module source.
  // NOTE: 'MCMCPEnv' in VALID_CONFIGS MUST exactly match this SURFACE_MAP key —
  // any case difference or typo (e.g. 'MCMcpEnv') causes detectLivenessProperties()
  // to silently return [] without ever reaching invariants.md, producing a false negative.
  const src = fs.readFileSync(path.join(__dirname, 'run-tlc.cjs'), 'utf8');
  assert.match(src, /'MCMCPEnv'.*'mcp-calls'/, 'SURFACE_MAP must contain MCMCPEnv entry');
});

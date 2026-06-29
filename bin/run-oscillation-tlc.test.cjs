#!/usr/bin/env node
'use strict';
// bin/run-oscillation-tlc.test.cjs
// Wave 0 RED stubs for bin/run-oscillation-tlc.cjs error paths.
// All tests check error conditions only — no Java or TLC invocation.
// Requirements: GAP-1, GAP-5

const { test } = require('node:test');
const assert   = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');
const { resolveTlaJar } = require('./resolve-formal-tools.cjs');

const RUN_OSCILLATION_TLC = path.join(__dirname, 'run-oscillation-tlc.cjs');

// @requirement DETECT-05
test('exits non-zero and prints clear error when JAVA_HOME points to nonexistent path', () => {
  const result = spawnSync(process.execPath, [RUN_OSCILLATION_TLC], {
    encoding: 'utf8',
    env: { ...process.env, JAVA_HOME: '/nonexistent/java/path' },
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /JAVA_HOME|java/i);
});

test('exits non-zero and prints download URL when tla2tools.jar is not found', () => {
  // Need valid Java so run-oscillation-tlc.cjs passes Java check and reaches JAR check.
  // Detect system Java home: on macOS /usr/libexec/java_home, fallback to JAVA_HOME env.
  const javaHome = process.env.JAVA_HOME ||
    (() => { const r = spawnSync('/usr/libexec/java_home', [], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; })() ||
    null;
  // If no Java available, skip this test — it cannot reach JAR check without Java.
  if (!javaHome) { return; }  // test is skipped, not failed
  // If the JAR is present on disk (gitignored but downloaded), skip — cannot test absence.
  if (resolveTlaJar(path.join(__dirname, '..'))) { return; }  // test is skipped, not failed
  const result = spawnSync(process.execPath, [RUN_OSCILLATION_TLC], {
    encoding: 'utf8',
    env: { ...process.env, JAVA_HOME: javaHome },
    // No JAR exists in the repo (gitignored) — JAR check fires
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /tla2tools\.jar|github\.com\/tlaplus/i);
});

test('exits non-zero with descriptive message for unknown --config value', () => {
  const result = spawnSync(process.execPath, [RUN_OSCILLATION_TLC, '--config=bogus'], {
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /Unknown config|bogus/i);
});

test('exits non-zero and lists valid configs (MCoscillation, MCconvergence) in error output for invalid config', () => {
  const result = spawnSync(process.execPath, [RUN_OSCILLATION_TLC, '--config=invalid'], {
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /MCoscillation|MCconvergence/i);
});

test('both MCoscillation and MCconvergence use -workers 1 (both have liveness PROPERTY)', () => {
  const fs = require('fs');
  if (!fs.existsSync(RUN_OSCILLATION_TLC)) {
    assert.fail('run-oscillation-tlc.cjs not yet implemented — Wave 0 RED stub');
  }
  const src = fs.readFileSync(RUN_OSCILLATION_TLC, 'utf8');
  // GAP-5 fix: both configs have PROPERTY (liveness); workers must always be '1'
  // Assert unconditional workers assignment to '1'
  assert.match(src, /const workers = '1';/);
  // Assert no workers ternary conditional (the spec-file ternary for NFOscillation/NFConvergence
  // is still valid — only the workers ternary must be gone)
  assert.doesNotMatch(src, /workers\s*=\s*configName\s*===\s*['"]MCoscillation['"]\s*\?/);
  // Assert 'auto' is not assigned as the workers value
  assert.doesNotMatch(src, /workers\s*=.*['"]auto['"]/);
});

// LIVE-02: liveness wiring tests (Wave 0 RED stubs — fail until implementation in Wave 1)

test('run-oscillation-tlc.cjs requires run-tlc.cjs and destructures detectLivenessProperties', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, 'run-oscillation-tlc.cjs'), 'utf8');
  // Must require run-tlc.cjs
  assert.match(src, /require\(['"]\.\/run-tlc\.cjs['"]\)/,
    'run-oscillation-tlc.cjs must require ./run-tlc.cjs');
  // Must destructure detectLivenessProperties from it
  assert.match(src, /\{\s*detectLivenessProperties\s*\}\s*=\s*require\(['"]\.\/run-tlc\.cjs['"]\)/,
    'run-oscillation-tlc.cjs must destructure detectLivenessProperties from ./run-tlc.cjs');
});

test('run-oscillation-tlc.cjs calls detectLivenessProperties with configName and cfgPath', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, 'run-oscillation-tlc.cjs'), 'utf8');
  // Must call detectLivenessProperties(configName, cfgPath)
  assert.match(src, /detectLivenessProperties\s*\(\s*configName\s*,\s*cfgPath\s*\)/,
    'run-oscillation-tlc.cjs must call detectLivenessProperties(configName, cfgPath)');
});

test('run-oscillation-tlc.cjs has inconclusive writeCheckResult call in source', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, 'run-oscillation-tlc.cjs'), 'utf8');
  // Must have result: 'inconclusive' in a writeCheckResult call
  assert.match(src, /result\s*:\s*['"]inconclusive['"]/,
    'run-oscillation-tlc.cjs must have result=inconclusive in writeCheckResult call');
});

// ── MCsolve-convergence tests (v0.33-05-02) ──────────────────────────────────

test('MCsolve-convergence is a valid config (no Unknown config error)', () => {
  // Spawn with --config=MCsolve-convergence using bogus JAVA_HOME so it fails
  // at Java check (not config validation). Assert stderr does NOT match /Unknown config/.
  const result = spawnSync(process.execPath, [RUN_OSCILLATION_TLC, '--config=MCsolve-convergence'], {
    encoding: 'utf8',
    env: { ...process.env, JAVA_HOME: '/nonexistent/java/path' },
  });
  // It should fail (exit 1) because JAVA_HOME is bogus, but NOT because of unknown config
  assert.strictEqual(result.status, 1);
  assert.doesNotMatch(result.stderr, /Unknown config/i,
    'MCsolve-convergence should be a valid config — not rejected as unknown');
});

test('MCsolve-convergence maps to NFSolveConvergence.tla spec file', () => {
  const fs = require('fs');
  const src = fs.readFileSync(RUN_OSCILLATION_TLC, 'utf8');
  // SPEC_FILE_MAP must contain the mapping
  assert.match(src, /['"]MCsolve-convergence['"]\s*:\s*['"]NFSolveConvergence\.tla['"]/,
    'SPEC_FILE_MAP must map MCsolve-convergence to NFSolveConvergence.tla');
});

test('All VALID_CONFIGS have entries in SPEC_FILE_MAP and CHECK_ID_MAP', () => {
  const fs = require('fs');
  const src = fs.readFileSync(RUN_OSCILLATION_TLC, 'utf8');

  // Extract VALID_CONFIGS entries
  const validMatch = src.match(/VALID_CONFIGS\s*=\s*\[([^\]]+)\]/);
  assert.ok(validMatch, 'VALID_CONFIGS array must exist in source');
  const validConfigs = validMatch[1].match(/['"]([^'"]+)['"]/g).map(s => s.replace(/['"]/g, ''));

  // Extract SPEC_FILE_MAP keys
  const specMapMatch = src.match(/SPEC_FILE_MAP\s*=\s*\{([^}]+)\}/);
  assert.ok(specMapMatch, 'SPEC_FILE_MAP must exist in source');
  const specMapKeys = specMapMatch[1].match(/['"]([^'"]+)['"]\s*:/g).map(s => s.replace(/['":]/g, '').trim());

  // Extract CHECK_ID_MAP keys
  const checkMapMatch = src.match(/CHECK_ID_MAP\s*=\s*\{([^}]+)\}/);
  assert.ok(checkMapMatch, 'CHECK_ID_MAP must exist in source');
  const checkMapKeys = checkMapMatch[1].match(/['"]([^'"]+)['"]\s*:/g).map(s => s.replace(/['":]/g, '').trim());

  for (const cfg of validConfigs) {
    assert.ok(specMapKeys.includes(cfg),
      `VALID_CONFIGS entry '${cfg}' missing from SPEC_FILE_MAP`);
    assert.ok(checkMapKeys.includes(cfg),
      `VALID_CONFIGS entry '${cfg}' missing from CHECK_ID_MAP`);
  }
});

test('requirement-map.cjs has tla:solve-convergence entry with FV-01, FV-02, FV-03', () => {
  const { getRequirementIds } = require('./requirement-map.cjs');
  const ids = getRequirementIds('tla:solve-convergence');
  assert.deepStrictEqual(ids, ['FV-01', 'FV-02', 'FV-03'],
    'tla:solve-convergence must map to [FV-01, FV-02, FV-03]');
});

// OSC-TLC-01: prototype-pollution config key must not poison the error record
test('unknown config with a prototype-pollution key (__proto__) still records an error check result instead of silently dropping it', () => {
  const fs = require('fs');
  const os = require('os');
  const outFile = path.join(os.tmpdir(), 'nf-osc-tlc-proto-' + process.pid + '-' + Date.now() + '.ndjson');
  try {
    const result = spawnSync(process.execPath, [RUN_OSCILLATION_TLC, '--config=__proto__'], {
      encoding: 'utf8',
      env: { ...process.env, CHECK_RESULTS_PATH: outFile },
    });
    // Still an operator error -> exit 1 with the clear message.
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /Unknown config/i);
    // The poison key must NOT cause writeCheckResult to throw internally.
    assert.doesNotMatch(result.stderr, /failed to write check result/i,
      'prototype-pollution config key must not poison the check_id/property bracket lookup');
    // The structured error record must be recorded, not silently dropped.
    assert.ok(fs.existsSync(outFile), 'an error check-result line must be written');
    const lines = fs.readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1, 'exactly one error record expected');
    const rec = JSON.parse(lines[0]);
    assert.strictEqual(rec.result, 'error');
    assert.strictEqual(rec.check_id, 'tla:__proto__');
    assert.strictEqual(typeof rec.property, 'string');
  } finally {
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  }
});

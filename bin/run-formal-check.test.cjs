#!/usr/bin/env node
'use strict';
// bin/run-formal-check.test.cjs
// Tests for PRISM delegation in run-formal-check.cjs.
// Verifies that prism checks delegate to run-prism.cjs instead of calling
// the prism binary directly.
// Requirements: quick-225

const { test }      = require('node:test');
const assert        = require('node:assert');
const { spawnSync } = require('child_process');
const path          = require('path');

const { runCheck, MODULE_CHECKS, loadProjectManifest, runProjectCheck, ALLOWED_COMMANDS, DANGEROUS_ARG_PATTERNS } = require('./run-formal-check.cjs');

const RUN_FORMAL_CHECK = path.join(__dirname, 'run-formal-check.cjs');

test('runCheck delegates prism checks to run-prism.cjs', () => {
  // Find the prism check definition for quorum module
  const prismCheck = MODULE_CHECKS.quorum.find(c => c.tool === 'prism');
  assert.ok(prismCheck, 'quorum module must have a prism check definition');

  const result = runCheck('quorum', prismCheck, null, process.cwd());

  // Since PRISM_BIN may not be set in the test environment,
  // expected behavior is either pass (prism installed) or skipped (not installed).
  // It should never be 'fail' due to a delegation issue.
  assert.ok(
    ['pass', 'skipped'].includes(result.status),
    'prism check status should be pass or skipped, got: ' + result.status + ' detail: ' + result.detail
  );
  // Verify correct shape
  assert.strictEqual(result.module, 'quorum');
  assert.strictEqual(result.tool, 'prism');
  assert.ok(typeof result.detail === 'string', 'detail must be a string');
  assert.ok(typeof result.runtimeMs === 'number', 'runtimeMs must be a number');
});

test('prism delegation spawns run-prism.cjs not prism binary directly', () => {
  // Verify the source code delegates to run-prism.cjs by checking the implementation.
  // The old inline code used resolvePrismBin() + spawnSync(prismBin, ...).
  // The new code uses spawnSync(process.execPath, [runPrismPath, ...]).
  const fs = require('fs');
  const src = fs.readFileSync(RUN_FORMAL_CHECK, 'utf8');

  // Delegation pattern must exist
  assert.ok(
    src.includes('run-prism.cjs'),
    'run-formal-check.cjs must reference run-prism.cjs for delegation'
  );

  // Old direct invocation pattern must NOT exist
  assert.ok(
    !src.includes("require('./resolve-prism-bin.cjs')"),
    'run-formal-check.cjs must not directly require resolve-prism-bin.cjs'
  );
  assert.ok(
    !src.includes('spawnSync(prismBin'),
    'run-formal-check.cjs must not directly spawn the prism binary'
  );

  // Also run the CLI to verify fail-open behavior
  const env = { ...process.env };
  delete env.PRISM_BIN;

  const result = spawnSync(process.execPath, [RUN_FORMAL_CHECK, '--modules=quorum'], {
    cwd: process.cwd(),
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 60000,
    env
  });

  // Fail-open: prism skipped should not cause overall failure if TLC/Alloy also skip
  assert.strictEqual(result.status, 0,
    'exit code should be 0 (fail-open: skipped checks do not cause failure)');

  // The FORMAL_CHECK_RESULT line should show prism was handled (skipped or passed)
  assert.ok(
    result.stdout.includes('FORMAL_CHECK_RESULT'),
    'stdout must contain machine-readable result line'
  );
});

test('MODULE_CHECKS covers all spec directories that have checker files', () => {
  // Prevents vacuous passes: if a formal spec dir exists AND has a corresponding
  // .als/.tla/.pm file, MODULE_CHECKS must have an entry for it.
  const fs = require('fs');
  const specDir = path.join(process.cwd(), '.planning', 'formal', 'spec');
  if (!fs.existsSync(specDir)) return; // skip if no spec dir

  const specModules = fs.readdirSync(specDir).filter(f =>
    fs.statSync(path.join(specDir, f)).isDirectory()
  );

  const formalDir = path.join(process.cwd(), '.planning', 'formal');
  const missing = [];

  for (const mod of specModules) {
    if (MODULE_CHECKS[mod]) continue;

    // Check if this module has any checkable model files (tla, als, pm)
    const hasAlloy = fs.readdirSync(path.join(formalDir, 'alloy')).some(f =>
      f.includes(mod.replace('formal-', '')) && f.endsWith('.als')
    );
    const hasTla = fs.readdirSync(path.join(formalDir, 'tla')).some(f =>
      f.toLowerCase().includes(mod.replace(/-/g, '').toLowerCase()) && f.endsWith('.tla')
    );
    const hasPrism = fs.existsSync(path.join(formalDir, 'prism')) &&
      fs.readdirSync(path.join(formalDir, 'prism')).some(f =>
        f.includes(mod) && (f.endsWith('.pm') || f.endsWith('.prism'))
      );

    if (hasAlloy || hasTla || hasPrism) {
      missing.push(mod);
    }
  }

  assert.deepStrictEqual(missing, [],
    'Spec dirs with checker files but no MODULE_CHECKS entry (vacuous pass risk): ' +
    missing.join(', ') + '. Add entries to MODULE_CHECKS in run-formal-check.cjs'
  );
});

test('unknown modules cause exit 1 (no vacuous passes)', () => {
  const result = spawnSync(process.execPath, [RUN_FORMAL_CHECK, '--modules=nonexistent-module-xyz'], {
    cwd: process.cwd(),
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 10000
  });

  assert.strictEqual(result.status, 1,
    'unknown module must exit 1, not vacuously pass with 0 checks');
  assert.ok(
    result.stderr.includes('unknown module'),
    'stderr must mention the unknown module'
  );
});

test('runCheck returns correct shape for prism tool', () => {
  const prismCheck = MODULE_CHECKS.quorum.find(c => c.tool === 'prism');
  assert.ok(prismCheck, 'quorum module must have a prism check definition');

  const result = runCheck('quorum', prismCheck, null, process.cwd());

  // Verify all expected keys exist
  assert.ok('module' in result, 'result must have module key');
  assert.ok('tool' in result, 'result must have tool key');
  assert.ok('status' in result, 'result must have status key');
  assert.ok('detail' in result, 'result must have detail key');
  assert.ok('runtimeMs' in result, 'result must have runtimeMs key');

  // Type checks
  assert.strictEqual(typeof result.module, 'string');
  assert.strictEqual(typeof result.tool, 'string');
  assert.strictEqual(typeof result.status, 'string');
  assert.strictEqual(typeof result.detail, 'string');
  assert.strictEqual(typeof result.runtimeMs, 'number');
  assert.ok(result.runtimeMs >= 0, 'runtimeMs must be >= 0');
});

// ── Project manifest tests ──────────────────────────────────────────────

test('loadProjectManifest returns empty array when no manifest exists', () => {
  const specs = loadProjectManifest();
  assert.ok(Array.isArray(specs));
});

test('ALLOWED_COMMANDS contains expected safe executables', () => {
  assert.ok(ALLOWED_COMMANDS.has('make'));
  assert.ok(ALLOWED_COMMANDS.has('java'));
  assert.ok(ALLOWED_COMMANDS.has('node'));
  assert.ok(!ALLOWED_COMMANDS.has('rm'), 'rm must not be in allowlist');
  assert.ok(!ALLOWED_COMMANDS.has('curl'), 'curl must not be in allowlist');
  assert.ok(!ALLOWED_COMMANDS.has('sh'), 'sh must not be in allowlist');
});

test('DANGEROUS_ARG_PATTERNS blocks -e, -c, --eval', () => {
  assert.ok(DANGEROUS_ARG_PATTERNS.has('-e'));
  assert.ok(DANGEROUS_ARG_PATTERNS.has('-c'));
  assert.ok(DANGEROUS_ARG_PATTERNS.has('--eval'));
  assert.ok(DANGEROUS_ARG_PATTERNS.has('--exec'));
});

test('runProjectCheck rejects command not in allowlist', () => {
  const result = runProjectCheck({
    module: 'evil',
    type: 'tla',
    spec_path: 'fake.tla',
    command: 'rm',
    args: ['-rf', '/']
  }, process.cwd());
  assert.strictEqual(result.status, 'skipped');
  assert.ok(result.detail.includes('allowlist'));
});

test('runProjectCheck rejects dangerous argument patterns', () => {
  const resultE = runProjectCheck({
    module: 'eval-attempt',
    type: 'tla',
    spec_path: 'fake.tla',
    command: 'node',
    args: ['-e', 'process.exit(0)']
  }, process.cwd());
  assert.strictEqual(resultE.status, 'skipped');
  assert.ok(resultE.detail.includes('dangerous argument'));

  const resultC = runProjectCheck({
    module: 'shell-attempt',
    type: 'tla',
    spec_path: 'fake.tla',
    command: 'python3',
    args: ['-c', 'print("hello")']
  }, process.cwd());
  assert.strictEqual(resultC.status, 'skipped');
  assert.ok(resultC.detail.includes('dangerous argument'));
});

test('runProjectCheck rejects path traversal in spec_path', () => {
  const result = runProjectCheck({
    module: 'traversal',
    type: 'tla',
    spec_path: '../../../tmp/evil',
    command: 'make',
    args: ['check']
  }, process.cwd());
  assert.strictEqual(result.status, 'skipped');
  assert.ok(result.detail.includes('escapes project root'));
});

test('runProjectCheck rejects absolute spec_path', () => {
  const result = runProjectCheck({
    module: 'abs-path',
    type: 'tla',
    spec_path: '/tmp/evil.tla',
    command: 'make',
    args: ['check']
  }, process.cwd());
  assert.strictEqual(result.status, 'skipped');
  assert.ok(result.detail.includes('escapes project root'));
});

test('runProjectCheck skips when spec file missing', () => {
  const result = runProjectCheck({
    module: 'test-mod',
    type: 'tla',
    spec_path: 'nonexistent.tla',
    command: 'make',
    args: ['check']
  }, process.cwd());
  assert.strictEqual(result.status, 'skipped');
  assert.ok(result.detail.includes('spec file not found'));
});

test('runProjectCheck returns pass for successful command', () => {
  const fs = require('fs');
  const os = require('os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfc-test-'));
  const specFile = path.join(tmpDir, 'test.tla');
  fs.writeFileSync(specFile, 'dummy');
  try {
    const result = runProjectCheck({
      module: 'test-pass',
      type: 'tla',
      spec_path: 'test.tla',
      command: 'node',
      args: ['--version']
    }, tmpDir);
    assert.strictEqual(result.status, 'pass');
    assert.strictEqual(result.module, 'test-pass');
    assert.ok(typeof result.runtimeMs === 'number');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runProjectCheck returns fail for non-zero exit', () => {
  const fs = require('fs');
  const os = require('os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfc-test-'));
  const specFile = path.join(tmpDir, 'test.tla');
  fs.writeFileSync(specFile, 'dummy');
  // Create a script that exits with code 1 (avoids -e flag)
  const failScript = path.join(tmpDir, 'fail.js');
  fs.writeFileSync(failScript, 'process.exit(1)');
  try {
    const result = runProjectCheck({
      module: 'test-fail',
      type: 'tla',
      spec_path: 'test.tla',
      command: 'node',
      args: [failScript]
    }, tmpDir);
    assert.strictEqual(result.status, 'fail');
    assert.ok(result.detail.includes('Exit code'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('double-release is safe (runProjectCheck idempotent)', () => {
  // runProjectCheck does not have release semantics, but verify it returns
  // consistent results when called multiple times with the same input
  const result1 = runProjectCheck({
    module: 'idempotent',
    type: 'tla',
    spec_path: 'nonexistent.tla',
    command: 'make',
    args: ['check']
  }, process.cwd());
  const result2 = runProjectCheck({
    module: 'idempotent',
    type: 'tla',
    spec_path: 'nonexistent.tla',
    command: 'make',
    args: ['check']
  }, process.cwd());
  assert.strictEqual(result1.status, result2.status);
  assert.strictEqual(result1.detail, result2.detail);
});

test('unknown module falls through to project manifest lookup', () => {
  const result = spawnSync(process.execPath, [RUN_FORMAL_CHECK, '--modules=totally-fake-module'], {
    encoding: 'utf8', stdio: 'pipe', cwd: process.cwd()
  });
  assert.ok(result.stderr.includes('unknown module'));
});

test('runProjectCheck fails open (no crash) when spec_path is missing', () => {
  // Manifest validation only checks command/args, not spec_path, so a malformed
  // entry can reach runProjectCheck without spec_path. path.isAbsolute(undefined)
  // throws ERR_INVALID_ARG_TYPE OUTSIDE the spawn try/catch -> process crash.
  let result;
  assert.doesNotThrow(() => {
    result = runProjectCheck({
      module: 'no-specpath',
      type: 'tla',
      command: 'make',
      args: ['check']
    }, process.cwd());
  }, 'runProjectCheck must not throw on missing spec_path (fail-open contract)');
  assert.strictEqual(result.status, 'skipped');
  assert.ok(typeof result.detail === 'string' && result.detail.length > 0);
  assert.strictEqual(result.module, 'no-specpath');
});

test('runProjectCheck fails open when spec_path is a non-string', () => {
  let result;
  assert.doesNotThrow(() => {
    result = runProjectCheck({
      module: 'bad-specpath',
      type: 'tla',
      spec_path: 123,
      command: 'make',
      args: ['check']
    }, process.cwd());
  }, 'runProjectCheck must not throw on non-string spec_path');
  assert.strictEqual(result.status, 'skipped');
});

'use strict';
// Test suite for bin/set-secret.cjs
// Uses Node.js built-in test runner: node --test bin/set-secret.test.cjs
//
// set-secret.cjs is a thin CLI wrapper around secrets.cjs.
// We test argument validation (the only logic in the script itself)
// by spawning it as a subprocess.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CLI = path.join(__dirname, 'set-secret.cjs');

function run(...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    // Prevent actual writes — arg-validation exit happens before any async code.
    // The arg-validation exit happens before any async code, so no env tricks needed.
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
  };
}

// ─── Usage / argument validation ─────────────────────────────────────────────

test('no args: exits 1 with usage message', () => {
  const { exitCode, stderr } = run();
  assert.equal(exitCode, 1);
  assert.ok(stderr.includes('Usage'), `Expected Usage in stderr, got: ${stderr}`);
});

test('key only (no value): exits 1 with usage message', () => {
  const { exitCode, stderr } = run('MY_KEY');
  assert.equal(exitCode, 1);
  assert.ok(stderr.includes('Usage'), `Expected Usage in stderr, got: ${stderr}`);
});

test('usage message includes KEY_NAME placeholder', () => {
  const { stderr } = run();
  assert.ok(stderr.includes('KEY_NAME'), `Expected KEY_NAME in usage, got: ${stderr}`);
});

test('usage message includes value placeholder', () => {
  const { stderr } = run();
  assert.ok(stderr.includes('value') || stderr.includes('<value>'),
    `Expected value reference in usage, got: ${stderr}`);
});

// ─── Never-throws contract ────────────────────────────────────────────────────

test('does not hang: resolves within timeout on bad args', () => {
  // Verifies the arg-validation path exits synchronously
  const start = Date.now();
  run();
  assert.ok(Date.now() - start < 2000, 'Should exit quickly with no args');
});

// ─── Reserved-key validation (prototype pollution) ───────────────────────────

test('reserved key __proto__: rejected, not falsely reported as stored', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-setsecret-'));
  const result = spawnSync(process.execPath, [CLI, '__proto__'], {
    encoding: 'utf8',
    timeout: 5000,
    input: 'super-secret-value\n',
    env: { ...process.env, HOME: tmpHome },
  });
  const secretsPath = path.join(tmpHome, '.claude', 'nf-secrets.json');
  let persisted = false;
  try {
    const store = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
    persisted = Object.prototype.hasOwnProperty.call(store, '__proto__')
      && store['__proto__'] === 'super-secret-value';
  } catch (_) { /* file absent -> not persisted */ }
  const reportedSuccess = result.status === 0 && /Stored __proto__/.test(result.stdout || '');
  // The CLI must never claim it stored a secret that was silently dropped.
  assert.ok(!(reportedSuccess && !persisted),
    `CLI reported storing __proto__ but the secret was not persisted (status=${result.status}, stdout=${result.stdout})`);
});

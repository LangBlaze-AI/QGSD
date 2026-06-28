'use strict';

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'check-results-exit.cjs');

/**
 * Run check-results-exit.cjs with CHECK_RESULTS_PATH set to ndjsonPath.
 */
function run(ndjsonPath) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, CHECK_RESULTS_PATH: ndjsonPath },
  });
}

/**
 * Write NDJSON lines to a temp file and return its path.
 */
function writeTmpNdjson(tmpDir, lines) {
  const tmpFile = path.join(tmpDir, 'check-results.ndjson');
  fs.writeFileSync(tmpFile, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf8');
  return tmpFile;
}

// ─── Test 1: exits 0 when no ndjson file exists ────────────────────────────
test('exits 0 when no ndjson file exists', () => {
  const nonexistent = path.join(os.tmpdir(), 'does-not-exist-' + Date.now() + '.ndjson');
  const result = run(nonexistent);
  assert.strictEqual(result.status, 0, 'Expected exit code 0 when file does not exist');
});

// ─── Test 2: exits 0 when all results are pass ─────────────────────────────
test('exits 0 when all results are pass', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cre-test-'));
  try {
    const ndjsonFile = writeTmpNdjson(tmpDir, [
      JSON.stringify({ tool: 't', formalism: 'tla', result: 'pass', timestamp: new Date().toISOString(), metadata: {} }),
    ]);
    const result = run(ndjsonFile);
    assert.strictEqual(result.status, 0, 'Expected exit code 0 when all pass');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test 3: exits 1 when any result is fail ──────────────────────────────
test('exits 1 when any result is fail', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cre-test-'));
  try {
    const ndjsonFile = writeTmpNdjson(tmpDir, [
      JSON.stringify({ tool: 't', formalism: 'tla', result: 'fail', timestamp: new Date().toISOString(), metadata: {} }),
    ]);
    const result = run(ndjsonFile);
    assert.strictEqual(result.status, 1, 'Expected exit code 1 when any fail');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test 4: exits 0 when all results are warn ────────────────────────────
test('exits 0 when all results are warn', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cre-test-'));
  try {
    const ndjsonFile = writeTmpNdjson(tmpDir, [
      JSON.stringify({ tool: 't', formalism: 'prism', result: 'warn', timestamp: new Date().toISOString(), metadata: {} }),
    ]);
    const result = run(ndjsonFile);
    assert.strictEqual(result.status, 0, 'Expected exit code 0 for warn entries');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test 5: exits 0 when all results are inconclusive ────────────────────
test('exits 0 when all results are inconclusive', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cre-test-'));
  try {
    const ndjsonFile = writeTmpNdjson(tmpDir, [
      JSON.stringify({ tool: 't', formalism: 'trace', result: 'inconclusive', timestamp: new Date().toISOString(), metadata: {} }),
    ]);
    const result = run(ndjsonFile);
    assert.strictEqual(result.status, 0, 'Expected exit code 0 for inconclusive entries');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test 6: prints fail details to stderr on failure ─────────────────────
test('prints fail details to stderr on failure', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cre-test-'));
  try {
    const ndjsonFile = writeTmpNdjson(tmpDir, [
      JSON.stringify({ tool: 'run-tlc', formalism: 'tla', result: 'fail', timestamp: '2026-02-27T12:00:00.000Z', metadata: {} }),
    ]);
    const result = run(ndjsonFile);
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('tool='), 'stderr should include tool=');
    assert.ok(result.stderr.includes('formalism='), 'stderr should include formalism=');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test 7: exits 0 with empty ndjson file ───────────────────────────────
test('exits 0 with empty ndjson file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cre-test-'));
  try {
    const ndjsonFile = path.join(tmpDir, 'check-results.ndjson');
    fs.writeFileSync(ndjsonFile, '', 'utf8');
    const result = run(ndjsonFile);
    assert.strictEqual(result.status, 0, 'Expected exit code 0 for empty file');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test 8: skips corrupt NDJSON line instead of crashing ────────────────
test('skips corrupt NDJSON line instead of crashing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cre-test-'));
  try {
    const ndjsonFile = path.join(tmpDir, 'check-results.ndjson');
    fs.writeFileSync(
      ndjsonFile,
      JSON.stringify({ tool: 't', formalism: 'tla', result: 'pass', timestamp: new Date().toISOString(), metadata: {} }) + '\n' +
      '{ this is not valid json\n',
      'utf8',
    );
    const result = run(ndjsonFile);
    assert.strictEqual(result.status, 0, 'corrupt line should be skipped, not crash');
    assert.ok(!/SyntaxError/.test(result.stderr), 'should not emit a SyntaxError stack');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test 9: does not crash on a JSON null line ───────────────────────────
test('does not crash on a JSON null line', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cre-test-'));
  try {
    const ndjsonFile = writeTmpNdjson(tmpDir, ['null']);
    const result = run(ndjsonFile);
    assert.strictEqual(result.status, 0, 'null line should be ignored, not crash');
    assert.ok(!/TypeError/.test(result.stderr), 'should not emit a TypeError stack');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test 10: exits 1 when a result is error ──────────────────────────────
test('exits 1 when a result is error', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cre-test-'));
  try {
    const ndjsonFile = writeTmpNdjson(tmpDir, [
      JSON.stringify({ tool: 't', formalism: 'tla', result: 'error', timestamp: new Date().toISOString(), metadata: {} }),
    ]);
    const result = run(ndjsonFile);
    assert.strictEqual(result.status, 1, 'an errored check must not pass CI');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

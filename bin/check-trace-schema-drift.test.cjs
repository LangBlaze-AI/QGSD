'use strict';
// bin/check-trace-schema-drift.test.cjs
// Tests for schema drift detection logic.
// Requirements: DRIFT-01, DRIFT-02

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { checkSchemaDrift, KNOWN_EMITTERS } = require('../bin/check-trace-schema-drift.cjs');

// ── Unit tests ────────────────────────────────────────────────────────────────

test('exports checkSchemaDrift and KNOWN_EMITTERS', () => {
  assert.strictEqual(typeof checkSchemaDrift, 'function', 'checkSchemaDrift should be a function');
  assert.ok(Array.isArray(KNOWN_EMITTERS), 'KNOWN_EMITTERS should be an array');
});

test('KNOWN_EMITTERS contains bin/validate-traces.cjs and hooks/nf-stop.js', () => {
  assert.ok(KNOWN_EMITTERS.includes('bin/validate-traces.cjs'), 'should contain bin/validate-traces.cjs');
  assert.ok(KNOWN_EMITTERS.includes('hooks/nf-stop.js'), 'should contain hooks/nf-stop.js');
});

test('checkSchemaDrift([]) => pass, no-schema-change', () => {
  const result = checkSchemaDrift([]);
  assert.strictEqual(result.status, 'pass');
  assert.strictEqual(result.reason, 'no-schema-change');
});

test('checkSchemaDrift([README.md, bin/run-tlc.cjs]) => pass, no-schema-change', () => {
  const result = checkSchemaDrift(['README.md', 'bin/run-tlc.cjs']);
  assert.strictEqual(result.status, 'pass');
  assert.strictEqual(result.reason, 'no-schema-change');
});

test('checkSchemaDrift with schema + validator + emitter => pass, schema-change-atomic', () => {
  const result = checkSchemaDrift([
    '.planning/formal/trace/trace.schema.json',
    'bin/validate-traces.cjs',
    'hooks/nf-stop.js',
  ]);
  assert.strictEqual(result.status, 'pass');
  assert.strictEqual(result.reason, 'schema-change-atomic');
  assert.strictEqual(result.files, 3);
});

test('checkSchemaDrift with schema only => fail, schema-drift-detected (validator_updated=false, emitter_updated=false)', () => {
  const result = checkSchemaDrift(['.planning/formal/trace/trace.schema.json']);
  assert.strictEqual(result.status, 'fail');
  assert.strictEqual(result.reason, 'schema-drift-detected');
  assert.strictEqual(result.validator_updated, false);
  assert.strictEqual(result.emitter_updated, false);
});

test('checkSchemaDrift with schema + validator only => fail, schema-drift-detected (emitter_updated=false)', () => {
  const result = checkSchemaDrift(['.planning/formal/trace/trace.schema.json', 'bin/validate-traces.cjs']);
  assert.strictEqual(result.status, 'fail');
  assert.strictEqual(result.reason, 'schema-drift-detected');
  assert.strictEqual(result.validator_updated, true);
  assert.strictEqual(result.emitter_updated, false);
});

test('checkSchemaDrift with schema + emitter only => fail, schema-drift-detected (validator_updated=false)', () => {
  const result = checkSchemaDrift(['.planning/formal/trace/trace.schema.json', 'hooks/nf-stop.js']);
  assert.strictEqual(result.status, 'fail');
  assert.strictEqual(result.reason, 'schema-drift-detected');
  assert.strictEqual(result.validator_updated, false);
  assert.strictEqual(result.emitter_updated, true);
});

test('checkSchemaDrift(undefined) => pass, no-schema-change (no crash)', () => {
  const result = checkSchemaDrift(undefined);
  assert.strictEqual(result.status, 'pass');
  assert.strictEqual(result.reason, 'no-schema-change');
});

test('checkSchemaDrift(null) does not throw', () => {
  assert.doesNotThrow(() => checkSchemaDrift(null));
  const result = checkSchemaDrift(null);
  assert.strictEqual(result.status, 'pass');
  assert.strictEqual(result.reason, 'no-schema-change');
});

test('checkSchemaDrift with non-string entries does not throw and still detects drift', () => {
  let result;
  assert.doesNotThrow(() => {
    result = checkSchemaDrift([null, 42, '.planning/formal/trace/trace.schema.json']);
  });
  assert.strictEqual(result.status, 'fail');
  assert.strictEqual(result.reason, 'schema-drift-detected');
  assert.strictEqual(result.validator_updated, false);
  assert.strictEqual(result.emitter_updated, false);
});

// ── Integration test ──────────────────────────────────────────────────────────

test('integration: node bin/check-trace-schema-drift.cjs exits 0 or 1 and writes NDJSON', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-schema-drift-test-'));
  const ndjsonPath = path.join(tmpDir, 'check-results.ndjson');

  try {
    // Run from repo root so git diff works
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'check-trace-schema-drift.cjs')],
      {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        env: { ...process.env, CHECK_RESULTS_PATH: ndjsonPath },
      }
    );

    // Accept either 0 (no schema change) or 1 (drift detected) — real git behavior
    assert.ok(
      result.status === 0 || result.status === 1,
      'should exit 0 or 1, got: ' + result.status + ' stderr: ' + result.stderr
    );

    // NDJSON entry should be written
    assert.ok(fs.existsSync(ndjsonPath), 'check-results.ndjson should be written');
    const ndjson = fs.readFileSync(ndjsonPath, 'utf8').trim();
    assert.ok(ndjson.length > 0, 'NDJSON should not be empty');
    const entry = JSON.parse(ndjson.split('\n')[0]);
    assert.strictEqual(entry.tool, 'check-trace-schema-drift');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

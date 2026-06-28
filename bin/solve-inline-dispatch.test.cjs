#!/usr/bin/env node
'use strict';
// bin/solve-inline-dispatch.test.cjs
// Tests for bin/solve-inline-dispatch.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runDtoC } = require('./solve-inline-dispatch.cjs');

// ── runDtoC tests ────────────────────────────────────────────────────────────

test('runDtoC returns skipped when residual is 0', () => {
  const res = runDtoC({ d_to_c: { residual: 0 } });
  assert.equal(res.status, 'skipped');
  assert.equal(res.broken_claims_count, 0);
});

test('runDtoC returns skipped when d_to_c is missing', () => {
  const res = runDtoC({});
  assert.equal(res.status, 'skipped');
});

test('runDtoC formats broken claims table', () => {
  const res = runDtoC({
    d_to_c: {
      residual: 2,
      detail: {
        broken_claims: [
          { doc_file: 'README.md', line: 42, type: 'file_path', value: 'bin/old.cjs', reason: 'file not found' },
          { doc_file: 'docs/setup.md', line: 15, type: 'cli_command', value: 'node missing.cjs', reason: 'script not found' },
        ],
      },
    },
  });
  assert.equal(res.status, 'ok');
  assert.equal(res.broken_claims_count, 2);
  assert.ok(res.table.includes('D->C: 2 stale structural claim(s)'));
  assert.ok(res.table.includes('README.md'));
  assert.ok(res.table.includes('docs/setup.md'));
});

test('runDtoC handles empty broken_claims array', () => {
  const res = runDtoC({ d_to_c: { residual: 1, detail: { broken_claims: [] } } });
  assert.equal(res.status, 'skipped');
  assert.equal(res.broken_claims_count, 0);
});

test('runDtoC does not crash when broken_claims is a non-array', () => {
  const res = runDtoC({ d_to_c: { residual: 1, detail: { broken_claims: 'oops' } } });
  assert.equal(res.status, 'skipped');
  assert.equal(res.broken_claims_count, 0);
  assert.equal(res.table, '');
});

test('runDtoC does not crash when broken_claims contains null entries', () => {
  const res = runDtoC({ d_to_c: { residual: 1, detail: { broken_claims: [null, { doc_file: 'a.md', line: 1, type: 't', value: 'v', reason: 'r' }] } } });
  assert.equal(res.status, 'ok');
  assert.equal(res.broken_claims_count, 2);
  assert.ok(res.table.includes('a.md'));
});

test('runDtoC does not crash when claim fields are non-string', () => {
  const res = runDtoC({ d_to_c: { residual: 1, detail: { broken_claims: [{ doc_file: 'a.md', line: 7, type: 'count', value: 42, reason: 'mismatch' }] } } });
  assert.equal(res.status, 'ok');
  assert.equal(res.broken_claims_count, 1);
  assert.ok(res.table.includes('42'));
});

// ── Integration test: script runs with zero residual ─────────────────────────

test('script outputs valid JSON with zero residual via --input', () => {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const tmpFile = path.join(require('os').tmpdir(), 'nf-inline-test-' + Date.now() + '.json');

  fs.writeFileSync(tmpFile, JSON.stringify({
    hazard_model: { residual: 0 },
    d_to_c: { residual: 0 },
    l3_to_tc: { residual: 0 },
  }));

  try {
    const out = execFileSync(process.execPath, [
      path.join(__dirname, 'solve-inline-dispatch.cjs'),
      '--input=' + tmpFile,
      '--project-root=' + process.cwd(),
    ], { encoding: 'utf8', timeout: 15000 });

    const result = JSON.parse(out);
    assert.ok(Array.isArray(result.skip_layers), 'skip_layers should be an array');
    assert.ok(result.skip_layers.includes('d_to_c'), 'd_to_c should always be in skip_layers');
    assert.ok(result.inline_results, 'inline_results should exist');
    assert.ok(result.preflight_data !== undefined, 'preflight_data should exist');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

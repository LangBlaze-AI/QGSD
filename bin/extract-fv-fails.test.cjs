'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { extractFvFails } = require('./extract-fv-fails.cjs');

const BIN = path.join(__dirname, 'extract-fv-fails.cjs');

const NDJSON = [
  { tool: 'run-tlc', result: 'pass', check_id: 'tla:quorum-safety', surface: 'quorum', property: 'Safety', summary: 'pass' },
  { tool: 'run-tlc', result: 'fail', check_id: 'tla:quorum-liveness', surface: 'quorum', property: 'Liveness', summary: 'fail: counterexample found' },
  { tool: 'run-tlc', result: 'inconclusive', check_id: 'tla:oscillation', surface: 'oscillation', property: 'NoOsc', summary: 'inconclusive' },
].map((e) => JSON.stringify(e)).join('\n');

test('extractFvFails identifies only result=fail entries as hypotheses', () => {
  const fails = extractFvFails(NDJSON);
  assert.strictEqual(fails.length, 1);
  assert.strictEqual(fails[0].check_id, 'tla:quorum-liveness');
  assert.strictEqual(fails[0].property, 'Liveness');
});

test('extractFvFails returns [] when all pass/inconclusive', () => {
  const clean = NDJSON.split('\n').filter((l) => !l.includes('"fail"')).join('\n');
  assert.deepStrictEqual(extractFvFails(clean), []);
});

test('fail-open: empty / non-string / corrupt input never throws', () => {
  assert.deepStrictEqual(extractFvFails(''), []);
  assert.deepStrictEqual(extractFvFails(null), []);
  assert.deepStrictEqual(extractFvFails('not json\n{bad'), []);
});

test('CLI reads CHECK_RESULTS_PATH, emits fails JSON, exits 0 (fail-open)', () => {
  const tmp = path.join(os.tmpdir(), 'fv-' + process.pid + '.ndjson');
  fs.writeFileSync(tmp, NDJSON);
  try {
    const out = execFileSync(process.execPath, [BIN, '--json'], { env: { ...process.env, CHECK_RESULTS_PATH: tmp }, encoding: 'utf8' });
    const fails = JSON.parse(out);
    assert.strictEqual(fails.length, 1);
    assert.strictEqual(fails[0].check_id, 'tla:quorum-liveness');
  } finally { fs.unlinkSync(tmp); }
});

test('CLI exits 0 even when the ledger is missing (fail-open)', () => {
  let code = 0;
  try { execFileSync(process.execPath, [BIN, '--json'], { env: { ...process.env, CHECK_RESULTS_PATH: '/no/such/ledger.ndjson' }, encoding: 'utf8' }); }
  catch (e) { code = e.status; }
  assert.strictEqual(code, 0);
});

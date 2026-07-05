'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { scoreEval } = require('./eval-score.cjs');

const BIN = path.join(__dirname, 'eval-score.cjs');

test('full coverage + all infra ok → PRODUCTION READY', () => {
  const r = scoreEval(5, 5, ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.strictEqual(r.coverage_score, 100);
  assert.strictEqual(r.infra_score, 100);
  assert.strictEqual(r.overall_score, 100);
  assert.strictEqual(r.verdict, 'PRODUCTION READY');
});

test('nothing covered / no infra → NOT IMPLEMENTED', () => {
  const r = scoreEval(0, 5, ['missing', 'missing', 'missing', 'missing', 'missing']);
  assert.strictEqual(r.overall_score, 0);
  assert.strictEqual(r.verdict, 'NOT IMPLEMENTED');
});

test('partial infra is half-weight', () => {
  const r = scoreEval(0, 5, ['partial', 'partial', 'partial', 'partial', 'partial']);
  assert.strictEqual(r.infra_score, 50);
  // overall = 0.7*0 + 0.3*0.5 = 0.15 → 15
  assert.strictEqual(r.overall_score, 15);
  assert.strictEqual(r.verdict, 'NOT IMPLEMENTED');
});

test('mid coverage → SIGNIFICANT GAPS / NEEDS WORK band', () => {
  // covered 3/5=0.6, infra all ok=1 → 0.7*0.6 + 0.3*1 = 0.72 → 72 → NEEDS WORK
  const r = scoreEval(3, 5, ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.strictEqual(r.overall_score, 72);
  assert.strictEqual(r.verdict, 'NEEDS WORK');
});

test('fusion: a score near a threshold flags quorum_recommended', () => {
  // aim for ~85: coverage 1.0, infra: need 0.3*infra so overall lands ~83-87.
  // coverage 0.8 (4/5), infra all ok → 0.7*0.8 + 0.3*1 = 0.86 → 86 → within 5 of 85 → borderline
  const r = scoreEval(4, 5, ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.strictEqual(r.overall_score, 86);
  assert.strictEqual(r.quorum_recommended, true);
});

test('a clearly-non-borderline score does NOT flag quorum', () => {
  const r = scoreEval(5, 5, ['ok', 'ok', 'ok', 'ok', 'ok']); // 100, far from any boundary
  assert.strictEqual(r.quorum_recommended, false);
});

test('missing infra entries default to missing (not a crash)', () => {
  const r = scoreEval(5, 5, ['ok']); // only 1 of 5 provided
  assert.strictEqual(r.infra_score, 20); // 1/5
  assert.strictEqual(r.verdict, 'NEEDS WORK'); // 0.7*1 + 0.3*0.2 = 0.76 → 76
});

test('CLI --json', () => {
  const out = execFileSync(process.execPath, [BIN, '--covered', '5', '--total', '5', '--infra', 'ok,ok,ok,ok,ok', '--json'], { encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.strictEqual(r.verdict, 'PRODUCTION READY');
});

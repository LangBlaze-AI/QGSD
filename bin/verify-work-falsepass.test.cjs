'use strict';

// Dogfood Batch 9 (HIGH IMPACT): /nf:verify-work auto-marked a test "verified" when
// `failed_count: 0` — but a jest batch of nonexistent/empty files (run with
// --passWithNoTests) reported zero failures AND zero real tests, so the gate
// auto-verified with NO coverage, bypassing manual validation. Two fixes:
//   (a) nf-tools run-batch records a zero-test file as `no_tests` (not `passed`),
//   (b) the verify-work gate requires `failed_count:0` AND a non-zero passed_count.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- (b) the gate, exercised behaviorally --------------------------------------
// The exact condition shipped in core/workflows/verify-work.md.
const GATE = `grep -q '"failed_count": 0' "$OUTPUT_JSON" 2>/dev/null && ! grep -q '"passed_count": 0' "$OUTPUT_JSON" 2>/dev/null && echo PASS || echo MANUAL`;

function runGate(batch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-vw-'));
  const f = path.join(dir, 'out.json');
  fs.writeFileSync(f, JSON.stringify(batch, null, 2));
  try {
    const r = spawnSync('/bin/sh', ['-c', GATE], { env: { ...process.env, OUTPUT_JSON: f }, encoding: 'utf8' });
    return r.stdout.trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('verify-work auto-verify gate requires real passing tests', () => {
  it('a zero-test batch (passed:0, failed:0) does NOT auto-verify', () => {
    assert.equal(runGate({ passed_count: 0, failed_count: 0, no_tests_count: 1 }), 'MANUAL');
  });
  it('a real passing batch (passed:2, failed:0) auto-verifies', () => {
    assert.equal(runGate({ passed_count: 2, failed_count: 0 }), 'PASS');
  });
  it('a batch with failures does NOT auto-verify', () => {
    assert.equal(runGate({ passed_count: 1, failed_count: 1 }), 'MANUAL');
  });

  it('the shipped verify-work.md gate is the passed_count-aware form', () => {
    const md = fs.readFileSync(path.join(__dirname, '..', 'core', 'workflows', 'verify-work.md'), 'utf8');
    assert.match(md, /! grep -q '"passed_count": 0'/, 'gate must reject a zero-passed batch');
  });
});

// --- (a) the run-batch status, guarded at the source ---------------------------
describe('maintain-tests run-batch records no_tests (not passed) for empty results', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'bin', 'nf-tools.cjs'), 'utf8');
  it("empty jest testResults → status 'no_tests', and the batch reports no_tests_count", () => {
    assert.match(src, /status: 'no_tests', duration_ms: durationMs, error_summary: 'no tests found/, 'a zero-test jest file must be recorded as no_tests');
    assert.match(src, /no_tests_count: noTestsCount/, 'the batch output must surface no_tests_count');
    assert.match(src, /else if \(r\.status === 'no_tests'\) noTestsCount\+\+/, 'aggregation must count no_tests separately');
  });
});

#!/usr/bin/env node
'use strict';
// bin/run-phase-tlc.test.cjs
// Tests for bin/run-phase-tlc.cjs -- PLAN-02
//
// Validates: runPhaseTlc, iterativeVerify, formatTlcFeedback, CLI behavior
// NOTE: Uses spawnSync (no shell) for safe subprocess invocation.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert        = require('node:assert');
const { spawnSync } = require('child_process');
const fs            = require('fs');
const path          = require('path');
const os            = require('os');

const { runPhaseTlc, iterativeVerify, formatTlcFeedback } = require('./run-phase-tlc.cjs');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: check if Java is available
function isJavaAvailable() {
  const probe = spawnSync('java', ['--version'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

// Helper: check if tla2tools.jar exists
function isTla2toolsAvailable() {
  return fs.existsSync(path.join(__dirname, '..', '.planning', 'formal', 'tla', 'tla2tools.jar'));
}

// ── Test 1: iterativeVerify returns skipped for plan with no truths

test('iterativeVerify returns skipped for plan with no truths', () => {
  const planPath = path.join(tmpDir, 'v0.21-05-01-PLAN.md');
  fs.writeFileSync(planPath, `---
phase: v0.21-05
plan: "01"
must_haves:
  truths: []
---

<objective>Test</objective>
`, 'utf8');

  const result = iterativeVerify(planPath);
  assert.strictEqual(result.status, 'skipped');
  assert.ok(result.reason.includes('no truths'), 'reason should mention no truths');
});

// ── Test 2: iterativeVerify returns passed for plan with valid truths (stubs default to TRUE)

test('iterativeVerify returns passed for plan with valid truths (stubs default to TRUE)', (t) => {
  if (!isJavaAvailable() || !isTla2toolsAvailable()) {
    t.skip('Java or tla2tools.jar not available');
    return;
  }

  const planPath = path.join(tmpDir, 'v0.21-05-01-PLAN.md');
  fs.writeFileSync(planPath, `---
phase: v0.21-05
plan: "01"
must_haves:
  truths:
    - "count never exceeds maxSize"
    - "eventually reaches DONE state"
---

<objective>Test</objective>
`, 'utf8');

  const result = iterativeVerify(planPath);
  assert.strictEqual(result.status, 'passed', 'stubs are TRUE so TLC should pass. Got: ' + JSON.stringify(result));
  assert.strictEqual(result.truthCount, 2);
  assert.ok(result.runtimeMs >= 0, 'runtimeMs should be non-negative');
});

// ── Test 3: runPhaseTlc returns error when Java binary not found

test('runPhaseTlc returns error when Java binary not found', () => {
  const result = runPhaseTlc('/tmp/test.tla', '/tmp/test.cfg', { javaOverride: '/nonexistent/java' });
  assert.strictEqual(result.passed, false);
  assert.ok(result.violations.length > 0, 'should have violations');
  assert.ok(result.violations[0].includes('Java not found'), 'should mention Java not found');
});

// ── Test 4: runPhaseTlc returns error when tla2tools.jar not found

test('runPhaseTlc returns error when tla2tools.jar not found', () => {
  const result = runPhaseTlc('/tmp/test.tla', '/tmp/test.cfg', { jarOverride: '/nonexistent/tla2tools.jar' });
  assert.strictEqual(result.passed, false);
  assert.ok(result.violations.length > 0, 'should have violations');
  assert.ok(result.violations[0].includes('tla2tools.jar not found'), 'should mention tla2tools.jar not found');
});

// ── Test 5: formatTlcFeedback produces structured feedback with truth mapping

test('formatTlcFeedback produces structured feedback with truth mapping', () => {
  const feedback = formatTlcFeedback(1, 3, {
    passed: false,
    violations: ['Invariant Req01 is violated'],
    output: '',
    runtimeMs: 100,
  }, ['count never exceeds 5', 'eventually done']);

  assert.ok(feedback.includes('ATTEMPT 1/3'), 'should contain attempt info');
  assert.ok(feedback.includes('Req01'), 'should contain Req01');
  assert.ok(feedback.includes('count never exceeds 5'), 'should contain mapped truth text');
  assert.ok(feedback.includes('INVARIANT'), 'should contain INVARIANT kind');
});

// ── Test 6: formatTlcFeedback produces pass message

test('formatTlcFeedback produces pass message', () => {
  const feedback = formatTlcFeedback(1, 3, {
    passed: true,
    violations: [],
    output: '',
    runtimeMs: 50,
  }, ['truth1']);

  assert.ok(feedback.includes('PASSED'), 'should contain PASSED');
  assert.ok(feedback.includes('1 properties satisfied'), 'should contain property count');
});

// ── Test 7: formatTlcFeedback handles 2+ violations spanning both INVARIANT and PROPERTY types

test('formatTlcFeedback handles 2+ violations spanning both INVARIANT and PROPERTY types', () => {
  const feedback = formatTlcFeedback(2, 3, {
    passed: false,
    violations: ['Invariant Req01 is violated', 'Property Req03 is violated'],
    output: '',
    runtimeMs: 200,
  }, ['count never exceeds 5', 'state is always valid', 'eventually reaches DONE']);

  assert.ok(feedback.includes('ATTEMPT 2/3'), 'should contain ATTEMPT 2/3');
  assert.ok(feedback.includes('FAILED'), 'should contain FAILED');

  // Req01 -> truth index 0 -> "count never exceeds 5"
  assert.ok(feedback.includes('Req01'), 'should contain Req01');
  assert.ok(feedback.includes('count never exceeds 5'), 'should map Req01 to truth[0]');
  assert.ok(feedback.includes('INVARIANT'), 'should contain INVARIANT for Req01');

  // Req03 -> truth index 2 -> "eventually reaches DONE"
  assert.ok(feedback.includes('Req03'), 'should contain Req03');
  assert.ok(feedback.includes('eventually reaches DONE'), 'should map Req03 to truth[2]');
  assert.ok(feedback.includes('PROPERTY'), 'should contain PROPERTY for Req03');

  // Truth index 1 should NOT appear (not violated)
  assert.ok(!feedback.includes('state is always valid'), 'truth[1] should NOT appear (not violated)');
});

// ── Test 8: iterativeVerify generates both ProposedChanges.tla and MCProposedChanges.cfg

test('iterativeVerify generates both ProposedChanges.tla and MCProposedChanges.cfg', () => {
  const planPath = path.join(tmpDir, 'v0.21-05-01-PLAN.md');
  fs.writeFileSync(planPath, `---
phase: v0.21-05
plan: "01"
must_haves:
  truths:
    - "count never exceeds 5"
    - "eventually reaches DONE"
---

<objective>Test</objective>
`, 'utf8');

  const result = iterativeVerify(planPath);
  // Regardless of pass/fail (Java may not be available), spec files should be generated
  const formalDir = path.join(tmpDir, '.planning', 'formal');
  assert.ok(fs.existsSync(path.join(formalDir, 'ProposedChanges.tla')), 'ProposedChanges.tla should exist');
  assert.ok(fs.existsSync(path.join(formalDir, 'MCProposedChanges.cfg')), 'MCProposedChanges.cfg should exist');
});

// ── Test 9: CLI prints JSON result to stdout

test('CLI prints JSON result to stdout', () => {
  const planPath = path.join(tmpDir, 'v0.21-05-01-PLAN.md');
  fs.writeFileSync(planPath, `---
phase: v0.21-05
plan: "01"
must_haves:
  truths: []
---

<objective>Test</objective>
`, 'utf8');

  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'run-phase-tlc.cjs'),
    planPath,
  ], { encoding: 'utf8' });

  assert.strictEqual(result.status, 0, 'should exit 0 for skipped. stderr: ' + (result.stderr || ''));
  const parsed = JSON.parse(result.stdout);
  assert.strictEqual(parsed.status, 'skipped', 'should have status: skipped');
});

// ── Test 10: formatTlcFeedback does not crash when a failed result lacks a violations array

test('formatTlcFeedback does not crash when a failed result lacks a violations array', () => {
  let feedback;
  assert.doesNotThrow(() => {
    feedback = formatTlcFeedback(1, 3, { passed: false, output: '', runtimeMs: 0 }, ['t1']);
  }, 'missing violations array must not throw');
  assert.ok(feedback.includes('ATTEMPT 1/3'), 'should still contain attempt info');
  assert.ok(feedback.includes('FAILED'), 'should still contain FAILED');
});

// ── Test 11: formatTlcFeedback does not crash when truthsList is omitted

test('formatTlcFeedback does not crash when truthsList is omitted', () => {
  let pass, fail;
  assert.doesNotThrow(() => {
    pass = formatTlcFeedback(1, 3, { passed: true, violations: [], output: '', runtimeMs: 0 });
  }, 'omitted truthsList on pass must not throw');
  assert.ok(pass.includes('PASSED'), 'should still report PASSED');
  assert.doesNotThrow(() => {
    fail = formatTlcFeedback(1, 3, { passed: false, violations: ['Invariant Req01 is violated'], output: '', runtimeMs: 0 });
  }, 'omitted truthsList on Req-mapped failure must not throw');
  assert.ok(fail.includes('Req01'), 'should still contain Req01');
  assert.ok(fail.includes('(unknown truth)'), 'unmapped truth should fall back to (unknown truth)');
});

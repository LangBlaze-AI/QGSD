#!/usr/bin/env node
'use strict';
// bin/quorum-formal-context.test.cjs
// Tests for bin/quorum-formal-context.cjs -- PLAN-03
//
// Validates: generateFormalSpecSummary, generateVerificationResult,
//            buildFormalEvidenceBlock, getFormalContext

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const {
  generateFormalSpecSummary,
  generateVerificationResult,
  buildFormalEvidenceBlock,
  getFormalContext,
} = require('./quorum-formal-context.cjs');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfc-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Test 1: generateFormalSpecSummary returns null for plan with no truths

test('generateFormalSpecSummary returns null for plan with no truths', () => {
  const planPath = path.join(tmpDir, 'v0.21-05-01-PLAN.md');
  fs.writeFileSync(planPath, `---
phase: v0.21-05
plan: "01"
must_haves:
  truths: []
---

<objective>Test</objective>
`, 'utf8');

  const result = generateFormalSpecSummary(planPath);
  assert.strictEqual(result, null, 'should return null for no truths');
});

// ── Test 2: generateFormalSpecSummary produces plain-English summary with correct classifications

test('generateFormalSpecSummary produces plain-English summary with correct classifications', () => {
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

  const result = generateFormalSpecSummary(planPath);
  assert.ok(result !== null, 'should not be null');
  assert.ok(result.summary.includes('[INVARIANT]'), 'should contain INVARIANT classification');
  assert.ok(result.summary.includes('count never exceeds maxSize'), 'should contain first truth');
  assert.ok(result.summary.includes('[PROPERTY]'), 'should contain PROPERTY classification');
  assert.ok(result.summary.includes('eventually reaches DONE state'), 'should contain second truth');
  assert.strictEqual(result.truthCount, 2, 'truthCount should be 2');
});

// ── Test 3: generateFormalSpecSummary sanitizes special characters in truths

test('generateFormalSpecSummary sanitizes special characters in truths', () => {
  const planPath = path.join(tmpDir, 'v0.21-05-01-PLAN.md');
  fs.writeFileSync(planPath, `---
phase: v0.21-05
plan: "01"
must_haves:
  truths:
    - "<state> transitions are always valid"
---

<objective>Test</objective>
`, 'utf8');

  const result = generateFormalSpecSummary(planPath);
  assert.ok(result !== null, 'should not be null');
  // Angle brackets should be replaced with square brackets
  assert.ok(!result.summary.includes('<state>'), 'should NOT contain raw angle brackets');
  assert.ok(result.summary.includes('[state]'), 'should contain sanitized brackets');
  // Truths should be wrapped in backticks
  assert.ok(result.summary.includes('`'), 'should wrap truths in backticks');
});

// ── Test 4: generateVerificationResult returns PASS string for passed result

test('generateVerificationResult returns PASS string for passed result', () => {
  const result = generateVerificationResult({ status: 'passed', truthCount: 3, runtimeMs: 500 });
  assert.ok(result.startsWith('PASS:'), 'should start with PASS:');
  assert.ok(result.includes('3 properties'), 'should mention 3 properties');
  assert.ok(result.includes('500ms'), 'should mention runtime');
});

// ── Test 5: generateVerificationResult returns FAIL string for failed result

test('generateVerificationResult returns FAIL string for failed result', () => {
  const result = generateVerificationResult({
    status: 'failed',
    violations: ['Invariant Req01 is violated'],
  });
  assert.ok(result.startsWith('FAIL:'), 'should start with FAIL:');
  assert.ok(result.includes('Req01'), 'should contain Req01');
  assert.ok(result.includes('1 properties violated'), 'should mention violation count');
});

// ── Test 6: generateVerificationResult returns INCONCLUSIVE for null input

test('generateVerificationResult returns INCONCLUSIVE for null input', () => {
  const result = generateVerificationResult(null);
  assert.ok(result.startsWith('INCONCLUSIVE:'), 'should start with INCONCLUSIVE:');
  assert.ok(result.includes('No verification was run'), 'should mention no verification');
});

// ── Test 7: generateVerificationResult returns INCONCLUSIVE for skipped (no truths)

test('generateVerificationResult returns INCONCLUSIVE for skipped (no truths)', () => {
  const result = generateVerificationResult({ status: 'skipped', reason: 'no truths in plan' });
  assert.ok(result.startsWith('INCONCLUSIVE:'), 'should start with INCONCLUSIVE:');
  assert.ok(result.includes('No truths'), 'should mention no truths');
});

// ── Test 8: buildFormalEvidenceBlock produces formatted block with both fields

test('buildFormalEvidenceBlock produces formatted block with both fields', () => {
  const result = buildFormalEvidenceBlock('summary text here', 'PASS: all good');
  assert.ok(result !== null, 'should not be null');
  assert.ok(result.includes('=== Formal Evidence ==='), 'should contain header');
  assert.ok(result.includes('summary text here'), 'should contain summary');
  assert.ok(result.includes('Verification result: PASS: all good'), 'should contain verification result');
  assert.ok(result.includes('======================'), 'should contain footer');
});

// ── Test 9: buildFormalEvidenceBlock returns null when no summary

test('buildFormalEvidenceBlock returns null when no summary', () => {
  const result = buildFormalEvidenceBlock(null, null);
  assert.strictEqual(result, null, 'should return null when both inputs are null');
});

// ── Test 10: getFormalContext integrates all three steps

test('getFormalContext integrates all three steps', () => {
  const planPath = path.join(tmpDir, 'v0.21-05-01-PLAN.md');
  fs.writeFileSync(planPath, `---
phase: v0.21-05
plan: "01"
must_haves:
  truths:
    - "count never exceeds maxSize"
    - "eventually reaches DONE"
---

<objective>Test</objective>
`, 'utf8');

  const result = getFormalContext(planPath, { status: 'passed', truthCount: 2, runtimeMs: 100 });
  assert.ok(result.evidenceBlock !== null, 'evidenceBlock should be non-null');
  assert.ok(typeof result.evidenceBlock === 'string', 'evidenceBlock should be a string');
  assert.ok(result.formalSpecSummary !== null, 'formalSpecSummary should be non-null');
  assert.ok(result.verificationResult.startsWith('PASS:'), 'verificationResult should start with PASS:');
});

// ── Test 11: getFormalContext returns null evidence for plan with no truths

test('getFormalContext returns null evidence for plan with no truths', () => {
  const planPath = path.join(tmpDir, 'v0.21-05-01-PLAN.md');
  fs.writeFileSync(planPath, `---
phase: v0.21-05
plan: "01"
must_haves:
  truths: []
---

<objective>Test</objective>
`, 'utf8');

  const result = getFormalContext(planPath, null);
  assert.strictEqual(result.evidenceBlock, null, 'evidenceBlock should be null');
});

// ── Test 12: generateVerificationResult does not crash on non-string violations

test('generateVerificationResult does not crash on non-string violations', () => {
  const result = generateVerificationResult({ status: 'failed', violations: [null, 42, { x: 1 }] });
  assert.ok(typeof result === 'string', 'should return a string, not throw');
  assert.ok(result.startsWith('FAIL:'), 'should still report FAIL for failed status');
});

// ── Test 13: generateVerificationResult does not crash when violations is not an array

test('generateVerificationResult does not crash when violations is not an array', () => {
  const result = generateVerificationResult({ status: 'failed', violations: 'Invariant Req01 is violated' });
  assert.ok(typeof result === 'string', 'should return a string, not throw');
  assert.ok(result.startsWith('FAIL:'), 'should still report FAIL for failed status');
});

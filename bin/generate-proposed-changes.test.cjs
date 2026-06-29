#!/usr/bin/env node
'use strict';
// bin/generate-proposed-changes.test.cjs
// Tests for bin/generate-proposed-changes.cjs -- PLAN-01
//
// Validates: generateProposedChanges, generateTlaCfg, CLI behavior

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert             = require('node:assert');
const { spawnSync }      = require('child_process');
const fs                 = require('fs');
const path               = require('path');
const os                 = require('os');

const { generateProposedChanges, generateTlaCfg } = require('./generate-proposed-changes.cjs');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpc-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Test 1: generateProposedChanges returns generated: false for plan with no truths

test('generateProposedChanges returns generated: false for plan with no truths', () => {
  const planPath = path.join(tmpDir, 'v0.21-05-01-PLAN.md');
  fs.writeFileSync(planPath, `---
phase: v0.21-05
plan: "01"
must_haves:
  truths: []
---

<objective>Test</objective>
`, 'utf8');

  const result = generateProposedChanges(planPath);
  assert.strictEqual(result.generated, false, 'should not generate when no truths');
  assert.strictEqual(result.reason, 'no truths');
});

// ── Test 2: generateProposedChanges produces ProposedChanges.tla with correct INVARIANT/PROPERTY stubs

test('generateProposedChanges produces ProposedChanges.tla with correct INVARIANT/PROPERTY stubs', () => {
  const planPath = path.join(tmpDir, 'v0.21-05-01-PLAN.md');
  fs.writeFileSync(planPath, `---
phase: v0.21-05
plan: "01"
must_haves:
  truths:
    - "count never exceeds 5"
    - "eventually reaches DONE"
    - "state is always valid"
---

<objective>Test</objective>
`, 'utf8');

  const result = generateProposedChanges(planPath);
  assert.strictEqual(result.generated, true);
  assert.strictEqual(result.truthCount, 3);

  const specContent = fs.readFileSync(result.specPath, 'utf8');
  assert.ok(specContent.includes('Req01'), 'should contain Req01');
  assert.ok(specContent.includes('Req02'), 'should contain Req02');
  assert.ok(specContent.includes('Req03'), 'should contain Req03');
  assert.ok(specContent.includes('MODULE ProposedChanges'), 'should contain MODULE ProposedChanges');
});

// ── Test 3: generateProposedChanges writes to phaseDir/.formal/ subdirectory

test('generateProposedChanges writes to phaseDir/.formal/ subdirectory', () => {
  const phaseDir = path.join(tmpDir, '.planning', 'phases', 'v0.21-05-test');
  fs.mkdirSync(phaseDir, { recursive: true });
  const planPath = path.join(phaseDir, 'v0.21-05-01-PLAN.md');
  fs.writeFileSync(planPath, `---
phase: v0.21-05
plan: "01"
must_haves:
  truths:
    - "count never exceeds 5"
---

<objective>Test</objective>
`, 'utf8');

  const result = generateProposedChanges(planPath);
  assert.strictEqual(result.generated, true);

  const expectedPath = path.join(phaseDir, '.formal', 'ProposedChanges.tla');
  assert.ok(fs.existsSync(expectedPath), 'ProposedChanges.tla should exist in phaseDir/.formal/');
  assert.strictEqual(result.specPath, expectedPath);
});

// ── Test 4: generateTlaCfg creates MCProposedChanges.cfg with correct SPECIFICATION and checks

test('generateTlaCfg creates MCProposedChanges.cfg with correct SPECIFICATION and checks', () => {
  const planPath = path.join(tmpDir, 'v0.21-05-01-PLAN.md');
  fs.writeFileSync(planPath, `---
phase: v0.21-05
plan: "01"
must_haves:
  truths:
    - "count never exceeds 5"
    - "eventually reaches DONE"
    - "state is always valid"
---

<objective>Test</objective>
`, 'utf8');

  const result = generateProposedChanges(planPath);
  const { cfgPath } = generateTlaCfg(result.specPath);

  assert.ok(fs.existsSync(cfgPath), 'MCProposedChanges.cfg should exist');

  const cfgContent = fs.readFileSync(cfgPath, 'utf8');
  assert.ok(cfgContent.includes('SPECIFICATION Spec'), 'cfg should contain SPECIFICATION Spec');
  assert.ok(cfgContent.includes('INVARIANT Req01'), 'cfg should contain INVARIANT Req01 (safety truth)');
  assert.ok(cfgContent.includes('PROPERTY Req02'), 'cfg should contain PROPERTY Req02 (liveness truth)');
  assert.ok(cfgContent.includes('INVARIANT Req03'), 'cfg should contain INVARIANT Req03 (safety truth)');
});

// ── Test 5: CLI dry-run mode prints to stdout without writing files

test('CLI dry-run mode prints to stdout without writing files', () => {
  const planPath = path.join(tmpDir, 'v0.21-05-01-PLAN.md');
  fs.writeFileSync(planPath, `---
phase: v0.21-05
plan: "01"
must_haves:
  truths:
    - "count never exceeds 5"
---

<objective>Test</objective>
`, 'utf8');

  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'generate-proposed-changes.cjs'),
    planPath,
    '--dry-run',
  ], { encoding: 'utf8' });

  assert.ok(result.stdout.includes('DRY-RUN'), 'stdout should contain DRY-RUN');

  const formalDir = path.join(tmpDir, '.formal');
  assert.ok(!fs.existsSync(formalDir), '.formal/ directory should NOT be created in dry-run mode');
});

// ── Test 6: each truth appears as a comment in the generated TLA+ spec

test('each truth appears as a comment in the generated TLA+ spec', () => {
  const planPath = path.join(tmpDir, 'v0.21-05-01-PLAN.md');
  fs.writeFileSync(planPath, `---
phase: v0.21-05
plan: "01"
must_haves:
  truths:
    - "quorum threshold must be at least 3"
    - "eventually all slots respond"
---

<objective>Test</objective>
`, 'utf8');

  const result = generateProposedChanges(planPath);
  const specContent = fs.readFileSync(result.specPath, 'utf8');

  assert.ok(specContent.includes('quorum threshold must be at least 3'), 'first truth should appear in spec');
  assert.ok(specContent.includes('eventually all slots respond'), 'second truth should appear in spec');
});

// ── Test 7: generated spec contains ReqNN-to-Truth index mapping comment block

test('generated spec contains ReqNN-to-Truth index mapping comment block', () => {
  const planPath = path.join(tmpDir, 'v0.21-05-01-PLAN.md');
  fs.writeFileSync(planPath, `---
phase: v0.21-05
plan: "01"
must_haves:
  truths:
    - "count never exceeds maxSize"
    - "eventually reaches DONE state"
    - "threshold is always positive"
---

<objective>Test</objective>
`, 'utf8');

  const result = generateProposedChanges(planPath);
  const specContent = fs.readFileSync(result.specPath, 'utf8');

  assert.ok(specContent.includes('=== ReqNN-to-Truth Mapping ==='), 'should contain mapping header');
  assert.ok(specContent.includes('Req01 -> Truth[0]: "count never exceeds maxSize"'), 'should map Req01 to Truth[0]');
  assert.ok(specContent.includes('Req02 -> Truth[1]: "eventually reaches DONE state"'), 'should map Req02 to Truth[1]');
  assert.ok(specContent.includes('Req03 -> Truth[2]: "threshold is always positive"'), 'should map Req03 to Truth[2]');
});

// ── Test 8: .formal/ subdirectory is auto-created via mkdir -p when it does not exist

test('.formal/ subdirectory is auto-created via mkdir -p when it does not exist', () => {
  const deepDir = path.join(tmpDir, 'a', 'b', 'c');
  fs.mkdirSync(deepDir, { recursive: true });
  const planPath = path.join(deepDir, 'v0.21-05-01-PLAN.md');
  fs.writeFileSync(planPath, `---
phase: v0.21-05
plan: "01"
must_haves:
  truths:
    - "count never exceeds 5"
---

<objective>Test</objective>
`, 'utf8');

  const result = generateProposedChanges(planPath);
  assert.strictEqual(result.generated, true);

  const expectedPath = path.join(deepDir, '.formal', 'ProposedChanges.tla');
  assert.ok(fs.existsSync(expectedPath), 'ProposedChanges.tla should exist in deeply nested .formal/ dir');
});

// ── Test 9 (GPC-1): generateProposedChanges fails cleanly on a directory path instead of throwing EISDIR

test('generateProposedChanges fails cleanly on a directory path instead of throwing EISDIR', () => {
  const dir = path.join(tmpDir, 'phasedir');
  fs.mkdirSync(dir, { recursive: true });

  // A phase DIRECTORY (what the sibling generate-phase-spec.cjs accepts) must not
  // crash this tool with a raw EISDIR — it should return a graceful result.
  let result;
  assert.doesNotThrow(() => { result = generateProposedChanges(dir); });
  assert.strictEqual(result.generated, false, 'directory input should not generate');
});

// ── Test 10 (GPC-2): generateTlaCfg emits a check for the 100th truth (3-digit ReqNN)

test('generateTlaCfg emits a check for the 100th truth (3-digit ReqNN)', () => {
  const planPath = path.join(tmpDir, 'v0.21-05-01-PLAN.md');
  let truths = '';
  for (let i = 0; i < 100; i++) truths += `    - "count never exceeds ${i}"\n`;
  fs.writeFileSync(planPath, `---\nphase: v0.21-05\nplan: "01"\nmust_haves:\n  truths:\n${truths}---\n\n<objective>Test</objective>\n`, 'utf8');

  const result = generateProposedChanges(planPath);
  assert.strictEqual(result.truthCount, 100);

  const { cfgPath } = generateTlaCfg(result.specPath);
  const cfg = fs.readFileSync(cfgPath, 'utf8');
  assert.ok(/\bReq100\b/.test(cfg), 'cfg should include a check line for Req100');
  const reqLines = cfg.split('\n').filter(l => /^(INVARIANT|PROPERTY) Req/.test(l));
  assert.strictEqual(reqLines.length, 100, 'cfg should have one check per truth');
});

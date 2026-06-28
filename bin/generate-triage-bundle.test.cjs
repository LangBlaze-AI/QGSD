#!/usr/bin/env node
'use strict';
// bin/generate-triage-bundle.test.cjs
// Wave 0 RED tests for TRIAGE-01 and TRIAGE-02.
// Requirements: TRIAGE-01, TRIAGE-02

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Path to the tool under test
const TOOL_PATH = path.join(__dirname, 'generate-triage-bundle.cjs');

// Creates a temp dir, writes .planning/formal/check-results.ndjson, optionally seeds diff-report.md with a previous snapshot,
// runs generate-triage-bundle.cjs with cwd=tmpDir, returns { tmpDir, result }
function runTriage(ndjsonContent, prevDiffReportContent) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-test-'));
  fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.planning', 'formal', 'check-results.ndjson'), ndjsonContent, 'utf8');
  if (prevDiffReportContent !== undefined) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'formal', 'diff-report.md'), prevDiffReportContent, 'utf8');
  }
  const result = spawnSync(process.execPath, [TOOL_PATH], {
    cwd: tmpDir,
    encoding: 'utf8',
    timeout: 15000,
  });
  return { tmpDir, result };
}

// Reads an output file from .planning/formal/ in tmpDir; returns null if missing
function readOutput(tmpDir, filename) {
  const p = path.join(tmpDir, '.planning', 'formal', filename);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

// Builds an NDJSON record string
function makeRecord(overrides) {
  return JSON.stringify({
    tool: overrides.tool || 'tla',
    formalism: overrides.formalism || 'tla',
    result: overrides.result || 'pass',
    check_id: overrides.check_id || 'tla:test-check',
    surface: overrides.surface || 'tla',
    property: overrides.property || 'Test property',
    summary: overrides.summary || (overrides.result || 'pass') + ': test summary',
    triage_tags: overrides.triage_tags || [],
    runtime_ms: overrides.runtime_ms || 100,
    timestamp: new Date().toISOString(),
  });
}

// Builds a diff-report.md stub with embedded JSON snapshot for previous run
function makeSnapshotReport(snapshotObj) {
  return [
    '# Formal Verification Diff Report',
    '',
    '## Previous Run (for next comparison)',
    '```json',
    JSON.stringify(snapshotObj),
    '```',
  ].join('\n');
}

test('parseCurrentNDJSON parses check-results.ndjson correctly', () => {
  const ndjson = [
    makeRecord({ check_id: 'tla:t1', result: 'pass' }),
    makeRecord({ check_id: 'tla:t2', result: 'fail' }),
    makeRecord({ check_id: 'ci:t3', result: 'inconclusive', surface: 'ci', formalism: 'ci' }),
  ].join('\n');
  const { tmpDir, result } = runTriage(ndjson);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // If the tool binary doesn't exist yet, spawnSync returns result.error with code ENOENT.
  // Treat that as a clean RED failure rather than letting result.status===null pass silently.
  if (result.error) {
    assert.fail('generate-triage-bundle.cjs not yet implemented (spawnSync error: ' + result.error.code + ')');
  }
  // Tool must exit 0 for well-formed NDJSON
  assert.strictEqual(result.status, 0, 'generate-triage-bundle.cjs must exit 0: ' + result.stderr);
});

test('suspects.md lists checks with result=fail', () => {
  const ndjson = [
    makeRecord({ check_id: 'tla:quorum-safety', result: 'fail', summary: 'fail: invariant violated' }),
    makeRecord({ check_id: 'tla:passing-check', result: 'pass' }),
    makeRecord({ check_id: 'tla:passing-check2', result: 'pass' }),
  ].join('\n');
  const { tmpDir } = runTriage(ndjson);
  const suspects = readOutput(tmpDir, 'suspects.md');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.ok(suspects, 'suspects.md was not created');
  assert.ok(suspects.includes('tla:quorum-safety'), 'fail check missing from suspects.md');
});

test('suspects.md lists checks with triage_tags set', () => {
  const ndjson = [
    makeRecord({ check_id: 'ci:liveness-fairness-lint', result: 'warn', triage_tags: ['needs-fairness'], summary: 'warn: fairness missing' }),
  ].join('\n');
  const { tmpDir } = runTriage(ndjson);
  const suspects = readOutput(tmpDir, 'suspects.md');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.ok(suspects, 'suspects.md was not created');
  assert.ok(suspects.includes('ci:liveness-fairness-lint'), 'tagged warn check missing from suspects.md');
});

test('diff-report.md handles first run (no previous snapshot)', () => {
  const ndjson = [
    makeRecord({ check_id: 'tla:t1', result: 'pass' }),
    makeRecord({ check_id: 'tla:t2', result: 'pass' }),
  ].join('\n');
  // No prevDiffReportContent — first run scenario
  const { tmpDir } = runTriage(ndjson, undefined);
  const diffReport = readOutput(tmpDir, 'diff-report.md');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.ok(diffReport, 'diff-report.md was not created');
  assert.ok(
    diffReport.toLowerCase().includes('first run'),
    'diff-report.md must contain "first run" note when no previous snapshot exists'
  );
});

test('diff-report.md detects transitioned checks', () => {
  const ndjson = makeRecord({ check_id: 'tla:quorum-safety', result: 'pass', summary: 'pass: now passing' });
  // Previous snapshot: tla:quorum-safety was 'fail'
  const prevReport = makeSnapshotReport({ 'tla:quorum-safety': 'fail' });
  const { tmpDir } = runTriage(ndjson, prevReport);
  const diffReport = readOutput(tmpDir, 'diff-report.md');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.ok(diffReport, 'diff-report.md was not created');
  assert.ok(diffReport.includes('tla:quorum-safety'), 'transitioned check_id missing from diff-report');
  assert.ok(
    /fail.*pass|pass.*fail/i.test(diffReport),
    'diff-report must show the fail->pass transition direction'
  );
});

test('diff-report.md detects new checks', () => {
  const ndjson = makeRecord({ check_id: 'tla:new-check', result: 'pass', summary: 'pass: first seen' });
  // Previous snapshot has NO entry for 'tla:new-check'
  const prevReport = makeSnapshotReport({ 'tla:existing-check': 'pass' });
  const { tmpDir } = runTriage(ndjson, prevReport);
  const diffReport = readOutput(tmpDir, 'diff-report.md');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.ok(diffReport, 'diff-report.md was not created');
  assert.ok(diffReport.includes('tla:new-check'), 'new check_id missing from diff-report new-checks section');
  assert.ok(
    diffReport.toLowerCase().includes('new'),
    'diff-report must have a "new" section header'
  );
});

test('handles non-object NDJSON records (null/number/string/array lines) without crashing', () => {
  const ndjson = [
    'null',
    '42',
    '"a bare string"',
    '[1,2,3]',
    makeRecord({ check_id: 'tla:real', result: 'fail', summary: 'fail: real check' }),
  ].join('\n');
  const { tmpDir, result } = runTriage(ndjson);
  const suspects = readOutput(tmpDir, 'suspects.md');
  const diffReport = readOutput(tmpDir, 'diff-report.md');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.strictEqual(result.status, 0, 'must exit 0 on non-object NDJSON lines: ' + result.stderr);
  assert.ok(suspects, 'suspects.md was not created');
  assert.ok(diffReport, 'diff-report.md was not created');
  assert.ok(suspects.includes('tla:real'), 'real fail check must still appear in suspects.md');
});

test('non-string summary in a new check does not crash diff report', () => {
  const rec = JSON.parse(makeRecord({ check_id: 'tla:numsum', result: 'pass' }));
  rec.summary = 12345; // JSON-valid but wrong type
  const ndjson = JSON.stringify(rec);
  const prevReport = makeSnapshotReport({ 'tla:existing': 'pass' }); // not first run; tla:numsum is new
  const { tmpDir, result } = runTriage(ndjson, prevReport);
  const diffReport = readOutput(tmpDir, 'diff-report.md');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.strictEqual(result.status, 0, 'must exit 0 with numeric summary: ' + result.stderr);
  assert.ok(diffReport, 'diff-report.md was not created');
  assert.ok(diffReport.includes('tla:numsum'), 'new check missing from diff-report');
});

test('check_id matching an Object.prototype member is treated as a new check, not a transition', () => {
  const ndjson = makeRecord({ check_id: 'constructor', result: 'pass', summary: 'pass: brand new' });
  const prevReport = makeSnapshotReport({ 'tla:existing': 'pass' });
  const { tmpDir, result } = runTriage(ndjson, prevReport);
  const diffReport = readOutput(tmpDir, 'diff-report.md');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.strictEqual(result.status, 0, 'must exit 0: ' + result.stderr);
  assert.ok(diffReport.includes('constructor'), 'constructor check missing from diff-report');
  assert.ok(/## New Checks/.test(diffReport), 'brand-new constructor check must appear under New Checks');
  assert.ok(!/native code/.test(diffReport), 'must not render an inherited prototype function as previousResult');
});

test('run-formal-verify includes ci:triage-bundle STEPS entry', () => {
  const rfvPath = path.join(__dirname, 'run-formal-verify.cjs');
  const content = fs.readFileSync(rfvPath, 'utf8');
  assert.ok(
    content.includes('ci:triage-bundle'),
    'run-formal-verify.cjs must contain a STEPS entry with id: ci:triage-bundle (TRIAGE-02)'
  );
});

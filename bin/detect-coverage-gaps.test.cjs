#!/usr/bin/env node
'use strict';
// bin/detect-coverage-gaps.test.cjs
// Unit tests for SIG-01: TLC state-space vs conformance trace coverage gap detector.
// Requirements: SIG-01

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const { detectCoverageGaps, parseTlcStates, parseTraceStates } = require('./detect-coverage-gaps.cjs');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-gaps-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── parseTlcStates tests ─────────────────────────────────────────────────────

test('parseTlcStates returns state set for known spec', () => {
  const result = parseTlcStates('NFQuorum');
  assert.ok(result, 'Should return a result for NFQuorum');
  assert.strictEqual(result.specName, 'NFQuorum');
  assert.strictEqual(result.variable, 's');
  assert.ok(result.states.has('COLLECTING_VOTES'));
  assert.ok(result.states.has('DECIDED'));
  assert.ok(result.states.has('DELIBERATING'));
  assert.strictEqual(result.states.size, 3);
});

test('parseTlcStates returns null for unknown spec', () => {
  const result = parseTlcStates('NonExistentSpec');
  assert.strictEqual(result, null);
});

// ── parseTraceStates tests ───────────────────────────────────────────────────

test('parseTraceStates returns null when log file does not exist', () => {
  const result = parseTraceStates('/nonexistent/path.jsonl');
  assert.strictEqual(result, null);
});

test('parseTraceStates extracts observed states from JSONL', () => {
  const logPath = path.join(tmpDir, 'events.jsonl');
  const events = [
    JSON.stringify({ action: 'quorum_start', timestamp: '2026-03-01T00:00:00Z' }),
    JSON.stringify({ action: 'quorum_complete', timestamp: '2026-03-01T00:01:00Z' }),
    JSON.stringify({ state: 'DELIBERATING', timestamp: '2026-03-01T00:02:00Z' }),
  ];
  fs.writeFileSync(logPath, events.join('\n'));

  const result = parseTraceStates(logPath);
  assert.ok(result instanceof Set, 'Should return a Set');
  assert.ok(result.has('COLLECTING_VOTES'), 'quorum_start maps to COLLECTING_VOTES');
  assert.ok(result.has('DECIDED'), 'quorum_complete maps to DECIDED');
  assert.ok(result.has('DELIBERATING'), 'direct state field should be captured');
});

// ── detectCoverageGaps tests ─────────────────────────────────────────────────

test('detectCoverageGaps returns no-traces when log missing', () => {
  const result = detectCoverageGaps({
    specName: 'NFQuorum',
    logPath: '/nonexistent/path.jsonl',
  });
  assert.strictEqual(result.status, 'no-traces');
  assert.strictEqual(result.reason, 'conformance log not found');
});

test('detectCoverageGaps returns full-coverage when all states observed', () => {
  const logPath = path.join(tmpDir, 'events.jsonl');
  const events = [
    JSON.stringify({ action: 'quorum_start' }),
    JSON.stringify({ action: 'quorum_complete' }),
    JSON.stringify({ action: 'deliberation_round' }),
  ];
  fs.writeFileSync(logPath, events.join('\n'));

  const outputPath = path.join(tmpDir, 'coverage-gaps.md');
  const result = detectCoverageGaps({
    specName: 'NFQuorum',
    logPath,
    outputPath,
  });
  assert.strictEqual(result.status, 'full-coverage');
  assert.deepStrictEqual(result.gaps, []);
});

test('detectCoverageGaps returns gaps-found and writes coverage-gaps.md', () => {
  const logPath = path.join(tmpDir, 'events.jsonl');
  // Only cover COLLECTING_VOTES and DECIDED — missing DELIBERATING
  const events = [
    JSON.stringify({ action: 'quorum_start' }),
    JSON.stringify({ action: 'quorum_complete' }),
  ];
  fs.writeFileSync(logPath, events.join('\n'));

  const outputPath = path.join(tmpDir, 'coverage-gaps.md');
  const result = detectCoverageGaps({
    specName: 'NFQuorum',
    logPath,
    outputPath,
  });
  assert.strictEqual(result.status, 'gaps-found');
  assert.ok(result.gaps.includes('DELIBERATING'), 'Should find DELIBERATING as a gap');
  assert.ok(fs.existsSync(outputPath), 'coverage-gaps.md should be written');

  const content = fs.readFileSync(outputPath, 'utf8');
  assert.ok(content.includes('## Unreached States'), 'Should contain Unreached States section');
  assert.ok(content.includes('DELIBERATING'), 'Should mention DELIBERATING in the output');
});

test('coverage-gaps.md contains correct coverage percentage', () => {
  const logPath = path.join(tmpDir, 'events.jsonl');
  // 2 of 3 states covered = 66%
  const events = [
    JSON.stringify({ action: 'quorum_start' }),
    JSON.stringify({ action: 'quorum_complete' }),
  ];
  fs.writeFileSync(logPath, events.join('\n'));

  const outputPath = path.join(tmpDir, 'coverage-gaps.md');
  detectCoverageGaps({
    specName: 'NFQuorum',
    logPath,
    outputPath,
  });

  const content = fs.readFileSync(outputPath, 'utf8');
  // 2/3 = 66.67%, rounded to 67%
  assert.ok(content.includes('67% coverage') || content.includes('66% coverage'),
    'Should contain correct coverage percentage (66% or 67%)');
  assert.ok(content.includes('TLC reachable: 3 states'), 'Should show 3 reachable states');
  assert.ok(content.includes('Trace observed: 2 states'), 'Should show 2 observed states');
  assert.ok(content.includes('Gaps: 1 states'), 'Should show 1 gap');
});

// ── adversarial hardening tests ──────────────────────────────────────────────

test('parseTlcStates returns null for prototype-pollution spec names', () => {
  assert.strictEqual(parseTlcStates('__proto__'), null);
  assert.strictEqual(parseTlcStates('prototype'), null);
});

test('detectCoverageGaps returns unknown-spec for __proto__ instead of throwing', () => {
  const result = detectCoverageGaps({ specName: '__proto__' });
  assert.strictEqual(result.status, 'unknown-spec');
});

test('parseTlcStates returns null for inherited Object keys (constructor)', () => {
  assert.strictEqual(parseTlcStates('constructor'), null);
  assert.strictEqual(parseTlcStates('hasOwnProperty'), null);
});

test('detectCoverageGaps does not report full-coverage for non-existent constructor spec', () => {
  const result = detectCoverageGaps({ specName: 'constructor' });
  assert.strictEqual(result.status, 'unknown-spec');
});

test('detectCoverageGaps(null) falls back to defaults without throwing', () => {
  // null log path resolution will find no conformance log under a temp cwd
  const result = detectCoverageGaps(null);
  assert.ok(result && typeof result === 'object', 'returns a result object');
  assert.ok(['no-traces', 'full-coverage', 'gaps-found'].includes(result.status),
    'should resolve to a normal status, not throw');
});

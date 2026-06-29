#!/usr/bin/env node
'use strict';

/**
 * bin/harness-diagnostic.test.cjs — Unit tests for harness diagnostic module.
 * Run: node --test bin/harness-diagnostic.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// spawnSync used only for spawning the CLI in tests — no shell injection risk
const { spawnSync } = require('child_process');

const { generateReport, formatTerminalReport } = require('./harness-diagnostic.cjs');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-diag-test-'));
}

function writeJson(dir, relPath, data) {
  const absPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, JSON.stringify(data, null, 2), 'utf8');
}

// ─── generateReport Tests ───────────────────────────────────────────────────

test('generateReport returns complete structure with all 6 top-level keys', () => {
  const dir = makeTmpDir();
  const report = generateReport(dir);
  assert.ok(report.timestamp, 'should have timestamp');
  assert.ok(Array.isArray(report.slot_availability), 'should have slot_availability array');
  assert.ok(typeof report.pass_at_k === 'object', 'should have pass_at_k object');
  assert.ok(typeof report.token_spend === 'object', 'should have token_spend object');
  assert.ok(Array.isArray(report.stall_events), 'should have stall_events array');
  assert.ok(typeof report.circuit_breaker === 'object', 'should have circuit_breaker object');
  assert.ok(Array.isArray(report.recommendations), 'should have recommendations array');
});

test('generateReport handles missing scoreboard', () => {
  const dir = makeTmpDir();
  const report = generateReport(dir);
  assert.equal(report.slot_availability.length, 0, 'slot_availability should be empty when no scoreboard');
});

test('generateReport handles missing conformance events', () => {
  const dir = makeTmpDir();
  const report = generateReport(dir);
  assert.equal(report.pass_at_k.total, 0, 'pass_at_k total should be 0 when no events');
});

test('generateReport handles missing token-usage', () => {
  const dir = makeTmpDir();
  const report = generateReport(dir);
  assert.equal(report.token_spend.total_records, 0, 'token_spend total_records should be 0');
});

test('generateReport reads circuit breaker state', () => {
  const dir = makeTmpDir();
  writeJson(dir, '.claude/circuit-breaker-state.json', {
    active: true,
    disabled: false,
    last_triggered: '2026-03-06T10:00:00Z',
  });
  const report = generateReport(dir);
  assert.equal(report.circuit_breaker.active, true, 'circuit_breaker.active should be true');
  assert.equal(report.circuit_breaker.last_triggered, '2026-03-06T10:00:00Z');
});

test('generateReport generates recommendations for degraded slots', () => {
  const dir = makeTmpDir();
  // Create scoreboard with a critical slot
  writeJson(dir, '.planning/quorum/scoreboard.json', {
    slots: {
      'bad-slot:model-a': { tp: 2, fn: 8 },
      'good-slot:model-b': { tp: 18, fn: 2 },
    },
  });
  const report = generateReport(dir);
  const criticalRec = report.recommendations.find(r => r.includes('bad-slot'));
  assert.ok(criticalRec, 'should have recommendation for critical slot');
  assert.ok(criticalRec.includes('20%'), 'should mention the low success rate');
});

test('generateReport generates recommendation when no data', () => {
  const dir = makeTmpDir();
  const report = generateReport(dir);
  assert.ok(
    report.recommendations.some(r => r.includes('No quorum data available')),
    'should recommend running quorum rounds when no data'
  );
});

test('generateReport generates circuit breaker recommendation when active', () => {
  const dir = makeTmpDir();
  // Need some data to avoid the "no data" recommendation
  writeJson(dir, '.planning/quorum/scoreboard.json', {
    slots: { 'slot-a:model': { tp: 10, fn: 0 } },
  });
  writeJson(dir, '.claude/circuit-breaker-state.json', { active: true });
  const report = generateReport(dir);
  assert.ok(
    report.recommendations.some(r => r.includes('Circuit breaker is ACTIVE')),
    'should have circuit breaker recommendation'
  );
});

test('generateReport reads scoreboard slots correctly', () => {
  const dir = makeTmpDir();
  writeJson(dir, '.planning/quorum/scoreboard.json', {
    slots: {
      'claude-1:claude-sonnet-4-20250514': { tp: 20, fn: 2 },
      'claude-1:claude-haiku-4-5-20251001': { tp: 5, fn: 1 },
    },
  });
  const report = generateReport(dir);
  assert.equal(report.slot_availability.length, 1, 'should aggregate by slot name');
  assert.equal(report.slot_availability[0].slot, 'claude-1');
  assert.equal(report.slot_availability[0].total_rounds, 28);
  assert.equal(report.slot_availability[0].successes, 25);
  assert.equal(report.slot_availability[0].status, 'healthy');
});

test('generateReport does not pollute Object.prototype via __proto__ scoreboard slot key', () => {
  const dir = makeTmpDir();
  writeJson(dir, '.planning/quorum/scoreboard.json', {
    slots: { '__proto__:model-a': { tp: 2, fn: 8 } },
  });
  try {
    generateReport(dir);
    assert.equal(
      Object.prototype.hasOwnProperty.call(Object.prototype, 'tp'),
      false,
      'Object.prototype must not gain a tp property'
    );
    assert.equal(({}).tp, undefined, 'plain objects must not inherit a polluted tp');
  } finally {
    delete Object.prototype.tp;
    delete Object.prototype.fn;
  }
});

// ─── formatTerminalReport Tests ─────────────────────────────────────────────

test('formatTerminalReport produces string output', () => {
  const report = generateReport(makeTmpDir());
  const output = formatTerminalReport(report);
  assert.ok(typeof output === 'string', 'output should be a string');
  assert.ok(output.length > 0, 'output should be non-empty');
  assert.ok(output.includes('Harness Diagnostic'), 'output should contain Harness Diagnostic');
});

test('formatTerminalReport includes all sections', () => {
  const report = generateReport(makeTmpDir());
  const output = formatTerminalReport(report);
  assert.ok(output.includes('Slot Availability'), 'should include Slot Availability');
  assert.ok(output.includes('Pass@k'), 'should include Pass@k');
  assert.ok(output.includes('Token Spend'), 'should include Token Spend');
  assert.ok(output.includes('Stall Events'), 'should include Stall Events');
  assert.ok(output.includes('Circuit Breaker'), 'should include Circuit Breaker');
  assert.ok(output.includes('Recommendations'), 'should include Recommendations');
});

test('formatTerminalReport tolerates null and partial report objects', () => {
  assert.doesNotThrow(() => formatTerminalReport(null), 'null report must not throw');
  const out = formatTerminalReport({ timestamp: 'x' });
  assert.ok(typeof out === 'string' && out.length > 0, 'partial report should still render a string');
  assert.ok(out.includes('Recommendations'), 'partial report should still include section headers');
});

// ─── CLI Tests ──────────────────────────────────────────────────────────────

test('CLI --json flag produces valid JSON', () => {
  const dir = makeTmpDir();
  const result = spawnSync('node', [
    path.join(__dirname, 'harness-diagnostic.cjs'),
    '--json', '--cwd', dir,
  ], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, 'should exit 0');
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    assert.fail('stdout should be valid JSON: ' + result.stdout);
  }
  assert.ok(parsed.timestamp, 'JSON should have timestamp');
  assert.ok(Array.isArray(parsed.slot_availability), 'JSON should have slot_availability');
  assert.ok(Array.isArray(parsed.recommendations), 'JSON should have recommendations');
});

test('CLI without --json produces terminal report', () => {
  const dir = makeTmpDir();
  const result = spawnSync('node', [
    path.join(__dirname, 'harness-diagnostic.cjs'),
    '--cwd', dir,
  ], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, 'should exit 0');
  assert.ok(result.stdout.includes('nForma Harness Diagnostic Report'), 'should contain report header');
});

#!/usr/bin/env node
'use strict';
// bin/prism-priority.test.cjs
// Unit tests for SIG-03: PRISM failure probability priority ranker.
// Requirements: SIG-03

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const { readPrismResults, rankFailureModes, formatPrioritySignal } = require('./prism-priority.cjs');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-priority-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── readPrismResults tests ───────────────────────────────────────────────────

describe('readPrismResults', () => {
  test('returns empty array when file does not exist', () => {
    const result = readPrismResults('/nonexistent/path.ndjson');
    assert.deepStrictEqual(result, []);
  });

  test('filters for PRISM entries only', () => {
    const ndjsonPath = path.join(tmpDir, 'check-results.ndjson');
    const lines = [
      JSON.stringify({ formalism: 'prism', check_id: 'prism:quorum', result: 'fail', summary: 'fail: quorum', timestamp: '2026-03-01T00:00:00Z', metadata: {} }),
      JSON.stringify({ formalism: 'tla', check_id: 'ci:tlc', result: 'pass', summary: 'pass: tlc', timestamp: '2026-03-01T00:00:00Z', metadata: {} }),
      JSON.stringify({ formalism: 'trace', check_id: 'ci:traces', result: 'fail', summary: 'fail: traces', timestamp: '2026-03-01T00:00:00Z', metadata: {} }),
      JSON.stringify({ formalism: 'prism', check_id: 'prism:mcp-availability', result: 'warn', summary: 'warn: mcp', timestamp: '2026-03-01T00:00:00Z', metadata: {} }),
    ];
    fs.writeFileSync(ndjsonPath, lines.join('\n'));

    const result = readPrismResults(ndjsonPath);
    assert.strictEqual(result.length, 2, 'Should return only PRISM entries');
    const checkIds = result.map(r => r.check_id).sort();
    assert.deepStrictEqual(checkIds, ['prism:mcp-availability', 'prism:quorum']);
  });

  test('keeps only most recent entry per check_id', () => {
    const ndjsonPath = path.join(tmpDir, 'check-results.ndjson');
    const lines = [
      JSON.stringify({ formalism: 'prism', check_id: 'prism:quorum', result: 'fail', summary: 'old fail', timestamp: '2026-03-01T00:00:00Z', metadata: {} }),
      JSON.stringify({ formalism: 'prism', check_id: 'prism:quorum', result: 'pass', summary: 'new pass', timestamp: '2026-03-01T01:00:00Z', metadata: {} }),
    ];
    fs.writeFileSync(ndjsonPath, lines.join('\n'));

    const result = readPrismResults(ndjsonPath);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].summary, 'new pass', 'Should keep the most recent entry');
  });
});

// ── rankFailureModes tests ───────────────────────────────────────────────────

describe('rankFailureModes', () => {
  test('returns empty array when no failures', () => {
    const results = [
      { check_id: 'prism:quorum', result: 'pass', summary: 'pass', timestamp: '', metadata: {} },
    ];
    const ranked = rankFailureModes(results);
    assert.deepStrictEqual(ranked, []);
  });

  test('ranks failures by P(failure) x impact', () => {
    const results = [
      { check_id: 'prism:quorum', result: 'fail', summary: 'fail: quorum', timestamp: '', metadata: {} },
      { check_id: 'prism:mcp-availability', result: 'warn', summary: 'warn: mcp', timestamp: '', metadata: {} },
    ];
    const ranked = rankFailureModes(results);
    assert.strictEqual(ranked.length, 2);
    // prism:quorum: P=1.0, impact=10, priority=10.0
    // prism:mcp-availability: P=0.5, impact=7, priority=3.5
    assert.strictEqual(ranked[0].check_id, 'prism:quorum', 'Quorum should be ranked first');
    assert.strictEqual(ranked[0].priority, 10.0);
    assert.strictEqual(ranked[1].check_id, 'prism:mcp-availability');
    assert.strictEqual(ranked[1].priority, 3.5);
  });

  test('assigns correct impact scores', () => {
    const results = [
      { check_id: 'prism:quorum', result: 'fail', summary: 's1', timestamp: '', metadata: {} },
      { check_id: 'prism:mcp-availability', result: 'fail', summary: 's2', timestamp: '', metadata: {} },
      { check_id: 'prism:unknown-model', result: 'fail', summary: 's3', timestamp: '', metadata: {} },
    ];
    const ranked = rankFailureModes(results);
    const quorum = ranked.find(r => r.check_id === 'prism:quorum');
    const mcp    = ranked.find(r => r.check_id === 'prism:mcp-availability');
    const unknown = ranked.find(r => r.check_id === 'prism:unknown-model');
    assert.strictEqual(quorum.impact, 10, 'prism:quorum should have impact 10');
    assert.strictEqual(mcp.impact, 7, 'prism:mcp-availability should have impact 7');
    assert.strictEqual(unknown.impact, 5, 'Unknown check_id should have default impact 5');
  });
});

describe('rankFailureModes — prototype-pollution check_id', () => {
  test('uses default impact for __proto__ / constructor check_id', () => {
    const results = [
      { check_id: '__proto__', result: 'fail', summary: 'evil', timestamp: '', metadata: {} },
      { check_id: 'constructor', result: 'fail', summary: 'evil2', timestamp: '', metadata: {} },
    ];
    const ranked = rankFailureModes(results);
    const proto = ranked.find(r => r.check_id === '__proto__');
    const ctor  = ranked.find(r => r.check_id === 'constructor');
    assert.strictEqual(proto.impact, 5, '__proto__ check_id should fall back to default impact 5');
    assert.strictEqual(proto.priority, 5.0, 'priority must be a finite number, not NaN');
    assert.ok(!Number.isNaN(proto.priority), 'priority must not be NaN');
    assert.strictEqual(ctor.impact, 5, 'constructor check_id should fall back to default impact 5');
    assert.ok(!Number.isNaN(ctor.priority), 'priority must not be NaN');
  });
});

describe('rankFailureModes — non-array input', () => {
  test('returns empty array for null/undefined/non-array input', () => {
    assert.deepStrictEqual(rankFailureModes(null), []);
    assert.deepStrictEqual(rankFailureModes(undefined), []);
    assert.deepStrictEqual(rankFailureModes({}), []);
  });
});

// ── formatPrioritySignal tests ───────────────────────────────────────────────

describe('formatPrioritySignal', () => {
  test('returns null when no failures', () => {
    const result = formatPrioritySignal([]);
    assert.strictEqual(result, null);
  });

  test('produces formatted text block', () => {
    const ranked = [
      { check_id: 'prism:quorum', priority: 10.0, p_failure: 1.0, impact: 10, summary: 'fail: quorum in 500ms' },
      { check_id: 'prism:mcp-availability', priority: 3.5, p_failure: 0.5, impact: 7, summary: 'warn: mcp-availability' },
    ];
    const result = formatPrioritySignal(ranked);
    assert.ok(result.includes('=== PRISM Priority Signal ==='), 'Should contain header');
    assert.ok(result.includes('[prism:quorum]'), 'Should contain quorum entry');
    assert.ok(result.includes('[prism:mcp-availability]'), 'Should contain mcp entry');
    // Check order: quorum should appear before mcp
    const quorumIdx = result.indexOf('[prism:quorum]');
    const mcpIdx    = result.indexOf('[prism:mcp-availability]');
    assert.ok(quorumIdx < mcpIdx, 'Quorum should appear before mcp-availability');
  });
});

// ── CLI test ─────────────────────────────────────────────────────────────────

test('CLI prints signal to stdout', () => {
  const ndjsonPath = path.join(tmpDir, 'check-results.ndjson');
  const formalDir  = path.join(tmpDir, '.planning', 'formal');
  fs.mkdirSync(formalDir, { recursive: true });
  const realNdjsonPath = path.join(formalDir, 'check-results.ndjson');

  const lines = [
    JSON.stringify({ formalism: 'prism', check_id: 'prism:quorum', result: 'fail', summary: 'fail: quorum in 500ms', timestamp: '2026-03-01T00:00:00Z', metadata: {} }),
  ];
  fs.writeFileSync(realNdjsonPath, lines.join('\n'));

  const SCRIPT = path.join(__dirname, 'prism-priority.cjs');
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    cwd: tmpDir,
  });

  assert.ok(result.stdout.includes('PRISM Priority Signal'), 'Should print priority signal to stdout');
});

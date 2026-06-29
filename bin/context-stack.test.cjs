#!/usr/bin/env node
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const {
  append,
  queryRecentPhases,
  queryByType,
  formatInjection,
  getStackPath,
  prune,
  STACK_FILE,
  MAX_ENTRIES_PER_PHASE,
  INJECTION_CAP_CHARS,
} = require('./context-stack.cjs');

// --- append tests ---

describe('append', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-stack-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates file and writes valid JSONL line', () => {
    const result = append(tmpDir, {
      phase: 'v0.30-05',
      type: 'architecture_decision',
      content: 'Used node:test runner',
      tags: ['testing'],
    });
    assert.equal(result.phase, 'v0.30-05');
    assert.equal(result.type, 'architecture_decision');
    assert.equal(result.content, 'Used node:test runner');

    const filePath = getStackPath(tmpDir);
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    const parsed = JSON.parse(raw);
    assert.equal(parsed.phase, 'v0.30-05');
  });

  it('adds ts field to entry', () => {
    const result = append(tmpDir, {
      phase: 'v0.30-05',
      type: 'test_result',
      content: 'all tests pass',
    });
    assert.ok(result.ts);
    assert.ok(result.ts.includes('T')); // ISO format
  });

  it('validates type field - invalid type falls back to constraint', () => {
    const result = append(tmpDir, {
      phase: 'v0.30-05',
      type: 'invalid_type',
      content: 'some content',
    });
    assert.equal(result.type, 'constraint');
  });

  it('enforces MAX_ENTRIES_PER_PHASE - skips after 10 for same phase', () => {
    for (let i = 0; i < MAX_ENTRIES_PER_PHASE; i++) {
      append(tmpDir, {
        phase: 'v0.30-05',
        type: 'constraint',
        content: `entry ${i}`,
      });
    }
    const result = append(tmpDir, {
      phase: 'v0.30-05',
      type: 'constraint',
      content: 'entry 11 - should be skipped',
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'phase_cap_reached');
  });

  it('allows entries for different phases even when one is capped', () => {
    for (let i = 0; i < MAX_ENTRIES_PER_PHASE; i++) {
      append(tmpDir, { phase: 'v0.30-05', type: 'constraint', content: `entry ${i}` });
    }
    const result = append(tmpDir, {
      phase: 'v0.30-06',
      type: 'constraint',
      content: 'different phase',
    });
    assert.ok(!result.skipped);
    assert.equal(result.phase, 'v0.30-06');
  });
});

// --- queryRecentPhases tests ---

describe('queryRecentPhases', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-stack-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('excludes current phase from results', () => {
    append(tmpDir, { phase: 'v0.30-04', type: 'constraint', content: 'old' });
    append(tmpDir, { phase: 'v0.30-05', type: 'constraint', content: 'current' });

    const result = queryRecentPhases(tmpDir, 'v0.30-05');
    assert.ok(result.every(e => e.phase !== 'v0.30-05'));
    assert.ok(result.some(e => e.phase === 'v0.30-04'));
  });

  it('returns only last N phases', () => {
    append(tmpDir, { phase: 'v0.30-01', type: 'constraint', content: 'a' });
    append(tmpDir, { phase: 'v0.30-02', type: 'constraint', content: 'b' });
    append(tmpDir, { phase: 'v0.30-03', type: 'constraint', content: 'c' });
    append(tmpDir, { phase: 'v0.30-04', type: 'constraint', content: 'd' });
    append(tmpDir, { phase: 'v0.30-05', type: 'constraint', content: 'e' });

    const result = queryRecentPhases(tmpDir, 'v0.30-05', 2);
    const phases = [...new Set(result.map(e => e.phase))];
    assert.ok(phases.length <= 2);
    assert.ok(phases.includes('v0.30-04'));
    assert.ok(phases.includes('v0.30-03'));
  });

  it('returns empty array when file missing', () => {
    const result = queryRecentPhases(tmpDir, 'v0.30-05');
    assert.deepEqual(result, []);
  });

  it('skips malformed JSONL lines', () => {
    const filePath = getStackPath(tmpDir);
    fs.appendFileSync(filePath, '{"phase":"v0.30-04","type":"constraint","content":"good","tags":[],"ts":"2026-01-01T00:00:00Z"}\n');
    fs.appendFileSync(filePath, 'NOT JSON\n');
    fs.appendFileSync(filePath, '{"phase":"v0.30-04","type":"constraint","content":"also good","tags":[],"ts":"2026-01-02T00:00:00Z"}\n');

    const result = queryRecentPhases(tmpDir, 'v0.30-05');
    assert.equal(result.length, 2);
  });
});

describe('queryRecentPhases maxPhases boundary', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-stack-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty when maxPhases is 0 (slice(-0) must not select all)', () => {
    append(tmpDir, { phase: 'v0.30-01', type: 'constraint', content: 'a' });
    append(tmpDir, { phase: 'v0.30-02', type: 'constraint', content: 'b' });

    const result = queryRecentPhases(tmpDir, 'v0.30-05', 0);
    assert.deepEqual(result, []);
  });

  it('returns empty when maxPhases is NaN', () => {
    append(tmpDir, { phase: 'v0.30-01', type: 'constraint', content: 'a' });

    const result = queryRecentPhases(tmpDir, 'v0.30-05', NaN);
    assert.deepEqual(result, []);
  });
});

// --- queryByType tests ---

describe('queryByType', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-stack-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('filters by type correctly', () => {
    append(tmpDir, { phase: 'v0.30-04', type: 'constraint', content: 'a' });
    append(tmpDir, { phase: 'v0.30-04', type: 'test_result', content: 'b' });
    append(tmpDir, { phase: 'v0.30-04', type: 'constraint', content: 'c' });

    const result = queryByType(tmpDir, 'constraint');
    assert.ok(result.every(e => e.type === 'constraint'));
    assert.equal(result.length, 2);
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      append(tmpDir, { phase: 'v0.30-04', type: 'constraint', content: `entry ${i}` });
    }
    const result = queryByType(tmpDir, 'constraint', 2);
    assert.equal(result.length, 2);
  });

  it('returns newest-first', () => {
    append(tmpDir, { phase: 'v0.30-04', type: 'constraint', content: 'first' });
    append(tmpDir, { phase: 'v0.30-04', type: 'constraint', content: 'second' });

    const result = queryByType(tmpDir, 'constraint');
    assert.equal(result[0].content, 'second');
    assert.equal(result[1].content, 'first');
  });
});

// --- formatInjection tests ---

describe('formatInjection', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-stack-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no entries', () => {
    const result = formatInjection(tmpDir, 'v0.30-05');
    assert.equal(result, null);
  });

  it('respects INJECTION_CAP_CHARS', () => {
    // Add many entries with long content to exceed cap
    for (let i = 0; i < 10; i++) {
      append(tmpDir, {
        phase: 'v0.30-04',
        type: 'architecture_decision',
        content: 'A'.repeat(300) + ` entry-${i}`,
      });
    }

    const result = formatInjection(tmpDir, 'v0.30-05');
    assert.ok(result);
    assert.ok(result.length <= INJECTION_CAP_CHARS);
  });

  it('excludes current phase', () => {
    append(tmpDir, { phase: 'v0.30-04', type: 'constraint', content: 'old phase' });
    append(tmpDir, { phase: 'v0.30-05', type: 'constraint', content: 'current phase' });

    const result = formatInjection(tmpDir, 'v0.30-05');
    assert.ok(result);
    assert.ok(!result.includes('current phase'));
    assert.ok(result.includes('old phase'));
  });

  it('includes phase and type in formatted output', () => {
    append(tmpDir, { phase: 'v0.30-04', type: 'architecture_decision', content: 'Used node:test' });

    const result = formatInjection(tmpDir, 'v0.30-05');
    assert.ok(result.includes('[v0.30-04]'));
    assert.ok(result.includes('architecture_decision'));
    assert.ok(result.includes('Used node:test'));
    assert.ok(result.includes('Context Stack'));
  });
});

// --- prune tests ---

describe('prune', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-stack-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps only entries from recent phases', () => {
    append(tmpDir, { phase: 'v0.30-01', type: 'constraint', content: 'oldest' });
    append(tmpDir, { phase: 'v0.30-02', type: 'constraint', content: 'old' });
    append(tmpDir, { phase: 'v0.30-03', type: 'constraint', content: 'recent' });

    const result = prune(tmpDir, 2);
    assert.equal(result.removed, 1);
    assert.equal(result.remaining, 2);

    // Verify file contents
    const filePath = getStackPath(tmpDir);
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    const entries = lines.map(l => JSON.parse(l));
    assert.ok(entries.every(e => e.phase !== 'v0.30-01'));
  });

  it('returns correct removed/remaining counts', () => {
    append(tmpDir, { phase: 'v0.30-01', type: 'constraint', content: 'a' });
    append(tmpDir, { phase: 'v0.30-01', type: 'constraint', content: 'b' });
    append(tmpDir, { phase: 'v0.30-02', type: 'constraint', content: 'c' });

    const result = prune(tmpDir, 1);
    assert.equal(result.removed, 2);
    assert.equal(result.remaining, 1);
  });

  it('handles empty file', () => {
    const result = prune(tmpDir, 5);
    assert.equal(result.removed, 0);
    assert.equal(result.remaining, 0);
  });
});

describe('prune keepPhases boundary', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-stack-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes all entries when keepPhases is 0 (slice(-0) must not keep all)', () => {
    append(tmpDir, { phase: 'v0.30-01', type: 'constraint', content: 'a' });
    append(tmpDir, { phase: 'v0.30-02', type: 'constraint', content: 'b' });

    const result = prune(tmpDir, 0);
    assert.equal(result.remaining, 0);
    assert.equal(result.removed, 2);

    const filePath = getStackPath(tmpDir);
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    assert.equal(raw, '');
  });
});

// --- Fail-open ---

describe('Fail-open', () => {
  it('CLI with no args exits 0', () => {
    const script = path.join(__dirname, 'context-stack.cjs');
    const result = execFileSync('node', [script], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(typeof result, 'string');
  });
});

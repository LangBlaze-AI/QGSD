#!/usr/bin/env node
'use strict';
// bin/state-candidates.test.cjs
// Tests for state-candidates.cjs

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('node:os');

const ROOT = process.env.PROJECT_ROOT || path.join(__dirname, '..');
const OUTPUT_PATH = path.join(ROOT, '.planning', 'formal', 'evidence', 'state-candidates.json');

describe('state-candidates unmapped action detection', () => {
  it('detects actions not in vocabulary', () => {
    const vocab = { quorum_start: {}, quorum_complete: {} };
    const vocabActions = new Set(Object.keys(vocab));
    const events = [
      { action: 'quorum_start' },
      { action: 'unknown_action' },
      { action: 'quorum_complete' },
    ];
    const unmapped = events.filter(e => !vocabActions.has(e.action));
    assert.strictEqual(unmapped.length, 1);
    assert.strictEqual(unmapped[0].action, 'unknown_action');
  });

  it('detects events with no action field', () => {
    const vocabActions = new Set(['quorum_start']);
    const events = [
      { type: 'some_type' }, // no action field
    ];
    const unmapped = events.filter(e => !vocabActions.has(e.action || e.type || 'undefined'));
    assert.strictEqual(unmapped.length, 1);
  });
});

describe('state-candidates deduplication', () => {
  it('deduplicates same action into one candidate', () => {
    const clusters = {};
    const actions = ['unknown_x', 'unknown_x', 'unknown_y', 'unknown_x'];
    for (const a of actions) {
      if (!clusters[a]) clusters[a] = { count: 0 };
      clusters[a].count++;
    }
    assert.strictEqual(Object.keys(clusters).length, 2);
    assert.strictEqual(clusters.unknown_x.count, 3);
    assert.strictEqual(clusters.unknown_y.count, 1);
  });
});

describe('state-candidates context extraction', () => {
  it('tracks before/after context', () => {
    const events = [
      { action: 'quorum_start', ts: '2026-01-01T00:00:00Z' },
      { action: 'unknown_action', ts: '2026-01-01T00:01:00Z' },
      { action: 'quorum_complete', ts: '2026-01-01T00:02:00Z' },
    ];

    const contextBefore = {};
    const contextAfter = {};
    // Event at index 1 is unknown
    const prevAction = events[0].action;
    const nextAction = events[2].action;
    contextBefore[prevAction] = (contextBefore[prevAction] || 0) + 1;
    contextAfter[nextAction] = (contextAfter[nextAction] || 0) + 1;

    assert.strictEqual(contextBefore.quorum_start, 1);
    assert.strictEqual(contextAfter.quorum_complete, 1);
  });
});

describe('state-candidates mapToXStateEvent import', () => {
  it('imports mapToXStateEvent from validate-traces.cjs', () => {
    const { mapToXStateEvent } = require('./validate-traces.cjs');
    assert.strictEqual(typeof mapToXStateEvent, 'function',
      'mapToXStateEvent must be exported from validate-traces.cjs');
  });
});

describe('state-candidates integration', () => {
  before(() => {
    execFileSync('node', ['bin/state-candidates.cjs'], { cwd: ROOT, stdio: 'pipe' });
  });

  it('identifies at least 1 candidate', () => {
    const result = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    assert.ok(result.candidates.length >= 1,
      `Expected at least 1 candidate from undefined/unmapped actions, got ${result.candidates.length}`);
  });

  it('has unmapped event count', () => {
    const result = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    assert.ok(result.total_unmapped_events >= 1,
      `Expected unmapped events, got ${result.total_unmapped_events}`);
  });

  it('has schema_version', () => {
    const result = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    assert.strictEqual(result.schema_version, '1');
  });

  it('candidates have required fields', () => {
    const result = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    for (const c of result.candidates) {
      assert.ok('action' in c, 'Missing action');
      assert.ok('count' in c, 'Missing count');
      assert.ok('suggested_state' in c, 'Missing suggested_state');
      assert.ok('confidence' in c, 'Missing confidence');
      assert.ok('context_before' in c, 'Missing context_before');
      assert.ok('context_after' in c, 'Missing context_after');
    }
  });
});

describe('state-candidates malformed vocabulary hardening', () => {
  it('does not crash when event-vocabulary.json lacks a vocabulary key', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-vocab-'));
    fs.mkdirSync(path.join(tmp, '.planning', 'formal', 'evidence'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.planning', 'telemetry'), { recursive: true });
    // Valid JSON but NO `vocabulary` property
    fs.writeFileSync(
      path.join(tmp, '.planning', 'formal', 'evidence', 'event-vocabulary.json'),
      JSON.stringify({ schema_version: '1' }),
    );
    fs.writeFileSync(
      path.join(tmp, '.planning', 'telemetry', 'conformance-events.jsonl'),
      JSON.stringify({ action: 'unknown_x', ts: '2026-01-01T00:00:00Z' }) + '\n',
    );
    assert.doesNotThrow(() => {
      execFileSync('node', [path.join(ROOT, 'bin', 'state-candidates.cjs')], {
        cwd: tmp,
        env: { ...process.env, PROJECT_ROOT: tmp },
        stdio: 'pipe',
      });
    });
    const out = JSON.parse(fs.readFileSync(
      path.join(tmp, '.planning', 'formal', 'evidence', 'state-candidates.json'), 'utf8'));
    // With an empty vocabulary, the lone event is unmapped
    assert.ok(out.total_unmapped_events >= 1);
  });
});

describe('state-candidates malformed event line hardening', () => {
  it('does not crash when a conformance-events line parses to null', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-null-'));
    fs.mkdirSync(path.join(tmp, '.planning', 'formal', 'evidence'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.planning', 'telemetry'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.planning', 'formal', 'evidence', 'event-vocabulary.json'),
      JSON.stringify({ vocabulary: { quorum_start: {} } }),
    );
    // 'null' is valid JSON: it survives JSON.parse and crashes the sort comparator
    fs.writeFileSync(
      path.join(tmp, '.planning', 'telemetry', 'conformance-events.jsonl'),
      'null\n' + JSON.stringify({ action: 'unknown_x', ts: '2026-01-01T00:00:00Z' }) + '\n',
    );
    assert.doesNotThrow(() => {
      execFileSync('node', [path.join(ROOT, 'bin', 'state-candidates.cjs')], {
        cwd: tmp,
        env: { ...process.env, PROJECT_ROOT: tmp },
        stdio: 'pipe',
      });
    });
  });
});

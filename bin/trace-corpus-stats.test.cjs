#!/usr/bin/env node
'use strict';
// bin/trace-corpus-stats.test.cjs
// Tests for trace-corpus-stats.cjs

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = process.env.PROJECT_ROOT || path.join(__dirname, '..');
const OUTPUT_PATH = path.join(ROOT, '.planning', 'formal', 'evidence', 'trace-corpus-stats.json');

const { inferSessions, summarizeSession } = require('./trace-corpus-stats.cjs');

describe('trace-corpus-stats session inference', () => {
  it('groups events within gap threshold into one session', () => {
    const events = [
      { ts: '2026-03-01T10:00:00Z', action: 'quorum_start' },
      { ts: '2026-03-01T10:01:00Z', action: 'quorum_complete' },
      { ts: '2026-03-01T10:02:00Z', action: 'circuit_break' },
    ];
    const sessions = inferSessions(events, 300000);
    assert.strictEqual(sessions.length, 1, 'All events within 5min gap = 1 session');
  });

  it('splits sessions on gaps exceeding threshold', () => {
    const events = [
      { ts: '2026-03-01T10:00:00Z', action: 'quorum_start' },
      { ts: '2026-03-01T10:01:00Z', action: 'quorum_complete' },
      { ts: '2026-03-01T11:00:00Z', action: 'quorum_start' }, // 59 min gap
      { ts: '2026-03-01T11:01:00Z', action: 'quorum_complete' },
    ];
    const sessions = inferSessions(events, 300000);
    assert.strictEqual(sessions.length, 2, 'Gap > 5min should split into 2 sessions');
  });

  it('handles single-event session', () => {
    const events = [
      { ts: '2026-03-01T10:00:00Z', action: 'quorum_start' },
    ];
    const sessions = inferSessions(events, 300000);
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].events.length, 1);

    const summary = summarizeSession(sessions[0]);
    assert.strictEqual(summary.event_count, 1);
    assert.strictEqual(summary.start, summary.end, 'Single event: start === end');
  });

  it('groups events with identical timestamps into same session', () => {
    const events = [
      { ts: '2026-03-01T10:00:00Z', action: 'quorum_start' },
      { ts: '2026-03-01T10:00:00Z', action: 'quorum_complete' },
      { ts: '2026-03-01T10:00:00Z', action: 'circuit_break' },
    ];
    const sessions = inferSessions(events, 300000);
    assert.strictEqual(sessions.length, 1, 'Identical timestamps = 0 gap < threshold');
    assert.strictEqual(sessions[0].events.length, 3);
  });

  it('handles empty events array', () => {
    const sessions = inferSessions([], 300000);
    assert.strictEqual(sessions.length, 0);
  });

  it('respects custom session gap threshold', () => {
    const events = [
      { ts: '2026-03-01T10:00:00Z', action: 'quorum_start' },
      { ts: '2026-03-01T10:03:00Z', action: 'quorum_complete' }, // 3 min gap
      { ts: '2026-03-01T10:06:00Z', action: 'circuit_break' },   // 3 min gap
    ];
    // With 2-minute threshold, each 3-min gap creates a new session
    const sessions = inferSessions(events, 120000);
    assert.strictEqual(sessions.length, 3, '2min threshold should split 3min gaps');

    // With 5-minute threshold, all in one session
    const sessions2 = inferSessions(events, 300000);
    assert.strictEqual(sessions2.length, 1, '5min threshold should keep all together');
  });

  it('tolerates non-object (null) event entries without crashing', () => {
    const events = [
      { ts: '2026-03-01T10:00:00Z', action: 'quorum_start' },
      null, // valid-JSON-but-non-object line from the corpus
      { ts: '2026-03-01T10:01:00Z', action: 'quorum_complete' },
    ];
    assert.doesNotThrow(() => inferSessions(events, 300000));
    const sessions = inferSessions(events, 300000);
    assert.ok(sessions.length >= 1, 'should still produce at least one session');
  });
});

describe('trace-corpus-stats action indexing', () => {
  it('counts actions correctly in session summary', () => {
    const session = {
      id: 'test-001',
      events: [
        { ts: '2026-03-01T10:00:00Z', action: 'quorum_start' },
        { ts: '2026-03-01T10:01:00Z', action: 'quorum_start' },
        { ts: '2026-03-01T10:02:00Z', action: 'quorum_complete' },
      ],
    };
    const summary = summarizeSession(session);
    assert.strictEqual(summary.actions.quorum_start, 2);
    assert.strictEqual(summary.actions.quorum_complete, 1);
    assert.strictEqual(summary.event_count, 3);
  });

  it('maps undefined action to "undefined" key', () => {
    const session = {
      id: 'test-002',
      events: [
        { ts: '2026-03-01T10:00:00Z' }, // no action field
      ],
    };
    const summary = summarizeSession(session);
    assert.strictEqual(summary.actions.undefined, 1);
  });

  it('tolerates non-object (null) event entries in a session', () => {
    const session = {
      id: 'test-003',
      events: [
        { ts: '2026-03-01T10:00:00Z', action: 'quorum_start' },
        null, // non-object line that slipped through JSON.parse
      ],
    };
    let summary;
    assert.doesNotThrow(() => { summary = summarizeSession(session); });
    assert.strictEqual(summary.event_count, 2);
    assert.strictEqual(summary.actions.quorum_start, 1);
    assert.strictEqual(summary.actions.undefined, 1, 'null entry counts as undefined action');
  });
});

describe('trace-corpus-stats vocabulary validation', () => {
  it('vocabulary file is loadable', () => {
    const vocab = JSON.parse(fs.readFileSync(
      path.join(ROOT, '.planning', 'formal', 'evidence', 'event-vocabulary.json'), 'utf8'
    ));
    assert.ok(Object.keys(vocab.vocabulary).length >= 7);
  });
});

describe('trace-corpus-stats integration', () => {
  before(() => {
    execFileSync('node', ['bin/trace-corpus-stats.cjs'], { cwd: ROOT, stdio: 'pipe' });
  });

  it('produces output with expected event count', () => {
    const result = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    assert.ok(result.total_events >= 35000,
      `Expected 35K+ events, got ${result.total_events}`);
  });

  it('has sessions', () => {
    const result = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    assert.ok(result.sessions.length >= 1, 'Should have at least 1 session');
  });

  it('uses default session gap', () => {
    const result = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    assert.strictEqual(result.session_gap_ms, 300000, 'Default session_gap_ms should be 300000');
  });

  it('has vocabulary validation', () => {
    const result = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    assert.ok('vocabulary_validation' in result);
    assert.ok('known' in result.vocabulary_validation);
    assert.ok('unknown' in result.vocabulary_validation);
  });
});

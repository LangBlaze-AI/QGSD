#!/usr/bin/env node
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  buildObservedFSM, extractModelTransitions, mergeAdjacency, compareWithModel, stateToString
} = require('./observed-fsm.cjs');

// ── Unit tests ──────────────────────────────────────────────────────────────

describe('stateToString', () => {
  it('converts string state to string', () => {
    assert.strictEqual(stateToString('IDLE'), 'IDLE');
  });

  it('converts object state to JSON string', () => {
    assert.strictEqual(stateToString({ a: 1 }), '{"a":1}');
  });
});

describe('extractModelTransitions', () => {
  it('returns states and transitions from the XState machine', () => {
    const model = extractModelTransitions();
    assert.ok(Array.isArray(model.states), 'states should be array');
    assert.ok(model.states.length >= 3, 'Should have at least 3 states');
    assert.ok(model.states.includes('IDLE'), 'Should include IDLE');
    assert.ok(Array.isArray(model.transitions), 'transitions should be array');
    assert.ok(model.transitions.length >= 3, 'Should have at least 3 transitions');
  });
});

describe('mergeAdjacency', () => {
  it('merges per-event and per-session adjacency maps', () => {
    const perEvent = {
      IDLE: { QUORUM_START: { to_state: 'COLLECTING_VOTES', count: 10 } }
    };
    const perSession = {
      IDLE: { QUORUM_START: { to_state: 'COLLECTING_VOTES', count: 8 } },
      COLLECTING_VOTES: { VOTES_COLLECTED: { to_state: 'DELIBERATING', count: 5 } }
    };
    const merged = mergeAdjacency(perEvent, perSession);

    assert.strictEqual(merged.IDLE.QUORUM_START.source, 'both');
    assert.strictEqual(merged.COLLECTING_VOTES.VOTES_COLLECTED.source, 'per_session');
  });

  it('marks per-event-only transitions correctly', () => {
    const perEvent = { IDLE: { CIRCUIT_BREAK: { to_state: 'IDLE', count: 3 } } };
    const perSession = {};
    const merged = mergeAdjacency(perEvent, perSession);
    assert.strictEqual(merged.IDLE.CIRCUIT_BREAK.source, 'per_event');
  });
});

describe('compareWithModel', () => {
  it('identifies matching transitions', () => {
    const adjacency = {
      IDLE: { QUORUM_START: { to_state: 'COLLECTING_VOTES', count: 10 } }
    };
    const modelTransitions = [
      { from: 'IDLE', event: 'QUORUM_START', to: 'COLLECTING_VOTES' },
      { from: 'IDLE', event: 'CIRCUIT_BREAK', to: 'IDLE' },
    ];
    const result = compareWithModel(adjacency, modelTransitions);
    assert.strictEqual(result.matching.length, 1);
    assert.strictEqual(result.missing_in_observed.length, 1);
  });

  it('identifies transitions missing in model', () => {
    const adjacency = {
      IDLE: { UNKNOWN_EVENT: { to_state: 'WEIRD', count: 1 } }
    };
    const modelTransitions = [];
    const result = compareWithModel(adjacency, modelTransitions);
    assert.strictEqual(result.missing_in_model.length, 1);
  });
});

describe('per-session replay captures multi-step transitions', () => {
  it('per-session mode captures >= per-event transitions on a multi-step session (hermetic)', () => {
    // Build from a synthetic single-session trace rather than reading the
    // checked-in observed-fsm.json. That artifact is generated from whatever
    // trace data exists at generation time, so on a fresh checkout it
    // legitimately has sessions_replayed=0 / per_session=0 — asserting
    // per_session >= per_event against it fails as 0 >= N (the bug that slipped
    // through until this file was gated). Here we replay a known multi-step
    // session so the invariant is tested against the ALGORITHM, deterministically.
    const events = [
      { action: 'quorum_start',    ts: '2025-01-01T00:00:01Z', slots_available: 3 },
      { action: 'quorum_complete', ts: '2025-01-01T00:00:02Z', vote_result: 3 },
      { action: 'quorum_block',    ts: '2025-01-01T00:00:03Z' },
    ];
    const traceStats = { sessions: [{ start: '2025-01-01T00:00:00Z', end: '2025-01-01T00:01:00Z' }] };
    const fsm = buildObservedFSM(events, traceStats);
    const rm = fsm.replay_modes;

    assert.strictEqual(rm.sessions_replayed, 1, 'the single session should be replayed');
    assert.ok(rm.per_session_transitions >= rm.per_event_transitions,
      `per_session (${rm.per_session_transitions}) should be >= per_event (${rm.per_event_transitions})`);
    // Per-session runs one actor through the whole sequence, so it must capture
    // at least one transition OUT OF a non-IDLE state — something per-event
    // isolation (fresh IDLE actor per event) structurally cannot do.
    const fromStates = Object.keys(fsm.observed_transitions || {});
    assert.ok(fromStates.some(s => s !== 'IDLE'),
      `expected a non-IDLE source state from per-session replay, got ${JSON.stringify(fromStates)}`);
  });
});

// ── Integration tests ───────────────────────────────────────────────────────

describe('integration', () => {
  it('observed-fsm.json exists and has expected structure', () => {
    const fsmPath = path.join(ROOT, '.planning', 'formal', 'semantics', 'observed-fsm.json');
    assert.ok(fs.existsSync(fsmPath), 'observed-fsm.json should exist');
    const fsm = JSON.parse(fs.readFileSync(fsmPath, 'utf8'));
    assert.strictEqual(fsm.schema_version, '1');
    assert.ok(Array.isArray(fsm.states_observed));
    assert.ok(fsm.states_observed.length > 0, 'Should have observed states');
  });

  it('vocabulary_coverage < 1.0 (unmapped events exist)', () => {
    const fsmPath = path.join(ROOT, '.planning', 'formal', 'semantics', 'observed-fsm.json');
    const fsm = JSON.parse(fs.readFileSync(fsmPath, 'utf8'));
    assert.ok(fsm.coverage.vocabulary_coverage < 1.0,
      `Vocab coverage should be < 1.0, got ${fsm.coverage.vocabulary_coverage}`);
  });

  it('output is JSON object, NOT XState machine definition', () => {
    const fsmPath = path.join(ROOT, '.planning', 'formal', 'semantics', 'observed-fsm.json');
    const fsm = JSON.parse(fs.readFileSync(fsmPath, 'utf8'));
    assert.ok(!('initial' in fsm), 'Should NOT have XState "initial" key');
    assert.ok(!('states' in fsm) || !fsm.states || !fsm.states.IDLE,
      'Should NOT have XState "states" structure');
  });

  it('coverage metrics are present', () => {
    const fsmPath = path.join(ROOT, '.planning', 'formal', 'semantics', 'observed-fsm.json');
    const fsm = JSON.parse(fs.readFileSync(fsmPath, 'utf8'));
    assert.ok(typeof fsm.coverage.model_coverage === 'number');
    assert.ok(typeof fsm.coverage.vocabulary_coverage === 'number');
    assert.ok(typeof fsm.coverage.total_events === 'number');
    assert.ok(fsm.coverage.total_events > 0);
  });

  it('model comparison has all three arrays', () => {
    const fsmPath = path.join(ROOT, '.planning', 'formal', 'semantics', 'observed-fsm.json');
    const fsm = JSON.parse(fs.readFileSync(fsmPath, 'utf8'));
    assert.ok(Array.isArray(fsm.model_comparison.matching));
    assert.ok(Array.isArray(fsm.model_comparison.missing_in_observed));
    assert.ok(Array.isArray(fsm.model_comparison.missing_in_model));
  });
});

// ── Adversarial hardening tests ───────────────────────────────────────────────

describe('replayPerSession — adversarial traceStats', () => {
  it('does not crash on a null session entry in traceStats.sessions', () => {
    assert.doesNotThrow(() =>
      buildObservedFSM([], { sessions: [null] }));
  });

  it('does not crash on a non-object session entry', () => {
    assert.doesNotThrow(() =>
      buildObservedFSM([], { sessions: ['oops', 42] }));
  });
});

describe('replayPerSession — adversarial conformance events', () => {
  it('does not crash on a null event entry when a valid session exists', () => {
    assert.doesNotThrow(() =>
      buildObservedFSM([null], {
        sessions: [{ start: '2020-01-01T00:00:00Z', end: '2030-01-01T00:00:00Z' }]
      }));
  });
});

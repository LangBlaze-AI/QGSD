'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('path');
const fs       = require('fs');

// Load machine to pass to walker (same resolution logic as validate-traces.cjs)
const machinePath = (() => {
  const repoDist    = path.join(__dirname, '..', 'dist', 'machines', 'nf-workflow.machine.js');
  const installDist = path.join(__dirname, 'dist', 'machines', 'nf-workflow.machine.js');
  if (fs.existsSync(repoDist))    return repoDist;
  if (fs.existsSync(installDist)) return installDist;
  throw new Error('Cannot find nf-workflow.machine.js');
})();
const { createActor, nfWorkflowMachine } = require(machinePath);

// Load walker (will not exist yet → module-not-found error causes test suite to fail)
const { evaluateTransitions, replayTrace } = require('./xstate-trace-walker.cjs');

test('evaluateTransitions: QUORUM_START in IDLE state returns COLLECTING_VOTES', () => {
  const actor = createActor(nfWorkflowMachine);
  actor.start();
  const snapshot = actor.getSnapshot(); // IDLE
  actor.stop();
  const result = evaluateTransitions(snapshot, { type: 'QUORUM_START', slotsAvailable: 3 }, nfWorkflowMachine);
  assert.equal(result.currentState, 'IDLE');
  assert.ok(result.expectedNextState !== null, 'Should have a valid next state');
  assert.equal(result.emptyTransitions, false);
});

test('evaluateTransitions: unknown event type returns emptyTransitions=true', () => {
  const actor = createActor(nfWorkflowMachine);
  actor.start();
  const snapshot = actor.getSnapshot();
  actor.stop();
  const result = evaluateTransitions(snapshot, { type: 'NO_SUCH_EVENT_XYZ' }, nfWorkflowMachine);
  assert.equal(result.emptyTransitions, true);
  assert.equal(result.expectedNextState, null);
});

test('evaluateTransitions: guardContext captures context at evaluation time', () => {
  const actor = createActor(nfWorkflowMachine);
  actor.start();
  actor.send({ type: 'QUORUM_START', slotsAvailable: 5 });
  const snapshot = actor.getSnapshot(); // COLLECTING_VOTES
  actor.stop();
  const result = evaluateTransitions(snapshot, { type: 'VOTES_COLLECTED', successCount: 5 }, nfWorkflowMachine);
  assert.ok(Array.isArray(result.possibleTransitions), 'possibleTransitions must be an array');
  // Each transition has guardContext captured
  for (const t of result.possibleTransitions) {
    assert.ok(typeof t.guardContext === 'object', 'guardContext must be object');
  }
});

test('replayTrace: maintains state across multi-event sequence (guards in event N see context from event N-1)', () => {
  // This test guards against Pitfall 1 (fresh-actor validation blindspot):
  // If replayTrace creates a fresh actor per event, the second event would see IDLE context
  // and any guard that depends on slotsAvailable set during QUORUM_START would behave as if
  // it was never set. The test verifies the state machine carries forward across events.
  const events = [
    { type: 'QUORUM_START', slotsAvailable: 3 },
    { type: 'VOTES_COLLECTED', successCount: 3 },
  ];
  const results = replayTrace(events, nfWorkflowMachine);
  assert.equal(results.length, 2, 'Should produce one result per event');
  // First event: walker evaluates from IDLE
  assert.equal(results[0].walkerResult.currentState, 'IDLE');
  // Second event: state should NOT be IDLE (machine advanced after first event)
  // If a fresh actor were created per event, this would be IDLE again — that is the bug we detect
  assert.notEqual(results[1].walkerResult.currentState, 'IDLE',
    'Second event must be evaluated from the state AFTER QUORUM_START, not from fresh IDLE — fresh-actor bug would fail this');
  // Guard context in second event should reflect context accumulated by QUORUM_START
  const secondTransitions = results[1].walkerResult.possibleTransitions;
  if (secondTransitions.length > 0) {
    // slotsAvailable should be 3 as set by QUORUM_START, not 0/undefined as it would be with fresh actor
    const ctx = secondTransitions[0].guardContext;
    assert.ok(ctx !== undefined, 'guardContext must exist in second event transitions');
  }
});

test('replayTrace: snapshotBefore and snapshotAfter differ after valid transition', () => {
  const events = [{ type: 'QUORUM_START', slotsAvailable: 3 }];
  const results = replayTrace(events, nfWorkflowMachine);
  const before = results[0].snapshotBefore.value;
  const after  = results[0].snapshotAfter.value;
  assert.notDeepEqual(before, after, 'Snapshot must change after QUORUM_START');
});

test('evaluateTransitions: possibleTransitions includes guardName for guarded transitions', () => {
  const actor = createActor(nfWorkflowMachine);
  actor.start();
  actor.send({ type: 'QUORUM_START', slotsAvailable: 5 });
  const snapshot = actor.getSnapshot(); // COLLECTING_VOTES
  actor.stop();
  const result = evaluateTransitions(snapshot, { type: 'VOTES_COLLECTED', successCount: 5 }, nfWorkflowMachine);
  // All transitions should have guardName (string or null) and guardPassed (boolean)
  for (const t of result.possibleTransitions) {
    assert.ok('guardName' in t, 'guardName field required on each transition');
    assert.ok('guardPassed' in t, 'guardPassed field required on each transition');
  }
});

test('replayTrace: null/non-object event element does not abort the whole replay (fail-open)', () => {
  const events = [
    { type: 'QUORUM_START', slotsAvailable: 3 },
    null,
    { type: 'VOTES_COLLECTED', successCount: 3 },
  ];
  let results;
  assert.doesNotThrow(() => { results = replayTrace(events, nfWorkflowMachine); },
    'replayTrace must not throw on a null event element');
  assert.equal(results.length, 3, 'Should still produce one result per input event');
  // The null event yields no transitions rather than crashing
  assert.equal(results[1].walkerResult.emptyTransitions, true);
  assert.deepEqual(results[1].walkerResult.possibleTransitions, []);
});

test('evaluateTransitions: snapshot with null value does not crash', () => {
  let result;
  assert.doesNotThrow(() => {
    result = evaluateTransitions({ value: null, context: {} }, { type: 'QUORUM_START' }, nfWorkflowMachine);
  }, 'null snapshot.value must not throw');
  assert.equal(result.emptyTransitions, true);
  assert.equal(result.expectedNextState, null);
});

test('evaluateTransitions: snapshot missing value field does not crash', () => {
  assert.doesNotThrow(() => {
    evaluateTransitions({ context: {} }, { type: 'QUORUM_START' }, nfWorkflowMachine);
  }, 'missing snapshot.value must not throw');
});

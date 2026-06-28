'use strict';
// bin/xstate-trace-walker.cjs
// Reusable XState trace replay library used by validate-traces.cjs and attribute-trace-divergence.cjs.
// Evaluates XState transitions and guard conditions given a conformance event and current snapshot.
//
// Key design principle: replayTrace creates ONE actor for the full sequence (not fresh per event).
// This enables multi-event interaction bug detection — guards in event N see context accumulated
// from events 1..N-1, rather than seeing the uninitialized defaults from a fresh IDLE snapshot.
// (Pitfall 1: "fresh-actor validation blindspot" documented in v0.21-02-RESEARCH.md)
//
// Exports: evaluateTransitions, replayTrace, evaluateGuard

const fs   = require('fs');
const path = require('path');

// ── Machine loader (cached) ────────────────────────────────────────────────────

let _cachedMachineModule = null;

function loadMachineModule() {
  if (_cachedMachineModule) return _cachedMachineModule;
  const repoDist    = path.join(__dirname, '..', 'dist', 'machines', 'nf-workflow.machine.js');
  const installDist = path.join(__dirname, 'dist', 'machines', 'nf-workflow.machine.js');
  const machinePath = fs.existsSync(repoDist) ? repoDist : installDist;
  if (!fs.existsSync(machinePath)) {
    throw new Error('Cannot find nf-workflow.machine.js at ' + repoDist + ' or ' + installDist);
  }
  _cachedMachineModule = require(machinePath);
  return _cachedMachineModule;
}

// ── Guard evaluation ───────────────────────────────────────────────────────────

/**
 * evaluateGuard: evaluate a named guard function against snapshot context + event.
 *
 * @param {string|null} guardName  - The guard name string (from transition config)
 * @param {object} context         - The XState snapshot context at evaluation time
 * @param {object} event           - The event being evaluated
 * @param {object} machine         - The XState machine (used to resolve guard fn)
 * @returns {{ guardName: string|null, guardPassed: boolean, guardContext: object }}
 */
function evaluateGuard(guardName, context, event, machine) {
  if (!guardName) {
    // No guard → transition is always taken (unconditional)
    return { guardName: null, guardPassed: true, guardContext: Object.assign({}, context) };
  }

  // Resolve guard function from machine implementations (XState v5) or options (XState v4)
  const guards = (machine && (machine.implementations?.guards || machine.options?.guards || machine.config?.guards)) || {};
  const guardFn = guards[guardName];

  if (!guardFn || typeof guardFn !== 'function') {
    // Guard function not found → fail-open (return true to avoid false negatives)
    return { guardName, guardPassed: true, guardContext: Object.assign({}, context) };
  }

  let guardPassed = true;
  try {
    // XState v5 guard signature: ({ context, event }) => boolean
    // XState v4 guard signature: (context, event) => boolean
    // Try v5 first (object destructuring), fall back to v4
    guardPassed = !!guardFn({ context, event }, event);
  } catch (_) {
    // Guard threw — fail-open
    guardPassed = true;
  }

  return { guardName, guardPassed, guardContext: Object.assign({}, context) };
}

// ── Core transition evaluator ──────────────────────────────────────────────────

/**
 * evaluateTransitions: given a snapshot and event, determine which transitions would be
 * taken and evaluate all applicable guards.
 *
 * Uses the actor approach: clones the snapshot via a fresh actor seeded to that state,
 * sends the event, and captures before/after. Guard results are computed by evaluating
 * the guard functions against the pre-send context.
 *
 * @param {object} snapshot  - XState snapshot (from actor.getSnapshot())
 * @param {object} event     - Event object (must have `type` field)
 * @param {object} machine   - The XState machine definition
 * @returns {{
 *   currentState: string,
 *   expectedNextState: string|null,
 *   emptyTransitions: boolean,
 *   possibleTransitions: Array<{ guardName: string|null, guardPassed: boolean, guardContext: object }>
 * }}
 */
function evaluateTransitions(snapshot, event, machine) {
  // Extract current state name (handles string or object shape from XState v4/v5)
  const snapVal = (snapshot && snapshot.value != null) ? snapshot.value : '';
  const currentState = typeof snapVal === 'string'
    ? snapVal
    : Object.keys(snapVal)[0];

  const context = snapshot.context || {};
  const eventType = (event && typeof event === 'object') ? event.type : undefined;

  // Look up transitions for this state + event from machine config
  const machineConfig = machine.config || {};
  const states = machineConfig.states || {};
  const stateConfig = states[currentState] || {};
  const eventTransitions = (stateConfig.on && eventType != null) ? stateConfig.on[eventType] : null;

  if (!eventTransitions) {
    // No transitions defined for this event in this state
    return {
      currentState,
      expectedNextState: null,
      emptyTransitions: true,
      possibleTransitions: [],
    };
  }

  const transArray = Array.isArray(eventTransitions) ? eventTransitions : [eventTransitions];

  if (transArray.length === 0) {
    return {
      currentState,
      expectedNextState: null,
      emptyTransitions: true,
      possibleTransitions: [],
    };
  }

  // Evaluate each transition's guard
  const possibleTransitions = transArray.map(trans => {
    const guardName = trans.guard || trans.cond || null;
    return evaluateGuard(guardName, context, event, machine);
  });

  // Determine expected next state: first transition whose guard passes
  let expectedNextState = null;
  for (let i = 0; i < transArray.length; i++) {
    if (possibleTransitions[i].guardPassed) {
      expectedNextState = transArray[i].target || currentState;
      break;
    }
  }

  return {
    currentState,
    expectedNextState,
    emptyTransitions: false,
    possibleTransitions,
  };
}

// ── Trace replayer ─────────────────────────────────────────────────────────────

/**
 * replayTrace: replay a sequence of events through a SINGLE XState actor.
 *
 * This is the key difference from fresh-actor-per-event validation:
 * - Creates ONE actor for the full event sequence
 * - Guards evaluated for event N see context accumulated from events 1..N-1
 * - Enables detection of cross-event interaction bugs (Pitfall 1 prevention)
 *
 * @param {Array<object>} events  - Array of event objects (each must have `type` field)
 * @param {object} machine        - The XState machine definition
 * @returns {Array<{
 *   event: object,
 *   snapshotBefore: object,
 *   snapshotAfter: object,
 *   walkerResult: object  (result from evaluateTransitions)
 * }>}
 */
function replayTrace(events, machine) {
  const { createActor } = loadMachineModule();
  const actor = createActor(machine);
  actor.start();

  const results = [];

  for (const event of events) {
    const snapshotBefore = actor.getSnapshot();

    // Evaluate transitions BEFORE sending (captures pre-send context for guard evaluation)
    const walkerResult = evaluateTransitions(snapshotBefore, event, machine);

    // Send the event to advance the actor state
    try {
      // Skip null/non-object events: actor.send can schedule async work that
      // throws after this try/catch returns (XState dereferences event.type).
      if (event && typeof event === 'object') {
        actor.send(event);
      }
    } catch (_) {
      // Fail-open: if actor errors on this event, continue with remaining events
    }

    const snapshotAfter = actor.getSnapshot();

    results.push({
      event,
      snapshotBefore,
      snapshotAfter,
      walkerResult,
    });
  }

  actor.stop();
  return results;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { evaluateTransitions, replayTrace, evaluateGuard };

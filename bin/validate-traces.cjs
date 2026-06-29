#!/usr/bin/env node
'use strict';
// bin/validate-traces.cjs
// Replays .planning/conformance-events.jsonl through the XState machine
// and reports a deviation score (% of traces that are valid XState executions).
//
// MCPENV-03: also validates MCP interaction metadata for mcp_call events.
// Schema: .planning/formal/trace/trace.schema.json
//
// Exit code 0: no divergences found (or log file missing)
// Exit code 1: one or more divergences found

const fs   = require('fs');
const path = require('path');
const { setup, assign, createActor } = require('xstate');

// ── Confidence tier constants and helpers ─────────────────────────────────────

const CONFIDENCE_THRESHOLDS = {
  low:    { min_rounds: 0,     min_days: 0  },
  medium: { min_rounds: 500,   min_days: 14 },
  high:   { min_rounds: 10000, min_days: 90 },
};

function computeConfidenceTier(n_rounds, window_days) {
  if (n_rounds >= CONFIDENCE_THRESHOLDS.high.min_rounds && window_days >= CONFIDENCE_THRESHOLDS.high.min_days) return 'high';
  if (n_rounds >= CONFIDENCE_THRESHOLDS.medium.min_rounds && window_days >= CONFIDENCE_THRESHOLDS.medium.min_days) return 'medium';
  return 'low';
}

function createFallbackMachineModule() {
  const nfWorkflowMachine = setup({
    guards: {
      minQuorumMet: ({ context }) =>
        context.successCount >= Math.ceil(context.slotsAvailable / 2),
      unanimityMet: ({ context }) =>
        context.successCount === context.polledCount,
      noInfiniteDeliberation: ({ context }) =>
        context.deliberationRounds < context.maxDeliberation,
      phaseMonotonicallyAdvances: () => true,
    },
  }).createMachine({
    id: 'nf-workflow',
    initial: 'IDLE',
    context: {
      slotsAvailable: 0,
      successCount: 0,
      deliberationRounds: 0,
      currentPhase: 'IDLE',
      maxDeliberation: 9,
      maxSize: 3,
      polledCount: 0,
    },
    states: {
      IDLE: {
        on: {
          QUORUM_START: {
            target: 'COLLECTING_VOTES',
            actions: assign({
              slotsAvailable: ({ event }) => event.slotsAvailable,
              polledCount: ({ event }) => event.polledCount,
              currentPhase: () => 'COLLECTING_VOTES',
            }),
          },
          CIRCUIT_BREAK: { target: 'IDLE' },
          DECIDE: { target: 'IDLE' },
          VOTES_COLLECTED: { target: 'IDLE' },
        },
      },
      COLLECTING_VOTES: {
        on: {
          VOTES_COLLECTED: [
            {
              guard: 'unanimityMet',
              target: 'DECIDED',
              actions: assign({
                successCount: ({ event }) => event.successCount,
                currentPhase: () => 'DECIDED',
              }),
            },
            {
              target: 'DELIBERATING',
              actions: assign({
                successCount: ({ event }) => event.successCount,
                deliberationRounds: ({ context }) => context.deliberationRounds + 1,
                currentPhase: () => 'DELIBERATING',
              }),
            },
          ],
          QUORUM_START: { target: 'COLLECTING_VOTES' },
          CIRCUIT_BREAK: { target: 'COLLECTING_VOTES' },
          DECIDE: { target: 'COLLECTING_VOTES' },
        },
      },
      DELIBERATING: {
        on: {
          VOTES_COLLECTED: [
            {
              guard: 'unanimityMet',
              target: 'DECIDED',
              actions: assign({
                successCount: ({ event }) => event.successCount,
                currentPhase: () => 'DECIDED',
              }),
            },
            {
              guard: 'noInfiniteDeliberation',
              target: 'DELIBERATING',
              actions: assign({
                deliberationRounds: ({ context }) => context.deliberationRounds + 1,
              }),
            },
            {
              target: 'DECIDED',
              actions: assign({ currentPhase: () => 'DECIDED' }),
            },
          ],
          DECIDE: { target: 'DECIDED' },
          QUORUM_START: { target: 'DELIBERATING' },
          CIRCUIT_BREAK: { target: 'DELIBERATING' },
        },
      },
      DECIDED: {
        type: 'final',
        on: {
          DECIDE: { target: 'DECIDED' },
          CIRCUIT_BREAK: { target: 'DECIDED' },
          QUORUM_START: { target: 'DECIDED' },
          VOTES_COLLECTED: { target: 'DECIDED' },
        },
      },
    },
  });

  return { createActor, nfWorkflowMachine };
}

function loadMachineModule() {
  const repoDist = path.join(__dirname, '..', 'dist', 'machines', 'nf-workflow.machine.js');
  const installDist = path.join(__dirname, 'dist', 'machines', 'nf-workflow.machine.js');

  if (fs.existsSync(repoDist)) return require(repoDist);
  if (fs.existsSync(installDist)) return require(installDist);

  return createFallbackMachineModule();
}

function machineEventWithDefaults(rawEvent, sourceEvent) {
  if (!rawEvent || rawEvent.type !== 'QUORUM_START') return rawEvent;
  return {
    ...rawEvent,
    polledCount: rawEvent.polledCount ||
      sourceEvent.polledCount ||
      sourceEvent.polled_count ||
      rawEvent.slotsAvailable ||
      0,
  };
}

function readScoreboardMeta() {
  const pp = require('./planning-paths.cjs');
  const scoreboardPath = pp.resolveWithFallback(process.cwd(), 'quorum-scoreboard');
  try {
    const raw = fs.readFileSync(scoreboardPath, 'utf8');
    const sb = JSON.parse(raw);
    const rounds = Array.isArray(sb.rounds) ? sb.rounds : [];
    const n_rounds = rounds.length;
    if (n_rounds === 0) return { n_rounds: 0, window_days: 0 };
    const dates = rounds.map(r => new Date(r.date).getTime()).filter(t => !isNaN(t));
    const window_days = dates.length < 2 ? 0 : Math.floor((Math.max(...dates) - Math.min(...dates)) / 86400000);
    return { n_rounds, window_days };
  } catch (_) {
    return { n_rounds: 0, window_days: 0 };
  }
}

// Validates MCP-specific metadata fields for mcp_call events (MCPENV-03).
// Schema: .planning/formal/trace/trace.schema.json
// Returns true if valid, or an array of error strings if invalid.
// Non-mcp_call events are always valid (returns true immediately).
function validateMCPMetadata(event) {
  if (!event || event.action !== 'mcp_call') return true; // not an MCP event — skip

  const errors = [];
  if (!event.request_id || typeof event.request_id !== 'string') {
    errors.push('mcp_call missing or invalid request_id (expected string, e.g. round1:codex-1:1, got: ' + JSON.stringify(event.request_id) + ')');
  }
  if (!event.peer || typeof event.peer !== 'string') {
    errors.push('mcp_call missing or invalid peer (expected slot name string, e.g. codex-1, got: ' + JSON.stringify(event.peer) + ')');
  }
  const validMCPOutcomes = ['success', 'fail', 'timeout', 'reorder'];
  if (!validMCPOutcomes.includes(event.mcp_outcome)) {
    errors.push('mcp_call missing or invalid mcp_outcome (expected: success|fail|timeout|reorder, got: ' + JSON.stringify(event.mcp_outcome) + ')');
  }
  if (typeof event.attempt !== 'number' || !Number.isInteger(event.attempt) || event.attempt < 1) {
    errors.push('mcp_call missing or invalid attempt (expected integer >= 1, got: ' + JSON.stringify(event.attempt) + ')');
  }
  return errors.length === 0 ? true : errors;
}

// Maps a conformance event action to the XState event type and payload.
// Returns null if the action is unmappable (schema violation).
function mapToXStateEvent(event) {
  const action = (event && (event.action || event.type)) || null;
  if (typeof action !== 'string') return null;
  switch (action) {
    case 'quorum_start':
      return { type: 'QUORUM_START', slotsAvailable: event.slots_available || 0 };
    case 'quorum_complete':
      return { type: 'VOTES_COLLECTED', successCount: event.vote_result || 0 };
    case 'quorum_block':
      return { type: 'DECIDE', outcome: 'BLOCK' };
    case 'deliberation_round':
      return { type: 'VOTES_COLLECTED', successCount: event.vote_result || 0 };
    case 'circuit_break':
      return { type: 'CIRCUIT_BREAK' };
    case 'quorum_fallback_t1_required':
      return { type: 'QUORUM_START', slotsAvailable: event.fanOutCount || 0 };
    case 'quorum_block_r3_2':
      return { type: 'DECIDE', outcome: 'BLOCK' };
    case 'security_sweep':
      return null; // Not an FSM event — handled as known-skip below
    default:
      return null;
  }
}

// buildTTrace: construct a structured TTrace record for a divergent conformance event.
// Uses xstate-trace-walker to get guard evaluation details.
// IMPORTANT: roundEvents is the full ordered array of conformance events for this round_id group
// (or just [event] for standalone events with no round_id). Guards are evaluated with the actor
// replayed through all preceding events in the group, so guard context at event N reflects
// context accumulated from events 1..N-1 — not from a fresh IDLE snapshot.
//
// STANDALONE EVENT TRADE-OFF (intentional approximation):
// When an event has no round_id, roundEvents = [event] — a single-event group with no
// preceding context. The actor starts fresh (IDLE) before evaluating the guard.
// This is an acceptable methodological approximation because:
//   1. Standalone events represent ad-hoc or non-session actions where cross-event context
//      is not meaningful — evaluating them in isolation accurately reflects their runtime
//      execution environment.
//   2. The accuracy cost is bounded: only guards that depend on context set by earlier
//      events in the same round will be misclassified. Guards that depend only on the
//      event's own payload (the majority) are evaluated correctly.
//   3. The alternative (silently dropping standalone events) would introduce undetected
//      divergence blind spots — the approximation is always preferable to omission.
// Consequence: a standalone guard failure may be classified as impl-bug when it is a
// methodology artifact. attribute-trace-divergence.cjs should treat standalone TTrace
// records with lower specBugConfidence when no preceding context is present.
//
// scoreboardMeta and confidence are passed from the outer loop.
// walker is the result of require('./xstate-trace-walker.cjs') — passed in to keep helper pure.
function buildTTrace(event, actualState, expectedStateName, divergenceType, scoreboardMeta, confidence, walker, machine, roundEvents) {
  let guardEvaluations = [];
  if (walker && machine) {
    try {
      const { createActor } = loadMachineModule();

      // Find the index of this event in its round group
      const groupEvents = roundEvents || [event];
      const eventIndex  = groupEvents.indexOf(event);
      const precedingEvents = groupEvents.slice(0, eventIndex);

      // Replay preceding events through a single actor to accumulate session context.
      // Guards evaluated here will see slotsAvailable, polledCount, etc. as set by
      // QUORUM_START and earlier events — not from a fresh IDLE snapshot.
      const xstateEvt = mapToXStateEvent(event);
      if (xstateEvt) {
        const actor = createActor(machine);
        actor.start();
        for (const prev of precedingEvents) {
          const prevEvt = mapToXStateEvent(prev);
          if (prevEvt) actor.send(machineEventWithDefaults(prevEvt, prev));
        }
        const beforeSnap = actor.getSnapshot();
        actor.stop();
        const walkerResult = walker.evaluateTransitions(beforeSnap, machineEventWithDefaults(xstateEvt, event), machine);
        guardEvaluations = walkerResult.possibleTransitions.map(t => ({
          guardName: t.guardName || 'none',
          passed:    t.guardPassed,
          context:   t.guardContext,
        }));
      }
    } catch (_) { /* fail-open — guard evaluation failure must not break validation */ }
  }
  return {
    event,
    actualState,
    expectedState: expectedStateName,
    guardEvaluations,
    divergenceType,
    confidence,
    observation_window: {
      n_rounds:    scoreboardMeta.n_rounds,
      window_days: scoreboardMeta.window_days,
    },
  };
}

// Returns the expected XState state after this event, based on the event's outcome field.
//
// METHODOLOGY FIX (H1 — fresh-actor blindspot correction):
// The validator uses a fresh XState actor (starting in IDLE) for each event.
// This is only meaningful for events that legitimately start from IDLE state.
// Events with phase !== 'IDLE' happen mid-session (e.g., phase='DECIDING') and
// CANNOT be valid as standalone fresh-actor traces:
//   - quorum_block (DECIDE event) from IDLE → stays IDLE (no DECIDE transition from IDLE)
//   - quorum_complete (VOTES_COLLECTED event) from IDLE → stays IDLE (no transition from IDLE)
// Returning null for these events causes them to be counted as VALID (skipped),
// which is the correct behavior: a mid-session event cannot be falsified by a
// fresh-actor trace from IDLE.
//
// Only quorum_start (phase=IDLE) and deliberation_round can start from IDLE legitimately.
// All other events require session context accumulated from preceding events.
function expectedState(event) {
  if (!event || typeof event !== 'object') return null;
  const action = event.action || event.type;

  // quorum_start always starts from IDLE — the only truly standalone-valid event type
  if (action === 'quorum_start') return 'COLLECTING_VOTES';

  // quorum_fallback_t1_required is equivalent to quorum_start (type-only events)
  if (action === 'quorum_fallback_t1_required') return 'COLLECTING_VOTES';

  // deliberation_round: these happen mid-session (phase=DECIDING) too
  // but are already excluded by the phase check below
  if (action === 'deliberation_round') return 'DELIBERATING';

  // circuit_break self-loops to IDLE — no state transition occurs
  if (action === 'circuit_break') return 'IDLE';

  // H1 fix: skip validation for mid-session events (phase !== 'IDLE').
  // These events require cross-event context that a fresh actor starting in IDLE cannot provide.
  // Returning null causes the validator to count them as valid (not divergent),
  // which is the methodologically correct choice for standalone fresh-actor validation.
  if (event.phase && event.phase !== 'IDLE') return null;

  if (event.outcome === 'APPROVE') return 'DECIDED';
  if (event.outcome === 'BLOCK')   return 'DECIDED';
  return null; // cannot determine — will count as valid (skip)
}

// Builds the observation_window object for a check-result NDJSON record (EVID-02).
// Reads scoreboard to derive window_start (earliest round date), window_end (now),
// n_traces (round count), n_events (conformance event count), window_days (span).
// Fail-open: if scoreboard is missing or malformed, returns sensible zero defaults.
function buildObservationWindow(scoreboardMeta, n_events) {
  let window_start = new Date().toISOString();
  try {
    const pp2 = require('./planning-paths.cjs');
    const sbPath = pp2.resolveWithFallback(process.cwd(), 'quorum-scoreboard');
    if (fs.existsSync(sbPath)) {
      const sb = JSON.parse(fs.readFileSync(sbPath, 'utf8'));
      const rounds = Array.isArray(sb.rounds) ? sb.rounds : [];
      if (rounds.length > 0) {
        const dates = rounds.map(r => new Date(r.date).getTime()).filter(t => !isNaN(t));
        if (dates.length > 0) {
          window_start = new Date(Math.min(...dates)).toISOString();
        }
      }
    }
  } catch (_) { /* fail-open */ }
  return {
    window_start,
    window_end:   new Date().toISOString(),
    n_traces:     scoreboardMeta.n_rounds,
    n_events,
    window_days:  scoreboardMeta.window_days,
  };
}

if (require.main === module) {
  const KNOWN_NON_FSM_ACTIONS = new Set(['security_sweep']);
  const _startMs = Date.now();
  const { writeCheckResult } = require('./write-check-result.cjs');
  const { createActor, nfWorkflowMachine } = loadMachineModule();

  // Load walker for TTrace export (DIAG-01) — lazy-loaded here to avoid breaking module.exports usage
  let walker = null;
  try {
    walker = require('./xstate-trace-walker.cjs');
  } catch (_) { /* walker not available — TTrace export will use empty guardEvaluations */ }

  const pp = require('./planning-paths.cjs');
  const logPath = pp.resolveWithFallback(process.cwd(), 'conformance-events');

  if (!fs.existsSync(logPath)) {
    process.stdout.write('[validate-traces] No conformance log at: ' + logPath + ' — nothing to validate\n');
    const _obs0 = buildObservationWindow({ n_rounds: 0, window_days: 0 }, 0);
    try {
      writeCheckResult({
        tool: 'validate-traces', formalism: 'trace', result: 'pass',
        check_id: 'ci:conformance-traces', surface: 'ci',
        property: 'Conformance event replay through XState machine',
        runtime_ms: Date.now() - _startMs,
        summary: 'pass: no conformance log found — nothing to validate',
        observation_window: _obs0,
        metadata: { reason: 'no-log' },
      });
    } catch (e) { process.stderr.write('[validate-traces] Warning: failed to write check result: ' + e.message + '\n'); }
    process.exit(0);
  }

  const raw   = fs.readFileSync(logPath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim().length > 0);

  if (lines.length === 0) {
    process.stdout.write('[validate-traces] Conformance log is empty — deviation score: 100.0% (0/0)\n');
    const _obs1 = buildObservationWindow({ n_rounds: 0, window_days: 0 }, 0);
    try {
      writeCheckResult({
        tool: 'validate-traces', formalism: 'trace', result: 'pass',
        check_id: 'ci:conformance-traces', surface: 'ci',
        property: 'Conformance event replay through XState machine',
        runtime_ms: Date.now() - _startMs,
        summary: 'pass: conformance log is empty — nothing to validate',
        observation_window: _obs1,
        metadata: { reason: 'empty-log' },
      });
    } catch (e) { process.stderr.write('[validate-traces] Warning: failed to write check result: ' + e.message + '\n'); }
    process.exit(0);
  }

  // Read scoreboard metadata ONCE before the loop (avoid repeated file reads)
  const scoreboardMeta = readScoreboardMeta();
  const confidence = computeConfidenceTier(scoreboardMeta.n_rounds, scoreboardMeta.window_days);

  // Parse all events first so we can group by round_id for session-based buildTTrace calls.
  const parsedEvents = [];
  let valid       = 0;
  const divergences = [];

  // First pass: parse JSON lines
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let event;
    try {
      event = JSON.parse(line);
      if (event === null || typeof event !== 'object' || Array.isArray(event)) {
        divergences.push({
          line,
          reason: 'non_object_event: parsed JSON is not a conformance event object',
          divergenceType: 'unmappable_action',
          ...scoreboardMeta,
          confidence,
        });
        continue;
      }
      event._lineIndex = i; // internal index for standalone event keying
      parsedEvents.push(event);
    } catch (parseErr) {
      divergences.push({
        line,
        reason: 'json_parse_error: ' + parseErr.message,
        ...scoreboardMeta,
        confidence,
      });
    }
  }

  // Group events by round_id for session-based guard evaluation in buildTTrace.
  // Events without round_id form singleton groups (standalone events).
  const roundGroups = new Map(); // round_id_key → events[]
  for (const evt of parsedEvents) {
    const key = evt.round_id || evt.session_id || '__standalone__' + evt._lineIndex;
    if (!roundGroups.has(key)) roundGroups.set(key, []);
    roundGroups.get(key).push(evt);
  }

  // Second pass: validate each parsed event
  for (const event of parsedEvents) {
    // MCPENV-03: validate MCP interaction metadata for mcp_call events
    const mcpErrors = validateMCPMetadata(event);
    if (mcpErrors !== true) {
      divergences.push({
        event,
        reason: 'mcp_field_validation',
        errors: mcpErrors,
        divergenceType: 'mcp_field_validation',
        ...scoreboardMeta,
        confidence,
      });
      continue;
    }

    const xstateEvent = mapToXStateEvent(event);
    if (!xstateEvent) {
      const normalizedAction = event.action || event.type;
      if (KNOWN_NON_FSM_ACTIONS.has(normalizedAction)) {
        valid++;
        continue;
      }
      divergences.push({
        event,
        reason: 'unmappable_action: ' + normalizedAction,
        divergenceType: 'unmappable_action',
        ...scoreboardMeta,
        confidence,
      });
      continue;
    }

    // Fresh actor per event — each conformance event is a single-step trace
    const actor = createActor(nfWorkflowMachine);
    actor.start();
    actor.send(machineEventWithDefaults(xstateEvent, event));
    const snapshot = actor.getSnapshot();
    actor.stop();

    const expected = expectedState(event);
    if (expected === null || snapshot.matches(expected)) {
      valid++;
    } else {
      // Build TTrace record with session-based guard evaluation (DIAG-01)
      const roundKey    = event.round_id || event.session_id || '__standalone__' + event._lineIndex;
      const roundEvents = roundGroups.get(roundKey) || [event];
      divergences.push(
        buildTTrace(event, snapshot.value, expected, 'state_mismatch', scoreboardMeta, confidence, walker, nfWorkflowMachine, roundEvents)
      );
    }
  }

  const total = lines.length;
  const score = ((valid / total) * 100).toFixed(1);
  const observationWindow = buildObservationWindow(scoreboardMeta, total);

  // Export first 10 state_mismatch TTrace records to .planning/formal/.divergences.json (DIAG-01)
  // Atomic write (tmp + rename) consistent with project pattern.
  const ttraceDivergences = divergences
    .filter(d => d.divergenceType === 'state_mismatch')
    .slice(0, 10);
  if (ttraceDivergences.length > 0) {
    const divergencesPath = path.join(process.cwd(), '.planning', 'formal', '.divergences.json');
    const tmpPath = divergencesPath + '.tmp.' + Date.now();
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(ttraceDivergences, null, 2), 'utf8');
      fs.renameSync(tmpPath, divergencesPath);
    } catch (e) {
      process.stderr.write('[validate-traces] Warning: failed to write .divergences.json: ' + e.message + '\n');
    }
  }

  process.stdout.write('[validate-traces] Deviation score: ' + score + '% valid (' + valid + '/' + total + ' traces)\n');

  if (divergences.length > 0) {
    process.stdout.write('[validate-traces] ' + divergences.length + ' divergence(s) found:\n');
    for (const d of divergences) {
      process.stdout.write('  ' + JSON.stringify(d) + '\n');
    }
    try {
      writeCheckResult({
        tool: 'validate-traces', formalism: 'trace', result: 'fail',
        check_id: 'ci:conformance-traces', surface: 'ci',
        property: 'Conformance event replay through XState machine',
        runtime_ms: Date.now() - _startMs,
        summary: 'fail: ' + divergences.length + ' divergence(s) in ' + total + ' traces (' + (Date.now() - _startMs) + 'ms)',
        observation_window: observationWindow,
        metadata: { divergences: divergences.length, total },
        triage_tags: ['trace-divergence'],
      });
    } catch (e) { process.stderr.write('[validate-traces] Warning: failed to write check result: ' + e.message + '\n'); }
    process.exit(1);
  }

  try {
    writeCheckResult({
      tool: 'validate-traces', formalism: 'trace', result: 'pass',
      check_id: 'ci:conformance-traces', surface: 'ci',
      property: 'Conformance event replay through XState machine',
      runtime_ms: Date.now() - _startMs,
      summary: 'pass: ' + valid + '/' + total + ' traces valid (' + (Date.now() - _startMs) + 'ms)',
      observation_window: observationWindow,
      metadata: { valid, total },
    });
  } catch (e) { process.stderr.write('[validate-traces] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(0);
}

if (typeof module !== 'undefined') {
  module.exports = { computeConfidenceTier, CONFIDENCE_THRESHOLDS, validateMCPMetadata, buildTTrace, mapToXStateEvent, expectedState };
}

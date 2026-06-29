#!/usr/bin/env node
'use strict';

/**
 * observed-fsm.cjs — Derives an observed-behavior FSM from traces using
 * dual-mode replay (per-event isolation + per-session chains).
 *
 * Requirements: SEM-04
 *
 * Usage:
 *   node bin/observed-fsm.cjs            # print summary to stdout
 *   node bin/observed-fsm.cjs --json     # print full FSM JSON to stdout
 */

const fs   = require('fs');
const path = require('path');

const ROOT = process.env.PROJECT_ROOT || path.join(__dirname, '..');
const FORMAL = path.join(ROOT, '.planning', 'formal');
const OUT_DIR = path.join(FORMAL, 'semantics');
const OUT_FILE = path.join(OUT_DIR, 'observed-fsm.json');

const JSON_FLAG = process.argv.includes('--json');

// ── Helpers ─────────────────────────────────────────────────────────────────

function stateToString(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}

// ── Model extraction ────────────────────────────────────────────────────────

function extractModelTransitions() {
  const machinePath = (() => {
    const repoDist    = path.join(__dirname, '..', 'dist', 'machines', 'nf-workflow.machine.js');
    const installDist = path.join(__dirname, 'dist', 'machines', 'nf-workflow.machine.js');
    return fs.existsSync(repoDist) ? repoDist : installDist;
  })();
  const { nfWorkflowMachine } = require(machinePath);

  const config = nfWorkflowMachine.config;
  const transitions = [];

  for (const [stateName, stateDef] of Object.entries(config.states)) {
    const on = stateDef.on || {};
    for (const [eventName, targets] of Object.entries(on)) {
      if (Array.isArray(targets)) {
        for (const t of targets) {
          if (t.target) transitions.push({ from: stateName, event: eventName, to: t.target });
        }
      } else if (typeof targets === 'string') {
        transitions.push({ from: stateName, event: eventName, to: targets });
      } else if (targets && targets.target) {
        transitions.push({ from: stateName, event: eventName, to: targets.target });
      }
    }
  }

  return { states: Object.keys(config.states), transitions };
}

// ── Mode A: Per-event isolation ─────────────────────────────────────────────

function replayPerEvent(conformanceEvents, mapToXStateEvent, createActor, nfWorkflowMachine) {
  const adjacency = {}; // { fromState: { eventType: { toState, count } } }
  let totalMapped = 0;

  for (const event of conformanceEvents) {
    const xstateEvent = mapToXStateEvent(event);
    if (!xstateEvent) continue;
    totalMapped++;

    const actor = createActor(nfWorkflowMachine);
    actor.start();
    const beforeState = stateToString(actor.getSnapshot().value);
    actor.send(xstateEvent);
    const afterState = stateToString(actor.getSnapshot().value);
    actor.stop();

    if (!adjacency[beforeState]) adjacency[beforeState] = {};
    const key = xstateEvent.type;
    if (!adjacency[beforeState][key]) {
      adjacency[beforeState][key] = { to_state: afterState, count: 0 };
    }
    adjacency[beforeState][key].count++;
  }

  return { adjacency, totalMapped };
}

// ── Mode B: Per-session running actor ───────────────────────────────────────

function replayPerSession(conformanceEvents, traceStats, mapToXStateEvent, createActor, nfWorkflowMachine) {
  const adjacency = {};
  let sessionsReplayed = 0;

  const sessions = (traceStats && traceStats.sessions) || [];
  for (const session of sessions) {
    if (!session || typeof session !== 'object') continue;
    const sessionStart = new Date(session.start).getTime();
    const sessionEnd = new Date(session.end).getTime();
    const sessionEvents = conformanceEvents.filter(e => {
      if (!e || typeof e !== 'object') return false;
      const t = new Date(e.ts).getTime();
      return t >= sessionStart && t <= sessionEnd;
    });

    if (sessionEvents.length === 0) continue;

    const actor = createActor(nfWorkflowMachine);
    actor.start();
    sessionsReplayed++;

    for (const event of sessionEvents) {
      const xstateEvent = mapToXStateEvent(event);
      if (!xstateEvent) continue;

      const beforeState = stateToString(actor.getSnapshot().value);
      actor.send(xstateEvent);
      const afterState = stateToString(actor.getSnapshot().value);

      const key = xstateEvent.type;
      if (!adjacency[beforeState]) adjacency[beforeState] = {};
      if (!adjacency[beforeState][key]) {
        adjacency[beforeState][key] = { to_state: afterState, count: 0 };
      }
      adjacency[beforeState][key].count++;
    }

    actor.stop();
  }

  return { adjacency, sessionsReplayed };
}

// ── Merge ───────────────────────────────────────────────────────────────────

function mergeAdjacency(perEvent, perSession) {
  const merged = {};

  // Add per-event transitions
  for (const [from, events] of Object.entries(perEvent)) {
    if (!merged[from]) merged[from] = {};
    for (const [event, data] of Object.entries(events)) {
      merged[from][event] = { ...data, source: 'per_event' };
    }
  }

  // Merge per-session transitions
  for (const [from, events] of Object.entries(perSession)) {
    if (!merged[from]) merged[from] = {};
    for (const [event, data] of Object.entries(events)) {
      if (merged[from][event]) {
        // Both modes have this transition
        merged[from][event].source = 'both';
        // Keep per-event count as authoritative
      } else {
        merged[from][event] = { ...data, source: 'per_session' };
      }
    }
  }

  return merged;
}

// ── Model comparison ────────────────────────────────────────────────────────

function compareWithModel(mergedAdjacency, modelTransitions) {
  const observedSet = new Set();
  for (const [from, events] of Object.entries(mergedAdjacency)) {
    for (const [event, data] of Object.entries(events)) {
      observedSet.add(`${from}::${event}::${data.to_state}`);
    }
  }

  const modelSet = new Set();
  for (const t of modelTransitions) {
    modelSet.add(`${t.from}::${t.event}::${t.to}`);
  }

  const matching = [];
  const missingInObserved = [];
  const missingInModel = [];

  for (const key of modelSet) {
    const [from, event, to] = key.split('::');
    if (observedSet.has(key)) {
      matching.push({ from, event, to });
    } else {
      missingInObserved.push({ from, event, to });
    }
  }

  for (const key of observedSet) {
    if (!modelSet.has(key)) {
      const [from, event, to] = key.split('::');
      missingInModel.push({ from, event, to });
    }
  }

  return { matching, missing_in_observed: missingInObserved, missing_in_model: missingInModel };
}

// ── Build FSM ───────────────────────────────────────────────────────────────

function buildObservedFSM(conformanceEvents, traceStats) {
  const { mapToXStateEvent } = require(path.join(__dirname, 'validate-traces.cjs'));
  const machinePath = (() => {
    const repoDist    = path.join(__dirname, '..', 'dist', 'machines', 'nf-workflow.machine.js');
    const installDist = path.join(__dirname, 'dist', 'machines', 'nf-workflow.machine.js');
    return fs.existsSync(repoDist) ? repoDist : installDist;
  })();
  const { createActor, nfWorkflowMachine } = require(machinePath);

  // Mode A: Per-event isolation
  const perEventResult = replayPerEvent(conformanceEvents, mapToXStateEvent, createActor, nfWorkflowMachine);

  // Mode B: Per-session running actor
  const perSessionResult = replayPerSession(conformanceEvents, traceStats, mapToXStateEvent, createActor, nfWorkflowMachine);

  // Merge
  const mergedAdjacency = mergeAdjacency(perEventResult.adjacency, perSessionResult.adjacency);

  // Extract observed states
  const statesObserved = new Set();
  for (const [from, events] of Object.entries(mergedAdjacency)) {
    statesObserved.add(from);
    for (const data of Object.values(events)) {
      statesObserved.add(data.to_state);
    }
  }

  // Model comparison
  const model = extractModelTransitions();
  const comparison = compareWithModel(mergedAdjacency, model.transitions);

  // Coverage metrics
  const totalEvents = conformanceEvents.length;
  const mappedEvents = perEventResult.totalMapped;
  const unmappedEvents = totalEvents - mappedEvents;
  const modelTransitionCount = model.transitions.length;
  const exercisedCount = comparison.matching.length;

  // Count per-event and per-session unique transitions
  const perEventTransitions = new Set();
  for (const [from, events] of Object.entries(perEventResult.adjacency)) {
    for (const [event, data] of Object.entries(events)) {
      perEventTransitions.add(`${from}::${event}::${data.to_state}`);
    }
  }
  const perSessionTransitions = new Set();
  for (const [from, events] of Object.entries(perSessionResult.adjacency)) {
    for (const [event, data] of Object.entries(events)) {
      perSessionTransitions.add(`${from}::${event}::${data.to_state}`);
    }
  }

  return {
    schema_version: '1',
    generated: new Date().toISOString(),
    observed_transitions: mergedAdjacency,
    states_observed: [...statesObserved].sort(),
    model_comparison: comparison,
    coverage: {
      model_coverage: modelTransitionCount > 0 ? exercisedCount / modelTransitionCount : 0,
      vocabulary_coverage: totalEvents > 0 ? mappedEvents / totalEvents : 0,
      total_events: totalEvents,
      mapped_events: mappedEvents,
      unmapped_events: unmappedEvents
    },
    replay_modes: {
      per_event_transitions: perEventTransitions.size,
      per_session_transitions: perSessionTransitions.size,
      sessions_replayed: perSessionResult.sessionsReplayed
    }
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  // Read conformance events
  const pp = require(path.join(__dirname, 'planning-paths.cjs'));
  const logPath = pp.resolveWithFallback(ROOT, 'conformance-events');
  let conformanceEvents = [];
  if (fs.existsSync(logPath)) {
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try { conformanceEvents.push(JSON.parse(line)); } catch (_) { /* skip */ }
    }
  }

  // Read trace stats
  const statsPath = path.join(FORMAL, 'evidence', 'trace-corpus-stats.json');
  let traceStats = null;
  if (fs.existsSync(statsPath)) {
    traceStats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
  }

  const fsm = buildObservedFSM(conformanceEvents, traceStats);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(fsm, null, 2) + '\n');

  if (JSON_FLAG) {
    process.stdout.write(JSON.stringify(fsm, null, 2) + '\n');
  } else {
    console.log(`Observed FSM written to ${path.relative(ROOT, OUT_FILE)}`);
    console.log(`  States observed: ${fsm.states_observed.length} (${fsm.states_observed.join(', ')})`);
    console.log(`  Model coverage: ${(fsm.coverage.model_coverage * 100).toFixed(1)}%`);
    console.log(`  Vocabulary coverage: ${(fsm.coverage.vocabulary_coverage * 100).toFixed(1)}%`);
    console.log(`  Events: ${fsm.coverage.total_events} total, ${fsm.coverage.mapped_events} mapped, ${fsm.coverage.unmapped_events} unmapped`);
    console.log(`  Replay modes: per_event=${fsm.replay_modes.per_event_transitions} per_session=${fsm.replay_modes.per_session_transitions} sessions=${fsm.replay_modes.sessions_replayed}`);
    console.log(`  Model comparison: matching=${fsm.model_comparison.matching.length} missing_in_observed=${fsm.model_comparison.missing_in_observed.length} missing_in_model=${fsm.model_comparison.missing_in_model.length}`);
  }

  process.exit(0);
}

module.exports = {
  buildObservedFSM, extractModelTransitions, replayPerEvent, replayPerSession,
  mergeAdjacency, compareWithModel, stateToString
};

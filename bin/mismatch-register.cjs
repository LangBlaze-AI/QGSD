#!/usr/bin/env node
'use strict';
// bin/mismatch-register.cjs
// Builds a JSONL mismatch register tracking L2-model vs L1-trace disagreements.
// Each line is a standalone JSON object with resolution tracking.
// Requirements: SEM-02

const fs   = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Classify a conformance event as a methodology skip.
 * H1 methodology: mid-session events (phase !== 'IDLE' AND action !== 'quorum_start')
 * cannot be validated with a fresh actor from IDLE, so they are methodology skips,
 * NOT mismatches. Fresh actors always start in IDLE, so mid-session events would
 * produce false mismatches without this compensation.
 */
function isMethodologySkip(event) {
  if (!event) return false;
  // quorum_start always starts from IDLE -- valid for fresh-actor replay
  if (event.action === 'quorum_start') return false;
  // Events with non-IDLE phase are mid-session
  if (event.phase && event.phase !== 'IDLE') return true;
  return false;
}

/**
 * Generate a mismatch entry from a conformance event comparison.
 */
function buildMismatchEntry(id, event, eventIndex, expectedState, actualState, divergenceType, resolution, notes, classification) {
  const ev = (event && typeof event === 'object') ? event : {};
  return {
    id: 'MISMATCH-' + String(id).padStart(3, '0'),
    timestamp: ev.ts || new Date().toISOString(),
    l2_source: 'nf-workflow.machine.ts',
    l1_trace_ref: {
      event_index: eventIndex,
      session: ev.session_id || ev.round_id || 'standalone',
    },
    expected_state: expectedState,
    actual_state: actualState,
    divergence_type: divergenceType,
    resolution: resolution || 'open',
    resolution_notes: notes || null,
    classification: classification || null,
  };
}

/**
 * Process conformance events and build mismatch entries.
 * Returns { entries, summary }.
 */
function buildMismatchRegister(conformanceEvents, vocabulary, divergences) {
  // Lazy-load validate-traces for mapToXStateEvent
  const { mapToXStateEvent } = require(path.join(__dirname, 'validate-traces.cjs'));

  // Machine path resolution (same pattern as validate-traces.cjs)
  const machinePath = (() => {
    const repoDist    = path.join(__dirname, '..', 'dist', 'machines', 'nf-workflow.machine.js');
    const installDist = path.join(__dirname, 'dist', 'machines', 'nf-workflow.machine.js');
    return fs.existsSync(repoDist) ? repoDist : installDist;
  })();
  const { createActor, nfWorkflowMachine } = require(machinePath);

  const entries = [];
  let mismatchCounter = 0;
  const stats = { total_events: 0, mapped: 0, unmapped: 0, methodology_skip: 0, state_mismatch: 0 };

  // Process conformance events
  const events = Array.isArray(conformanceEvents) ? conformanceEvents : [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    stats.total_events++;

    // Map to XState event
    const xstateEvent = mapToXStateEvent(event);
    if (!xstateEvent) {
      stats.unmapped++;
      continue; // instrumentation gap, not a mismatch
    }
    stats.mapped++;

    // H1 methodology skip: mid-session events cannot be validated with fresh actor
    if (isMethodologySkip(event)) {
      stats.methodology_skip++;
      continue;
    }

    // Fresh actor per event for isolation
    const actor = createActor(nfWorkflowMachine);
    actor.start();
    actor.send(xstateEvent);
    const snapshot = actor.getSnapshot();
    actor.stop();

    // Determine expected state based on event type
    let expectedState = null;
    if (event.action === 'quorum_start') expectedState = 'COLLECTING_VOTES';
    else if (event.action === 'circuit_break') expectedState = 'IDLE';
    else if (event.action === 'deliberation_round') expectedState = 'DELIBERATING';
    else if (event.outcome === 'APPROVE' || event.outcome === 'BLOCK') expectedState = 'DECIDED';

    if (expectedState === null) continue; // cannot determine -- skip

    // Get actual state as string
    const actualStateValue = typeof snapshot.value === 'string'
      ? snapshot.value
      : JSON.stringify(snapshot.value);

    // Compare states
    if (!snapshot.matches(expectedState)) {
      mismatchCounter++;
      stats.state_mismatch++;
      entries.push(buildMismatchEntry(
        mismatchCounter, event, i,
        expectedState, actualStateValue,
        'state_mismatch', 'open', null, null
      ));
    }
  }

  // Incorporate existing .divergences.json entries
  if (Array.isArray(divergences)) {
    for (const div of divergences) {
      if (!div || typeof div !== 'object') continue; // skip malformed entries (fail-open)
      mismatchCounter++;
      const divEvent = div.event || {};

      // Check if this divergence matches the H1 methodology skip pattern
      const isH1 = isMethodologySkip(divEvent);
      const resolution = isH1 ? 'explained' : 'open';
      const notes = isH1 ? 'H1 methodology limitation: mid-session event evaluated with fresh actor from IDLE' : null;

      entries.push(buildMismatchEntry(
        mismatchCounter, divEvent, divEvent._lineIndex || 0,
        div.expectedState || 'unknown',
        typeof div.actualState === 'string' ? div.actualState : JSON.stringify(div.actualState || 'unknown'),
        div.divergenceType || 'state_mismatch',
        resolution, notes,
        isH1 ? 'methodology_limitation' : null
      ));
    }
  }

  const byResolution = { open: 0, explained: 0, bug: 0 };
  const byDivergenceType = {};
  for (const e of entries) {
    byResolution[e.resolution] = (byResolution[e.resolution] || 0) + 1;
    byDivergenceType[e.divergence_type] = (byDivergenceType[e.divergence_type] || 0) + 1;
  }

  return {
    entries,
    summary: {
      total_mismatches: entries.length,
      by_resolution: byResolution,
      by_divergence_type: byDivergenceType,
      stats,
    },
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const jsonFlag = process.argv.includes('--json');

  // Read conformance events
  const pp = require(path.join(__dirname, 'planning-paths.cjs'));
  const logPath = pp.resolveWithFallback(PROJECT_ROOT, 'conformance-events');
  let conformanceEvents = [];
  if (fs.existsSync(logPath)) {
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try { conformanceEvents.push(JSON.parse(line)); } catch (_) { /* skip malformed lines */ }
    }
  }

  // Read event vocabulary
  const vocabPath = path.join(PROJECT_ROOT, '.planning', 'formal', 'evidence', 'event-vocabulary.json');
  let vocabulary = {};
  if (fs.existsSync(vocabPath)) {
    try { vocabulary = JSON.parse(fs.readFileSync(vocabPath, 'utf8')); } catch (_) { /* fail-open */ }
  }

  // Read existing divergences
  const divergencesPath = path.join(PROJECT_ROOT, '.planning', 'formal', '.divergences.json');
  let divergences = [];
  if (fs.existsSync(divergencesPath)) {
    try { divergences = JSON.parse(fs.readFileSync(divergencesPath, 'utf8')); } catch (_) { /* fail-open */ }
  }

  const result = buildMismatchRegister(conformanceEvents, vocabulary, divergences);

  // Write JSONL output (one JSON object per line)
  const outputPath = path.join(PROJECT_ROOT, '.planning', 'formal', 'semantics', 'mismatch-register.jsonl');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const jsonlContent = result.entries.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(outputPath, jsonlContent + (jsonlContent.length > 0 ? '\n' : ''), 'utf8');

  // Output summary
  if (jsonFlag) {
    process.stdout.write(JSON.stringify(result.summary, null, 2) + '\n');
  } else {
    process.stdout.write('[mismatch-register] Total mismatches: ' + result.summary.total_mismatches + '\n');
    process.stdout.write('[mismatch-register] By resolution: ' + JSON.stringify(result.summary.by_resolution) + '\n');
    process.stdout.write('[mismatch-register] By type: ' + JSON.stringify(result.summary.by_divergence_type) + '\n');
    process.stdout.write('[mismatch-register] Stats: ' + JSON.stringify(result.summary.stats) + '\n');
    process.stdout.write('[mismatch-register] Output: ' + outputPath + '\n');
  }

  process.exit(0);
}

module.exports = { buildMismatchRegister, buildMismatchEntry, isMethodologySkip };

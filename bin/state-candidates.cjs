#!/usr/bin/env node
'use strict';
// bin/state-candidates.cjs
// Mines conformance traces for unmodeled state candidates.
// Identifies unmapped actions and suggests missing state transitions.
//
// Requirement: EVID-04

const fs   = require('fs');
const path = require('path');

const ROOT = process.env.PROJECT_ROOT || path.join(__dirname, '..');
const EVIDENCE_DIR = path.join(ROOT, '.planning', 'formal', 'evidence');
const VOCAB_PATH = path.join(EVIDENCE_DIR, 'event-vocabulary.json');
const OUTPUT_PATH = path.join(EVIDENCE_DIR, 'state-candidates.json');

const JSON_FLAG = process.argv.includes('--json');

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  }

  // Import mapToXStateEvent from validate-traces.cjs
  const { mapToXStateEvent } = require('./validate-traces.cjs');

  // Read conformance events using planning-paths
  const pp = require('./planning-paths.cjs');
  const eventsPath = pp.resolve(process.cwd(), 'conformance-events');

  if (!fs.existsSync(eventsPath)) {
    console.error(`Conformance events file not found: ${eventsPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(eventsPath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim());
  const events = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        events.push(parsed);
      }
    } catch (_) {}
  }

  // Load vocabulary (fail-open: treat missing/malformed vocab as empty)
  let vocab = {};
  try { vocab = JSON.parse(fs.readFileSync(VOCAB_PATH, 'utf8')); } catch (_) {}
  const vocabMap = (vocab && typeof vocab.vocabulary === 'object' && vocab.vocabulary !== null)
    ? vocab.vocabulary
    : {};
  const vocabActions = new Set(Object.keys(vocabMap));

  // Sort by timestamp
  events.sort((a, b) => {
    const tsA = new Date(a.ts || a.timestamp).getTime();
    const tsB = new Date(b.ts || b.timestamp).getTime();
    return tsA - tsB;
  });

  // Identify unmapped actions: action is "undefined", not in vocabulary, or has no action field
  const unmappedClusters = {};
  let totalUnmapped = 0;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const action = event.action || event.type || 'undefined';

    // Check if this action is unmapped
    const isUnmapped = !vocabActions.has(action);

    if (isUnmapped) {
      totalUnmapped++;

      if (!unmappedClusters[action]) {
        unmappedClusters[action] = {
          action,
          count: 0,
          timestamps: [],
          context_before: {},
          context_after: {},
        };
      }

      const cluster = unmappedClusters[action];
      cluster.count++;

      // Sample timestamps (first 5)
      if (cluster.timestamps.length < 5) {
        cluster.timestamps.push(event.ts || event.timestamp);
      }

      // Context: what actions appear before/after
      if (i > 0) {
        const prevAction = events[i - 1].action || events[i - 1].type || 'undefined';
        cluster.context_before[prevAction] = (cluster.context_before[prevAction] || 0) + 1;
      }
      if (i < events.length - 1) {
        const nextAction = events[i + 1].action || events[i + 1].type || 'undefined';
        cluster.context_after[nextAction] = (cluster.context_after[nextAction] || 0) + 1;
      }
    }
  }

  // Build deduplicated candidates
  const candidates = Object.values(unmappedClusters).map(cluster => {
    // Suggest state variable based on context
    const topBefore = Object.entries(cluster.context_before)
      .sort((a, b) => b[1] - a[1])[0];
    const topAfter = Object.entries(cluster.context_after)
      .sort((a, b) => b[1] - a[1])[0];

    let suggestedState = 'unknown';
    let confidence = 'low';

    if (topBefore && topBefore[0] === 'quorum_start') {
      suggestedState = 'quorum_sub_state';
      confidence = 'medium';
    } else if (topAfter && topAfter[0] === 'quorum_complete') {
      suggestedState = 'quorum_pre_completion';
      confidence = 'medium';
    } else if (cluster.action === 'undefined' || cluster.action === 'quorum_fallback_t1_required') {
      suggestedState = 'instrumentation_gap';
      confidence = 'high';
    }

    const allTs = cluster.timestamps.map(t => new Date(t).getTime()).filter(t => !isNaN(t));

    return {
      action: cluster.action,
      count: cluster.count,
      first_seen: allTs.length > 0 ? new Date(Math.min(...allTs)).toISOString() : null,
      last_seen: allTs.length > 0 ? new Date(Math.max(...allTs)).toISOString() : null,
      sample_timestamps: cluster.timestamps.slice(0, 5),
      context_before: cluster.context_before,
      context_after: cluster.context_after,
      suggested_state: suggestedState,
      confidence,
    };
  });

  // Sort by count descending
  candidates.sort((a, b) => b.count - a.count);

  // Identify missing transitions (sequences of known actions not in XState)
  const transitionPairs = {};
  for (let i = 0; i < events.length - 1; i++) {
    const fromAction = events[i].action || 'undefined';
    const toAction = events[i + 1].action || 'undefined';
    if (vocabActions.has(fromAction) && vocabActions.has(toAction)) {
      const key = `${fromAction}→${toAction}`;
      transitionPairs[key] = (transitionPairs[key] || 0) + 1;
    }
  }

  // Try mapping through XState to find unmodeled transitions
  const missingTransitions = [];
  for (const [key, count] of Object.entries(transitionPairs)) {
    const [fromAction, toAction] = key.split('→');
    // Check if XState maps both actions
    try {
      const fromEvent = mapToXStateEvent({ action: fromAction });
      const toEvent = mapToXStateEvent({ action: toAction });
      if (!fromEvent || !toEvent) {
        missingTransitions.push({
          from_action: fromAction,
          to_action: toAction,
          count,
          note: `XState mapping missing: from=${fromEvent || 'null'}, to=${toEvent || 'null'}`,
        });
      }
    } catch (_) {}
  }

  // Build result
  const result = {
    schema_version: '1',
    generated: new Date().toISOString(),
    total_unmapped_events: totalUnmapped,
    candidates,
    missing_transitions: missingTransitions,
    summary: `${totalUnmapped} unmapped events found. ` +
             `${candidates.length} candidate(s): ` +
             candidates.slice(0, 3).map(c => `${c.action} (${c.count}x)`).join(', ') +
             (candidates.length > 3 ? `, +${candidates.length - 3} more` : '') + '. ' +
             `${missingTransitions.length} potentially missing transitions.`,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2) + '\n', 'utf8');

  if (JSON_FLAG) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('State Candidates Generated');
    console.log(`  Unmapped events: ${totalUnmapped}`);
    console.log(`  Candidates: ${candidates.length}`);
    for (const c of candidates.slice(0, 5)) {
      console.log(`    ${c.action}: ${c.count}x (suggested: ${c.suggested_state}, confidence: ${c.confidence})`);
    }
    console.log(`  Missing transitions: ${missingTransitions.length}`);
  }
}

// Export for testing
module.exports = { main };

if (require.main === module) {
  main();
}

#!/usr/bin/env node
'use strict';
// bin/trace-corpus-stats.cjs
// Indexes conformance events by session, action type, and state transition.
// Infers sessions using timestamp gaps.
//
// Requirement: EVID-02

const fs   = require('fs');
const path = require('path');

const ROOT = process.env.PROJECT_ROOT || path.join(__dirname, '..');
const EVIDENCE_DIR = path.join(ROOT, '.planning', 'formal', 'evidence');
const VOCAB_PATH = path.join(EVIDENCE_DIR, 'event-vocabulary.json');
const OUTPUT_PATH = path.join(EVIDENCE_DIR, 'trace-corpus-stats.json');

const JSON_FLAG = process.argv.includes('--json');

// Parse --session-gap-ms from CLI
const DEFAULT_SESSION_GAP_MS = 300000; // 5 minutes
function parseSessionGapMs() {
  const idx = process.argv.indexOf('--session-gap-ms');
  if (idx >= 0 && process.argv[idx + 1]) {
    const val = parseInt(process.argv[idx + 1], 10);
    if (!isNaN(val) && val > 0) return val;
  }
  return DEFAULT_SESSION_GAP_MS;
}

// ── Session inference ───────────────────────────────────────────────────────

/**
 * Infer sessions from sorted events using timestamp gap analysis.
 * A gap > sessionGapMs between consecutive events starts a new session.
 */
function inferSessions(events, sessionGapMs) {
  if (events.length === 0) return [];

  const sessions = [];
  let currentSession = {
    id: 'session-001',
    events: [events[0]],
  };

  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1] || {};
    const curr = events[i] || {};
    const prevTs = new Date(prev.ts || prev.timestamp).getTime();
    const currTs = new Date(curr.ts || curr.timestamp).getTime();
    const gap = currTs - prevTs;

    if (gap > sessionGapMs) {
      sessions.push(currentSession);
      const num = String(sessions.length + 1).padStart(3, '0');
      currentSession = {
        id: `session-${num}`,
        events: [events[i]],
      };
    } else {
      currentSession.events.push(events[i]);
    }
  }
  sessions.push(currentSession);

  return sessions;
}

/**
 * Build session summary from raw session with events.
 */
function summarizeSession(session) {
  const events = (session && Array.isArray(session.events)) ? session.events : [];
  const timestamps = events.map(e => new Date((e && (e.ts || e.timestamp))).getTime()).filter(t => !isNaN(t));
  const start = timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString() : null;
  const end = timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null;

  const actions = {};
  for (const e of events) {
    const action = (e && e.action) || 'undefined';
    actions[action] = (actions[action] || 0) + 1;
  }

  return {
    id: session.id,
    start,
    end,
    event_count: events.length,
    actions,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const sessionGapMs = parseSessionGapMs();

  // Ensure output directory
  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  }

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
      events.push(JSON.parse(line));
    } catch (_) {
      // Skip malformed lines
    }
  }

  // Sort by timestamp
  events.sort((a, b) => {
    const tsA = new Date(a.ts || a.timestamp).getTime();
    const tsB = new Date(b.ts || b.timestamp).getTime();
    return tsA - tsB;
  });

  // Infer sessions
  const rawSessions = inferSessions(events, sessionGapMs);
  const sessions = rawSessions.map(summarizeSession);

  // Build action index
  const actionIndex = {};
  for (const session of sessions) {
    for (const [action, count] of Object.entries(session.actions)) {
      if (!actionIndex[action]) {
        actionIndex[action] = { total: 0, sessions: [] };
      }
      actionIndex[action].total += count;
      actionIndex[action].sessions.push(session.id);
    }
  }

  // Build transition index
  const transitionCounts = {};
  for (const event of events) {
    if (event.from_state && event.to_state) {
      const key = `${event.from_state}→${event.to_state}`;
      transitionCounts[key] = (transitionCounts[key] || 0) + 1;
    }
  }
  const transitionIndex = Object.entries(transitionCounts).map(([key, count]) => {
    const [from, to] = key.split('→');
    return { from, to, count };
  });

  // Date range
  const timestamps = events.map(e => new Date(e.ts || e.timestamp).getTime()).filter(t => !isNaN(t));
  const dateRange = timestamps.length > 0
    ? { earliest: new Date(Math.min(...timestamps)).toISOString(), latest: new Date(Math.max(...timestamps)).toISOString() }
    : { earliest: null, latest: null };

  // Vocabulary validation
  const vocab = JSON.parse(fs.readFileSync(VOCAB_PATH, 'utf8'));
  const vocabActions = new Set(Object.keys(vocab.vocabulary));
  const allActions = new Set(Object.keys(actionIndex));
  const known = [...allActions].filter(a => vocabActions.has(a));
  const unknown = [...allActions].filter(a => !vocabActions.has(a));

  // Build result
  const result = {
    schema_version: '1',
    generated: new Date().toISOString(),
    session_gap_ms: sessionGapMs,
    total_events: events.length,
    date_range: dateRange,
    sessions,
    action_index: actionIndex,
    transition_index: transitionIndex,
    vocabulary_validation: {
      known: known.length,
      unknown: unknown.length,
      unknown_actions: unknown,
    },
    summary: `${events.length} events across ${sessions.length} sessions ` +
             `(${dateRange.earliest} to ${dateRange.latest}). ` +
             `${known.length} known actions, ${unknown.length} unknown. ` +
             `${transitionIndex.length} distinct transitions.`,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2) + '\n', 'utf8');

  if (JSON_FLAG) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Trace Corpus Stats Generated`);
    console.log(`  Total events: ${events.length}`);
    console.log(`  Sessions: ${sessions.length}`);
    console.log(`  Date range: ${dateRange.earliest} to ${dateRange.latest}`);
    console.log(`  Known actions: ${known.length}, Unknown: ${unknown.length}`);
    console.log(`  Transitions: ${transitionIndex.length}`);
  }
}

// Export for testing
module.exports = { inferSessions, summarizeSession, parseSessionGapMs, DEFAULT_SESSION_GAP_MS };

// Run if invoked directly
if (require.main === module) {
  main();
}

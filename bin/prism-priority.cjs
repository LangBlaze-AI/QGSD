#!/usr/bin/env node
'use strict';
// bin/prism-priority.cjs
// PRISM failure probability priority ranker for roadmap signal injection.
// Requirements: SIG-03
//
// Usage:
//   node bin/prism-priority.cjs [--path=check-results.ndjson]
//
// Reads check-results.ndjson, extracts PRISM failure entries, ranks by
// P(failure) x impact, and outputs a formatted priority signal block
// for injection into plan-phase.md quorum context.

const fs   = require('fs');
const path = require('path');

// ── Impact score map ─────────────────────────────────────────────────────────
const IMPACT_SCORES = {
  'prism:quorum':           10,
  'prism:mcp-availability': 7,
};
const DEFAULT_IMPACT = 5;

/**
 * readPrismResults(ndjsonPath) — reads check-results.ndjson and filters PRISM entries.
 * @param {string} [ndjsonPath] - path to check-results.ndjson
 * @returns {Array<{ check_id: string, result: string, summary: string, timestamp: string, metadata: object }>}
 */
function readPrismResults(ndjsonPath) {
  const p = ndjsonPath || path.join(process.cwd(), '.planning', 'formal', 'check-results.ndjson');
  try {
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);

    // Parse and filter for PRISM entries
    const prismEntries = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.formalism === 'prism') {
          prismEntries.push({
            check_id:  entry.check_id || 'unknown',
            result:    entry.result || 'unknown',
            summary:   entry.summary || '',
            timestamp: entry.timestamp || '',
            metadata:  entry.metadata || {},
          });
        }
      } catch (_) { /* skip malformed lines */ }
    }

    // Group by check_id, keep only most recent entry per check_id
    const byCheckId = new Map();
    for (const entry of prismEntries) {
      const existing = byCheckId.get(entry.check_id);
      if (!existing || entry.timestamp > existing.timestamp) {
        byCheckId.set(entry.check_id, entry);
      }
    }

    return Array.from(byCheckId.values());
  } catch (_) {
    return [];
  }
}

/**
 * rankFailureModes(prismResults) — ranks failure modes by P(failure) x impact.
 * @param {Array<{ check_id: string, result: string, summary: string, timestamp: string, metadata: object }>} prismResults
 * @returns {Array<{ check_id: string, priority: number, p_failure: number, impact: number, summary: string }>}
 */
function rankFailureModes(prismResults) {
  if (!Array.isArray(prismResults)) return [];
  const failures = prismResults.filter(e => e.result === 'fail' || e.result === 'warn');
  if (failures.length === 0) return [];

  const ranked = failures.map(entry => {
    // Determine P(failure)
    let p_failure;
    if (entry.result === 'fail') {
      p_failure = 1.0;
    } else {
      // warn results — uncertain, use 0.5
      p_failure = 0.5;
    }

    // Determine impact
    const impact = Object.prototype.hasOwnProperty.call(IMPACT_SCORES, entry.check_id)
      ? IMPACT_SCORES[entry.check_id]
      : DEFAULT_IMPACT;

    // Compute priority
    const priority = Math.round(p_failure * impact * 100) / 100;

    return {
      check_id:  entry.check_id,
      priority,
      p_failure,
      impact,
      summary:   entry.summary,
    };
  });

  // Sort descending by priority
  ranked.sort((a, b) => b.priority - a.priority);

  return ranked;
}

/**
 * formatPrioritySignal(rankedModes) — produces formatted text block for quorum injection.
 * @param {Array<{ check_id: string, priority: number, p_failure: number, impact: number, summary: string }>} rankedModes
 * @returns {string|null} - formatted text block, or null if no failures
 */
function formatPrioritySignal(rankedModes) {
  if (!rankedModes || rankedModes.length === 0) return null;

  const lines = [
    '=== PRISM Priority Signal ===',
    'Failure modes ranked by P(failure) x impact:',
  ];

  for (let i = 0; i < rankedModes.length; i++) {
    const mode = rankedModes[i];
    lines.push(
      (i + 1) + '. [' + mode.check_id + '] priority=' + mode.priority.toFixed(1) +
      ' -- P(fail)=' + mode.p_failure.toFixed(1) +
      ', impact=' + mode.impact +
      ' -- "' + mode.summary + '"'
    );
  }

  lines.push('=============================');

  return lines.join('\n');
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const pathArg = args.find(a => a.startsWith('--path='));
  const ndjsonPath = pathArg ? pathArg.split('=')[1] : undefined;

  const results = readPrismResults(ndjsonPath);
  const ranked  = rankFailureModes(results);
  const signal  = formatPrioritySignal(ranked);

  if (signal) {
    process.stdout.write(signal + '\n');
  } else {
    process.stderr.write('No PRISM failures found\n');
  }
}

module.exports = { readPrismResults, rankFailureModes, formatPrioritySignal };

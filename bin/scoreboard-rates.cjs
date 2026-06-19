#!/usr/bin/env node
'use strict';
// bin/scoreboard-rates.cjs
// Side-effect-free helpers for reading per-slot availability rates from the
// quorum scoreboard. Extracted from run-prism.cjs (issue #198) so that
// consumers (quorum-consensus-gate.cjs, run-prism.cjs) can require it WITHOUT
// triggering run-prism's heavy import-time pipeline (process.exit, spawnSync,
// PRISM invocation, argv forwarding).
//
// This module performs NO top-level work: no process.exit, no spawn, no FS
// writes. Requiring it is safe in any context.
//
// Requirements: MCPENV-04

const fs   = require('fs');
const path = require('path');

// ── readMCPAvailabilityRates (MCPENV-04) ─────────────────────────────────────
// Reads quorum-scoreboard.json and computes per-slot availability rates.
// Returns { 'slot-name': availabilityRate, ... } or null if no data.
// Rate = 1.0 - (unavail_count / total_count) per slot, excluding 'claude' (self).
function readMCPAvailabilityRates(sbPath) {
  let p = sbPath;
  if (!p) {
    try {
      const pp = require('./planning-paths.cjs');
      p = pp.resolveWithFallback(process.cwd(), 'quorum-scoreboard');
    } catch (_) {
      p = path.join(process.cwd(), '.planning', 'quorum-scoreboard.json');
    }
  }
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const sb = JSON.parse(raw);
    const rounds = Array.isArray(sb.rounds) ? sb.rounds : [];
    if (rounds.length === 0) return null;

    const slotStats = {};
    for (const round of rounds) {
      const votes = round.votes || {};
      for (const [slot, code] of Object.entries(votes)) {
        if (slot === 'claude') continue; // exclude self
        // FILTER FIRST — inside readMCPAvailabilityRates, before building the rates object.
        // Composite keys (e.g. 'claude-1:deepseek-ai/DeepSeek-V3.2') contain ':' or '/'
        // which are illegal PRISM identifier characters. Filter them out here so the returned
        // rates object contains only base keys — making the function directly testable with
        // realistic scoreboards that include composite keys.
        if (slot.includes(':') || slot.includes('/')) {
          process.stderr.write('[scoreboard-rates] Skipping composite key (invalid PRISM identifier): ' + slot + '\n');
          continue;
        }
        if (!slotStats[slot]) slotStats[slot] = { total: 0, unavail: 0 };
        slotStats[slot].total++;
        if (code === 'UNAVAIL') slotStats[slot].unavail++;
      }
    }

    const rates = {};
    for (const [slot, stats] of Object.entries(slotStats)) {
      if (stats.total === 0) continue;
      rates[slot] = Math.round((1.0 - stats.unavail / stats.total) * 1e6) / 1e6;
    }
    return Object.keys(rates).length > 0 ? rates : null;
  } catch (_) {
    return null; // missing or malformed scoreboard — caller uses priors
  }
}

module.exports = { readMCPAvailabilityRates };

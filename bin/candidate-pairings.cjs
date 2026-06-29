#!/usr/bin/env node
'use strict';

/**
 * candidate-pairings.cjs
 *
 * Generates candidate-pairings.json from the evaluated candidates.json output
 * of v0.34-02 (candidate-discovery + haiku-semantic-eval). Adds resolution
 * tracking fields (pending/confirmed/rejected) and preserves previously
 * resolved pairings on re-run.
 *
 * Usage:
 *   node bin/candidate-pairings.cjs              # generate/update pairings
 *   node bin/candidate-pairings.cjs --json       # print summary to stdout
 *   node bin/candidate-pairings.cjs --force      # regenerate all (ignore existing)
 *
 * Requirements: PAIR-01, PAIR-04
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORMAL_DIR = path.join(process.cwd(), '.planning', 'formal');
const CANDIDATES_PATH = path.join(FORMAL_DIR, 'candidates.json');
const PAIRINGS_PATH = path.join(FORMAL_DIR, 'candidate-pairings.json');

// ─────────────────────────────────────────────────────────────────────────────
// Core logic (exported for testability)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate pairings from candidates data, merging with existing pairings.
 *
 * @param {object} candidatesData - The full candidates.json object
 * @param {object|null} existingPairings - Existing candidate-pairings.json or null
 * @returns {{ metadata: object, pairings: Array }}
 */
function generatePairings(candidatesData, existingPairings) {
  const candidates = Array.isArray(candidatesData && candidatesData.candidates)
    ? candidatesData.candidates
    : [];
  const sourceHash = crypto.createHash('sha256')
    .update(JSON.stringify(candidatesData))
    .digest('hex').slice(0, 8);

  // Build lookup from existing pairings
  const existingMap = new Map();
  if (existingPairings && Array.isArray(existingPairings.pairings)) {
    for (const p of existingPairings.pairings) {
      if (!p || typeof p !== 'object') continue;
      existingMap.set(`${p.model}::${p.requirement}`, p);
    }
  }

  const pairings = [];

  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const key = `${c.model}::${c.requirement}`;
    const existing = existingMap.get(key);

    if (existing && (existing.status === 'rejected' || existing.status === 'confirmed')) {
      // Preserve resolved pairings (PAIR-04 cache)
      pairings.push(existing);
    } else {
      // New or pending pairing
      pairings.push({
        model: c.model,
        requirement: c.requirement,
        proximity_score: c.proximity_score,
        verdict: c.verdict || null,
        confidence: c.confidence || null,
        reasoning: c.reasoning || null,
        status: 'pending',
        resolved_at: null,
        resolved_by: null,
      });
    }
  }

  // Sort: yes first, then maybe, then no; within each group by score descending
  const verdictOrder = { yes: 0, maybe: 1, no: 2 };
  pairings.sort((a, b) => {
    const va = verdictOrder[a.verdict] != null ? verdictOrder[a.verdict] : 3;
    const vb = verdictOrder[b.verdict] != null ? verdictOrder[b.verdict] : 3;
    if (va !== vb) return va - vb;
    if (b.proximity_score !== a.proximity_score) return b.proximity_score - a.proximity_score;
    return (`${a.model}::${a.requirement}`).localeCompare(`${b.model}::${b.requirement}`);
  });

  const pending = pairings.filter(p => p.status === 'pending').length;
  const confirmed = pairings.filter(p => p.status === 'confirmed').length;
  const rejected = pairings.filter(p => p.status === 'rejected').length;

  return {
    metadata: {
      generated: new Date().toISOString(),
      source_candidates_hash: sourceHash,
      total_pairings: pairings.length,
      pending,
      confirmed,
      rejected,
    },
    pairings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { json: false, force: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

// Read + parse a required JSON input, exiting cleanly (not a raw SyntaxError) on a
// missing or corrupt file (dogfood F47).
function readJsonOrExit(p, label) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    process.stderr.write(`[candidate-pairings] ERROR: cannot read ${label} (${p}): ${e.message}\n`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`[candidate-pairings] ERROR: ${label} is not valid JSON (${p}): ${e.message}\n`);
    process.exit(1);
  }
}

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(`Usage: node bin/candidate-pairings.cjs [options]

Options:
  --json    Print summary to stdout as JSON
  --force   Regenerate all (ignore existing pairings)
  --help    Show this help message
`);
    process.exit(0);
  }

  if (!fs.existsSync(CANDIDATES_PATH)) {
    process.stderr.write('[candidate-pairings] ERROR: candidates.json not found — run candidate-discovery + haiku-semantic-eval first\n');
    process.exit(1);
  }

  const candidatesData = readJsonOrExit(CANDIDATES_PATH, 'candidates.json');
  const candidates = candidatesData.candidates || [];

  if (candidates.filter(c => c.verdict).length === 0) {
    process.stderr.write('[candidate-pairings] ERROR: No evaluated candidates — run haiku-semantic-eval first\n');
    process.exit(1);
  }

  let existingPairings = null;
  if (!args.force && fs.existsSync(PAIRINGS_PATH)) {
    try {
      existingPairings = JSON.parse(fs.readFileSync(PAIRINGS_PATH, 'utf8'));
    } catch { /* ignore corrupt file */ }
  }

  const result = generatePairings(candidatesData, existingPairings);

  fs.writeFileSync(PAIRINGS_PATH, JSON.stringify(result, null, 2) + '\n');
  process.stderr.write(`[candidate-pairings] Generated ${result.metadata.total_pairings} pairings (${result.metadata.pending} pending, ${result.metadata.confirmed} confirmed, ${result.metadata.rejected} rejected)\n`);

  if (args.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  }
}

if (require.main === module) {
  main();
}

module.exports = { generatePairings };

#!/usr/bin/env node
'use strict';

/**
 * compute-semantic-scores.cjs
 *
 * Aggregates Haiku verdicts from candidates.json per gate and writes
 * semantic_score to gate JSON files alongside existing wiring_score fields.
 *
 * Usage:
 *   node bin/compute-semantic-scores.cjs              # compute and write
 *   node bin/compute-semantic-scores.cjs --dry-run    # compute without writing
 *   node bin/compute-semantic-scores.cjs --maybe-weight 0.0  # exclude maybe verdicts
 *   node bin/compute-semantic-scores.cjs --json       # output as JSON to stdout
 *
 * Requirements: SEM-03, SEM-04, SEM-05
 */

const fs = require('fs');
const path = require('path');

const FORMAL_DIR = path.join(process.cwd(), '.planning', 'formal');
const CANDIDATES_PATH = path.join(FORMAL_DIR, 'candidates.json');
const PER_MODEL_GATES_PATH = path.join(FORMAL_DIR, 'gates', 'per-model-gates.json');
const GATE_PATHS = {
  gate_a: path.join(FORMAL_DIR, 'gates', 'gate-a-grounding.json'),
  gate_b: path.join(FORMAL_DIR, 'gates', 'gate-b-abstraction.json'),
  gate_c: path.join(FORMAL_DIR, 'gates', 'gate-c-validation.json'),
};
const GATE_LABELS = {
  gate_a: 'Gate A (Wiring:Evidence)',
  gate_b: 'Gate B (Wiring:Purpose)',
  gate_c: 'Gate C (Wiring:Coverage)',
};

// ─────────────────────────────────────────────────────────────────────────────
// Core scoring logic (exported for testability)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute per-gate semantic_score from candidates and per-model gate results.
 *
 * @param {Array} candidates - Evaluated candidates with verdicts
 * @param {object} perModelGates - per-model-gates.json models object
 * @param {string} gateKey - 'gate_a', 'gate_b', or 'gate_c'
 * @param {number} maybeWeight - Weight for 'maybe' verdicts (default 0.5)
 * @returns {{ semantic_score: number, semantic_metadata: object }}
 */
function computeGateSemanticScore(candidates, perModelGates, gateKey, maybeWeight) {
  if (maybeWeight == null) maybeWeight = 0.5;

  // Identify models that pass this gate
  const passingModels = new Set();
  for (const [modelPath, info] of Object.entries(perModelGates)) {
    if (info[gateKey] && info[gateKey].pass) {
      passingModels.add(modelPath);
    }
  }

  // Filter candidates whose model passes this gate
  const gateCandidates = candidates.filter(c => passingModels.has(c.model));

  const totalCount = gateCandidates.length;
  if (totalCount === 0) {
    return {
      semantic_score: 0.0,
      semantic_metadata: {
        evaluated_candidates: 0,
        confirmed: 0,
        rejected: 0,
        maybe: 0,
        computed: new Date().toISOString(),
      },
    };
  }

  let yesCount = 0;
  let noCount = 0;
  let maybeCount = 0;

  for (const c of gateCandidates) {
    if (c.verdict === 'yes') yesCount++;
    else if (c.verdict === 'no') noCount++;
    else maybeCount++;
  }

  const score = (yesCount + maybeCount * maybeWeight) / totalCount;

  return {
    semantic_score: Math.round(score * 10000) / 10000,
    semantic_metadata: {
      evaluated_candidates: totalCount,
      confirmed: yesCount,
      rejected: noCount,
      maybe: maybeCount,
      computed: new Date().toISOString(),
    },
  };
}

/**
 * Enrich a gate JSON file with semantic_score, preserving all existing fields.
 *
 * @param {object} gateData - Existing gate JSON content
 * @param {number} semanticScore - Computed semantic score
 * @param {object} semanticMetadata - Metadata about the computation
 * @returns {object} Updated gate JSON (new object, does not mutate input)
 */
function enrichGateFile(gateData, semanticScore, semanticMetadata) {
  return {
    ...gateData,
    schema_version: '3',
    semantic_score: semanticScore,
    semantic_metadata: semanticMetadata,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { dryRun: false, json: false, maybeWeight: 0.5, help: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else if (argv[i].startsWith('--maybe-weight')) {
      const val = argv[i].includes('=') ? argv[i].split('=')[1] : argv[++i];
      args.maybeWeight = parseFloat(val);
    }
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
    process.stderr.write(`[compute-semantic-scores] ERROR: cannot read ${label} (${p}): ${e.message}\n`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`[compute-semantic-scores] ERROR: ${label} is not valid JSON (${p}): ${e.message}\n`);
    process.exit(1);
  }
}

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(`Usage: node bin/compute-semantic-scores.cjs [options]

Options:
  --dry-run              Compute and display without writing
  --maybe-weight <n>     Weight for 'maybe' verdicts (default: 0.5)
  --json                 Output scores as JSON to stdout
  --help                 Show this help message
`);
    process.exit(0);
  }

  // Validate inputs
  if (!fs.existsSync(CANDIDATES_PATH)) {
    process.stderr.write('[semantic-scores] ERROR: candidates.json not found\n');
    process.exit(1);
  }

  const candidatesData = readJsonOrExit(CANDIDATES_PATH, 'candidates.json');
  const candidates = candidatesData.candidates || [];

  // Validate that candidates have verdicts
  const withVerdicts = candidates.filter(c => c.verdict);
  if (withVerdicts.length === 0) {
    process.stderr.write('[semantic-scores] ERROR: No evaluated candidates \u2014 run haiku-semantic-eval first\n');
    process.exit(1);
  }

  // Load per-model gates
  if (!fs.existsSync(PER_MODEL_GATES_PATH)) {
    process.stderr.write('[semantic-scores] ERROR: per-model-gates.json not found\n');
    process.exit(1);
  }
  const perModelGatesData = readJsonOrExit(PER_MODEL_GATES_PATH, 'per-model-gates.json');
  const perModelGates = perModelGatesData.models || {};

  const results = {};

  for (const [gateKey, gatePath] of Object.entries(GATE_PATHS)) {
    const { semantic_score, semantic_metadata } = computeGateSemanticScore(
      candidates, perModelGates, gateKey, args.maybeWeight,
    );

    results[gateKey] = { semantic_score, semantic_metadata };

    const label = GATE_LABELS[gateKey];
    process.stderr.write(`[semantic-scores] ${label}: semantic_score=${semantic_score} (${semantic_metadata.confirmed} yes / ${semantic_metadata.evaluated_candidates} total)\n`);

    if (!args.dryRun) {
      let gateData = {};
      if (fs.existsSync(gatePath)) {
        gateData = JSON.parse(fs.readFileSync(gatePath, 'utf8'));
      }
      const enriched = enrichGateFile(gateData, semantic_score, semantic_metadata);
      fs.writeFileSync(gatePath, JSON.stringify(enriched, null, 2) + '\n');
    }
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  }

  if (!args.dryRun) {
    process.stderr.write('[semantic-scores] Gate files updated with semantic_score (schema_version 3)\n');
  }
}

if (require.main === module) {
  main();
}

module.exports = { computeGateSemanticScore, enrichGateFile };

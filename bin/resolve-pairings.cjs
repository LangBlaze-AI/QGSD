#!/usr/bin/env node
'use strict';

/**
 * resolve-pairings.cjs
 *
 * Interactive CLI for human confirmation of graph-discovered (model, requirement)
 * pairings. Confirmed pairings are written to model-registry.json requirements
 * arrays. Rejected pairings are cached to avoid re-evaluation.
 *
 * Usage:
 *   node bin/resolve-pairings.cjs                    # interactive mode
 *   node bin/resolve-pairings.cjs --auto-confirm-yes # auto-confirm verdict=yes
 *   node bin/resolve-pairings.cjs --auto-reject-no   # auto-reject verdict=no
 *   node bin/resolve-pairings.cjs --dry-run           # show without writing
 *
 * Requirements: PAIR-02, PAIR-03, PAIR-04
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const FORMAL_DIR = path.join(process.cwd(), '.planning', 'formal');
const PAIRINGS_PATH = path.join(FORMAL_DIR, 'candidate-pairings.json');
const REGISTRY_PATH = path.join(FORMAL_DIR, 'model-registry.json');

// ─────────────────────────────────────────────────────────────────────────────
// Core logic (exported for testability)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Confirm a pairing: set status, add requirement to model-registry.
 *
 * @param {object} pairing - The pairing object to confirm
 * @param {object} registry - The full model-registry.json object
 * @returns {{ pairing: object, registry: object, added: boolean }}
 */
function confirmPairing(pairing, registry) {
  pairing.status = 'confirmed';
  pairing.resolved_at = new Date().toISOString();
  pairing.resolved_by = 'human';

  let added = false;
  const models = (registry && registry.models) || {};
  if (Object.prototype.hasOwnProperty.call(models, pairing.model)) {
    const reqs = models[pairing.model].requirements || [];
    if (!reqs.includes(pairing.requirement)) {
      reqs.push(pairing.requirement);
      models[pairing.model].requirements = reqs;
      added = true;
    }
  } else {
    process.stderr.write(`[resolve-pairings] WARN: model ${pairing.model} not found in registry, skipping registry update\n`);
  }

  return { pairing, registry, added };
}

/**
 * Reject a pairing: set status and timestamp.
 *
 * @param {object} pairing - The pairing object to reject
 * @returns {object} The updated pairing
 */
function rejectPairing(pairing) {
  pairing.status = 'rejected';
  pairing.resolved_at = new Date().toISOString();
  pairing.resolved_by = 'human';
  return pairing;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence helpers
// ─────────────────────────────────────────────────────────────────────────────

function savePairings(data) {
  fs.writeFileSync(PAIRINGS_PATH, JSON.stringify(data, null, 2) + '\n');
}

function saveRegistry(registry) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
}

function updateMetadataCounts(data) {
  const pairings = data.pairings || [];
  data.metadata.pending = pairings.filter(p => p.status === 'pending').length;
  data.metadata.confirmed = pairings.filter(p => p.status === 'confirmed').length;
  data.metadata.rejected = pairings.filter(p => p.status === 'rejected').length;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    autoConfirmYes: false,
    autoRejectNo: false,
    dryRun: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--auto-confirm-yes') args.autoConfirmYes = true;
    else if (argv[i] === '--auto-reject-no') args.autoRejectNo = true;
    else if (argv[i] === '--dry-run') args.dryRun = true;
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
    process.stderr.write(`[resolve-pairings] ERROR: cannot read ${label} (${p}): ${e.message}\n`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`[resolve-pairings] ERROR: ${label} is not valid JSON (${p}): ${e.message}\n`);
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(`Usage: node bin/resolve-pairings.cjs [options]

Options:
  --auto-confirm-yes   Auto-confirm all pairings with verdict "yes"
  --auto-reject-no     Auto-reject all pairings with verdict "no"
  --dry-run            Show what would be resolved without writing
  --help               Show this help message
`);
    process.exit(0);
  }

  if (!fs.existsSync(PAIRINGS_PATH)) {
    process.stderr.write('[resolve-pairings] ERROR: candidate-pairings.json not found — run candidate-pairings first\n');
    process.exit(1);
  }

  if (!fs.existsSync(REGISTRY_PATH)) {
    process.stderr.write('[resolve-pairings] ERROR: model-registry.json not found\n');
    process.exit(1);
  }

  const data = readJsonOrExit(PAIRINGS_PATH, 'candidate-pairings.json');
  const registry = readJsonOrExit(REGISTRY_PATH, 'model-registry.json');

  // A partially-written / wrong-shape pairings file has no (or a non-array)
  // `pairings` — treat it as "nothing pending" instead of crashing on `.filter`.
  const pairings = Array.isArray(data.pairings) ? data.pairings : [];
  const pending = pairings.filter(p => p && p.status === 'pending');

  if (pending.length === 0) {
    console.log('No pending pairings to resolve.');
    process.exit(0);
  }

  let confirmedCount = 0;
  let rejectedCount = 0;
  let skippedCount = 0;

  // Batch modes
  if (args.autoConfirmYes || args.autoRejectNo) {
    for (const p of pending) {
      if (args.autoConfirmYes && p.verdict === 'yes') {
        if (!args.dryRun) {
          confirmPairing(p, registry);
        }
        confirmedCount++;
        process.stderr.write(`[resolve-pairings] ${args.dryRun ? '[DRY RUN] Would confirm' : 'Confirmed'}: ${p.model} <-> ${p.requirement}\n`);
      } else if (args.autoRejectNo && p.verdict === 'no') {
        if (!args.dryRun) {
          rejectPairing(p);
        }
        rejectedCount++;
        process.stderr.write(`[resolve-pairings] ${args.dryRun ? '[DRY RUN] Would reject' : 'Rejected'}: ${p.model} <-> ${p.requirement}\n`);
      } else {
        skippedCount++;
      }
    }

    if (!args.dryRun) {
      updateMetadataCounts(data);
      savePairings(data);
      saveRegistry(registry);
    }

    console.log(`\nSummary: Confirmed: ${confirmedCount}, Rejected: ${rejectedCount}, Skipped: ${skippedCount}`);
    process.exit(0);
  }

  // Dry run mode
  if (args.dryRun) {
    console.log(`\n${pending.length} pending pairings:\n`);
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      console.log(`[${i + 1}/${pending.length}] Model: ${p.model}`);
      console.log(`        Requirement: ${p.requirement}`);
      console.log(`        Proximity: ${p.proximity_score} | Verdict: ${p.verdict} (confidence: ${p.confidence})`);
      if (p.reasoning) console.log(`        Reasoning: ${p.reasoning}`);
      console.log();
    }
    process.exit(0);
  }

  // Interactive mode
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];

    console.log(`\n[${i + 1}/${pending.length}] Model: ${p.model}`);
    console.log(`        Requirement: ${p.requirement}`);
    console.log(`        Proximity: ${p.proximity_score} | Verdict: ${p.verdict} (confidence: ${p.confidence})`);
    if (p.reasoning) console.log(`        Reasoning: ${p.reasoning}`);
    console.log();

    const answer = await ask('        (c)onfirm | (r)eject | (s)kip | (q)uit: ');
    const cmd = answer.trim().toLowerCase();

    if (cmd === 'c' || cmd === 'confirm') {
      confirmPairing(p, registry);
      confirmedCount++;
      updateMetadataCounts(data);
      savePairings(data);
      saveRegistry(registry);
      console.log('        -> Confirmed, written to model-registry.json');
    } else if (cmd === 'r' || cmd === 'reject') {
      rejectPairing(p);
      rejectedCount++;
      updateMetadataCounts(data);
      savePairings(data);
      console.log('        -> Rejected, cached');
    } else if (cmd === 's' || cmd === 'skip') {
      skippedCount++;
      console.log('        -> Skipped');
    } else if (cmd === 'q' || cmd === 'quit') {
      updateMetadataCounts(data);
      savePairings(data);
      saveRegistry(registry);
      console.log('\nSaved progress. Exiting.');
      break;
    }
  }

  rl.close();
  console.log(`\nSummary: Confirmed: ${confirmedCount}, Rejected: ${rejectedCount}, Skipped: ${skippedCount}`);
}

if (require.main === module) {
  main();
}

module.exports = { confirmPairing, rejectPairing };

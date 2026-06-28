#!/usr/bin/env node
'use strict';

/**
 * hazard-model.cjs — FMEA hazard model for Layer 3 (Reasoning).
 *
 * Applies FMEA scoring (Severity x Occurrence x Detection = RPN) to every
 * state-event pair in the L2 observed FSM. Outputs hazard-model.json with
 * derived_from traceability links.
 *
 * Requirements: RSN-01
 *
 * Usage:
 *   node bin/hazard-model.cjs            # print summary to stdout
 *   node bin/hazard-model.cjs --json     # print full results JSON to stdout
 */

const fs   = require('fs');
const path = require('path');

const ROOT = (() => {
  const arg = process.argv.find(a => a.startsWith('--project-root='));
  if (arg) return path.resolve(arg.slice('--project-root='.length));
  if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;
  return path.join(__dirname, '..');
})();
const FORMAL = path.join(ROOT, '.planning', 'formal');
const REASONING_DIR = path.join(FORMAL, 'reasoning');
const OUT_FILE = path.join(REASONING_DIR, 'hazard-model.json');

const JSON_FLAG = process.argv.includes('--json');

// ── Severity lookup table (domain judgment) ─────────────────────────────────

/**
 * Compute severity score (1-10) for a (fromState, event) pair.
 * Based on domain impact if the transition fails.
 */
function computeSeverity(fromState, event) {
  // DECIDED -> any self-loop: already terminal, harmless (check first — overrides event rules)
  if (fromState === 'DECIDED') return 2;

  // DELIBERATING -> DECIDE: wrong verdict = incorrect PASS/BLOCK
  if (fromState === 'DELIBERATING' && event === 'DECIDE') return 8;

  // COLLECTING_VOTES -> VOTES_COLLECTED: incomplete votes = stalled quorum
  if (fromState === 'COLLECTING_VOTES' && event === 'VOTES_COLLECTED') return 6;

  // Any -> CIRCUIT_BREAK: false positive break = workflow interruption
  if (event === 'CIRCUIT_BREAK') return 6;

  // IDLE -> QUORUM_START: start failure = degraded, can retry
  if (fromState === 'IDLE' && event === 'QUORUM_START') return 4;

  // Default: moderate
  return 4;
}

// ── Occurrence computation from trace data ──────────────────────────────────

/**
 * Compute occurrence score (1-10) based on transition frequency.
 * ratio = transition.count / totalSessions
 */
function computeOccurrenceScore(transitionCount, totalSessions) {
  if (totalSessions === 0) return 1;
  const ratio = transitionCount / totalSessions;
  if (ratio > 0.8) return 10;
  if (ratio > 0.5) return 8;
  if (ratio > 0.2) return 6;
  if (ratio > 0.05) return 4;
  if (ratio > 0) return 2;
  return 1;
}

// ── Detection computation from formalism + test coverage ────────────────────

// Mapping of states/events to related requirement prefixes for formalism lookup
const STATE_REQ_MAP = {
  'IDLE':             ['STOP', 'SPEC'],
  'COLLECTING_VOTES': ['PLAN', 'LOOP'],
  'DELIBERATING':     ['PLAN', 'IMPR', 'LOOP'],
  'DECIDED':          ['ORES', 'DETECT'],
};

const EVENT_REQ_MAP = {
  'QUORUM_START':     ['PLAN', 'CRED'],
  'VOTES_COLLECTED':  ['PLAN', 'LOOP'],
  'DECIDE':           ['PLAN', 'IMPR', 'SAFE'],
  'CIRCUIT_BREAK':    ['DETECT', 'ORES'],
};

/**
 * Compute detection score (1-10) based on formalism and test coverage.
 * - Has formalism AND tests: 2
 * - Has formalism OR tests: 4
 * - Neither (only conformance events): 8
 * - Nothing at all: 10
 */
function computeDetectionScore(fromState, event, failureTaxonomy, unitTestCoverage) {
  // Check if any formal check covers related requirements
  const relatedPrefixes = [
    ...(STATE_REQ_MAP[fromState] || []),
    ...(EVENT_REQ_MAP[event] || []),
  ];

  const logicViolations = failureTaxonomy?.categories?.logic_violation || [];
  const hasFormalism = logicViolations.some(f =>
    (f.requirement_ids || []).some(rid =>
      relatedPrefixes.some(pfx => typeof rid === 'string' && rid.startsWith(pfx))
    )
  );

  // Check if there are tests covering related requirement IDs
  const coveredReqs = unitTestCoverage?.requirements || {};
  const hasTests = relatedPrefixes.some(pfx =>
    Object.keys(coveredReqs).some(rid => rid.startsWith(pfx) && coveredReqs[rid]?.covered)
  );

  if (hasFormalism && hasTests) return 2;
  if (hasFormalism || hasTests) return 4;

  // Check if at least conformance events cover this transition
  // (all transitions in observed-fsm.json have conformance traces by definition)
  return 8;
}

// ── Main generation ─────────────────────────────────────────────────────────

function generateHazardModel(observedFsm, traceStats, failureTaxonomy, unitTestCoverage) {
  const totalSessions = traceStats?.sessions?.length || 349;
  const hazards = [];

  for (const [fromState, events] of Object.entries((observedFsm && observedFsm.observed_transitions) || {})) {
    for (const [event, data] of Object.entries(events || {})) {
      if (!data || typeof data !== 'object') continue;
      const severity = computeSeverity(fromState, event);
      const occurrence = computeOccurrenceScore(data.count, totalSessions);
      const detection = computeDetectionScore(fromState, event, failureTaxonomy, unitTestCoverage);
      const rpn = severity * occurrence * detection;

      // Build derived_from links
      const derivedFrom = [
        {
          layer: 'L2',
          artifact: 'semantics/observed-fsm.json',
          ref: `observed_transitions.${fromState}.${event}`,
        },
        {
          layer: 'L1',
          artifact: 'evidence/trace-corpus-stats.json',
          ref: `sessions[*].actions`,
        },
      ];

      // Add invariant link if any invariant relates to this state
      const invariantConfigs = {
        'IDLE':             'MCQGSDQuorum',
        'COLLECTING_VOTES': 'MCQGSDQuorum',
        'DELIBERATING':     'MCdeliberation',
        'DECIDED':          'MCQGSDQuorum',
      };
      const config = invariantConfigs[fromState];
      if (config) {
        derivedFrom.push({
          layer: 'L2',
          artifact: 'semantics/invariant-catalog.json',
          ref: `invariants[config=${config}]`,
        });
      }

      hazards.push({
        id: `HAZARD-${fromState}-${event}`,
        state: fromState,
        event,
        to_state: data.to_state,
        severity,
        occurrence,
        detection,
        rpn,
        derived_from: derivedFrom,
      });
    }
  }

  // Sort by RPN descending
  hazards.sort((a, b) => b.rpn - a.rpn);

  const criticalCount = hazards.filter(h => h.rpn >= 200).length;
  const highCount = hazards.filter(h => h.rpn >= 100 && h.rpn < 200).length;
  const maxRpn = hazards.length > 0 ? hazards[0].rpn : 0;

  return {
    schema_version: '1',
    generated: new Date().toISOString(),
    methodology: 'FMEA (IEC 60812)',
    scoring_scale: {
      severity: '1-10: 1=no impact, 2=cosmetic, 4=degraded, 6=stalled/interrupted, 8=incorrect verdict, 10=crash/data loss',
      occurrence: '1-10: based on transition count / total sessions (349). >80%=10, >50%=8, >20%=6, >5%=4, >0%=2, 0=1',
      detection: '1-10: 2=formalism+tests, 4=formalism OR tests, 8=conformance events only, 10=nothing',
      rpn: 'Severity x Occurrence x Detection (range 1-1000)',
    },
    hazards,
    summary: {
      total: hazards.length,
      max_rpn: maxRpn,
      critical_count: criticalCount,
      high_count: highCount,
    },
  };
}

// ── Entry point ─────────────────────────────────────────────────────────────

function main() {
  // Load L2 observed FSM
  const fsmPath = path.join(FORMAL, 'semantics', 'observed-fsm.json');
  if (!fs.existsSync(fsmPath)) {
    console.error('ERROR: observed-fsm.json not found at', fsmPath);
    process.exit(1);
  }
  const observedFsm = JSON.parse(fs.readFileSync(fsmPath, 'utf8'));

  // Load L1 trace corpus stats
  const tracePath = path.join(FORMAL, 'evidence', 'trace-corpus-stats.json');
  let traceStats = { sessions: [] };
  if (fs.existsSync(tracePath)) {
    traceStats = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
  }

  // Load failure taxonomy
  const taxPath = path.join(FORMAL, 'evidence', 'failure-taxonomy.json');
  let failureTaxonomy = { categories: { logic_violation: [] } };
  if (fs.existsSync(taxPath)) {
    failureTaxonomy = JSON.parse(fs.readFileSync(taxPath, 'utf8'));
  }

  // Load unit test coverage
  const covPath = path.join(FORMAL, 'unit-test-coverage.json');
  let unitTestCoverage = { requirements: {} };
  if (fs.existsSync(covPath)) {
    unitTestCoverage = JSON.parse(fs.readFileSync(covPath, 'utf8'));
  }

  const output = generateHazardModel(observedFsm, traceStats, failureTaxonomy, unitTestCoverage);

  // Preserve user overrides from existing hazard-model.json
  // Fields marked with user_override: true (or detection_justification present) are user-owned
  try {
    if (fs.existsSync(OUT_FILE)) {
      const existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
      const overrideMap = {};
      for (const h of (existing.hazards || [])) {
        if (h.user_override || h.detection_justification) {
          overrideMap[h.id] = {
            detection: h.detection,
            detection_justification: h.detection_justification,
            user_override: true,
          };
        }
      }
      if (Object.keys(overrideMap).length > 0) {
        for (const h of output.hazards) {
          const override = overrideMap[h.id];
          if (override) {
            h.detection = override.detection;
            h.detection_justification = override.detection_justification;
            h.user_override = true;
            h.rpn = h.severity * h.occurrence * h.detection;
          }
        }
        // Re-sort and recompute summary after overrides
        output.hazards.sort((a, b) => b.rpn - a.rpn);
        output.summary.max_rpn = output.hazards.length > 0 ? output.hazards[0].rpn : 0;
        output.summary.critical_count = output.hazards.filter(h => h.rpn >= 200).length;
        output.summary.high_count = output.hazards.filter(h => h.rpn >= 100 && h.rpn < 200).length;
      }
    }
  } catch (e) {
    // Fail-open: if existing file can't be read, proceed with fresh generation
  }

  // Write output
  fs.mkdirSync(REASONING_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2) + '\n');

  if (JSON_FLAG) {
    process.stdout.write(JSON.stringify(output));
  } else {
    console.log(`Hazard Model (FMEA)`);
    console.log(`  Total hazards: ${output.summary.total}`);
    console.log(`  Max RPN: ${output.summary.max_rpn}`);
    console.log(`  Critical (RPN>=200): ${output.summary.critical_count}`);
    console.log(`  High (100<=RPN<200): ${output.summary.high_count}`);
    console.log(`  Output: ${OUT_FILE}`);
  }

  process.exit(0);
}

if (require.main === module) main();

module.exports = { computeSeverity, computeOccurrenceScore, computeDetectionScore, generateHazardModel, main };

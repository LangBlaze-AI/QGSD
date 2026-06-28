'use strict';
// bin/attribute-trace-divergence.cjs
// Root-cause attribution tool for XState conformance divergences.
// Reads TTrace records from .planning/formal/.divergences.json (produced by validate-traces.cjs).
// Classifies each divergence as spec-bug or impl-bug with confidence scores.
// DIAG-02: outputs "fix XState guard X" or "fix hook implementation Y at line Z".
//
// CLI usage:
//   node bin/attribute-trace-divergence.cjs [--input <path>] [--batch-size <N>] [--output-json]
//
// --input       path to TTrace JSON file (default: .planning/formal/.divergences.json)
// --batch-size  analyze first N divergences (default: 10)
// --output-json emit structured JSON to stdout in addition to plain text summary

const fs   = require('fs');
const path = require('path');

// ── Attribution heuristics ────────────────────────────────────────────────────

// classifyDivergence: given a TTrace record, classify the root cause.
// Returns { specBugConfidence, implBugConfidence, failingGuard, recommendation, evidence }.
function classifyDivergence(ttrace) {
  const t = (ttrace && typeof ttrace === 'object') ? ttrace : {};
  const { event, actualState, expectedState, guardEvaluations, divergenceType } = t;
  let specBugConfidence = 50;  // start at 50/50
  let implBugConfidence = 50;
  let failingGuard = null;
  const evidence = [];

  // Evidence 1: Are there guard evaluations where a guard failed?
  const failedGuards = (Array.isArray(guardEvaluations) ? guardEvaluations : [])
    .filter(g => g && typeof g === 'object' && !g.passed);
  if (failedGuards.length > 0) {
    failingGuard = failedGuards[0].guardName;
    evidence.push(`Guard "${failingGuard}" evaluated to false`);
    // Guard failure → could be spec-bug (wrong guard logic) or impl-bug (context not set)
    // Check if context values look uninitialized (null, 0, undefined for numeric fields)
    const ctx = failedGuards[0].context || {};
    const suspiciousFields = Object.entries(ctx)
      .filter(([k, v]) => (v === null || v === undefined || v === 0) &&
        (k.includes('Count') || k.includes('Available') || k.includes('Polled')))
      .map(([k]) => k);
    if (suspiciousFields.length > 0) {
      implBugConfidence += 30;
      specBugConfidence -= 30;
      evidence.push(`Context fields may not be initialized: ${suspiciousFields.join(', ')}`);
    } else {
      // Guard failed but context looks populated → more likely spec-bug
      specBugConfidence += 20;
      implBugConfidence -= 20;
      evidence.push(`Context appears populated — guard logic may be incorrect`);
    }
  }

  // Evidence 2: unmappable_action — always impl-bug (hook sent wrong event type)
  if (divergenceType === 'unmappable_action') {
    implBugConfidence = 90;
    specBugConfidence = 10;
    evidence.push('Action type has no XState mapping — hook emitted unknown event');
  }

  // Evidence 3: state stayed same when it should have changed (machine ignored event)
  if (actualState === expectedState) {
    // Validation passed — not a divergence; shouldn't be in TTrace
    implBugConfidence = 0;
    specBugConfidence = 0;
  }

  // Clamp 0-100
  specBugConfidence = Math.max(0, Math.min(100, specBugConfidence));
  implBugConfidence = Math.max(0, Math.min(100, implBugConfidence));

  const recommendation = implBugConfidence >= specBugConfidence
    ? `impl-bug: check hook implementation — context field initialization or event payload mapping`
    : `spec-bug: review XState guard "${failingGuard || 'unknown'}" in nf-workflow.machine.ts`;

  return { specBugConfidence, implBugConfidence, failingGuard, recommendation, evidence };
}

// analyzeTrace: full attribution for one TTrace record.
// Returns structured analysis object.
function analyzeTrace(ttrace, machine, walker) {
  const t = (ttrace && typeof ttrace === 'object') ? ttrace : {};
  const { event, actualState, expectedState, divergenceType } = t;
  const classification = classifyDivergence(ttrace);
  return {
    event_action:         event?.action || 'unknown',
    actual_state:         actualState,
    expected_state:       expectedState,
    divergence_type:      divergenceType,
    failing_guard:        classification.failingGuard,
    spec_bug_confidence:  classification.specBugConfidence,
    impl_bug_confidence:  classification.implBugConfidence,
    recommendation:       classification.recommendation,
    evidence:             classification.evidence,
  };
}

module.exports = { classifyDivergence, analyzeTrace };

if (require.main === module) {
  // Parse args
  const args       = process.argv.slice(2);
  const inputIdx   = args.indexOf('--input');
  const batchIdx   = args.indexOf('--batch-size');
  const outputJson = args.includes('--output-json');
  const inputPath  = inputIdx >= 0
    ? args[inputIdx + 1]
    : path.join(process.cwd(), '.planning', 'formal', '.divergences.json');
  const batchSize  = batchIdx >= 0 ? (parseInt(args[batchIdx + 1], 10) || 10) : 10;

  if (!fs.existsSync(inputPath)) {
    process.stderr.write('[attribute-trace-divergence] No divergences file at: ' + inputPath + '\n');
    process.stderr.write('  Run: node bin/validate-traces.cjs to generate .planning/formal/.divergences.json\n');
    process.exit(0);
  }

  let ttraces;
  try {
    ttraces = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (e) {
    process.stderr.write('[attribute-trace-divergence] Failed to parse: ' + inputPath + ' — ' + e.message + '\n');
    process.exit(1);
  }

  if (!Array.isArray(ttraces) || ttraces.length === 0) {
    process.stdout.write('[attribute-trace-divergence] No divergences to analyze\n');
    process.exit(0);
  }

  const batch   = ttraces.slice(0, batchSize);
  const results = batch.map(t => analyzeTrace(t, null, null));

  // Plain text summary
  process.stdout.write('[attribute-trace-divergence] Analyzed ' + results.length + ' of ' + ttraces.length + ' divergences\n\n');
  for (const r of results) {
    process.stdout.write('Action: ' + r.event_action + ' | ' + r.actual_state + ' → expected ' + r.expected_state + '\n');
    process.stdout.write('  Guard:       ' + (r.failing_guard || 'n/a') + '\n');
    process.stdout.write('  Spec-bug:    ' + r.spec_bug_confidence + '%  |  Impl-bug: ' + r.impl_bug_confidence + '%\n');
    process.stdout.write('  Recommend:   ' + r.recommendation + '\n');
    if (r.evidence.length > 0) {
      process.stdout.write('  Evidence:    ' + r.evidence.join('; ') + '\n');
    }
    process.stdout.write('\n');
  }

  if (outputJson) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  }

  // Fail-open exit: non-zero only if attribution itself errored, not just because divergences exist
  process.exit(0);
}

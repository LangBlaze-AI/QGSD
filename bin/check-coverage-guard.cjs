#!/usr/bin/env node
'use strict';
// bin/check-coverage-guard.cjs
// CI coverage guard — compares current traceability matrix coverage against
// a saved baseline and warns when the drop exceeds a configurable threshold.
//
// Usage:
//   node bin/check-coverage-guard.cjs                    # compare current vs baseline
//   node bin/check-coverage-guard.cjs --save-baseline    # save current matrix as baseline
//   node bin/check-coverage-guard.cjs --threshold 10     # override threshold (default: 15)
//   node bin/check-coverage-guard.cjs --quiet            # suppress output (exit code only)
//
// Requirements: TRACE-05

const fs   = require('fs');
const path = require('path');

const TAG = '[check-coverage-guard]';
let ROOT = process.cwd();

// Parse --project-root (overrides CWD-based ROOT for cross-repo usage)
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--project-root=')) {
    ROOT = path.resolve(arg.slice('--project-root='.length));
  }
}

const MATRIX_PATH   = process.env.COVERAGE_GUARD_MATRIX_PATH || path.join(ROOT, '.planning', 'formal', 'traceability-matrix.json');
const BASELINE_PATH = process.env.COVERAGE_GUARD_BASELINE_PATH || path.join(ROOT, '.planning', 'formal', 'traceability-matrix.baseline.json');

// ── CLI flags ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const saveBaseline = args.includes('--save-baseline');
const quietMode    = args.includes('--quiet');
const thresholdIdx = args.indexOf('--threshold');
let threshold = 15;
if (thresholdIdx !== -1) {
  const parsedThreshold = parseFloat(args[thresholdIdx + 1]);
  threshold = Number.isFinite(parsedThreshold) ? parsedThreshold : 15;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  if (!quietMode) {
    process.stdout.write(TAG + ' ' + msg + '\n');
  }
}

function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
}

// ── Save Baseline Mode ──────────────────────────────────────────────────────

if (saveBaseline) {
  const current = loadJSON(MATRIX_PATH);
  if (!current) {
    process.stderr.write(TAG + ' ERROR: Cannot read ' + MATRIX_PATH + '\n');
    process.exit(1);
  }
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + '\n', 'utf8');
  const cs = current.coverage_summary || {};
  log('Baseline saved: ' + (cs.coverage_percentage || 0) + '% coverage (' + (cs.covered_count || 0) + '/' + (cs.total_requirements || 0) + ' requirements)');
  process.exit(0);
}

// ── Comparison Mode ─────────────────────────────────────────────────────────

const current = loadJSON(MATRIX_PATH);
if (!current) {
  process.stderr.write(TAG + ' ERROR: Cannot read current matrix at ' + MATRIX_PATH + '\n');
  process.exit(1);
}

let baseline = loadJSON(BASELINE_PATH);

if (!baseline) {
  // Auto-create baseline from current matrix
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + '\n', 'utf8');
  const cs = current.coverage_summary || {};
  log('No baseline found — creating from current matrix (' + (cs.coverage_percentage || 0) + '%)');
  log('PASS: No regression (baseline just created)');
  process.exit(0);
}

// Extract coverage percentages
const currentCs  = current.coverage_summary || {};
const baselineCs = baseline.coverage_summary || {};
const currentPct  = currentCs.coverage_percentage || 0;
const baselinePct = baselineCs.coverage_percentage || 0;
const drop = Math.round((baselinePct - currentPct) * 10) / 10;

if (drop > threshold) {
  // Coverage regression exceeds threshold
  log('WARN: Coverage regression detected');
  log('  Baseline: ' + baselinePct + '% (' + (baselineCs.covered_count || 0) + '/' + (baselineCs.total_requirements || 0) + ')');
  log('  Current:  ' + currentPct + '% (' + (currentCs.covered_count || 0) + '/' + (currentCs.total_requirements || 0) + ')');
  log('  Drop:     ' + drop + ' percentage points (threshold: ' + threshold + 'pp)');
  log('  To update baseline: node bin/check-coverage-guard.cjs --save-baseline');
  process.exit(1);
} else if (drop > 0) {
  // Minor drop within threshold
  log('PASS: Minor coverage change (' + drop + 'pp drop, within ' + threshold + 'pp threshold)');
  log('  Baseline: ' + baselinePct + '% → Current: ' + currentPct + '%');
  process.exit(0);
} else {
  // No regression or improved
  log('PASS: No regression (baseline: ' + baselinePct + '% → current: ' + currentPct + '%)');
  process.exit(0);
}

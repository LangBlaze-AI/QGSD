#!/usr/bin/env node
'use strict';
// bin/sensitivity-sweep-feedback.cjs
// LOOP-03 (v0.21-03): Read sensitivity sweep report, compare empirical TP rate,
// re-run PRISM if deviation detected. Exits 0 unless a NEW threshold violation is found.
// Usage: node bin/sensitivity-sweep-feedback.cjs

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ── Named constant ─────────────────────────────────────────────────────────────
const DEVIATION_THRESHOLD = 0.05;

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Read .planning/formal/sensitivity-report.ndjson from cwd.
 * Returns array of parsed NDJSON records, or null if file absent/malformed.
 */
function readSweepRecords(cwd) {
  const reportPath = path.join(cwd, '.planning', 'formal', 'sensitivity-report.ndjson');
  if (!fs.existsSync(reportPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(reportPath, 'utf8');
    return raw.trim().split('\n').filter(l => l.length > 0).map(l => JSON.parse(l));
  } catch (e) {
    process.stderr.write('[sensitivity-sweep-feedback] Warning: failed to parse sensitivity-report.ndjson: ' + e.message + '\n');
    return null;
  }
}

/**
 * Compute empirical TP rate from quorum-scoreboard.md in cwd.
 * Format: | Slot | Wins | Losses |
 * Returns a number (0..1) or null if absent/empty.
 */
function readEmpiricalRate(cwd) {
  const sbPath = path.join(cwd, 'quorum-scoreboard.md');
  if (!fs.existsSync(sbPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(sbPath, 'utf8');
    const rows = raw.split('\n');
    let totalWins = 0;
    let totalLosses = 0;
    const rowRe = /\|\s*\S+\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/g;
    for (const row of rows) {
      let m;
      rowRe.lastIndex = 0;
      while ((m = rowRe.exec(row)) !== null) {
        totalWins   += parseInt(m[1], 10);
        totalLosses += parseInt(m[2], 10);
      }
    }
    const total = totalWins + totalLosses;
    if (total === 0) return null;
    return totalWins / total;
  } catch (e) {
    process.stderr.write('[sensitivity-sweep-feedback] Warning: failed to parse quorum-scoreboard.md: ' + e.message + '\n');
    return null;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

const cwd = process.cwd();

// 1. Read sensitivity report
const allRecords = readSweepRecords(cwd);
if (allRecords === null) {
  process.stdout.write('[sensitivity-sweep-feedback] Warning: .planning/formal/sensitivity-report.ndjson not found — no feedback to process.\n');
  process.exit(0);
}

// 2. Filter to PRISM tp_rate records
const prismTpRecords = allRecords.filter(r =>
  r && typeof r === 'object' &&
  r.formalism === 'prism' &&
  r.metadata && typeof r.metadata === 'object' &&
  r.metadata.parameter === 'tp_rate' &&
  typeof r.metadata.value === 'number' && Number.isFinite(r.metadata.value)
);

// 3. If all inconclusive — no actionable data
const actionableRecords = prismTpRecords.filter(r => r.result !== 'inconclusive');
if (actionableRecords.length === 0) {
  process.stdout.write('[sensitivity-sweep-feedback] Warning: all PRISM tp_rate sweep records are inconclusive — PRISM not available, skipping feedback.\n');
  process.exit(0);
}

// 4. Compute empirical TP rate
const empiricalRate = readEmpiricalRate(cwd);
if (empiricalRate === null) {
  process.stdout.write('[sensitivity-sweep-feedback] Warning: quorum-scoreboard.md not found or empty — cannot compute empirical rate.\n');
  process.exit(0);
}

// 5. Find nearest tested value (from actionable records)
const testedValues = actionableRecords.map(r => r.metadata.value);
const nearestTestedValue = testedValues.reduce((nearest, v) =>
  Math.abs(empiricalRate - v) < Math.abs(empiricalRate - nearest) ? v : nearest
, testedValues[0]);

const deviation = Math.abs(empiricalRate - nearestTestedValue);

// 6. No deviation — exit 0
if (deviation <= DEVIATION_THRESHOLD) {
  process.stdout.write(
    '[sensitivity-sweep-feedback] No deviation detected: empirical rate=' + empiricalRate.toFixed(4) +
    ' nearest tested=' + nearestTestedValue + ' deviation=' + deviation.toFixed(4) +
    ' (threshold=' + DEVIATION_THRESHOLD + ').\n'
  );
  process.exit(0);
}

// 7. Deviation detected — check for flip-to-fail records near the empirical rate
process.stdout.write(
  '[sensitivity-sweep-feedback] Deviation detected: empirical rate=' + empiricalRate.toFixed(4) +
  ' nearest tested=' + nearestTestedValue + ' deviation=' + deviation.toFixed(4) +
  ' (threshold=' + DEVIATION_THRESHOLD + ').\n'
);

// 7a. Check if any flip-to-fail record is near the empirical rate (within 2x threshold)
// If so, this is a NEW threshold violation — exit 1 immediately (conservative, no PRISM run required)
const flipToFailRecords = actionableRecords.filter(r =>
  r.result === 'fail' &&
  r.metadata.delta === 'flip-to-fail' &&
  Math.abs(empiricalRate - r.metadata.value) <= DEVIATION_THRESHOLD * 2
);

if (flipToFailRecords.length > 0) {
  process.stdout.write(
    '[sensitivity-sweep-feedback] NEW THRESHOLD VIOLATION DETECTED: empirical rate=' + empiricalRate.toFixed(4) +
    ' is near flip-to-fail boundary (value=' + flipToFailRecords[0].metadata.value + ').\n'
  );

  // 7b. Update rates.const and re-run PRISM to confirm (fail-open: proceed to exit 1 regardless)
  const exportScript = path.join(__dirname, 'export-prism-constants.cjs');
  const exportResult = spawnSync(process.execPath, [exportScript], {
    encoding: 'utf8',
    cwd: cwd,
    timeout: 10000,
  });
  if (exportResult.status !== 0 || exportResult.error) {
    process.stderr.write(
      '[sensitivity-sweep-feedback] Warning: export-prism-constants pre-step failed — rates.const may be stale.\n' +
      (exportResult.stderr || '') + '\n'
    );
  }

  const runPrismScript = path.join(__dirname, 'run-prism.cjs');
  const prismResult = spawnSync(process.execPath, [runPrismScript], {
    encoding: 'utf8',
    cwd: cwd,
    timeout: 60000,
  });
  process.stdout.write(
    '[sensitivity-sweep-feedback] PRISM re-run exit=' + prismResult.status + '. Exiting 1 (threshold violation).\n'
  );
  process.exit(1);
}

// 7c. Deviation but no flip-to-fail records nearby — update rates.const and re-run PRISM
process.stdout.write('[sensitivity-sweep-feedback] No flip-to-fail boundary near empirical rate. Re-running PRISM with updated rates...\n');

const exportScript = path.join(__dirname, 'export-prism-constants.cjs');
const exportResult = spawnSync(process.execPath, [exportScript], {
  encoding: 'utf8',
  cwd: cwd,
  timeout: 10000,
});
if (exportResult.status !== 0 || exportResult.error) {
  process.stderr.write(
    '[sensitivity-sweep-feedback] Warning: export-prism-constants pre-step failed — rates.const may be stale.\n' +
    (exportResult.stderr || '') + '\n'
  );
}

const runPrismScript = path.join(__dirname, 'run-prism.cjs');
const prismResult = spawnSync(process.execPath, [runPrismScript], {
  encoding: 'utf8',
  cwd: cwd,
  timeout: 60000,
});

if (prismResult.status !== 0) {
  process.stdout.write('[sensitivity-sweep-feedback] PRISM re-run failed after rate update (non-flip-to-fail deviation).\n');
  process.exit(0); // Not a new flip-to-fail violation
}

process.stdout.write('[sensitivity-sweep-feedback] PRISM re-run passed after rate update.\n');
process.exit(0);

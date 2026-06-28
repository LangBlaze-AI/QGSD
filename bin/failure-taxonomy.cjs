#!/usr/bin/env node
'use strict';
// bin/failure-taxonomy.cjs
// Classifies check-result failures into 5 categories:
// crash, timeout, logic_violation, drift, degradation
//
// Requirement: EVID-03

const fs   = require('fs');
const path = require('path');

const ROOT = process.env.PROJECT_ROOT || path.join(__dirname, '..');
const EVIDENCE_DIR = path.join(ROOT, '.planning', 'formal', 'evidence');
const CHECK_RESULTS_PATH = path.join(ROOT, '.planning', 'formal', 'check-results.ndjson');
const DEBT_PATH = path.join(ROOT, '.planning', 'formal', 'debt.json');
const OUTPUT_PATH = path.join(EVIDENCE_DIR, 'failure-taxonomy.json');

const JSON_FLAG = process.argv.includes('--json');

// Timeout threshold in ms (> 60 seconds suggests TLC state explosion)
const TIMEOUT_THRESHOLD_MS = 60000;

// ── Classification rules ────────────────────────────────────────────────────

/**
 * Classify a check-result failure into exactly one category.
 * Decision rules per research Pitfall 5:
 *
 * - crash: formalism tool itself crashed (non-zero exit, no structured result, stack trace)
 * - timeout: runtime_ms > threshold AND result=fail (TLC state explosion, model checker timeout)
 * - logic_violation: TLC/Alloy counterexample, assertion failure
 * - drift: validate-traces reports divergence (formalism "trace" with divergence count)
 * - degradation: metrics trending worse (reserved; falls back to logic_violation when no baseline)
 */
function classifyFailure(entry) {
  if (!entry || typeof entry !== 'object') {
    return { category: 'logic_violation', reason: 'Logic violation: missing or malformed check-result entry' };
  }
  // Check for crash indicators
  if (entry.metadata && entry.metadata.stack_trace) {
    return { category: 'crash', reason: 'Stack trace present in metadata' };
  }
  if (entry.summary && /error|crash|exception|ENOENT|spawn/i.test(entry.summary) &&
      !/counterexample|divergence|fail:/i.test(entry.summary)) {
    return { category: 'crash', reason: `Error pattern in summary: ${entry.summary.substring(0, 80)}` };
  }

  // Check for timeout
  if (entry.runtime_ms && entry.runtime_ms > TIMEOUT_THRESHOLD_MS) {
    return { category: 'timeout', reason: `runtime_ms=${entry.runtime_ms} exceeds ${TIMEOUT_THRESHOLD_MS}ms threshold` };
  }

  // Check for drift (trace formalism with divergences)
  if (entry.formalism === 'trace') {
    const divMatch = entry.summary && String(entry.summary).match(/(\d+)\s+divergence/);
    if (divMatch) {
      return { category: 'drift', reason: `Trace divergence: ${divMatch[1]} divergence(s) detected` };
    }
    return { category: 'drift', reason: 'Trace formalism failure (drift)' };
  }

  // Degradation: reserved, falls back to logic_violation when no baseline
  // (no baseline data exists in current codebase)

  // Default: logic_violation (counterexample, assertion failure, etc.)
  return { category: 'logic_violation', reason: entry.summary
    ? `Logic violation: ${String(entry.summary).substring(0, 100)}`
    : 'Logic violation: check-result failure without specific categorization' };
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  }

  // Read check-results.ndjson
  const failures = [];

  if (fs.existsSync(CHECK_RESULTS_PATH)) {
    const lines = fs.readFileSync(CHECK_RESULTS_PATH, 'utf8').split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.result === 'fail' || entry.result === 'error') {
          failures.push(entry);
        }
      } catch (_) {}
    }
  }

  // Read debt.json for additional failure sources
  if (fs.existsSync(DEBT_PATH)) {
    try {
      const debt = JSON.parse(fs.readFileSync(DEBT_PATH, 'utf8'));
      if (Array.isArray(debt.debt_entries)) {
        for (const entry of debt.debt_entries) {
          failures.push({
            ...entry,
            result: 'fail',
            formalism: entry.formalism || 'unknown',
            tool: entry.tool || 'debt-entry',
            summary: entry.summary || entry.description || 'Debt entry',
            timestamp: entry.timestamp || debt.last_updated,
            _source: 'debt.json',
          });
        }
      }
    } catch (_) {}
  }

  // Classify each failure
  const categories = {
    crash: [],
    timeout: [],
    logic_violation: [],
    drift: [],
    degradation: [],
  };
  const unclassified = [];

  for (const failure of failures) {
    const { category, reason } = classifyFailure(failure);
    const classified = { ...failure, category, classification_reason: reason };

    if (category in categories) {
      categories[category].push(classified);
    } else {
      unclassified.push(classified);
    }
  }

  // Count per category
  const categoryCounts = {};
  for (const [cat, entries] of Object.entries(categories)) {
    categoryCounts[cat] = entries.length;
  }

  // Build result
  const result = {
    schema_version: '1',
    generated: new Date().toISOString(),
    total_failures: failures.length,
    categories,
    category_counts: categoryCounts,
    degradation_fallback_note: 'When no baseline exists, potential degradation entries are classified as logic_violation',
    unclassified,
    summary: `${failures.length} failures classified: ` +
             Object.entries(categoryCounts).map(([k, v]) => `${k}=${v}`).join(', ') +
             `. ${unclassified.length} unclassified.`,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2) + '\n', 'utf8');

  if (JSON_FLAG) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('Failure Taxonomy Generated');
    console.log(`  Total failures: ${failures.length}`);
    for (const [cat, count] of Object.entries(categoryCounts)) {
      console.log(`  ${cat}: ${count}`);
    }
    if (unclassified.length > 0) {
      console.log(`  UNCLASSIFIED: ${unclassified.length}`);
    }
  }

  // Exit 1 if any unclassified
  if (unclassified.length > 0) {
    process.exit(1);
  }
}

// Export for testing
module.exports = { classifyFailure, TIMEOUT_THRESHOLD_MS };

if (require.main === module) {
  main();
}

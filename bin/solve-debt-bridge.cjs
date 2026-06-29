'use strict';

/**
 * Solve-Debt Bridge Module
 *
 * Bridges the debt ledger into the solve loop. Provides functions to read
 * open debt entries, match them to residual vector layers, transition their
 * statuses, and summarize progress.
 *
 * All functions are fail-open: bad input returns safe defaults, never throws.
 */

const path = require('node:path');

/**
 * Resolve the debt-ledger module from either installed or local path.
 * @returns {{ readDebtLedger: Function, writeDebtLedger: Function }}
 */
function loadDebtLedger() {
  try {
    return require('./debt-ledger.cjs');
  } catch {
    try {
      return require(path.join(process.env.HOME || '', '.claude', 'nf-bin', 'debt-ledger.cjs'));
    } catch {
      return null;
    }
  }
}

/**
 * Valid status transitions for debt entries.
 * Also includes resolving->open for regression cases (residual increases after remediation).
 */
const VALID_TRANSITIONS = {
  'open': ['resolving'],
  'acknowledged': ['resolving'],
  'resolving': ['resolved', 'open'],
  'resolved': []
};

/**
 * Layer keywords for matching debt entry titles/descriptions to residual layers.
 */
const LAYER_KEYWORDS = {
  r_to_f: ['requirement', 'formal', 'spec', 'specification', 'invariant', 'model'],
  f_to_t: ['test', 'testing', 'stub', 'coverage', 'vitest', 'jest'],
  c_to_f: ['constant', 'config', 'mismatch', 'code-formal', 'divergence'],
  t_to_c: ['failing', 'failure', 'broken test', 'test failure'],
  f_to_c: ['formal check', 'verification', 'conformance', 'trace'],
  r_to_d: ['documentation', 'docs', 'undocumented', 'readme'],
  d_to_c: ['stale doc', 'broken claim', 'outdated']
};

/**
 * Read open/acknowledged debt entries from the ledger.
 * Fail-open: returns empty entries array on any error.
 *
 * @param {string} ledgerPath - Path to debt.json
 * @returns {{ entries: Array, error: string|null }}
 */
function readOpenDebt(ledgerPath) {
  try {
    const dl = loadDebtLedger();
    if (!dl) {
      return { entries: [], error: 'debt-ledger module not found' };
    }

    const ledger = dl.readDebtLedger(ledgerPath);
    if (!ledger || !Array.isArray(ledger.debt_entries)) {
      return { entries: [], error: null };
    }

    const entries = ledger.debt_entries.filter(
      e => e && (e.status === 'open' || e.status === 'acknowledged')
    );
    return { entries, error: null };
  } catch (err) {
    return { entries: [], error: err.message || String(err) };
  }
}

/**
 * Match debt entries to residual vector layers using heuristics.
 *
 * Matching priority:
 * 1. formal_ref with requirement pattern -> r_to_f
 * 2. source_type internal -> layer from _route or title keywords
 * 3. source_type github/sentry -> f_to_c
 * 4. Title/description keyword scan for any layer
 *
 * @param {Array} debtEntries - Array of debt entry objects
 * @param {object} residualVector - Residual vector from nf-solve.cjs
 * @returns {{ matched: Array<{entry, layer, reason}>, unmatched: Array }}
 */
function matchDebtToResidual(debtEntries, residualVector) {
  if (!Array.isArray(debtEntries)) {
    return { matched: [], unmatched: [] };
  }

  const matched = [];
  const unmatched = [];

  for (const entry of debtEntries) {
    if (!entry || typeof entry !== 'object') {
      unmatched.push(entry);
      continue;
    }
    let layer = null;
    let reason = null;

    // Priority 1: formal_ref with requirement pattern
    if (entry.formal_ref && /^(REQ-|ACT-|CONF-|SEC-|PERF-|INT-)/i.test(entry.formal_ref)) {
      layer = 'r_to_f';
      reason = `formal_ref matches requirement pattern: ${entry.formal_ref}`;
    }

    // Priority 2: source_entries with internal type -> use _route or title keywords
    if (!layer && Array.isArray(entry.source_entries)) {
      const hasInternal = entry.source_entries.some(s => s && s.source_type === 'internal');
      if (hasInternal) {
        // Check _route first
        const route = entry._route || '';
        if (route.includes('test') || route.includes('f_to_t')) {
          layer = 'f_to_t';
          reason = `internal source with test route: ${route}`;
        } else if (route.includes('formal') || route.includes('r_to_f')) {
          layer = 'r_to_f';
          reason = `internal source with formal route: ${route}`;
        } else if (route.includes('doc') || route.includes('r_to_d')) {
          layer = 'r_to_d';
          reason = `internal source with docs route: ${route}`;
        }
      }
    }

    // Priority 3: github/sentry sources -> f_to_c
    if (!layer && Array.isArray(entry.source_entries)) {
      const hasExternal = entry.source_entries.some(
        s => s && (s.source_type === 'github' || s.source_type === 'sentry')
      );
      if (hasExternal) {
        layer = 'f_to_c';
        reason = 'external source (github/sentry) indicates code-formal divergence';
      }
    }

    // Priority 4: Title/description keyword scan (quorum improvement)
    if (!layer) {
      const text = `${entry.title || ''} ${entry.description || ''}`.toLowerCase();
      for (const [layerKey, keywords] of Object.entries(LAYER_KEYWORDS)) {
        if (keywords.some(kw => text.includes(kw))) {
          layer = layerKey;
          reason = `title/description keyword match for ${layerKey}`;
          break;
        }
      }
    }

    if (layer) {
      matched.push({ entry, layer, reason });
    } else {
      unmatched.push(entry);
    }
  }

  return { matched, unmatched };
}

/**
 * Transition debt entry statuses in the ledger.
 *
 * Valid transitions: open->resolving, acknowledged->resolving,
 * resolving->resolved, resolving->open (regression).
 *
 * Fail-open: returns safe defaults on any error.
 *
 * @param {string} ledgerPath - Path to debt.json
 * @param {string[]} fingerprints - Array of fingerprints to transition
 * @param {string} fromStatus - Expected current status
 * @param {string} toStatus - Target status
 * @returns {{ transitioned: number, skipped: number }}
 */
function transitionDebtEntries(ledgerPath, fingerprints, fromStatus, toStatus) {
  try {
    if (!Array.isArray(fingerprints) || fingerprints.length === 0) {
      return { transitioned: 0, skipped: 0 };
    }

    // Validate transition
    const validTargets = VALID_TRANSITIONS[fromStatus];
    if (!validTargets || !validTargets.includes(toStatus)) {
      return { transitioned: 0, skipped: fingerprints.length };
    }

    const dl = loadDebtLedger();
    if (!dl) {
      return { transitioned: 0, skipped: fingerprints.length };
    }

    const ledger = dl.readDebtLedger(ledgerPath);
    if (!ledger || !Array.isArray(ledger.debt_entries)) {
      return { transitioned: 0, skipped: fingerprints.length };
    }

    const fpSet = new Set(fingerprints);
    let transitioned = 0;
    let skipped = 0;

    for (const entry of ledger.debt_entries) {
      if (fpSet.has(entry.fingerprint)) {
        if (entry.status === fromStatus) {
          entry.status = toStatus;
          entry.last_updated = new Date().toISOString();
          transitioned++;
        } else {
          skipped++;
        }
      }
    }

    // Write back if anything changed
    if (transitioned > 0) {
      dl.writeDebtLedger(ledgerPath, ledger);
    }

    return { transitioned, skipped };
  } catch (err) {
    return { transitioned: 0, skipped: fingerprints.length };
  }
}

/**
 * Summarize debt ledger status counts.
 * Fail-open: returns all-zero counts on error.
 *
 * @param {string} ledgerPath - Path to debt.json
 * @returns {{ open: number, acknowledged: number, resolving: number, resolved: number, total: number }}
 */
function summarizeDebtProgress(ledgerPath) {
  const empty = { open: 0, acknowledged: 0, resolving: 0, resolved: 0, total: 0 };

  try {
    const dl = loadDebtLedger();
    if (!dl) return empty;

    const ledger = dl.readDebtLedger(ledgerPath);
    if (!ledger || !Array.isArray(ledger.debt_entries)) return empty;

    const counts = { open: 0, acknowledged: 0, resolving: 0, resolved: 0, total: 0 };
    for (const entry of ledger.debt_entries) {
      const status = entry.status || 'open';
      if (Object.prototype.hasOwnProperty.call(counts, status) && status !== 'total') {
        counts[status]++;
      }
      counts.total++;
    }
    return counts;
  } catch {
    return empty;
  }
}

module.exports = {
  readOpenDebt,
  matchDebtToResidual,
  transitionDebtEntries,
  summarizeDebtProgress,
  // Exported for testing
  VALID_TRANSITIONS,
  LAYER_KEYWORDS
};

// CLI entry — `/nf:solve` invokes this as `node solve-debt-bridge.cjs --read-open
// --project-root=<dir>` and parses stdout JSON. Without this block the module only
// exported and emitted nothing, so DEBT_JSON always fell back to {"entries":[]} and
// the debt-convergence feature never ran (dogfood: library-module-invoked-as-CLI).
if (require.main === module) {
  const args = process.argv.slice(2);
  const rootArg = args.find((a) => a.startsWith('--project-root='));
  const projectRoot = rootArg ? rootArg.slice('--project-root='.length) : process.cwd();
  if (args.includes('--read-open')) {
    const ledgerPath = path.join(projectRoot, '.planning', 'formal', 'debt.json');
    process.stdout.write(JSON.stringify(readOpenDebt(ledgerPath)));
  } else {
    process.stderr.write('Usage: solve-debt-bridge.cjs --read-open [--project-root=DIR]\n');
    process.exit(1);
  }
}

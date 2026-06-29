/**
 * P->F residual sweep function
 * Reads acknowledged debt entries, compares production measurements against
 * formal model thresholds, and returns a residual count with detail.
 *
 * Requirements: PF-01, PF-02, PF-03
 */

'use strict';

const path = require('node:path');
const { readDebtLedger } = require('./debt-ledger.cjs');
const { compareDrift } = require('./compareDrift.cjs');
const { extractFormalExpected } = require('./extractFormalExpected.cjs');

/**
 * Sweep Production-to-Formal layer for divergent debt entries
 * @param {object} [options]
 * @param {string} [options.ledgerPath] - Override path to debt.json
 * @param {string} [options.specDir] - Override path to spec directory
 * @returns {{ residual: number, detail: object }}
 */
function sweepPtoF(options = {}) {
  const ROOT = options.root || process.cwd();
  const focusSet = options.focusSet || null;
  const ledgerPath = options.ledgerPath || path.join(ROOT, '.planning/formal/debt.json');
  const specDir = options.specDir || path.join(ROOT, '.planning/formal/spec');

  // 1. Read ledger (fail-open: empty on error)
  const ledger = readDebtLedger(ledgerPath);

  // 2. Filter for acknowledged entries only (PF-03)
  const entries = Array.isArray(ledger && ledger.debt_entries) ? ledger.debt_entries : [];
  const acknowledged = entries.filter(e => e && e.status === 'acknowledged');

  // 3. Separate linked vs unlinked
  const withRef = acknowledged.filter(e => e.formal_ref != null);
  const unlinked = acknowledged.filter(e => e.formal_ref == null);

  // 4. Detect divergence for linked entries
  const divergent = [];
  for (const entry of withRef) {
    const expected = extractFormalExpected(entry.formal_ref, { specDir });
    if (compareDrift(entry, expected)) {
      divergent.push({
        id: entry.id,
        formal_ref: entry.formal_ref,
        measured: entry.meta?.measured_value,
        expected,
        issue_type: entry.issue_type,
      });
    }
  }

  return {
    residual: divergent.length,
    detail: {
      divergent_entries: divergent,
      skipped_unlinked: unlinked.length,
      skipped_unlinked_ids: unlinked.map(e => e.id),
      scoped: focusSet ? false : undefined,
    },
  };
}

module.exports = { sweepPtoF };

/**
 * P->F auto-close remediation dispatch
 * Dispatches parameter updates via /nf:quick for drift entries,
 * flags investigation for issue/invariant entries.
 *
 * Requirements: PF-04, PF-05
 */

'use strict';

const { transitionDebtEntry } = require('./debt-state-machine.cjs');
const { readDebtLedger, writeDebtLedger } = require('./debt-ledger.cjs');

/**
 * Auto-close P->F divergent entries with two-track dispatch
 * @param {object} residual - The p_to_f residual from sweepPtoF
 * @param {object} [options]
 * @param {function} [options.spawnTool] - Mock spawn function for testing
 * @param {function} [options.isNumericThreshold] - Mock isNumericThreshold for testing
 * @param {function} [options.writeDebtLedger] - Mock write function for testing
 * @param {string} [options.ledgerPath] - Path to debt.json
 * @param {string} [options.specDir] - Path to spec directory
 * @returns {{ actions_taken: string[], entries_processed: number }}
 */
function autoClosePtoF(residual, options = {}) {
  if (!residual || residual.residual === 0) {
    return { actions_taken: [], entries_processed: 0 };
  }

  const isNumericFn = options.isNumericThreshold || require('./isNumericThreshold.cjs').isNumericThreshold;
  const writeLedgerFn = options.writeDebtLedger || writeDebtLedger;
  const spawnFn = options.spawnTool || null;
  const specDir = options.specDir;
  const ledgerPath = options.ledgerPath;

  const actions = [];
  const divergent = residual.detail?.divergent_entries || [];

  if (divergent.length === 0) {
    return { actions_taken: [], entries_processed: 0 };
  }

  // Read full ledger to get actual entry objects for mutation
  const ledger = ledgerPath ? readDebtLedger(ledgerPath) : { debt_entries: [] };

  for (const div of divergent) {
    if (!div || typeof div !== 'object') continue;
    // Find actual entry in ledger
    const entryIdx = (ledger.debt_entries || []).findIndex(e => e && e.id === div.id);
    if (entryIdx === -1) continue;

    let entry = ledger.debt_entries[entryIdx];

    // Freeze: transition acknowledged -> resolving
    const freezeResult = transitionDebtEntry(entry, 'resolving');
    if (!freezeResult.success) {
      actions.push(`Cannot freeze entry ${entry.id}: ${freezeResult.error}`);
      continue;
    }
    entry = freezeResult.entry;
    ledger.debt_entries[entryIdx] = entry;

    // Determine track: parameter update vs investigation
    const isParameter = entry.issue_type === 'drift' && isNumericFn(entry.formal_ref, { specDir });

    if (isParameter) {
      // Parameter update track: dispatch /nf:quick
      let dispatchOk = false;

      if (spawnFn) {
        const result = spawnFn('nf-quick.cjs', [
          `Update formal parameter ${entry.formal_ref} to match production`,
          `Production measurement: ${entry.meta?.measured_value}`,
          `Current formal: ${div.expected}`,
        ]);
        dispatchOk = result && result.ok;
      }

      entry.meta = entry.meta || {};
      entry.meta.remediation_log = `${new Date().toISOString()} - Dispatched parameter update: ${entry.formal_ref}`;

      if (dispatchOk) {
        const resolveResult = transitionDebtEntry(entry, 'resolved');
        if (resolveResult.success) {
          entry = resolveResult.entry;
          ledger.debt_entries[entryIdx] = entry;
        }
        actions.push(`Dispatched parameter update for ${entry.id}`);
      } else {
        // Failed dispatch - entry stays in resolving (state machine does not allow resolving->acknowledged)
        // It will need manual triage to resolve or a future mechanism to revert
        actions.push(`Failed to dispatch parameter update for ${entry.id}`);
      }
    } else {
      // Investigation track: flag only, do NOT auto-remediate
      entry.meta = entry.meta || {};
      entry.meta.investigation_notes = `${new Date().toISOString()} - Production diverged from ${entry.formal_ref || 'unknown'}. Requires manual review.`;
      actions.push(`Flagged ${entry.id} for investigation`);
      // Entry stays in 'resolving' status — investigation needed
    }
  }

  // Persist updated ledger to disk
  if (ledgerPath) {
    writeLedgerFn(ledgerPath, ledger);
  }

  return { actions_taken: actions, entries_processed: divergent.length };
}

module.exports = { autoClosePtoF };

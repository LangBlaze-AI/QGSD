/**
 * Debt ledger write-through for /nf:observe
 * Upserts observations to .planning/formal/debt.json by fingerprint using v0.27-01 functions
 * Then runs dedup engine and formal reference linker (v0.27-03)
 *
 * CRITICAL: Never compute fingerprints inline — always use imported v0.27-01 functions
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { readDebtLedger, writeDebtLedger } = require('./debt-ledger.cjs');
const { fingerprintIssue } = require('./fingerprint-issue.cjs');
const { fingerprintDrift } = require('./fingerprint-drift.cjs');
const { validateDebtEntry } = require('./validate-debt-entry.cjs');
const { deduplicateEntries } = require('./debt-dedup.cjs');
const { linkFormalRefs } = require('./formal-ref-linker.cjs');

/**
 * Write observations from observe command to debt ledger, then dedup and link formal refs.
 * Pipeline: write/upsert -> dedup (fingerprint + Levenshtein) -> formal-ref link -> save
 *
 * @param {object[]} observations - Array of issue/drift objects from handlers (standard schema)
 * @param {string} [ledgerPath] - Path to debt.json (default: .planning/formal/debt.json)
 * @param {object} [options] - Options for dedup and linking
 * @param {number} [options.threshold=0.85] - Levenshtein similarity threshold
 * @param {boolean} [options.verbose=false] - Include detailed merge/link logs
 * @param {string} [options.requirementsPath] - Custom requirements.json path
 * @param {string} [options.specDir] - Custom spec directory path
 * @returns {object} { written, updated, errors, merged, linked, mergeLog?, linkLog? }
 */
function writeObservationsToDebt(observations, ledgerPath, options = {}) {
  const resolvedPath = ledgerPath || path.resolve(process.cwd(), '.planning/formal/debt.json');
  const ledger = readDebtLedger(resolvedPath);
  const now = new Date().toISOString();

  let written = 0;
  let updated = 0;
  let errors = 0;

  for (const obs of observations) {
    try {
      // Compute fingerprint using v0.27-01 functions (NEVER inline)
      let fp;
      if (obs.issue_type === 'drift') {
        fp = fingerprintDrift({
          formal_parameter_key: obs.formal_parameter_key || obs.title
        });
      } else {
        fp = fingerprintIssue({
          exception_type: obs.exception_type || obs.source_type || 'unknown',
          function_name: obs.function_name || 'unknown',
          message: obs.title || ''
        });
      }

      // Search for existing entry by fingerprint
      const existingIdx = ledger.debt_entries.findIndex(e => e.fingerprint === fp);

      if (existingIdx >= 0) {
        // Update existing entry
        const existing = ledger.debt_entries[existingIdx];
        existing.occurrences = (existing.occurrences || 1) + 1;
        existing.last_seen = now;
        existing.source_entries.push({
          source_type: obs.source_type || 'unknown',
          source_id: obs.id || `obs-${Date.now()}`,
          observed_at: obs.created_at || now
        });
        updated++;
      } else {
        // Create new debt entry
        const entry = {
          id: crypto.randomUUID(),
          fingerprint: fp,
          title: (obs.title || 'Unknown observation').slice(0, 256),
          occurrences: 1,
          first_seen: now,
          last_seen: now,
          environments: ['production'],
          status: 'open',
          formal_ref: obs.formal_parameter_key || null,
          source_entries: [{
            source_type: obs.source_type || 'unknown',
            source_id: obs.id || `obs-${Date.now()}`,
            observed_at: obs.created_at || now
          }]
        };

        // Validate before adding
        const validation = validateDebtEntry(entry);
        if (validation !== true) {
          console.warn(`[observe-debt-writer] Skipping invalid entry: ${validation.join('; ')}`);
          errors++;
          continue;
        }

        ledger.debt_entries.push(entry);
        written++;
      }
    } catch (err) {
      console.warn(`[observe-debt-writer] Error processing observation: ${err.message}`);
      errors++;
    }
  }

  // Phase 2: Dedup (fingerprint exact-match + Levenshtein near-duplicate)
  // Normalize a non-array `debt_entries` (corrupt/partially-written ledger) so the
  // dedup pass doesn't choke on a non-iterable (dogfood F48).
  if (!Array.isArray(ledger.debt_entries)) ledger.debt_entries = [];
  const dedupResult = deduplicateEntries(ledger.debt_entries, {
    threshold: options.threshold ?? 0.85
  });
  ledger.debt_entries = dedupResult.entries;

  // Phase 3: Formal reference linking
  const linkResult = linkFormalRefs(ledger.debt_entries, {
    requirementsPath: options.requirementsPath,
    specDir: options.specDir
  });
  ledger.debt_entries = linkResult.entries;

  // Write updated ledger only if changes occurred
  if (written > 0 || updated > 0 || dedupResult.mergeCount > 0 || linkResult.linkedCount > 0) {
    writeDebtLedger(resolvedPath, ledger);
  }

  const result = {
    written,
    updated,
    errors,
    merged: dedupResult.mergeCount,
    linked: linkResult.linkedCount
  };

  if (options.verbose) {
    result.mergeLog = dedupResult.mergeLog;
    result.linkLog = linkResult.linkLog;
  }

  return result;
}

module.exports = { writeObservationsToDebt };

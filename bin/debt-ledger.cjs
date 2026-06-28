/**
 * Debt ledger I/O module
 * Provides atomic read/write operations for debt ledger with fail-open behavior
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Read debt ledger from file
 * Implements fail-open: returns empty ledger on missing or corrupt files
 * @param {string} ledgerPath - Path to debt.json file
 * @returns {object} Ledger object with schema_version, created_at, last_updated, debt_entries
 */
function readDebtLedger(ledgerPath) {
  try {
    const content = fs.readFileSync(ledgerPath, 'utf8');
    const ledger = JSON.parse(content);
    if (
      ledger === null ||
      typeof ledger !== 'object' ||
      Array.isArray(ledger) ||
      !Array.isArray(ledger.debt_entries)
    ) {
      throw new Error('Ledger has invalid shape: expected object with debt_entries array');
    }
    return ledger;
  } catch (err) {
    // Fail-open: log error but return empty ledger
    console.error(`[debt-ledger] Failed to read ledger at ${ledgerPath}:`, err.message);

    const now = new Date().toISOString();
    return {
      schema_version: '1',
      created_at: now,
      last_updated: now,
      debt_entries: []
    };
  }
}

/**
 * Write debt ledger to file atomically
 * Uses temp file + rename pattern to prevent corruption on crash
 * @param {string} ledgerPath - Path to debt.json file
 * @param {object} ledger - Ledger object to write
 */
function writeDebtLedger(ledgerPath, ledger) {
  // Ensure parent directory exists
  const dir = path.dirname(ledgerPath);
  fs.mkdirSync(dir, { recursive: true });

  // Normalize malformed input (null/array/non-object) to a valid ledger shape
  const safeLedger = (ledger && typeof ledger === 'object' && !Array.isArray(ledger)) ? ledger : {};

  // Update last_updated timestamp
  const now = new Date().toISOString();
  const ledgerToWrite = {
    schema_version: '1',
    debt_entries: [],
    ...safeLedger,
    last_updated: now
  };

  // Atomic write: write to temp file, then rename
  const tmpPath = ledgerPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(ledgerToWrite, null, 2), 'utf8');
  fs.renameSync(tmpPath, ledgerPath);
}

module.exports = {
  readDebtLedger,
  writeDebtLedger
};

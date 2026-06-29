/**
 * Validation module for debt entries and ledger
 * Implements runtime validation against debt.schema.json
 */

const VALID_STATUSES = ['open', 'acknowledged', 'resolving', 'resolved'];
const VALID_ENVIRONMENTS = ['production', 'staging', 'development', 'test', 'local'];
const VALID_SOURCE_TYPES = ['github', 'sentry', 'sentry-feedback', 'prometheus', 'grafana', 'logstash', 'bash'];

/**
 * Check if a string is valid ISO8601 date-time format
 * @param {string} dateStr - String to validate
 * @returns {boolean} true if valid ISO8601
 */
function isValidISO8601(dateStr) {
  if (typeof dateStr !== 'string') return false;
  // Check basic ISO8601 format: YYYY-MM-DDTHH:MM:SSZ or with timezone offset
  const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!iso8601Regex.test(dateStr)) return false;
  // Also verify it's a valid date
  const date = new Date(dateStr);
  return !isNaN(date.getTime());
}

/**
 * Validate a debt entry object
 * @param {object} entry - Debt entry to validate
 * @returns {boolean|string[]} true if valid, or array of error strings if invalid
 */
function validateDebtEntry(entry) {
  const errors = [];

  // Type check: must be object
  if (typeof entry !== 'object' || entry === null) {
    return ['entry must be an object'];
  }

  // Check required fields: id
  if (!entry.id || typeof entry.id !== 'string') {
    errors.push('id required (string)');
  } else {
    // Validate id pattern: UUID v4 format
    const idPattern = /^[a-z0-9]{8}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{12}$/;
    if (!idPattern.test(entry.id)) {
      errors.push('id must match UUID format');
    }
  }

  // Check required fields: fingerprint
  if (!entry.fingerprint || typeof entry.fingerprint !== 'string') {
    errors.push('fingerprint required (string)');
  } else {
    // Validate fingerprint pattern: 16-64 hex chars
    const fpPattern = /^[a-z0-9]{16,64}$/;
    if (!fpPattern.test(entry.fingerprint)) {
      errors.push('fingerprint must be 16-64 lowercase hex characters');
    }
  }

  // Check required fields: title
  if (!entry.title || typeof entry.title !== 'string' || entry.title.length < 1) {
    errors.push('title required (non-empty string)');
  } else if (entry.title.length > 256) {
    errors.push('title must be <= 256 characters');
  }

  // Check required fields: occurrences
  if (typeof entry.occurrences !== 'number' || entry.occurrences < 1) {
    errors.push('occurrences required (integer >= 1)');
  } else if (!Number.isInteger(entry.occurrences)) {
    errors.push('occurrences must be an integer');
  }

  // Check required fields: first_seen
  if (!entry.first_seen) {
    errors.push('first_seen required (ISO8601 string)');
  } else if (!isValidISO8601(entry.first_seen)) {
    errors.push('first_seen must be ISO8601 format');
  }

  // Check required fields: last_seen
  if (!entry.last_seen) {
    errors.push('last_seen required (ISO8601 string)');
  } else if (!isValidISO8601(entry.last_seen)) {
    errors.push('last_seen must be ISO8601 format');
  }

  // Check timestamp ordering: last_seen >= first_seen
  if (entry.first_seen && entry.last_seen && isValidISO8601(entry.first_seen) && isValidISO8601(entry.last_seen)) {
    const firstDate = new Date(entry.first_seen);
    const lastDate = new Date(entry.last_seen);
    if (lastDate < firstDate) {
      errors.push('last_seen must be >= first_seen');
    }
  }

  // Check required fields: environments
  if (!Array.isArray(entry.environments) || entry.environments.length === 0) {
    errors.push('environments required (non-empty array)');
  } else {
    // Validate each environment value
    for (const env of entry.environments) {
      if (typeof env !== 'string' || !VALID_ENVIRONMENTS.includes(env)) {
        errors.push(`invalid environment value: ${env} (must be one of: ${VALID_ENVIRONMENTS.join(', ')})`);
      }
    }
  }

  // Check required fields: status
  if (!entry.status || typeof entry.status !== 'string') {
    errors.push('status required (string)');
  } else if (!VALID_STATUSES.includes(entry.status)) {
    errors.push(`status must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  // Check required fields: source_entries
  if (!Array.isArray(entry.source_entries) || entry.source_entries.length === 0) {
    errors.push('source_entries required (non-empty array)');
  } else {
    // Validate each source entry
    for (let i = 0; i < entry.source_entries.length; i++) {
      const se = entry.source_entries[i];
      if (typeof se !== 'object' || se === null) {
        errors.push(`source_entries[${i}] must be an object`);
        continue;
      }
      if (!se.source_type || typeof se.source_type !== 'string' || !VALID_SOURCE_TYPES.includes(se.source_type)) {
        errors.push(`source_entries[${i}].source_type required and must be one of: ${VALID_SOURCE_TYPES.join(', ')}`);
      }
      if (!se.source_id || typeof se.source_id !== 'string' || se.source_id.length === 0) {
        errors.push(`source_entries[${i}].source_id required (non-empty string)`);
      }
      if (!se.observed_at || !isValidISO8601(se.observed_at)) {
        errors.push(`source_entries[${i}].observed_at required (ISO8601 format)`);
      }
    }
  }

  // Check optional fields: formal_ref
  if (Object.prototype.hasOwnProperty.call(entry, 'formal_ref')) {
    if (entry.formal_ref !== null && typeof entry.formal_ref !== 'string') {
      errors.push('formal_ref must be string or null');
    }
  }

  // Check optional fields: formal_ref_source
  if (Object.prototype.hasOwnProperty.call(entry, 'formal_ref_source')) {
    const validSources = ['manual', 'auto-detect', 'spec-inferred'];
    if (entry.formal_ref_source !== null &&
        (typeof entry.formal_ref_source !== 'string' || !validSources.includes(entry.formal_ref_source))) {
      errors.push('formal_ref_source must be "manual", "auto-detect", "spec-inferred", or null');
    }
  }

  // Check for additional properties (additionalProperties: false)
  const allowedProps = new Set([
    'id', 'fingerprint', 'title', 'occurrences', 'first_seen', 'last_seen',
    'environments', 'status', 'formal_ref', 'formal_ref_source', 'source_entries', 'resolved_at'
  ]);
  for (const key of Object.keys(entry)) {
    if (!allowedProps.has(key)) {
      errors.push(`additional property not allowed: ${key}`);
    }
  }

  return errors.length === 0 ? true : errors;
}

/**
 * Validate a debt ledger object
 * @param {object} ledger - Debt ledger to validate
 * @returns {boolean|string[]} true if valid, or array of error strings if invalid
 */
function validateDebtLedger(ledger) {
  const errors = [];

  // Type check: must be object
  if (typeof ledger !== 'object' || ledger === null) {
    return ['ledger must be an object'];
  }

  // Check schema_version
  if (ledger.schema_version !== '1') {
    errors.push('schema_version must be "1"');
  }

  // Check debt_entries is array
  if (!Array.isArray(ledger.debt_entries)) {
    errors.push('debt_entries must be an array');
  } else {
    // Validate each entry
    for (let i = 0; i < ledger.debt_entries.length; i++) {
      const entryErrors = validateDebtEntry(ledger.debt_entries[i]);
      if (entryErrors !== true) {
        errors.push(`debt_entries[${i}]: ${entryErrors.join('; ')}`);
      }
    }
  }

  return errors.length === 0 ? true : errors;
}

module.exports = {
  validateDebtEntry,
  validateDebtLedger,
  isValidISO8601
};

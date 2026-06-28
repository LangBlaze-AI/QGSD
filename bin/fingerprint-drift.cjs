const crypto = require('crypto');

/**
 * Generate deterministic fingerprint for a drift using formal parameter key
 * Fingerprint depends only on the parameter key, not measured values or timestamps
 *
 * @param {Object} drift - Drift object with formal_parameter_key and other optional fields
 * @returns {string} - 16-char hex fingerprint
 * @throws {Error} - If formal_parameter_key is missing or empty
 */
function fingerprintDrift(drift) {
  // Validate that formal_parameter_key exists and is non-empty
  if (!drift || typeof drift !== 'object' || !drift.formal_parameter_key || typeof drift.formal_parameter_key !== 'string' || drift.formal_parameter_key.trim() === '') {
    throw new Error('formal_parameter_key required (non-empty string)');
  }

  // Deterministic hash of the formal parameter key
  return crypto.createHash('sha256')
    .update(drift.formal_parameter_key)
    .digest('hex')
    .slice(0, 16);
}

module.exports = { fingerprintDrift };

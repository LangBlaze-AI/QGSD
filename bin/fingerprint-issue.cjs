const crypto = require('crypto');

/**
 * Normalize and hash an error message
 * Strips timestamps, line numbers, and lowercases for stable hashing
 *
 * @param {string} msg - Error message text
 * @returns {string} - 16-char hex hash
 */
function hashMessage(msg) {
  const normalized = String(msg == null ? '' : msg)
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z]+/g, 'TIMESTAMP') // ISO8601 timestamps
    .replace(/:\d+/g, ':LINE')                             // Line numbers
    .toLowerCase()
    .trim();

  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Generate deterministic fingerprint for an issue using hierarchical strategy:
 * exception_type -> function_name -> message_hash
 *
 * @param {Object} issue - Issue object with optional exception_type, function_name, message
 * @returns {string} - 16-char hex fingerprint
 */
function fingerprintIssue(issue) {
  const safeIssue = (issue && typeof issue === 'object') ? issue : {};

  // Normalize exception type
  const exceptionType = String(safeIssue.exception_type || 'unknown').toLowerCase();

  // Normalize function name (replace non-alphanumeric with underscore)
  const functionName = String(safeIssue.function_name || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_');

  // Hash the message
  const msgHash = hashMessage(safeIssue.message);

  // Combine components with colon separator
  const combined = `${exceptionType}:${functionName}:${msgHash}`;

  // Final deterministic hash
  return crypto.createHash('sha256').update(combined).digest('hex').slice(0, 16);
}

module.exports = { fingerprintIssue, hashMessage };

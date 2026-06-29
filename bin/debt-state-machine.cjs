/**
 * Debt status state machine
 * Enforces valid transitions: open -> acknowledged -> resolving -> resolved
 */

/**
 * Allowed transitions map
 * Each state maps to an array of valid target states
 */
const ALLOWED_TRANSITIONS = {
  'open': ['acknowledged'],                    // open can only go to acknowledged
  'acknowledged': ['resolving', 'open'],       // can move forward or revert to open
  'resolving': ['resolved'],                   // can only go to resolved
  'resolved': []                                // terminal state — no outbound transitions
};

/**
 * Check if a transition is allowed
 * @param {string} fromStatus - Current status
 * @param {string} toStatus - Target status
 * @returns {boolean} true if transition is allowed, false otherwise
 */
function canTransition(fromStatus, toStatus) {
  // Reject transition to same status (no-op transitions not allowed)
  if (fromStatus === toStatus) {
    return false;
  }

  // Check if transition is in the allowed list (own keys only — guard
  // against __proto__/constructor resolving to non-array prototype members)
  const allowed = Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, fromStatus)
    ? ALLOWED_TRANSITIONS[fromStatus]
    : [];
  return allowed.includes(toStatus);
}

/**
 * Transition a debt entry to a new status
 * @param {object} entry - Debt entry object
 * @param {string} newStatus - Target status
 * @returns {object} { success: boolean, entry?: object, error?: string }
 */
function transitionDebtEntry(entry, newStatus) {
  const errors = [];

  // Guard: entry must be a non-null object before dereferencing entry.status
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { success: false, error: 'Invalid entry: must be an object' };
  }

  // Validate target status is one of the allowed values
  const validStatuses = ['open', 'acknowledged', 'resolving', 'resolved'];
  if (!validStatuses.includes(newStatus)) {
    errors.push(`Invalid target status: ${newStatus}`);
  }

  // Check if transition is allowed
  if (!canTransition(entry.status, newStatus)) {
    errors.push(`Transition not allowed: ${entry.status} -> ${newStatus}`);
  }

  // Return error if any validation failed
  if (errors.length > 0) {
    return {
      success: false,
      error: errors.join('; ')
    };
  }

  // Apply transition: create updated entry with new status
  const updated = { ...entry, status: newStatus };

  // Add resolved_at timestamp when transitioning to resolved state
  if (newStatus === 'resolved') {
    updated.resolved_at = new Date().toISOString();
  }

  return {
    success: true,
    entry: updated
  };
}

module.exports = {
  canTransition,
  transitionDebtEntry,
  ALLOWED_TRANSITIONS
};

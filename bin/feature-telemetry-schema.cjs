'use strict';
// bin/feature-telemetry-schema.cjs
// Single source of truth for feature interaction telemetry event schema.
// Imported by feature-report.cjs for validation during event parsing.
// NEVER add external require() calls — keep zero runtime dependencies.

const FEATURE_IDS = [
  'formal_loop',           // Loop 1/2 autoresearch iterations
  'quorum_consensus',      // Multi-agent quorum voting
  'debug_pipeline',        // /nf:debug bug investigation
  'pre_commit_gate',       // Pre-commit simulation gate (Loop 2)
  'task_classification',   // Haiku task classifier
  'model_staleness',       // Formal model staleness detection
  'observe_pipeline',      // /nf:observe data gathering
  'solve_diagnostic',      // /nf:solve diagnostic sweep
];

const FEATURE_ACTIONS = ['start', 'complete', 'fail', 'skip'];

const FEATURE_OUTCOMES = ['success', 'failure', 'partial', 'skipped', 'timeout'];

const VALID_DETECTION_TYPES = ['detected', 'prevented', 'related'];

const schema_version = '1';

/**
 * Validate a feature telemetry event object.
 * @param {object} event - The event to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateFeatureEvent(event) {
  const errors = [];

  if (!event || typeof event !== 'object') {
    return { valid: false, errors: ['Event must be a non-null object'] };
  }

  // Required: feature_id
  if (!event.feature_id) {
    errors.push('Missing required field: feature_id');
  } else if (!FEATURE_IDS.includes(event.feature_id)) {
    errors.push(`Unknown feature_id: '${event.feature_id}'. Must be one of: ${FEATURE_IDS.join(', ')}`);
  }

  // Required: action
  if (!event.action) {
    errors.push('Missing required field: action');
  } else if (!FEATURE_ACTIONS.includes(event.action)) {
    errors.push(`Invalid action: '${event.action}'. Must be one of: ${FEATURE_ACTIONS.join(', ')}`);
  }

  // Required: session_id (non-empty string)
  if (event.session_id === undefined || event.session_id === null) {
    errors.push('Missing required field: session_id');
  } else if (typeof event.session_id !== 'string' || event.session_id.trim() === '') {
    errors.push('session_id must be a non-empty string');
  }

  // Required: timestamp (ISO 8601 string)
  if (!event.timestamp) {
    errors.push('Missing required field: timestamp');
  } else if (typeof event.timestamp !== 'string' || isNaN(Date.parse(event.timestamp))) {
    errors.push('timestamp must be a valid ISO 8601 string');
  }

  // Required: outcome
  if (!event.outcome) {
    errors.push('Missing required field: outcome');
  } else if (!FEATURE_OUTCOMES.includes(event.outcome)) {
    errors.push(`Invalid outcome: '${event.outcome}'. Must be one of: ${FEATURE_OUTCOMES.join(', ')}`);
  }

  // Required: duration_ms (non-negative number)
  if (event.duration_ms === undefined || event.duration_ms === null) {
    errors.push('Missing required field: duration_ms');
  } else if (typeof event.duration_ms !== 'number') {
    errors.push('duration_ms must be a number');
  } else if (!Number.isFinite(event.duration_ms)) {
    errors.push('duration_ms must be a finite number');
  } else if (event.duration_ms < 0) {
    errors.push('duration_ms must be non-negative');
  }

  // Optional: bug_link
  if (event.bug_link !== undefined && event.bug_link !== null) {
    if (typeof event.bug_link !== 'object') {
      errors.push('bug_link must be an object');
    } else {
      if (typeof event.bug_link.issue_url !== 'string' || event.bug_link.issue_url.trim() === '') {
        errors.push('bug_link.issue_url must be a non-empty string');
      }
      if (!event.bug_link.detection_type || !VALID_DETECTION_TYPES.includes(event.bug_link.detection_type)) {
        errors.push(`bug_link.detection_type must be one of: ${VALID_DETECTION_TYPES.join(', ')}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Convenience constructor for feature telemetry events.
 * Fills defaults for timestamp, user_id, schema_version.
 * Validates before returning; throws if invalid.
 * @param {object} fields - Partial event fields
 * @returns {object} Complete validated event
 */
function createFeatureEvent(fields) {
  const event = {
    schema_version,
    user_id: 'local',
    timestamp: new Date().toISOString(),
    ...fields,
  };

  const result = validateFeatureEvent(event);
  if (!result.valid) {
    throw new Error(`Invalid feature event: ${result.errors.join('; ')}`);
  }

  return event;
}

module.exports = {
  FEATURE_IDS,
  FEATURE_ACTIONS,
  FEATURE_OUTCOMES,
  validateFeatureEvent,
  createFeatureEvent,
  schema_version,
};

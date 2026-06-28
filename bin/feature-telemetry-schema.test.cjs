'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  FEATURE_IDS,
  FEATURE_ACTIONS,
  FEATURE_OUTCOMES,
  validateFeatureEvent,
  createFeatureEvent,
  schema_version,
} = require('./feature-telemetry-schema.cjs');

// Helper: create a minimal valid event
function validEvent(overrides = {}) {
  return {
    feature_id: 'formal_loop',
    action: 'complete',
    session_id: 'sess-001',
    timestamp: '2026-04-07T10:00:00.000Z',
    outcome: 'success',
    duration_ms: 1500,
    ...overrides,
  };
}

describe('feature-telemetry-schema', () => {

  describe('FEATURE_IDS', () => {
    it('is a non-empty array', () => {
      assert.ok(Array.isArray(FEATURE_IDS));
      assert.ok(FEATURE_IDS.length > 0);
    });

    it('contains formal_loop', () => {
      assert.ok(FEATURE_IDS.includes('formal_loop'));
    });

    it('contains quorum_consensus', () => {
      assert.ok(FEATURE_IDS.includes('quorum_consensus'));
    });
  });

  describe('FEATURE_ACTIONS', () => {
    it('includes start, complete, fail, skip', () => {
      assert.ok(FEATURE_ACTIONS.includes('start'));
      assert.ok(FEATURE_ACTIONS.includes('complete'));
      assert.ok(FEATURE_ACTIONS.includes('fail'));
      assert.ok(FEATURE_ACTIONS.includes('skip'));
    });
  });

  describe('FEATURE_OUTCOMES', () => {
    it('includes success, failure, partial, skipped, timeout', () => {
      assert.ok(FEATURE_OUTCOMES.includes('success'));
      assert.ok(FEATURE_OUTCOMES.includes('failure'));
      assert.ok(FEATURE_OUTCOMES.includes('partial'));
      assert.ok(FEATURE_OUTCOMES.includes('skipped'));
      assert.ok(FEATURE_OUTCOMES.includes('timeout'));
    });
  });

  describe('schema_version', () => {
    it('is string "1"', () => {
      assert.equal(schema_version, '1');
      assert.equal(typeof schema_version, 'string');
    });
  });

  describe('validateFeatureEvent', () => {
    it('returns valid for a complete valid event', () => {
      const result = validateFeatureEvent(validEvent());
      assert.deepEqual(result, { valid: true, errors: [] });
    });

    it('catches missing feature_id', () => {
      const evt = validEvent();
      delete evt.feature_id;
      const result = validateFeatureEvent(evt);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('feature_id')));
    });

    it('catches unknown feature_id', () => {
      const result = validateFeatureEvent(validEvent({ feature_id: 'nonexistent_feature' }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('Unknown feature_id')));
    });

    it('catches missing action', () => {
      const evt = validEvent();
      delete evt.action;
      const result = validateFeatureEvent(evt);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('action')));
    });

    it('catches invalid action value', () => {
      const result = validateFeatureEvent(validEvent({ action: 'explode' }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('Invalid action')));
    });

    it('catches missing session_id', () => {
      const evt = validEvent();
      delete evt.session_id;
      const result = validateFeatureEvent(evt);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('session_id')));
    });

    it('catches empty string session_id', () => {
      const result = validateFeatureEvent(validEvent({ session_id: '  ' }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('session_id')));
    });

    it('catches missing timestamp', () => {
      const evt = validEvent();
      delete evt.timestamp;
      const result = validateFeatureEvent(evt);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('timestamp')));
    });

    it('catches missing outcome', () => {
      const evt = validEvent();
      delete evt.outcome;
      const result = validateFeatureEvent(evt);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('outcome')));
    });

    it('catches invalid outcome value', () => {
      const result = validateFeatureEvent(validEvent({ outcome: 'unknown_outcome' }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('Invalid outcome')));
    });

    it('catches negative duration_ms', () => {
      const result = validateFeatureEvent(validEvent({ duration_ms: -100 }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('non-negative')));
    });

    it('catches non-number duration_ms', () => {
      const result = validateFeatureEvent(validEvent({ duration_ms: 'fast' }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('duration_ms must be a number')));
    });

    it('accepts valid bug_link', () => {
      const result = validateFeatureEvent(validEvent({
        bug_link: { issue_url: 'https://github.com/org/repo/issues/42', detection_type: 'detected' },
      }));
      assert.deepEqual(result, { valid: true, errors: [] });
    });

    it('catches bug_link with missing issue_url', () => {
      const result = validateFeatureEvent(validEvent({
        bug_link: { detection_type: 'detected' },
      }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('issue_url')));
    });

    it('catches bug_link with invalid detection_type', () => {
      const result = validateFeatureEvent(validEvent({
        bug_link: { issue_url: 'https://example.com/issue/1', detection_type: 'magic' },
      }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('detection_type')));
    });

    it('rejects NaN duration_ms', () => {
      const result = validateFeatureEvent(validEvent({ duration_ms: NaN }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('duration_ms')));
    });

    it('rejects Infinity duration_ms', () => {
      const result = validateFeatureEvent(validEvent({ duration_ms: Infinity }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('duration_ms')));
    });

    it('catches bug_link with whitespace-only issue_url', () => {
      const result = validateFeatureEvent(validEvent({
        bug_link: { issue_url: '   ', detection_type: 'detected' },
      }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('issue_url')));
    });
  });

  describe('createFeatureEvent', () => {
    it('returns valid event with defaults filled', () => {
      const evt = createFeatureEvent({
        feature_id: 'formal_loop',
        action: 'complete',
        session_id: 'sess-001',
        outcome: 'success',
        duration_ms: 1500,
      });
      assert.equal(evt.feature_id, 'formal_loop');
      assert.equal(evt.schema_version, '1');
      assert.equal(evt.user_id, 'local');
      assert.ok(evt.timestamp); // auto-filled
      const result = validateFeatureEvent(evt);
      assert.equal(result.valid, true);
    });

    it('throws on invalid input', () => {
      assert.throws(() => {
        createFeatureEvent({ feature_id: 'nonexistent' });
      }, /Invalid feature event/);
    });

    it('fills timestamp and user_id defaults', () => {
      const before = new Date().toISOString();
      const evt = createFeatureEvent({
        feature_id: 'debug_pipeline',
        action: 'start',
        session_id: 'sess-002',
        outcome: 'success',
        duration_ms: 500,
      });
      const after = new Date().toISOString();
      assert.equal(evt.user_id, 'local');
      assert.ok(evt.timestamp >= before);
      assert.ok(evt.timestamp <= after);
    });
  });
});

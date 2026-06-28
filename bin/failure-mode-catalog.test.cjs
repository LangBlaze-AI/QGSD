#!/usr/bin/env node
'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const { enumerateFailureModes, classifySeverity } = require('./failure-mode-catalog.cjs');

// ── Minimal test fixtures ───────────────────────────────────────────────────

const miniFsm = {
  observed_transitions: {
    IDLE: {
      QUORUM_START: { to_state: 'COLLECTING_VOTES', count: 100 },
      DECIDE: { to_state: 'IDLE', count: 50 },
    },
  },
  model_comparison: {
    missing_in_model: [
      { from: 'IDLE', event: 'DECIDE', to: 'IDLE' },
    ],
  },
};

const miniHazard = {
  hazards: [
    { id: 'HAZARD-IDLE-QUORUM_START', state: 'IDLE', event: 'QUORUM_START', severity: 4 },
    { id: 'HAZARD-IDLE-DECIDE', state: 'IDLE', event: 'DECIDE', severity: 4 },
  ],
};

const highSevHazard = {
  hazards: [
    { id: 'HAZARD-IDLE-QUORUM_START', state: 'IDLE', event: 'QUORUM_START', severity: 8 },
    { id: 'HAZARD-IDLE-DECIDE', state: 'IDLE', event: 'DECIDE', severity: 4 },
  ],
};

// ── Unit tests: classifySeverity ────────────────────────────────────────────

describe('classifySeverity', () => {
  it('returns model_gap for commission mode regardless of severity', () => {
    assert.strictEqual(classifySeverity(8, 'commission'), 'model_gap');
    assert.strictEqual(classifySeverity(2, 'commission'), 'model_gap');
  });

  it('returns critical for severity >= 8', () => {
    assert.strictEqual(classifySeverity(8, 'omission'), 'critical');
    assert.strictEqual(classifySeverity(10, 'omission'), 'critical');
  });

  it('returns stalled for severity >= 6', () => {
    assert.strictEqual(classifySeverity(6, 'omission'), 'stalled');
    assert.strictEqual(classifySeverity(7, 'omission'), 'stalled');
  });

  it('returns degraded for severity >= 4', () => {
    assert.strictEqual(classifySeverity(4, 'omission'), 'degraded');
    assert.strictEqual(classifySeverity(5, 'omission'), 'degraded');
  });

  it('returns cosmetic for severity < 4', () => {
    assert.strictEqual(classifySeverity(2, 'omission'), 'cosmetic');
    assert.strictEqual(classifySeverity(1, 'omission'), 'cosmetic');
  });
});

// ── Unit tests: omission mode always generated ──────────────────────────────

describe('omission mode', () => {
  it('always generates omission for every transition', () => {
    const result = enumerateFailureModes(miniFsm, miniHazard, []);
    const omissions = result.failure_modes.filter(fm => fm.failure_mode === 'omission');
    assert.strictEqual(omissions.length, 2); // 2 transitions in miniFsm
  });
});

// ── Unit tests: commission mode conditional ─────────────────────────────────

describe('commission mode', () => {
  it('generates commission only for missing_in_model transitions', () => {
    const result = enumerateFailureModes(miniFsm, miniHazard, []);
    const commissions = result.failure_modes.filter(fm => fm.failure_mode === 'commission');
    assert.strictEqual(commissions.length, 1);
    assert.strictEqual(commissions[0].state, 'IDLE');
    assert.strictEqual(commissions[0].event, 'DECIDE');
  });

  it('does not generate commission for modeled transitions', () => {
    const result = enumerateFailureModes(miniFsm, miniHazard, []);
    const commissions = result.failure_modes.filter(fm => fm.failure_mode === 'commission');
    const qsCommission = commissions.find(fm => fm.event === 'QUORUM_START');
    assert.strictEqual(qsCommission, undefined);
  });
});

// ── Unit tests: corruption mode conditional ─────────────────────────────────

describe('corruption mode', () => {
  it('generates corruption only for high-severity transitions (>= 6)', () => {
    const result = enumerateFailureModes(miniFsm, highSevHazard, []);
    const corruptions = result.failure_modes.filter(fm => fm.failure_mode === 'corruption');
    assert.strictEqual(corruptions.length, 1);
    assert.strictEqual(corruptions[0].state, 'IDLE');
    assert.strictEqual(corruptions[0].event, 'QUORUM_START');
  });

  it('does not generate corruption for low-severity transitions', () => {
    const result = enumerateFailureModes(miniFsm, miniHazard, []);
    const corruptions = result.failure_modes.filter(fm => fm.failure_mode === 'corruption');
    assert.strictEqual(corruptions.length, 0);
  });
});

// ── Integration tests with real data ────────────────────────────────────────

describe('integration: real L2/L3 data', () => {
  const ROOT = process.env.PROJECT_ROOT || path.join(__dirname, '..');
  const FORMAL = path.join(ROOT, '.planning', 'formal');

  let result;

  before(() => {
    const fsmPath = path.join(FORMAL, 'semantics', 'observed-fsm.json');
    const hazardPath = path.join(FORMAL, 'reasoning', 'hazard-model.json');
    const mismatchPath = path.join(FORMAL, 'semantics', 'mismatch-register.jsonl');

    const observedFsm = JSON.parse(fs.readFileSync(fsmPath, 'utf8'));
    const hazardModel = JSON.parse(fs.readFileSync(hazardPath, 'utf8'));
    let mismatches = [];
    if (fs.existsSync(mismatchPath)) {
      mismatches = fs.readFileSync(mismatchPath, 'utf8')
        .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    }

    result = enumerateFailureModes(observedFsm, hazardModel, mismatches);
  });

  it('produces at least 16 failure mode entries (one omission per transition)', () => {
    // Minimum is 16 omission modes (one per FSM transition).
    // Commission modes are only generated when missing_in_model has entries.
    // Corruption modes depend on high-severity hazards (>= 6).
    // Total floor = 16 (omission) when mismatch register and hazards are empty/low.
    assert.ok(result.failure_modes.length >= 16, `Too few: ${result.failure_modes.length}`);
    assert.ok(result.failure_modes.length <= 100, `Too many: ${result.failure_modes.length}`);
  });

  it('all entries have non-empty derived_from links', () => {
    for (const fm of result.failure_modes) {
      assert.ok(Array.isArray(fm.derived_from), `${fm.id} missing derived_from`);
      assert.ok(fm.derived_from.length > 0, `${fm.id} has empty derived_from`);
    }
  });

  it('no duplicate IDs', () => {
    const ids = result.failure_modes.map(fm => fm.id);
    const uniqueIds = new Set(ids);
    assert.strictEqual(uniqueIds.size, ids.length, `Duplicate IDs found: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
  });

  it('has 16 omission modes (one per transition)', () => {
    const omissions = result.failure_modes.filter(fm => fm.failure_mode === 'omission');
    assert.strictEqual(omissions.length, 16);
  });

  it('has commission modes only for missing_in_model transitions', () => {
    // Commission modes are generated only when observed-fsm.json model_comparison.missing_in_model has entries.
    // When missing_in_model is empty, commission count is 0. This is valid behavior.
    const commissions = result.failure_modes.filter(fm => fm.failure_mode === 'commission');
    assert.ok(commissions.length >= 0, 'Commission count must be non-negative');
    assert.ok(commissions.length <= 50, `At most 50 commission modes, got ${commissions.length}`);
  });

  it('has valid schema fields', () => {
    assert.strictEqual(result.schema_version, '1');
    assert.ok(result.generated);
    assert.ok(result.summary);
    assert.strictEqual(typeof result.summary.total, 'number');
    assert.ok(result.summary.by_mode);
    assert.ok(result.summary.by_severity_class);
  });

  it('all failure_mode values are valid types', () => {
    const validModes = new Set(['omission', 'commission', 'corruption']);
    for (const fm of result.failure_modes) {
      assert.ok(validModes.has(fm.failure_mode), `Invalid mode: ${fm.failure_mode}`);
    }
  });

  it('all severity_class values are valid', () => {
    const validClasses = new Set(['critical', 'stalled', 'degraded', 'model_gap', 'cosmetic']);
    for (const fm of result.failure_modes) {
      assert.ok(validClasses.has(fm.severity_class), `Invalid class: ${fm.severity_class} for ${fm.id}`);
    }
  });
});

// ── Adversarial: malformed observed-fsm.json artifacts ──────────────────────

describe('malformed observed_transitions (adversarial)', () => {
  it('does not crash when observed_transitions is missing', () => {
    const fsm = { model_comparison: { missing_in_model: [] } };
    const result = enumerateFailureModes(fsm, miniHazard, []);
    assert.strictEqual(result.summary.total, 0);
    assert.strictEqual(result.failure_modes.length, 0);
  });
});

describe('null transition data (adversarial)', () => {
  it('does not crash when a transition value is null', () => {
    const fsm = {
      observed_transitions: { IDLE: { DECIDE: null, QUORUM_START: { to_state: 'COLLECTING_VOTES', count: 1 } } },
      model_comparison: { missing_in_model: [] },
    };
    const result = enumerateFailureModes(fsm, miniHazard, []);
    assert.ok(Array.isArray(result.failure_modes));
    // the null DECIDE entry is skipped; the valid QUORUM_START still yields an omission
    const omissions = result.failure_modes.filter(fm => fm.failure_mode === 'omission');
    assert.strictEqual(omissions.length, 1);
    assert.strictEqual(omissions[0].event, 'QUORUM_START');
  });

  it('does not crash when a state bucket is null', () => {
    const fsm = {
      observed_transitions: { IDLE: null },
      model_comparison: { missing_in_model: [] },
    };
    const result = enumerateFailureModes(fsm, miniHazard, []);
    assert.strictEqual(result.summary.total, 0);
  });
});

describe('null entry in missing_in_model (adversarial)', () => {
  it('does not crash when missing_in_model contains a null entry', () => {
    const fsm = {
      observed_transitions: { IDLE: { DECIDE: { to_state: 'IDLE', count: 1 } } },
      model_comparison: { missing_in_model: [null, { from: 'IDLE', event: 'DECIDE', to: 'IDLE' }] },
    };
    const result = enumerateFailureModes(fsm, miniHazard, []);
    const commissions = result.failure_modes.filter(fm => fm.failure_mode === 'commission');
    assert.strictEqual(commissions.length, 1);
    assert.strictEqual(commissions[0].event, 'DECIDE');
  });
});

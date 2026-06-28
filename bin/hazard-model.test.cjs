#!/usr/bin/env node
'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const {
  computeSeverity,
  computeOccurrenceScore,
  computeDetectionScore,
  generateHazardModel,
} = require('./hazard-model.cjs');

// ── Unit tests: computeSeverity ─────────────────────────────────────────────

describe('computeSeverity', () => {
  it('returns 8 for DELIBERATING -> DECIDE (wrong verdict)', () => {
    assert.strictEqual(computeSeverity('DELIBERATING', 'DECIDE'), 8);
  });

  it('returns 6 for COLLECTING_VOTES -> VOTES_COLLECTED (stalled quorum)', () => {
    assert.strictEqual(computeSeverity('COLLECTING_VOTES', 'VOTES_COLLECTED'), 6);
  });

  it('returns 6 for non-DECIDED -> CIRCUIT_BREAK (workflow interruption)', () => {
    assert.strictEqual(computeSeverity('IDLE', 'CIRCUIT_BREAK'), 6);
    assert.strictEqual(computeSeverity('COLLECTING_VOTES', 'CIRCUIT_BREAK'), 6);
    assert.strictEqual(computeSeverity('DELIBERATING', 'CIRCUIT_BREAK'), 6);
  });

  it('returns 2 for DECIDED -> CIRCUIT_BREAK (DECIDED overrides event rule)', () => {
    assert.strictEqual(computeSeverity('DECIDED', 'CIRCUIT_BREAK'), 2);
  });

  it('returns 4 for IDLE -> QUORUM_START (degraded, can retry)', () => {
    assert.strictEqual(computeSeverity('IDLE', 'QUORUM_START'), 4);
  });

  it('returns 2 for DECIDED self-loops (already terminal)', () => {
    assert.strictEqual(computeSeverity('DECIDED', 'DECIDE'), 2);
    assert.strictEqual(computeSeverity('DECIDED', 'QUORUM_START'), 2);
    assert.strictEqual(computeSeverity('DECIDED', 'VOTES_COLLECTED'), 2);
  });

  it('returns 4 as default for unmatched transitions', () => {
    assert.strictEqual(computeSeverity('IDLE', 'DECIDE'), 4);
    assert.strictEqual(computeSeverity('IDLE', 'VOTES_COLLECTED'), 4);
    assert.strictEqual(computeSeverity('COLLECTING_VOTES', 'QUORUM_START'), 4);
    assert.strictEqual(computeSeverity('COLLECTING_VOTES', 'DECIDE'), 4);
  });
});

// ── Unit tests: computeOccurrenceScore ──────────────────────────────────────

describe('computeOccurrenceScore', () => {
  it('returns 10 for ratio > 80%', () => {
    assert.strictEqual(computeOccurrenceScore(300, 349), 10);
  });

  it('returns 8 for ratio > 50%', () => {
    assert.strictEqual(computeOccurrenceScore(200, 349), 8);
  });

  it('returns 6 for ratio > 20%', () => {
    assert.strictEqual(computeOccurrenceScore(100, 349), 6);
  });

  it('returns 4 for ratio > 5%', () => {
    assert.strictEqual(computeOccurrenceScore(25, 349), 4);
  });

  it('returns 2 for ratio > 0%', () => {
    assert.strictEqual(computeOccurrenceScore(3, 349), 2);
  });

  it('returns 1 for zero count', () => {
    assert.strictEqual(computeOccurrenceScore(0, 349), 1);
  });

  it('returns 1 for zero sessions', () => {
    assert.strictEqual(computeOccurrenceScore(100, 0), 1);
  });
});

// ── Unit tests: computeDetectionScore ───────────────────────────────────────

describe('computeDetectionScore', () => {
  const taxWithFormalism = {
    categories: {
      logic_violation: [
        { requirement_ids: ['STOP-01', 'STOP-02', 'SPEC-01'] },
        { requirement_ids: ['DETECT-01', 'DETECT-02'] },
        { requirement_ids: ['PLAN-01', 'PLAN-02', 'IMPR-01'] },
      ],
    },
  };

  const covWithTests = {
    requirements: {
      'STOP-01': { covered: true },
      'DETECT-01': { covered: true },
      'PLAN-01': { covered: true },
    },
  };

  it('returns 2 when both formalism AND tests exist', () => {
    // IDLE has STOP prefix, and STOP-01 is covered in both
    assert.strictEqual(computeDetectionScore('IDLE', 'QUORUM_START', taxWithFormalism, covWithTests), 2);
  });

  it('returns 4 when only formalism exists', () => {
    const covEmpty = { requirements: {} };
    assert.strictEqual(computeDetectionScore('IDLE', 'QUORUM_START', taxWithFormalism, covEmpty), 4);
  });

  it('returns 4 when only tests exist', () => {
    const taxEmpty = { categories: { logic_violation: [] } };
    assert.strictEqual(computeDetectionScore('IDLE', 'QUORUM_START', taxEmpty, covWithTests), 4);
  });

  it('returns 8 when neither formalism nor tests exist', () => {
    const taxEmpty = { categories: { logic_violation: [] } };
    const covEmpty = { requirements: {} };
    // Use a state/event combo that has no matching prefixes
    assert.strictEqual(computeDetectionScore('UNKNOWN_STATE', 'UNKNOWN_EVENT', taxEmpty, covEmpty), 8);
  });
});

// ── Unit tests: RPN computation ─────────────────────────────────────────────

describe('RPN computation', () => {
  it('computes S x O x D correctly', () => {
    // Use a minimal FSM to test
    const miniFsm = {
      observed_transitions: {
        IDLE: {
          QUORUM_START: { to_state: 'COLLECTING_VOTES', count: 300 },
        },
      },
    };
    const traceStats = { sessions: new Array(349) };
    const taxEmpty = { categories: { logic_violation: [] } };
    const covEmpty = { requirements: {} };

    const result = generateHazardModel(miniFsm, traceStats, taxEmpty, covEmpty);
    const hazard = result.hazards[0];

    // S=4 (IDLE->QUORUM_START), O=10 (300/349 > 80%), D=8 (no formalism or tests)
    assert.strictEqual(hazard.severity, 4);
    assert.strictEqual(hazard.occurrence, 10);
    assert.strictEqual(hazard.detection, 8);
    assert.strictEqual(hazard.rpn, 4 * 10 * 8);
  });
});

// ── Integration tests with real data ────────────────────────────────────────

describe('integration: real L2 data', () => {
  const ROOT = process.env.PROJECT_ROOT || path.join(__dirname, '..');
  const FORMAL = path.join(ROOT, '.planning', 'formal');

  let result;

  before(() => {
    const fsmPath = path.join(FORMAL, 'semantics', 'observed-fsm.json');
    const tracePath = path.join(FORMAL, 'evidence', 'trace-corpus-stats.json');
    const taxPath = path.join(FORMAL, 'evidence', 'failure-taxonomy.json');
    const covPath = path.join(FORMAL, 'unit-test-coverage.json');

    const observedFsm = JSON.parse(fs.readFileSync(fsmPath, 'utf8'));
    const traceStats = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
    const failureTaxonomy = JSON.parse(fs.readFileSync(taxPath, 'utf8'));
    const unitTestCoverage = fs.existsSync(covPath)
      ? JSON.parse(fs.readFileSync(covPath, 'utf8'))
      : { requirements: {} };

    result = generateHazardModel(observedFsm, traceStats, failureTaxonomy, unitTestCoverage);
  });

  it('produces 16 hazard entries (4 states x 4 events)', () => {
    assert.strictEqual(result.hazards.length, 16);
  });

  it('all entries have non-empty derived_from arrays', () => {
    for (const h of result.hazards) {
      assert.ok(Array.isArray(h.derived_from), `${h.id} missing derived_from`);
      assert.ok(h.derived_from.length > 0, `${h.id} has empty derived_from`);
    }
  });

  it('hazards are sorted by RPN descending', () => {
    for (let i = 1; i < result.hazards.length; i++) {
      assert.ok(
        result.hazards[i - 1].rpn >= result.hazards[i].rpn,
        `${result.hazards[i - 1].id} (${result.hazards[i - 1].rpn}) should be >= ${result.hazards[i].id} (${result.hazards[i].rpn})`
      );
    }
  });

  it('no RPN exceeds 1000', () => {
    for (const h of result.hazards) {
      assert.ok(h.rpn <= 1000, `${h.id} has RPN ${h.rpn} > 1000`);
    }
  });

  it('no RPN below 1', () => {
    for (const h of result.hazards) {
      assert.ok(h.rpn >= 1, `${h.id} has RPN ${h.rpn} < 1`);
    }
  });

  it('DECIDED self-loop transitions have low RPNs (severity=2)', () => {
    const decidedHazards = result.hazards.filter(h => h.state === 'DECIDED');
    for (const h of decidedHazards) {
      assert.strictEqual(h.severity, 2, `${h.id} should have severity 2 but got ${h.severity}`);
    }
  });

  it('not all RPNs cluster above 200 (score inflation check)', () => {
    const below200 = result.hazards.filter(h => h.rpn < 200);
    assert.ok(below200.length > 0, 'All RPNs >= 200 — likely score inflation');
  });

  it('has valid schema fields', () => {
    assert.strictEqual(result.schema_version, '1');
    assert.ok(result.generated);
    assert.strictEqual(result.methodology, 'FMEA (IEC 60812)');
    assert.ok(result.scoring_scale);
    assert.ok(result.summary);
    assert.strictEqual(typeof result.summary.total, 'number');
    assert.strictEqual(typeof result.summary.max_rpn, 'number');
    assert.strictEqual(typeof result.summary.critical_count, 'number');
    assert.strictEqual(typeof result.summary.high_count, 'number');
  });
});

// ── Adversarial hardening: malformed FSM (HM-1) ─────────────────────────────

describe('generateHazardModel — malformed FSM (HM-1)', () => {
  it('does not crash when observed_transitions is missing', () => {
    const result = generateHazardModel({}, { sessions: [] }, { categories: { logic_violation: [] } }, { requirements: {} });
    assert.strictEqual(result.hazards.length, 0);
    assert.strictEqual(result.summary.total, 0);
    assert.strictEqual(result.summary.max_rpn, 0);
  });

  it('does not crash when observed_transitions is null', () => {
    const result = generateHazardModel({ observed_transitions: null }, { sessions: [] }, { categories: { logic_violation: [] } }, { requirements: {} });
    assert.strictEqual(result.hazards.length, 0);
  });
});

// ── Adversarial hardening: corrupt transition data (HM-2) ───────────────────

describe('generateHazardModel — corrupt transition data (HM-2)', () => {
  it('skips null transition data without crashing', () => {
    const fsm = { observed_transitions: { IDLE: { QUORUM_START: null, VOTES_COLLECTED: { to_state: 'X', count: 10 } } } };
    const result = generateHazardModel(fsm, { sessions: new Array(349) }, { categories: { logic_violation: [] } }, { requirements: {} });
    // The valid transition still produces a hazard; the null one is skipped
    assert.strictEqual(result.hazards.length, 1);
    assert.strictEqual(result.hazards[0].event, 'VOTES_COLLECTED');
  });

  it('skips a state whose event map is null', () => {
    const fsm = { observed_transitions: { IDLE: null } };
    const result = generateHazardModel(fsm, { sessions: [] }, { categories: { logic_violation: [] } }, { requirements: {} });
    assert.strictEqual(result.hazards.length, 0);
  });
});

// ── Adversarial hardening: non-string requirement_ids (HM-3) ────────────────

describe('computeDetectionScore — non-string requirement_ids (HM-3)', () => {
  it('ignores non-string requirement ids without crashing', () => {
    const tax = { categories: { logic_violation: [ { requirement_ids: [123, 'STOP-01'] } ] } };
    const cov = { requirements: {} };
    // STOP-01 matches IDLE's STOP prefix -> formalism present, no tests -> 4
    assert.strictEqual(computeDetectionScore('IDLE', 'QUORUM_START', tax, cov), 4);
  });

  it('returns 8 when only non-string ids are present', () => {
    const tax = { categories: { logic_violation: [ { requirement_ids: [123, null] } ] } };
    const cov = { requirements: {} };
    assert.strictEqual(computeDetectionScore('IDLE', 'QUORUM_START', tax, cov), 8);
  });
});

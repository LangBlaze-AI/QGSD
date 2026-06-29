#!/usr/bin/env node
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const {
  generateRecipe,
  generateAllRecipes,
  buildInputSequence,
  buildExpectedOutcome,
  buildOracle,
  buildSetup,
  buildRiskContext,
  buildDerivedFrom,
} = require('./test-recipe-gen.cjs');

// ── Test fixtures ────────────────────────────────────────────────────────

const omissionFm = {
  id: 'FM-IDLE-QUORUM_START-OMISSION',
  state: 'IDLE',
  event: 'QUORUM_START',
  to_state: 'COLLECTING_VOTES',
  failure_mode: 'omission',
  description: 'Transition does not fire',
  effect: 'System stays in IDLE',
  severity_class: 'degraded',
  derived_from: [
    { layer: 'L2', artifact: 'semantics/observed-fsm.json', ref: 'observed_transitions.IDLE.QUORUM_START' },
    { layer: 'L3', artifact: 'reasoning/hazard-model.json', ref: 'hazards[id=HAZARD-IDLE-QUORUM_START]' },
  ],
};

const commissionFm = {
  id: 'FM-IDLE-DECIDE-COMMISSION',
  state: 'IDLE',
  event: 'DECIDE',
  to_state: 'IDLE',
  failure_mode: 'commission',
  description: 'Fires but not modeled',
  effect: 'Unmodeled transition',
  severity_class: 'model_gap',
  derived_from: [
    { layer: 'L2', artifact: 'semantics/observed-fsm.json', ref: 'model_comparison.missing_in_model' },
    { layer: 'L3', artifact: 'reasoning/hazard-model.json', ref: 'hazards[id=HAZARD-IDLE-DECIDE]' },
  ],
};

const corruptionFm = {
  id: 'FM-IDLE-CIRCUIT_BREAK-CORRUPTION',
  state: 'IDLE',
  event: 'CIRCUIT_BREAK',
  to_state: 'IDLE',
  failure_mode: 'corruption',
  description: 'Wrong target state',
  effect: 'Incorrect state',
  severity_class: 'stalled',
  derived_from: [
    { layer: 'L2', artifact: 'semantics/observed-fsm.json', ref: 'observed_transitions.IDLE.CIRCUIT_BREAK' },
    { layer: 'L3', artifact: 'reasoning/hazard-model.json', ref: 'hazards[id=HAZARD-IDLE-CIRCUIT_BREAK]' },
  ],
};

const hazardMap = new Map([
  ['IDLE-QUORUM_START', { state: 'IDLE', event: 'QUORUM_START', rpn: 80 }],
  ['IDLE-DECIDE', { state: 'IDLE', event: 'DECIDE', rpn: 80 }],
  ['IDLE-CIRCUIT_BREAK', { state: 'IDLE', event: 'CIRCUIT_BREAK', rpn: 120 }],
]);

const riskMap = new Map([
  ['IDLE-QUORUM_START', { state: 'IDLE', event: 'QUORUM_START', risk_tier: 'medium' }],
  ['IDLE-DECIDE', { state: 'IDLE', event: 'DECIDE', risk_tier: 'high' }],
  ['IDLE-CIRCUIT_BREAK', { state: 'IDLE', event: 'CIRCUIT_BREAK', risk_tier: 'high' }],
]);

// ── Unit tests ───────────────────────────────────────────────────────────

describe('test-recipe-gen', () => {

  describe('recipe construction per failure mode type', () => {

    it('builds omission recipe with state_assertion oracle', () => {
      const recipe = generateRecipe(omissionFm, hazardMap, riskMap);
      assert.equal(recipe.id, 'TR-FM-IDLE-QUORUM_START-OMISSION');
      assert.equal(recipe.failure_mode_id, omissionFm.id);
      assert.equal(recipe.setup.initial_state, 'IDLE');
      assert.equal(recipe.expected_outcome.final_state, 'COLLECTING_VOTES');
      assert.equal(recipe.oracle.type, 'state_assertion');
      assert.ok(recipe.oracle.check.includes('COLLECTING_VOTES'));
      assert.ok(recipe.oracle.failure_indicates.includes('Omission'));
    });

    it('builds commission recipe with guard_rejection oracle', () => {
      const recipe = generateRecipe(commissionFm, hazardMap, riskMap);
      assert.equal(recipe.id, 'TR-FM-IDLE-DECIDE-COMMISSION');
      assert.equal(recipe.expected_outcome.rejection, true);
      assert.equal(recipe.oracle.type, 'guard_rejection');
      assert.ok(recipe.oracle.check.includes('IDLE'));
      assert.ok(recipe.oracle.failure_indicates.includes('Commission'));
    });

    it('builds corruption recipe with state_equality oracle', () => {
      const recipe = generateRecipe(corruptionFm, hazardMap, riskMap);
      assert.equal(recipe.id, 'TR-FM-IDLE-CIRCUIT_BREAK-CORRUPTION');
      assert.equal(recipe.expected_outcome.final_state, 'IDLE');
      assert.equal(recipe.expected_outcome.not_state, 'any_other');
      assert.equal(recipe.oracle.type, 'state_equality');
      assert.ok(recipe.oracle.failure_indicates.includes('Corruption'));
    });
  });

  describe('oracle type matches failure mode type', () => {
    it('omission -> state_assertion', () => {
      assert.equal(buildOracle(omissionFm).type, 'state_assertion');
    });
    it('commission -> guard_rejection', () => {
      assert.equal(buildOracle(commissionFm).type, 'guard_rejection');
    });
    it('corruption -> state_equality', () => {
      assert.equal(buildOracle(corruptionFm).type, 'state_equality');
    });
  });

  describe('derived_from links', () => {
    it('includes failure-mode-catalog reference', () => {
      const refs = buildDerivedFrom(omissionFm);
      const fmRef = refs.find(r => r.artifact === 'reasoning/failure-mode-catalog.json');
      assert.ok(fmRef, 'Should have failure-mode-catalog reference');
      assert.ok(fmRef.ref.includes(omissionFm.id));
    });

    it('includes hazard-model reference when present', () => {
      const refs = buildDerivedFrom(omissionFm);
      const hmRef = refs.find(r => r.artifact === 'reasoning/hazard-model.json');
      assert.ok(hmRef, 'Should have hazard-model reference');
    });
  });

  describe('risk_context enrichment', () => {
    it('includes rpn from hazard-model', () => {
      const ctx = buildRiskContext(omissionFm, hazardMap, riskMap);
      assert.equal(ctx.rpn, 80);
    });

    it('includes risk_tier from risk-heatmap', () => {
      const ctx = buildRiskContext(omissionFm, hazardMap, riskMap);
      assert.equal(ctx.risk_tier, 'medium');
    });

    it('includes severity_class from failure mode', () => {
      const ctx = buildRiskContext(omissionFm, hazardMap, riskMap);
      assert.equal(ctx.severity_class, 'degraded');
    });
  });

  describe('summary counts', () => {
    it('produces correct summary totals', () => {
      const result = generateAllRecipes(
        [omissionFm, commissionFm, corruptionFm],
        [
          { state: 'IDLE', event: 'QUORUM_START', rpn: 80 },
          { state: 'IDLE', event: 'DECIDE', rpn: 80 },
          { state: 'IDLE', event: 'CIRCUIT_BREAK', rpn: 120 },
        ],
        [
          { state: 'IDLE', event: 'QUORUM_START', risk_tier: 'medium' },
          { state: 'IDLE', event: 'DECIDE', risk_tier: 'high' },
          { state: 'IDLE', event: 'CIRCUIT_BREAK', risk_tier: 'high' },
        ]
      );

      assert.equal(result.summary.total_recipes, 3);
      assert.equal(result.summary.by_failure_mode.omission, 1);
      assert.equal(result.summary.by_failure_mode.commission, 1);
      assert.equal(result.summary.by_failure_mode.corruption, 1);
      assert.equal(result.summary.by_risk_tier.medium, 1);
      assert.equal(result.summary.by_risk_tier.high, 2);
    });
  });

  describe('integration: real failure-mode-catalog', () => {
    it('produces valid output with recipe count matching failure_modes.length', () => {
      const ROOT = path.join(__dirname, '..');
      const fmPath = path.join(ROOT, '.planning', 'formal', 'reasoning', 'failure-mode-catalog.json');
      const hmPath = path.join(ROOT, '.planning', 'formal', 'reasoning', 'hazard-model.json');
      const rhPath = path.join(ROOT, '.planning', 'formal', 'reasoning', 'risk-heatmap.json');

      const fmData = JSON.parse(fs.readFileSync(fmPath, 'utf8'));
      const hmData = JSON.parse(fs.readFileSync(hmPath, 'utf8'));
      const rhData = JSON.parse(fs.readFileSync(rhPath, 'utf8'));

      const result = generateAllRecipes(
        fmData.failure_modes,
        hmData.hazards,
        rhData.transitions
      );

      // Dynamic assertion: recipes === failure_modes count
      assert.equal(result.recipes.length, fmData.failure_modes.length);
      assert.equal(result.summary.total_recipes, fmData.failure_modes.length);
      assert.equal(result.schema_version, '1');
      assert.ok(result.generated);
      assert.ok(result.source);

      // Every recipe has required fields
      for (const recipe of result.recipes) {
        assert.ok(recipe.id, `recipe missing id`);
        assert.ok(recipe.failure_mode_id, `recipe missing failure_mode_id`);
        assert.ok(recipe.setup, `recipe ${recipe.id} missing setup`);
        assert.ok(recipe.input_sequence, `recipe ${recipe.id} missing input_sequence`);
        assert.ok(recipe.expected_outcome, `recipe ${recipe.id} missing expected_outcome`);
        assert.ok(recipe.oracle, `recipe ${recipe.id} missing oracle`);
        assert.ok(recipe.risk_context, `recipe ${recipe.id} missing risk_context`);
        assert.ok(recipe.derived_from, `recipe ${recipe.id} missing derived_from`);
      }
    });
  });

  describe('edge cases', () => {
    it('handles missing hazard-model gracefully (rpn=null)', () => {
      const emptyHazardMap = new Map();
      const emptyRiskMap = new Map();
      const recipe = generateRecipe(omissionFm, emptyHazardMap, emptyRiskMap);
      assert.equal(recipe.risk_context.rpn, null);
      assert.equal(recipe.risk_context.risk_tier, null);
      assert.equal(recipe.risk_context.severity_class, 'degraded');
    });

    it('handles empty failure-mode-catalog (0 failure modes)', () => {
      const result = generateAllRecipes([], [], []);
      assert.equal(result.recipes.length, 0);
      assert.equal(result.summary.total_recipes, 0);
      assert.deepEqual(result.summary.by_failure_mode, {});
      assert.deepEqual(result.summary.by_risk_tier, {});
    });
  });

  describe('derived_from hardening', () => {
    it('does not throw when derived_from is a non-array object', () => {
      const fm = { ...omissionFm, derived_from: {} };
      let refs;
      assert.doesNotThrow(() => { refs = buildDerivedFrom(fm); });
      assert.equal(refs.length, 1);
      assert.equal(refs[0].artifact, 'reasoning/failure-mode-catalog.json');
    });

    it('does not throw when derived_from is a string', () => {
      const fm = { ...omissionFm, derived_from: 'reasoning/hazard-model.json' };
      assert.doesNotThrow(() => buildDerivedFrom(fm));
    });
  });

  describe('failureModes element hardening', () => {
    it('skips null/non-object entries without crashing', () => {
      let result;
      assert.doesNotThrow(() => {
        result = generateAllRecipes([omissionFm, null, 'bogus'], [], []);
      });
      assert.equal(result.recipes.length, 1);
      assert.equal(result.summary.total_recipes, 1);
      assert.equal(result.recipes[0].failure_mode_id, omissionFm.id);
    });
  });

  describe('hazards/riskTransitions hardening', () => {
    it('does not throw when hazards is a non-array object', () => {
      let result;
      assert.doesNotThrow(() => {
        result = generateAllRecipes([omissionFm], {}, []);
      });
      assert.equal(result.recipes.length, 1);
      assert.equal(result.recipes[0].risk_context.rpn, null);
    });

    it('does not throw when riskTransitions is a non-array object', () => {
      assert.doesNotThrow(() => generateAllRecipes([omissionFm], [], {}));
    });
  });
});

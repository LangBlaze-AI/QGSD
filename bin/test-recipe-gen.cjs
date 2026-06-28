#!/usr/bin/env node
'use strict';

/**
 * test-recipe-gen.cjs — Transform L3 failure modes into executable test recipe JSON.
 *
 * Reads failure-mode-catalog.json, hazard-model.json, and risk-heatmap.json
 * to produce test recipes with setup, input_sequence, expected_outcome,
 * oracle, risk_context, and derived_from for each failure mode.
 *
 * Requirements: RSN-04
 *
 * Usage:
 *   node bin/test-recipe-gen.cjs            # print summary to stdout
 *   node bin/test-recipe-gen.cjs --json     # print full results JSON to stdout
 */

const fs   = require('fs');
const path = require('path');

const ROOT = process.env.PROJECT_ROOT
  || (process.argv.find(a => a.startsWith('--project-root=')) || '').replace('--project-root=', '')
  || path.join(__dirname, '..');
const FORMAL = path.join(ROOT, '.planning', 'formal');
const REASONING_DIR = path.join(FORMAL, 'reasoning');
const OUT_DIR = path.join(FORMAL, 'test-recipes');
const OUT_FILE = path.join(OUT_DIR, 'test-recipes.json');

const JSON_FLAG = process.argv.includes('--json');

// ── Recipe builders ──────────────────────────────────────────────────────

function buildSetup(fm) {
  return {
    initial_state: fm.state,
    preconditions: [`Machine is in ${fm.state} state`],
  };
}

function buildInputSequence(fm) {
  return [
    {
      event: fm.event,
      description: `Send ${fm.event} event to machine in ${fm.state} state`,
    },
  ];
}

function buildExpectedOutcome(fm) {
  switch (fm.failure_mode) {
    case 'omission':
      return {
        final_state: fm.to_state,
        assertions: [`Machine transitions to ${fm.to_state}`],
      };
    case 'commission':
      return {
        rejection: true,
        assertions: [`Machine remains in ${fm.state}; event ${fm.event} is rejected`],
      };
    case 'corruption':
      return {
        final_state: fm.to_state,
        not_state: 'any_other',
        assertions: [`Machine transitions to exactly ${fm.to_state}, not any other state`],
      };
    default:
      return { final_state: fm.to_state, assertions: [] };
  }
}

function buildOracle(fm) {
  switch (fm.failure_mode) {
    case 'omission':
      return {
        type: 'state_assertion',
        check: `machine.state === '${fm.to_state}'`,
        failure_indicates: 'Omission: transition did not fire',
      };
    case 'commission':
      return {
        type: 'guard_rejection',
        check: `machine.state === '${fm.state}'`,
        failure_indicates: 'Commission: unmodeled event was accepted',
      };
    case 'corruption':
      return {
        type: 'state_equality',
        check: `machine.state === '${fm.to_state}'`,
        failure_indicates: 'Corruption: wrong target state reached',
      };
    default:
      return { type: 'unknown', check: '', failure_indicates: '' };
  }
}

function buildRiskContext(fm, hazardMap, riskMap) {
  const key = `${fm.state}-${fm.event}`;
  const hazard = hazardMap.get(key);
  const risk = riskMap.get(key);

  return {
    severity_class: fm.severity_class || null,
    rpn: hazard ? hazard.rpn : null,
    risk_tier: risk ? risk.risk_tier : null,
  };
}

function buildDerivedFrom(fm) {
  const refs = [
    {
      layer: 'L3',
      artifact: 'reasoning/failure-mode-catalog.json',
      ref: `failure_modes[id=${fm.id}]`,
    },
  ];

  // Add hazard-model reference if the failure mode has one
  if (Array.isArray(fm.derived_from)) {
    const hazardLink = fm.derived_from.find(
      d => d.artifact === 'reasoning/hazard-model.json'
    );
    if (hazardLink) {
      refs.push({
        layer: 'L3',
        artifact: hazardLink.artifact,
        ref: hazardLink.ref,
      });
    }
  }

  return refs;
}

function generateRecipe(fm, hazardMap, riskMap) {
  return {
    id: `TR-${fm.id}`,
    failure_mode_id: fm.id,
    title: `Test ${fm.failure_mode} of ${fm.state} --[${fm.event}]--> ${fm.to_state}`,
    setup: buildSetup(fm),
    input_sequence: buildInputSequence(fm),
    expected_outcome: buildExpectedOutcome(fm),
    oracle: buildOracle(fm),
    risk_context: buildRiskContext(fm, hazardMap, riskMap),
    derived_from: buildDerivedFrom(fm),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────

function generateAllRecipes(failureModes, hazards, riskTransitions) {
  // Build lookup maps by state-event key
  const hazardMap = new Map();
  for (const h of Array.isArray(hazards) ? hazards : []) {
    if (h && typeof h === 'object') hazardMap.set(`${h.state}-${h.event}`, h);
  }

  const riskMap = new Map();
  for (const t of Array.isArray(riskTransitions) ? riskTransitions : []) {
    if (t && typeof t === 'object') riskMap.set(`${t.state}-${t.event}`, t);
  }

  const recipes = (Array.isArray(failureModes) ? failureModes : [])
    .filter(fm => fm && typeof fm === 'object')
    .map(fm => generateRecipe(fm, hazardMap, riskMap));

  // Compute summary
  const byFailureMode = {};
  const byRiskTier = {};
  for (const r of recipes) {
    const fmType = r.oracle.type === 'state_assertion' ? 'omission'
      : r.oracle.type === 'guard_rejection' ? 'commission'
      : r.oracle.type === 'state_equality' ? 'corruption'
      : 'unknown';
    byFailureMode[fmType] = (byFailureMode[fmType] || 0) + 1;

    const tier = r.risk_context.risk_tier || 'unclassified';
    byRiskTier[tier] = (byRiskTier[tier] || 0) + 1;
  }

  return {
    schema_version: '1',
    generated: new Date().toISOString(),
    source: {
      failure_mode_catalog: 'reasoning/failure-mode-catalog.json',
      hazard_model: 'reasoning/hazard-model.json',
      risk_heatmap: 'reasoning/risk-heatmap.json',
    },
    recipes,
    summary: {
      total_recipes: recipes.length,
      by_failure_mode: byFailureMode,
      by_risk_tier: byRiskTier,
    },
  };
}

function main() {
  // Load failure-mode-catalog
  const fmPath = path.join(REASONING_DIR, 'failure-mode-catalog.json');
  if (!fs.existsSync(fmPath)) {
    console.error('ERROR: failure-mode-catalog.json not found at', fmPath);
    process.exit(1);
  }
  const fmData = JSON.parse(fs.readFileSync(fmPath, 'utf8'));
  const failureModes = fmData.failure_modes || [];

  // Load hazard-model (optional)
  let hazards = [];
  const hmPath = path.join(REASONING_DIR, 'hazard-model.json');
  if (fs.existsSync(hmPath)) {
    const hmData = JSON.parse(fs.readFileSync(hmPath, 'utf8'));
    hazards = hmData.hazards || [];
  }

  // Load risk-heatmap (optional)
  let riskTransitions = [];
  const rhPath = path.join(REASONING_DIR, 'risk-heatmap.json');
  if (fs.existsSync(rhPath)) {
    const rhData = JSON.parse(fs.readFileSync(rhPath, 'utf8'));
    riskTransitions = rhData.transitions || [];
  }

  const result = generateAllRecipes(failureModes, hazards, riskTransitions);

  // Write output
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2) + '\n');

  if (JSON_FLAG) {
    process.stdout.write(JSON.stringify(result));
  } else {
    console.log('Test Recipe Generator');
    console.log(`  Total recipes: ${result.summary.total_recipes}`);
    console.log(`  By failure mode: ${JSON.stringify(result.summary.by_failure_mode)}`);
    console.log(`  By risk tier: ${JSON.stringify(result.summary.by_risk_tier)}`);
    console.log(`  Output: ${OUT_FILE}`);
  }
}

if (require.main === module) main();

module.exports = {
  generateRecipe,
  generateAllRecipes,
  buildInputSequence,
  buildExpectedOutcome,
  buildOracle,
  buildSetup,
  buildRiskContext,
  buildDerivedFrom,
};

#!/usr/bin/env node
'use strict';

/**
 * risk-heatmap.cjs — Ranked risk transition list for Layer 3 (Reasoning).
 *
 * Combines FMEA RPN scores with L1/L2 coverage gap data to produce a
 * prioritized list of highest-risk transitions. Transitions not modeled
 * in XState receive a 50% risk penalty.
 *
 * Requirements: RSN-03
 *
 * Usage:
 *   node bin/risk-heatmap.cjs            # print summary to stdout
 *   node bin/risk-heatmap.cjs --json     # print full results JSON to stdout
 */

const fs   = require('fs');
const path = require('path');

const ROOT = process.env.PROJECT_ROOT || path.join(__dirname, '..');
const FORMAL = path.join(ROOT, '.planning', 'formal');
const REASONING_DIR = path.join(FORMAL, 'reasoning');
const OUT_FILE = path.join(REASONING_DIR, 'risk-heatmap.json');

const JSON_FLAG = process.argv.includes('--json');

// ── Risk tier classification ────────────────────────────────────────────────

function classifyRiskTier(riskScore) {
  if (riskScore >= 200) return 'critical';
  if (riskScore >= 100) return 'high';
  if (riskScore >= 40)  return 'medium';
  return 'low';
}

// ── Core computation ────────────────────────────────────────────────────────

/**
 * Compute composite risk score for a transition.
 * risk_score = RPN * (1 + coverage_gap_penalty)
 * coverage_gap_penalty = 0.5 if transition is in missing_in_model, else 0.0
 */
function computeRiskScore(rpn, hasCoverageGap) {
  const penalty = hasCoverageGap ? 0.5 : 0.0;
  return rpn * (1 + penalty);
}

function generateRiskHeatmap(hazardModel, observedFsm) {
  // Build set of missing_in_model transitions
  const missingInModel = new Set(
    (observedFsm?.model_comparison?.missing_in_model || [])
      .filter(m => m && typeof m === 'object')
      .map(m => `${m.from}-${m.event}`)
  );

  const transitions = [];

  for (const hazard of (hazardModel?.hazards || [])) {
    if (!hazard || typeof hazard !== 'object') continue;
    const key = `${hazard.state}-${hazard.event}`;
    const hasCoverageGap = missingInModel.has(key);
    const coverageGapPenalty = hasCoverageGap ? 0.5 : 0.0;
    const riskScore = computeRiskScore(hazard.rpn, hasCoverageGap);

    transitions.push({
      state: hazard.state,
      event: hazard.event,
      to_state: hazard.to_state,
      rpn: hazard.rpn,
      coverage_gap: hasCoverageGap,
      coverage_gap_penalty: coverageGapPenalty,
      risk_score: riskScore,
      risk_tier: classifyRiskTier(riskScore),
      derived_from: [
        { layer: 'L3', artifact: 'reasoning/hazard-model.json', ref: `hazards[id=${hazard.id}]` },
        { layer: 'L2', artifact: 'semantics/observed-fsm.json', ref: `observed_transitions.${hazard.state}.${hazard.event}` },
      ],
    });
  }

  // Sort by risk_score descending
  transitions.sort((a, b) => b.risk_score - a.risk_score);

  // Summary stats
  const byRiskTier = { critical: 0, high: 0, medium: 0, low: 0 };
  let coverageGapCount = 0;
  for (const t of transitions) {
    byRiskTier[t.risk_tier] = (byRiskTier[t.risk_tier] || 0) + 1;
    if (t.coverage_gap) coverageGapCount++;
  }

  return {
    schema_version: '1',
    generated: new Date().toISOString(),
    formula: 'risk_score = RPN * (1 + coverage_gap_penalty); coverage_gap_penalty = 0.5 if missing_in_model, else 0.0',
    risk_tiers: {
      critical: 'risk_score >= 200',
      high: '100 <= risk_score < 200',
      medium: '40 <= risk_score < 100',
      low: 'risk_score < 40',
    },
    transitions,
    summary: {
      total: transitions.length,
      by_risk_tier: byRiskTier,
      coverage_gap_count: coverageGapCount,
    },
  };
}

// ── Entry point ─────────────────────────────────────────────────────────────

function main() {
  // Load L3 hazard model
  const hazardPath = path.join(REASONING_DIR, 'hazard-model.json');
  if (!fs.existsSync(hazardPath)) {
    console.error('ERROR: hazard-model.json not found at', hazardPath);
    console.error('Run bin/hazard-model.cjs first.');
    process.exit(1);
  }
  const hazardModel = JSON.parse(fs.readFileSync(hazardPath, 'utf8'));

  // Load L2 observed FSM
  const fsmPath = path.join(FORMAL, 'semantics', 'observed-fsm.json');
  if (!fs.existsSync(fsmPath)) {
    console.error('ERROR: observed-fsm.json not found at', fsmPath);
    process.exit(1);
  }
  const observedFsm = JSON.parse(fs.readFileSync(fsmPath, 'utf8'));

  const output = generateRiskHeatmap(hazardModel, observedFsm);

  // Write output
  fs.mkdirSync(REASONING_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2) + '\n');

  if (JSON_FLAG) {
    process.stdout.write(JSON.stringify(output));
  } else {
    console.log(`Risk Heatmap`);
    console.log(`  Total transitions: ${output.summary.total}`);
    console.log(`  By risk tier: ${JSON.stringify(output.summary.by_risk_tier)}`);
    console.log(`  Coverage gaps: ${output.summary.coverage_gap_count}`);
    console.log(`  Output: ${OUT_FILE}`);
  }

  process.exit(0);
}

if (require.main === module) main();

module.exports = { computeRiskScore, classifyRiskTier, generateRiskHeatmap, main };

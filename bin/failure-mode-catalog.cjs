#!/usr/bin/env node
'use strict';

/**
 * failure-mode-catalog.cjs — Failure mode enumeration for Layer 3 (Reasoning).
 *
 * Enumerates concrete failure modes (omission, commission, corruption) per
 * L2 state-event pair. Uses hazard-model.json severity scores for corruption
 * thresholds and observed-fsm.json model_comparison for commission conditions.
 *
 * Requirements: RSN-02
 *
 * Usage:
 *   node bin/failure-mode-catalog.cjs            # print summary to stdout
 *   node bin/failure-mode-catalog.cjs --json     # print full results JSON to stdout
 */

const fs   = require('fs');
const path = require('path');

const ROOT = process.env.PROJECT_ROOT || path.join(__dirname, '..');
const FORMAL = path.join(ROOT, '.planning', 'formal');
const REASONING_DIR = path.join(FORMAL, 'reasoning');
const OUT_FILE = path.join(REASONING_DIR, 'failure-mode-catalog.json');

const JSON_FLAG = process.argv.includes('--json');

// ── Severity class mapping ──────────────────────────────────────────────────

function classifySeverity(severity, mode) {
  if (mode === 'commission') return 'model_gap';
  if (severity >= 8) return 'critical';
  if (severity >= 6) return 'stalled';
  if (severity >= 4) return 'degraded';
  if (severity >= 2) return 'cosmetic';
  return 'cosmetic';
}

// ── Failure mode descriptions ───────────────────────────────────────────────

function omissionDescription(fromState, event, toState) {
  return `Transition ${fromState} --[${event}]--> ${toState} does not fire when expected`;
}

function omissionEffect(fromState) {
  return `System stays in ${fromState}; expected state change does not occur`;
}

function commissionDescription(fromState, event, toState) {
  return `Transition ${fromState} --[${event}]--> ${toState} fires but is not modeled in XState`;
}

function commissionEffect(fromState, event, toState) {
  return `Unmodeled state transition from ${fromState} to ${toState} on ${event}; behavior diverges from spec`;
}

function corruptionDescription(fromState, event, toState) {
  return `Transition ${fromState} --[${event}]--> fires but produces wrong target state (not ${toState})`;
}

function corruptionEffect(fromState, toState) {
  return `System enters incorrect state instead of ${toState}; downstream behavior undefined`;
}

// ── Mismatch enrichment ─────────────────────────────────────────────────────

function findMismatches(fromState, event, mismatches) {
  return mismatches.filter(m => {
    // Mismatches have expected/actual states; match if the event context aligns
    // Since mismatches don't have from/event fields directly, we match on state overlap
    return m.expected_state === fromState || m.actual_state === fromState;
  });
}

// ── Core enumeration ────────────────────────────────────────────────────────

function enumerateFailureModes(observedFsm, hazardModel, mismatches) {
  const missingInModel = new Set(
    (observedFsm?.model_comparison?.missing_in_model || [])
      .filter(m => m && typeof m === 'object')
      .map(m => `${m.from}-${m.event}`)
  );

  // Build severity lookup from hazard model
  const severityMap = {};
  for (const h of (hazardModel?.hazards || [])) {
    severityMap[`${h.state}-${h.event}`] = h.severity;
  }

  const failureModes = [];

  for (const [fromState, events] of Object.entries(observedFsm?.observed_transitions || {})) {
    for (const [event, data] of Object.entries(events || {})) {
      if (!data || typeof data !== 'object') continue;
      const key = `${fromState}-${event}`;
      const severity = severityMap[key] || 4;
      const toState = data.to_state;
      const relMismatches = findMismatches(fromState, event, mismatches);
      const mismatchNote = relMismatches.length > 0
        ? ` (${relMismatches.length} observed mismatch(es): ${relMismatches.map(m => m.id).join(', ')})`
        : '';

      // 1. Omission (always)
      failureModes.push({
        id: `FM-${fromState}-${event}-OMISSION`,
        state: fromState,
        event,
        to_state: toState,
        failure_mode: 'omission',
        description: omissionDescription(fromState, event, toState) + mismatchNote,
        effect: omissionEffect(fromState),
        severity_class: classifySeverity(severity, 'omission'),
        derived_from: [
          { layer: 'L2', artifact: 'semantics/observed-fsm.json', ref: `observed_transitions.${fromState}.${event}` },
          { layer: 'L3', artifact: 'reasoning/hazard-model.json', ref: `hazards[id=HAZARD-${fromState}-${event}]` },
        ],
      });

      // 2. Commission (conditional: only if in missing_in_model)
      if (missingInModel.has(key)) {
        failureModes.push({
          id: `FM-${fromState}-${event}-COMMISSION`,
          state: fromState,
          event,
          to_state: toState,
          failure_mode: 'commission',
          description: commissionDescription(fromState, event, toState) + mismatchNote,
          effect: commissionEffect(fromState, event, toState),
          severity_class: classifySeverity(severity, 'commission'),
          derived_from: [
            { layer: 'L2', artifact: 'semantics/observed-fsm.json', ref: `model_comparison.missing_in_model` },
            { layer: 'L2', artifact: 'semantics/observed-fsm.json', ref: `observed_transitions.${fromState}.${event}` },
            { layer: 'L3', artifact: 'reasoning/hazard-model.json', ref: `hazards[id=HAZARD-${fromState}-${event}]` },
          ],
        });
      }

      // 3. Corruption (conditional: only if severity >= 6)
      if (severity >= 6) {
        failureModes.push({
          id: `FM-${fromState}-${event}-CORRUPTION`,
          state: fromState,
          event,
          to_state: toState,
          failure_mode: 'corruption',
          description: corruptionDescription(fromState, event, toState) + mismatchNote,
          effect: corruptionEffect(fromState, toState),
          severity_class: classifySeverity(severity, 'corruption'),
          derived_from: [
            { layer: 'L2', artifact: 'semantics/observed-fsm.json', ref: `observed_transitions.${fromState}.${event}` },
            { layer: 'L3', artifact: 'reasoning/hazard-model.json', ref: `hazards[id=HAZARD-${fromState}-${event}]` },
          ],
        });
      }
    }
  }

  // Count by mode and severity class
  const byMode = { omission: 0, commission: 0, corruption: 0 };
  const bySeverityClass = {};
  for (const fm of failureModes) {
    byMode[fm.failure_mode] = (byMode[fm.failure_mode] || 0) + 1;
    bySeverityClass[fm.severity_class] = (bySeverityClass[fm.severity_class] || 0) + 1;
  }

  return {
    schema_version: '1',
    generated: new Date().toISOString(),
    failure_modes: failureModes,
    summary: {
      total: failureModes.length,
      by_mode: byMode,
      by_severity_class: bySeverityClass,
    },
  };
}

// ── Entry point ─────────────────────────────────────────────────────────────

function main() {
  // Load L2 observed FSM
  const fsmPath = path.join(FORMAL, 'semantics', 'observed-fsm.json');
  if (!fs.existsSync(fsmPath)) {
    console.error('ERROR: observed-fsm.json not found at', fsmPath);
    process.exit(1);
  }
  const observedFsm = JSON.parse(fs.readFileSync(fsmPath, 'utf8'));

  // Load L3 hazard model (produced by hazard-model.cjs)
  const hazardPath = path.join(REASONING_DIR, 'hazard-model.json');
  if (!fs.existsSync(hazardPath)) {
    console.error('ERROR: hazard-model.json not found at', hazardPath);
    console.error('Run bin/hazard-model.cjs first.');
    process.exit(1);
  }
  const hazardModel = JSON.parse(fs.readFileSync(hazardPath, 'utf8'));

  // Load mismatch register
  const mismatchPath = path.join(FORMAL, 'semantics', 'mismatch-register.jsonl');
  let mismatches = [];
  if (fs.existsSync(mismatchPath)) {
    mismatches = fs.readFileSync(mismatchPath, 'utf8')
      .trim().split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  }

  const output = enumerateFailureModes(observedFsm, hazardModel, mismatches);

  // Write output
  fs.mkdirSync(REASONING_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2) + '\n');

  if (JSON_FLAG) {
    process.stdout.write(JSON.stringify(output));
  } else {
    console.log(`Failure Mode Catalog`);
    console.log(`  Total failure modes: ${output.summary.total}`);
    console.log(`  By mode: ${JSON.stringify(output.summary.by_mode)}`);
    console.log(`  By severity class: ${JSON.stringify(output.summary.by_severity_class)}`);
    console.log(`  Output: ${OUT_FILE}`);
  }

  process.exit(0);
}

if (require.main === module) main();

module.exports = { enumerateFailureModes, classifySeverity };

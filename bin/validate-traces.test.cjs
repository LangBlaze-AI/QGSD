'use strict';
// bin/validate-traces.test.cjs
// Unit tests (Wave 0) + integration tests (Plan 03) for the conformance event validator.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { spawnSync } = require('child_process');
const os   = require('os');
const path = require('path');

// Helper: write a temp NDJSON file and run validate-traces.cjs against it
function runValidator(ndjsonLines) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-test-'));
  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  if (ndjsonLines !== null) {
    const logFile = path.join(planningDir, 'conformance-events.jsonl');
    fs.writeFileSync(logFile, ndjsonLines.join('\n') + '\n', 'utf8');
  }
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'validate-traces.cjs')
  ], { cwd: tmpDir, encoding: 'utf8' });
  // Clean up temp dir
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return result;
}

test('schema module exports VALID_ACTIONS array', () => {
  const schema = require('../bin/conformance-schema.cjs');
  assert.ok(Array.isArray(schema.VALID_ACTIONS), 'VALID_ACTIONS should be an array');
  assert.ok(schema.VALID_ACTIONS.length > 0, 'VALID_ACTIONS should not be empty');
});

test('schema module exports VALID_PHASES array', () => {
  const schema = require('../bin/conformance-schema.cjs');
  assert.ok(Array.isArray(schema.VALID_PHASES), 'VALID_PHASES should be an array');
  assert.ok(schema.VALID_PHASES.includes('IDLE'), 'VALID_PHASES should include IDLE');
  assert.ok(schema.VALID_PHASES.includes('COLLECTING_VOTES'), 'VALID_PHASES should include COLLECTING_VOTES');
  assert.ok(schema.VALID_PHASES.includes('DELIBERATING'), 'VALID_PHASES should include DELIBERATING');
  assert.ok(schema.VALID_PHASES.includes('DECIDED'), 'VALID_PHASES should include DECIDED');
});

test('schema module exports VALID_OUTCOMES and schema_version', () => {
  const schema = require('../bin/conformance-schema.cjs');
  assert.ok(Array.isArray(schema.VALID_OUTCOMES), 'VALID_OUTCOMES should be an array');
  assert.strictEqual(typeof schema.schema_version, 'string', 'schema_version should be a string');
});

test('event shape has required fields', () => {
  const event = {
    ts: new Date().toISOString(),
    phase: 'IDLE',
    action: 'quorum_start',
    slots_available: 4,
    vote_result: null,
    outcome: null,
  };
  const keys = Object.keys(event);
  assert.ok(keys.includes('ts'), 'event must have ts');
  assert.ok(keys.includes('phase'), 'event must have phase');
  assert.ok(keys.includes('action'), 'event must have action');
  assert.ok(keys.includes('slots_available'), 'event must have slots_available');
  assert.ok(keys.includes('vote_result'), 'event must have vote_result');
  assert.ok(keys.includes('outcome'), 'event must have outcome');
});

test('deviation score formula: 3 valid of 4 total = 75.0%', () => {
  const score = (3 / 4 * 100).toFixed(1);
  assert.strictEqual(score, '75.0', 'deviation score formula should compute 75.0 for 3/4');
});

// ── Integration tests (Plan 03) ──────────────────────────────────────────────

test('exit code 0 when no log file exists', () => {
  const result = runValidator(null);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /No conformance log/);
});

test('exit code 0 on valid quorum_start trace', () => {
  const event = JSON.stringify({
    ts: new Date().toISOString(),
    phase: 'IDLE',
    action: 'quorum_start',
    slots_available: 4,
    vote_result: null,
    outcome: null,
    schema_version: '1',
  });
  const result = runValidator([event]);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /100\.0%/);
});

test('exit code 1 on unmappable action in trace', () => {
  const event = JSON.stringify({
    ts: new Date().toISOString(),
    phase: 'IDLE',
    action: 'unknown_action_xyz',
    slots_available: 4,
    vote_result: null,
    outcome: null,
    schema_version: '1',
  });
  const result = runValidator([event]);
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /divergence/i);
});

// ── Confidence Tier Tests (v0.19-04-02 RED phase) ────────────────────────────

test('validate-traces exports computeConfidenceTier and CONFIDENCE_THRESHOLDS', () => {
  const m = require('../bin/validate-traces.cjs');
  assert.strictEqual(typeof m.computeConfidenceTier, 'function', 'computeConfidenceTier should be a function');
  assert.ok(m.CONFIDENCE_THRESHOLDS, 'CONFIDENCE_THRESHOLDS should be exported');
});

test('computeConfidenceTier boundary: (0, 0) => low', () => {
  const { computeConfidenceTier } = require('../bin/validate-traces.cjs');
  assert.strictEqual(computeConfidenceTier(0, 0), 'low');
});

test('computeConfidenceTier boundary: (49, 2) => low', () => {
  const { computeConfidenceTier } = require('../bin/validate-traces.cjs');
  assert.strictEqual(computeConfidenceTier(49, 2), 'low');
});

test('computeConfidenceTier boundary: (50, 3) => low (below medium threshold)', () => {
  const { computeConfidenceTier } = require('../bin/validate-traces.cjs');
  assert.strictEqual(computeConfidenceTier(50, 3), 'low');
});

test('computeConfidenceTier boundary: (499, 13) => low (just below medium)', () => {
  const { computeConfidenceTier } = require('../bin/validate-traces.cjs');
  assert.strictEqual(computeConfidenceTier(499, 13), 'low');
});

test('computeConfidenceTier boundary: (500, 14) => medium (exact medium boundary)', () => {
  const { computeConfidenceTier } = require('../bin/validate-traces.cjs');
  assert.strictEqual(computeConfidenceTier(500, 14), 'medium');
});

test('computeConfidenceTier boundary: (501, 15) => medium', () => {
  const { computeConfidenceTier } = require('../bin/validate-traces.cjs');
  assert.strictEqual(computeConfidenceTier(501, 15), 'medium');
});

test('computeConfidenceTier boundary: (5000, 30) => medium (rounds OK but days < 90)', () => {
  const { computeConfidenceTier } = require('../bin/validate-traces.cjs');
  assert.strictEqual(computeConfidenceTier(5000, 30), 'medium');
});

test('computeConfidenceTier boundary: (9999, 89) => medium (just below high)', () => {
  const { computeConfidenceTier } = require('../bin/validate-traces.cjs');
  assert.strictEqual(computeConfidenceTier(9999, 89), 'medium');
});

test('computeConfidenceTier boundary: (10000, 90) => high (exact high boundary)', () => {
  const { computeConfidenceTier } = require('../bin/validate-traces.cjs');
  assert.strictEqual(computeConfidenceTier(10000, 90), 'high');
});

test('computeConfidenceTier boundary: (50000, 365) => high', () => {
  const { computeConfidenceTier } = require('../bin/validate-traces.cjs');
  assert.strictEqual(computeConfidenceTier(50000, 365), 'high');
});

test('CONFIDENCE_THRESHOLDS.medium.min_rounds === 500 and high.min_rounds === 10000', () => {
  const { CONFIDENCE_THRESHOLDS } = require('../bin/validate-traces.cjs');
  assert.strictEqual(CONFIDENCE_THRESHOLDS.medium.min_rounds, 500);
  assert.strictEqual(CONFIDENCE_THRESHOLDS.medium.min_days, 14);
  assert.strictEqual(CONFIDENCE_THRESHOLDS.high.min_rounds, 10000);
  assert.strictEqual(CONFIDENCE_THRESHOLDS.high.min_days, 90);
});

test('integration: divergence object contains confidence field for unmappable_action', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-vtrace-conf-test-'));
  const ndjsonPath = path.join(tmpDir, 'check-results.ndjson');
  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });

  const badEvent = JSON.stringify({
    ts: new Date().toISOString(),
    phase: 'IDLE',
    action: 'unknown_action_xyz',
    slots_available: 4,
    vote_result: null,
    outcome: null,
    schema_version: '1',
  });
  fs.writeFileSync(path.join(planningDir, 'conformance-events.jsonl'), badEvent + '\n', 'utf8');

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'validate-traces.cjs')],
    { cwd: tmpDir, encoding: 'utf8', env: { ...process.env, CHECK_RESULTS_PATH: ndjsonPath } }
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.strictEqual(result.status, 1);
  // The stdout should include the divergence with a confidence field
  assert.match(result.stdout, /confidence/i, 'divergence output should include confidence field');
});

// ── MCP field validation (MCPENV-03) ─────────────────────────────────────────
// Wave 0 failing tests. These MUST be in RED state before Plan 03 implements
// validateMCPMetadata in validate-traces.cjs.
// Ref: .planning/phases/v0.19-05-mcp-environment-model/v0.19-05-01-PLAN.md

test('validate-traces emits error for mcp_call missing request_id', () => {
  // mcp_call event without request_id — validator must reject it (MCPENV-03)
  const { validateMCPMetadata } = require('../bin/validate-traces.cjs');
  const event = { action: 'mcp_call', peer: 'codex-1', mcp_outcome: 'success', attempt: 1 }; // no request_id
  const result = validateMCPMetadata(event);
  assert.notStrictEqual(result, true, 'should return error array for mcp_call missing request_id');
  assert.ok(Array.isArray(result), 'result should be an array of errors');
  assert.ok(result.some(e => e.includes('request_id')), 'error should mention request_id');
});

test('validate-traces accepts mcp_call with all required fields', () => {
  // mcp_call event with all fields present — validator must accept it (MCPENV-03)
  const { validateMCPMetadata } = require('../bin/validate-traces.cjs');
  const event = { action: 'mcp_call', request_id: 'round1:codex-1:1', peer: 'codex-1', mcp_outcome: 'success', attempt: 1 };
  const result = validateMCPMetadata(event);
  assert.strictEqual(result, true, 'should return true for valid mcp_call event');
});

test('validate-traces ignores MCP metadata fields for non-mcp_call actions', () => {
  // quorum_start event without MCP fields — validator must not error (MCPENV-03)
  const { validateMCPMetadata } = require('../bin/validate-traces.cjs');
  const event = { action: 'quorum_start', slots_available: 4 }; // no MCP fields
  const result = validateMCPMetadata(event);
  assert.strictEqual(result, true, 'should return true for non-mcp_call events regardless of missing MCP fields');
});

// ── EVID-01 + EVID-02 Wave 0 RED Tests ───────────────────────────────────────
// These MUST FAIL before Plan 02 implements observation_window and v2.1 fields
// in validate-traces.cjs. They pass after Plan 02.
// Ref: .planning/phases/v0.20-05-evidence-confidence/v0.20-05-01-PLAN.md

// Helper: run validator and keep tmpDir for NDJSON inspection
function runValidatorKeepTmp(ndjsonLines) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-evid-test-'));
  const planningDir = path.join(tmpDir, '.planning');
  const formalDir   = path.join(tmpDir, '.planning', 'formal');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.mkdirSync(formalDir,   { recursive: true });
  if (ndjsonLines !== null) {
    const logFile = path.join(planningDir, 'conformance-events.jsonl');
    fs.writeFileSync(logFile, ndjsonLines.join('\n') + '\n', 'utf8');
  }
  const ndjsonPath = path.join(formalDir, 'check-results.ndjson');
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'validate-traces.cjs')
  ], {
    cwd: tmpDir,
    encoding: 'utf8',
    env: { ...process.env, CHECK_RESULTS_PATH: ndjsonPath },
  });
  // NOTE: tmpDir is NOT cleaned up — caller must do so after reading NDJSON
  result.tmpDir = tmpDir;
  return result;
}

// Helper: read last NDJSON record written by validate-traces.cjs
function getLastNDJSON(tmpDir) {
  const ndjsonPath = path.join(tmpDir, '.planning', 'formal', 'check-results.ndjson');
  if (!fs.existsSync(ndjsonPath)) return null;
  const lines = fs.readFileSync(ndjsonPath, 'utf8').split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return null;
  return JSON.parse(lines[lines.length - 1]);
}

// Helper: write scoreboard fixture to tmpDir
function writeScoreboard(tmpDir, rounds) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'quorum-scoreboard.json'),
    JSON.stringify({ rounds }),
    'utf8'
  );
}

const VALID_EVENT = JSON.stringify({ action: 'plan_phase', timestamp: new Date().toISOString() });

test('observation_window.window_start is ISO-8601 string', () => {
  const result = runValidatorKeepTmp([VALID_EVENT]);
  const record = getLastNDJSON(result.tmpDir);
  fs.rmSync(result.tmpDir, { recursive: true, force: true });
  assert.ok(record, 'NDJSON record must be written');
  assert.ok(record.observation_window, 'observation_window must be present');
  assert.match(record.observation_window.window_start, /^\d{4}-\d{2}-\d{2}T/, 'window_start must be ISO-8601');
});

test('observation_window.window_end is ISO-8601 string', () => {
  const result = runValidatorKeepTmp([VALID_EVENT]);
  const record = getLastNDJSON(result.tmpDir);
  fs.rmSync(result.tmpDir, { recursive: true, force: true });
  assert.ok(record, 'NDJSON record must be written');
  assert.ok(record.observation_window, 'observation_window must be present');
  assert.match(record.observation_window.window_end, /^\d{4}-\d{2}-\d{2}T/, 'window_end must be ISO-8601');
});

test('observation_window.n_traces is 0 without scoreboard', () => {
  const result = runValidatorKeepTmp([VALID_EVENT]);
  const record = getLastNDJSON(result.tmpDir);
  fs.rmSync(result.tmpDir, { recursive: true, force: true });
  assert.ok(record, 'NDJSON record must be written');
  assert.ok(record.observation_window, 'observation_window must be present');
  assert.strictEqual(record.observation_window.n_traces, 0, 'n_traces must be 0 when no scoreboard');
});

test('observation_window.n_events equals conformance log line count', () => {
  const events = [VALID_EVENT, VALID_EVENT, VALID_EVENT];
  const result = runValidatorKeepTmp(events);
  const record = getLastNDJSON(result.tmpDir);
  fs.rmSync(result.tmpDir, { recursive: true, force: true });
  assert.ok(record, 'NDJSON record must be written');
  assert.ok(record.observation_window, 'observation_window must be present');
  assert.strictEqual(record.observation_window.n_events, 3, 'n_events must equal conformance log line count');
});

test('observation_window.window_days is 0 without scoreboard', () => {
  const result = runValidatorKeepTmp([VALID_EVENT]);
  const record = getLastNDJSON(result.tmpDir);
  fs.rmSync(result.tmpDir, { recursive: true, force: true });
  assert.ok(record, 'NDJSON record must be written');
  assert.ok(record.observation_window, 'observation_window must be present');
  assert.strictEqual(record.observation_window.window_days, 0, 'window_days must be 0 when no scoreboard');
});

test('observation_window.window_days matches multi-day scoreboard span', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-evid-sb-test-'));
  const planningDir = path.join(tmpDir, '.planning');
  const formalDir   = path.join(tmpDir, '.planning', 'formal');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.mkdirSync(formalDir,   { recursive: true });
  // Write conformance event log
  fs.writeFileSync(path.join(planningDir, 'conformance-events.jsonl'), VALID_EVENT + '\n', 'utf8');
  // Write scoreboard with rounds 10 days apart
  writeScoreboard(tmpDir, [
    { date: '2026-01-01T00:00:00.000Z' },
    { date: '2026-01-11T00:00:00.000Z' },
  ]);
  const ndjsonPath = path.join(formalDir, 'check-results.ndjson');
  // Run with scoreboard present
  spawnSync(process.execPath, [
    path.join(__dirname, 'validate-traces.cjs')
  ], {
    cwd: tmpDir,
    encoding: 'utf8',
    env: { ...process.env, CHECK_RESULTS_PATH: ndjsonPath },
  });
  const record = getLastNDJSON(tmpDir);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.ok(record, 'NDJSON record must be written');
  assert.ok(record.observation_window, 'observation_window must be present');
  assert.strictEqual(record.observation_window.window_days, 10, 'window_days must equal 10 for a 10-day scoreboard span');
});

test('check_id is ci:conformance-traces', () => {
  const result = runValidatorKeepTmp([VALID_EVENT]);
  const record = getLastNDJSON(result.tmpDir);
  fs.rmSync(result.tmpDir, { recursive: true, force: true });
  assert.ok(record, 'NDJSON record must be written');
  assert.strictEqual(record.check_id, 'ci:conformance-traces', 'check_id must be ci:conformance-traces');
});

test('surface is ci', () => {
  const result = runValidatorKeepTmp([VALID_EVENT]);
  const record = getLastNDJSON(result.tmpDir);
  fs.rmSync(result.tmpDir, { recursive: true, force: true });
  assert.ok(record, 'NDJSON record must be written');
  assert.strictEqual(record.surface, 'ci', 'surface must be ci');
});

// ── buildTTrace unit tests (v0.21-02-02) ─────────────────────────────────────

test('buildTTrace: returns required TTrace fields', () => {
  const { buildTTrace } = require('../bin/validate-traces.cjs');
  const event = { action: 'quorum_complete', outcome: 'APPROVE', vote_result: 3, slots_available: 3 };
  const scoreboardMeta = { n_rounds: 5, window_days: 1 };
  // Pass walker=null and machine=null to test the structure without XState dependency
  const result = buildTTrace(event, 'DECIDED', 'DELIBERATING', 'state_mismatch', scoreboardMeta, 'low', null, null, [event]);
  assert.ok(result.event, 'event field required');
  assert.strictEqual(result.actualState, 'DECIDED');
  assert.strictEqual(result.expectedState, 'DELIBERATING');
  assert.strictEqual(result.divergenceType, 'state_mismatch');
  assert.strictEqual(result.confidence, 'low');
  assert.ok(result.observation_window, 'observation_window required');
  assert.ok(Array.isArray(result.guardEvaluations), 'guardEvaluations must be array');
});

test('buildTTrace: observation_window populated from scoreboardMeta', () => {
  const { buildTTrace } = require('../bin/validate-traces.cjs');
  const scoreboardMeta = { n_rounds: 42, window_days: 7 };
  const result = buildTTrace({}, 'A', 'B', 'state_mismatch', scoreboardMeta, 'medium', null, null, [{}]);
  assert.strictEqual(result.observation_window.n_rounds, 42);
  assert.strictEqual(result.observation_window.window_days, 7);
});

test('buildTTrace: fail-open when walker is null — guardEvaluations is empty array, event is NOT dropped', () => {
  const { buildTTrace } = require('../bin/validate-traces.cjs');
  // Standalone event (no round_id) with walker=null: must return a TTrace record, not null/undefined.
  // Silent data loss (returning null or skipping) is the bug this test prevents.
  const standaloneEvent = { action: 'quorum_complete' }; // no round_id
  const result = buildTTrace(standaloneEvent, 'DECIDED', 'DELIBERATING', 'state_mismatch',
    { n_rounds: 0, window_days: 0 }, 'low', null, null, [standaloneEvent]);
  assert.ok(result !== null && result !== undefined, 'Standalone event must not be silently dropped');
  assert.deepStrictEqual(result.guardEvaluations, [], 'guardEvaluations must be empty array when walker=null');
  assert.strictEqual(result.event, standaloneEvent, 'event field must preserve original event');
});

test('buildTTrace: standalone event (no round_id) produces TTrace with empty precedingEvents', () => {
  const { buildTTrace } = require('../bin/validate-traces.cjs');
  // When roundEvents = [event] (standalone), no preceding context is replayed.
  // The result is still a valid TTrace (no silent drop), and guardEvaluations may be empty.
  const event = { action: 'quorum_vote' }; // no round_id field
  const result = buildTTrace(event, 'COLLECTING_VOTES', 'DELIBERATING', 'state_mismatch',
    { n_rounds: 1, window_days: 0 }, 'low', null, null, [event]);
  assert.ok(typeof result === 'object' && result !== null, 'Must return TTrace object, not null');
  assert.strictEqual(result.actualState, 'COLLECTING_VOTES');
  assert.strictEqual(result.divergenceType, 'state_mismatch');
});

test('buildTTrace: validateMCPMetadata non-mcp_call event returns true', () => {
  const { validateMCPMetadata } = require('../bin/validate-traces.cjs');
  assert.strictEqual(validateMCPMetadata({ action: 'quorum_start' }), true);
});

test('mapToXStateEvent maps circuit_break to CIRCUIT_BREAK', () => {
  const lines = [
    JSON.stringify({ action: 'circuit_break', phase: 'IDLE', ts: Date.now(), session: 'test-cb' })
  ];
  const result = runValidator(lines);
  assert.strictEqual(result.status, 0, 'circuit_break trace should validate without divergence');
  assert.ok(!result.stdout.includes('unmappable_action'), 'should not report unmappable_action for circuit_break');
});

test('buildTTrace: exported and callable from module.exports', () => {
  const m = require('../bin/validate-traces.cjs');
  assert.strictEqual(typeof m.buildTTrace, 'function', 'buildTTrace must be exported');
});

// ── Quick-205: mapToXStateEvent expansion tests ───────────────────────────────

test('mapToXStateEvent: normalizes event.type when event.action is missing', () => {
  const { mapToXStateEvent } = require('../bin/validate-traces.cjs');
  const event = { type: 'quorum_fallback_t1_required', fanOutCount: 3 };
  const result = mapToXStateEvent(event);
  assert.deepStrictEqual(result, { type: 'QUORUM_START', slotsAvailable: 3 });
});

test('mapToXStateEvent: quorum_fallback_t1_required maps to QUORUM_START', () => {
  const { mapToXStateEvent } = require('../bin/validate-traces.cjs');
  const event = { action: 'quorum_fallback_t1_required', fanOutCount: 2 };
  const result = mapToXStateEvent(event);
  assert.deepStrictEqual(result, { type: 'QUORUM_START', slotsAvailable: 2 });
});

test('mapToXStateEvent: quorum_block_r3_2 maps to DECIDE/BLOCK', () => {
  const { mapToXStateEvent } = require('../bin/validate-traces.cjs');
  const event = { action: 'quorum_block_r3_2' };
  const result = mapToXStateEvent(event);
  assert.deepStrictEqual(result, { type: 'DECIDE', outcome: 'BLOCK' });
});

test('mapToXStateEvent: security_sweep returns null (not an FSM event)', () => {
  const { mapToXStateEvent } = require('../bin/validate-traces.cjs');
  const event = { action: 'security_sweep' };
  const result = mapToXStateEvent(event);
  assert.strictEqual(result, null);
});

test('expectedState: quorum_fallback_t1_required returns COLLECTING_VOTES', () => {
  const { expectedState } = require('../bin/validate-traces.cjs');
  const event = { action: 'quorum_fallback_t1_required' };
  assert.strictEqual(expectedState(event), 'COLLECTING_VOTES');
});

test('expectedState: quorum_block_r3_2 with non-IDLE phase returns null (H1 skip)', () => {
  const { expectedState } = require('../bin/validate-traces.cjs');
  const event = { action: 'quorum_block_r3_2', phase: 'DECIDING' };
  assert.strictEqual(expectedState(event), null);
});

test('exit code 0 on valid quorum_fallback_t1_required trace', () => {
  const event = JSON.stringify({
    type: 'quorum_fallback_t1_required',
    fanOutCount: 3,
    phase: 'IDLE',
    ts: new Date().toISOString(),
  });
  const result = runValidator([event]);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /100\.0%/);
});

test('exit code 0 on security_sweep trace (skipped, not divergent)', () => {
  const event = JSON.stringify({
    action: 'security_sweep',
    phase: 'IDLE',
    ts: new Date().toISOString(),
  });
  const result = runValidator([event]);
  assert.strictEqual(result.status, 0);
  assert.ok(!result.stdout.match(/divergence/i), 'security_sweep should not cause divergence');
});

// ── Adversarial hardening tests ───────────────────────────────────────────────

test('expectedState: returns null for null/undefined/non-object input (no crash)', () => {
  const { expectedState } = require('../bin/validate-traces.cjs');
  assert.doesNotThrow(() => expectedState(null), 'expectedState(null) must not throw');
  assert.strictEqual(expectedState(null), null);
  assert.strictEqual(expectedState(undefined), null);
  assert.strictEqual(expectedState('quorum_start'), null);
});

test('validate-traces does not misclassify a valid `null` JSON line as a parse error', () => {
  const result = runValidator(['null']);
  assert.strictEqual(result.status, 1, 'a null event line is a schema violation -> exit 1');
  assert.ok(!/Cannot set properties of null/.test(result.stdout),
    'must not surface a strict-mode property-set TypeError as a json_parse_error');
  assert.ok(!/json_parse_error/.test(result.stdout),
    'a syntactically valid JSON line must not be reported as a parse error');
});

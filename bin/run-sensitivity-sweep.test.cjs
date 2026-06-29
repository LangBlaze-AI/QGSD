#!/usr/bin/env node
'use strict';
// bin/run-sensitivity-sweep.test.cjs
// Wave 0 RED tests for SENS-01, SENS-02, SENS-03.
// Requirements: SENS-01, SENS-02, SENS-03

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TOOL_PATH   = path.join(__dirname, 'run-sensitivity-sweep.cjs');
const REPORT_PATH = path.join(__dirname, 'sensitivity-report.cjs');
const PLAN_PHASE_PATH = path.join(
  os.homedir(), '.claude', 'nf', 'workflows', 'plan-phase.md'
);

/**
 * Run run-sensitivity-sweep.cjs in an isolated tmp dir with PATH stripped.
 * Passes SENSITIVITY_REPORT_PATH pointing into tmpDir.
 */
function runSweep(extraEnv) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sens-test-'));
  fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });
  const ndjsonOut = path.join(tmpDir, '.planning', 'formal', 'sensitivity-report.ndjson');
  const result = spawnSync(process.execPath, [TOOL_PATH], {
    cwd: tmpDir,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ...(extraEnv || {}),
      SENSITIVITY_REPORT_PATH: ndjsonOut,
      PATH: '/nonexistent:' + (process.env.PATH || ''),
    },
  });
  return { tmpDir, ndjsonOut, result };
}

// Test 1: syntax check
test('run-sensitivity-sweep.cjs loads without syntax errors (SENS-01)', () => {
  const result = spawnSync(process.execPath, ['--check', TOOL_PATH], { encoding: 'utf8' });
  assert.strictEqual(
    result.status, 0,
    'node --check must exit 0 (file must exist and be valid JS): ' + (result.stderr || result.error)
  );
});

// Test 2: graceful degradation — exit 0 when TLC and PRISM not in PATH
test('run-sensitivity-sweep.cjs exits 0 when TLC and PRISM not in PATH (SENS-01)', () => {
  const { tmpDir, result } = runSweep({});
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.strictEqual(
    result.status, 0,
    'must exit 0 even when TLC/PRISM missing: ' + (result.stderr || result.error)
  );
});

// Test 3: writes records to sensitivity-report.ndjson when tools absent
test('run-sensitivity-sweep.cjs writes records to sensitivity-report.ndjson (SENS-01)', () => {
  const { tmpDir, ndjsonOut, result } = runSweep({});
  let ndjson = '';
  if (fs.existsSync(ndjsonOut)) {
    ndjson = fs.readFileSync(ndjsonOut, 'utf8');
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.ok(
    ndjson.includes('result'),
    'sensitivity-report.ndjson must contain records with a result field'
  );
  assert.ok(
    ndjson.includes('parameter') || ndjson.includes('sens:'),
    'records must include parameter metadata or sens: check_id prefix'
  );
});

// Test 4: sweeps ≥2 parameters with ≥3 values each
test('run-sensitivity-sweep.cjs sweeps ≥2 parameters with ≥3 values each (SENS-01)', () => {
  const { tmpDir, ndjsonOut, result } = runSweep({});
  let records = [];
  if (fs.existsSync(ndjsonOut)) {
    const lines = fs.readFileSync(ndjsonOut, 'utf8').trim().split('\n').filter(l => l.trim());
    records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // Extract unique parameters
  const paramMap = {};
  for (const r of records) {
    const p = r.metadata && r.metadata.parameter;
    if (p) {
      if (!paramMap[p]) paramMap[p] = [];
      paramMap[p].push(r.metadata.value);
    }
  }
  const uniqueParams = Object.keys(paramMap);

  assert.ok(
    uniqueParams.length >= 2,
    'must sweep at least 2 parameters, got: ' + uniqueParams.length + ' (' + uniqueParams.join(', ') + ')'
  );
  for (const param of uniqueParams) {
    assert.ok(
      paramMap[param].length >= 3,
      'parameter ' + param + ' must have ≥3 values, got: ' + paramMap[param].length
    );
  }
});

// Test 5: records include metadata.parameter and metadata.value
test('run-sensitivity-sweep.cjs records include metadata.parameter and metadata.value (SENS-01)', () => {
  const { tmpDir, ndjsonOut, result } = runSweep({});
  let records = [];
  if (fs.existsSync(ndjsonOut)) {
    const lines = fs.readFileSync(ndjsonOut, 'utf8').trim().split('\n').filter(l => l.trim());
    records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.ok(records.length > 0, 'must write at least one record');
  assert.ok(
    records.every(r => r.metadata && 'parameter' in r.metadata),
    'all records must have metadata.parameter'
  );
  assert.ok(
    records.every(r => r.metadata && 'value' in r.metadata),
    'all records must have metadata.value'
  );
});

// Test 6: sensitivity-report.cjs generates .planning/formal/sensitivity-report.md
test('sensitivity-report.cjs generates .planning/formal/sensitivity-report.md (SENS-03)', () => {
  // Create a sample sensitivity-report.ndjson to feed to the report generator
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sens-report-test-'));
  fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });

  const sampleNdjsonPath = path.join(tmpDir, '.planning', 'formal', 'sensitivity-report.ndjson');
  const sampleMdPath = path.join(tmpDir, '.planning', 'formal', 'sensitivity-report.md');

  const sampleRecord = JSON.stringify({
    tool: 'run-sensitivity-sweep',
    formalism: 'tla',
    result: 'inconclusive',
    timestamp: new Date().toISOString(),
    check_id: 'sens:tla-maxsize',
    surface: 'sensitivity',
    property: 'TLA+ quorum size sweep',
    runtime_ms: 1,
    summary: 'inconclusive: no-tlc',
    triage_tags: ['no-tlc'],
    metadata: { parameter: 'MaxSize', value: 1, baseline: 3, baseline_result: null, delta: 'unknown' },
  });
  fs.writeFileSync(sampleNdjsonPath, sampleRecord + '\n', 'utf8');

  const result = spawnSync(process.execPath, [REPORT_PATH], {
    cwd: tmpDir,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      SENSITIVITY_REPORT_PATH: sampleNdjsonPath,
      SENSITIVITY_MD_PATH: sampleMdPath,
    },
  });

  const mdExists = fs.existsSync(sampleMdPath);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.ok(
    mdExists,
    'sensitivity-report.cjs must generate .planning/formal/sensitivity-report.md (file not found): exit=' +
    result.status + ' stderr=' + (result.stderr || '') + ' error=' + (result.error || '')
  );
});

// Test 8 (RSS-1): baseline_result and delta resolved against baseline
test('records resolve baseline_result and delta against the baseline (prism baseline 0.85 must not stay unknown) (SENS-01)', () => {
  const { tmpDir, ndjsonOut } = runSweep({});
  let records = [];
  if (fs.existsSync(ndjsonOut)) {
    const lines = fs.readFileSync(ndjsonOut, 'utf8').trim().split('\n').filter(l => l.trim());
    records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const prism = records.filter(r => r.formalism === 'prism');
  assert.ok(prism.length >= 3, 'expected >=3 prism records, got ' + prism.length);
  assert.ok(
    prism.every(r => r.metadata && r.metadata.baseline_result !== null),
    'prism baseline_result must be resolved (baseline 0.85 is not a swept value, so it must be evaluated explicitly) — got null'
  );
  assert.ok(
    prism.every(r => r.metadata && r.metadata.delta !== 'unknown'),
    'prism delta must be computed against baseline, not left as "unknown"'
  );
});

// Test 9 (RSS-2): exits 0 even when report path is unwritable
test('run-sensitivity-sweep.cjs exits 0 even when report path is unwritable (always-exit-0 contract) (SENS-01)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sens-unwritable-'));
  // Point the report path at an existing directory -> appendFileSync throws EISDIR
  const dirAsReport = path.join(tmpDir, 'report-dir');
  fs.mkdirSync(dirAsReport, { recursive: true });
  const result = spawnSync(process.execPath, [TOOL_PATH], {
    cwd: tmpDir,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      SENSITIVITY_REPORT_PATH: dirAsReport,
      PATH: '/nonexistent:' + (process.env.PATH || ''),
    },
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.strictEqual(
    result.status, 0,
    'must exit 0 even when report path is unwritable (graceful degradation): ' + (result.stderr || result.error)
  );
});

// Test 7: plan-phase.md step 8.3 exists and references run-sensitivity-sweep.cjs
test('plan-phase.md step 8.3 exists and references run-sensitivity-sweep.cjs (SENS-02)', () => {
  assert.ok(
    fs.existsSync(PLAN_PHASE_PATH),
    'plan-phase.md must exist at: ' + PLAN_PHASE_PATH
  );
  const src = fs.readFileSync(PLAN_PHASE_PATH, 'utf8');
  assert.ok(
    src.includes('run-sensitivity-sweep.cjs'),
    'plan-phase.md must reference run-sensitivity-sweep.cjs (SENS-02) — add in Plan 04'
  );
  assert.ok(
    src.includes('8.3') || src.includes('SENSITIVITY_CONTEXT'),
    'plan-phase.md must include step 8.3 or SENSITIVITY_CONTEXT injection (SENS-02)'
  );
});

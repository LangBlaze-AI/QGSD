#!/usr/bin/env node
'use strict';
// bin/run-sensitivity-sweep.cjs
// Sensitivity sweep: varies key model parameters and records outcome deltas.
// Requirements: SENS-01
//
// Usage:
//   node bin/run-sensitivity-sweep.cjs
//   SENSITIVITY_REPORT_PATH=/path/to/file.ndjson node bin/run-sensitivity-sweep.cjs
//
// Outputs to .planning/formal/sensitivity-report.ndjson (separate from check-results.ndjson).
// Graceful degradation: if TLC/PRISM not found, records inconclusive results.
// Always exits 0.

const { spawnSync } = require('child_process');
const JAVA_HEAP_MAX = process.env.NF_JAVA_HEAP_MAX || '512m';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const TAG = '[run-sensitivity-sweep]';

const REPORT_PATH = process.env.SENSITIVITY_REPORT_PATH ||
  path.join(__dirname, '..', '.planning', 'formal', 'sensitivity-report.ndjson');

// ── Tool location helpers ────────────────────────────────────────────────────

function locateTLC() {
  const { resolveTlaJar } = require('./resolve-formal-tools.cjs');
  return resolveTlaJar();
}

const { resolvePrismBin: locatePRISM } = require('./resolve-prism-bin.cjs');

// ── Sweep runners ────────────────────────────────────────────────────────────

function runTLCSweep(maxSize) {
  const startMs = Date.now();
  const tlcJar = locateTLC();
  if (!tlcJar) {
    return {
      result: 'inconclusive',
      runtime_ms: Date.now() - startMs,
      summary: 'inconclusive: tla2tools.jar not found — install TLC to run sweep',
      triage_tags: ['no-tlc'],
    };
  }

  // Write temp cfg with MaxSize override
  const baseCfgPath = path.join(__dirname, '..', '.planning', 'formal', 'tla', 'MCsafety.cfg');
  if (!fs.existsSync(baseCfgPath)) {
    return {
      result: 'inconclusive',
      runtime_ms: Date.now() - startMs,
      summary: 'inconclusive: MCsafety.cfg not found',
      triage_tags: ['missing-cfg'],
    };
  }

  const tmpCfg = path.join(os.tmpdir(), 'sens-mcsafety-' + maxSize + '-' + Date.now() + '.cfg');
  const baseCfg = fs.readFileSync(baseCfgPath, 'utf8');
  const overrideCfg = baseCfg.replace(/MaxSize\s*=\s*\d+/, 'MaxSize = ' + maxSize);
  fs.writeFileSync(tmpCfg, overrideCfg, 'utf8');

  const tlaFile = path.join(__dirname, '..', '.planning', 'formal', 'tla', 'NFQuorum.tla');
  // Use a fixed metadir so TLC overwrites state files instead of creating timestamped dirs
  const metaDir = path.join(__dirname, '..', '.planning', 'formal', 'tla', 'states', 'current');
  fs.rmSync(metaDir, { recursive: true, force: true });
  fs.mkdirSync(metaDir, { recursive: true });

  process.stderr.write('[heap] Xms=64m Xmx=' + JAVA_HEAP_MAX + '\n');
  const javaResult = spawnSync('java', [
    '-Xms64m', '-Xmx' + JAVA_HEAP_MAX,
    '-jar', tlcJar,
    '-metadir', metaDir,
    '-config', tmpCfg,
    tlaFile,
  ], { encoding: 'utf8', timeout: 120000 });

  try { fs.unlinkSync(tmpCfg); } catch (_) {}

  const runtimeMs = Date.now() - startMs;

  if (javaResult.error) {
    return {
      result: 'inconclusive',
      runtime_ms: runtimeMs,
      summary: 'inconclusive: TLC launch error — ' + javaResult.error.message,
      triage_tags: ['tlc-error'],
    };
  }

  const passed = javaResult.status === 0;
  return {
    result: passed ? 'pass' : 'fail',
    runtime_ms: runtimeMs,
    summary: (passed ? 'pass' : 'fail') + ': TLA+ MCsafety MaxSize=' + maxSize + ' in ' + runtimeMs + 'ms',
    triage_tags: [],
  };
}

function runPRISMSweep(tpRate) {
  const startMs = Date.now();
  const prismBin = locatePRISM();
  if (!prismBin) {
    return {
      result: 'inconclusive',
      runtime_ms: Date.now() - startMs,
      summary: 'inconclusive: prism binary not found — install PRISM to run sweep',
      triage_tags: ['no-prism'],
    };
  }

  const modelPath = path.join(__dirname, '..', '.planning', 'formal', 'prism', 'quorum.pm');
  if (!fs.existsSync(modelPath)) {
    return {
      result: 'inconclusive',
      runtime_ms: Date.now() - startMs,
      summary: 'inconclusive: .planning/formal/prism/quorum.pm not found',
      triage_tags: ['missing-model'],
    };
  }

  const prismResult = spawnSync(prismBin, [
    modelPath, '-pf', 'P=? [ F s=1 ]',
    '-const', 'tp_rate=' + tpRate,
  ], { encoding: 'utf8', timeout: 60000 });

  const runtimeMs = Date.now() - startMs;

  if (prismResult.error) {
    return {
      result: 'inconclusive',
      runtime_ms: runtimeMs,
      summary: 'inconclusive: PRISM launch error — ' + prismResult.error.message,
      triage_tags: ['prism-error'],
    };
  }

  const passed = prismResult.status === 0;
  return {
    result: passed ? 'pass' : 'fail',
    runtime_ms: runtimeMs,
    summary: (passed ? 'pass' : 'fail') + ': PRISM quorum tp_rate=' + tpRate + ' in ' + runtimeMs + 'ms',
    triage_tags: [],
  };
}

// ── Parameter sweep definitions (SENS-01: ≥2 parameters, ≥3 values each) ────

const SWEEP_PARAMS = [
  {
    name: 'MaxSize',
    description: 'TLA+ quorum size (N slots required for consensus)',
    model: 'tla',
    values: [1, 2, 3],
    baseline: 3,
    run: runTLCSweep,
  },
  {
    name: 'tp_rate',
    description: 'PRISM slot approval probability (P(slot votes APPROVE | available))',
    model: 'prism',
    values: [0.5, 0.75, 0.95],
    baseline: 0.85,
    run: runPRISMSweep,
  },
];

// ── Record writer ─────────────────────────────────────────────────────────────

function writeRecord(record) {
  fs.appendFileSync(REPORT_PATH, JSON.stringify(record) + '\n', 'utf8');
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  // Ensure output directory exists
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });

  for (const param of SWEEP_PARAMS) {
    process.stderr.write(TAG + ' Sweeping ' + param.name + ': ' + param.values.join(', ') + '\n');

    // Evaluate the baseline once up front so deltas are meaningful regardless of
    // value ordering AND when the baseline isn't itself a swept value
    // (e.g. prism baseline 0.85 is not in [0.5, 0.75, 0.95]).
    const baselineOutcome = param.run(param.baseline);
    const baselineResult = baselineOutcome.result;

    for (const value of param.values) {
      const outcome = value === param.baseline ? baselineOutcome : param.run(value);

      const delta = outcome.result === baselineResult
        ? 'stable'
        : 'flip-to-' + outcome.result;

      const record = {
        tool: 'run-sensitivity-sweep',
        formalism: param.model,
        result: outcome.result,
        timestamp: new Date().toISOString(),
        check_id: 'sens:' + param.model + '-' + param.name.toLowerCase().replace(/_/g, '-'),
        surface: 'sensitivity',
        property: param.description + ' sweep',
        runtime_ms: outcome.runtime_ms,
        summary: outcome.summary,
        triage_tags: outcome.triage_tags || [],
        metadata: {
          parameter: param.name,
          value: value,
          baseline: param.baseline,
          baseline_result: baselineResult,
          delta: delta,
        },
      };

      writeRecord(record);
      process.stderr.write(
        TAG + '  ' + param.name + '=' + value + ' → ' + outcome.result + ' (' + delta + ')\n'
      );
    }
  }

  process.stderr.write(TAG + ' Sweep complete. Written to: ' + REPORT_PATH + '\n');
}

try {
  main();
} catch (err) {
  process.stderr.write(TAG + ' WARN sweep aborted: ' + (err && err.message ? err.message : String(err)) + '\n');
  process.exit(0);
}

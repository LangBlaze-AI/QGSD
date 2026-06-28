'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'bin', 'analyze-state-space.cjs');
const REPORT_PATH = path.join(__dirname, '..', '.planning', 'formal', 'state-space-report.json');

/**
 * Run analyze-state-space.cjs with given args and return { stdout, stderr, status }.
 */
function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    timeout: 30000,
  });
}

/**
 * Run with --json and parse the result.
 */
let _cachedReport = null;
function getReport() {
  if (_cachedReport) return _cachedReport;
  const result = run('--json');
  assert.strictEqual(result.status, 0, 'analyze-state-space.cjs should exit 0, stderr: ' + result.stderr);
  _cachedReport = JSON.parse(result.stdout);
  return _cachedReport;
}

// ── Basic Execution ─────────────────────────────────────────────────────────

describe('basic execution', () => {
  test('exits with code 0 and produces valid JSON', () => {
    const result = run('--json');
    assert.strictEqual(result.status, 0, 'Expected exit code 0, got ' + result.status + '. stderr: ' + result.stderr);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); }, 'stdout should be valid JSON');
    assert.ok(parsed, 'Parsed JSON should be truthy');
  });

  test('prints summary to stdout in default mode', () => {
    const result = run();
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('[analyze-state-space]'), 'stdout should include TAG prefix');
    assert.ok(result.stdout.includes('Analyzed'), 'stdout should include "Analyzed"');
    assert.ok(result.stdout.includes('MINIMAL:'), 'stdout should include risk breakdown');
  });
});

// ── Report Structure ────────────────────────────────────────────────────────

describe('report structure', () => {
  test('has top-level keys: metadata, models, summary', () => {
    const report = getReport();
    assert.ok(report.metadata, 'report should have metadata');
    assert.ok(report.models, 'report should have models');
    assert.ok(report.summary, 'report should have summary');
  });

  test('metadata has required fields', () => {
    const meta = getReport().metadata;
    assert.ok(meta.generated_at, 'metadata should have generated_at');
    assert.strictEqual(meta.generator, 'analyze-state-space', 'generator should be analyze-state-space');
    assert.strictEqual(meta.version, '1.0', 'version should be 1.0');
    assert.ok(meta.thresholds, 'metadata should have thresholds');
    assert.strictEqual(typeof meta.thresholds.MINIMAL, 'number');
    assert.strictEqual(typeof meta.thresholds.LOW, 'number');
    assert.strictEqual(typeof meta.thresholds.MODERATE, 'number');
  });

  test('summary has required fields', () => {
    const summary = getReport().summary;
    assert.strictEqual(typeof summary.total_models, 'number');
    assert.ok(summary.by_risk, 'summary should have by_risk');
    assert.strictEqual(typeof summary.unbounded_count, 'number');
    assert.strictEqual(typeof summary.models_without_cfg, 'number');
  });
});

// ── Risk Classification ─────────────────────────────────────────────────────

describe('risk classification', () => {
  test('QGSDQuorum_xstate.tla is HIGH risk', () => {
    const models = getReport().models;
    const xstate = models['.planning/formal/tla/QGSDQuorum_xstate.tla'];
    assert.ok(xstate, 'QGSDQuorum_xstate.tla should be in models');
    assert.strictEqual(xstate.risk_level, 'HIGH', 'xstate should be HIGH risk');
    assert.strictEqual(xstate.has_unbounded, true, 'xstate should have unbounded domains');
    assert.ok(xstate.unbounded_domains.length > 0, 'xstate should have non-empty unbounded_domains');
    // Check that at least one unbounded domain mentions Nat
    const hasNat = xstate.unbounded_domains.some(function(d) { return d.includes('Nat'); });
    assert.ok(hasNat, 'xstate unbounded_domains should mention Nat');
  });

  test('all models have required fields', () => {
    const models = getReport().models;
    const validRisks = ['MINIMAL', 'LOW', 'MODERATE', 'HIGH'];
    for (const [file, model] of Object.entries(models)) {
      assert.strictEqual(typeof model.module_name, 'string', file + ' should have module_name string');
      assert.ok(Array.isArray(model.variables), file + ' should have variables array');
      assert.ok(validRisks.includes(model.risk_level), file + ' should have valid risk_level, got: ' + model.risk_level);
      assert.strictEqual(typeof model.has_unbounded, 'boolean', file + ' should have boolean has_unbounded');
    }
  });

  test('risk distribution sums to total_models', () => {
    const summary = getReport().summary;
    const sum = summary.by_risk.MINIMAL + summary.by_risk.LOW + summary.by_risk.MODERATE + summary.by_risk.HIGH;
    assert.strictEqual(sum, summary.total_models, 'Risk distribution should sum to total_models');
  });

  test('unbounded_count matches models with has_unbounded === true', () => {
    const report = getReport();
    let count = 0;
    for (const model of Object.values(report.models)) {
      if (model.has_unbounded) count++;
    }
    assert.strictEqual(count, report.summary.unbounded_count, 'unbounded_count should match actual count');
  });

  test('bounded models have positive estimated_states', () => {
    const models = getReport().models;
    for (const [file, model] of Object.entries(models)) {
      if (!model.has_unbounded && model.estimated_states !== null) {
        assert.ok(model.estimated_states > 0, file + ' should have positive estimated_states when bounded and resolvable');
      }
    }
  });
});

// ── Constant Parsing ────────────────────────────────────────────────────────

describe('constant parsing', () => {
  test('model with .cfg CONSTANTS has parsed constants', () => {
    const models = getReport().models;
    // QGSDQuorum.tla uses MCsafety.cfg which has MaxDeliberation=9, MaxSize=3
    const quorum = models['.planning/formal/tla/QGSDQuorum.tla'];
    if (quorum && quorum.constants && quorum.constants.length > 0) {
      // At least one constant should have a numeric value
      const hasNumeric = quorum.constants.some(function(c) { return typeof c.value === 'number'; });
      assert.ok(hasNumeric, 'QGSDQuorum constants should include numeric values from .cfg');
    }
  });

  test('models with bounded ranges have finite estimated_states', () => {
    const models = getReport().models;
    // QGSDCircuitBreaker has 2 BOOLEAN vars = 4 states
    const breaker = models['.planning/formal/tla/QGSDCircuitBreaker.tla'];
    if (breaker) {
      assert.strictEqual(breaker.risk_level, 'MINIMAL', 'QGSDCircuitBreaker should be MINIMAL risk');
      assert.ok(breaker.estimated_states !== null && breaker.estimated_states > 0,
        'QGSDCircuitBreaker should have computable states');
    }
  });
});

// ── CLI Modes ───────────────────────────────────────────────────────────────

describe('CLI modes', () => {
  test('--quiet mode suppresses stdout', () => {
    const result = run('--quiet');
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim(), '', '--quiet should produce no stdout');
  });

  test('file write mode creates report file', () => {
    // Remove existing report if any
    if (fs.existsSync(REPORT_PATH)) {
      fs.unlinkSync(REPORT_PATH);
    }
    const result = run();
    assert.strictEqual(result.status, 0);
    assert.ok(fs.existsSync(REPORT_PATH), 'state-space-report.json should exist after default run');
    const content = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
    assert.ok(content.models, 'Written report should have models');
    assert.ok(content.summary, 'Written report should have summary');
  });

  test('--json mode outputs to stdout only', () => {
    // Remove report file first
    if (fs.existsSync(REPORT_PATH)) {
      fs.unlinkSync(REPORT_PATH);
    }
    const result = run('--json');
    assert.strictEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.models, '--json output should have models');
    // In --json mode, file should NOT be written
    assert.ok(!fs.existsSync(REPORT_PATH), '--json should not write report file');
  });
});

// ── Cross-Model Decomposition (DECOMP-05) ───────────────────────────────────

describe('cross-model decomposition', () => {
  test('report has cross_model top-level key', () => {
    const report = getReport();
    assert.ok(report.cross_model, 'report should have cross_model key');
    assert.ok(report.cross_model.budget, 'cross_model should have budget');
    assert.ok(Array.isArray(report.cross_model.pairs), 'cross_model should have pairs array');
    assert.ok(report.cross_model.summary, 'cross_model should have summary');
  });

  test('budget has expected fields', () => {
    const budget = getReport().cross_model.budget;
    assert.strictEqual(budget.max_tlc_seconds, 300, 'Budget should be 5 minutes (300s)');
    assert.strictEqual(budget.throughput_states_per_sec, 10000, 'Throughput should be 10,000 states/sec');
    assert.strictEqual(budget.max_merged_states, 3000000, 'Max merged states should be 3,000,000');
  });

  test('pairs have required fields', () => {
    const pairs = getReport().cross_model.pairs;
    for (const pair of pairs) {
      assert.ok(pair.model_a, 'pair should have model_a');
      assert.ok(pair.model_b, 'pair should have model_b');
      assert.ok(pair.model_a < pair.model_b, 'model_a should sort before model_b: ' + pair.model_a + ' vs ' + pair.model_b);
      assert.ok(Array.isArray(pair.shared_source_files), 'pair should have shared_source_files array');
      assert.ok(Array.isArray(pair.shared_requirement_prefixes), 'pair should have shared_requirement_prefixes array');
      assert.ok(Array.isArray(pair.shared_requirements), 'pair should have shared_requirements array');
      assert.ok(pair.shared_source_files.length > 0 || pair.shared_requirement_prefixes.length > 0,
        'pair should have shared sources or prefixes: ' + pair.model_a + ' + ' + pair.model_b);
      assert.ok(['merge', 'interface-contract'].includes(pair.recommendation),
        'recommendation should be merge or interface-contract, got: ' + pair.recommendation);
      assert.ok(typeof pair.rationale === 'string' && pair.rationale.length > 0,
        'rationale should be non-empty string');
    }
  });

  test('summary totals match pair count', () => {
    const cm = getReport().cross_model;
    const total = cm.summary.merge_recommended + cm.summary.interface_contract_needed;
    assert.strictEqual(total, cm.summary.total_pairs_analyzed,
      'merge + interface-contract should equal total pairs');
    assert.strictEqual(cm.pairs.length, cm.summary.total_pairs_analyzed,
      'pairs array length should match total_pairs_analyzed');
  });

  test('DETECT prefix models are paired', () => {
    // QGSDCircuitBreaker (DETECT-01..03) and QGSDOscillation (DETECT-04..06)
    // share the DETECT prefix
    const pairs = getReport().cross_model.pairs;
    const detectPair = pairs.find(function(p) {
      return p.shared_requirement_prefixes.includes('DETECT');
    });
    assert.ok(detectPair, 'Should find a pair sharing DETECT prefix');
    assert.ok(
      (detectPair.model_a.includes('CircuitBreaker') && detectPair.model_b.includes('Oscillation')) ||
      (detectPair.model_a.includes('Oscillation') && detectPair.model_b.includes('CircuitBreaker')),
      'DETECT pair should be CircuitBreaker + Oscillation'
    );
  });

  test('merge recommendation applies when merged states within budget', () => {
    const pairs = getReport().cross_model.pairs;
    for (const pair of pairs) {
      if (pair.estimated_merged_states !== null && pair.estimated_merged_states <= 3000000) {
        assert.strictEqual(pair.recommendation, 'merge',
          'Pair with ' + pair.estimated_merged_states + ' states should recommend merge');
      }
    }
  });

  test('interface-contract applies when merged states exceed budget or null', () => {
    const pairs = getReport().cross_model.pairs;
    for (const pair of pairs) {
      if (pair.estimated_merged_states === null || pair.estimated_merged_states > 3000000) {
        assert.strictEqual(pair.recommendation, 'interface-contract',
          'Pair with states=' + pair.estimated_merged_states + ' should recommend interface-contract');
      }
    }
  });

  test('cross-model analysis does not alter existing report sections', () => {
    const report = getReport();
    // Verify existing sections still present and valid
    assert.ok(report.metadata, 'metadata should still exist');
    assert.ok(report.models, 'models should still exist');
    assert.ok(report.summary, 'summary should still exist');
    assert.strictEqual(report.metadata.generator, 'analyze-state-space');
    assert.strictEqual(typeof report.summary.total_models, 'number');
  });
});

// ── Exported analyzeModel() — adversarial input ──────────────────────────────

describe('analyzeModel exported API — adversarial input', () => {
  const { analyzeModel } = require(path.join(__dirname, '..', 'bin', 'analyze-state-space.cjs'));

  test('missing projectRoot fails open instead of throwing', () => {
    let result;
    assert.doesNotThrow(() => { result = analyzeModel('MCsafety'); },
      'analyzeModel with no projectRoot should not throw');
    assert.ok(result && typeof result === 'object', 'should return an object');
    assert.ok(['MINIMAL', 'LOW', 'MODERATE', 'HIGH'].includes(result.risk_level),
      'should return a valid conservative risk_level, got: ' + (result && result.risk_level));
    assert.strictEqual(result.has_unbounded, false, 'conservative default has_unbounded should be false');
    assert.strictEqual(result.estimated_states, null, 'conservative default estimated_states should be null');
  });

  test('null / non-string projectRoot fails open', () => {
    assert.doesNotThrow(() => analyzeModel('MCsafety', null), 'null projectRoot should not throw');
    assert.doesNotThrow(() => analyzeModel('MCsafety', 123), 'numeric projectRoot should not throw');
    const r = analyzeModel('MCsafety', null);
    assert.strictEqual(r.risk_level, 'MODERATE', 'invalid projectRoot should yield MODERATE conservative default');
  });
});

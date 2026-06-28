'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'bin', 'check-coverage-guard.cjs');

/**
 * Create a synthetic matrix JSON string with a given coverage percentage.
 */
function createMatrix(coveragePct, coveredCount, totalReqs) {
  return JSON.stringify({
    metadata: { generated_at: new Date().toISOString(), generator_version: '1.1' },
    coverage_summary: {
      total_requirements: totalReqs,
      covered_count: coveredCount,
      coverage_percentage: coveragePct,
      uncovered_requirements: [],
      orphan_properties: [],
    },
    requirements: {},
    properties: {},
    bidirectional_validation: { asymmetric_links: [], stale_links: [], summary: { total_checked: 0, asymmetric_count: 0, stale_count: 0, clean: true } },
  }, null, 2);
}

/**
 * Run check-coverage-guard.cjs with env overrides and given args.
 */
function run(matrixPath, baselinePath, ...extraArgs) {
  return spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    timeout: 10000,
    env: {
      ...process.env,
      COVERAGE_GUARD_MATRIX_PATH: matrixPath,
      COVERAGE_GUARD_BASELINE_PATH: baselinePath,
    },
  });
}

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-guard-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Save Baseline ──────────────────────────────────────────────────────────

describe('save baseline', () => {
  test('--save-baseline creates file and exits 0', () => {
    const matrixPath = path.join(tmpDir, 'matrix.json');
    const baselinePath = path.join(tmpDir, 'baseline.json');
    fs.writeFileSync(matrixPath, createMatrix(27, 57, 211));

    const result = run(matrixPath, baselinePath, '--save-baseline');
    assert.strictEqual(result.status, 0, 'should exit 0');
    assert.ok(fs.existsSync(baselinePath), 'baseline file should be created');
    assert.ok(result.stdout.includes('Baseline saved'), 'should confirm baseline saved');
    assert.ok(result.stdout.includes('27%'), 'should show coverage percentage');
  });
});

// ── No Baseline ────────────────────────────────────────────────────────────

describe('no baseline', () => {
  test('auto-creates baseline and exits 0', () => {
    const matrixPath = path.join(tmpDir, 'matrix.json');
    const baselinePath = path.join(tmpDir, 'baseline.json');
    fs.writeFileSync(matrixPath, createMatrix(27, 57, 211));

    const result = run(matrixPath, baselinePath);
    assert.strictEqual(result.status, 0, 'should exit 0');
    assert.ok(fs.existsSync(baselinePath), 'baseline file should be auto-created');
    assert.ok(result.stdout.includes('No baseline found'), 'should report auto-creation');
    assert.ok(result.stdout.includes('PASS'), 'should report PASS');
  });
});

// ── No Regression ──────────────────────────────────────────────────────────

describe('no regression', () => {
  test('same coverage exits 0 with PASS', () => {
    const matrixPath = path.join(tmpDir, 'matrix.json');
    const baselinePath = path.join(tmpDir, 'baseline.json');
    fs.writeFileSync(matrixPath, createMatrix(27, 57, 211));
    fs.writeFileSync(baselinePath, createMatrix(27, 57, 211));

    const result = run(matrixPath, baselinePath);
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('PASS'));
    assert.ok(result.stdout.includes('No regression'));
  });

  test('coverage improved exits 0 with PASS', () => {
    const matrixPath = path.join(tmpDir, 'matrix.json');
    const baselinePath = path.join(tmpDir, 'baseline.json');
    fs.writeFileSync(matrixPath, createMatrix(30, 63, 211));
    fs.writeFileSync(baselinePath, createMatrix(27, 57, 211));

    const result = run(matrixPath, baselinePath);
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('PASS'));
  });
});

// ── Minor Regression Within Threshold ──────────────────────────────────────

describe('minor regression', () => {
  test('7pp drop within 15pp threshold exits 0', () => {
    const matrixPath = path.join(tmpDir, 'matrix.json');
    const baselinePath = path.join(tmpDir, 'baseline.json');
    fs.writeFileSync(matrixPath, createMatrix(20, 42, 211));
    fs.writeFileSync(baselinePath, createMatrix(27, 57, 211));

    const result = run(matrixPath, baselinePath);
    assert.strictEqual(result.status, 0, 'should exit 0 for minor drop');
    assert.ok(result.stdout.includes('PASS'), 'should report PASS');
    assert.ok(result.stdout.includes('Minor coverage change'), 'should mention minor change');
  });
});

// ── Regression Exceeds Threshold ───────────────────────────────────────────

describe('regression exceeds threshold', () => {
  test('17pp drop exceeds 15pp threshold, exits 1', () => {
    const matrixPath = path.join(tmpDir, 'matrix.json');
    const baselinePath = path.join(tmpDir, 'baseline.json');
    fs.writeFileSync(matrixPath, createMatrix(10, 21, 211));
    fs.writeFileSync(baselinePath, createMatrix(27, 57, 211));

    const result = run(matrixPath, baselinePath);
    assert.strictEqual(result.status, 1, 'should exit 1 for regression');
    assert.ok(result.stdout.includes('WARN'), 'should report WARN');
    assert.ok(result.stdout.includes('Coverage regression detected'), 'should mention regression');
    assert.ok(result.stdout.includes('To update baseline'), 'should include update instructions');
  });

  test('WARN output includes correct drop value', () => {
    const matrixPath = path.join(tmpDir, 'matrix.json');
    const baselinePath = path.join(tmpDir, 'baseline.json');
    fs.writeFileSync(matrixPath, createMatrix(10, 21, 211));
    fs.writeFileSync(baselinePath, createMatrix(27, 57, 211));

    const result = run(matrixPath, baselinePath);
    assert.ok(result.stdout.includes('17'), 'should show drop of 17pp');
  });
});

// ── Custom Threshold ───────────────────────────────────────────────────────

describe('custom threshold', () => {
  test('7pp drop fails with --threshold 5', () => {
    const matrixPath = path.join(tmpDir, 'matrix.json');
    const baselinePath = path.join(tmpDir, 'baseline.json');
    fs.writeFileSync(matrixPath, createMatrix(20, 42, 211));
    fs.writeFileSync(baselinePath, createMatrix(27, 57, 211));

    const result = run(matrixPath, baselinePath, '--threshold', '5');
    assert.strictEqual(result.status, 1, 'should exit 1 with lower threshold');
  });

  test('7pp drop passes with --threshold 10', () => {
    const matrixPath = path.join(tmpDir, 'matrix.json');
    const baselinePath = path.join(tmpDir, 'baseline.json');
    fs.writeFileSync(matrixPath, createMatrix(20, 42, 211));
    fs.writeFileSync(baselinePath, createMatrix(27, 57, 211));

    const result = run(matrixPath, baselinePath, '--threshold', '10');
    assert.strictEqual(result.status, 0, 'should exit 0 with higher threshold');
  });
});

// ── Malformed Threshold ────────────────────────────────────────────────────

describe('malformed threshold', () => {
  test('--threshold with no value falls back to default and still catches 17pp regression', () => {
    const matrixPath = path.join(tmpDir, 'matrix.json');
    const baselinePath = path.join(tmpDir, 'baseline.json');
    fs.writeFileSync(matrixPath, createMatrix(10, 21, 211));
    fs.writeFileSync(baselinePath, createMatrix(27, 57, 211));

    const result = run(matrixPath, baselinePath, '--threshold');
    assert.strictEqual(result.status, 1, 'missing threshold value must not disable the guard');
    assert.ok(result.stdout.includes('WARN'), 'should still report the regression');
    assert.ok(!result.stdout.includes('NaN'), 'threshold must never render as NaN');
  });

  test('--threshold abc (non-numeric) falls back to default and still catches 17pp regression', () => {
    const matrixPath = path.join(tmpDir, 'matrix.json');
    const baselinePath = path.join(tmpDir, 'baseline.json');
    fs.writeFileSync(matrixPath, createMatrix(10, 21, 211));
    fs.writeFileSync(baselinePath, createMatrix(27, 57, 211));

    const result = run(matrixPath, baselinePath, '--threshold', 'abc');
    assert.strictEqual(result.status, 1, 'non-numeric threshold must not disable the guard');
  });
});

// ── Missing Matrix ─────────────────────────────────────────────────────────

describe('missing files', () => {
  test('missing matrix file exits 1', () => {
    const matrixPath = path.join(tmpDir, 'nonexistent.json');
    const baselinePath = path.join(tmpDir, 'baseline.json');

    const result = run(matrixPath, baselinePath);
    assert.strictEqual(result.status, 1, 'should exit 1 for missing matrix');
    assert.ok(result.stderr.includes('ERROR'), 'should report error on stderr');
  });
});

// ── Quiet Mode ─────────────────────────────────────────────────────────────

describe('quiet mode', () => {
  test('--quiet suppresses stdout', () => {
    const matrixPath = path.join(tmpDir, 'matrix.json');
    const baselinePath = path.join(tmpDir, 'baseline.json');
    fs.writeFileSync(matrixPath, createMatrix(27, 57, 211));
    fs.writeFileSync(baselinePath, createMatrix(27, 57, 211));

    const result = run(matrixPath, baselinePath, '--quiet');
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim(), '', '--quiet should produce no stdout');
  });
});

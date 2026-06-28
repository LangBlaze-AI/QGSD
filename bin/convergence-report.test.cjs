#!/usr/bin/env node
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { generateSparkline, rankActionItems, formatConvergenceSection } = require('./convergence-report.cjs');

// ── generateSparkline tests ─────────────────────────────────────────────────

describe('generateSparkline', () => {
  it('returns empty string for empty array', () => {
    assert.equal(generateSparkline([]), '');
  });

  it('returns empty string for null/undefined', () => {
    assert.equal(generateSparkline(null), '');
    assert.equal(generateSparkline(undefined), '');
  });

  it('returns single middle-level character for single value', () => {
    const result = generateSparkline([5]);
    assert.equal(result.length, 1);
    assert.equal(result, '▅'); // middle level for constant
  });

  it('maps increasing series correctly', () => {
    const result = generateSparkline([0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(result, '▁▂▃▄▅▆▇█');
  });

  it('maps decreasing series correctly', () => {
    const result = generateSparkline([7, 6, 5, 4, 3, 2, 1, 0]);
    assert.equal(result, '█▇▆▅▄▃▂▁');
  });

  it('maps constant series to middle level', () => {
    const result = generateSparkline([3, 3, 3]);
    assert.equal(result, '▅▅▅');
  });

  it('uses middle dot for -1 (missing) values', () => {
    const result = generateSparkline([5, -1, 3, -1, 1]);
    assert.equal(result.length, 5);
    assert.equal(result[1], '·');
    assert.equal(result[3], '·');
  });

  it('returns all middle dots for all -1 values', () => {
    const result = generateSparkline([-1, -1, -1]);
    assert.equal(result, '···');
  });
});

// ── rankActionItems tests ───────────────────────────────────────────────────

describe('rankActionItems', () => {
  it('returns empty array for null verdicts', () => {
    assert.deepEqual(rankActionItems(null, {}, 3), []);
  });

  it('blocked layer gets highest priority', () => {
    const verdicts = {
      r_to_f: { trend: 'STABLE', blocked: true, oscillation_count: 1, credits_remaining: 0, grace_period: false },
      f_to_t: { trend: 'INCREASING', blocked: false, oscillation_count: 0, credits_remaining: 1, grace_period: false },
    };
    const residuals = { r_to_f: 5, f_to_t: 10 };
    const items = rankActionItems(verdicts, residuals, 3);
    assert.equal(items[0].layer, 'r_to_f');
    assert.ok(items[0].priority > items[1].priority);
  });

  it('INCREASING layer gets priority 80 + residual', () => {
    const verdicts = {
      f_to_t: { trend: 'INCREASING', blocked: false, oscillation_count: 0, credits_remaining: 1, grace_period: false },
    };
    const items = rankActionItems(verdicts, { f_to_t: 5 }, 3);
    assert.equal(items[0].priority, 85);
  });

  it('OSCILLATING layer gets priority 60 + residual', () => {
    const verdicts = {
      c_to_f: { trend: 'OSCILLATING', blocked: false, oscillation_count: 2, credits_remaining: 1, grace_period: false },
    };
    const items = rankActionItems(verdicts, { c_to_f: 3 }, 3);
    assert.equal(items[0].priority, 63);
  });

  it('STABLE with residual > 0 gets priority 40 + residual', () => {
    const verdicts = {
      t_to_c: { trend: 'STABLE', blocked: false, oscillation_count: 0, credits_remaining: 1, grace_period: false },
    };
    const items = rankActionItems(verdicts, { t_to_c: 7 }, 3);
    assert.equal(items[0].priority, 47);
  });

  it('DECREASING layer does not appear (priority 0)', () => {
    const verdicts = {
      r_to_f: { trend: 'DECREASING', blocked: false, oscillation_count: 0, credits_remaining: 1, grace_period: false },
    };
    const items = rankActionItems(verdicts, { r_to_f: 3 }, 3);
    assert.equal(items.length, 0);
  });

  it('sorts multiple layers by priority descending', () => {
    const verdicts = {
      r_to_f: { trend: 'STABLE', blocked: true, oscillation_count: 1, credits_remaining: 0, grace_period: false },
      f_to_t: { trend: 'INCREASING', blocked: false, oscillation_count: 0, credits_remaining: 1, grace_period: false },
      c_to_f: { trend: 'OSCILLATING', blocked: false, oscillation_count: 2, credits_remaining: 1, grace_period: false },
    };
    const residuals = { r_to_f: 2, f_to_t: 2, c_to_f: 2 };
    const items = rankActionItems(verdicts, residuals, 10);
    assert.ok(items[0].priority >= items[1].priority);
    assert.ok(items[1].priority >= items[2].priority);
  });

  it('respects maxItems parameter', () => {
    const verdicts = {
      r_to_f: { trend: 'STABLE', blocked: true, oscillation_count: 1, credits_remaining: 0, grace_period: false },
      f_to_t: { trend: 'INCREASING', blocked: false, oscillation_count: 0, credits_remaining: 1, grace_period: false },
      c_to_f: { trend: 'OSCILLATING', blocked: false, oscillation_count: 2, credits_remaining: 1, grace_period: false },
    };
    const residuals = { r_to_f: 2, f_to_t: 2, c_to_f: 2 };
    const items = rankActionItems(verdicts, residuals, 2);
    assert.equal(items.length, 2);
  });
});

// ── formatConvergenceSection tests ──────────────────────────────────────────

describe('formatConvergenceSection', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-report-test-'));
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns unavailable message when no trend file exists', () => {
    const result = formatConvergenceSection({ root: tmpDir });
    assert.ok(result.includes('unavailable'));
  });

  it('returns unavailable message when trend file is empty', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'formal', 'solve-trend.jsonl'), '');
    const result = formatConvergenceSection({ root: tmpDir });
    assert.ok(result.includes('unavailable'));
  });

  it('renders sparklines from valid trend data', () => {
    const entries = [];
    for (let i = 0; i < 5; i++) {
      const perLayer = {};
      for (const key of require('./oscillation-detector.cjs').LAYER_KEYS) {
        perLayer[key] = 10 - i;
      }
      entries.push({ timestamp: new Date().toISOString(), per_layer: perLayer });
    }
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'formal', 'solve-trend.jsonl'),
      entries.map(e => JSON.stringify(e)).join('\n') + '\n'
    );

    const result = formatConvergenceSection({ root: tmpDir });
    assert.ok(result.includes('Convergence Trends'));
    assert.ok(result.includes('R->F'));
    // Should contain sparkline characters
    assert.ok(/[▁▂▃▄▅▆▇█]/.test(result));
  });

  it('shows all layers stable when no verdicts with oscillation', () => {
    const entries = [];
    for (let i = 0; i < 5; i++) {
      const perLayer = {};
      for (const key of require('./oscillation-detector.cjs').LAYER_KEYS) {
        perLayer[key] = 0;
      }
      entries.push({ timestamp: new Date().toISOString(), per_layer: perLayer });
    }
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'formal', 'solve-trend.jsonl'),
      entries.map(e => JSON.stringify(e)).join('\n') + '\n'
    );

    const result = formatConvergenceSection({ root: tmpDir });
    assert.ok(result.includes('All layers stable'));
  });

  it('does not throw when trend file contains a null JSON entry (corrupt line)', () => {
    const trendPath = path.join(tmpDir, '.planning', 'formal', 'solve-trend.jsonl');
    // Middle entry is the bare JSON literal `null`; last entry is valid.
    // Reproduces the deref crash at the per_layer map (and the latestEntry deref).
    fs.writeFileSync(
      trendPath,
      '{"per_layer":{"r_to_f":5}}\nnull\n{"per_layer":{"r_to_f":3}}\n'
    );
    let result;
    assert.doesNotThrow(() => { result = formatConvergenceSection({ root: tmpDir }); });
    assert.equal(typeof result, 'string');
    assert.ok(result.includes('Convergence Trends'));
  });

  it('does not throw when called with null options', () => {
    assert.doesNotThrow(() => formatConvergenceSection(null));
  });
});

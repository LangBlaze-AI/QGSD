#!/usr/bin/env node
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'cross-layer-dashboard.cjs');

// ── Helper ──────────────────────────────────────────────────────────────────

function run(...extraArgs) {
  const result = spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    encoding: 'utf8',
    timeout: 30000,
    stdio: 'pipe',
  });
  return result;
}

// ── Unit tests: healthIndicator ─────────────────────────────────────────────

const { healthIndicator, buildResult } = require('./cross-layer-dashboard.cjs');

describe('healthIndicator', () => {
  it('returns [PASS] when score >= target', () => {
    assert.equal(healthIndicator(0.85, 0.8), '[PASS]');
    assert.equal(healthIndicator(0.8, 0.8), '[PASS]');
    assert.equal(healthIndicator(1.0, 0.8), '[PASS]');
  });

  it('returns [WARN] when score >= target*0.8 but below target', () => {
    assert.equal(healthIndicator(0.79, 0.8), '[WARN]');
    assert.equal(healthIndicator(0.65, 0.8), '[WARN]');
  });

  it('returns [FAIL] when score < target*0.8', () => {
    assert.equal(healthIndicator(0.63, 0.8), '[FAIL]');
    assert.equal(healthIndicator(0.0, 0.8), '[FAIL]');
  });

  it('returns [N/A] when score or target is null', () => {
    assert.equal(healthIndicator(null, 0.8), '[N/A]');
    assert.equal(healthIndicator(0.5, null), '[N/A]');
    assert.equal(healthIndicator(null, null), '[N/A]');
  });
});

// ── Integration tests via CLI ───────────────────────────────────────────────

describe('cross-layer-dashboard CLI', () => {

  describe('JSON output structure', () => {
    it('produces valid JSON with all four metrics', () => {
      const result = run('--cached', '--json');
      const data = JSON.parse(result.stdout);
      assert.equal(typeof data.l1_coverage_pct, 'number');
      assert.ok(data.gate_a !== undefined, 'gate_a present');
      assert.ok(data.gate_b !== undefined, 'gate_b present');
      assert.ok(data.gate_c !== undefined, 'gate_c present');
    });

    it('gate objects have score, target, target_met fields', () => {
      const result = run('--cached', '--json');
      const data = JSON.parse(result.stdout);
      for (const key of ['gate_a', 'gate_b', 'gate_c']) {
        const gate = data[key];
        if (gate === null) continue; // graceful degradation
        assert.equal(typeof gate.score, 'number', `${key}.score is number`);
        assert.equal(typeof gate.target, 'number', `${key}.target is number`);
        assert.equal(typeof gate.target_met, 'boolean', `${key}.target_met is boolean`);
      }
    });

    it('includes all_targets_met boolean', () => {
      const result = run('--cached', '--json');
      const data = JSON.parse(result.stdout);
      assert.equal(typeof data.all_targets_met, 'boolean');
    });
  });

  describe('terminal output', () => {
    it('contains all four metric labels', () => {
      const result = run('--cached');
      const out = result.stdout;
      assert.ok(out.includes('L1 Coverage'), 'contains L1 Coverage');
      assert.ok(out.includes('Wiring:Evidence'), 'contains Wiring:Evidence');
      assert.ok(out.includes('Wiring:Purpose'), 'contains Wiring:Purpose');
      assert.ok(out.includes('Wiring:Coverage'), 'contains Wiring:Coverage');
    });

    it('contains at least one health indicator', () => {
      const result = run('--cached');
      const out = result.stdout;
      const hasIndicator = out.includes('[PASS]') || out.includes('[WARN]') || out.includes('[FAIL]');
      assert.ok(hasIndicator, 'has at least one health indicator');
    });

    it('contains dashboard title', () => {
      const result = run('--cached');
      assert.ok(result.stdout.includes('Cross-Layer Alignment Dashboard'));
    });

    it('contains composite summary line', () => {
      const result = run('--cached');
      assert.ok(result.stdout.includes('Composite:'));
    });
  });

  describe('graceful degradation', () => {
    it('produces output even when gate files may be missing', () => {
      // The --cached mode reads from gate JSON files; even if one is missing
      // the dashboard should still produce output with N/A
      const result = run('--cached');
      // Should not crash (status 0 or 1, not null/undefined from crash)
      assert.ok(result.status === 0 || result.status === 1, 'exits cleanly');
      assert.ok(result.stdout.length > 0, 'produces output');
    });

    it('JSON mode shows null for unavailable gates', () => {
      // buildResult handles null gates gracefully
      const result = buildResult({ gateA: null, gateB: null, gateC: null, l1Pct: null, maturity: null });
      assert.equal(result.gate_a, null);
      assert.equal(result.gate_b, null);
      assert.equal(result.gate_c, null);
      assert.equal(result.l1_coverage_pct, null);
      assert.equal(result.all_targets_met, false);
    });
  });

  describe('exit code', () => {
    it('exits 0 when all gates meet targets (current state)', () => {
      // Build a synthetic result with all targets met to verify exit logic
      const syntheticData = {
        gateA: { wiring_evidence_score: 1.0, target: 0.8, target_met: true, explained: 5, total: 5, unexplained_counts: { instrumentation_bug: 0, model_gap: 0, genuine_violation: 0 } },
        gateB: { wiring_purpose_score: 1.0, target: 1.0, target_met: true, grounded_entries: 5, total_entries: 5, orphaned_entries: 0 },
        gateC: { wiring_coverage_score: 1.0, target: 0.8, target_met: true, validated_entries: 5, total_entries: 5, unvalidated_entries: 0 },
        l1Pct: 1.0,
        maturity: { total: 5, by_level: { ADVISORY: 5 } },
      };
      const result = buildResult(syntheticData);
      assert.equal(result.all_targets_met, true, 'all_targets_met must be true when all gate targets met');
    });
  });

  describe('renderTerminal robustness', () => {
    const { renderTerminal } = require('./cross-layer-dashboard.cjs');

    it('degrades to N/A instead of crashing on non-numeric l1 coverage (corrupt JSON file)', () => {
      const result = buildResult({ gateA: null, gateB: null, gateC: null, l1Pct: '50', maturity: null });
      let out;
      assert.doesNotThrow(() => { out = renderTerminal(result); }, 'renderTerminal must not throw on a non-numeric l1 coverage value');
      assert.ok(out.includes('L1 Coverage'), 'still renders the L1 Coverage row');
      assert.ok(out.includes('N/A'), 'shows N/A for the corrupt coverage value');
    });
  });

  describe('null-argument robustness', () => {
    const { renderTerminal } = require('./cross-layer-dashboard.cjs');

    it('buildResult does not throw on null/undefined data', () => {
      assert.doesNotThrow(() => buildResult(undefined), 'buildResult(undefined) must not throw');
      const r = buildResult(null);
      assert.equal(r.gate_a, null);
      assert.equal(r.l1_coverage_pct, null);
      assert.equal(r.all_targets_met, false);
    });

    it('renderTerminal does not throw on null result', () => {
      assert.doesNotThrow(() => renderTerminal(null), 'renderTerminal(null) must not throw');
    });
  });

});

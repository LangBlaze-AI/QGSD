#!/usr/bin/env node
'use strict';

/**
 * quorum-consensus-gate-cluster.test.cjs — tests for cluster-aware correlated failure model
 * Issue #171: model correlated provider failures in early-escalation gate
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  poissonBinomialPMF,
  poissonBinomialCDF,
  buildFailureDomainClusters,
  clusterPMF,
  convolvePMFs,
  detectClusterOutages,
  computeClusterAwareConsensus,
  computeConsensusProbability,
  computeEarlyEscalation,
} = require('../bin/quorum-consensus-gate.cjs');

// ── poissonBinomialPMF ─────────────────────────────────────────────────────

describe('poissonBinomialPMF', () => {
  it('returns [1] for empty probabilities', () => {
    assert.deepStrictEqual(poissonBinomialPMF([]), [1]);
  });

  it('returns correct PMF for single trial', () => {
    const pmf = poissonBinomialPMF([0.8]);
    assert.ok(Math.abs(pmf[0] - 0.2) < 1e-10);
    assert.ok(Math.abs(pmf[1] - 0.8) < 1e-10);
  });

  it('sums to 1 for heterogeneous rates', () => {
    const pmf = poissonBinomialPMF([0.9, 0.5, 0.3]);
    const sum = pmf.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-10, 'PMF must sum to 1, got ' + sum);
  });

  it('matches CDF: sum of PMF[k..n] == CDF(k)', () => {
    const probs = [0.85, 0.70, 0.60, 0.90];
    const pmf = poissonBinomialPMF(probs);
    for (let k = 0; k <= probs.length; k++) {
      let pmfSum = 0;
      for (let j = k; j < pmf.length; j++) pmfSum += pmf[j];
      const cdf = poissonBinomialCDF(probs, k);
      assert.ok(Math.abs(pmfSum - cdf) < 1e-10, `PMF sum from ${k} = ${pmfSum}, CDF = ${cdf}`);
    }
  });
});

// ── clusterPMF ─────────────────────────────────────────────────────────────

describe('clusterPMF', () => {
  it('returns [1] for empty rates', () => {
    assert.deepStrictEqual(clusterPMF([]), [1]);
  });

  it('returns [1, 0] for single slot at rate 0', () => {
    assert.deepStrictEqual(clusterPMF([0]), [1, 0]);
  });

  it('captures perfect correlation when rates are equal', () => {
    // Two slots both at 0.85: pUp=0.85, q=[1.0, 1.0]
    // P(j|up): only j=2 has mass 1.0
    // P(j) = 0.85 * P(j|up) + 0.15 * δ(j=0)
    // P(0) = 0.15, P(2) = 0.85, P(1) = 0
    const pmf = clusterPMF([0.85, 0.85]);
    assert.ok(Math.abs(pmf[0] - 0.15) < 1e-10, 'P(0) should be 0.15');
    assert.ok(Math.abs(pmf[1] - 0.00) < 1e-10, 'P(1) should be 0.00');
    assert.ok(Math.abs(pmf[2] - 0.85) < 1e-10, 'P(2) should be 0.85');
  });

  it('sums to 1', () => {
    const pmf = clusterPMF([0.9, 0.5]);
    const sum = pmf.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-10, 'cluster PMF must sum to 1');
  });

  it('models shared failure mode: P(both) = pUp when rates are equal', () => {
    // When two slots share a provider and have equal rates, the model says
    // all observed failures come from the shared provider. Conditional on
    // provider being up, both slots succeed. So P(both) = pUp = max(rate).
    const pmf = clusterPMF([0.85, 0.85]);
    const pBoth = pmf[2]; // P(both up)
    assert.ok(Math.abs(pBoth - 0.85) < 1e-10,
      `P(both) should equal pUp=0.85, got ${pBoth}`);
    // This is higher than independent P(both) = 0.7225 — correct because
    // shared failures mean fewer independent failure events.
    const pIndependent = 0.85 * 0.85;
    assert.ok(pBoth > pIndependent,
      `Correlated P(both)=${pBoth} should be > independent P(both)=${pIndependent}`);
  });

  it('handles heterogeneous rates in cluster', () => {
    // Slots at 0.9 and 0.7: pUp=0.9, q=[1.0, 0.7/0.9≈0.778]
    const pmf = clusterPMF([0.9, 0.7]);
    const sum = pmf.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-10);
    // P(0) = 0.1 (provider down) + 0.9 * P(0|up)
    // P(0|up) = (1-1.0)*(1-0.778) = 0
    // P(0) = 0.1
    assert.ok(Math.abs(pmf[0] - 0.1) < 1e-10, 'P(0) should be 0.1');
  });
});

// ── convolvePMFs ───────────────────────────────────────────────────────────

describe('convolvePMFs', () => {
  it('identity: convolve with [1] returns same PMF', () => {
    const result = convolvePMFs([1], [0.2, 0.8]);
    assert.deepStrictEqual(result, [0.2, 0.8]);
  });

  it('two independent Bernoulli(0.5) trials', () => {
    const result = convolvePMFs([0.5, 0.5], [0.5, 0.5]);
    // P(0)=0.25, P(1)=0.50, P(2)=0.25
    assert.ok(Math.abs(result[0] - 0.25) < 1e-10);
    assert.ok(Math.abs(result[1] - 0.50) < 1e-10);
    assert.ok(Math.abs(result[2] - 0.25) < 1e-10);
  });

  it('sum is preserved', () => {
    const a = [0.1, 0.6, 0.3];
    const b = [0.05, 0.45, 0.5];
    const result = convolvePMFs(a, b);
    const sumA = a.reduce((x, y) => x + y, 0);
    const sumR = result.reduce((x, y) => x + y, 0);
    assert.ok(Math.abs(sumA - sumR) < 1e-10);
  });
});

// ── buildFailureDomainClusters ─────────────────────────────────────────────

describe('buildFailureDomainClusters', () => {
  const fixturesDir = path.join(__dirname, 'fixtures');

  it('returns empty for empty slot rates', () => {
    assert.deepStrictEqual(buildFailureDomainClusters({}), {});
  });

  it('returns empty when providers.json has no multi-slot providers', () => {
    const providersPath = path.join(fixturesDir, 'providers-independent.json');
    const rates = { 'codex-1': 0.9, 'gemini-1': 0.8 };
    const clusters = buildFailureDomainClusters(rates, providersPath);
    assert.deepStrictEqual(clusters, {});
  });

  it('groups slots sharing a provider', () => {
    const providersPath = path.join(fixturesDir, 'providers-correlated.json');
    const rates = { 'codex-1': 0.9, 'copilot-1': 0.8, 'gemini-1': 0.7 };
    const clusters = buildFailureDomainClusters(rates, providersPath);
    // codex-1 and copilot-1 share provider "openai"
    assert.ok(clusters.openai, 'should have openai cluster');
    assert.deepEqual(clusters.openai.sort(), ['codex-1', 'copilot-1'].sort());
    assert.ok(!clusters.google, 'single-slot cluster should be removed');
  });

  it('ignores slots not in slotRates', () => {
    const providersPath = path.join(fixturesDir, 'providers-correlated.json');
    // Only codex-1 active — copilot-1 not in rates
    const rates = { 'codex-1': 0.9, 'gemini-1': 0.7 };
    const clusters = buildFailureDomainClusters(rates, providersPath);
    // codex-1 alone doesn't form a cluster
    assert.deepStrictEqual(clusters, {});
  });
});

// ── detectClusterOutages ───────────────────────────────────────────────────

describe('detectClusterOutages', () => {
  it('returns empty when no clusters', () => {
    assert.deepStrictEqual(detectClusterOutages({}, {}), []);
  });

  it('detects fully-down cluster', () => {
    const clusters = { openai: ['codex-1', 'copilot-1'] };
    const rates = { 'codex-1': 0, 'copilot-1': 0, 'gemini-1': 0.9 };
    assert.deepStrictEqual(detectClusterOutages(clusters, rates), ['openai']);
  });

  it('does not flag partially-down cluster', () => {
    const clusters = { openai: ['codex-1', 'copilot-1'] };
    const rates = { 'codex-1': 0, 'copilot-1': 0.5, 'gemini-1': 0.9 };
    assert.deepStrictEqual(detectClusterOutages(clusters, rates), []);
  });

  it('detects multiple cluster outages', () => {
    const clusters = { openai: ['codex-1', 'copilot-1'], google: ['gemini-1', 'gemini-2'] };
    const rates = { 'codex-1': 0, 'copilot-1': 0, 'gemini-1': 0, 'gemini-2': 0 };
    const outages = detectClusterOutages(clusters, rates).sort();
    assert.deepStrictEqual(outages, ['google', 'openai']);
  });
});

// ── computeClusterAwareConsensus ───────────────────────────────────────────

describe('computeClusterAwareConsensus', () => {
  const fixturesDir = path.join(__dirname, 'fixtures');

  it('falls back to independent model when no clusters', () => {
    const providersPath = path.join(fixturesDir, 'providers-independent.json');
    const rates = { 'codex-1': 0.85, 'gemini-1': 0.85, 'opencode-1': 0.85 };
    const result = computeClusterAwareConsensus(rates, 2, providersPath);
    assert.strictEqual(result.method, 'independent');
    assert.strictEqual(result.clusterOutages.length, 0);

    // Must match vanilla Poisson binomial
    const vanilla = computeConsensusProbability(rates, 2);
    assert.strictEqual(result.probability, vanilla.probability);
  });

  it('produces lower P(consensus) than independent model for correlated cluster', () => {
    const providersPath = path.join(fixturesDir, 'providers-correlated.json');
    // codex-1 + copilot-1 share provider "openai", gemini-1 is independent
    const rates = { 'codex-1': 0.85, 'copilot-1': 0.85, 'gemini-1': 0.85 };
    const clusterResult = computeClusterAwareConsensus(rates, 2, providersPath);
    const independentResult = computeConsensusProbability(rates, 2);

    assert.strictEqual(clusterResult.method, 'cluster-aware');
    assert.ok(clusterResult.probability <= independentResult.probability,
      `cluster-aware P=${clusterResult.probability} should be <= independent P=${independentResult.probability}`);
  });

  it('detects cluster outage and reports probability 0', () => {
    const providersPath = path.join(fixturesDir, 'providers-correlated.json');
    const rates = { 'codex-1': 0, 'copilot-1': 0, 'gemini-1': 0.9 };
    const result = computeClusterAwareConsensus(rates, 2, providersPath);
    assert.deepStrictEqual(result.clusterOutages, ['openai']);
    // With 2 openai slots down, only gemini-1 can succeed → P(>=2) should be very low
    assert.ok(result.probability < 0.01,
      `P=${result.probability} should be ~0 with one provider fully down and minQuorum=2`);
  });

  it('preserves baseline behaviour for all-independent slots', () => {
    const providersPath = path.join(fixturesDir, 'providers-independent.json');
    const rates = { 'codex-1': 0.90, 'gemini-1': 0.80, 'opencode-1': 0.70 };
    const clusterResult = computeClusterAwareConsensus(rates, 2, providersPath);
    const independentResult = computeConsensusProbability(rates, 2);
    assert.strictEqual(clusterResult.probability, independentResult.probability);
  });
});

// ── computeEarlyEscalation with clusters ───────────────────────────────────

describe('computeEarlyEscalation (cluster-aware)', () => {
  const fixturesDir = path.join(__dirname, 'fixtures');

  it('escalates immediately on full cluster outage', () => {
    const providersPath = path.join(fixturesDir, 'providers-correlated.json');
    const rates = { 'codex-1': 0, 'copilot-1': 0, 'gemini-1': 0.9 };
    const result = computeEarlyEscalation(rates, 2, 5, 0.10, { providersPath });
    assert.strictEqual(result.shouldEscalate, true);
    assert.ok(result.clusterOutages);
    assert.deepStrictEqual(result.clusterOutages, ['openai']);
    assert.strictEqual(result.probability, 0);
  });

  it('uses cluster-aware pPerRound when clusters exist', () => {
    const providersPath = path.join(fixturesDir, 'providers-correlated.json');
    const rates = { 'codex-1': 0.85, 'copilot-1': 0.85, 'gemini-1': 0.85 };
    const withClusters = computeEarlyEscalation(rates, 2, 3, 0.10, { providersPath });
    const noClusters = computeEarlyEscalation(rates, 2, 3, 0.10,
      { providersPath: path.join(fixturesDir, 'providers-independent.json') });

    // Cluster-aware should produce lower or equal probability
    assert.ok(withClusters.pPerRound <= noClusters.pPerRound,
      `cluster-aware pPerRound=${withClusters.pPerRound} should be <= independent=${noClusters.pPerRound}`);
  });

  it('preserves baseline when no clusters', () => {
    const providersPath = path.join(fixturesDir, 'providers-independent.json');
    const rates = { 'codex-1': 0.9, 'gemini-1': 0.8, 'opencode-1': 0.7 };
    const result = computeEarlyEscalation(rates, 2, 5, 0.10, { providersPath });
    // With 3 slots at decent rates and 5 rounds, should not escalate
    assert.strictEqual(result.shouldEscalate, false);
    assert.ok(result.probability > 0.10);
  });

  it('escalates when remaining rounds are 0', () => {
    const rates = { 'codex-1': 0.9, 'gemini-1': 0.9 };
    const result = computeEarlyEscalation(rates, 2, 0, 0.10);
    assert.strictEqual(result.shouldEscalate, true);
  });
});

// ── Overlapping clusters ───────────────────────────────────────────────────

describe('overlapping cluster scenarios', () => {
  const fixturesDir = path.join(__dirname, 'fixtures');

  it('handles multiple independent clusters correctly', () => {
    const providersPath = path.join(fixturesDir, 'providers-multi-cluster.json');
    // openai: [codex-1, copilot-1], anthropic: [claude-1, claude-2], google: [gemini-1] (single, no cluster)
    const rates = { 'codex-1': 0.85, 'copilot-1': 0.80, 'claude-1': 0.90, 'claude-2': 0.75, 'gemini-1': 0.85 };
    const result = computeClusterAwareConsensus(rates, 3, providersPath);
    assert.strictEqual(result.method, 'cluster-aware');

    // Should be lower than independent model
    const independent = computeConsensusProbability(rates, 3);
    assert.ok(result.probability <= independent.probability,
      `multi-cluster P=${result.probability} should be <= independent P=${independent.probability}`);
  });

  it('detects outage in one cluster while others remain up', () => {
    const providersPath = path.join(fixturesDir, 'providers-multi-cluster.json');
    const rates = { 'codex-1': 0, 'copilot-1': 0, 'claude-1': 0.9, 'claude-2': 0.8, 'gemini-1': 0.85 };
    const result = computeClusterAwareConsensus(rates, 2, providersPath);
    assert.ok(result.clusterOutages.includes('openai'));
    // claude cluster and gemini still available → P(>=2) should still be positive
    assert.ok(result.probability > 0);
  });
});

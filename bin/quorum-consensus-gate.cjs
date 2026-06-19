#!/usr/bin/env node
'use strict';
// bin/quorum-consensus-gate.cjs
// PRISM consensus probability gate for quorum rounds.
// Requirements: SIG-04
//
// Usage:
//   node bin/quorum-consensus-gate.cjs [--min-quorum=2]
//
// Computes P(consensus_reached) from current scoreboard availability rates
// using the Poisson binomial distribution (closed-form, no PRISM dependency).
// Gates quorum rounds when probability is below threshold.
//
// Exit 0 = proceed, Exit 1 = defer.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { loadProviders } = require('./resolve-providers.cjs');
const { parseIntStrict } = require('./parse-int-strict.cjs');

/**
 * poissonBinomialCDF(probabilities, k) — computes P(X >= k) for heterogeneous trials.
 *
 * Uses recursive DP approach for the Poisson binomial distribution:
 *   dp[0] = 1 (base case: 0 successes with 0 trials)
 *   For each probability p_i: dp[j] = dp[j] * (1-p_i) + dp[j-1] * p_i for j from n down to 1
 *   Returns P(X >= k) = sum of dp[k..n]
 *
 * Equivalent to the PRISM mcp-availability.pm model but computed in O(n^2) without Java.
 *
 * @param {number[]} probabilities - per-slot availability rates
 * @param {number} k - minimum number of successes needed
 * @returns {number} P(X >= k)
 */
function poissonBinomialCDF(probabilities, k) {
  const n = probabilities.length;
  if (k > n) return 0;
  if (k <= 0) return 1.0;

  // dp[j] = probability of exactly j successes after processing i trials
  const dp = new Array(n + 1).fill(0);
  dp[0] = 1; // base: P(0 successes with 0 trials) = 1

  for (let i = 0; i < n; i++) {
    const p = probabilities[i];
    // Process backwards to avoid overwriting dp[j-1] before it's used
    for (let j = i + 1; j >= 1; j--) {
      dp[j] = dp[j] * (1 - p) + dp[j - 1] * p;
    }
    dp[0] = dp[0] * (1 - p);
  }

  // P(X >= k) = sum of dp[k..n]
  let result = 0;
  for (let j = k; j <= n; j++) {
    result += dp[j];
  }

  return result;
}

/**
 * computeConsensusProbability(slotRates, minQuorum) — computes P(consensus_reached).
 * @param {Object} slotRates - { slot_name: availability_rate }
 * @param {number} minQuorum - minimum number of slots needed for consensus
 * @returns {{ probability: number, slotCount: number, minQuorum: number, rates: Object }}
 */
function computeConsensusProbability(slotRates, minQuorum) {
  const probabilities = Object.values(slotRates);
  const probability = poissonBinomialCDF(probabilities, minQuorum);

  return {
    probability: Math.round(probability * 1e6) / 1e6,
    slotCount: probabilities.length,
    minQuorum,
    rates: slotRates,
  };
}

/**
 * checkConsensusGate(options) — reads scoreboard, computes probability, returns gate decision.
 *
 * Uses cluster-aware P(consensus) when multi-slot provider clusters are detected,
 * falling back to independent Poisson binomial otherwise.
 *
 * @param {{ scoreboardPath?: string, configPath?: string, minQuorum?: number, providersPath?: string }} options
 * @returns {{ action: string, probability: number, threshold: number, message: string, method?: string, clusterOutages?: string[] }}
 */
function checkConsensusGate(options = {}) {
  const pp = require('./planning-paths.cjs');
  const scoreboardPath = options.scoreboardPath || pp.resolveWithFallback(process.cwd(), 'quorum-scoreboard');
  const configPath     = options.configPath || path.join(process.cwd(), '.planning', 'config.json');
  const minQuorum      = options.minQuorum || 2;

  // Read scoreboard availability rates.
  // Source from the side-effect-free scoreboard-rates.cjs — NOT run-prism.cjs,
  // which runs its full PRISM pipeline (process.exit, spawnSync, argv forwarding)
  // at import time and would kill this gate. See issue #198.
  let slotRates = null;
  try {
    const { readMCPAvailabilityRates } = require('./scoreboard-rates.cjs');
    slotRates = readMCPAvailabilityRates(scoreboardPath);
  } catch (_) {
    // scoreboard-rates.cjs not available — fall through to priors
  }

  // If no rates (empty/missing scoreboard): use conservative prior rates
  if (!slotRates || Object.keys(slotRates).length === 0) {
    slotRates = {
      'slot-1': 0.85,
      'slot-2': 0.85,
      'slot-3': 0.85,
      'slot-4': 0.85,
    };
  }

  // Read threshold from config.json
  let threshold = 0.70;
  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.workflow && typeof config.workflow.consensus_probability_threshold === 'number') {
        threshold = config.workflow.consensus_probability_threshold;
      }
    }
  } catch (_) {
    // Use default threshold
  }

  // Compute P(consensus_reached) — cluster-aware when possible
  const result = computeClusterAwareConsensus(slotRates, minQuorum, options.providersPath);
  const probability = result.probability;

  // Immediate escalation on cluster outage
  if (result.clusterOutages && result.clusterOutages.length > 0) {
    return {
      action: 'defer',
      probability,
      threshold,
      method: result.method,
      clusterOutages: result.clusterOutages,
      message: 'WARNING: Provider cluster outage: [' + result.clusterOutages.join(', ') + '] — immediate escalation. P(consensus)=' + probability.toFixed(4),
    };
  }

  if (probability >= threshold) {
    return {
      action: 'proceed',
      probability,
      threshold,
      method: result.method,
      message: 'Consensus probability ' + probability.toFixed(4) + ' >= threshold ' + threshold.toFixed(2) + ' -- proceeding',
    };
  } else {
    return {
      action: 'defer',
      probability,
      threshold,
      method: result.method,
      message: 'WARNING: Consensus probability ' + probability.toFixed(4) + ' < threshold ' + threshold.toFixed(2) + ' -- deferring quorum round. Slot availability too low for reliable consensus.',
    };
  }
}

/**
 * readEarlyEscalationThreshold(configPaths) — reads workflow.early_escalation_threshold from config.
 *
 * Tries each config path in order. Returns 0.10 (default) if:
 * - No paths provided or none exist
 * - JSON parse fails (fail-open)
 * - Value is missing, non-numeric, or outside [0, 1.0] range
 *
 * @param {string[]} configPaths - ordered list of config file paths to try
 * @returns {number} threshold (0.0 to 1.0), or 0.10 default
 */
function readEarlyEscalationThreshold(configPaths) {
  const DEFAULT = 0.10;
  const paths = configPaths || [
    path.join(process.cwd(), '.planning', 'config.json'),
    path.join(process.cwd(), '.planning', 'nf.json'),
  ];
  for (const cfgPath of paths) {
    try {
      if (fs.existsSync(cfgPath)) {
        const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        const val = config.workflow?.early_escalation_threshold;
        if (typeof val === 'number' && val > 0 && val <= 1.0) return val;
      }
    } catch (_) {
      // Fail-open: JSON parse error, continue to next path
    }
  }
  return DEFAULT;
}

/**
 * computeEarlyEscalation(slotRates, minQuorum, remainingRounds, threshold, options)
 *
 * Computes P(consensus within remainingRounds) and checks early escalation.
 * Uses cluster-aware model when multi-slot provider clusters are detected.
 * Detects full cluster outages for immediate escalation.
 *
 * @param {Object} slotRates - { slot_name: availability_rate }
 * @param {number} minQuorum - minimum successful slots needed
 * @param {number} remainingRounds - rounds left in deliberation loop
 * @param {number} threshold - escalation threshold (optional, defaults to 0.10)
 * @param {{ providersPath?: string }} [options] - optional providers.json path
 * @returns {{ shouldEscalate: boolean, probability: number, threshold: number, remainingRounds: number, pPerRound: number, clusterOutages?: string[] }}
 */
function computeEarlyEscalation(slotRates, minQuorum, remainingRounds, threshold, options) {
  if (typeof threshold !== 'number') threshold = readEarlyEscalationThreshold();
  if (remainingRounds <= 0) {
    return { shouldEscalate: true, probability: 0, threshold, remainingRounds, pPerRound: 0 };
  }

  // Detect cluster outages — immediate escalation if any cluster is fully down
  const providersPath = (options && options.providersPath) || undefined;
  const clusters = buildFailureDomainClusters(slotRates, providersPath);
  const clusterOutages = detectClusterOutages(clusters, slotRates);

  if (clusterOutages.length > 0) {
    return {
      shouldEscalate: true,
      probability: 0,
      threshold,
      remainingRounds,
      pPerRound: 0,
      clusterOutages,
    };
  }

  // Use cluster-aware pPerRound when clusters exist, otherwise independent model
  let pPerRound;
  if (Object.keys(clusters).length > 0) {
    const clusterResult = computeClusterAwareConsensus(slotRates, minQuorum, providersPath);
    pPerRound = clusterResult.probability;
  } else {
    const rates = Object.values(slotRates);
    pPerRound = poissonBinomialCDF(rates, minQuorum);
  }

  const probability = 1 - Math.pow(1 - pPerRound, remainingRounds);
  const rounded = Math.round(probability * 1e6) / 1e6;
  return {
    shouldEscalate: rounded < threshold,
    probability: rounded,
    threshold,
    remainingRounds,
    pPerRound: Math.round(pPerRound * 1e6) / 1e6,
  };
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const minQuorumArg = args.find(a => a.startsWith('--min-quorum='));
  let minQuorum;
  if (minQuorumArg) {
    minQuorum = parseIntStrict(minQuorumArg.split('=')[1]);
    if (minQuorum === null || minQuorum < 1) {
      process.stderr.write(
        'Usage: quorum-consensus-gate --min-quorum=<positive integer>\n' +
        `Invalid --min-quorum value: ${JSON.stringify(minQuorumArg.split('=')[1])}\n`,
      );
      process.exit(2);
    }
  }

  const remainingRoundsArg = args.find(a => a.startsWith('--remaining-rounds='));

  if (remainingRoundsArg) {
    // HEAL-01: Early escalation mode -- compute P(consensus | remaining rounds)
    // Fail CLOSED on malformed input (#204): an unvalidated NaN propagated
    // through Math.pow(...) and produced shouldEscalate:false / probability:null,
    // silently disabling the early-escalation net. Exit 2 so callers SEE the misuse.
    const remainingRounds = parseIntStrict(remainingRoundsArg.split('=')[1]);
    if (remainingRounds === null || remainingRounds < 0) {
      process.stderr.write(
        'Usage: quorum-consensus-gate --remaining-rounds=<non-negative integer>\n' +
        `Invalid --remaining-rounds value: ${JSON.stringify(remainingRoundsArg.split('=')[1])}\n`,
      );
      process.exit(2);
    }
    const pp2 = require('./planning-paths.cjs');
    const scoreboardPath = pp2.resolveWithFallback(process.cwd(), 'quorum-scoreboard');
    let slotRates = null;
    try {
      const { readMCPAvailabilityRates } = require('./scoreboard-rates.cjs');
      slotRates = readMCPAvailabilityRates(scoreboardPath);
    } catch (_) {}
    if (!slotRates || Object.keys(slotRates).length === 0) {
      slotRates = { 'slot-1': 0.85, 'slot-2': 0.85, 'slot-3': 0.85, 'slot-4': 0.85 };
    }
    const result = computeEarlyEscalation(slotRates, minQuorum || 2, remainingRounds, undefined, { providersPath: undefined });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    // Exit 1 = should escalate (stop deliberating), Exit 0 = continue deliberating
    process.exit(result.shouldEscalate ? 1 : 0);
  } else {
    // Original behavior: unconditional consensus gate check
    const result = checkConsensusGate({ minQuorum });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.action === 'proceed' ? 0 : 1);
  }
}

// ── Failure-domain cluster taxonomy (Issue #171) ────────────────────────────
//
// Models correlated provider failures. When a provider (OpenAI, Google, etc.)
// goes down, all slots using that provider fail simultaneously. The independence
// assumption in the vanilla Poisson binomial inflates P(consensus) during
// correlated outages, causing the gate to wait for unanimity that won't arrive.
//
// Model: conditional independence given provider state
//   P(slot up) = P(provider up) × P(slot up | provider up)
//   p_up (provider availability) estimated conservatively as max(observed rates)
//   q_i (conditional slot rate) = r_i / p_up, clamped to [0, 1]
//
// Per-cluster PMF: P(j available in cluster) =
//   p_up × PoissonBinomialPMF(q_1..q_n, j) + (1 - p_up) × δ(j=0)
//
// Total P(consensus) = convolution of per-cluster PMFs, then sum P(≥minQuorum).

/**
 * poissonBinomialPMF(probabilities) — returns full PMF [P(X=0), P(X=1), ..., P(X=n)].
 * @param {number[]} probabilities
 * @returns {number[]} dp array where dp[j] = P(exactly j successes)
 */
function poissonBinomialPMF(probabilities) {
  const n = probabilities.length;
  const dp = new Array(n + 1).fill(0);
  dp[0] = 1;

  for (let i = 0; i < n; i++) {
    const p = probabilities[i];
    for (let j = i + 1; j >= 1; j--) {
      dp[j] = dp[j] * (1 - p) + dp[j - 1] * p;
    }
    dp[0] *= (1 - p);
  }

  return dp;
}

/**
 * buildFailureDomainClusters(slotRates, providersPath)
 *
 * Reads providers.json and groups active slots by their `provider` field.
 * Only slots present in slotRates are included (inactive slots are ignored).
 *
 * Returns cluster map: { groupName: [slotName, ...], ... }
 *
 * @param {Object} slotRates - { slot_name: availability_rate }
 * @param {string} [providersPath] - path to providers.json
 * @returns {Object} clusters keyed by provider name
 */
function buildFailureDomainClusters(slotRates, providersPath) {
  const activeSlots = Object.keys(slotRates);
  if (activeSlots.length === 0) return {};

  // Resolve providers.json. An explicit providersPath (used by tests) is read
  // directly; otherwise delegate to the single source of truth (issue #197).
  // Canonical installed path: ~/.claude/nf-bin/providers.json
  // (`'.claude', 'nf-bin', 'providers.json'`).
  let providers = [];
  if (providersPath) {
    try {
      providers = JSON.parse(fs.readFileSync(providersPath, 'utf8')).providers || [];
    } catch (_) {}
  } else {
    providers = loadProviders({ baseDir: __dirname }) || [];
  }

  if (providers.length === 0) return {};

  // Build name → provider mapping
  const slotProvider = {};
  for (const entry of providers) {
    if (entry.name && entry.provider) {
      slotProvider[entry.name] = entry.provider;
    }
  }

  // Group active slots by provider
  const clusters = {};
  for (const slot of activeSlots) {
    const group = slotProvider[slot] || '_independent';
    if (!clusters[group]) clusters[group] = [];
    clusters[group].push(slot);
  }

  // Remove single-slot "clusters" — no correlation possible
  for (const key of Object.keys(clusters)) {
    if (clusters[key].length <= 1) delete clusters[key];
  }

  return clusters;
}

/**
 * clusterPMF(rates) — computes P(j slots available) for a cluster under
 * the conditional-independence model.
 *
 * @param {number[]} rates - observed availability rates for slots in the cluster
 * @returns {number[]} PMF array where pmf[j] = P(exactly j available)
 */
function clusterPMF(rates) {
  const n = rates.length;
  if (n === 0) return [1];

  // Estimate provider-level availability (conservative: max observed rate)
  const pUp = Math.max(...rates);

  if (pUp === 0) {
    // Provider completely down
    const pmf = new Array(n + 1).fill(0);
    pmf[0] = 1;
    return pmf;
  }

  // Conditional rates given provider is up
  const conditionalRates = rates.map(function (r) {
    return Math.min(r / pUp, 1.0);
  });

  // P(j | provider up) via Poisson binomial PMF
  const pmfGivenUp = poissonBinomialPMF(conditionalRates);

  // P(j) = pUp * P(j | up) + (1 - pUp) * δ(j = 0)
  const pmf = pmfGivenUp.map(function (p) { return p * pUp; });
  pmf[0] += (1 - pUp);

  return pmf;
}

/**
 * convolvePMFs(a, b) — convolves two probability mass functions.
 * result[k] = sum over i+j=k of a[i] * b[j]
 *
 * @param {number[]} a - PMF for random variable A
 * @param {number[]} b - PMF for random variable B
 * @returns {number[]} PMF for A + B
 */
function convolvePMFs(a, b) {
  const resultLen = a.length + b.length - 1;
  const result = new Array(resultLen).fill(0);

  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      result[i + j] += a[i] * b[j];
    }
  }

  return result;
}

/**
 * detectClusterOutages(clusters, slotRates)
 *
 * Checks whether any failure-domain cluster has ALL slots at rate 0.
 * Returns array of fully-down cluster names.
 *
 * @param {Object} clusters - { groupName: [slotName, ...], ... }
 * @param {Object} slotRates - { slot_name: availability_rate }
 * @returns {string[]} names of fully-down clusters
 */
function detectClusterOutages(clusters, slotRates) {
  const downed = [];
  for (const [group, slots] of Object.entries(clusters)) {
    const allDown = slots.every(function (s) { return (slotRates[s] || 0) === 0; });
    if (allDown) downed.push(group);
  }
  return downed;
}

/**
 * computeClusterAwareConsensus(slotRates, minQuorum, providersPath)
 *
 * Cluster-aware P(consensus) accounting for correlated provider failures.
 * Falls back to independent Poisson binomial when no multi-slot clusters exist.
 *
 * @param {Object} slotRates - { slot_name: availability_rate }
 * @param {number} minQuorum - minimum successful slots needed
 * @param {string} [providersPath] - path to providers.json
 * @returns {{ probability: number, method: string, clusters: Object, clusterOutages: string[] }}
 */
function computeClusterAwareConsensus(slotRates, minQuorum, providersPath) {
  const clusters = buildFailureDomainClusters(slotRates, providersPath);

  // Detect fully-down clusters for immediate escalation
  const clusterOutages = detectClusterOutages(clusters, slotRates);

  // If no multi-slot clusters, fall back to independent model
  if (Object.keys(clusters).length === 0) {
    const independent = computeConsensusProbability(slotRates, minQuorum);
    return {
      probability: independent.probability,
      method: 'independent',
      clusters: {},
      clusterOutages: [],
    };
  }

  // Compute per-cluster PMFs
  // Slots not in any cluster are treated as independent single-slot "clusters"
  const clusteredSlots = new Set();
  for (const slots of Object.values(clusters)) {
    for (const s of slots) clusteredSlots.add(s);
  }

  // Start PMF with the independent (unclustered) slots
  let totalPMF = [1]; // identity for convolution
  for (const [slot, rate] of Object.entries(slotRates)) {
    if (!clusteredSlots.has(slot)) {
      // Independent slot: P(0) = 1-rate, P(1) = rate
      totalPMF = convolvePMFs(totalPMF, [1 - rate, rate]);
    }
  }

  // Convolve in per-cluster PMFs
  for (const [group, slots] of Object.entries(clusters)) {
    const rates = slots.map(function (s) { return slotRates[s] || 0; });
    const pmf = clusterPMF(rates);
    totalPMF = convolvePMFs(totalPMF, pmf);
  }

  // P(consensus) = P(total available >= minQuorum)
  let probability = 0;
  for (let j = minQuorum; j < totalPMF.length; j++) {
    probability += totalPMF[j];
  }
  probability = Math.round(probability * 1e6) / 1e6;

  return {
    probability,
    method: 'cluster-aware',
    clusters,
    clusterOutages,
  };
}

module.exports = {
  checkConsensusGate,
  computeConsensusProbability,
  poissonBinomialCDF,
  computeEarlyEscalation,
  readEarlyEscalationThreshold,
  // Issue #171 — cluster-aware correlated failure model
  poissonBinomialPMF,
  buildFailureDomainClusters,
  clusterPMF,
  convolvePMFs,
  detectClusterOutages,
  computeClusterAwareConsensus,
};

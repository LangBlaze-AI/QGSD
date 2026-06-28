#!/usr/bin/env node
'use strict';
// bin/hypothesis-measure.cjs
// Reads proposed-metrics.json tier-1 assumptions, compares against actual
// trace/scoreboard/telemetry data, and flags VIOLATED assumptions.
// Requirements: QUICK-303

const fs   = require('fs');
const path = require('path');

// ── Path resolution ──────────────────────────────────────────────────────────

let ROOT = process.cwd();
const args = process.argv.slice(2);
for (const arg of args) {
  if (arg.startsWith('--project-root=')) {
    ROOT = path.resolve(arg.slice('--project-root='.length));
  }
}

const jsonMode = args.includes('--json');

// ── Pure Functions (exported for unit testing) ───────────────────────────────

/**
 * Load actual data from up to 4 sources (all fail-open).
 * @param {string} root - project root directory
 * @returns {{ conformance: Object|null, scoreboard: Object|null, telemetry: Object|null, circuitBreaker: Object|null }}
 */
function loadActualData(root) {
  const result = {
    conformance: null,
    scoreboard: null,
    telemetry: null,
    circuitBreaker: null,
  };

  // 1. conformance-events.jsonl
  try {
    const confPath = path.join(root, '.planning', 'formal', 'trace', 'conformance-events.jsonl');
    if (fs.existsSync(confPath)) {
      const lines = fs.readFileSync(confPath, 'utf8').split('\n').filter(Boolean);
      const events = [];
      for (const line of lines) {
        try { events.push(JSON.parse(line)); } catch (_) { /* skip malformed */ }
      }
      // Extract observed maximums
      let maxRounds = 0;
      let maxIterations = 0;
      let totalTransitions = 0;
      for (const e of events) {
        if (typeof e.round === 'number' && e.round > maxRounds) maxRounds = e.round;
        if (typeof e.iteration === 'number' && e.iteration > maxIterations) maxIterations = e.iteration;
        totalTransitions++;
      }
      result.conformance = { maxRounds, maxIterations, totalTransitions, eventCount: events.length };
    }
  } catch (_) { /* fail-open */ }

  // 2. quorum-scoreboard.json
  try {
    let scoreboardPath;
    try {
      const pp = require('./planning-paths.cjs');
      scoreboardPath = pp.resolveWithFallback(root, 'quorum-scoreboard');
    } catch (_) {
      scoreboardPath = path.join(root, '.planning', 'quorum-scoreboard.json');
    }
    if (fs.existsSync(scoreboardPath)) {
      const sb = JSON.parse(fs.readFileSync(scoreboardPath, 'utf8'));
      const rounds = sb.rounds || [];
      // Compute per-slot rates using same logic as export-prism-constants.cjs
      const slots = ['gemini', 'opencode', 'copilot', 'codex'];
      const slotRates = {};
      for (const slot of slots) {
        const participated = rounds.filter(r => {
          const v = r.votes && r.votes[slot];
          return v !== undefined && v !== '' && v !== 'UNAVAILABLE';
        });
        const n = participated.length;
        let tpCount = 0;
        let unavailCount = 0;
        for (const r of participated) {
          const vote = r.votes[slot];
          if (vote === 'TP' || vote === 'TP+') tpCount++;
          else if (vote === 'UNAVAIL') unavailCount++;
        }
        slotRates[slot] = {
          n,
          tpRate: n > 0 ? tpCount / n : 0,
          unavailRate: n > 0 ? unavailCount / n : 0,
        };
      }
      result.scoreboard = { totalRounds: rounds.length, slotRates };
    }
  } catch (_) { /* fail-open */ }

  // 3. telemetry report.json
  try {
    const telPath = path.join(root, '.planning', 'telemetry', 'report.json');
    if (fs.existsSync(telPath)) {
      const report = JSON.parse(fs.readFileSync(telPath, 'utf8'));
      // Extract p95 latencies and failure/hang counts
      const serverStats = {};
      if (report.mcp && report.mcp.servers) {
        for (const [name, stats] of Object.entries(report.mcp.servers)) {
          serverStats[name] = {
            p95Ms: stats.p95Ms || 0,
            failureCount: stats.failureCount || 0,
            hangCount: stats.hangCount || 0,
          };
        }
      }
      result.telemetry = { servers: serverStats };
    }
  } catch (_) { /* fail-open */ }

  // 4. circuit-breaker-state.json
  try {
    const cbPath = path.join(root, '.claude', 'circuit-breaker-state.json');
    if (fs.existsSync(cbPath)) {
      const cb = JSON.parse(fs.readFileSync(cbPath, 'utf8'));
      result.circuitBreaker = {
        triggerCount: typeof cb.triggerCount === 'number' ? cb.triggerCount : 0,
        active: Boolean(cb.active),
      };
    }
  } catch (_) { /* fail-open */ }

  return result;
}

/**
 * Extract formal value from a TLA+ or PRISM source file for a given assumption name.
 * @param {string} sourceModel - absolute path to the model file
 * @param {string} assumptionName - the constant name to find
 * @returns {number|null}
 */
function extractFormalValue(sourceModel, assumptionName) {
  try {
    if (!fs.existsSync(sourceModel)) return null;
    const content = fs.readFileSync(sourceModel, 'utf8');
    const name = assumptionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // TLA+ patterns
    // Pattern: Name == N
    let m = content.match(new RegExp(name + '\\s*==\\s*(\\d+)'));
    if (m) return parseInt(m[1], 10);

    // Pattern: ASSUME Name \in M..N (take upper bound)
    m = content.match(new RegExp('ASSUME\\s+' + name + '\\s*\\\\in\\s*\\d+\\.\\.\\s*(\\d+)'));
    if (m) return parseInt(m[1], 10);

    // Pattern: ASSUME Name = N
    m = content.match(new RegExp('ASSUME\\s+' + name + '\\s*=\\s*(\\d+)'));
    if (m) return parseInt(m[1], 10);

    // PRISM pattern: const TYPE NAME = VALUE;
    m = content.match(new RegExp('const\\s+\\w+\\s+' + name + '\\s*=\\s*([\\d.]+)'));
    if (m) return parseFloat(m[1]);

    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Match an assumption to actual data and produce a verdict.
 * @param {Object} metric - tier-1 metric entry from proposed-metrics.json
 * @param {number|null} formalValue - extracted formal value
 * @param {Object} actualData - from loadActualData()
 * @returns {{ actual_value: number|null, actual_source: string|null, verdict: string, reason: string }}
 */
function compareAssumption(metric, formalValue, actualData) {
  const name = (metric.assumption_name || '').toLowerCase();

  // Try to find a matching actual measurement
  let actualValue = null;
  let actualSource = null;

  // Max rounds/iterations/size/depth/window/filter — match against conformance data
  if (actualData.conformance) {
    if (name.includes('maxdeliberationround') || name.includes('maxdeliberation') || name === 'depth') {
      actualValue = actualData.conformance.maxRounds;
      actualSource = 'conformance-events.jsonl';
    } else if (name.includes('maximprovementiteration') || name.includes('maxfilterround')) {
      actualValue = actualData.conformance.maxIterations;
      actualSource = 'conformance-events.jsonl';
    } else if (name.includes('commitwindow')) {
      // CommitWindow maps to observed transition count
      actualValue = actualData.conformance.totalTransitions;
      actualSource = 'conformance-events.jsonl';
    }
  }

  // TP/UNAVAIL rate assumptions — match against scoreboard
  if (actualValue === null && actualData.scoreboard) {
    if (name.includes('tp_') || name.includes('rate')) {
      // Try to find matching slot
      const slotRates = actualData.scoreboard.slotRates || {};
      for (const [slot, rates] of Object.entries(slotRates)) {
        if (name.includes(slot)) {
          if (name.includes('unavail')) {
            actualValue = rates.unavailRate;
          } else {
            actualValue = rates.tpRate;
          }
          actualSource = 'quorum-scoreboard.json';
          break;
        }
      }
    }
  }

  // Timeout/latency assumptions — match against telemetry
  if (actualValue === null && actualData.telemetry) {
    if (name.includes('timeout') || name.includes('latency')) {
      const servers = actualData.telemetry.servers || {};
      // Use the highest p95 across all servers
      let maxP95 = 0;
      for (const stats of Object.values(servers)) {
        if (stats.p95Ms > maxP95) maxP95 = stats.p95Ms;
      }
      if (maxP95 > 0) {
        actualValue = maxP95;
        actualSource = 'telemetry/report.json';
      }
    }
  }

  // Circuit breaker trigger count
  if (actualValue === null && actualData.circuitBreaker) {
    if (name.includes('trigger') || name.includes('breaker')) {
      actualValue = actualData.circuitBreaker.triggerCount;
      actualSource = 'circuit-breaker-state.json';
    }
  }

  // Produce verdict
  if (formalValue === null || actualValue === null) {
    return {
      actual_value: actualValue,
      actual_source: actualSource,
      verdict: 'UNMEASURABLE',
      reason: formalValue === null
        ? 'formal value not extractable from source model'
        : 'no matching actual data source found',
    };
  }

  // Compare: violated if actual exceeds formal by >10% relative or >2 absolute for small values
  const diff = Math.abs(actualValue - formalValue);
  const relativeDiff = formalValue !== 0 ? diff / Math.abs(formalValue) : (diff > 0 ? Infinity : 0);

  const isSmallValue = Math.abs(formalValue) <= 20;
  const violated = isSmallValue
    ? diff > 2
    : relativeDiff > 0.10;

  return {
    actual_value: actualValue,
    actual_source: actualSource,
    verdict: violated ? 'VIOLATED' : 'CONFIRMED',
    reason: violated
      ? `actual (${actualValue}) exceeds formal (${formalValue}) by ${(relativeDiff * 100).toFixed(1)}% (abs diff: ${diff})`
      : `actual (${actualValue}) within bounds of formal (${formalValue})`,
  };
}

/**
 * Measure all tier-1 hypotheses against actual data.
 * @param {string} root - project root directory
 * @returns {Object} measurement result with verdicts and measurements array
 */
function measureHypotheses(root) {
  // Read proposed-metrics.json
  const metricsPath = path.join(root, '.planning', 'formal', 'evidence', 'proposed-metrics.json');
  if (!fs.existsSync(metricsPath)) {
    return {
      schema_version: '1',
      generated: new Date().toISOString(),
      total_measured: 0,
      verdicts: { CONFIRMED: 0, VIOLATED: 0, UNMEASURABLE: 0 },
      measurements: [],
    };
  }

  let metricsData;
  try {
    metricsData = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  } catch (_) {
    return {
      schema_version: '1',
      generated: new Date().toISOString(),
      total_measured: 0,
      verdicts: { CONFIRMED: 0, VIOLATED: 0, UNMEASURABLE: 0 },
      measurements: [],
    };
  }

  // Filter to tier-1 only (guard against null root, non-array metrics, and null/non-object entries)
  const metricsList = (metricsData && typeof metricsData === 'object' && Array.isArray(metricsData.metrics))
    ? metricsData.metrics
    : [];
  const tier1 = metricsList.filter(m => m && typeof m === 'object' && m.tier === 1);

  // Load actual data from all 4 sources
  const actualData = loadActualData(root);

  // Measure each tier-1 assumption
  const measurements = [];
  const verdictCounts = { CONFIRMED: 0, VIOLATED: 0, UNMEASURABLE: 0 };

  for (const metric of tier1) {
    const formalValue = extractFormalValue(metric.source_model, metric.assumption_name);
    const comparison = compareAssumption(metric, formalValue, actualData);

    measurements.push({
      assumption_name: metric.assumption_name,
      source_model: metric.source_model,
      formal_value: formalValue,
      actual_value: comparison.actual_value,
      actual_source: comparison.actual_source,
      verdict: comparison.verdict,
      reason: comparison.reason,
    });

    verdictCounts[comparison.verdict] = (verdictCounts[comparison.verdict] || 0) + 1;
  }

  const result = {
    schema_version: '1',
    generated: new Date().toISOString(),
    total_measured: tier1.length,
    verdicts: verdictCounts,
    measurements,
  };

  // Write to disk
  const outputPath = path.join(root, '.planning', 'formal', 'evidence', 'hypothesis-measurements.json');
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8');
  } catch (_) { /* fail-open on write error */ }

  return result;
}

// ── Export pure functions for unit testing ───────────────────────────────────
module.exports._pure = { measureHypotheses, loadActualData, extractFormalValue, compareAssumption };

// ── Main ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const result = measureHypotheses(ROOT);

  if (jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    // Human-readable summary
    console.log('[hypothesis-measure] Tier-1 assumption measurement');
    console.log('  Total measured: ' + result.total_measured);
    console.log('  CONFIRMED:     ' + result.verdicts.CONFIRMED);
    console.log('  VIOLATED:      ' + result.verdicts.VIOLATED);
    console.log('  UNMEASURABLE:  ' + result.verdicts.UNMEASURABLE);

    const violated = result.measurements.filter(m => m.verdict === 'VIOLATED');
    if (violated.length > 0) {
      console.log('\n  Violated assumptions:');
      for (const v of violated) {
        console.log('    - ' + v.assumption_name + ' (' + v.source_model + ')');
        console.log('      ' + v.reason);
      }
    }
  }

  process.exit(0);
}

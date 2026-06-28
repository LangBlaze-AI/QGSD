#!/usr/bin/env node
'use strict';

/**
 * bin/harness-diagnostic.cjs — Unified harness diagnostic tool for nForma.
 *
 * Cross-references scoreboard, conformance events, token usage, stall detector,
 * and circuit breaker state into a single structured health report with
 * actionable recommendations.
 *
 * Exports: generateReport, formatTerminalReport
 * CLI: node bin/harness-diagnostic.cjs [--json] [--cwd /path]
 */

const fs = require('fs');
const path = require('path');

// ─── Module resolution helpers ──────────────────────────────────────────────

function tryRequire(modulePath) {
  try { return require(modulePath); } catch (_) { return null; }
}

function findModule(name) {
  return tryRequire(path.join(__dirname, name)) ||
         tryRequire(path.join(__dirname, '..', 'bin', name));
}

// ─── generateReport ─────────────────────────────────────────────────────────

/**
 * Generate a structured harness diagnostic report.
 * @param {string} cwd - Project root directory.
 * @param {Object} [options]
 * @param {Object} [options.config] - Pre-loaded config (optional).
 * @returns {Object} Structured report object.
 */
function generateReport(cwd, options = {}) {
  const report = {
    timestamp: new Date().toISOString(),
    slot_availability: [],
    pass_at_k: { total: 0, pass_at_1: 0, pass_at_3: 0, avg_k: 0 },
    token_spend: {
      total_records: 0,
      total_input: 0,
      total_output: 0,
      by_slot: {},
      note: 'Token values are currently unreliable (all zeros in Claude Code subagent transcripts)',
    },
    stall_events: [],
    circuit_breaker: {
      active: false,
      disabled: false,
      last_triggered: null,
    },
    recommendations: [],
  };

  const planningPaths = findModule('planning-paths.cjs');

  // ── Section 1: Slot Availability from scoreboard ──────────────────────────
  try {
    let scoreboardPath;
    if (planningPaths) {
      scoreboardPath = planningPaths.resolveWithFallback(cwd, 'quorum-scoreboard');
    } else {
      scoreboardPath = path.join(cwd, '.planning', 'quorum', 'scoreboard.json');
    }

    if (fs.existsSync(scoreboardPath)) {
      const scoreboard = JSON.parse(fs.readFileSync(scoreboardPath, 'utf8'));
      const slots = scoreboard.slots || {};
      const slotAgg = Object.create(null);

      for (const [key, data] of Object.entries(slots)) {
        const slotName = key.split(':')[0];
        if (!slotAgg[slotName]) slotAgg[slotName] = { tp: 0, fn: 0 };
        slotAgg[slotName].tp += (data.tp || 0);
        slotAgg[slotName].fn += (data.fn || 0);
      }

      for (const [slotName, agg] of Object.entries(slotAgg)) {
        const total = agg.tp + agg.fn;
        const rate = total > 0 ? agg.tp / total : 0;
        let status = 'unknown';
        if (total > 0) {
          if (rate >= 0.8) status = 'healthy';
          else if (rate >= 0.5) status = 'degraded';
          else status = 'critical';
        }
        report.slot_availability.push({
          slot: slotName,
          total_rounds: total,
          successes: agg.tp,
          failures: agg.fn,
          success_rate: Math.round(rate * 1000) / 1000,
          status,
        });
      }
    }
  } catch (_) {}

  // ── Section 2: Pass@k from conformance events ────────────────────────────
  try {
    const vqh = findModule('verify-quorum-health.cjs');
    if (vqh && vqh.computePassAtKRates) {
      let conformancePath;
      if (planningPaths) {
        conformancePath = planningPaths.resolveWithFallback(cwd, 'conformance-events');
      } else {
        conformancePath = path.join(cwd, '.planning', 'telemetry', 'conformance-events.jsonl');
      }
      report.pass_at_k = vqh.computePassAtKRates(conformancePath);
    }
  } catch (_) {}

  // ── Section 3: Token spend from token-usage.jsonl ─────────────────────────
  try {
    let tokenPath;
    if (planningPaths) {
      tokenPath = planningPaths.resolveWithFallback(cwd, 'token-usage');
    } else {
      tokenPath = path.join(cwd, '.planning', 'telemetry', 'token-usage.jsonl');
    }

    if (fs.existsSync(tokenPath)) {
      const lines = fs.readFileSync(tokenPath, 'utf8').split('\n').filter(l => l.trim());
      report.token_spend.total_records = lines.length;
      const bySlot = {};
      for (const line of lines) {
        try {
          const r = JSON.parse(line);
          const slot = r.slot || 'unknown';
          if (!bySlot[slot]) bySlot[slot] = { input: 0, output: 0, rounds: 0 };
          bySlot[slot].input += (r.input_tokens || 0);
          bySlot[slot].output += (r.output_tokens || 0);
          bySlot[slot].rounds++;
          report.token_spend.total_input += (r.input_tokens || 0);
          report.token_spend.total_output += (r.output_tokens || 0);
        } catch (_) {}
      }
      report.token_spend.by_slot = bySlot;
    }
  } catch (_) {}

  // ── Section 4: Stall events from stall-detector ──────────────────────────
  try {
    const stallDetector = findModule('stall-detector.cjs');
    if (stallDetector && stallDetector.detectStalledSlots) {
      let config = options.config;
      if (!config) {
        try {
          const configLoader = tryRequire(path.join(__dirname, '..', 'hooks', 'config-loader'));
          if (configLoader) config = configLoader.loadConfig(cwd);
        } catch (_) {}
      }
      report.stall_events = stallDetector.detectStalledSlots(cwd, config || {}) || [];
    }
  } catch (_) {}

  // ── Section 5: Circuit breaker status ─────────────────────────────────────
  try {
    const cbPath = path.join(cwd, '.claude', 'circuit-breaker-state.json');
    if (fs.existsSync(cbPath)) {
      const cb = JSON.parse(fs.readFileSync(cbPath, 'utf8'));
      report.circuit_breaker.active = !!cb.active;
      report.circuit_breaker.disabled = !!cb.disabled;
      report.circuit_breaker.last_triggered = cb.last_triggered || cb.lastTriggered || null;
    }
  } catch (_) {}

  // ── Section 6: Recommendations ────────────────────────────────────────────
  const hasData = report.slot_availability.length > 0 ||
                  report.pass_at_k.total > 0 ||
                  report.token_spend.total_records > 0;

  if (!hasData) {
    report.recommendations.push('No quorum data available yet -- run quorum rounds to populate diagnostic data.');
  } else {
    // Slot health recommendations
    for (const slot of report.slot_availability) {
      if (slot.success_rate < 0.5 && slot.total_rounds > 0) {
        const pct = Math.round(slot.success_rate * 100);
        report.recommendations.push(
          `Slot ${slot.slot} has ${pct}% success rate -- consider removing from quorum_active or checking provider health`
        );
      }
    }

    // Stall recommendations
    for (const stall of report.stall_events) {
      if ((stall.consecutiveTimeouts || 0) >= 2) {
        report.recommendations.push(
          `Slot ${stall.slot} has ${stall.consecutiveTimeouts} consecutive timeouts -- run \`node bin/check-mcp-health.cjs\``
        );
      }
    }

    // Pass@k recommendations
    if (report.pass_at_k.total > 0 && report.pass_at_k.pass_at_1 < 0.7) {
      const pct = Math.round(report.pass_at_k.pass_at_1 * 100);
      report.recommendations.push(
        `pass@1 rate at ${pct}% -- quorum requires multiple rounds frequently. Consider adjusting maxDeliberation.`
      );
    }

    // Circuit breaker recommendations
    if (report.circuit_breaker.active) {
      report.recommendations.push(
        'Circuit breaker is ACTIVE -- oscillation detected. Follow resolution procedure.'
      );
    }

    if (report.recommendations.length === 0) {
      report.recommendations.push('No issues detected. Harness is healthy.');
    }
  }

  return report;
}

// ─── formatTerminalReport ───────────────────────────────────────────────────

/**
 * Format report object into a terminal-friendly string.
 * @param {Object} report - Report from generateReport().
 * @returns {string}
 */
function formatTerminalReport(report) {
  report = (report && typeof report === 'object') ? report : {};
  const slotAvailability = Array.isArray(report.slot_availability) ? report.slot_availability : [];
  const passAtK = (report.pass_at_k && typeof report.pass_at_k === 'object') ? report.pass_at_k : { total: 0, pass_at_1: 0, pass_at_3: 0, avg_k: 0 };
  const tokenSpend = (report.token_spend && typeof report.token_spend === 'object') ? report.token_spend : { total_records: 0 };
  const stallEvents = Array.isArray(report.stall_events) ? report.stall_events : [];
  const circuitBreaker = (report.circuit_breaker && typeof report.circuit_breaker === 'object') ? report.circuit_breaker : {};
  const recommendations = Array.isArray(report.recommendations) ? report.recommendations : [];
  const lines = [];

  lines.push('nForma Harness Diagnostic Report');
  lines.push('=================================');
  lines.push(`Generated: ${report.timestamp || 'unknown'}`);
  lines.push('');

  // Slot Availability
  lines.push('## Slot Availability');
  if (slotAvailability.length === 0) {
    lines.push('  No slot data available.');
  } else {
    lines.push('  slot           rounds   success   rate     status');
    lines.push('  -----------------------------------------------');
    for (const s of slotAvailability) {
      const rate = (s.success_rate * 100).toFixed(1) + '%';
      lines.push(
        '  ' +
        s.slot.padEnd(15) +
        String(s.total_rounds).padStart(6) +
        String(s.successes).padStart(10) +
        rate.padStart(9) +
        '    ' + s.status
      );
    }
  }
  lines.push('');

  // Pass@k
  lines.push('## Pass@k Consensus Efficiency');
  if (passAtK.total === 0) {
    lines.push('  No pass@k data available.');
  } else {
    lines.push(`  pass@1:    ${(passAtK.pass_at_1 * 100).toFixed(1)}%`);
    lines.push(`  pass@3:    ${(passAtK.pass_at_3 * 100).toFixed(1)}%`);
    lines.push(`  avg rounds: ${passAtK.avg_k.toFixed(1)}`);
    lines.push(`  total events: ${passAtK.total}`);
  }
  lines.push('');

  // Token Spend
  lines.push('## Token Spend');
  lines.push('  Note: Token values unreliable (all zeros)');
  lines.push(`  total records: ${tokenSpend.total_records}`);
  lines.push('');

  // Stall Events
  lines.push('## Stall Events');
  if (stallEvents.length === 0) {
    lines.push('  No stalled slots detected.');
  } else {
    for (const s of stallEvents) {
      lines.push(`  ${s.slot}: ${s.consecutiveTimeouts} consecutive timeouts (last: ${s.lastSeen || 'unknown'})`);
    }
  }
  lines.push('');

  // Circuit Breaker
  lines.push('## Circuit Breaker');
  if (circuitBreaker.active) {
    lines.push('  Status: ACTIVE (oscillation detected)');
  } else if (circuitBreaker.disabled) {
    lines.push('  Status: disabled');
  } else {
    lines.push('  Status: inactive');
  }
  lines.push('');

  // Recommendations
  lines.push('## Recommendations');
  for (const r of recommendations) {
    lines.push(`  - ${r}`);
  }

  return lines.join('\n');
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const jsonFlag = args.includes('--json');
  const cwdIdx = args.indexOf('--cwd');
  const cwd = cwdIdx >= 0 && args[cwdIdx + 1] ? args[cwdIdx + 1] : process.cwd();

  const report = generateReport(cwd);

  if (jsonFlag) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatTerminalReport(report) + '\n');
  }

  process.exit(0);
}

module.exports = { generateReport, formatTerminalReport };

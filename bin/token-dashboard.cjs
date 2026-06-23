#!/usr/bin/env node
'use strict';
// bin/token-dashboard.cjs
// Token usage dashboard CLI — aggregates cost data from token-usage.jsonl.
// Zero external dependencies. Uses only Node.js built-ins (fs, path).

const fs = require('fs');
const path = require('path');
const planningPaths = require('./planning-paths.cjs');

// Cost per million tokens (estimated, approximate)
const COST_PER_M = {
  // Anthropic models (via Claude Code)
  'claude':    { input: 15.00, output: 75.00 },
  'sonnet':    { input: 3.00,  output: 15.00 },
  'haiku':     { input: 0.25,  output: 1.25 },
  // Third-party (via ccr/MCP)
  'codex':     { input: 2.50,  output: 10.00 },
  'gemini':    { input: 1.25,  output: 5.00 },
  'opencode':  { input: 2.00,  output: 8.00 },
  'copilot':   { input: 0.00,  output: 0.00, subscription: true },
  'default':   { input: 3.00,  output: 15.00 },
};

/**
 * Parse token-usage.jsonl file into array of record objects.
 * Skips empty and malformed lines (fail-open). Returns [] if file missing.
 * @param {string} jsonlPath - Path to token-usage.jsonl
 * @returns {Array<object>}
 */
function parseTokenUsage(jsonlPath) {
  try {
    if (!fs.existsSync(jsonlPath)) return [];
    const content = fs.readFileSync(jsonlPath, 'utf8');
    const lines = content.split('\n');
    const records = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch (_) {
        // Skip malformed lines
      }
    }
    return records;
  } catch (_) {
    return [];
  }
}

/**
 * Extract slot family from slot name (strip trailing -N).
 * e.g. 'codex-1' -> 'codex', 'gemini-2' -> 'gemini', 'claude' -> 'claude'
 * @param {string} slot
 * @returns {string}
 */
function slotFamily(slot) {
  if (!slot) return 'unknown';
  return slot.replace(/-\d+$/, '');
}

/**
 * Aggregate records by slot family.
 * @param {Array<object>} records
 * @returns {Map<string, {input: number, output: number, cacheHit: number, recordCount: number}>}
 */
function aggregateBySlot(records) {
  const map = new Map();
  for (const r of records) {
    const family = slotFamily(r.slot);
    if (!map.has(family)) {
      map.set(family, { input: 0, output: 0, cacheHit: 0, recordCount: 0 });
    }
    const agg = map.get(family);
    agg.input += (r.input_tokens || 0);
    agg.output += (r.output_tokens || 0);
    agg.cacheHit += (r.cache_read_input_tokens || 0);
    agg.recordCount += 1;
  }
  return map;
}

/**
 * Aggregate records by session_id.
 * @param {Array<object>} records
 * @returns {Map<string, {input: number, output: number, ts: string, recordCount: number}>}
 */
function aggregateBySession(records) {
  const map = new Map();
  for (const r of records) {
    const sid = r.session_id || 'unknown';
    if (!map.has(sid)) {
      map.set(sid, { input: 0, output: 0, ts: r.ts || '', recordCount: 0 });
    }
    const agg = map.get(sid);
    agg.input += (r.input_tokens || 0);
    agg.output += (r.output_tokens || 0);
    // Track earliest timestamp
    if (r.ts && (!agg.ts || r.ts < agg.ts)) {
      agg.ts = r.ts;
    }
    agg.recordCount += 1;
  }
  return map;
}

/**
 * Estimate cost for a slot family given token counts.
 * Cache read tokens charged at 10% of input rate.
 * For subscription-based slots, returns { cost: 0, isSubscription: true }.
 * @param {string} family - Slot family name
 * @param {number} inputTokens - Input token count
 * @param {number} outputTokens - Output token count
 * @param {number} [cacheReadTokens=0] - Cache read token count
 * @returns {{cost: number, isSubscription?: boolean}}
 */
function estimateCost(family, inputTokens, outputTokens, cacheReadTokens) {
  const rates = COST_PER_M[family] || COST_PER_M['default'];
  if (rates.subscription) {
    return { cost: 0, isSubscription: true };
  }
  const cacheRead = cacheReadTokens || 0;
  const inputCost = (inputTokens / 1_000_000) * rates.input;
  const outputCost = (outputTokens / 1_000_000) * rates.output;
  const cacheCost = (cacheRead / 1_000_000) * rates.input * 0.1;
  return { cost: inputCost + outputCost + cacheCost };
}

/**
 * Format number with commas.
 * @param {number} n
 * @returns {string}
 */
function fmtNum(n) {
  if (n == null || isNaN(n)) return '0';
  return n.toLocaleString('en-US');
}

/**
 * Format the full dashboard output as a string.
 * @param {Array<object>} records
 * @param {object} [options]
 * @param {number} [options.last] - Limit to last N sessions
 * @param {boolean} [options.json] - Output as JSON
 * @returns {string}
 */
function formatDashboard(records, options) {
  options = options || {};

  if (!records || records.length === 0) {
    // Honor the --json contract even with no data: emit a valid empty-shape
    // object (same structure as the populated result) so callers that
    // JSON.parse the output don't choke on a human string.
    if (options.json) {
      return JSON.stringify({ slots: {}, sessions: {}, total: { input: 0, output: 0, estimatedCost: 0 } }, null, 2);
    }
    return 'No token usage data found.';
  }

  // Filter to last N sessions if requested
  let filteredRecords = records;
  if (options.last) {
    const sessionMap = aggregateBySession(records);
    const sessions = [...sessionMap.entries()]
      .sort((a, b) => (b[1].ts || '').localeCompare(a[1].ts || ''))
      .slice(0, options.last)
      .map(e => e[0]);
    const sessionSet = new Set(sessions);
    filteredRecords = records.filter(r => sessionSet.has(r.session_id || 'unknown'));
  }

  if (options.json) {
    const slotAgg = aggregateBySlot(filteredRecords);
    const sessionAgg = aggregateBySession(filteredRecords);
    const result = {
      slots: {},
      sessions: {},
      total: { input: 0, output: 0, estimatedCost: 0 },
    };
    for (const [family, agg] of slotAgg) {
      const cost = estimateCost(family, agg.input, agg.output, agg.cacheHit);
      result.slots[family] = { ...agg, estimatedCost: cost.isSubscription ? 'subscription' : cost.cost };
      if (!cost.isSubscription) {
        result.total.estimatedCost += cost.cost;
      }
      result.total.input += agg.input;
      result.total.output += agg.output;
    }
    for (const [sid, agg] of sessionAgg) {
      result.sessions[sid] = agg;
    }
    return JSON.stringify(result, null, 2);
  }

  // Table format
  const slotAgg = aggregateBySlot(filteredRecords);
  const lines = [];

  lines.push('Token Usage Dashboard (estimated costs)');
  lines.push('\u2550'.repeat(55));

  // Header
  const hdr = padRow('Slot', 'Input', 'Output', 'Cache Hit%', 'Est. Cost');
  lines.push(hdr);
  lines.push('\u2500'.repeat(55));

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheHit = 0;
  let totalCost = 0;
  let hasSubscription = false;

  const sortedSlots = [...slotAgg.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  for (const [family, agg] of sortedSlots) {
    const totalTokens = agg.input + agg.cacheHit;
    const cacheHitPct = totalTokens > 0 ? Math.round((agg.cacheHit / totalTokens) * 100) : 0;
    const cost = estimateCost(family, agg.input, agg.output, agg.cacheHit);
    const costStr = cost.isSubscription ? 'subscription' : `$${cost.cost.toFixed(2)}`;

    lines.push(padRow(
      family,
      fmtNum(agg.input),
      fmtNum(agg.output),
      `${cacheHitPct}%`,
      costStr
    ));

    totalInput += agg.input;
    totalOutput += agg.output;
    totalCacheHit += agg.cacheHit;
    if (cost.isSubscription) {
      hasSubscription = true;
    } else {
      totalCost += cost.cost;
    }
  }

  lines.push('\u2500'.repeat(55));
  const totalTokens = totalInput + totalCacheHit;
  const totalCacheHitPct = totalTokens > 0 ? Math.round((totalCacheHit / totalTokens) * 100) : 0;
  const totalCostStr = hasSubscription ? `$${totalCost.toFixed(2)}*` : `$${totalCost.toFixed(2)}`;
  lines.push(padRow('TOTAL', fmtNum(totalInput), fmtNum(totalOutput), `${totalCacheHitPct}%`, totalCostStr));

  if (hasSubscription) {
    lines.push('');
    lines.push('* Total excludes subscription-based slots');
  }

  return lines.join('\n');
}

/**
 * Pad a row of columns to fixed widths.
 */
function padRow(slot, input, output, cacheHit, cost) {
  return [
    slot.padEnd(14),
    input.toString().padStart(12),
    output.toString().padStart(12),
    cacheHit.toString().padStart(12),
    ('  ' + cost).padStart(14),
  ].join('');
}

// CLI entrypoint
if (require.main === module) {
  const args = process.argv.slice(2);

  // Parse --help
  if (args.includes('--help') || args.includes('-h')) {
    process.stderr.write([
      'Usage: node bin/token-dashboard.cjs [options]',
      '',
      'Options:',
      '  --last N        Show last N sessions (default: 5)',
      '  --jsonl PATH    Path to token-usage.jsonl (default: .planning/telemetry/token-usage.jsonl, with legacy fallback)',
      '  --json          Output as JSON instead of formatted table',
      '  --help, -h      Show this help message',
      '',
    ].join('\n') + '\n');
    process.exit(0);
  }

  // Parse args
  let last = 5;
  // Default to the canonical telemetry path (with legacy flat-layout fallback).
  // Previously hardcoded the legacy `.planning/token-usage.jsonl`, which no
  // longer exists post-migration — so the dashboard always reported "no data".
  let jsonlPath = planningPaths.resolveWithFallback(process.cwd(), 'token-usage');
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--last' && args[i + 1]) {
      last = parseInt(args[i + 1], 10) || 5;
      i++;
    } else if (args[i] === '--jsonl' && args[i + 1]) {
      jsonlPath = args[i + 1];
      i++;
    } else if (args[i] === '--json') {
      jsonOutput = true;
    }
  }

  const records = parseTokenUsage(jsonlPath);
  const output = formatDashboard(records, { last, json: jsonOutput });
  process.stdout.write(output + '\n');
  process.exit(0);
}

module.exports = { parseTokenUsage, aggregateBySlot, aggregateBySession, estimateCost, formatDashboard, COST_PER_M, slotFamily };

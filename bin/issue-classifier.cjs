#!/usr/bin/env node
'use strict';

/**
 * issue-classifier.cjs
 *
 * Reads .planning/telemetry/report.json, ranks operational issues by severity,
 * writes .planning/telemetry/pending-fixes.json with up to 3 prioritized issues.
 *
 * NEVER invokes Claude or any MCP tool. Pure disk I/O.
 *
 * Priority scoring:
 *   alwaysFailing server:        100  (token waste on every quorum round)
 *   circuitBreaker.active:        90  (oscillation active — blocks progress)
 *   hangCount > 5 for server:     80  (degrades quorum latency)
 *   quorumFailureRate > 0.5:      70  (majority of rounds have no quorum)
 *   slowServer with p95 > 30s:    60  (chronic latency)
 *   circuitBreaker.triggerCount > 3: 50 (repeated oscillation history)
 *
 * Usage:
 *   node bin/issue-classifier.cjs
 */

const fs   = require('fs');
const path = require('path');

const PROJECT_DIR   = process.cwd();
const TELEMETRY_DIR = path.join(PROJECT_DIR, '.planning', 'telemetry');
const REPORT_PATH   = path.join(TELEMETRY_DIR, 'report.json');
const FIXES_PATH    = path.join(TELEMETRY_DIR, 'pending-fixes.json');

// ─── Helpers ──────────────────────────────────────────────────────────────────
function slug(str) {
  return String(str == null ? '' : str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function writeEmpty(reason) {
  if (reason) process.stderr.write('[issue-classifier] ' + reason + '\n');
  fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
  const out = { generatedAt: new Date().toISOString(), issues: [] };
  fs.writeFileSync(FIXES_PATH, JSON.stringify(out, null, 2), 'utf8');
  console.log('[issue-classifier] pending-fixes.json written (0 issues)');
  process.exit(0);
}

// ─── Load report.json ─────────────────────────────────────────────────────────
let report;
try {
  if (!fs.existsSync(REPORT_PATH)) writeEmpty('report.json not found');
  report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
} catch (err) {
  writeEmpty('Failed to parse report.json: ' + err.message);
}

if (!report || typeof report !== 'object' || Array.isArray(report)) {
  writeEmpty('report.json is not an object');
}

const mcp            = report.mcp            || {};
const quorum         = report.quorum         || {};
const circuitBreaker = report.circuitBreaker || {};

const issues = [];
const now    = new Date().toISOString();

// ─── Rule 1: Always-failing servers (100 pts each) ────────────────────────────
for (const serverName of (mcp.alwaysFailing || [])) {
  issues.push({
    id:          'mcp-always-failing-' + slug(serverName),
    priority:    100,
    description: `MCP server "${serverName}" has never succeeded — it wastes tokens on every quorum round.`,
    action:      `Remove or disable "${serverName}" from ~/.claude.json mcpServers, or investigate its endpoint.`,
    surfaced:    false,
    detectedAt:  now,
  });
}

// ─── Rule 2: Circuit breaker active (90 pts) ──────────────────────────────────
if (circuitBreaker.active === true) {
  issues.push({
    id:          'circuit-breaker-active',
    priority:    90,
    description: 'Circuit breaker is currently active — oscillation was detected and execution is paused.',
    action:      'Run /nf:debug to diagnose the oscillation root cause, then run `npx nforma --reset-breaker`.',
    surfaced:    false,
    detectedAt:  now,
  });
}

// ─── Rule 3: High hang count (80 pts) ─────────────────────────────────────────
for (const [serverName, stats] of Object.entries(mcp.servers || {})) {
  if (stats && typeof stats === 'object' && (stats.hangCount || 0) > 5) {
    issues.push({
      id:          'mcp-high-hangs-' + slug(serverName),
      priority:    80,
      description: `MCP server "${serverName}" hung ${stats.hangCount} times (>60s) — it degrades quorum latency significantly.`,
      action:      `Raise CLAUDE_MCP_TIMEOUT_MS or switch "${serverName}" to a faster provider in ~/.claude.json.`,
      surfaced:    false,
      detectedAt:  now,
    });
  }
}

// ─── Rule 4: High quorum failure rate (70 pts) ───────────────────────────────
if ((quorum.quorumFailureRate || 0) > 0.5 && (quorum.totalRounds || 0) > 0) {
  const pct = Math.round(quorum.quorumFailureRate * 100);
  issues.push({
    id:          'quorum-high-failure-rate',
    priority:    70,
    description: `${pct}% of quorum rounds had no available external models — consensus quality is severely degraded.`,
    action:      'Check provider API keys and quotas; run `node bin/check-mcp-health.cjs` to identify unavailable models.',
    surfaced:    false,
    detectedAt:  now,
  });
}

// ─── Rule 5: Slow server p95 > 30s (60 pts) ──────────────────────────────────
for (const slow of (mcp.slowServers || [])) {
  if ((slow.p95Ms || 0) > 30000) {
    const p95s = (slow.p95Ms / 1000).toFixed(0);
    issues.push({
      id:          'mcp-slow-server-' + slug(slow.name),
      priority:    60,
      description: `MCP server "${slow.name}" has p95 latency of ${p95s}s — it chronically slows quorum rounds.`,
      action:      `Raise CLAUDE_MCP_TIMEOUT_MS or route "${slow.name}" via a faster provider endpoint.`,
      surfaced:    false,
      detectedAt:  now,
    });
  }
}

// ─── Rule 6: Repeated circuit breaker triggers (50 pts) ──────────────────────
if (!circuitBreaker.active && (circuitBreaker.triggerCount || 0) > 3) {
  issues.push({
    id:          'circuit-breaker-repeated-triggers',
    priority:    50,
    description: `Circuit breaker has triggered ${circuitBreaker.triggerCount} times — recurring oscillation pattern detected.`,
    action:      'Run /nf:discuss-phase to review recent commit patterns; consider adding explicit done-criteria to plans.',
    surfaced:    false,
    detectedAt:  now,
  });
}

// ─── Sort by priority desc, take top 3 ───────────────────────────────────────
issues.sort((a, b) => b.priority - a.priority);
const top3 = issues.slice(0, 3);

// ─── Write output ─────────────────────────────────────────────────────────────
fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
const output = {
  generatedAt: now,
  issues:      top3,
};
fs.writeFileSync(FIXES_PATH, JSON.stringify(output, null, 2), 'utf8');
console.log('[issue-classifier] pending-fixes.json written (' + top3.length + ' issues)');

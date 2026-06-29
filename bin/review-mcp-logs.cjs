#!/usr/bin/env node
'use strict';

/**
 * review-mcp-logs.cjs
 *
 * Scans ~/.claude/debug/*.txt for MCP tool call timing, failures, and hang
 * patterns. Outputs a structured report surfacing automation opportunities.
 *
 * Usage:
 *   node bin/review-mcp-logs.cjs [--files N] [--days N] [--json] [--tool <name>]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};
const hasFlag = (flag) => args.includes(flag);

const _maxFilesRaw = parseInt(getArg('--files') ?? '50', 10);
const MAX_FILES    = Number.isFinite(_maxFilesRaw) && _maxFilesRaw > 0 ? _maxFilesRaw : 50;
const _maxDaysRaw  = parseInt(getArg('--days')  ?? '7',  10);
const MAX_DAYS     = Number.isFinite(_maxDaysRaw) && _maxDaysRaw >= 0 ? _maxDaysRaw : 7;
const JSON_OUTPUT = hasFlag('--json');
const TOOL_FILTER = getArg('--tool');

// ─── Paths ────────────────────────────────────────────────────────────────────
const DEBUG_DIR = path.join(os.homedir(), '.claude', 'debug');

// ─── Regex patterns ───────────────────────────────────────────────────────────
// MCP tool timing lines emitted by Claude Code
const RE_RUNNING  = /MCP server "([^"]+)": Tool '([^']+)' still running \((\d+)s elapsed\)/;
const RE_COMPLETE = /MCP server "([^"]+)": Tool '([^']+)' completed successfully in (\d+)ms/;
const RE_FAILED   = /MCP server "([^"]+)": Tool '([^']+)' failed after (\d+)s: (.+)/;
const RE_CALLING  = /MCP server "([^"]+)": Calling MCP tool: (.+)/;
const RE_STDERR   = /MCP server "([^"]+)" Server stderr: (.+)/;
const RE_CONNECT  = /MCP server "([^"]+)": Successfully connected .+ in (\d+)ms/;
const RE_TOOL_ERR = /mcp__([^_]+)__(\S+) tool error \((\d+)ms\): (.+)/;
const RE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/;

// ─── Data structures ──────────────────────────────────────────────────────────
const servers   = Object.create(null);   // serverName -> { calls: [], failures: [], hangs: [] }
const timeline  = [];   // [{ts, server, tool, durationMs, status}]
const stderrLog = Object.create(null);   // serverName -> [messages]

function ensureServer(name) {
  if (!servers[name]) {
    servers[name] = { calls: [], failures: [], hangs: [], connectMs: null };
  }
  return servers[name];
}

// ─── Parse files ──────────────────────────────────────────────────────────────
const cutoff = Date.now() - MAX_DAYS * 86400 * 1000;

let files;
try {
  files = fs.readdirSync(DEBUG_DIR)
    .filter(f => f.endsWith('.txt'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(DEBUG_DIR, f)).mtimeMs }))
    .filter(f => f.mtime >= cutoff)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_FILES)
    .map(f => path.join(DEBUG_DIR, f.name));
} catch {
  console.error(`Cannot read debug dir: ${DEBUG_DIR}`);
  process.exit(1);
}

if (files.length === 0) {
  console.log(`No debug files found in last ${MAX_DAYS} days at ${DEBUG_DIR}`);
  process.exit(0);
}

for (const file of files) {
  let content;
  try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }

  for (const line of content.split('\n')) {
    const tsMatch = line.match(RE_TIMESTAMP);
    const ts = tsMatch ? new Date(tsMatch[1]).getTime() : 0;

    let m;

    if ((m = line.match(RE_COMPLETE))) {
      const [, server, tool, ms] = m;
      if (TOOL_FILTER && !server.includes(TOOL_FILTER) && !tool.includes(TOOL_FILTER)) continue;
      const s = ensureServer(server);
      s.calls.push({ tool, durationMs: parseInt(ms, 10), status: 'ok', ts });
      timeline.push({ ts, server, tool, durationMs: parseInt(ms, 10), status: 'ok' });
    }

    else if ((m = line.match(RE_FAILED))) {
      const [, server, tool, sec, reason] = m;
      if (TOOL_FILTER && !server.includes(TOOL_FILTER) && !tool.includes(TOOL_FILTER)) continue;
      const s = ensureServer(server);
      const durationMs = parseInt(sec, 10) * 1000;
      s.failures.push({ tool, durationMs, reason: reason.trim(), ts });
      timeline.push({ ts, server, tool, durationMs, status: 'fail', reason: reason.trim() });
      if (durationMs > 60000) s.hangs.push({ tool, durationMs, reason: reason.trim(), ts });
    }

    else if ((m = line.match(RE_TOOL_ERR))) {
      const [, serverPart, tool, ms, reason] = m;
      const server = `claude-${serverPart}`;
      if (TOOL_FILTER && !server.includes(TOOL_FILTER) && !tool.includes(TOOL_FILTER)) continue;
      const s = ensureServer(server);
      const durationMs = parseInt(ms, 10);
      s.failures.push({ tool, durationMs, reason: reason.trim(), ts, fromToolError: true });
    }

    else if ((m = line.match(RE_CONNECT))) {
      const [, server, ms] = m;
      ensureServer(server).connectMs = parseInt(ms, 10);
    }

    else if ((m = line.match(RE_STDERR))) {
      const [, server, msg] = m;
      if (!stderrLog[server]) stderrLog[server] = [];
      stderrLog[server].push(msg.trim());
    }
  }
}

// ─── Compute per-server stats ─────────────────────────────────────────────────
const serverStats = Object.create(null);
for (const [name, data] of Object.entries(servers)) {
  const ok = data.calls;
  const failed = data.failures;
  const durations = ok.map(c => c.durationMs);

  serverStats[name] = {
    totalCalls:    ok.length + failed.length,
    successCount:  ok.length,
    failureCount:  failed.length,
    hangCount:     data.hangs.length,
    connectMs:     data.connectMs,
    p50Ms:  percentile(durations, 50),
    p95Ms:  percentile(durations, 95),
    maxMs:  durations.length ? Math.max(...durations) : 0,
    failures:      failed,
    hangs:         data.hangs,
  };
}

// ─── Automation patterns ──────────────────────────────────────────────────────
// Find tools that always fail — automation target: add to UNAVAIL skip list
const alwaysFailing = Object.entries(serverStats)
  .filter(([, s]) => s.totalCalls > 0 && s.successCount === 0)
  .map(([name]) => name);

// Find tools with consistent long latency — automation target: increase timeout or route differently
const slowServers = Object.entries(serverStats)
  .filter(([, s]) => s.p95Ms > 30000 && s.successCount > 0)
  .sort(([, a], [, b]) => b.p95Ms - a.p95Ms);

// Find recurring error messages — may hint at config fixes
const errorFreq = Object.create(null);
for (const [server, data] of Object.entries(servers)) {
  for (const f of data.failures) {
    const key = f.reason.slice(0, 80);
    errorFreq[key] = (errorFreq[key] ?? 0) + 1;
  }
}
const topErrors = Object.entries(errorFreq)
  .sort(([, a], [, b]) => b - a)
  .slice(0, 8);

// ─── Output ───────────────────────────────────────────────────────────────────
if (JSON_OUTPUT) {
  console.log(JSON.stringify({ serverStats, alwaysFailing, slowServers: slowServers.map(([n, s]) => ({ name: n, p95Ms: s.p95Ms, maxMs: s.maxMs })), topErrors }, null, 2));
  process.exit(0);
}

const hr = '─'.repeat(60);
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const red   = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow= (s) => `\x1b[33m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const cyan  = (s) => `\x1b[36m${s}\x1b[0m`;
const dim   = (s) => `\x1b[2m${s}\x1b[0m`;

const fmtMs = (ms) => {
  if (!ms) return dim('—');
  if (ms >= 60000) return red(`${(ms/1000).toFixed(0)}s`);
  if (ms >= 10000) return yellow(`${(ms/1000).toFixed(1)}s`);
  return green(`${ms}ms`);
};

console.log(`\n${bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}`);
console.log(bold(' nForma ► MCP LOG REVIEW'));
console.log(bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
console.log(dim(` Scanned: ${files.length} debug files | Last ${MAX_DAYS} days | ${DEBUG_DIR}`));
console.log();

// ── Per-server table ──────────────────────────────────────────────────────────
console.log(bold('MCP SERVER HEALTH'));
console.log(hr);

const colW = [22, 6, 6, 6, 6, 10, 10, 10];
const header = [
  'Server', 'Calls', 'OK', 'Fail', 'Hang', 'p50', 'p95', 'max'
].map((h, i) => h.padEnd(colW[i])).join('  ');
console.log(dim(header));

for (const [name, s] of Object.entries(serverStats).sort(([a],[b]) => a.localeCompare(b))) {
  const failColor = s.failureCount > 0 ? red : green;
  const hangColor = s.hangCount > 0 ? red : dim;
  const row = [
    name.slice(0, 21).padEnd(colW[0]),
    String(s.totalCalls).padEnd(colW[1]),
    green(String(s.successCount)).padEnd(colW[2] + 9),
    failColor(String(s.failureCount)).padEnd(colW[3] + 9),
    hangColor(String(s.hangCount)).padEnd(colW[4] + 9),
    fmtMs(s.p50Ms).padEnd(colW[5] + 9),
    fmtMs(s.p95Ms).padEnd(colW[6] + 9),
    fmtMs(s.maxMs),
  ].join('  ');
  console.log(row);
}
console.log();

// ── Failures detail ───────────────────────────────────────────────────────────
const allFailures = Object.entries(serverStats)
  .flatMap(([server, s]) => s.failures.map(f => ({ server, ...f })))
  .sort((a, b) => b.ts - a.ts)
  .slice(0, 15);

if (allFailures.length > 0) {
  console.log(bold('RECENT FAILURES (last 15)'));
  console.log(hr);
  for (const f of allFailures) {
    const dt = f.ts ? new Date(f.ts).toISOString().slice(0,19).replace('T',' ') : '?';
    console.log(`  ${dim(dt)}  ${yellow(f.server)}  ${cyan(f.tool)}  ${fmtMs(f.durationMs)}`);
    console.log(`    ${dim(f.reason.slice(0, 100))}`);
  }
  console.log();
}

// ── Automation insights ───────────────────────────────────────────────────────
console.log(bold('AUTOMATION INSIGHTS'));
console.log(hr);

if (alwaysFailing.length > 0) {
  console.log(red('  ✗ Always-failing servers (add to UNAVAIL skip list):'));
  alwaysFailing.forEach(s => console.log(`    • ${s}`));
  console.log();
}

if (slowServers.length > 0) {
  console.log(yellow('  ⚠ Chronically slow servers (p95 > 30s):'));
  slowServers.forEach(([name, s]) => {
    console.log(`    • ${name}  p95=${fmtMs(s.p95Ms)}  max=${fmtMs(s.maxMs)}`);
    console.log(`      → consider raising CLAUDE_MCP_TIMEOUT_MS or routing via faster provider`);
  });
  console.log();
}

if (topErrors.length > 0) {
  console.log(cyan('  ↻ Most common error patterns:'));
  topErrors.forEach(([msg, count]) => {
    console.log(`    [${count}x] ${dim(msg)}`);
  });
  console.log();
}

// ── Suggested CLAUDE_MCP_TIMEOUT_MS ──────────────────────────────────────────
const allP95 = Object.values(serverStats).map(s => s.p95Ms).filter(Boolean);
if (allP95.length > 0) {
  const suggested = Math.max(60000, Math.min(300000, Math.ceil(Math.max(...allP95) * 1.5 / 10000) * 10000));
  console.log(bold('SUGGESTED CONFIG'));
  console.log(hr);
  console.log(`  CLAUDE_MCP_TIMEOUT_MS=${suggested}  ${dim('(1.5× observed p95 max, capped 60s–300s)')}`);
  console.log(`  ${dim('Set this in ~/.claude.json env for claude-deepseek/minimax/etc.')}`);
  console.log();
}

console.log(bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
console.log(dim(` Run with --json for machine-readable output`));
console.log(dim(` Run with --tool <name> to filter a specific server`));
console.log(dim(` Run with --days N to change lookback window`));
console.log();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

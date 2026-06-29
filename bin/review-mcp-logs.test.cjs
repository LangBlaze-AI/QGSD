#!/usr/bin/env node
'use strict';
// Test suite for bin/review-mcp-logs.cjs
// Uses Node.js built-in test runner: node --test bin/review-mcp-logs.test.cjs
//
// Tests spawn the CLI as a subprocess to avoid process.exit() contaminating the runner.
// Synthetic .txt log files are written to the real ~/.claude/debug/ directory (since
// DEBUG_DIR is hardcoded from os.homedir() at module top-level with no env override).
//
// IMPORTANT: The CLI calls process.exit(0) immediately after console.log(JSON.stringify(...))
// on the --json path. When the real debug dir is large (200KB+ output), the pipe buffer can
// overflow before process.exit flushes stdout, truncating JSON. Tests use --tool filter with
// unique server name prefixes to keep JSON output small and avoid pipe overflow.
//
// All temp files are cleaned up in finally blocks.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, 'review-mcp-logs.cjs');
const DEBUG_DIR = path.join(os.homedir(), '.claude', 'debug');

// Helper: write a synthetic .txt log file to the real debug dir.
// Returns the full file path for cleanup.
function writeSyntheticLog(lines) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const filename = `nf-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  const filePath = path.join(DEBUG_DIR, filename);
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  return filePath;
}

// Helper: spawn the CLI with given args, return { stdout, stderr, exitCode }
function runCLI(args) {
  const result = spawnSync('node', [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
    timeout: 8000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
  };
}

// Helper: safe cleanup — removes a file if it exists
function cleanup(filePath) {
  try { fs.unlinkSync(filePath); } catch (_) {}
}

// TC1: No qualifying files (--days 0 forces cutoff to now — no files from the future)
// The debug dir must exist (otherwise the CLI exits 1). We guarantee existence via mkdirSync.
// With --days 0, cutoff = Date.now(), so no pre-existing files qualify → empty result.
test('TC1: --days 0 produces no qualifying files, exits 0 with appropriate message', () => {
  // Ensure the debug dir exists so the CLI doesn't hit the process.exit(1) catch block
  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  const { stdout, exitCode } = runCLI(['--days', '0']);
  assert.strictEqual(exitCode, 0, 'exit code must be 0 when no files qualify');
  // The CLI prints: "No debug files found in last N days at <path>"
  assert.ok(stdout.length > 0, 'stdout must have some output');
  assert.ok(stdout.includes('No debug files found'), 'stdout must include "No debug files found"');
});

// TC2: Synthetic log file with a successful tool call → --json output contains server entry.
// Uses --tool nf-tc2-svc to filter to only our synthetic server, keeping JSON output small
// and avoiding pipe buffer overflow on machines with large real debug dirs.
test('TC2: synthetic successful tool call shows up in --json serverStats', () => {
  const serverName = 'nf-tc2-svc';
  const logFile = writeSyntheticLog([
    `2026-02-22T10:00:00.000Z MCP server "${serverName}": Tool 'test-tool' completed successfully in 150ms`,
  ]);
  try {
    const { stdout, exitCode } = runCLI(['--json', '--days', '1', '--tool', 'nf-tc2']);
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      assert.fail(`stdout must be valid JSON; got parse error: ${e.message}. stdout[:200]: ${stdout.slice(0, 200)}`);
    }
    assert.ok(parsed.serverStats, 'parsed result must have serverStats key');
    assert.ok(parsed.serverStats[serverName], `serverStats must contain "${serverName}"`);
    assert.ok(
      parsed.serverStats[serverName].totalCalls >= 1,
      `${serverName} must have at least 1 totalCall`
    );
    assert.ok(
      parsed.serverStats[serverName].successCount >= 1,
      `${serverName} must have at least 1 successCount`
    );
  } finally {
    cleanup(logFile);
  }
});

// TC3: Synthetic log file with a failure → --json output shows failureCount > 0.
// Uses --tool nf-tc3 filter for compact output.
test('TC3: synthetic failed tool call shows failureCount >= 1 in --json output', () => {
  const serverName = 'nf-tc3-slow';
  const logFile = writeSyntheticLog([
    `2026-02-22T10:00:00.000Z MCP server "${serverName}": Tool 'slow-tool' failed after 25s: connection timeout`,
  ]);
  try {
    const { stdout, exitCode } = runCLI(['--json', '--days', '1', '--tool', 'nf-tc3']);
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      assert.fail(`stdout must be valid JSON; parse error: ${e.message}`);
    }
    assert.ok(parsed.serverStats[serverName], `serverStats must contain "${serverName}"`);
    assert.ok(
      parsed.serverStats[serverName].failureCount >= 1,
      `${serverName} must have failureCount >= 1`
    );
  } finally {
    cleanup(logFile);
  }
});

// TC4: --tool filter — only matching server appears in JSON output
test('TC4: --tool alpha filter includes alpha-server and excludes beta-server', () => {
  const logFile = writeSyntheticLog([
    '2026-02-22T10:00:00.000Z MCP server "alpha-server": Tool \'alpha-tool\' completed successfully in 100ms',
    '2026-02-22T10:00:01.000Z MCP server "beta-server": Tool \'beta-tool\' completed successfully in 200ms',
  ]);
  try {
    const { stdout, exitCode } = runCLI(['--json', '--days', '1', '--tool', 'alpha']);
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      assert.fail(`stdout must be valid JSON; parse error: ${e.message}`);
    }
    assert.ok(parsed.serverStats['alpha-server'], 'serverStats must contain alpha-server');
    assert.strictEqual(
      parsed.serverStats['beta-server'],
      undefined,
      'serverStats must NOT contain beta-server when --tool alpha filter is active'
    );
  } finally {
    cleanup(logFile);
  }
});

// TC5: Percentile logic — p50 and p95 reported correctly for 4 durations (100, 200, 300, 400ms).
// Uses --tool nf-tc5 filter for compact output.
// The percentile() function: sorted=[100,200,300,400]
//   p50: idx = ceil(0.50 * 4) - 1 = ceil(2) - 1 = 1 → sorted[1] = 200
//   p95: idx = ceil(0.95 * 4) - 1 = ceil(3.8) - 1 = 3 → sorted[3] = 400
test('TC5: percentile logic p50 >= 100 and p95 >= 300 for 4 durations', () => {
  const serverName = 'nf-tc5-perf';
  const logFile = writeSyntheticLog([
    `2026-02-22T10:00:00.000Z MCP server "${serverName}": Tool 'tool-a' completed successfully in 100ms`,
    `2026-02-22T10:00:01.000Z MCP server "${serverName}": Tool 'tool-b' completed successfully in 200ms`,
    `2026-02-22T10:00:02.000Z MCP server "${serverName}": Tool 'tool-c' completed successfully in 300ms`,
    `2026-02-22T10:00:03.000Z MCP server "${serverName}": Tool 'tool-d' completed successfully in 400ms`,
  ]);
  try {
    const { stdout, exitCode } = runCLI(['--json', '--days', '1', '--tool', 'nf-tc5']);
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      assert.fail(`stdout must be valid JSON; parse error: ${e.message}`);
    }
    assert.ok(parsed.serverStats[serverName], `serverStats must contain "${serverName}"`);
    const stats = parsed.serverStats[serverName];
    assert.ok(stats.p50Ms >= 100, `p50Ms must be >= 100; got ${stats.p50Ms}`);
    assert.ok(stats.p95Ms >= 300, `p95Ms must be >= 300; got ${stats.p95Ms}`);
  } finally {
    cleanup(logFile);
  }
});

// TC6: server named __proto__ must not crash via prototype-key deref
test('TC6: server named __proto__ does not crash (prototype-pollution key)', () => {
  const logFile = writeSyntheticLog([
    `2026-02-22T10:00:00.000Z MCP server "__proto__": Tool 'proto-tool' completed successfully in 100ms`,
  ]);
  try {
    const { stdout, exitCode } = runCLI(['--json', '--days', '1', '--tool', '__proto__']);
    assert.strictEqual(exitCode, 0, 'must not crash on a server named __proto__');
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      assert.fail(`stdout must be valid JSON, not a crash; stdout[:200]: ${stdout.slice(0, 200)}`);
    }
    assert.ok(parsed.serverStats, 'parsed result must have serverStats key');
  } finally {
    cleanup(logFile);
  }
});

// TC7: non-numeric --days falls back to default and still finds a recent log
test('TC7: non-numeric --days falls back to default and still finds a recent log', () => {
  const serverName = 'nf-tc7-days';
  const logFile = writeSyntheticLog([
    `2026-02-22T10:00:00.000Z MCP server "${serverName}": Tool 'd-tool' completed successfully in 120ms`,
  ]);
  try {
    const { stdout, exitCode } = runCLI(['--json', '--days', 'week', '--tool', 'nf-tc7']);
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      assert.fail(`stdout must be valid JSON (NaN cutoff hid all files); stdout[:200]: ${stdout.slice(0, 200)}`);
    }
    assert.ok(parsed.serverStats[serverName], `serverStats must contain "${serverName}" despite bad --days`);
  } finally {
    cleanup(logFile);
  }
});

// TC8: non-numeric --files falls back to default and still finds a recent log
test('TC8: non-numeric --files falls back to default and still finds a recent log', () => {
  const serverName = 'nf-tc8-files';
  const logFile = writeSyntheticLog([
    `2026-02-22T10:00:00.000Z MCP server "${serverName}": Tool 'f-tool' completed successfully in 130ms`,
  ]);
  try {
    const { stdout, exitCode } = runCLI(['--json', '--files', 'all', '--days', '1', '--tool', 'nf-tc8']);
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      assert.fail(`stdout must be valid JSON (NaN slice emptied file list); stdout[:200]: ${stdout.slice(0, 200)}`);
    }
    assert.ok(parsed.serverStats[serverName], `serverStats must contain "${serverName}" despite bad --files`);
  } finally {
    cleanup(logFile);
  }
});

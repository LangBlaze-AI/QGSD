'use strict';
// Test suite for bin/issue-classifier.cjs
// Uses Node.js built-in test runner: node --test bin/issue-classifier.test.cjs
//
// issue-classifier.cjs reads .planning/telemetry/report.json and writes
// .planning/telemetry/pending-fixes.json with up to 3 ranked issues.
// All I/O is relative to process.cwd(), so we use tmpDir as cwd.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, 'issue-classifier.cjs');

function makeTmpDir() {
  const dir = path.join(os.tmpdir(), 'nf-ic-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function run(cwd) {
  const result = spawnSync(process.execPath, [CLI], {
    encoding: 'utf8',
    cwd,
    timeout: 5000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
  };
}

function writeReport(dir, report) {
  const telemetryDir = path.join(dir, '.planning', 'telemetry');
  fs.mkdirSync(telemetryDir, { recursive: true });
  fs.writeFileSync(path.join(telemetryDir, 'report.json'), JSON.stringify(report), 'utf8');
}

function readFixes(dir) {
  const fixesPath = path.join(dir, '.planning', 'telemetry', 'pending-fixes.json');
  return JSON.parse(fs.readFileSync(fixesPath, 'utf8'));
}

// ─── Missing report.json ──────────────────────────────────────────────────────

test('missing report.json: exits 0 with empty issues', () => {
  const tmpDir = makeTmpDir();
  const { exitCode, stdout } = run(tmpDir);
  assert.equal(exitCode, 0);
  const fixes = readFixes(tmpDir);
  assert.deepEqual(fixes.issues, []);
  assert.ok(stdout.includes('0 issues'));
});

test('missing report.json: creates pending-fixes.json', () => {
  const tmpDir = makeTmpDir();
  run(tmpDir);
  const fixesPath = path.join(tmpDir, '.planning', 'telemetry', 'pending-fixes.json');
  assert.ok(fs.existsSync(fixesPath), 'Should create pending-fixes.json even with no report');
});

// ─── Invalid report.json ───────────────────────────────────────────────────────

test('invalid JSON in report.json: exits 0 with empty issues (fail-safe)', () => {
  const tmpDir = makeTmpDir();
  const telemetryDir = path.join(tmpDir, '.planning', 'telemetry');
  fs.mkdirSync(telemetryDir, { recursive: true });
  fs.writeFileSync(path.join(telemetryDir, 'report.json'), 'not json {{{', 'utf8');
  const { exitCode } = run(tmpDir);
  assert.equal(exitCode, 0);
  const fixes = readFixes(tmpDir);
  assert.deepEqual(fixes.issues, []);
});

// ─── Rule 1: Always-failing servers (priority 100) ───────────────────────────

test('alwaysFailing server: creates issue with priority 100', () => {
  const tmpDir = makeTmpDir();
  writeReport(tmpDir, { mcp: { alwaysFailing: ['codex-1'] } });
  run(tmpDir);
  const fixes = readFixes(tmpDir);
  assert.equal(fixes.issues.length, 1);
  assert.equal(fixes.issues[0].priority, 100);
  assert.ok(fixes.issues[0].id.includes('mcp-always-failing'));
  assert.ok(fixes.issues[0].description.includes('codex-1'));
});

test('alwaysFailing server: issue has required fields', () => {
  const tmpDir = makeTmpDir();
  writeReport(tmpDir, { mcp: { alwaysFailing: ['gemini-1'] } });
  run(tmpDir);
  const fixes = readFixes(tmpDir);
  const issue = fixes.issues[0];
  assert.ok(issue.id, 'should have id');
  assert.ok(typeof issue.priority === 'number', 'should have numeric priority');
  assert.ok(issue.description, 'should have description');
  assert.ok(issue.action, 'should have action');
  assert.equal(issue.surfaced, false, 'should default surfaced=false');
  assert.ok(issue.detectedAt, 'should have detectedAt timestamp');
});

// ─── Rule 2: Circuit breaker active (priority 90) ────────────────────────────

test('circuitBreaker.active=true: creates issue with priority 90', () => {
  const tmpDir = makeTmpDir();
  writeReport(tmpDir, { circuitBreaker: { active: true } });
  run(tmpDir);
  const fixes = readFixes(tmpDir);
  assert.equal(fixes.issues.length, 1);
  assert.equal(fixes.issues[0].priority, 90);
  assert.equal(fixes.issues[0].id, 'circuit-breaker-active');
});

test('circuitBreaker.active=false: no circuit-breaker-active issue', () => {
  const tmpDir = makeTmpDir();
  writeReport(tmpDir, { circuitBreaker: { active: false } });
  run(tmpDir);
  const fixes = readFixes(tmpDir);
  const cbIssue = fixes.issues.find(i => i.id === 'circuit-breaker-active');
  assert.equal(cbIssue, undefined, 'Should not create issue when breaker inactive');
});

// ─── Rule 3: High hang count (priority 80) ────────────────────────────────────

test('server with hangCount > 5: creates issue with priority 80', () => {
  const tmpDir = makeTmpDir();
  writeReport(tmpDir, { mcp: { servers: { 'deepseek-1': { hangCount: 8 } } } });
  run(tmpDir);
  const fixes = readFixes(tmpDir);
  assert.equal(fixes.issues.length, 1);
  assert.equal(fixes.issues[0].priority, 80);
  assert.ok(fixes.issues[0].description.includes('deepseek-1'));
  assert.ok(fixes.issues[0].description.includes('8'));
});

test('server with hangCount = 5 (not > 5): no issue', () => {
  const tmpDir = makeTmpDir();
  writeReport(tmpDir, { mcp: { servers: { 'my-server': { hangCount: 5 } } } });
  run(tmpDir);
  const fixes = readFixes(tmpDir);
  assert.equal(fixes.issues.length, 0);
});

// ─── Rule 4: High quorum failure rate (priority 70) ──────────────────────────

test('quorumFailureRate > 0.5 with rounds > 0: creates issue with priority 70', () => {
  const tmpDir = makeTmpDir();
  writeReport(tmpDir, { quorum: { quorumFailureRate: 0.7, totalRounds: 10 } });
  run(tmpDir);
  const fixes = readFixes(tmpDir);
  assert.equal(fixes.issues.length, 1);
  assert.equal(fixes.issues[0].priority, 70);
  assert.equal(fixes.issues[0].id, 'quorum-high-failure-rate');
});

test('quorumFailureRate = 0.5 (not > 0.5): no issue', () => {
  const tmpDir = makeTmpDir();
  writeReport(tmpDir, { quorum: { quorumFailureRate: 0.5, totalRounds: 10 } });
  run(tmpDir);
  const fixes = readFixes(tmpDir);
  assert.equal(fixes.issues.length, 0);
});

test('quorumFailureRate > 0.5 but totalRounds = 0: no issue', () => {
  const tmpDir = makeTmpDir();
  writeReport(tmpDir, { quorum: { quorumFailureRate: 0.8, totalRounds: 0 } });
  run(tmpDir);
  const fixes = readFixes(tmpDir);
  assert.equal(fixes.issues.length, 0);
});

// ─── Rule 5: Slow server p95 > 30s (priority 60) ─────────────────────────────

test('slowServer with p95Ms > 30000: creates issue with priority 60', () => {
  const tmpDir = makeTmpDir();
  writeReport(tmpDir, { mcp: { slowServers: [{ name: 'kimi-1', p95Ms: 45000 }] } });
  run(tmpDir);
  const fixes = readFixes(tmpDir);
  assert.equal(fixes.issues.length, 1);
  assert.equal(fixes.issues[0].priority, 60);
  assert.ok(fixes.issues[0].description.includes('kimi-1'));
});

test('slowServer with p95Ms = 30000 (not > 30000): no issue', () => {
  const tmpDir = makeTmpDir();
  writeReport(tmpDir, { mcp: { slowServers: [{ name: 'fast-server', p95Ms: 30000 }] } });
  run(tmpDir);
  const fixes = readFixes(tmpDir);
  assert.equal(fixes.issues.length, 0);
});

// ─── Rule 6: Repeated circuit breaker triggers (priority 50) ─────────────────

test('triggerCount > 3 and not active: creates issue with priority 50', () => {
  const tmpDir = makeTmpDir();
  writeReport(tmpDir, { circuitBreaker: { active: false, triggerCount: 5 } });
  run(tmpDir);
  const fixes = readFixes(tmpDir);
  assert.equal(fixes.issues.length, 1);
  assert.equal(fixes.issues[0].priority, 50);
  assert.equal(fixes.issues[0].id, 'circuit-breaker-repeated-triggers');
});

test('triggerCount = 3 (not > 3): no issue', () => {
  const tmpDir = makeTmpDir();
  writeReport(tmpDir, { circuitBreaker: { active: false, triggerCount: 3 } });
  run(tmpDir);
  const fixes = readFixes(tmpDir);
  assert.equal(fixes.issues.length, 0);
});

// ─── Top-3 cap and priority ordering ─────────────────────────────────────────

test('more than 3 issues: only top 3 by priority are written', () => {
  const tmpDir = makeTmpDir();
  writeReport(tmpDir, {
    mcp: {
      alwaysFailing: ['server-a'],  // priority 100
      slowServers: [{ name: 'slow-b', p95Ms: 60000 }],  // priority 60
      servers: { 'hang-c': { hangCount: 10 } },  // priority 80
    },
    circuitBreaker: { active: true, triggerCount: 5 },  // 90 + 50
    quorum: { quorumFailureRate: 0.8, totalRounds: 20 }, // 70
  });
  run(tmpDir);
  const fixes = readFixes(tmpDir);
  assert.equal(fixes.issues.length, 3, 'Should cap at 3 issues');
  // Top 3 should be priorities 100, 90, 80
  assert.equal(fixes.issues[0].priority, 100);
  assert.equal(fixes.issues[1].priority, 90);
  assert.equal(fixes.issues[2].priority, 80);
});

test('issues are sorted descending by priority', () => {
  const tmpDir = makeTmpDir();
  writeReport(tmpDir, {
    mcp: { servers: { 'hang-x': { hangCount: 8 } } },  // priority 80
    quorum: { quorumFailureRate: 0.8, totalRounds: 10 }, // priority 70
  });
  run(tmpDir);
  const fixes = readFixes(tmpDir);
  assert.equal(fixes.issues.length, 2);
  assert.ok(fixes.issues[0].priority >= fixes.issues[1].priority, 'Should be sorted descending');
});

// ─── Output format ────────────────────────────────────────────────────────────

test('pending-fixes.json has generatedAt field', () => {
  const tmpDir = makeTmpDir();
  writeReport(tmpDir, {});
  run(tmpDir);
  const fixes = readFixes(tmpDir);
  assert.ok(fixes.generatedAt, 'Should have generatedAt timestamp');
  assert.doesNotThrow(() => new Date(fixes.generatedAt), 'generatedAt should be a valid date');
});

test('empty report: exits 0, writes 0 issues', () => {
  const tmpDir = makeTmpDir();
  writeReport(tmpDir, {});
  const { exitCode, stdout } = run(tmpDir);
  assert.equal(exitCode, 0);
  const fixes = readFixes(tmpDir);
  assert.deepEqual(fixes.issues, []);
  assert.ok(stdout.includes('0 issues'));
});

// ─── Adversarial: non-object / malformed report shapes (fail-open) ────────────

test('report.json is literal null: exits 0 with empty issues (fail-safe)', () => {
  const tmpDir = makeTmpDir();
  const telemetryDir = path.join(tmpDir, '.planning', 'telemetry');
  fs.mkdirSync(telemetryDir, { recursive: true });
  fs.writeFileSync(path.join(telemetryDir, 'report.json'), 'null', 'utf8');
  const { exitCode } = run(tmpDir);
  assert.equal(exitCode, 0);
  const fixes = readFixes(tmpDir);
  assert.deepEqual(fixes.issues, []);
});

test('mcp.servers with null stats entry: exits 0, no crash', () => {
  const tmpDir = makeTmpDir();
  writeReport(tmpDir, { mcp: { servers: { 'srv': null } } });
  const { exitCode } = run(tmpDir);
  assert.equal(exitCode, 0);
  const fixes = readFixes(tmpDir);
  assert.deepEqual(fixes.issues, []);
});

test('mcp.alwaysFailing with non-string entry: exits 0, no crash', () => {
  const tmpDir = makeTmpDir();
  writeReport(tmpDir, { mcp: { alwaysFailing: [null] } });
  const { exitCode } = run(tmpDir);
  assert.equal(exitCode, 0);
});

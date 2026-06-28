#!/usr/bin/env node
'use strict';
// bin/git-heatmap.test.cjs
// Unit tests for git-heatmap.cjs signal extraction and scoring logic.
// Requirements: QUICK-193

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  parseDiffNumericLine,
  parseHunksForNumericChanges,
  computeDriftDirection,
  isBugfixCommit,
  computePriority,
  hasFormalCoverage,
  validateSince,
  SINCE_PATTERN,
} = require('./git-heatmap.cjs');

// ── 1. Numerical adjustment regex ──────────────────────────────────────────

test('parseDiffNumericLine: detects const assignment change', () => {
  const removed = parseDiffNumericLine('-const TIMEOUT = 5000');
  assert.ok(removed, 'should parse removed line');
  assert.strictEqual(removed.name, 'TIMEOUT');
  assert.strictEqual(removed.value, 5000);

  const added = parseDiffNumericLine('+const TIMEOUT = 10000');
  assert.ok(added, 'should parse added line');
  assert.strictEqual(added.name, 'TIMEOUT');
  assert.strictEqual(added.value, 10000);
});

test('parseDiffNumericLine: detects object property change', () => {
  const removed = parseDiffNumericLine('-  retries: 3');
  assert.ok(removed, 'should parse removed property line');
  assert.strictEqual(removed.name, 'retries');
  assert.strictEqual(removed.value, 3);

  const added = parseDiffNumericLine('+  retries: 5');
  assert.ok(added, 'should parse added property line');
  assert.strictEqual(added.name, 'retries');
  assert.strictEqual(added.value, 5);
});

test('parseDiffNumericLine: rejects non-numeric changes', () => {
  const result = parseDiffNumericLine('-  name: "hello"');
  assert.strictEqual(result, null, 'string values should not match');

  const result2 = parseDiffNumericLine('+  description: "updated text"');
  assert.strictEqual(result2, null, 'string values should not match');
});

// ── 2. Drift direction computation ─────────────────────────────────────────

test('computeDriftDirection: increasing', () => {
  assert.strictEqual(computeDriftDirection([5, 10, 15]), 'increasing');
});

test('computeDriftDirection: decreasing', () => {
  assert.strictEqual(computeDriftDirection([15, 10, 5]), 'decreasing');
});

test('computeDriftDirection: oscillating', () => {
  assert.strictEqual(computeDriftDirection([5, 15, 5]), 'oscillating');
});

test('computeDriftDirection: single value is stable', () => {
  assert.strictEqual(computeDriftDirection([5]), 'stable');
});

// ── 3. Bugfix commit message filter ────────────────────────────────────────

test('isBugfixCommit: matches fix commits', () => {
  assert.ok(isBugfixCommit('fix: resolve timeout issue'));
  assert.ok(isBugfixCommit('bugfix in parser'));
  assert.ok(isBugfixCommit('hotfix for prod crash'));
  assert.ok(isBugfixCommit('patch security vulnerability'));
  assert.ok(isBugfixCommit('resolved merge conflict'));
});

test('isBugfixCommit: rejects non-fix commits', () => {
  assert.strictEqual(isBugfixCommit('feat: add new feature'), false);
  assert.strictEqual(isBugfixCommit('chore: update deps'), false);
  assert.strictEqual(isBugfixCommit('docs: update README'), false);
  assert.strictEqual(isBugfixCommit('refactor: clean up code'), false);
});

// ── 4. Priority scoring formula ────────────────────────────────────────────

test('computePriority: churn only', () => {
  assert.strictEqual(computePriority(100, 0, 0), 100);
});

test('computePriority: churn + fixes', () => {
  assert.strictEqual(computePriority(100, 2, 0), 300);
});

test('computePriority: churn + fixes + adjustments', () => {
  assert.strictEqual(computePriority(100, 2, 3), 1200);
});

test('computePriority: zero churn with fixes uses floor', () => {
  // max(0, 1) * (1 + 5) * (1 + 0) = 6
  assert.strictEqual(computePriority(0, 5, 0), 6);
});

test('computePriority: zero churn with adjustments uses floor', () => {
  // max(0, 1) * (1 + 0) * (1 + 3) = 4
  assert.strictEqual(computePriority(0, 0, 3), 4);
});

// ── 5. Model-registry cross-reference ──────────────────────────────────────

test('hasFormalCoverage: direct match returns true', () => {
  const coverageMap = new Set(['hooks/nf-stop.js', 'bin/install.js']);
  assert.ok(hasFormalCoverage('hooks/nf-stop.js', coverageMap));
});

test('hasFormalCoverage: no match returns false', () => {
  const coverageMap = new Set(['hooks/nf-stop.js']);
  assert.strictEqual(hasFormalCoverage('bin/unknown.cjs', coverageMap), false);
});

test('hasFormalCoverage: suffix match returns true', () => {
  const coverageMap = new Set(['hooks/nf-stop.js']);
  assert.ok(hasFormalCoverage('some/prefix/hooks/nf-stop.js', coverageMap));
});

// ── 6. Hunk-adjacent constraint ────────────────────────────────────────────

test('parseHunksForNumericChanges: matches within same hunk', () => {
  const diff = [
    '@@ -10,5 +10,5 @@',
    '-const TIMEOUT = 5000',
    '+const TIMEOUT = 10000',
  ].join('\n');
  const results = parseHunksForNumericChanges(diff);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].constant_name, 'TIMEOUT');
  assert.strictEqual(results[0].old_value, 5000);
  assert.strictEqual(results[0].new_value, 10000);
});

test('parseHunksForNumericChanges: rejects across hunk boundaries', () => {
  const diff = [
    '@@ -10,3 +10,3 @@',
    '-const TIMEOUT = 5000',
    ' some context line',
    '@@ -20,3 +20,3 @@',
    '+const TIMEOUT = 10000',
  ].join('\n');
  const results = parseHunksForNumericChanges(diff);
  assert.strictEqual(results.length, 0, 'should NOT match across hunk boundaries');
});

test('parseHunksForNumericChanges: matches within 3 lines', () => {
  const diff = [
    '@@ -10,6 +10,6 @@',
    '-  retries: 3',
    ' // some comment',
    ' // another comment',
    '+  retries: 5',
  ].join('\n');
  const results = parseHunksForNumericChanges(diff);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].constant_name, 'retries');
});

test('parseHunksForNumericChanges: rejects beyond 3 lines', () => {
  const diff = [
    '@@ -10,8 +10,8 @@',
    '-  retries: 3',
    ' // line 1',
    ' // line 2',
    ' // line 3',
    ' // line 4',
    '+  retries: 5',
  ].join('\n');
  const results = parseHunksForNumericChanges(diff);
  // Line indices: removed at 1, added at 6 => distance 5 > 3
  assert.strictEqual(results.length, 0, 'should NOT match beyond 3 lines');
});

// ── 7. --since flag sanitization ───────────────────────────────────────────

test('validateSince: valid date accepted', () => {
  assert.doesNotThrow(() => validateSince('2024-01-01'));
});

test('validateSince: valid ISO accepted', () => {
  assert.doesNotThrow(() => validateSince('2024-01-01T00:00:00Z'));
});

test('validateSince: malicious input rejected', () => {
  assert.throws(() => validateSince('2024; rm -rf /'), /Invalid --since value/);
});

test('validateSince: null accepted (no since)', () => {
  assert.doesNotThrow(() => validateSince(null));
});

test('SINCE_PATTERN rejects shell metacharacters', () => {
  assert.strictEqual(SINCE_PATTERN.test('$(whoami)'), false);
  assert.strictEqual(SINCE_PATTERN.test('`rm -rf`'), false);
  assert.strictEqual(SINCE_PATTERN.test('2024 && echo pwned'), false);
});

// ── 8. Output schema validation (end-to-end) ──────────────────────────────

test('end-to-end: script produces valid schema against real repo', () => {
  const { execFileSync } = require('child_process');
  const projectRoot = path.join(__dirname, '..');

  const output = execFileSync('node', [
    path.join(__dirname, 'git-heatmap.cjs'),
    '--json',
    `--project-root=${projectRoot}`,
  ], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: 120000,
  });

  const data = JSON.parse(output);

  // Schema version
  assert.strictEqual(data.schema_version, '1');

  // Generated timestamp
  assert.ok(data.generated, 'should have generated timestamp');
  assert.ok(!isNaN(Date.parse(data.generated)), 'generated should be valid ISO date');

  // All three signal arrays exist
  assert.ok(Array.isArray(data.signals.numerical_adjustments), 'numerical_adjustments should be array');
  assert.ok(Array.isArray(data.signals.bugfix_hotspots), 'bugfix_hotspots should be array');
  assert.ok(Array.isArray(data.signals.churn_ranking), 'churn_ranking should be array');

  // Uncovered hot zones
  assert.ok(Array.isArray(data.uncovered_hot_zones), 'uncovered_hot_zones should be array');

  // Validate hot zone entry structure (if any exist)
  if (data.uncovered_hot_zones.length > 0) {
    const hz = data.uncovered_hot_zones[0];
    assert.ok(typeof hz.file === 'string', 'hot zone should have file');
    assert.ok(typeof hz.priority === 'number', 'hot zone should have priority');
    assert.ok(typeof hz.churn === 'number', 'hot zone should have churn');
    assert.ok(typeof hz.fixes === 'number', 'hot zone should have fixes');
    assert.ok(typeof hz.adjustments === 'number', 'hot zone should have adjustments');
    assert.ok(Array.isArray(hz.signals), 'hot zone should have signals array');
  }

  // Validate signal counts are reasonable for a real repo
  assert.ok(data.signals.churn_ranking.length > 0, 'should find churn data in a real repo');
  assert.ok(data.signals.bugfix_hotspots.length > 0, 'should find bugfix data in a real repo');
});

// ── 9. Prototype-pollution hardening ───────────────────────────────────────

test('buildUncoveredHotZones: file named __proto__ does not corrupt output', () => {
  const { buildUncoveredHotZones } = require('./git-heatmap.cjs');
  const churnRanking = [{ file: '__proto__', total_churn: 50, commits: 2, lines_added: 30, lines_removed: 20 }];
  const zones = buildUncoveredHotZones([], [], churnRanking, new Set());
  assert.strictEqual(zones.length, 1);
  const z = zones[0];
  assert.strictEqual(z.file, '__proto__');
  assert.strictEqual(typeof z.churn, 'number', 'churn must be a number, not Object.prototype');
  assert.strictEqual(z.churn, 50);
  assert.strictEqual(z.fixes, 0);
  assert.strictEqual(z.adjustments, 0);
  assert.ok(Number.isFinite(z.priority), 'priority must be finite, not NaN');
  assert.deepStrictEqual(z.signals, ['churn'], 'only the churn signal should be present');
});

test('extractChurnRanking: file named __proto__ does not crash or pollute Object.prototype', () => {
  const { extractChurnRanking } = require('./git-heatmap.cjs');
  const os = require('os');
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heatmap-proto-'));
  const git = (a) => execFileSync('git', a, { cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'] });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 'tester']);
  fs.writeFileSync(path.join(tmp, '__proto__'), 'a\nb\nc\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'add proto file']);
  assert.doesNotThrow(() => extractChurnRanking(tmp, null, 0), 'must not throw on a __proto__ filename');
  assert.strictEqual(Object.prototype.lines_added, undefined, 'must not pollute Object.prototype');
  const ranking = extractChurnRanking(tmp, null, 0);
  const entry = ranking.find((r) => r.file === '__proto__');
  assert.ok(entry, 'should include the __proto__ file in the ranking');
  assert.strictEqual(typeof entry.total_churn, 'number');
});

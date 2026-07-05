#!/usr/bin/env node
'use strict';

/**
 * bin/security-sweep.test.cjs — Unit tests for security sweep module.
 * Run: node --test bin/security-sweep.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// spawnSync used only for git init in test fixtures — no shell injection risk
const { spawnSync } = require('child_process');

const { scanFile, scanDirectory, formatReport, SECRET_PATTERNS } = require('./security-sweep.cjs');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sec-sweep-test-'));
}

function initGitRepo(dir) {
  spawnSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
}

function addAndCommit(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
  spawnSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: dir, stdio: 'pipe' });
}

// ─── scanFile Tests ─────────────────────────────────────────────────────────

test('scanFile detects AWS key', () => {
  const findings = scanFile('src/config.js', 'const key = "AKIAIOSFODNN7ABCDEFG";\n');
  assert.ok(findings.length > 0, 'should detect AWS key');
  assert.equal(findings[0].severity, 'high');
  assert.equal(findings[0].pattern_name, 'AWS Access Key');
});

test('scanFile detects GitHub token', () => {
  const token = 'ghp_' + 'A'.repeat(40);
  const findings = scanFile('src/auth.js', `const gh = "${token}";\n`);
  assert.ok(findings.length > 0, 'should detect GitHub token');
  assert.equal(findings[0].pattern_name, 'GitHub Token');
  assert.equal(findings[0].severity, 'high');
});

test('scanFile detects Stripe live key', () => {
  const findings = scanFile('src/pay.js', 'const stripe = "sk_live_' + '51OyBvh0Oc2JurFqNkYLEHbN";\n');
  assert.ok(findings.length > 0, 'should detect Stripe live key');
  assert.equal(findings[0].severity, 'high');
});

test('scanFile detects OpenAI key', () => {
  const key = 'sk-' + 'a'.repeat(40);
  const findings = scanFile('src/ai.js', `const openai = "${key}";\n`);
  assert.ok(findings.length > 0, 'should detect OpenAI key');
  assert.equal(findings[0].pattern_name, 'OpenAI Key');
});

test('scanFile detects debugger statement', () => {
  const findings = scanFile('src/debug.js', '  debugger;\n');
  assert.ok(findings.length > 0, 'should detect debugger statement');
  assert.equal(findings[0].severity, 'low');
  assert.equal(findings[0].pattern_name, 'Debugger Statement');
});

test('scanFile detects sensitive console.log', () => {
  const findings = scanFile('src/log.js', 'console.log(password);\n');
  assert.ok(findings.length > 0, 'should detect sensitive console.log');
  assert.equal(findings[0].severity, 'low');
});

test('scanFile skips test fixture lines', () => {
  // "testKey" (camelCase) and "sk-test" (hyphen) are genuine test-indicator tokens → skip
  const findings = scanFile('src/cfg.js', 'const testKey = "sk-test1234567890abcdefghijklmnopqr";\n');
  assert.equal(findings.length, 0, 'should skip lines with a test-indicator token');
});

test('scanFile does NOT skip a real key just because a word contains "test" as a substring', () => {
  // Regression: the old whole-line substring skip hid real keys on "latest"/"greatest"
  // lines. Token-boundary matching must still flag these.
  assert.equal(scanFile('src/x.js', 'const k = "AKIAROGUEKEY123456XY"; deployTo("latest");\n').length, 1, // pragma: allowlist secret
    '"latest" is not a test-indicator token — the AWS key must be flagged');
  assert.equal(scanFile('src/x.js', 'const t = "ghp_' + 'a'.repeat(36) + '"; // the greatest\n').length, 1,
    '"greatest" must not suppress a real GitHub token');
});

test('scanFile returns empty for clean file', () => {
  const content = [
    '\'use strict\';',
    'const x = 42;',
    'function add(a, b) { return a + b; }',
    'module.exports = { add };',
    '',
  ].join('\n');
  const findings = scanFile('src/clean.js', content);
  assert.equal(findings.length, 0, 'clean file should have no findings');
});

test('scanFile detects generic api_key assignment', () => {
  const findings = scanFile('src/config.js', 'api_key = "abc123def456xy"\n');
  assert.ok(findings.length > 0, 'should detect generic api_key assignment');
  assert.equal(findings[0].pattern_name, 'Generic API Key Assignment');
  assert.equal(findings[0].severity, 'medium');
});

test('scanFile handles binary content gracefully', () => {
  const content = 'normal text\x00\x01\x02binary data\n';
  const findings = scanFile('bin/something', content);
  assert.equal(findings.length, 0, 'binary content should return empty findings');
});

test('scanFile returns correct line and column numbers', () => {
  const content = 'line one\nline two\n  debugger;\nline four\n';
  const findings = scanFile('src/lines.js', content);
  assert.ok(findings.length > 0);
  assert.equal(findings[0].line, 3);
  assert.ok(findings[0].column > 0);
});

test('scanFile truncates long matches', () => {
  // OpenAI key pattern with very long match
  const longKey = 'sk-' + 'a'.repeat(80);
  const findings = scanFile('src/long.js', `const k = "${longKey}";\n`);
  assert.ok(findings.length > 0);
  assert.ok(findings[0].match.length <= 40, 'match should be truncated to 40 chars max');
  assert.ok(findings[0].match.endsWith('...'), 'truncated match should end with ...');
});

// ─── scanDirectory Tests ────────────────────────────────────────────────────

test('scanDirectory scans git-tracked files and finds secrets', () => {
  const dir = makeTmpDir();
  initGitRepo(dir);
  addAndCommit(dir, {
    'src/config.js': 'const key = "AKIAIOSFODNN7ABCDEFG";\n',
  });
  const result = scanDirectory(dir);
  assert.ok(result.files_scanned > 0, 'should scan at least one file');
  assert.ok(result.findings.length > 0, 'should find the AWS key');
  assert.ok(result.duration_ms >= 0, 'should report duration');
});

test('scanDirectory excludes test files', () => {
  const dir = makeTmpDir();
  initGitRepo(dir);
  addAndCommit(dir, {
    'src/config.test.js': 'const key = "AKIAIOSFODNN7ABCDEFG";\n',
  });
  const result = scanDirectory(dir);
  // The test file should be excluded, so no findings
  assert.equal(result.findings.length, 0, 'test files should be excluded from scanning');
});

test('scanDirectory returns zero findings for clean repo', () => {
  const dir = makeTmpDir();
  initGitRepo(dir);
  addAndCommit(dir, {
    'src/clean.js': 'const x = 42;\nmodule.exports = { x };\n',
  });
  const result = scanDirectory(dir);
  assert.ok(result.files_scanned > 0, 'should scan files');
  assert.equal(result.findings.length, 0, 'clean repo should have no findings');
});

test('scanDirectory handles non-git directory', () => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'file.js'), 'const x = 1;\n');
  const result = scanDirectory(dir);
  assert.equal(result.files_scanned, 0, 'non-git dir should scan 0 files');
  assert.equal(result.findings.length, 0, 'non-git dir should have no findings');
});

test('scanDirectory does not throw when options is null', () => {
  const dir = makeTmpDir();
  initGitRepo(dir);
  addAndCommit(dir, {
    'src/clean.js': 'const x = 42;\nmodule.exports = { x };\n',
  });
  let result;
  assert.doesNotThrow(() => { result = scanDirectory(dir, null); }, 'null options should not throw');
  assert.ok(result && Array.isArray(result.findings), 'should return a normal result shape');
});

test('scanDirectory does not throw on null cwd while inside a git repo (fail-open)', () => {
  const dir = makeTmpDir();
  initGitRepo(dir);
  addAndCommit(dir, {
    'src/config.js': 'const x = 1;\n',
  });
  const prev = process.cwd();
  process.chdir(dir);
  try {
    let result;
    assert.doesNotThrow(() => { result = scanDirectory(null); }, 'null cwd must not throw');
    assert.ok(result && Array.isArray(result.findings), 'should return graceful result');
  } finally {
    process.chdir(prev);
  }
});

// ─── formatReport Tests ─────────────────────────────────────────────────────

test('formatReport produces markdown with findings', () => {
  const result = {
    findings: [
      { file: 'src/foo.js', line: 42, column: 1, pattern_name: 'AWS Access Key', severity: 'high', match: 'AKIAIOSFODNN7ABCDEFG' },
      { file: 'src/bar.js', line: 10, column: 5, pattern_name: 'Debugger Statement', severity: 'low', match: 'debugger;' },
    ],
    files_scanned: 50,
    duration_ms: 123,
  };
  const report = formatReport(result);
  assert.ok(report.includes('## Security Sweep'), 'report should have Security Sweep header');
  assert.ok(report.includes('50 files'), 'report should mention files scanned');
  assert.ok(report.includes('| high |'), 'report should contain findings table');
  assert.ok(report.includes('AWS Access Key'), 'report should include pattern name');
  assert.ok(report.includes('Advisory'), 'report should include advisory note');
});

test('formatReport produces clean report for no findings', () => {
  const result = { findings: [], files_scanned: 100, duration_ms: 50 };
  const report = formatReport(result);
  assert.ok(report.includes('## Security Sweep'), 'report should have header');
  assert.ok(report.includes('**Findings:** 0'), 'report should show 0 findings');
  assert.ok(report.includes('No hardcoded secrets'), 'report should have clean message');
});

test('formatReport does not throw on null/undefined input', () => {
  assert.doesNotThrow(() => formatReport(undefined), 'undefined input should not throw');
  assert.doesNotThrow(() => formatReport(null), 'null input should not throw');
  const report = formatReport(null);
  assert.ok(report.includes('## Security Sweep'), 'should still produce a report header');
});

test('formatReport counts severities correctly', () => {
  const result = {
    findings: [
      { file: 'a.js', line: 1, column: 1, pattern_name: 'AWS', severity: 'high', match: 'x' },
      { file: 'b.js', line: 1, column: 1, pattern_name: 'Stripe', severity: 'high', match: 'y' },
      { file: 'c.js', line: 1, column: 1, pattern_name: 'API Key', severity: 'medium', match: 'z' },
    ],
    files_scanned: 10,
    duration_ms: 5,
  };
  const report = formatReport(result);
  assert.ok(report.includes('3 (2 high, 1 medium, 0 low)'), 'severity counts should be correct');
});

// ─── SECRET_PATTERNS export ─────────────────────────────────────────────────

test('SECRET_PATTERNS is a non-empty array with expected structure', () => {
  assert.ok(Array.isArray(SECRET_PATTERNS), 'SECRET_PATTERNS should be an array');
  assert.ok(SECRET_PATTERNS.length >= 9, 'should have at least 9 patterns');
  for (const pat of SECRET_PATTERNS) {
    assert.ok(typeof pat.name === 'string', 'each pattern needs a name');
    assert.ok(pat.pattern instanceof RegExp, 'each pattern needs a regex');
    assert.ok(['high', 'medium', 'low'].includes(pat.severity), 'severity must be high/medium/low');
  }
});

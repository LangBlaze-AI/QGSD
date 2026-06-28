'use strict';
// bin/check-trace-redaction.test.cjs
// Unit + integration tests for check-trace-redaction.cjs
// Requirements: REDACT-01, REDACT-02, REDACT-03

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { parseRedactionPolicy, validateTraceEvent } = require('../bin/check-trace-redaction.cjs');
const POLICY_PATH = path.join(__dirname, '..', '.planning', 'formal', 'trace', 'redaction.yaml');

// ── Unit tests ────────────────────────────────────────────────────────────────

test('parseRedactionPolicy loads redaction.yaml with at least 4 forbidden_keys and 3 forbidden_patterns', () => {
  const policy = parseRedactionPolicy(POLICY_PATH);
  assert.ok(Array.isArray(policy.forbidden_keys), 'forbidden_keys should be an array');
  assert.ok(policy.forbidden_keys.length >= 4, 'should have at least 4 forbidden_keys, got: ' + policy.forbidden_keys.length);
  assert.ok(Array.isArray(policy.forbidden_patterns), 'forbidden_patterns should be an array');
  assert.ok(policy.forbidden_patterns.length >= 3, 'should have at least 3 forbidden_patterns, got: ' + policy.forbidden_patterns.length);
  // Each pattern should have name, regex, and compiled
  for (const p of policy.forbidden_patterns) {
    assert.ok(typeof p.name === 'string', 'pattern.name should be a string');
    assert.ok(typeof p.regex === 'string', 'pattern.regex should be a string');
    assert.ok(p.compiled instanceof RegExp, 'pattern.compiled should be a RegExp');
  }
});

test('validateTraceEvent returns 1 violation for forbidden key api_key', () => {
  const violations = validateTraceEvent(
    { api_key: 'secret123' },
    { forbidden_keys: ['api_key'], forbidden_patterns: [] }
  );
  assert.strictEqual(violations.length, 1);
  assert.strictEqual(violations[0].violation_type, 'forbidden_key');
  assert.strictEqual(violations[0].key, 'api_key');
});

test('validateTraceEvent returns 1 violation for AWS access key pattern', () => {
  const policy = parseRedactionPolicy(POLICY_PATH);
  const violations = validateTraceEvent(
    { normal_field: 'AKIAIOSFODNN7EXAMPLE' },
    policy
  );
  assert.strictEqual(violations.length, 1);
  assert.strictEqual(violations[0].violation_type, 'forbidden_pattern');
  assert.strictEqual(violations[0].pattern_name, 'aws_access_key_id');
});

test('validateTraceEvent returns 0 violations for clean trace event', () => {
  const policy = parseRedactionPolicy(POLICY_PATH);
  const violations = validateTraceEvent(
    { action: 'quorum_start', phase: 'IDLE' },
    policy
  );
  assert.strictEqual(violations.length, 0);
});

test('validateTraceEvent returns 2 violations for event with forbidden key and forbidden pattern value', () => {
  const policy = parseRedactionPolicy(POLICY_PATH);
  // api_key is a forbidden_key; AKIAIOSFODNN7EXAMPLE matches aws_access_key_id pattern
  const violations = validateTraceEvent(
    { api_key: 'x', another_field: 'AKIAIOSFODNN7EXAMPLE' },
    policy
  );
  assert.ok(violations.length >= 2, 'should have at least 2 violations, got: ' + violations.length);
});

test('validateTraceEvent detects forbidden pattern in a NESTED object value (no silent bypass)', () => {
  const policy = parseRedactionPolicy(POLICY_PATH);
  const violations = validateTraceEvent(
    { request: { headers: { authorization: 'AKIAIOSFODNN7EXAMPLE' } } },
    policy
  );
  // authorization is also a forbidden_key, and the value matches aws_access_key_id —
  // either way a secret is nested and MUST be reported, not silently skipped.
  assert.ok(violations.length >= 1, 'nested secret must be detected, got: ' + violations.length);
  assert.ok(
    violations.some(v => v.violation_type === 'forbidden_pattern' || v.violation_type === 'forbidden_key'),
    'should report a forbidden_pattern or forbidden_key for the nested secret'
  );
});

test('validateTraceEvent detects forbidden pattern in an ARRAY value element', () => {
  const policy = parseRedactionPolicy(POLICY_PATH);
  const violations = validateTraceEvent(
    { tags: ['benign', 'AKIAIOSFODNN7EXAMPLE'] },
    policy
  );
  assert.ok(violations.length >= 1, 'secret inside array element must be detected, got: ' + violations.length);
});

// ── Integration tests ─────────────────────────────────────────────────────────

test('integration: exits 0 with clean trace event JSONL file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-redact-test-'));
  const ndjsonPath = path.join(tmpDir, 'check-results.ndjson');

  try {
    const traceDir = path.join(tmpDir, 'traces');
    fs.mkdirSync(traceDir, { recursive: true });

    const cleanEvent = JSON.stringify({ action: 'quorum_start', phase: 'IDLE', slots_available: 4 });
    fs.writeFileSync(path.join(traceDir, 'events.jsonl'), cleanEvent + '\n', 'utf8');

    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'check-trace-redaction.cjs'), '--trace-dir', traceDir],
      { cwd: tmpDir, encoding: 'utf8', env: { ...process.env, CHECK_RESULTS_PATH: ndjsonPath } }
    );

    assert.strictEqual(result.status, 0, 'should exit 0 for clean events. stderr: ' + result.stderr);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('integration: exits 1 when trace event contains forbidden key api_key', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-redact-test-'));
  const ndjsonPath = path.join(tmpDir, 'check-results.ndjson');

  try {
    const traceDir = path.join(tmpDir, 'traces');
    fs.mkdirSync(traceDir, { recursive: true });

    const badEvent = JSON.stringify({ action: 'quorum_start', api_key: 'exposed123' });
    fs.writeFileSync(path.join(traceDir, 'events.jsonl'), badEvent + '\n', 'utf8');

    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'check-trace-redaction.cjs'), '--trace-dir', traceDir],
      { cwd: tmpDir, encoding: 'utf8', env: { ...process.env, CHECK_RESULTS_PATH: ndjsonPath } }
    );

    assert.strictEqual(result.status, 1, 'should exit 1 for forbidden key. stdout: ' + result.stdout);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('integration: exits 0 with non-existent trace directory (graceful no-op)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-redact-test-'));
  const ndjsonPath = path.join(tmpDir, 'check-results.ndjson');

  try {
    const nonExistentDir = path.join(tmpDir, 'does-not-exist');

    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'check-trace-redaction.cjs'), '--trace-dir', nonExistentDir],
      { cwd: tmpDir, encoding: 'utf8', env: { ...process.env, CHECK_RESULTS_PATH: ndjsonPath } }
    );

    assert.strictEqual(result.status, 0, 'should exit 0 when trace directory does not exist. stderr: ' + result.stderr);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('integration: exits 0 (graceful) when --trace-dir points to a file, not a directory', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-redact-test-'));
  const ndjsonPath = path.join(tmpDir, 'check-results.ndjson');

  try {
    const filePath = path.join(tmpDir, 'not-a-dir.txt');
    fs.writeFileSync(filePath, 'AKIAIOSFODNN7EXAMPLE\n', 'utf8');

    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'check-trace-redaction.cjs'), '--trace-dir', filePath],
      { cwd: tmpDir, encoding: 'utf8', env: { ...process.env, CHECK_RESULTS_PATH: ndjsonPath } }
    );

    assert.strictEqual(result.status, 0, 'should exit 0 gracefully when trace-dir is a file. stderr: ' + result.stderr);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

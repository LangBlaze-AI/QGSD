#!/usr/bin/env node
'use strict';
// bin/read-policy.test.cjs
// Unit tests for readPolicy() helper.
// Requirements: CALIB-01, CALIB-04

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// readPolicy is not yet created — tests must fail at require() or at assertions

const READ_POLICY = path.join(__dirname, 'read-policy.cjs');

test('readPolicy: loads successfully', () => {
  require(READ_POLICY);  // must not throw
});

test('readPolicy: throws when policy file is missing', () => {
  const { readPolicy } = require(READ_POLICY);
  assert.throws(
    () => readPolicy('/nonexistent/path/policy.yaml'),
    /Policy file not found|ENOENT/i
  );
});

test('readPolicy: throws on missing required field min_ci_runs', () => {
  const { readPolicy } = require(READ_POLICY);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-test-'));
  const p = path.join(tmp, 'policy.yaml');
  // Missing min_ci_runs
  fs.writeFileSync(p, 'min_quorum_rounds: 10\nmin_days: 1\nmode: warn\n');
  try {
    assert.throws(() => readPolicy(p), /min_ci_runs/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readPolicy: parses all required fields from valid policy.yaml', () => {
  const { readPolicy } = require(READ_POLICY);
  const policy = readPolicy(path.join(__dirname, '..', '.planning', 'formal', 'policy.yaml'));
  assert.strictEqual(typeof policy.cold_start.min_ci_runs, 'number');
  assert.strictEqual(typeof policy.cold_start.min_quorum_rounds, 'number');
  assert.strictEqual(typeof policy.cold_start.min_days, 'number');
  assert.ok(['warn', 'fail'].includes(policy.steady_state.mode), 'mode must be warn or fail');
});

test('readPolicy: min_ci_runs is integer >= 1', () => {
  const { readPolicy } = require(READ_POLICY);
  const policy = readPolicy(path.join(__dirname, '..', '.planning', 'formal', 'policy.yaml'));
  assert.ok(Number.isInteger(policy.cold_start.min_ci_runs));
  assert.ok(policy.cold_start.min_ci_runs >= 1);
});

test('readPolicy: min_days parses as float (allows fractional days)', () => {
  const { readPolicy } = require(READ_POLICY);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-test-'));
  const p = path.join(tmp, 'policy.yaml');
  fs.writeFileSync(p, 'min_ci_runs: 5\nmin_quorum_rounds: 10\nmin_days: 0.5\nmode: "warn"\ntp_rate: 0.85\nunavail: 0.15\n');
  try {
    const policy = readPolicy(p);
    assert.strictEqual(policy.cold_start.min_days, 0.5);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readPolicy: returns conservative_priors tp_rate and unavail', () => {
  const { readPolicy } = require(READ_POLICY);
  const policy = readPolicy(path.join(__dirname, '..', '.planning', 'formal', 'policy.yaml'));
  assert.strictEqual(typeof policy.conservative_priors.tp_rate, 'number');
  assert.strictEqual(typeof policy.conservative_priors.unavail, 'number');
});

test('readPolicy: throws descriptive error (not raw EISDIR) when path is a directory', () => {
  const { readPolicy } = require(READ_POLICY);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-dir-'));
  try {
    assert.throws(() => readPolicy(dir), (err) => {
      assert.notStrictEqual(err.code, 'EISDIR', 'should not leak raw EISDIR');
      assert.match(err.message, /not a file|read-policy/i);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readPolicy: rejects numeric field that parses to NaN (lone dot)', () => {
  const { readPolicy } = require(READ_POLICY);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-nan-'));
  const p = path.join(tmp, 'policy.yaml');
  // tp_rate token is a lone '.', which [\d.]+ matches but parseFloat('.') === NaN
  fs.writeFileSync(p, 'min_ci_runs: 5\nmin_quorum_rounds: 10\nmin_days: 1\nmode: warn\ntp_rate: .\nunavail: 0.15\n');
  try {
    assert.throws(() => readPolicy(p), /tp_rate|non-numeric|NaN/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

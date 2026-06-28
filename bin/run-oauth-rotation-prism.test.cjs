#!/usr/bin/env node
'use strict';
// bin/run-oauth-rotation-prism.test.cjs
// Error-path tests for bin/run-oauth-rotation-prism.cjs.
// All tests check error conditions only — no PRISM invocation.
// Requirements: INTG-01, INTG-02

const { test } = require('node:test');
const assert   = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');

const RUN_OAUTH_ROTATION_PRISM = path.join(__dirname, 'run-oauth-rotation-prism.cjs');

test('exits non-zero and prints PRISM binary error when PRISM_BIN points to nonexistent path', () => {
  // The script checks PRISM_BIN existence before the model file — this guard fires first.
  const result = spawnSync(process.execPath, [RUN_OAUTH_ROTATION_PRISM], {
    encoding: 'utf8',
    env: { ...process.env, PRISM_BIN: '/nonexistent/path/to/prism' },
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /PRISM binary not found|PRISM_BIN/i);
});

test('exits non-zero when PRISM_BIN is invalid regardless of model file presence', () => {
  // Confirms the PRISM_BIN check fires before any model file check.
  const result = spawnSync(process.execPath, [RUN_OAUTH_ROTATION_PRISM], {
    encoding: 'utf8',
    env: { ...process.env, PRISM_BIN: '/no/such/prism/binary' },
  });
  assert.strictEqual(result.status, 1);
  // Error message should reference PRISM download or PRISM_BIN env var
  assert.match(result.stderr, /PRISM|prism/i);
});

test('reports failure (non-zero exit) when PRISM is terminated by a signal instead of exiting cleanly', () => {
  const fs  = require('fs');
  const os  = require('os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-signal-'));
  const fakePrism = path.join(tmpDir, 'prism');
  // A PRISM that segfaults / is OOM-killed: terminates via signal, so
  // spawnSync returns { status: null, signal: 'SIGKILL', error: undefined }.
  fs.writeFileSync(fakePrism, '#!/bin/sh\nkill -KILL $$\n');
  fs.chmodSync(fakePrism, 0o755);

  const result = spawnSync(process.execPath, [RUN_OAUTH_ROTATION_PRISM], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PRISM_BIN: fakePrism },
  });

  // A signal-killed model checker must NOT be reported as a passing verification.
  assert.notStrictEqual(result.status, 0,
    'signal-terminated PRISM must exit non-zero, not be treated as a pass');
});

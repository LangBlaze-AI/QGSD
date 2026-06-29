#!/usr/bin/env node
'use strict';
// bin/run-account-pool-alloy.test.cjs
// Error-path tests for bin/run-account-pool-alloy.cjs.
// All tests check error conditions only — no Java or Alloy JAR invocation.
// Requirements: INTG-01, INTG-02

const { test } = require('node:test');
const assert   = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const RUN_ACCOUNT_POOL_ALLOY = path.join(__dirname, 'run-account-pool-alloy.cjs');
const { resolveAlloyJar } = require('./resolve-formal-tools.cjs');

test('exits non-zero and prints JAVA_HOME error when JAVA_HOME points to nonexistent path', () => {
  // The script checks Java before the Alloy JAR — this guard fires first.
  const result = spawnSync(process.execPath, [RUN_ACCOUNT_POOL_ALLOY], {
    encoding: 'utf8',
    env: { ...process.env, JAVA_HOME: '/nonexistent/java/path' },
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /JAVA_HOME|java/i);
});

test('exits non-zero and prints Alloy JAR download URL when JAR not found', () => {
  // Need valid Java so the Java check passes and the JAR check fires.
  const javaHome = process.env.JAVA_HOME ||
    (() => {
      const r = spawnSync('/usr/libexec/java_home', [], { encoding: 'utf8' });
      return r.status === 0 ? r.stdout.trim() : null;
    })() ||
    null;
  if (!javaHome) { return; }  // skip if no Java — cannot reach JAR check without Java

  if (resolveAlloyJar(path.join(__dirname, '..'))) { return; }  // skip if any supported Alloy JAR resolution path exists

  const result = spawnSync(process.execPath, [RUN_ACCOUNT_POOL_ALLOY], {
    encoding: 'utf8',
    env: { ...process.env, JAVA_HOME: javaHome },
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /alloy.*jar|org\.alloytools|download/i);
});

test('accepts a valid Java 17 whose `--version` prints the bare `java 17.x` format (Oracle/modern JDK)', () => {
  if (process.platform === 'win32') { return; }  // POSIX shell-script fake only
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-fakejava-'));
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const fakeJava = path.join(binDir, 'java');
  fs.writeFileSync(fakeJava, '#!/bin/sh\necho "java 17.0.11 2024-04-16 LTS"\n');
  fs.chmodSync(fakeJava, 0o755);

  const result = spawnSync(process.execPath, [RUN_ACCOUNT_POOL_ALLOY], {
    encoding: 'utf8',
    env: { ...process.env, JAVA_HOME: tmp },
  });

  // A valid Java 17 must clear the version gate; the regex currently misses the
  // bare `java 17.x` format and wrongly emits the >=17 rejection.
  assert.doesNotMatch(result.stderr, /Java >=17 required/);
});

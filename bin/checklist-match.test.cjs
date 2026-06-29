#!/usr/bin/env node
'use strict';
// bin/checklist-match.test.cjs
// Tests for checklist matching logic.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { matchChecklists, globToRegex, matchGlob } = require('./checklist-match.cjs');

const REGISTRY_PATH = path.join(__dirname, '..', 'core', 'references', 'checklist-registry.json');

test('file pattern matching: hooks/nf-stop.js triggers security', () => {
  const result = matchChecklists({
    files: ['hooks/nf-stop.js'],
    registryPath: REGISTRY_PATH,
  });
  const ids = result.map(r => r.id);
  assert.ok(ids.includes('security'), `Expected security, got: ${JSON.stringify(ids)}`);
});

test('file pattern matching: test/foo.test.js triggers testing-patterns', () => {
  const result = matchChecklists({
    files: ['test/foo.test.js'],
    registryPath: REGISTRY_PATH,
  });
  const ids = result.map(r => r.id);
  assert.ok(ids.includes('testing-patterns'), `Expected testing-patterns, got: ${JSON.stringify(ids)}`);
});

test('keyword matching: "fix auth token bug" triggers security', () => {
  const result = matchChecklists({
    description: 'fix auth token bug',
    registryPath: REGISTRY_PATH,
  });
  const ids = result.map(r => r.id);
  assert.ok(ids.includes('security'), `Expected security, got: ${JSON.stringify(ids)}`);
});

test('keyword matching: "optimize cache" triggers performance', () => {
  const result = matchChecklists({
    description: 'optimize cache',
    registryPath: REGISTRY_PATH,
  });
  const ids = result.map(r => r.id);
  assert.ok(ids.includes('performance'), `Expected performance, got: ${JSON.stringify(ids)}`);
});

test('task type matching: bug_fix triggers testing-patterns', () => {
  const result = matchChecklists({
    taskType: 'bug_fix',
    registryPath: REGISTRY_PATH,
  });
  const ids = result.map(r => r.id);
  assert.ok(ids.includes('testing-patterns'), `Expected testing-patterns, got: ${JSON.stringify(ids)}`);
});

test('no matches: unrelated file and description returns empty array', () => {
  const result = matchChecklists({
    files: ['README.txt'],
    description: 'update readme heading',
    registryPath: REGISTRY_PATH,
  });
  assert.strictEqual(result.length, 0, `Expected no matches, got: ${JSON.stringify(result)}`);
});

test('multiple matches: bin/install.js with "security audit" triggers security and performance', () => {
  const result = matchChecklists({
    files: ['bin/install.js'],
    description: 'security audit',
    registryPath: REGISTRY_PATH,
  });
  const ids = result.map(r => r.id);
  assert.ok(ids.includes('security'), `Expected security, got: ${JSON.stringify(ids)}`);
  assert.ok(ids.includes('performance'), `Expected performance, got: ${JSON.stringify(ids)}`);
});

test('glob edge case: **/*.test.* matches src/deep/nested/file.test.js', () => {
  const result = matchChecklists({
    files: ['src/deep/nested/file.test.js'],
    registryPath: REGISTRY_PATH,
  });
  const ids = result.map(r => r.id);
  assert.ok(ids.includes('testing-patterns'), `Expected testing-patterns, got: ${JSON.stringify(ids)}`);
});

test('glob helper: globToRegex converts patterns correctly', () => {
  // ** matches any path
  assert.ok(matchGlob('src/deep/file.test.js', '**/*.test.*'));
  // * does not match /
  assert.ok(!matchGlob('src/deep/file.test.js', '*.test.*'));
  // Literal match
  assert.ok(matchGlob('bin/install.js', 'bin/install.js'));
  // test/** matches nested
  assert.ok(matchGlob('test/unit/foo.js', 'test/**'));
});

test('keyword matching: "deprecation planning" triggers deprecation', () => {
  const result = matchChecklists({
    description: 'deprecation planning',
    registryPath: REGISTRY_PATH,
  });
  const ids = result.map(r => r.id);
  assert.ok(ids.includes('deprecation'), `Expected deprecation, got: ${JSON.stringify(ids)}`);
});

test('null description does not crash (treated as no keyword text)', () => {
  assert.doesNotThrow(() => {
    matchChecklists({
      description: null,
      files: ['README.txt'],
      registryPath: REGISTRY_PATH,
    });
  });
  // A non-string description still allows file/task matching to work
  const result = matchChecklists({
    description: null,
    files: ['hooks/nf-stop.js'],
    registryPath: REGISTRY_PATH,
  });
  const ids = result.map(r => r.id);
  assert.ok(ids.includes('security'), `Expected security, got: ${JSON.stringify(ids)}`);
});

test('checklist entry missing triggers does not crash', () => {
  const fs = require('fs');
  const os = require('os');
  const tmp = path.join(os.tmpdir(), `cm-reg-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ checklists: [{ id: 'x', file: 'x.md' }] }));
  try {
    assert.doesNotThrow(() => {
      matchChecklists({ files: ['a.js'], description: 'auth token', taskType: 'bug_fix', registryPath: tmp });
    });
    const result = matchChecklists({ files: ['a.js'], registryPath: tmp });
    assert.strictEqual(result.length, 0);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('registry without checklists array yields no matches and does not crash', () => {
  const fs = require('fs');
  const os = require('os');
  const tmp = path.join(os.tmpdir(), `cm-reg2-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ $schema: 'checklist-registry/v1' }));
  try {
    let result;
    assert.doesNotThrow(() => {
      result = matchChecklists({ files: ['hooks/x.js'], description: 'auth', registryPath: tmp });
    });
    assert.strictEqual(result.length, 0);
  } finally {
    fs.unlinkSync(tmp);
  }
});

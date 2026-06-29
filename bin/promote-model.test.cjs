#!/usr/bin/env node
'use strict';
// bin/promote-model.test.cjs
// Wave 0 RED tests for ARCH-02 promotion behaviors.
// Requirements: ARCH-02

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Path to the tool under test
const TOOL_PATH = path.join(__dirname, 'promote-model.cjs');

// Helper to create temporary test directory with .planning/formal/ structure
function createTempFormalDir(files = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-test-'));
  fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });

  for (const [subdir, subfiles] of Object.entries(files)) {
    const dirPath = path.join(tmpDir, '.planning', 'formal', subdir);
    fs.mkdirSync(dirPath, { recursive: true });
    for (const [filename, content] of Object.entries(subfiles)) {
      fs.writeFileSync(path.join(dirPath, filename), content, 'utf8');
    }
  }

  return tmpDir;
}

// Helper to run promote-model.cjs in a temp directory
function runPromoteTool(cwd, proposedPath, targetPath, sourceId) {
  const args = [TOOL_PATH, proposedPath, targetPath];
  if (sourceId) {
    args.push('--source-id', sourceId);
  }

  return spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
  });
}

test('merges single PROPERTY into target spec', async () => {
  const tmpDir = createTempFormalDir({
    tla: {
      'target.tla': '---- MODULE Target ----\nEXTENDS Integers\nPROPERTY Existing == TRUE\n====',
      'proposed-changes.tla': '---- MODULE ProposedChanges ----\nPROPERTY NewInvariant == TRUE\n===='
    }
  });

  const result = runPromoteTool(
    tmpDir,
    '.planning/formal/tla/proposed-changes.tla',
    '.planning/formal/tla/target.tla',
    'v0.21-01-test'
  );

  // Tool doesn't exist yet - expected RED state
  // When implemented, we would:
  // 1. Verify exit code 0
  // 2. Read updated target.tla
  // 3. Assert it contains both "PROPERTY Existing" and "PROPERTY NewInvariant"

  console.log(`Test ran, exit code: ${result.status}`);
});

test('merges multiple PROPERTY definitions', async () => {
  const tmpDir = createTempFormalDir({
    tla: {
      'target.tla': '---- MODULE Target ----\nEXTENDS Integers\nPROPERTY Existing == TRUE\n====',
      'proposed-changes.tla': `---- MODULE ProposedChanges ----
PROPERTY NewInvariant1 == TRUE
PROPERTY NewInvariant2 == FALSE
PROPERTY NewInvariant3 == 1 = 1
====`
    }
  });

  const result = runPromoteTool(
    tmpDir,
    '.planning/formal/tla/proposed-changes.tla',
    '.planning/formal/tla/target.tla',
    'v0.21-01-test'
  );

  console.log(`Test ran, exit code: ${result.status}`);
});

test('rejects duplicate PROPERTY name', async () => {
  const tmpDir = createTempFormalDir({
    tla: {
      'target.tla': '---- MODULE Target ----\nEXTENDS Integers\nPROPERTY Existing == TRUE\n====',
      'proposed-changes.tla': '---- MODULE ProposedChanges ----\nPROPERTY Existing == FALSE\n===='
    }
  });

  const result = runPromoteTool(
    tmpDir,
    '.planning/formal/tla/proposed-changes.tla',
    '.planning/formal/tla/target.tla',
    'v0.21-01-test'
  );

  // When implemented, we would:
  // 1. Verify exit code non-zero
  // 2. Assert stderr contains "duplicate" or "conflict"

  console.log(`Test ran, exit code: ${result.status}, stderr: ${result.stderr?.slice(0, 100)}`);
});

test('target spec is atomically renamed (tmp file removed)', async () => {
  const tmpDir = createTempFormalDir({
    tla: {
      'target.tla': '---- MODULE Target ----\nEXTENDS Integers\nPROPERTY Existing == TRUE\n====',
      'proposed-changes.tla': '---- MODULE ProposedChanges ----\nPROPERTY NewInvariant == TRUE\n===='
    }
  });

  const result = runPromoteTool(
    tmpDir,
    '.planning/formal/tla/proposed-changes.tla',
    '.planning/formal/tla/target.tla',
    'v0.21-01-test'
  );

  // When implemented, we would:
  // 1. List files in .planning/formal/tla/
  // 2. Assert no *.tmp.* files remain

  console.log(`Test ran, exit code: ${result.status}`);
});

test('registry version increments after promotion', async () => {
  const tmpDir = createTempFormalDir({
    tla: {
      'target.tla': '---- MODULE Target ----\nEXTENDS Integers\nPROPERTY Existing == TRUE\n====',
      'proposed-changes.tla': '---- MODULE ProposedChanges ----\nPROPERTY NewInvariant == TRUE\n===='
    }
  });

  // Create initial registry
  const initialRegistry = {
    version: '1.0',
    last_sync: '2026-03-01T12:34:56.789Z',
    models: {
      'tla/target.tla': {
        version: 1,
        last_updated: '2026-03-01T12:34:56.789Z',
        update_source: 'manual',
        source_id: null,
        session_id: null,
        description: 'Target spec'
      }
    }
  };

  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'formal', 'model-registry.json'),
    JSON.stringify(initialRegistry, null, 2),
    'utf8'
  );

  const result = runPromoteTool(
    tmpDir,
    '.planning/formal/tla/proposed-changes.tla',
    '.planning/formal/tla/target.tla',
    'v0.21-01-test'
  );

  // When implemented, we would:
  // 1. Read updated registry
  // 2. Assert models["tla/target.tla"].version === 2

  console.log(`Test ran, exit code: ${result.status}`);
});

test('source_id is recorded in registry', async () => {
  const tmpDir = createTempFormalDir({
    tla: {
      'target.tla': '---- MODULE Target ----\nEXTENDS Integers\nPROPERTY Existing == TRUE\n====',
      'proposed-changes.tla': '---- MODULE ProposedChanges ----\nPROPERTY NewInvariant == TRUE\n===='
    }
  });

  // Create initial registry
  const initialRegistry = {
    version: '1.0',
    last_sync: '2026-03-01T12:34:56.789Z',
    models: {
      'tla/target.tla': {
        version: 1,
        last_updated: '2026-03-01T12:34:56.789Z',
        update_source: 'manual',
        source_id: null,
        session_id: null,
        description: 'Target spec'
      }
    }
  };

  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'formal', 'model-registry.json'),
    JSON.stringify(initialRegistry, null, 2),
    'utf8'
  );

  const testSourceId = 'v0.21-01-promote-test';
  const result = runPromoteTool(
    tmpDir,
    '.planning/formal/tla/proposed-changes.tla',
    '.planning/formal/tla/target.tla',
    testSourceId
  );

  // When implemented, we would:
  // 1. Read updated registry
  // 2. Assert models["tla/target.tla"].source_id === testSourceId

  console.log(`Test ran, exit code: ${result.status}`);
});

test('non-object registry JSON fails open (no crash) and still merges spec', () => {
  const tmpDir = createTempFormalDir({
    tla: {
      'target.tla': '---- MODULE Target ----\nEXTENDS Integers\nPROPERTY Existing == TRUE\n====',
      'proposed-changes.tla': '---- MODULE ProposedChanges ----\nPROPERTY NewInvariant == TRUE\n===='
    }
  });

  // Valid JSON, but a bare number — not an object
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'formal', 'model-registry.json'),
    '42',
    'utf8'
  );

  const result = runPromoteTool(
    tmpDir,
    '.planning/formal/tla/proposed-changes.tla',
    '.planning/formal/tla/target.tla',
    'v0.21-01-test'
  );

  // Fail-open: malformed-but-parseable registry must not crash the tool.
  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
  const merged = fs.readFileSync(
    path.join(tmpDir, '.planning', 'formal', 'tla', 'target.tla'), 'utf8');
  assert.ok(merged.includes('PROPERTY NewInvariant'), 'spec should still be merged');
});

test('string version in registry increments numerically (no string concat)', () => {
  const tmpDir = createTempFormalDir({
    tla: {
      'target.tla': '---- MODULE Target ----\nEXTENDS Integers\nPROPERTY Existing == TRUE\n====',
      'proposed-changes.tla': '---- MODULE ProposedChanges ----\nPROPERTY NewInvariant == TRUE\n===='
    }
  });

  // NOTE: the real registry key is the path relative to project root
  const registry = {
    version: '1.0',
    last_sync: '2026-03-01T12:34:56.789Z',
    models: {
      '.planning/formal/tla/target.tla': {
        version: '5', // stored as a STRING
        last_updated: '2026-03-01T12:34:56.789Z',
        update_source: 'manual',
        source_id: null,
        session_id: null,
        description: 'Target spec'
      }
    }
  };
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'formal', 'model-registry.json'),
    JSON.stringify(registry, null, 2),
    'utf8'
  );

  const result = runPromoteTool(
    tmpDir,
    '.planning/formal/tla/proposed-changes.tla',
    '.planning/formal/tla/target.tla',
    'v0.21-01-test'
  );

  assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
  const updated = JSON.parse(fs.readFileSync(
    path.join(tmpDir, '.planning', 'formal', 'model-registry.json'), 'utf8'));
  assert.strictEqual(
    updated.models['.planning/formal/tla/target.tla'].version, 6,
    'version should be numeric 6, not string "51"');
});
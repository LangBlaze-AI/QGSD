#!/usr/bin/env node
'use strict';
// Test suite for addSlotToQuorumActive() in bin/migrate-to-slots.cjs
// Uses Node.js built-in test runner: node --test bin/migrate-to-slots.test.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { addSlotToQuorumActive, migrateClaudeJson, populateActiveSlots } = require('./migrate-to-slots.cjs');

// Helper: create a temporary directory and return its path
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nf-add-slot-test-'));
}

// Helper: clean up a temp directory
function cleanTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// MS-TC-ADD-1: new slot not in quorum_active → added, returns {added: true}
test('MS-TC-ADD-1: new slot not in quorum_active is added', () => {
  const tmpDir = makeTmpDir();
  try {
    const nfPath = path.join(tmpDir, 'nf.json');
    fs.writeFileSync(nfPath, JSON.stringify({ quorum_active: ['copilot-1'] }) + '\n');
    const result = addSlotToQuorumActive('copilot-2', nfPath);
    assert.strictEqual(result.added, true, 'added must be true for new slot');
    assert.strictEqual(result.slot, 'copilot-2', 'slot must match the input');
    const after = JSON.parse(fs.readFileSync(nfPath, 'utf8'));
    assert.deepStrictEqual(after.quorum_active, ['copilot-1', 'copilot-2']);
  } finally {
    cleanTmpDir(tmpDir);
  }
});

// MS-TC-ADD-2: slot already in quorum_active → no-op, returns {added: false, skipped: true}
test('MS-TC-ADD-2: slot already in quorum_active is no-op', () => {
  const tmpDir = makeTmpDir();
  try {
    const nfPath = path.join(tmpDir, 'nf.json');
    fs.writeFileSync(nfPath, JSON.stringify({ quorum_active: ['copilot-1', 'copilot-2'] }) + '\n');
    const result = addSlotToQuorumActive('copilot-2', nfPath);
    assert.strictEqual(result.added, false, 'added must be false for already-present slot');
    assert.strictEqual(result.skipped, true, 'skipped must be true for already-present slot');
    const after = JSON.parse(fs.readFileSync(nfPath, 'utf8'));
    assert.deepStrictEqual(after.quorum_active, ['copilot-1', 'copilot-2'], 'array must be unchanged');
  } finally {
    cleanTmpDir(tmpDir);
  }
});

// MS-TC-ADD-3: quorum_active absent in nf.json → creates array with the new slot
test('MS-TC-ADD-3: quorum_active absent creates array with new slot', () => {
  const tmpDir = makeTmpDir();
  try {
    const nfPath = path.join(tmpDir, 'nf.json');
    fs.writeFileSync(nfPath, JSON.stringify({ required_models: {} }) + '\n');
    const result = addSlotToQuorumActive('opencode-2', nfPath);
    assert.strictEqual(result.added, true, 'added must be true');
    const after = JSON.parse(fs.readFileSync(nfPath, 'utf8'));
    assert.deepStrictEqual(after.quorum_active, ['opencode-2']);
  } finally {
    cleanTmpDir(tmpDir);
  }
});

// MS-TC-ADD-4: dryRun=true → returns {added: true, dryRun: true} without writing file
test('MS-TC-ADD-4: dryRun=true returns {added: true, dryRun: true} without writing', () => {
  const tmpDir = makeTmpDir();
  try {
    const nfPath = path.join(tmpDir, 'nf.json');
    const initial = { quorum_active: ['copilot-1'] };
    fs.writeFileSync(nfPath, JSON.stringify(initial) + '\n');
    const result = addSlotToQuorumActive('copilot-2', nfPath, true);
    assert.strictEqual(result.added, true, 'added must be true in dryRun');
    assert.strictEqual(result.dryRun, true, 'dryRun must be true');
    const after = JSON.parse(fs.readFileSync(nfPath, 'utf8'));
    assert.deepStrictEqual(after.quorum_active, ['copilot-1'], 'file must be unchanged in dryRun');
  } finally {
    cleanTmpDir(tmpDir);
  }
});

// MS-TC-ADD-5: multiple calls with different slots → all appended, order preserved
test('MS-TC-ADD-5: multiple calls append all slots in call order', () => {
  const tmpDir = makeTmpDir();
  try {
    const nfPath = path.join(tmpDir, 'nf.json');
    fs.writeFileSync(nfPath, JSON.stringify({ quorum_active: ['claude-1'] }) + '\n');
    addSlotToQuorumActive('copilot-2', nfPath);
    addSlotToQuorumActive('opencode-2', nfPath);
    addSlotToQuorumActive('codex-cli-2', nfPath);
    const after = JSON.parse(fs.readFileSync(nfPath, 'utf8'));
    assert.deepStrictEqual(
      after.quorum_active,
      ['claude-1', 'copilot-2', 'opencode-2', 'codex-cli-2'],
      'all slots must be appended in order'
    );
  } finally {
    cleanTmpDir(tmpDir);
  }
});

// MS-TC-ADD-6: nf.json whose entire content is literal `null` must not crash
test('MS-TC-ADD-6: nf.json containing literal null is treated as empty config', () => {
  const tmpDir = makeTmpDir();
  try {
    const nfPath = path.join(tmpDir, 'nf.json');
    fs.writeFileSync(nfPath, 'null\n');
    const result = addSlotToQuorumActive('copilot-2', nfPath);
    assert.strictEqual(result.added, true, 'added must be true for null config');
    assert.strictEqual(result.slot, 'copilot-2');
    const after = JSON.parse(fs.readFileSync(nfPath, 'utf8'));
    assert.deepStrictEqual(after.quorum_active, ['copilot-2']);
  } finally {
    cleanTmpDir(tmpDir);
  }
});

// MS-TC-CLAUDE-NULL: claude.json containing literal null is a no-op, not a crash
test('MS-TC-CLAUDE-NULL: claude.json literal null returns no-op', () => {
  const tmpDir = makeTmpDir();
  try {
    const p = path.join(tmpDir, 'claude.json');
    fs.writeFileSync(p, 'null\n');
    const result = migrateClaudeJson(p, false);
    assert.strictEqual(result.changed, 0);
    assert.deepStrictEqual(result.renamed, []);
  } finally {
    cleanTmpDir(tmpDir);
  }
});

// MS-TC-POP-NULL: nf.json literal null is populated from claude.json, no crash
test('MS-TC-POP-NULL: nf.json literal null is populated, not crashed', () => {
  const tmpDir = makeTmpDir();
  try {
    const nfPath = path.join(tmpDir, 'nf.json');
    const claudePath = path.join(tmpDir, 'claude.json');
    fs.writeFileSync(nfPath, 'null\n');
    fs.writeFileSync(claudePath, JSON.stringify({ mcpServers: { 'claude-1': {} } }) + '\n');
    const result = populateActiveSlots(nfPath, claudePath, false);
    assert.strictEqual(result.skipped, false);
    assert.deepStrictEqual(result.slots, ['claude-1']);
    const after = JSON.parse(fs.readFileSync(nfPath, 'utf8'));
    assert.deepStrictEqual(after.quorum_active, ['claude-1']);
  } finally {
    cleanTmpDir(tmpDir);
  }
});

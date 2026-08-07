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

// ── MIGRATE-GUARD-01: preset slots must survive --migrate-slots ───────────────
// SLOT_MIGRATION_MAP treats `claude-minimax` / `claude-kimi` / `claude-glm` as legacy
// MODEL names, but that is also the shape /nf:link-daintree produces today
// ({agentName}-{slug}). Renaming a live preset clone moves its mcpServers key to
// `claude-2` while providers.json still says `claude-minimax` — the provider entry is
// orphaned and `mcp__claude-minimax__…` stops existing.

function writeFixture(dir, { servers, providers }) {
  const claudeJson = path.join(dir, 'claude.json');
  const providersJson = path.join(dir, 'providers.json');
  fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: servers }, null, 2));
  fs.writeFileSync(providersJson, JSON.stringify({ providers }, null, 2));
  return { claudeJson, providersJson };
}

test('MS-TC-GUARD-1: a Daintree preset slot is NOT renamed', () => {
  const dir = makeTmpDir();
  try {
    const { claudeJson, providersJson } = writeFixture(dir, {
      servers: { 'claude-minimax': { command: 'claude' }, 'claude-kimi': { command: 'claude' } },
      providers: [
        { name: 'claude-minimax', daintree_preset_id: 'user-055f3ff8' },
        { name: 'claude-kimi', daintree_preset_id: 'user-af326ff9' },
      ],
    });
    const r = migrateClaudeJson(claudeJson, false, { providersPath: providersJson });

    assert.equal(r.changed, 0, 'preset slots must not be migrated');
    assert.equal(r.skipped.length, 2, 'both preset slots must be reported as skipped');
    const after = JSON.parse(fs.readFileSync(claudeJson, 'utf8')).mcpServers;
    assert.ok(after['claude-minimax'], 'claude-minimax must keep its name');
    assert.ok(after['claude-kimi'], 'claude-kimi must keep its name');
    assert.equal(after['claude-2'], undefined, 'no claude-2 may be created');
    // providers.json untouched
    const provs = JSON.parse(fs.readFileSync(providersJson, 'utf8')).providers;
    assert.deepEqual(provs.map(p => p.name), ['claude-minimax', 'claude-kimi']);
  } finally { cleanTmpDir(dir); }
});

test('MS-TC-GUARD-2: a genuinely legacy slot IS still renamed, in both files', () => {
  // The guard must narrow the migration, not disable it. A pre-slot install whose
  // provider entry carries no daintree_preset_id still migrates — and providers.json
  // is renamed in lockstep so the pairing survives.
  const dir = makeTmpDir();
  try {
    const { claudeJson, providersJson } = writeFixture(dir, {
      servers: { 'claude-deepseek': { command: 'claude' } },
      providers: [{ name: 'claude-deepseek', mainTool: 'claude' }],
    });
    const r = migrateClaudeJson(claudeJson, false, { providersPath: providersJson });

    assert.equal(r.changed, 1);
    assert.deepEqual(r.renamed, [{ from: 'claude-deepseek', to: 'claude-1' }]);
    const after = JSON.parse(fs.readFileSync(claudeJson, 'utf8')).mcpServers;
    assert.ok(after['claude-1'] && !after['claude-deepseek'], 'mcpServers key renamed');
    const provs = JSON.parse(fs.readFileSync(providersJson, 'utf8')).providers;
    assert.equal(provs[0].name, 'claude-1', 'providers.json must follow the rename');
  } finally { cleanTmpDir(dir); }
});

test('MS-TC-GUARD-3: dryRun writes nothing to either file', () => {
  const dir = makeTmpDir();
  try {
    const { claudeJson, providersJson } = writeFixture(dir, {
      servers: { 'claude-deepseek': { command: 'claude' } },
      providers: [{ name: 'claude-deepseek' }],
    });
    const before = [fs.readFileSync(claudeJson, 'utf8'), fs.readFileSync(providersJson, 'utf8')];
    const r = migrateClaudeJson(claudeJson, true, { providersPath: providersJson });

    assert.equal(r.changed, 1, 'dry run still reports what it would do');
    assert.deepEqual(
      [fs.readFileSync(claudeJson, 'utf8'), fs.readFileSync(providersJson, 'utf8')], before,
      'dry run must not write either file',
    );
  } finally { cleanTmpDir(dir); }
});

test('MS-TC-GUARD-4: a missing/corrupt providers.json fails OPEN (legacy installs)', () => {
  // The pre-slot world this migration exists for has no providers.json at all. Absent
  // or unreadable means "nothing to protect, nothing to sync" — never a hard failure.
  const dir = makeTmpDir();
  try {
    const claudeJson = path.join(dir, 'claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { 'codex-cli': { command: 'codex' } } }));
    const missing = path.join(dir, 'does-not-exist.json');
    assert.equal(migrateClaudeJson(claudeJson, true, { providersPath: missing }).changed, 1);

    const corrupt = path.join(dir, 'corrupt.json');
    fs.writeFileSync(corrupt, '{ not json');
    assert.equal(migrateClaudeJson(claudeJson, true, { providersPath: corrupt }).changed, 1);
  } finally { cleanTmpDir(dir); }
});

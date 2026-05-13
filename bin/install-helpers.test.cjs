'use strict';

// Unit tests for bin/install-helpers.cjs — specifically mergeProvidersJson.
// Run: node --test bin/install-helpers.test.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { mergeProvidersJson } = require('./install-helpers.cjs');

function tmpDir(suffix) {
  const d = path.join(os.tmpdir(), `nf-merge-${process.pid}-${Date.now()}-${suffix}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

// MERGE-01: Fresh install (no user file) → straight copy from repo
test('MERGE-01: fresh install copies repo source to user path', () => {
  const dir = tmpDir('m01');
  try {
    const repoPath = path.join(dir, 'repo.json');
    const userPath = path.join(dir, 'user.json'); // does NOT exist yet
    writeJson(repoPath, { providers: [{ name: 'codex-1' }, { name: 'claude-1' }] });

    const result = mergeProvidersJson(repoPath, userPath);

    assert.equal(result.status, 'fresh-copy');
    assert.equal(result.preservedCount, 0);
    assert.ok(fs.existsSync(userPath), 'user file must be created');
    assert.deepEqual(readJson(userPath).providers.map(p => p.name), ['codex-1', 'claude-1']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// MERGE-02: User has a fan-out preset slot → preserved on re-install
test('MERGE-02: user-added preset slot (daintree_preset_id) preserved across install', () => {
  const dir = tmpDir('m02');
  try {
    const repoPath = path.join(dir, 'repo.json');
    const userPath = path.join(dir, 'user.json');
    writeJson(repoPath, { providers: [{ name: 'codex-1', model: 'gpt-5' }, { name: 'claude-1', model: 'opus' }] });
    writeJson(userPath, {
      providers: [
        { name: 'codex-1', model: 'gpt-5' },
        { name: 'claude-1', model: 'opus' },
        // Fan-out preset slot — user-added, not in repo
        {
          name: 'claude-z-ai',
          model: 'glm-5.1',
          provider: 'anthropic',
          mainTool: 'claude',
          env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
          daintree_preset_id: 'user-47d3419a-275e-4d73-8ef2-6be27181ce33',
          daintree_preset_name: 'Z.AI',
        },
      ],
    });

    const result = mergeProvidersJson(repoPath, userPath);

    assert.equal(result.status, 'merged');
    assert.equal(result.preservedCount, 1);
    assert.deepEqual(result.preservedNames, ['claude-z-ai']);
    const merged = readJson(userPath).providers;
    assert.deepEqual(merged.map(p => p.name), ['codex-1', 'claude-1', 'claude-z-ai']);
    // Preserved slot's metadata is intact
    const zai = merged.find(p => p.name === 'claude-z-ai');
    assert.equal(zai.daintree_preset_id, 'user-47d3419a-275e-4d73-8ef2-6be27181ce33');
    assert.equal(zai.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// MERGE-03: Repo updates an existing slot's metadata → repo version wins
test('MERGE-03: repo-shipped slot is refreshed from repo (metadata bumps propagate)', () => {
  const dir = tmpDir('m03');
  try {
    const repoPath = path.join(dir, 'repo.json');
    const userPath = path.join(dir, 'user.json');
    // Repo bumped claude-1's model from "opus" to "opus-4-7"
    writeJson(repoPath, { providers: [{ name: 'claude-1', model: 'opus-4-7', description: 'updated' }] });
    writeJson(userPath, { providers: [{ name: 'claude-1', model: 'opus', description: 'old' }] });

    mergeProvidersJson(repoPath, userPath);

    const merged = readJson(userPath).providers;
    assert.equal(merged.length, 1);
    // Repo version wins for repo-shipped slots
    assert.equal(merged[0].model, 'opus-4-7');
    assert.equal(merged[0].description, 'updated');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// MERGE-04: User has multiple custom slots (e.g. user-added MCP slots not in repo) → all preserved
test('MERGE-04: multiple user-added slots preserved', () => {
  const dir = tmpDir('m04');
  try {
    const repoPath = path.join(dir, 'repo.json');
    const userPath = path.join(dir, 'user.json');
    writeJson(repoPath, { providers: [{ name: 'claude-1' }] });
    writeJson(userPath, {
      providers: [
        { name: 'claude-1' },
        { name: 'custom-together-1', provider: 'together' }, // user-added slot
        { name: 'custom-together-2', provider: 'together' },
        { name: 'claude-z-ai', daintree_preset_id: 'abc' },
        { name: 'my-custom-slot' }, // hand-rolled
      ],
    });

    const result = mergeProvidersJson(repoPath, userPath);

    assert.equal(result.preservedCount, 4);
    assert.deepEqual(result.preservedNames.sort(), ['custom-together-1', 'custom-together-2', 'claude-z-ai', 'my-custom-slot']);
    const merged = readJson(userPath).providers;
    assert.equal(merged.length, 5);
    assert.equal(merged[0].name, 'claude-1', 'repo entries come first');
    assert.deepEqual(merged.slice(1).map(p => p.name), ['custom-together-1', 'custom-together-2', 'claude-z-ai', 'my-custom-slot']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// MERGE-05: Corrupt user file → fall back to repo overwrite (install never wedges)
test('MERGE-05: corrupt user JSON falls back to repo overwrite (fail-open)', () => {
  const dir = tmpDir('m05');
  try {
    const repoPath = path.join(dir, 'repo.json');
    const userPath = path.join(dir, 'user.json');
    writeJson(repoPath, { providers: [{ name: 'claude-1' }] });
    fs.writeFileSync(userPath, 'not valid json {{{');

    const logs = [];
    const result = mergeProvidersJson(repoPath, userPath, { log: msg => logs.push(msg) });

    assert.equal(result.status, 'fallback-copy');
    assert.equal(result.preservedCount, 0);
    assert.deepEqual(readJson(userPath).providers.map(p => p.name), ['claude-1']);
    assert.ok(logs.some(m => /unreadable/.test(m)), 'must log the corruption fallback');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// MERGE-06: Corrupt repo source → bail without touching user file
test('MERGE-06: corrupt repo source bails without touching user file', () => {
  const dir = tmpDir('m06');
  try {
    const repoPath = path.join(dir, 'repo.json');
    const userPath = path.join(dir, 'user.json');
    fs.writeFileSync(repoPath, 'not valid json {{{');
    writeJson(userPath, { providers: [{ name: 'user-only-slot' }] });

    const result = mergeProvidersJson(repoPath, userPath);

    assert.equal(result.status, 'error');
    // User file should still be intact and unchanged
    assert.deepEqual(readJson(userPath).providers.map(p => p.name), ['user-only-slot']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// MERGE-07: Atomic write — no .merge.tmp file lingers after success
test('MERGE-07: atomic write leaves no .merge.tmp lingering', () => {
  const dir = tmpDir('m07');
  try {
    const repoPath = path.join(dir, 'repo.json');
    const userPath = path.join(dir, 'user.json');
    writeJson(repoPath, { providers: [{ name: 'claude-1' }] });
    writeJson(userPath, { providers: [{ name: 'claude-1' }, { name: 'extra' }] });

    mergeProvidersJson(repoPath, userPath);
    assert.ok(!fs.existsSync(userPath + '.merge.tmp'), '.merge.tmp must be cleaned up');
    assert.ok(fs.existsSync(userPath), 'user file must exist');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// MERGE-08: User file has providers as non-array (or missing) → treat as empty, repo wins
test('MERGE-08: malformed user.providers treated as empty', () => {
  const dir = tmpDir('m08');
  try {
    const repoPath = path.join(dir, 'repo.json');
    const userPath = path.join(dir, 'user.json');
    writeJson(repoPath, { providers: [{ name: 'claude-1' }] });
    writeJson(userPath, { providers: 'not-an-array' });

    const result = mergeProvidersJson(repoPath, userPath);

    assert.equal(result.status, 'merged');
    assert.equal(result.preservedCount, 0);
    assert.deepEqual(readJson(userPath).providers.map(p => p.name), ['claude-1']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// MERGE-09: Order — repo entries always come before preserved user extras
test('MERGE-09: repo entries always precede user extras in merged output', () => {
  const dir = tmpDir('m09');
  try {
    const repoPath = path.join(dir, 'repo.json');
    const userPath = path.join(dir, 'user.json');
    writeJson(repoPath, { providers: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] });
    writeJson(userPath, {
      // user has them in a different order, plus extras interleaved
      providers: [{ name: 'extra-1' }, { name: 'b' }, { name: 'extra-2' }, { name: 'a' }, { name: 'c' }],
    });

    mergeProvidersJson(repoPath, userPath);

    const names = readJson(userPath).providers.map(p => p.name);
    assert.deepEqual(names, ['a', 'b', 'c', 'extra-1', 'extra-2'],
      'repo order preserved first, user extras appended in their declared order');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

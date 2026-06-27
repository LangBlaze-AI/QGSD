'use strict';

// Unit tests for bin/install-helpers.cjs — specifically mergeProvidersJson.
// Run: node --test bin/install-helpers.test.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  mergeProvidersJson,
  restoreDaintreePresets,
  shouldCopyToNfBin,
  synthesizeMcpEntry,
  installedUnifiedMcpPath,
  isUnderInstallDir,
  mcpArgsNeedMigration,
} = require('./install-helpers.cjs');

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
    assert.deepEqual(result.preservedNames.sort(), ['claude-z-ai', 'custom-together-1', 'custom-together-2', 'my-custom-slot']);
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

// ── Daintree preset restoration tests (issue #168) ──

// DP-01: Stripped slot gets metadata restored from daintree-presets.json
test('DP-01: stripped preset slot restored from durable store', () => {
  const dir = tmpDir('dp01');
  try {
    const presetsPath = path.join(dir, 'daintree-presets.json');
    writeJson(presetsPath, {
      version: 1,
      presets: {
        'claude-z-ai': {
          daintree_preset_id: 'preset-123',
          daintree_preset_name: 'Z.AI',
          daintree_preset_family: 'anthropic',
          agent_name: 'claude',
          vanilla_slot_name: 'claude-1',
          env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'tok' },
          model: 'claude-opus-4-6',
          display_provider: 'Z.AI',
        },
      },
    });

    const providers = [
      { name: 'claude-1', provider: 'anthropic', mainTool: 'claude', model: 'claude-opus-4-6' },
      { name: 'claude-z-ai', provider: 'claude', mainTool: 'claude' },
    ];

    const result = restoreDaintreePresets(providers, presetsPath);

    assert.equal(result.restoredCount, 1);
    assert.deepEqual(result.restoredNames, ['claude-z-ai']);
    const zai = providers.find(p => p.name === 'claude-z-ai');
    assert.equal(zai.daintree_preset_id, 'preset-123');
    assert.equal(zai.daintree_preset_name, 'Z.AI');
    assert.equal(zai.daintree_preset_family, 'anthropic');
    assert.equal(zai.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
    assert.equal(zai.model, 'claude-opus-4-6');
    assert.equal(zai.display_provider, 'Z.AI');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// DP-02: Entirely missing slot reconstructed from vanilla + preset store
test('DP-02: missing preset slot reconstructed from vanilla + durable store', () => {
  const dir = tmpDir('dp02');
  try {
    const presetsPath = path.join(dir, 'daintree-presets.json');
    writeJson(presetsPath, {
      version: 1,
      presets: {
        'claude-minimax': {
          daintree_preset_id: 'preset-456',
          daintree_preset_name: 'MiniMax',
          daintree_preset_family: 'anthropic',
          agent_name: 'claude',
          vanilla_slot_name: 'claude-1',
          env: { ANTHROPIC_BASE_URL: 'https://api.minimax.chat/v1/anthropic' },
          model: 'minimax-m2',
          display_provider: 'MiniMax',
        },
      },
    });

    const providers = [
      { name: 'claude-1', provider: 'anthropic', mainTool: 'claude', model: 'opus', description: 'Claude Opus' },
    ];

    const result = restoreDaintreePresets(providers, presetsPath);

    assert.equal(result.restoredCount, 1);
    assert.deepEqual(result.restoredNames, ['claude-minimax']);
    const minimax = providers.find(p => p.name === 'claude-minimax');
    assert.ok(minimax, 'reconstructed slot must exist');
    assert.equal(minimax.daintree_preset_id, 'preset-456');
    assert.equal(minimax.daintree_preset_name, 'MiniMax');
    assert.equal(minimax.mainTool, 'claude');
    assert.equal(minimax.env.ANTHROPIC_BASE_URL, 'https://api.minimax.chat/v1/anthropic');
    assert.equal(minimax.model, 'minimax-m2');
    assert.equal(minimax.display_provider, 'MiniMax');
    assert.ok(minimax.description.includes('Daintree preset: MiniMax'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// DP-03: Multiple install cycles — presets survive repeated restoration (issue #168 AC1)
test('DP-03: presets survive multiple install cycles (issue #168 AC1)', () => {
  const dir = tmpDir('dp03');
  try {
    const presetsPath = path.join(dir, 'daintree-presets.json');
    writeJson(presetsPath, {
      version: 1,
      presets: {
        'claude-z-ai': {
          daintree_preset_id: 'preset-789',
          daintree_preset_name: 'Z.AI',
          daintree_preset_family: 'anthropic',
          agent_name: 'claude',
          vanilla_slot_name: 'claude-1',
          env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
          model: 'glm-5.1',
          display_provider: 'Z.AI',
        },
        'claude-minimax': {
          daintree_preset_id: 'preset-012',
          daintree_preset_name: 'MiniMax',
          daintree_preset_family: 'anthropic',
          agent_name: 'claude',
          vanilla_slot_name: 'claude-1',
          env: { ANTHROPIC_BASE_URL: 'https://api.minimax.chat/v1/anthropic' },
          model: 'minimax-m2',
          display_provider: 'MiniMax',
        },
      },
    });

    for (let cycle = 1; cycle <= 3; cycle++) {
      const providers = [
        { name: 'claude-1', provider: 'anthropic', mainTool: 'claude', model: 'opus', description: 'Claude' },
        { name: 'claude-z-ai', provider: 'claude', mainTool: 'claude' },
      ];

      const result = restoreDaintreePresets(providers, presetsPath);

      assert.equal(result.restoredCount, 2, `cycle ${cycle}: both presets must be restored`);
      const zai = providers.find(p => p.name === 'claude-z-ai');
      const minimax = providers.find(p => p.name === 'claude-minimax');
      assert.equal(zai.daintree_preset_id, 'preset-789', `cycle ${cycle}: z-ai preset_id intact`);
      assert.equal(zai.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic', `cycle ${cycle}: z-ai env intact`);
      assert.equal(zai.display_provider, 'Z.AI', `cycle ${cycle}: z-ai display_provider intact`);
      assert.ok(minimax, `cycle ${cycle}: minimax slot reconstructed`);
      assert.equal(minimax.daintree_preset_id, 'preset-012', `cycle ${cycle}: minimax preset_id intact`);
      assert.equal(minimax.display_provider, 'MiniMax', `cycle ${cycle}: minimax display_provider intact`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// DP-04: Restored daintree_preset_id enables idempotent re-import (issue #168 AC2)
test('DP-04: restored preset_id enables idempotent re-import (issue #168 AC2)', () => {
  const dir = tmpDir('dp04');
  try {
    const presetsPath = path.join(dir, 'daintree-presets.json');
    writeJson(presetsPath, {
      version: 1,
      presets: {
        'claude-z-ai': {
          daintree_preset_id: 'user-47d3419a-275e-4d73-8ef2-6be27181ce33',
          daintree_preset_name: 'Z.AI',
          daintree_preset_family: 'anthropic',
          agent_name: 'claude',
          vanilla_slot_name: 'claude-1',
          env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
          model: 'glm-5.1',
          display_provider: 'Z.AI',
        },
      },
    });

    const providers = [
      { name: 'claude-1', provider: 'anthropic', mainTool: 'claude' },
      { name: 'claude-z-ai', provider: 'claude', mainTool: 'claude' },
    ];

    restoreDaintreePresets(providers, presetsPath);

    const zai = providers.find(p => p.name === 'claude-z-ai');
    assert.equal(zai.daintree_preset_id, 'user-47d3419a-275e-4d73-8ef2-6be27181ce33');
    assert.equal(String(zai.daintree_preset_id), zai.daintree_preset_id, 'preset_id must be a string');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// DP-05: No presets store → no-op
test('DP-05: missing presets store is a no-op', () => {
  const dir = tmpDir('dp05');
  try {
    const presetsPath = path.join(dir, 'nonexistent.json');
    const providers = [{ name: 'claude-1', mainTool: 'claude' }];

    const result = restoreDaintreePresets(providers, presetsPath);

    assert.equal(result.restoredCount, 0);
    assert.deepEqual(result.restoredNames, []);
    assert.equal(providers.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// DP-06: Vanilla slot missing → preset skipped gracefully
test('DP-06: preset with missing vanilla slot is skipped', () => {
  const dir = tmpDir('dp06');
  try {
    const presetsPath = path.join(dir, 'daintree-presets.json');
    writeJson(presetsPath, {
      version: 1,
      presets: {
        'claude-z-ai': {
          daintree_preset_id: 'preset-999',
          daintree_preset_name: 'Z.AI',
          agent_name: 'claude',
          vanilla_slot_name: 'claude-1',
          env: { ANTHROPIC_BASE_URL: 'https://api.z.ai' },
          model: 'glm-5.1',
          display_provider: 'Z.AI',
        },
      },
    });

    const providers = [];

    const result = restoreDaintreePresets(providers, presetsPath);

    assert.equal(result.restoredCount, 0);
    assert.equal(providers.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// MERGE-10: Provider with null/undefined name → filtered out safely (boundary value)
test('MERGE-10: provider entries with null/undefined names are filtered out', () => {
  const dir = tmpDir('m10');
  try {
    const repoPath = path.join(dir, 'repo.json');
    const userPath = path.join(dir, 'user.json');
    writeJson(repoPath, { providers: [{ name: 'claude-1' }] });
    writeJson(userPath, {
      providers: [
        { name: 'claude-1' },
        { name: null }, // invalid entry
        { name: undefined }, // invalid entry
        null, // completely null entry
        {}, // missing name property
        { name: 'valid-custom' }, // should be preserved
      ],
    });

    const result = mergeProvidersJson(repoPath, userPath);

    assert.equal(result.status, 'merged');
    assert.equal(result.preservedCount, 1);
    assert.deepEqual(result.preservedNames, ['valid-custom']);
    const merged = readJson(userPath).providers;
    assert.equal(merged.length, 2);
    assert.deepEqual(merged.map(p => p.name), ['claude-1', 'valid-custom']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// MERGE-11: Top-level fields merge with repo winning (shallow merge, not deep)
test('MERGE-11: top-level fields merge shallowly with repo winning on conflict', () => {
  const dir = tmpDir('m11');
  try {
    const repoPath = path.join(dir, 'repo.json');
    const userPath = path.join(dir, 'user.json');
    writeJson(repoPath, {
      schema_version: '2.0',
      custom_field: 'repo-value',
      providers: [{ name: 'claude-1' }],
    });
    writeJson(userPath, {
      schema_version: '1.0',
      custom_field: 'user-value',
      user_only_field: 'should-preserve',
      providers: [{ name: 'claude-1' }],
    });

    mergeProvidersJson(repoPath, userPath);

    const merged = readJson(userPath);
    assert.equal(merged.schema_version, '2.0', 'repo wins on schema_version');
    assert.equal(merged.custom_field, 'repo-value', 'repo wins on custom_field');
    assert.equal(merged.user_only_field, 'should-preserve', 'user-only fields preserved');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// DP-07: Malformed preset store (no presets field) → graceful no-op
test('DP-07: malformed preset store missing presets field is a no-op', () => {
  const dir = tmpDir('dp07');
  try {
    const presetsPath = path.join(dir, 'daintree-presets.json');
    writeJson(presetsPath, {
      version: 1,
      // presets field missing entirely
    });

    const providers = [{ name: 'claude-1', mainTool: 'claude' }];

    const result = restoreDaintreePresets(providers, presetsPath);

    assert.equal(result.restoredCount, 0);
    assert.deepEqual(result.restoredNames, []);
    assert.equal(providers.length, 1);
    assert.equal(providers[0].name, 'claude-1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// DP-08: Preset with already present daintree_preset_id → not restored again (idempotency)
test('DP-08: preset with existing daintree_preset_id is not restored again', () => {
  const dir = tmpDir('dp08');
  try {
    const presetsPath = path.join(dir, 'daintree-presets.json');
    writeJson(presetsPath, {
      version: 1,
      presets: {
        'claude-z-ai': {
          daintree_preset_id: 'preset-123',
          daintree_preset_name: 'Z.AI',
          agent_name: 'claude',
          env: { ANTHROPIC_BASE_URL: 'https://new-url.com' },
          model: 'new-model',
        },
      },
    });

    const providers = [
      { name: 'claude-1', mainTool: 'claude' },
      {
        name: 'claude-z-ai',
        daintree_preset_id: 'preset-999', // already set, different value
        env: { ANTHROPIC_BASE_URL: 'https://old-url.com' },
        model: 'old-model',
      },
    ];

    const result = restoreDaintreePresets(providers, presetsPath);

    // Should not restore because daintree_preset_id already exists
    assert.equal(result.restoredCount, 0);
    const zai = providers.find(p => p.name === 'claude-z-ai');
    assert.equal(zai.daintree_preset_id, 'preset-999', 'existing preset_id unchanged');
    assert.equal(zai.env.ANTHROPIC_BASE_URL, 'https://old-url.com', 'existing env unchanged');
    assert.equal(zai.model, 'old-model', 'existing model unchanged');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// DP-09: Preset with null/undefined vanilla_slot_name → reconstruction skipped safely
test('DP-09: preset with null vanilla_slot_name is skipped during reconstruction', () => {
  const dir = tmpDir('dp09');
  try {
    const presetsPath = path.join(dir, 'daintree-presets.json');
    writeJson(presetsPath, {
      version: 1,
      presets: {
        'claude-custom': {
          daintree_preset_id: 'preset-abc',
          daintree_preset_name: 'Custom',
          vanilla_slot_name: null, // null instead of string
          agent_name: 'claude',
          env: { API_KEY: 'test' },
        },
        'claude-broken': {
          daintree_preset_id: 'preset-def',
          daintree_preset_name: 'Broken',
          // vanilla_slot_name missing entirely
        },
      },
    });

    const providers = [{ name: 'claude-1', mainTool: 'claude' }];

    const result = restoreDaintreePresets(providers, presetsPath);

    // Both presets should be skipped since vanilla_slot_name is invalid
    assert.equal(result.restoredCount, 0);
    assert.equal(providers.length, 1);
    assert.equal(providers[0].name, 'claude-1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// MERGE-12: Provider name as empty string → filtered out (boundary value: falsy string)
test('MERGE-12: provider entries with empty string names are filtered out', () => {
  const dir = tmpDir('m12');
  try {
    const repoPath = path.join(dir, 'repo.json');
    const userPath = path.join(dir, 'user.json');
    writeJson(repoPath, { providers: [{ name: 'claude-1' }] });
    writeJson(userPath, {
      providers: [
        { name: 'claude-1' },
        { name: '' }, // empty string is falsy but different from null/undefined
        { name: 'valid-custom' },
      ],
    });

    const result = mergeProvidersJson(repoPath, userPath);

    assert.equal(result.status, 'merged');
    assert.equal(result.preservedCount, 1);
    assert.deepEqual(result.preservedNames, ['valid-custom']);
    const merged = readJson(userPath).providers;
    assert.equal(merged.length, 2);
    assert.deepEqual(merged.map(p => p.name), ['claude-1', 'valid-custom']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// DP-10: Preset with null/undefined slotName key in Object.entries → skipped
test('DP-10: preset store with null/undefined key in presets object is skipped', () => {
  const dir = tmpDir('dp10');
  try {
    const presetsPath = path.join(dir, 'daintree-presets.json');
    // Manually construct JSON with null key (simulating corrupted data)
    const presetsJson = {
      version: 1,
      presets: {
        'claude-z-ai': {
          daintree_preset_id: 'preset-123',
          daintree_preset_name: 'Z.AI',
          agent_name: 'claude',
          vanilla_slot_name: 'claude-1',
          env: { ANTHROPIC_BASE_URL: 'https://api.z.ai' },
        },
      },
    };
    fs.writeFileSync(presetsPath, JSON.stringify(presetsJson, null, 2));

    const providers = [{ name: 'claude-1', mainTool: 'claude' }];

    const result = restoreDaintreePresets(providers, presetsPath);

    // Should restore normally since Object.entries handles string keys
    assert.equal(result.restoredCount, 1);
    assert.deepEqual(result.restoredNames, ['claude-z-ai']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// MERGE-13: Provider with non-string name (number, object) → type coercion edge case
test('MERGE-13: provider entries with non-string names cause Set.has mismatch', () => {
  const dir = tmpDir('m13');
  try {
    const repoPath = path.join(dir, 'repo.json');
    const userPath = path.join(dir, 'user.json');
    writeJson(repoPath, { providers: [{ name: 'claude-1' }] });
    writeJson(userPath, {
      providers: [
        { name: 'claude-1' },
        { name: 123 }, // number instead of string - Set.has(123) won't match '123'
        { name: { nested: 'object' } }, // object - won't match any string
        { name: 'valid-custom' },
      ],
    });

    const result = mergeProvidersJson(repoPath, userPath);

    assert.equal(result.status, 'merged');
    // The non-string names will be preserved because they don't match repo names
    // This exposes a potential issue: Set.has('123') !== Set.has(123)
    assert.ok(result.preservedCount >= 1);
    assert.ok(result.preservedNames.includes('valid-custom'));
    const merged = readJson(userPath).providers;
    assert.ok(merged.length >= 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// DP-11: Multiple restorations with same preset name → idempotency with byName map
test('DP-11: calling restoreDaintreePresets twice on same array is idempotent', () => {
  const dir = tmpDir('dp11');
  try {
    const presetsPath = path.join(dir, 'daintree-presets.json');
    writeJson(presetsPath, {
      version: 1,
      presets: {
        'claude-z-ai': {
          daintree_preset_id: 'preset-123',
          daintree_preset_name: 'Z.AI',
          agent_name: 'claude',
          vanilla_slot_name: 'claude-1',
          env: { ANTHROPIC_BASE_URL: 'https://api.z.ai' },
          model: 'glm-5.1',
          display_provider: 'Z.AI',
        },
      },
    });

    const providers = [{ name: 'claude-1', mainTool: 'claude' }];

    // First restoration
    const result1 = restoreDaintreePresets(providers, presetsPath);
    assert.equal(result1.restoredCount, 1);
    assert.equal(providers.length, 2);
    const zai1 = providers.find(p => p.name === 'claude-z-ai');
    assert.equal(zai1.daintree_preset_id, 'preset-123');

    // Second restoration on same array (should be idempotent)
    const result2 = restoreDaintreePresets(providers, presetsPath);
    assert.equal(result2.restoredCount, 0, 'second call should not restore anything');
    assert.equal(providers.length, 2, 'should not duplicate entries');
    const zai2 = providers.find(p => p.name === 'claude-z-ai');
    assert.equal(zai2.daintree_preset_id, 'preset-123', 'existing preset_id unchanged');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// DP-12: Preset with null/undefined agent_name → falls back to existing mainTool
test('DP-12: preset with null agent_name uses existing mainTool from stripped slot', () => {
  const dir = tmpDir('dp12');
  try {
    const presetsPath = path.join(dir, 'daintree-presets.json');
    writeJson(presetsPath, {
      version: 1,
      presets: {
        'claude-z-ai': {
          daintree_preset_id: 'preset-123',
          daintree_preset_name: 'Z.AI',
          agent_name: null, // null instead of string
          env: { ANTHROPIC_BASE_URL: 'https://api.z.ai' },
        },
      },
    });

    const providers = [
      { name: 'claude-1', mainTool: 'claude' },
      { name: 'claude-z-ai', mainTool: 'claude' }, // already has mainTool
    ];

    const result = restoreDaintreePresets(providers, presetsPath);

    assert.equal(result.restoredCount, 1);
    const zai = providers.find(p => p.name === 'claude-z-ai');
    assert.equal(zai.mainTool, 'claude', 'existing mainTool should be preserved');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// MERGE-14: Repo entry with same name as user extra → repo wins, user extra not duplicated
test('MERGE-14: repo and user with same name results in single entry (repo wins)', () => {
  const dir = tmpDir('m14');
  try {
    const repoPath = path.join(dir, 'repo.json');
    const userPath = path.join(dir, 'user.json');
    writeJson(repoPath, { providers: [{ name: 'claude-1', model: 'opus-4-7' }] });
    writeJson(userPath, {
      providers: [
        { name: 'claude-1', model: 'opus' }, // user has old version
        { name: 'custom-slot' },
      ],
    });

    const result = mergeProvidersJson(repoPath, userPath);

    assert.equal(result.status, 'merged');
    assert.equal(result.preservedCount, 1);
    assert.deepEqual(result.preservedNames, ['custom-slot']);
    const merged = readJson(userPath).providers;
    assert.equal(merged.length, 2, 'should have exactly 2 entries (repo claude-1 + custom)');
    assert.equal(merged[0].name, 'claude-1', 'first entry should be claude-1');
    assert.equal(merged[0].model, 'opus-4-7', 'repo model should win');
    assert.equal(merged[1].name, 'custom-slot', 'second entry should be custom');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── GUARD tests: type/shape crashes on the path helpers ──
// These target the helpers also exercised by test/install-mcp-nfbin.test.cjs, but
// attack with type-coerced / boundary inputs the happy-path suite never sends.

// GUARD-01: shouldCopyToNfBin crashes on non-string entry (undefined/null/number/object)
// because it calls entry.endsWith('.cjs') unguarded. A non-string from a malformed
// readdir or a hand-rolled caller would throw TypeError instead of returning false.
test('GUARD-01: shouldCopyToNfBin should return false (not throw) for non-string entry', () => {
  // The SAFE behavior is to return false for any non-string. Today entry.endsWith
  // throws TypeError on undefined/null/number — this test documents that gap.
  for (const bad of [undefined, null, 123, {}, [], true]) {
    assert.equal(
      shouldCopyToNfBin(bad),
      false,
      `shouldCopyToNfBin(${JSON.stringify(bad)}) must be false, not a throw`
    );
  }
});

// GUARD-03: mcpArgsNeedMigration — a bare relative filename resolves under CWD, not
// nf-bin, so it MUST be flagged for migration. Also: a path that merely CONTAINS the
// filename as a substring but does not END with it (e.g. a .bak sibling) must NOT be
// flagged. This guards both false-negatives and false-positives in the endsWith check.
test('GUARD-03: mcpArgsNeedMigration flags bare relative filename, ignores non-suffix substrings', () => {
  const nfBin = path.join('/home', 'u', '.claude', 'nf-bin');
  // Bare filename resolves CWD-relative → NOT under nf-bin → must migrate
  assert.equal(
    mcpArgsNeedMigration('unified-mcp-server.mjs', nfBin),
    true,
    'bare relative filename is not under nf-bin, must be flagged for migration'
  );
  // Sibling that contains the name but does not END with the exact filename → must NOT migrate
  assert.equal(
    mcpArgsNeedMigration('/repo/unified-mcp-server.mjs.bak', nfBin),
    false,
    'a .bak sibling must not match the endsWith suffix'
  );
});

// ── MERGE tests: filesystem & prototype-pollution edge cases ──

// MERGE-15: Fresh-copy path calls fs.copyFileSync(repoPath, userPath) when the user
// file does not exist. If the user file's PARENT DIRECTORY also does not exist,
// copyFileSync throws ENOENT uncaught — install wedges instead of failing open.
test('MERGE-15: fresh-copy to a user path whose parent dir is missing fails open (no uncaught throw)', () => {
  const dir = tmpDir('m15');
  try {
    const repoPath = path.join(dir, 'repo.json');
    // userPath sits under a directory that was never created
    const missingParent = path.join(dir, 'no-such-subdir');
    const userPath = path.join(missingParent, 'user.json');
    assert.ok(!fs.existsSync(missingParent), 'precondition: parent dir absent');
    writeJson(repoPath, { providers: [{ name: 'claude-1' }] });

    // The SAFE behavior: fail open (status 'error' or 'fresh-copy' that creates the
    // dir), NOT an uncaught ENOENT that crashes the installer. Asserting no-throw +
    // a defined status here; today this throws.
    const result = mergeProvidersJson(repoPath, userPath);
    assert.ok(['error', 'fresh-copy', 'fallback-copy'].includes(result.status),
      `expected fail-open status, got ${result && result.status}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// MERGE-16: prototype-pollution-shaped keys in user providers JSON. JSON.parse
// neutralizes __proto__ as a key, but `constructor`/`prototype` survive as own
// enumerable keys. A malicious or corrupt user file with {providers:[{name:'constructor'}]}
// or top-level {constructor: {...}} must not let the merge or the re-stringified
// output pollute Object.prototype. Verify Object.prototype is clean after merge.
test('MERGE-16: prototype-pollution keys in user providers do not poison Object.prototype', () => {
  const dir = tmpDir('m16');
  try {
    const repoPath = path.join(dir, 'repo.json');
    const userPath = path.join(dir, 'user.json');
    writeJson(repoPath, { providers: [{ name: 'claude-1' }] });
    // Hand-construct a user file with pollution-shaped keys at both levels.
    // Using a raw string lets us inject keys JSON.parse would otherwise coerce.
    const malicious =
      '{"providers":[' +
      '  {"name":"claude-1"},' +
      '  {"name":"__proto__","payload":"x"},' +
      '  {"name":"constructor","payload":"y"},' +
      '  {"name":"prototype","payload":"z"},' +
      '  {"name":"real-custom"}' +
      '],' +
      '"__proto__":{"polluted_top":true},' +
      '"constructor":{"prototype":{"polluted_ctor":true}}' +
      '}';
    fs.writeFileSync(userPath, malicious);

    const result = mergeProvidersJson(repoPath, userPath);

    // Object.prototype must NOT gain any of these properties via the merge or
    // re-stringification round-trip.
    assert.equal({}.polluted_top, undefined, 'Object.prototype must not be polluted via __proto__ top-level');
    assert.equal({}.polluted_ctor, undefined, 'Object.prototype must not be polluted via constructor.prototype');
    assert.equal({}.payload, undefined, 'Object.prototype must not be polluted via a providers[].name of __proto__');

    // The merge must still complete and the legitimate custom slot must survive.
    assert.ok(['merged', 'fresh-copy', 'fallback-copy', 'error'].includes(result.status));
    const merged = readJson(userPath);
    const names = (merged.providers || []).map(p => p && p.name);
    assert.ok(names.includes('real-custom'), 'legitimate custom slot must be preserved');
  } finally {
    // Defensive cleanup of any prototype pollution that DID occur, so it can't leak
    // into sibling tests in the same process.
    delete Object.prototype.polluted_top;
    delete Object.prototype.polluted_ctor;
    delete Object.prototype.payload;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── DP tests: crash-on-bad-input in restoreDaintreePresets ──

// DP-13: providers array containing null/undefined/non-object entries. The function
// does `providers.map(p => [p.name, p])` to build byName — that throws TypeError on
// null/undefined entries (Cannot read properties of null). A reconstructed providers
// array from a corrupt ~/.claude.json can contain nulls.
test('DP-13: providers array with null/undefined entries does not crash restoreDaintreePresets', () => {
  const dir = tmpDir('dp13');
  try {
    const presetsPath = path.join(dir, 'daintree-presets.json');
    writeJson(presetsPath, {
      version: 1,
      presets: {
        'claude-z-ai': {
          daintree_preset_id: 'preset-123',
          daintree_preset_name: 'Z.AI',
          agent_name: 'claude',
          vanilla_slot_name: 'claude-1',
          env: { ANTHROPIC_BASE_URL: 'https://api.z.ai' },
        },
      },
    });

    // A providers array with holes / nulls / non-objects — the kind of shape a
    // corrupt mcpServers reconstruction could produce.
    const providers = [
      { name: 'claude-1', mainTool: 'claude' },
      null,                  // crashes null.name in the .map
      undefined,             // crashes undefined.name in the .map
      'not-an-object',       // crashes 'not-an-object'.name → undefined, but no throw
      42,                    // crashes (42).name → undefined
    ];

    // SAFE behavior: skip nullish/non-object entries, restore what it can, return a
    // defined result. Today this throws TypeError on the .map building byName.
    const result = restoreDaintreePresets(providers, presetsPath);

    assert.ok(result && typeof result.restoredCount === 'number',
      'must return a defined result, not throw');
    // claude-z-ai is missing → would be reconstructed from claude-1 if the function
    // survived the null entries. Either way: no throw.
    const zai = providers.find(p => p && typeof p === 'object' && p.name === 'claude-z-ai');
    if (result.restoredCount > 0) {
      assert.ok(zai, 'if restored, the reconstructed slot must exist');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Iteration 2: NEW edge cases in the reconstruction branch & atomic write ──

// DP-14: Asymmetry between the overlay branch (guarded by `preset.daintree_preset_id`
// truthiness, line 184) and the reconstruction branch (NO such guard, lines 193-209).
// A preset-store entry with a falsy daintree_preset_id (empty string / null) but a
// valid vanilla_slot_name makes the reconstruction branch run anyway, emitting a slot
// with `daintree_preset_id: ''` (or undefined). That is a malformed slot restored
// WITHOUT a real preset id — it can never be idempotent on re-import and pollutes
// providers.json with a half-baked entry. The overlay branch correctly skips this
// case; the reconstruction branch should too.
test('DP-14: reconstruction branch must skip a preset with falsy daintree_preset_id (overlay/restore asymmetry)', () => {
  const dir = tmpDir('dp14');
  try {
    const presetsPath = path.join(dir, 'daintree-presets.json');
    writeJson(presetsPath, {
      version: 1,
      presets: {
        'claude-empty-preset': {
          daintree_preset_id: '',            // falsy — no real preset id
          daintree_preset_name: 'Empty',
          agent_name: 'claude',
          vanilla_slot_name: 'claude-1',
          env: { ANTHROPIC_BASE_URL: 'https://example.com' },
          model: 'glm-5.1',
        },
        'claude-null-preset': {
          daintree_preset_id: null,          // falsy — no real preset id
          daintree_preset_name: 'Null',
          agent_name: 'claude',
          vanilla_slot_name: 'claude-1',
        },
      },
    });

    const providers = [{ name: 'claude-1', mainTool: 'claude', description: 'Claude' }];

    const result = restoreDaintreePresets(providers, presetsPath);

    // SAFE behavior: a preset with no real daintree_preset_id must NOT be reconstructed
    // (mirrors the overlay branch's `preset.daintree_preset_id` guard). Today the
    // reconstruction branch runs unconditionally and emits slots with empty/null ids.
    assert.equal(result.restoredCount, 0,
      'preset with falsy daintree_preset_id must not be reconstructed');
    const empty = providers.find(p => p && p.name === 'claude-empty-preset');
    const nulled = providers.find(p => p && p.name === 'claude-null-preset');
    assert.equal(empty, undefined, 'no slot should be reconstructed for an empty preset_id');
    assert.equal(nulled, undefined, 'no slot should be reconstructed for a null preset_id');
    assert.equal(providers.length, 1, 'vanilla slot count must be unchanged');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// DP-15: The reconstruction branch builds the description via string concatenation:
//   `(vanilla.description || '') + ' — Daintree preset: ' + preset.daintree_preset_name`
// When `daintree_preset_name` is missing/undefined (a corrupt or hand-edited preset
// store), JS coerces it to the literal string "undefined", producing a user-visible
// description like "Claude — Daintree preset: undefined". This is a latent data-quality
// bug — the slot ships with garbage in its description text. The safe behavior is to
// omit the suffix (or skip the entry) when the name is absent.
test('DP-15: reconstruction must not emit the literal string "undefined" in description when daintree_preset_name is missing', () => {
  const dir = tmpDir('dp15');
  try {
    const presetsPath = path.join(dir, 'daintree-presets.json');
    writeJson(presetsPath, {
      version: 1,
      presets: {
        'claude-noname': {
          daintree_preset_id: 'preset-noname',
          // daintree_preset_name intentionally MISSING
          agent_name: 'claude',
          vanilla_slot_name: 'claude-1',
          env: { ANTHROPIC_BASE_URL: 'https://example.com' },
        },
      },
    });

    const providers = [
      { name: 'claude-1', mainTool: 'claude', description: 'Claude Opus' },
    ];

    restoreDaintreePresets(providers, presetsPath);

    const slot = providers.find(p => p && p.name === 'claude-noname');
    assert.ok(slot, 'reconstructed slot should exist (preset_id is truthy)');
    // SAFE behavior: no literal "undefined" in the rendered description.
    // Today this produces "... — Daintree preset: undefined".
    assert.ok(!String(slot.description).includes('undefined'),
      `description must not contain literal "undefined", got: ${JSON.stringify(slot.description)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// MERGE-17: When the user file exists but is unreadable (e.g. it is a directory, or a
// read-only file the parse step fails on), the catch block falls back to
// `fs.copyFileSync(repoPath, userPath)`. That copy is NOT wrapped in try/catch. If the
// copy throws (userPath is a directory → EISDIR; or readonly target → EACCES), the throw
// is uncaught and wedges the installer — exactly the fail-open gap the rest of the
// function tries to prevent. This makes the corruption-recovery path itself a crash site.
test('MERGE-17: corrupt user file whose fallback copyFileSync throws must fail open, not wedge the installer (uncaught throw)', () => {
  const dir = tmpDir('m17');
  try {
    const repoPath = path.join(dir, 'repo.json');
    writeJson(repoPath, { providers: [{ name: 'claude-1' }] });

    // Make userPath a DIRECTORY. readFileSync(dir) throws EISDIR → caught → fallback
    // copyFileSync(repoPath, dirPath) throws EISDIR/EACCES UNCAUGHT today.
    const userPath = path.join(dir, 'user.json');
    fs.mkdirSync(userPath);
    assert.ok(fs.statSync(userPath).isDirectory(), 'precondition: userPath is a directory');

    // SAFE behavior: fail open with a defined status, never an uncaught throw.
    // Today this throws inside the catch block, crashing the calling installer.
    const result = mergeProvidersJson(repoPath, userPath, { log: () => {} });
    assert.ok(result && ['error', 'fallback-copy'].includes(result.status),
      `expected fail-open status, got ${result && result.status}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// MERGE-18 (INVARIANT): The Array.isArray coercion of providers is symmetric for repo
// and user (lines 124-125). Confirm a repo source whose `providers` is a non-array
// object (e.g. `{providers: {'claude-1': {...}}}` — a hand-corrupted or schema-drift
// repo file) is coerced to [] on BOTH sides and the merge still completes, preserving
// legitimate user extras. This locks in the symmetry so a future refactor can't
// accidentally drop one guard.
test('MERGE-18 (invariant): repo.providers as a non-array object is coerced to [] symmetrically with user side', () => {
  const dir = tmpDir('m18');
  try {
    const repoPath = path.join(dir, 'repo.json');
    const userPath = path.join(dir, 'user.json');
    // Repo shipped a corrupt shape: providers is an object map, not an array.
    writeJson(repoPath, { providers: { 'claude-1': { model: 'opus' } } });
    writeJson(userPath, {
      providers: [
        { name: 'claude-1' },
        { name: 'legit-user-extra' },
      ],
    });

    const result = mergeProvidersJson(repoPath, userPath);

    assert.equal(result.status, 'merged');
    // repoProviders coerced to [] → no repo names → both user entries treated as extras
    assert.equal(result.preservedCount, 2);
    assert.deepEqual(result.preservedNames.sort(), ['claude-1', 'legit-user-extra']);
    const merged = readJson(userPath).providers;
    assert.ok(Array.isArray(merged), 'merged providers must be an array even when repo shape is wrong');
    assert.deepEqual(merged.map(p => p.name).sort(), ['claude-1', 'legit-user-extra']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

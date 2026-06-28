#!/usr/bin/env node
'use strict';
// bin/routing-policy.test.cjs
// Tests for routing-policy.cjs — Tier 0/1 policy interface, reward recorder, bandit
// Pattern: routing-policy\.cjs|PresetPolicy|RiverPolicy|RewardRecorder|selectSlotWithPolicy

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// ── Load module ─────────────────────────────────────────────────────────────
let mod;
try {
  mod = require(path.resolve(__dirname, './routing-policy.cjs'));
} catch (e) {
  mod = null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function tmpPath(name) {
  return path.join(os.tmpdir(), `nf-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

function cleanUp(...paths) {
  for (const p of paths) {
    try { fs.unlinkSync(p); } catch (_) { /* ignore */ }
  }
}

const PROVIDERS = [
  { name: 'claude-1', type: 'http', has_file_access: false },
  { name: 'codex-1', type: 'subprocess', has_file_access: true },
  { name: 'gemini-1', type: 'subprocess', has_file_access: true },
];

const NO_MATCH_PROVIDERS = [
  { name: 'claude-1', type: 'http', has_file_access: false },
  { name: 'claude-2', type: 'http', has_file_access: false },
];

// ── STRUCTURAL TESTS ────────────────────────────────────────────────────────

test('module exists: bin/routing-policy.cjs can be required without error', () => {
  assert.ok(mod, 'bin/routing-policy.cjs not found');
});

test('exports: PresetPolicy is exported as a function', () => {
  assert.ok(mod);
  assert.strictEqual(typeof mod.PresetPolicy, 'function');
});

test('exports: RiverPolicy is exported as a function', () => {
  assert.ok(mod);
  assert.strictEqual(typeof mod.RiverPolicy, 'function');
});

test('exports: RewardRecorder is exported as a function', () => {
  assert.ok(mod);
  assert.strictEqual(typeof mod.RewardRecorder, 'function');
});

test('exports: selectSlotWithPolicy is exported as a function', () => {
  assert.ok(mod);
  assert.strictEqual(typeof mod.selectSlotWithPolicy, 'function');
});

// ── PresetPolicy TESTS ──────────────────────────────────────────────────────

test('PresetPolicy.recommend returns first subprocess+file_access provider', () => {
  assert.ok(mod);
  const policy = new mod.PresetPolicy();
  const result = policy.recommend('implement', PROVIDERS);

  assert.strictEqual(result.recommendation, 'codex-1');
  assert.strictEqual(result.confidence, 1.0);
  assert.strictEqual(result.evidenceCount, 0);
  assert.strictEqual(result.recentStability, 1.0);
  assert.strictEqual(result.reason, 'preset:first-eligible-subprocess');
});

test('PresetPolicy.recommend returns null recommendation for no-match providers', () => {
  assert.ok(mod);
  const policy = new mod.PresetPolicy();
  const result = policy.recommend('implement', NO_MATCH_PROVIDERS);

  assert.strictEqual(result.recommendation, null);
  assert.strictEqual(result.reason, 'preset:no-eligible-subprocess');
});

test('PresetPolicy.recommend returns null recommendation for empty providers', () => {
  assert.ok(mod);
  const policy = new mod.PresetPolicy();
  const result = policy.recommend('fix', []);

  assert.strictEqual(result.recommendation, null);
});

test('PresetPolicy.recommend returns null recommendation for non-array input', () => {
  assert.ok(mod);
  const policy = new mod.PresetPolicy();
  const result = policy.recommend('fix', null);

  assert.strictEqual(result.recommendation, null);
  assert.strictEqual(result.reason, 'preset:no-providers');
});

// ── PresetPolicy routingHint TESTS ─────────────────────────────────────────

test('PresetPolicy.recommend prefers routingHint string when eligible', () => {
  assert.ok(mod);
  const policy = new mod.PresetPolicy();
  const result = policy.recommend('implement', PROVIDERS, 'gemini-1');

  assert.strictEqual(result.recommendation, 'gemini-1');
  assert.strictEqual(result.confidence, 1.0);
  assert.strictEqual(result.reason, 'preset:routing-hint-match');
});

test('PresetPolicy.recommend prefers routingHint object with executor field', () => {
  assert.ok(mod);
  const policy = new mod.PresetPolicy();
  const result = policy.recommend('implement', PROVIDERS, { executor: 'gemini-1', reason: 'test' });

  assert.strictEqual(result.recommendation, 'gemini-1');
  assert.strictEqual(result.confidence, 1.0);
  assert.strictEqual(result.reason, 'preset:routing-hint-match');
});

test('PresetPolicy.recommend falls back when routingHint is ineligible', () => {
  assert.ok(mod);
  const policy = new mod.PresetPolicy();
  // claude-1 is type=http, not subprocess — should fall back
  const result = policy.recommend('implement', PROVIDERS, 'claude-1');

  assert.strictEqual(result.recommendation, 'codex-1');
  assert.strictEqual(result.reason, 'preset:first-eligible-subprocess');
});

test('PresetPolicy.recommend falls back when routingHint names unknown slot', () => {
  assert.ok(mod);
  const policy = new mod.PresetPolicy();
  const result = policy.recommend('implement', PROVIDERS, 'nonexistent-slot');

  assert.strictEqual(result.recommendation, 'codex-1');
  assert.strictEqual(result.reason, 'preset:first-eligible-subprocess');
});

test('selectSlotWithPolicy passes routingHint to preset', () => {
  assert.ok(mod);
  const result = mod.selectSlotWithPolicy('implement', PROVIDERS, {
    routingHint: 'gemini-1',
    policies: [new mod.PresetPolicy()],
  });

  assert.strictEqual(result.slot, 'gemini-1');
  assert.strictEqual(result.tier, 0);
  assert.strictEqual(result.policyResult.reason, 'preset:routing-hint-match');
});

// ── RewardRecorder TESTS ────────────────────────────────────────────────────

test('RewardRecorder.record writes valid JSONL line', () => {
  assert.ok(mod);
  const rewardsPath = tmpPath('rewards.jsonl');
  try {
    const recorder = new mod.RewardRecorder({ rewardsPath });
    recorder.record({ taskType: 'implement', slot: 'codex-1', reward: 0.85, latencyMs: 1200 });

    const content = fs.readFileSync(rewardsPath, 'utf8').trim();
    const entry = JSON.parse(content);
    assert.strictEqual(entry.taskType, 'implement');
    assert.strictEqual(entry.slot, 'codex-1');
    assert.strictEqual(entry.reward, 0.85);
    assert.strictEqual(entry.latencyMs, 1200);
    assert.ok(entry.timestamp, 'should have timestamp');
  } finally {
    cleanUp(rewardsPath);
  }
});

test('RewardRecorder.readRewards filters by taskType', () => {
  assert.ok(mod);
  const rewardsPath = tmpPath('rewards-filter.jsonl');
  try {
    const recorder = new mod.RewardRecorder({ rewardsPath });
    recorder.record({ taskType: 'implement', slot: 'codex-1', reward: 0.9 });
    recorder.record({ taskType: 'fix', slot: 'gemini-1', reward: 0.7 });
    recorder.record({ taskType: 'implement', slot: 'codex-1', reward: 0.8 });

    const implRewards = recorder.readRewards('implement');
    assert.strictEqual(implRewards.length, 2);
    assert.ok(implRewards.every(r => r.taskType === 'implement'));

    const fixRewards = recorder.readRewards('fix');
    assert.strictEqual(fixRewards.length, 1);
    assert.strictEqual(fixRewards[0].slot, 'gemini-1');
  } finally {
    cleanUp(rewardsPath);
  }
});

test('RewardRecorder handles missing file gracefully (returns [])', () => {
  assert.ok(mod);
  const rewardsPath = tmpPath('nonexistent.jsonl');
  const recorder = new mod.RewardRecorder({ rewardsPath });
  const rewards = recorder.readRewards('implement');

  assert.deepStrictEqual(rewards, []);
});

// ── RiverPolicy TESTS ───────────────────────────────────────────────────────

test('RiverPolicy.recommend returns null when insufficient samples', () => {
  assert.ok(mod);
  const rewardsPath = tmpPath('river-insufficient.jsonl');
  const statePath = tmpPath('river-insufficient-state.json');
  try {
    // Write only 3 rewards per arm (below minSamples of 10)
    const recorder = new mod.RewardRecorder({ rewardsPath });
    for (let i = 0; i < 3; i++) {
      recorder.record({ taskType: 'implement', slot: 'codex-1', reward: 0.9 });
      recorder.record({ taskType: 'implement', slot: 'gemini-1', reward: 0.5 });
    }

    const policy = new mod.RiverPolicy({ rewardsPath, statePath, config: { minSamples: 10, minExplore: 1, epsilon: 0 } });
    const result = policy.recommend('implement', PROVIDERS);

    assert.strictEqual(result.recommendation, null);
    assert.ok(result.reason.includes('insufficient-samples'), `reason: ${result.reason}`);
  } finally {
    cleanUp(rewardsPath, statePath);
  }
});

test('RiverPolicy.recommend returns best arm when confidence gate passes', () => {
  assert.ok(mod);
  const rewardsPath = tmpPath('river-passes.jsonl');
  const statePath = tmpPath('river-passes-state.json');
  try {
    const recorder = new mod.RewardRecorder({ rewardsPath });

    // Write 25 high rewards for gemini-1 and 25 low for codex-1
    for (let i = 0; i < 25; i++) {
      recorder.record({ taskType: 'implement', slot: 'gemini-1', reward: 0.95 });
      recorder.record({ taskType: 'implement', slot: 'codex-1', reward: 0.5 });
    }

    const policy = new mod.RiverPolicy({
      rewardsPath,
      statePath,
      config: { minSamples: 10, minExplore: 1, epsilon: 0, rewardMargin: 0.15, stabilityWindow: 5, cooldownMs: 0 },
    });
    const result = policy.recommend('implement', PROVIDERS);

    assert.strictEqual(result.recommendation, 'gemini-1');
    assert.ok(result.confidence > 0, 'should have positive confidence');
    assert.strictEqual(result.reason, 'river:confidence-gate-passed');
  } finally {
    cleanUp(rewardsPath, statePath);
  }
});

test('RiverPolicy incumbent bias: does not override when margin insufficient', () => {
  assert.ok(mod);
  const rewardsPath = tmpPath('river-incumbent.jsonl');
  const statePath = tmpPath('river-incumbent-state.json');
  try {
    const recorder = new mod.RewardRecorder({ rewardsPath });

    // gemini-1 slightly better than codex-1 but within margin
    for (let i = 0; i < 25; i++) {
      recorder.record({ taskType: 'implement', slot: 'gemini-1', reward: 0.82 });
      recorder.record({ taskType: 'implement', slot: 'codex-1', reward: 0.78 });
    }

    const policy = new mod.RiverPolicy({
      rewardsPath,
      statePath,
      config: { minSamples: 10, minExplore: 1, epsilon: 0, rewardMargin: 0.15, stabilityWindow: 5, cooldownMs: 0 },
    });
    const result = policy.recommend('implement', PROVIDERS);

    // codex-1 is the preset winner (first eligible), gemini-1 margin is only 0.04 < 0.15
    assert.strictEqual(result.recommendation, null);
    assert.ok(result.reason.includes('incumbent-bias') || result.reason.includes('margin-insufficient'),
      `expected incumbent bias, got: ${result.reason}`);
  } finally {
    cleanUp(rewardsPath, statePath);
  }
});

// ── selectSlotWithPolicy TESTS ──────────────────────────────────────────────

test('selectSlotWithPolicy returns preset result by default (no reward data)', () => {
  assert.ok(mod);
  const rewardsPath = tmpPath('swp-default.jsonl');
  const statePath = tmpPath('swp-default-state.json');
  try {
    const result = mod.selectSlotWithPolicy('implement', PROVIDERS, {
      policies: [
        new mod.PresetPolicy(),
        new mod.RiverPolicy({ rewardsPath, statePath }),
      ],
    });

    assert.strictEqual(result.slot, 'codex-1');
    assert.strictEqual(result.tier, 0);
    assert.strictEqual(result.policyResult.reason, 'preset:first-eligible-subprocess');
    assert.strictEqual(result.shadow, null);
  } finally {
    cleanUp(rewardsPath, statePath);
  }
});

test('selectSlotWithPolicy shadow mode logs but does not override', () => {
  assert.ok(mod);
  const rewardsPath = tmpPath('swp-shadow.jsonl');
  const statePath = tmpPath('swp-shadow-state.json');
  try {
    const recorder = new mod.RewardRecorder({ rewardsPath });
    for (let i = 0; i < 25; i++) {
      recorder.record({ taskType: 'implement', slot: 'gemini-1', reward: 0.95 });
      recorder.record({ taskType: 'implement', slot: 'codex-1', reward: 0.5 });
    }

    const result = mod.selectSlotWithPolicy('implement', PROVIDERS, {
      shadowMode: true,
      policies: [
        new mod.PresetPolicy(),
        new mod.RiverPolicy({
          rewardsPath,
          statePath,
          config: { minSamples: 10, minExplore: 1, epsilon: 0, rewardMargin: 0.15, stabilityWindow: 5, cooldownMs: 0 },
        }),
      ],
    });

    // Preset wins in shadow mode
    assert.strictEqual(result.slot, 'codex-1');
    assert.strictEqual(result.tier, 0);
    // Shadow should contain the River recommendation
    assert.ok(result.shadow, 'shadow result should exist');
    assert.strictEqual(result.shadow.recommendation, 'gemini-1');
  } finally {
    cleanUp(rewardsPath, statePath);
  }
});

// ── RiverPolicy Q-learning TESTS ───────────────────────────────────────────

test('RiverPolicy Q-learning: Q-values update incrementally after new rewards', () => {
  assert.ok(mod);
  const rewardsPath = tmpPath('q-incremental.jsonl');
  const statePath = tmpPath('q-incremental-state.json');
  try {
    const recorder = new mod.RewardRecorder({ rewardsPath });

    // Record 5 high rewards for gemini-1 and 5 low for codex-1
    for (let i = 0; i < 5; i++) {
      recorder.record({ taskType: 'implement', slot: 'gemini-1', reward: 0.9 });
      recorder.record({ taskType: 'implement', slot: 'codex-1', reward: 0.3 });
    }

    const policy = new mod.RiverPolicy({
      rewardsPath,
      statePath,
      config: { minSamples: 1, minExplore: 1, epsilon: 0, learningRate: 0.1, decayRate: 0.01, rewardMargin: 0.01, cooldownMs: 0 },
    });
    // Call recommend() which triggers _updateQValues
    policy.recommend('implement', PROVIDERS);

    // Verify Q-table: Q(gemini-1) > Q(codex-1)
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(state.qTable, 'state should have qTable');
    assert.ok(state.qTable.implement, 'qTable should have implement taskType');
    assert.ok(state.qTable.implement['gemini-1'].q > state.qTable.implement['codex-1'].q,
      `Q(gemini-1)=${state.qTable.implement['gemini-1'].q} should be > Q(codex-1)=${state.qTable.implement['codex-1'].q}`);
    assert.strictEqual(state.qTable.implement['gemini-1'].visits, 5);
    assert.strictEqual(state.qTable.implement['codex-1'].visits, 5);
  } finally {
    cleanUp(rewardsPath, statePath);
  }
});

test('RiverPolicy Q-learning: learning rate decays with visits', () => {
  assert.ok(mod);
  const rewardsPath = tmpPath('q-decay.jsonl');
  const statePath = tmpPath('q-decay-state.json');
  try {
    const recorder = new mod.RewardRecorder({ rewardsPath });

    // Record 30 rewards for a single slot, all the same value
    // Track Q-value delta: early updates should move Q more than later ones
    const policy = new mod.RiverPolicy({
      rewardsPath,
      statePath,
      config: { minSamples: 1, minExplore: 1, epsilon: 0, learningRate: 0.5, decayRate: 0.05, rewardMargin: 0.01, cooldownMs: 0 },
    });

    // Record 10 rewards with value 1.0
    for (let i = 0; i < 10; i++) {
      recorder.record({ taskType: 'test', slot: 'codex-1', reward: 1.0 });
    }
    policy.recommend('test', PROVIDERS);
    const state1 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const q1 = state1.qTable.test['codex-1'].q;

    // Record 20 more rewards with value 0.0 (should move Q down, but slower)
    for (let i = 0; i < 20; i++) {
      recorder.record({ taskType: 'test', slot: 'codex-1', reward: 0.0 });
    }
    policy.recommend('test', PROVIDERS);
    const state2 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const q2 = state2.qTable.test['codex-1'].q;

    // Q should have moved toward 0 but not fully (decay slows learning)
    assert.ok(q1 > q2, `Q after good rewards (${q1}) should be > Q after bad rewards (${q2})`);
    assert.ok(q2 > 0, `Q should not reach 0 due to learning rate decay (got ${q2})`);
    assert.strictEqual(state2.qTable.test['codex-1'].visits, 30);
  } finally {
    cleanUp(rewardsPath, statePath);
  }
});

test('RiverPolicy Q-learning: epsilon exploration defers to preset', () => {
  assert.ok(mod);
  const rewardsPath = tmpPath('q-epsilon.jsonl');
  const statePath = tmpPath('q-epsilon-state.json');
  try {
    const recorder = new mod.RewardRecorder({ rewardsPath });

    // Record enough rewards to pass minExplore
    for (let i = 0; i < 25; i++) {
      recorder.record({ taskType: 'implement', slot: 'codex-1', reward: 0.9 });
      recorder.record({ taskType: 'implement', slot: 'gemini-1', reward: 0.5 });
    }

    // epsilon=1.0 means always explore
    const policy = new mod.RiverPolicy({
      rewardsPath,
      statePath,
      config: { minSamples: 1, minExplore: 1, epsilon: 1.0, learningRate: 0.1, decayRate: 0.01, rewardMargin: 0.01, cooldownMs: 0 },
    });
    const result = policy.recommend('implement', PROVIDERS);

    assert.strictEqual(result.recommendation, null, 'epsilon=1.0 should always defer (null recommendation)');
    assert.strictEqual(result.reason, 'river:exploring');
  } finally {
    cleanUp(rewardsPath, statePath);
  }
});

test('RiverPolicy Q-learning: minExplore forces exploration for unvisited arms', () => {
  assert.ok(mod);
  const rewardsPath = tmpPath('q-minexplore.jsonl');
  const statePath = tmpPath('q-minexplore-state.json');
  try {
    const recorder = new mod.RewardRecorder({ rewardsPath });

    // Record rewards for codex-1 only — gemini-1 has zero visits
    for (let i = 0; i < 30; i++) {
      recorder.record({ taskType: 'implement', slot: 'codex-1', reward: 0.9 });
    }

    const policy = new mod.RiverPolicy({
      rewardsPath,
      statePath,
      config: { minSamples: 1, minExplore: 20, epsilon: 0, learningRate: 0.1, decayRate: 0.01, rewardMargin: 0.01, cooldownMs: 0 },
    });
    const result = policy.recommend('implement', PROVIDERS);

    assert.strictEqual(result.recommendation, null, 'should return null when unvisited arm exists');
    assert.strictEqual(result.reason, 'river:exploring', 'reason should be river:exploring');
  } finally {
    cleanUp(rewardsPath, statePath);
  }
});

test('RiverPolicy Q-learning: backward compat with old state format', () => {
  assert.ok(mod);
  const rewardsPath = tmpPath('q-backcompat.jsonl');
  const statePath = tmpPath('q-backcompat-state.json');
  try {
    // Write old-format state file (no qTable)
    fs.writeFileSync(statePath, JSON.stringify({ promotions: { implement: 0 } }), 'utf8');

    const recorder = new mod.RewardRecorder({ rewardsPath });
    for (let i = 0; i < 5; i++) {
      recorder.record({ taskType: 'implement', slot: 'codex-1', reward: 0.9 });
    }

    const policy = new mod.RiverPolicy({
      rewardsPath,
      statePath,
      config: { minSamples: 1, minExplore: 1, epsilon: 0, learningRate: 0.1, decayRate: 0.01, rewardMargin: 0.01, cooldownMs: 0 },
    });

    // Should not throw, and should work by initializing qTable
    let result;
    assert.doesNotThrow(() => {
      result = policy.recommend('implement', PROVIDERS);
    }, 'should not throw with old state format');

    // Verify qTable was created
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(state.qTable, 'qTable should be created on first load');
    assert.ok(state.qTable.implement, 'qTable.implement should exist');
    // Old promotions should still be preserved
    assert.ok(state.promotions, 'old promotions should be preserved');
  } finally {
    cleanUp(rewardsPath, statePath);
  }
});

test('RiverPolicy Q-learning: lastProcessedIdx prevents re-processing rewards', () => {
  assert.ok(mod);
  const rewardsPath = tmpPath('q-lastidx.jsonl');
  const statePath = tmpPath('q-lastidx-state.json');
  try {
    const recorder = new mod.RewardRecorder({ rewardsPath });

    // Record initial batch of rewards
    for (let i = 0; i < 5; i++) {
      recorder.record({ taskType: 'implement', slot: 'codex-1', reward: 1.0 });
    }

    const policy = new mod.RiverPolicy({
      rewardsPath,
      statePath,
      config: { minSamples: 1, minExplore: 1, epsilon: 0, learningRate: 0.5, decayRate: 0, rewardMargin: 0.01, cooldownMs: 0 },
    });

    policy.recommend('implement', PROVIDERS);
    const state1 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const q1 = state1.qTable.implement['codex-1'].q;
    const idx1 = state1.lastProcessedIdx.implement;
    assert.strictEqual(idx1, 5, 'lastProcessedIdx should be 5 after first batch');

    // Call recommend again without new rewards — Q should not change
    policy.recommend('implement', PROVIDERS);
    const state2 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const q2 = state2.qTable.implement['codex-1'].q;
    assert.strictEqual(q2, q1, 'Q-value should not change without new rewards');

    // Record new rewards with different value
    for (let i = 0; i < 5; i++) {
      recorder.record({ taskType: 'implement', slot: 'codex-1', reward: 0.0 });
    }

    policy.recommend('implement', PROVIDERS);
    const state3 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const q3 = state3.qTable.implement['codex-1'].q;
    const idx3 = state3.lastProcessedIdx.implement;
    assert.strictEqual(idx3, 10, 'lastProcessedIdx should be 10 after second batch');
    assert.ok(q3 < q1, `Q after bad rewards (${q3}) should be less than Q after good rewards (${q1})`);
  } finally {
    cleanUp(rewardsPath, statePath);
  }
});

// ── selectSlotWithPolicy TESTS (continued) ─────────────────────────────────

test('selectSlotWithPolicy with shadowMode:false promotes River when gate passes', () => {
  assert.ok(mod);
  const rewardsPath = tmpPath('swp-promote.jsonl');
  const statePath = tmpPath('swp-promote-state.json');
  try {
    const recorder = new mod.RewardRecorder({ rewardsPath });
    for (let i = 0; i < 25; i++) {
      recorder.record({ taskType: 'implement', slot: 'gemini-1', reward: 0.95 });
      recorder.record({ taskType: 'implement', slot: 'codex-1', reward: 0.5 });
    }

    const result = mod.selectSlotWithPolicy('implement', PROVIDERS, {
      shadowMode: false,
      policies: [
        new mod.PresetPolicy(),
        new mod.RiverPolicy({
          rewardsPath,
          statePath,
          config: { minSamples: 10, minExplore: 1, epsilon: 0, rewardMargin: 0.15, stabilityWindow: 5, cooldownMs: 0 },
        }),
      ],
    });

    // River promoted
    assert.strictEqual(result.slot, 'gemini-1');
    assert.strictEqual(result.tier, 1);
    assert.strictEqual(result.shadow, null);
  } finally {
    cleanUp(rewardsPath, statePath);
  }
});

// ── E2E Learning Loop Tests ────────────────────────────────────────────────

test('E2E learning loop: rewards -> Q-table update -> routing preference shift -> shadow recommendation', () => {
  assert.ok(mod);
  const rewardsPath = tmpPath('e2e-loop.jsonl');
  const statePath = tmpPath('e2e-loop-state.json');
  try {
    // Step 1-2: Record 25 high rewards for gemini-1 and 25 low rewards for codex-1
    const recorder = new mod.RewardRecorder({ rewardsPath });
    for (let i = 0; i < 25; i++) {
      recorder.record({ taskType: 'implement', slot: 'gemini-1', reward: 0.95 });
      recorder.record({ taskType: 'implement', slot: 'codex-1', reward: 0.4 });
    }

    // Step 3: Create RiverPolicy with test config
    const riverPolicy = new mod.RiverPolicy({
      rewardsPath,
      statePath,
      config: { minSamples: 10, minExplore: 1, epsilon: 0, rewardMargin: 0.15, stabilityWindow: 5, cooldownMs: 0, shadowMode: true },
    });

    // Step 4: Call selectSlotWithPolicy in shadow mode
    const result = mod.selectSlotWithPolicy('implement', PROVIDERS, {
      shadowMode: true,
      policies: [new mod.PresetPolicy(), riverPolicy],
    });

    // Step 5: Assert shadow mode behavior
    assert.strictEqual(result.slot, 'codex-1', 'preset wins in shadow mode');
    assert.strictEqual(result.tier, 0, 'tier should be 0 (preset)');
    assert.ok(result.shadow !== null, 'shadow result should exist');
    assert.strictEqual(result.shadow.recommendation, 'gemini-1', 'River prefers gemini-1 due to higher rewards');
    assert.ok(result.shadow.confidence > 0, 'shadow confidence should be positive');

    // Step 6: Read state file and verify Q-table and lastShadow
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(state.qTable.implement['gemini-1'].q > state.qTable.implement['codex-1'].q,
      `Q(gemini-1)=${state.qTable.implement['gemini-1'].q} should be > Q(codex-1)=${state.qTable.implement['codex-1'].q}`);
    assert.strictEqual(state.qTable.implement['gemini-1'].visits, 25);
    assert.ok(state.lastShadow, 'state should contain lastShadow');
    assert.strictEqual(state.lastShadow.recommendation, 'gemini-1');
    assert.ok(state.lastShadow.confidence > 0, 'lastShadow confidence should be positive');

    // Step 7: Record 30 MORE rewards with reversed quality
    for (let i = 0; i < 30; i++) {
      recorder.record({ taskType: 'implement', slot: 'codex-1', reward: 1.0 });
      recorder.record({ taskType: 'implement', slot: 'gemini-1', reward: 0.1 });
    }

    // Step 8: Call selectSlotWithPolicy again with fresh RiverPolicy
    const riverPolicy2 = new mod.RiverPolicy({
      rewardsPath,
      statePath,
      config: { minSamples: 10, minExplore: 1, epsilon: 0, rewardMargin: 0.15, stabilityWindow: 5, cooldownMs: 0, shadowMode: true },
    });
    const result2 = mod.selectSlotWithPolicy('implement', PROVIDERS, {
      shadowMode: true,
      policies: [new mod.PresetPolicy(), riverPolicy2],
    });

    // Step 9: Verify preference shifted
    const state2 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(state2.qTable.implement['codex-1'].q > state2.qTable.implement['gemini-1'].q,
      `After shift: Q(codex-1)=${state2.qTable.implement['codex-1'].q} should be > Q(gemini-1)=${state2.qTable.implement['gemini-1'].q}`);

    // codex-1 is both the preset winner AND the River recommendation now.
    // River recommends codex-1, but codex-1 is already the preset winner (first eligible subprocess).
    // Due to incumbent bias, when River's best (codex-1) IS the incumbent, the margin check
    // against itself is 0 which is < rewardMargin, so River returns null recommendation.
    // This means shadow will be null (no shadow needed when River agrees with preset).
    // Either shadow is null OR shadow.recommendation is codex-1 — both are valid.
    if (result2.shadow) {
      assert.strictEqual(result2.shadow.recommendation, 'codex-1',
        'If shadow exists, River should now prefer codex-1');
    }
    // result2.slot is always codex-1 (preset winner)
    assert.strictEqual(result2.slot, 'codex-1', 'preset still wins in shadow mode');
  } finally {
    cleanUp(rewardsPath, statePath);
  }
});

test('selectSlotWithPolicy clears lastShadow when River has no recommendation', () => {
  assert.ok(mod);
  const rewardsPath = tmpPath('clear-shadow.jsonl');
  const statePath = tmpPath('clear-shadow-state.json');
  try {
    // Step 1-2: Write state file with stale lastShadow, no rewards
    fs.writeFileSync(statePath, JSON.stringify({
      qTable: {},
      lastShadow: {
        recommendation: 'gemini-1',
        confidence: 0.9,
        taskType: 'implement',
        timestamp: new Date().toISOString(),
      },
    }, null, 2) + '\n', 'utf8');

    // Step 3: Call selectSlotWithPolicy with RiverPolicy that has no reward data
    const riverPolicy = new mod.RiverPolicy({
      rewardsPath,
      statePath,
      config: { minSamples: 10, minExplore: 1, epsilon: 0 },
    });
    mod.selectSlotWithPolicy('implement', PROVIDERS, {
      shadowMode: true,
      policies: [new mod.PresetPolicy(), riverPolicy],
    });

    // Step 4: Read state file and assert lastShadow is cleared
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(state.lastShadow, undefined, 'stale lastShadow should be cleared');
  } finally {
    cleanUp(rewardsPath, statePath);
  }
});

// ── Adversarial hardening TESTS ─────────────────────────────────────────────

test('RiverPolicy._updateQValues does not pollute Object.prototype via slot="__proto__"', () => {
  assert.ok(mod);
  const rewardsPath = tmpPath('q-proto.jsonl');
  const statePath = tmpPath('q-proto-state.json');
  try {
    const recorder = new mod.RewardRecorder({ rewardsPath });
    recorder.record({ taskType: 'implement', slot: '__proto__', reward: 0.9 });
    recorder.record({ taskType: 'implement', slot: 'codex-1', reward: 0.9 });

    const policy = new mod.RiverPolicy({
      rewardsPath,
      statePath,
      config: { minSamples: 1, minExplore: 1, epsilon: 0, learningRate: 0.1, decayRate: 0.01, rewardMargin: 0.01, cooldownMs: 0 },
    });
    policy.recommend('implement', PROVIDERS);

    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(Object.prototype, 'q'),
      false,
      'Object.prototype.q should not be polluted'
    );
    assert.strictEqual(({}).q, undefined, 'plain object should not inherit a polluted q');
  } finally {
    delete Object.prototype.q;
    delete Object.prototype.visits;
    delete Object.prototype.lastUpdate;
    cleanUp(rewardsPath, statePath);
  }
});

test('PresetPolicy.recommend does not throw on a null provider entry', () => {
  assert.ok(mod);
  const policy = new mod.PresetPolicy();
  const providers = [null, { name: 'codex-1', type: 'subprocess', has_file_access: true }];
  let result;
  assert.doesNotThrow(() => { result = policy.recommend('implement', providers); }, 'should not throw on null entry');
  assert.strictEqual(result.recommendation, 'codex-1');
  assert.strictEqual(result.reason, 'preset:first-eligible-subprocess');
});

test('PresetPolicy.recommend does not throw on a name-less provider when routingHint is given', () => {
  assert.ok(mod);
  const policy = new mod.PresetPolicy();
  const providers = [
    { type: 'subprocess', has_file_access: true }, // no name
    { name: 'gemini-1', type: 'subprocess', has_file_access: true },
  ];
  let result;
  assert.doesNotThrow(() => { result = policy.recommend('implement', providers, 'gemini-1'); }, 'should not throw on name-less entry');
  assert.strictEqual(result.recommendation, 'gemini-1');
  assert.strictEqual(result.reason, 'preset:routing-hint-match');
});

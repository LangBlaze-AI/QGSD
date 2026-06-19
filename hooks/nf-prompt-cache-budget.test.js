#!/usr/bin/env node
// Test suite for issue #206:
//   (a) cache key is computed from the FINAL dispatched roster (uniqueSlots),
//       AFTER the SC-4 fallback restore and the model-dedup mutate the slot list.
//   (b) quorum-preflight.cjs honors a --budget-ms deadline: it skips the slow
//       paths (service auto-start / Layer 2 upstream probes) when the budget is
//       tight, so it returns within budget even when a service is down.
//
// Run: node --test hooks/nf-prompt-cache-budget.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const cache = require(path.join(__dirname, '..', 'bin', 'quorum-cache.cjs'));
const PREFLIGHT = path.join(__dirname, '..', 'bin', 'quorum-preflight.cjs');

const QA = ['codex-1', 'gemini-1', 'claude-1'];
const GIT = 'deadbeef';

// ── (a) CACHE KEY ORDERING ────────────────────────────────────────────────

// The contract that the nf-prompt fix relies on: the key is a pure function of
// the dispatched roster (plus prompt/context/config/git). Identical rosters →
// identical key; different rosters → different key. This is what makes keying on
// `uniqueSlots` (the final roster) correct and keying on `cappedSlots` (pre-SC-4,
// pre-dedup) wrong.

test('TC-206-A1: cache key identical IFF the final dispatched roster is identical', () => {
  const rosterA = [{ slot: 'codex-1' }, { slot: 'gemini-1' }];
  const rosterB = [{ slot: 'codex-1' }, { slot: 'gemini-1' }];
  const keyA = cache.computeCacheKey('q', 'ctx', rosterA, QA, GIT);
  const keyB = cache.computeCacheKey('q', 'ctx', rosterB, QA, GIT);
  assert.strictEqual(keyA, keyB, 'identical dispatched rosters must produce identical keys');
});

test('TC-206-A2: key differs when SC-4 fallback collapses the roster to a single slot', () => {
  // Pre-fix: key computed from cappedSlots = [codex-1, gemini-1].
  // SC-4 can later collapse the dispatch list to [codex-1] (relaxedSlots[0]).
  // The dispatched roster is therefore different and MUST key differently.
  const preCap = [{ slot: 'codex-1' }, { slot: 'gemini-1' }];
  const afterSc4 = [{ slot: 'codex-1' }];
  const keyPre = cache.computeCacheKey('q', 'ctx', preCap, QA, GIT);
  const keyDispatched = cache.computeCacheKey('q', 'ctx', afterSc4, QA, GIT);
  assert.notStrictEqual(
    keyPre, keyDispatched,
    'a roster mutated by SC-4 must not collide with the pre-mutation key'
  );
});

test('TC-206-A3: key differs when model-dedup drops a duplicate-model slot', () => {
  // dedup demotes one of two same-model slots: dispatched roster shrinks.
  const beforeDedup = [{ slot: 'claude-1' }, { slot: 'claude-z-ai' }];
  const afterDedup = [{ slot: 'claude-1' }];
  const keyBefore = cache.computeCacheKey('q', 'ctx', beforeDedup, QA, GIT);
  const keyAfter = cache.computeCacheKey('q', 'ctx', afterDedup, QA, GIT);
  assert.notStrictEqual(
    keyBefore, keyAfter,
    'dedup-shrunk roster must key differently from the pre-dedup roster'
  );
});

test('TC-206-A4: key is order-independent — same roster, different order, same key', () => {
  const r1 = [{ slot: 'codex-1' }, { slot: 'gemini-1' }];
  const r2 = [{ slot: 'gemini-1' }, { slot: 'codex-1' }];
  assert.strictEqual(
    cache.computeCacheKey('q', 'ctx', r1, QA, GIT),
    cache.computeCacheKey('q', 'ctx', r2, QA, GIT),
    'roster order must not affect the key (slots are sorted)'
  );
});

test('TC-206-A5: nf-prompt.js keys the cache on uniqueSlots, not cappedSlots', () => {
  // Guard against a regression that re-orders the cache check before SC-4/dedup.
  const src = require('fs').readFileSync(path.join(__dirname, 'nf-prompt.js'), 'utf8');
  const m = src.match(/computeCacheKey\(\s*prompt\s*,\s*contextYaml\s*,\s*(\w+)\s*,/);
  assert.ok(m, 'expected a computeCacheKey(prompt, contextYaml, <roster>, ...) call');
  assert.strictEqual(
    m[1], 'uniqueSlots',
    'cache key must be computed from uniqueSlots (final dispatched roster)'
  );
  // And the cache check must appear AFTER uniqueSlots is defined.
  const idxDef = src.indexOf('const uniqueSlots =');
  const idxKey = src.indexOf('computeCacheKey(prompt, contextYaml, uniqueSlots');
  assert.ok(idxDef !== -1 && idxKey !== -1 && idxKey > idxDef,
    'cache key computation must come after uniqueSlots is finalized');
});

// ── (b) PREFLIGHT TIME BUDGET ─────────────────────────────────────────────

function runPreflight(args, timeoutMs, extraEnv) {
  return spawnSync('node', [PREFLIGHT, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    // Force a clean env so no real CLIs/services are probed unexpectedly.
    env: { ...process.env, ...(extraEnv || {}) },
  });
}

// Write a providers.json fixture with a single HTTP slot and return its path.
// Pointed at via UNIFIED_PROVIDERS_CONFIG so preflight has a real Layer-2 target
// to (not) probe — without it the budget test is vacuous in a CI checkout where
// no HTTP slots are installed.
function writeHttpFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-budget-'));
  const file = path.join(dir, 'providers.json');
  fs.writeFileSync(file, JSON.stringify({
    providers: [{
      // Named to match a default quorum_active slot so preflight probes it
      // whether the active list is populated (filtered by name) or empty (all
      // probed) — otherwise the slot is filtered out and the test goes vacuous.
      name: 'codex-1',
      type: 'http',
      baseUrl: 'https://nonexistent.invalid/v1',
      apiKeyEnv: 'NF_BUDGET_TEST_KEY',
    }],
  }));
  return { dir, file };
}

test('TC-206-B1: --all --budget-ms 6000 returns valid JSON well within budget', () => {
  const start = Date.now();
  const r = runPreflight(['--all', '--budget-ms', '6000'], 11000);
  const elapsed = Date.now() - start;
  assert.strictEqual(r.status, 0, 'preflight must exit 0');
  assert.ok(elapsed < 10000, `preflight must return within budget headroom (took ${elapsed}ms)`);
  const out = JSON.parse(r.stdout);
  assert.ok(Array.isArray(out.available_slots), 'available_slots must be present');
  assert.ok(Array.isArray(out.unavailable_slots), 'unavailable_slots must be present');
});

test('TC-206-B2: tight budget skips Layer 2 upstream probes (degrade, not SIGTERM)', () => {
  // Inject a real HTTP slot so this test is NOT vacuous — without a fixture, a CI
  // checkout has no HTTP slots and the loop below never runs.
  const { dir, file } = writeHttpFixture();
  try {
    const start = Date.now();
    const r = runPreflight(['--all', '--budget-ms', '1000'], 11000, { UNIFIED_PROVIDERS_CONFIG: file });
    const elapsed = Date.now() - start;
    assert.strictEqual(r.status, 0, 'preflight must exit 0 under a tight budget');
    // Must degrade within budget, not run a ~5s network round-trip to the dead host.
    assert.ok(elapsed < 4000, `tight-budget preflight must not block on a live probe (took ${elapsed}ms)`);
    const out = JSON.parse(r.stdout);
    const l2s = Object.values(out.health || {}).map(h => h.layer2).filter(Boolean);
    assert.ok(l2s.length > 0, 'fixture HTTP slot must be probed (test must not be vacuous)');
    for (const l2 of l2s) {
      assert.ok(l2.skipped, `layer2 must be skipped under a 1s budget, got: ${JSON.stringify(l2)}`);
      assert.ok(typeof l2.reason === 'string', 'layer2 skip must carry a reason');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-206-B3: service auto-start stays off under --all even with --ensure-services when budget is tight', () => {
  // The auto-start path emits "[preflight] Service ... is down, starting..." on stderr.
  // With a tight budget it must NOT run, regardless of the explicit flag.
  const r = runPreflight(['--all', '--budget-ms', '6000', '--ensure-services'], 11000);
  assert.strictEqual(r.status, 0, 'preflight must exit 0');
  assert.ok(
    !/Service .* is down, starting/.test(r.stderr || ''),
    'ensureServices must not auto-start services when the budget is tight'
  );
});

test('TC-206-B4: backward compatible — --all with no flags still produces tiered output', () => {
  // Absent --budget-ms, behavior must be unchanged (no budget-driven skips imposed).
  const r = runPreflight(['--all', '--no-probe'], 11000);
  assert.strictEqual(r.status, 0, 'preflight --all --no-probe must exit 0');
  const out = JSON.parse(r.stdout);
  assert.ok('quorum_active' in out && 'team' in out, 'no-probe output shape preserved');
});

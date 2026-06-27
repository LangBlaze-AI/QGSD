'use strict';

// hooks/config-loader-validate-adversarial.test.cjs
//
// ADVERSARIAL tests for validateConfig() ↔ the shallow-spread merge in loadConfig().
//
// loadConfig() merges DEFAULT_CONFIG, global, and project with a SHALLOW spread
// `{ ...DEFAULT_CONFIG, ...global, ...project }`. A partial nested object in a
// hand-edited project/global nf.json therefore REPLACES the whole default nested
// object — every sibling key the user omitted vanishes. validateConfig() is the
// last line of defence: it must RESTORE those omitted nested defaults and coerce
// wrong-typed values, or a downstream hook dereferences `undefined` (the #283 class:
// quorum-preflight shipped a corrupt roster because it bypassed validateConfig).
//
// These tests call validateConfig() directly with config objects built to mirror
// exactly what the shallow merge produces. No source edits, no real ~/.claude.

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateConfig, DEFAULT_CONFIG } = require('./config-loader');

// Deep clone so per-test mutation by validateConfig (it mutates nested objects in
// place) never leaks into the shared module-level DEFAULT_CONFIG.
function clone(obj) {
  return typeof structuredClone === 'function'
    ? structuredClone(obj)
    : JSON.parse(JSON.stringify(obj));
}

// Reproduces loadConfig's shallow spread: project `overrides` replace whole
// top-level keys (including nested objects) of a clean DEFAULT_CONFIG base.
function merged(overrides) {
  return { ...clone(DEFAULT_CONFIG), ...overrides };
}

// Silence validateConfig's stderr warnings during a call (keeps test output clean)
// while still exercising the real code path.
function quiet(fn) {
  const orig = process.stderr.write;
  process.stderr.write = () => true;
  try {
    return fn();
  } finally {
    process.stderr.write = orig;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GAP 1 (#283 class): a partial `quorum` object loses min_live_voters and
// validateConfig never restores it. Downstream consensus gate reads undefined.
// ─────────────────────────────────────────────────────────────────────────────
test('A1: partial quorum {maxSize} → min_live_voters restored to default after shallow merge', () => {
  // Hand-edited project nf.json: `"quorum": { "maxSize": 5 }` only.
  // Shallow merge drops the default sibling `min_live_voters: 2`.
  const config = quiet(() => validateConfig(merged({ quorum: { maxSize: 5 } })));

  // maxSize and preferSub ARE handled by validateConfig...
  assert.equal(config.quorum.maxSize, 5, 'user maxSize preserved');
  assert.equal(config.quorum.preferSub, false, 'missing preferSub restored');

  // ...but min_live_voters is NOT. It is left undefined, so any consumer that
  // trusts validateConfig (rather than re-deriving like nf-stop.getMinLiveVoters)
  // reads `config.quorum.min_live_voters === undefined` and the consensus floor
  // (issue #170) silently disappears.
  assert.equal(
    config.quorum.min_live_voters,
    DEFAULT_CONFIG.quorum.min_live_voters,
    '🔴 quorum.min_live_voters not restored after partial-object shallow merge ' +
    '(config-loader.js ~400-414): validateConfig fills maxSize/preferSub but never min_live_voters'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP 2: wrong-TYPE quorum (an array) is not coerced back to the default object.
// agent_config (~417) guards Array.isArray; quorum (~399) does NOT — `typeof []`
// is 'object', so an array slips into the else branch and stays an array.
// ─────────────────────────────────────────────────────────────────────────────
test('A2: wrong-type quorum (array) → replaced with default object, not left as array', () => {
  const config = quiet(() => validateConfig(merged({ quorum: [1, 2] })));

  assert.equal(
    Array.isArray(config.quorum),
    false,
    '🔴 quorum given an array is not coerced to an object (config-loader.js ~399 is ' +
    'missing the Array.isArray guard that agent_config ~417 has); it stays an array ' +
    'with maxSize/preferSub bolted on and min_live_voters undefined'
  );
  assert.equal(typeof config.quorum, 'object');
  assert.equal(config.quorum.min_live_voters, DEFAULT_CONFIG.quorum.min_live_voters,
    'replaced object must carry the default min_live_voters');
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTROL: circuit_breaker partial restoration — this is the #283 fix done RIGHT.
// A regression that drops a sibling default here would fail this test.
// ─────────────────────────────────────────────────────────────────────────────
test('A3: partial circuit_breaker {oscillation_depth} → all sibling defaults restored', () => {
  const config = quiet(() => validateConfig(merged({ circuit_breaker: { oscillation_depth: 2 } })));

  const cb = config.circuit_breaker;
  assert.equal(cb.oscillation_depth, 2, 'user value preserved');
  assert.equal(cb.commit_window, DEFAULT_CONFIG.circuit_breaker.commit_window);
  assert.equal(cb.haiku_reviewer, DEFAULT_CONFIG.circuit_breaker.haiku_reviewer);
  assert.equal(cb.haiku_model, DEFAULT_CONFIG.circuit_breaker.haiku_model);
  assert.equal(cb.min_cycles, DEFAULT_CONFIG.circuit_breaker.min_cycles);
  assert.equal(cb.rollback_detection, DEFAULT_CONFIG.circuit_breaker.rollback_detection);
  // None may be undefined — downstream nf-circuit-breaker derefs every one of these.
  for (const k of Object.keys(DEFAULT_CONFIG.circuit_breaker)) {
    assert.notEqual(cb[k], undefined, 'circuit_breaker.' + k + ' must not be undefined');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTROL: context_monitor partial restoration + ordering invariant.
// `{ warn_pct: 70 }` only must restore critical_pct (90) and keep warn < critical.
// ─────────────────────────────────────────────────────────────────────────────
test('A4: partial context_monitor {warn_pct} → critical_pct restored and ordering held', () => {
  const config = quiet(() => validateConfig(merged({ context_monitor: { warn_pct: 70 } })));

  assert.equal(config.context_monitor.warn_pct, 70);
  assert.equal(config.context_monitor.critical_pct, DEFAULT_CONFIG.context_monitor.critical_pct,
    'missing critical_pct must be restored, not left undefined');
  assert.ok(config.context_monitor.warn_pct < config.context_monitor.critical_pct,
    'warn_pct must remain strictly below critical_pct');
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTROL: numeric/boolean/range coercion completeness across several fields.
// Strings, zero, negatives, non-integers, and bad orderings must all be coerced.
// ─────────────────────────────────────────────────────────────────────────────
test('A5: type/range coercion — strings/0/neg/float/bad-order all coerced to safe values', () => {
  const config = quiet(() => validateConfig(merged({
    quorum: { maxSize: '5', preferSub: 'yes' },           // string number + string bool
    circuit_breaker: { oscillation_depth: 0, commit_window: -3, min_cycles: 1.5 }, // 0/neg/float
    context_monitor: { warn_pct: 95, critical_pct: 90 },  // invalid ordering warn >= critical
    budget: { warn_pct: 0, downgrade_pct: 200 },          // 0 and out-of-range
  })));

  assert.equal(config.quorum.maxSize, DEFAULT_CONFIG.quorum.maxSize, 'string maxSize coerced to default');
  assert.equal(typeof config.quorum.preferSub, 'boolean', 'string preferSub coerced to boolean');

  assert.ok(Number.isInteger(config.circuit_breaker.oscillation_depth) && config.circuit_breaker.oscillation_depth >= 1,
    'oscillation_depth 0 coerced to positive integer');
  assert.ok(Number.isInteger(config.circuit_breaker.commit_window) && config.circuit_breaker.commit_window >= 1,
    'negative commit_window coerced to positive integer');
  assert.ok(Number.isInteger(config.circuit_breaker.min_cycles) && config.circuit_breaker.min_cycles >= 0,
    'non-integer min_cycles coerced to integer');

  assert.ok(config.context_monitor.warn_pct < config.context_monitor.critical_pct,
    'invalid warn>=critical ordering reset so warn < critical');

  assert.ok(config.budget.warn_pct >= 1 && config.budget.warn_pct < config.budget.downgrade_pct,
    'budget warn_pct coerced and kept below downgrade_pct');
  assert.ok(config.budget.downgrade_pct >= 1 && config.budget.downgrade_pct <= 100,
    'out-of-range downgrade_pct coerced into 1-100');
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTROL: idempotency — a fully-valid config round-trips through validateConfig
// without any field being wrongly reset.
// ─────────────────────────────────────────────────────────────────────────────
test('A6: idempotency — a clean DEFAULT_CONFIG round-trips through validateConfig unchanged', () => {
  const before = clone(DEFAULT_CONFIG);
  const after = quiet(() => validateConfig(clone(DEFAULT_CONFIG)));
  assert.deepEqual(after, before, 'validateConfig must not mutate an already-valid config');
});

'use strict';

// hooks/config-loader-adversarial2.test.cjs
//
// ADVERSARIAL suite ROUND 2 for hooks/config-loader.js.
//
// Round 1 added five fixes:
//   (a) validateConfig restores quorum.min_live_voters after a partial merge,
//   (b) Array.isArray guards on all 7 object-typed nested blocks,
//   (c) loadConfig only spreads a PLAIN-object layer,
//   (d) shouldRunHook resolves via `instanceof Set`,
//   (e) validateHookInput rejects arrays at the root.
//
// This suite hunts for a REGRESSION introduced by those fixes (a valid config that
// the new guards wrongly mutate) and for a DIFFERENT real gap (prototype pollution,
// uncoerced fields). No source edits; never touches the real ~/.claude — global
// layer is sandboxed via a temp HOME, project layer is a temp dir.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  loadConfig,
  validateConfig,
  DEFAULT_CONFIG,
  shouldRunHook,
  validateHookInput,
} = require('./config-loader');

// ── helpers ──────────────────────────────────────────────────────────────────
function clone(obj) {
  return typeof structuredClone === 'function'
    ? structuredClone(obj)
    : JSON.parse(JSON.stringify(obj));
}
function quiet(fn) {
  const orig = process.stderr.write;
  process.stderr.write = () => true;
  try { return fn(); } finally { process.stderr.write = orig; }
}
function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function writeNfJson(dir, content) {
  const cfgDir = path.join(dir, '.claude');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'nf.json'), content, 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// B1 (REGRESSION — critical): a FULLY-VALID, fully-customized config must
// round-trip through validateConfig with every field PRESERVED. The round-1
// Array.isArray guards and the min_live_voters restore must not reset or strip any
// valid value. In particular a user-chosen quorum.min_live_voters (3) must NOT be
// forced back to the default 2. This is the canary: if any new guard over-fires on
// good input, this test fails.
// ─────────────────────────────────────────────────────────────────────────────
test('B1: fully-valid custom config round-trips unchanged (no over-coercion regression)', () => {
  const valid = {
    ...clone(DEFAULT_CONFIG),
    quorum: { maxSize: 6, preferSub: true, min_live_voters: 3 },
    circuit_breaker: {
      oscillation_depth: 4,
      commit_window: 8,
      haiku_reviewer: false,
      haiku_model: 'claude-haiku-4-5-20251001',
      min_cycles: 3,
      rollback_detection: false,
    },
    context_monitor: { warn_pct: 55, critical_pct: 88 },
    budget: { session_limit_tokens: 200000, warn_pct: 50, downgrade_pct: 80 },
    stall_detection: { timeout_s: 120, consecutive_threshold: 3, check_commits: false },
    smart_compact: { enabled: false, context_warn_pct: 45 },
    quorum_active: ['codex-1', 'gemini-1', 'copilot-1'],
    orchestrator_slot_family: 'codex',
    hook_profile: 'strict',
    fail_mode: 'closed',
    model_tier_planner: 'sonnet',
    model_tier_worker: 'sonnet',
    hook_priorities: { 'nf-stop': 500 },
  };
  const before = clone(valid);
  const after = quiet(() => validateConfig(clone(valid)));

  // The headline regression: a valid non-default min_live_voters must survive.
  assert.equal(
    after.quorum.min_live_voters, 3,
    '🔴 REGRESSION: valid quorum.min_live_voters=3 was reset (config-loader.js ~430 ' +
    'restore must only fire when the value is NOT a positive integer)'
  );
  // Every customized field preserved verbatim.
  assert.equal(after.quorum.maxSize, 6);
  assert.equal(after.quorum.preferSub, true);
  assert.deepEqual(after.circuit_breaker, before.circuit_breaker, 'valid circuit_breaker untouched');
  assert.deepEqual(after.context_monitor, before.context_monitor, 'valid context_monitor untouched');
  assert.deepEqual(after.budget, before.budget, 'valid budget untouched');
  assert.deepEqual(after.stall_detection, before.stall_detection, 'valid stall_detection untouched');
  assert.deepEqual(after.smart_compact, before.smart_compact, 'valid smart_compact untouched');
  assert.deepEqual(after.quorum_active, before.quorum_active, 'valid non-empty quorum_active untouched');
  assert.equal(after.orchestrator_slot_family, 'codex', 'valid orchestrator_slot_family untouched');
  assert.equal(after.hook_profile, 'strict', 'valid hook_profile untouched');
  assert.equal(after.fail_mode, 'closed', 'valid fail_mode untouched');
  assert.deepEqual(after.hook_priorities, before.hook_priorities, 'valid hook_priorities untouched');

  // Whole-object deep-equality: nothing added, nothing dropped, nothing changed.
  assert.deepEqual(after, before, 'a fully-valid config must round-trip byte-for-byte');

  // The three real profiles still gate correctly under instanceof-Set resolution.
  assert.equal(shouldRunHook('nf-prompt', 'minimal'), false, 'minimal gates out nf-prompt');
  assert.equal(shouldRunHook('nf-circuit-breaker', 'minimal'), true, 'minimal keeps nf-circuit-breaker');
  assert.equal(shouldRunHook('nf-stop', 'standard'), true, 'standard keeps nf-stop');
  assert.equal(shouldRunHook('nf-stop', 'strict'), true, 'strict keeps nf-stop');

  // validateHookInput still ACCEPTS a valid object payload for every event type.
  const okPayload = {
    PreToolUse: { tool_name: 'Edit', tool_input: {} },
    PostToolUse: { tool_name: 'Edit', tool_response: {} },
    UserPromptSubmit: { prompt: 'hi' },
    Stop: { stop_hook_active: false },
    SubagentStop: {},
    PreCompact: {},
    SessionStart: {},
    SessionEnd: {},
  };
  for (const [evt, payload] of Object.entries(okPayload)) {
    assert.equal(validateHookInput(evt, payload).valid, true, 'valid ' + evt + ' object must pass');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// B2 (PROTOTYPE POLLUTION): a config file carrying "__proto__" / "constructor"
// payloads must not pollute Object.prototype after loadConfig's shallow spread +
// validateConfig. Object spread defines OWN properties (it does not invoke the
// __proto__ setter), so this SHOULD be safe — this test pins that invariant so a
// future refactor to Object.assign-on-a-shared-target or a deep-merge can't silently
// open a pollution hole.
// ─────────────────────────────────────────────────────────────────────────────
test('B2: __proto__/constructor config payload does not pollute Object.prototype', () => {
  const home = mkTempDir('nf-adv2-b2-home-');
  const proj = mkTempDir('nf-adv2-b2-proj-');
  const oldHome = process.env.HOME;
  try {
    // Global carries a __proto__ payload; project carries a constructor payload.
    writeNfJson(home, '{"__proto__":{"polluted":true},"fail_mode":"open"}');
    writeNfJson(proj, '{"constructor":{"prototype":{"polluted2":true}},"fail_mode":"closed"}');
    process.env.HOME = home;

    let config;
    quiet(() => { config = loadConfig(proj); });

    // The pollution canaries — a brand-new empty object must NOT inherit the keys.
    assert.equal(({}).polluted, undefined, '🔴 Object.prototype.polluted set via __proto__ config payload');
    assert.equal(({}).polluted2, undefined, '🔴 Object.prototype.polluted2 set via constructor config payload');
    assert.equal(Object.prototype.polluted, undefined, 'Object.prototype must stay clean (proto)');
    assert.equal(Object.prototype.polluted2, undefined, 'Object.prototype must stay clean (ctor)');

    // And the legitimate merge still worked (project wins on the real key).
    assert.equal(config.fail_mode, 'closed', 'real keys still merge with project precedence');
  } finally {
    // Belt-and-suspenders cleanup in case a regression DID pollute.
    delete Object.prototype.polluted;
    delete Object.prototype.polluted2;
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// B3 (fields not probed in round 1): hook_profile / quorum_active / hook_priorities
// / orchestrator_slot_family coercion. Each invalid value must be corrected to a
// safe value — never left in the config to crash a downstream consumer.
// ─────────────────────────────────────────────────────────────────────────────
test('B3: hook_profile, quorum_active, orchestrator_slot_family, hook_priorities all coerced', () => {
  const config = quiet(() => validateConfig({
    ...clone(DEFAULT_CONFIG),
    hook_profile: 'paranoid',                                  // unknown profile
    quorum_active: ['codex-1', 123, '', '  ', null, 'gemini-1'], // mixed junk
    orchestrator_slot_family: 42,                              // non-string
    hook_priorities: { 'nf-stop': -5, 'nf-prompt': 1.5, 'nf-ok': 200 }, // neg/float/valid
  }));

  // hook_profile coerced to a real profile that shouldRunHook can resolve.
  assert.equal(config.hook_profile, 'standard',
    '🔴 unknown hook_profile not coerced to "standard" (config-loader.js ~614)');
  assert.ok(shouldRunHook('nf-prompt', config.hook_profile), 'coerced profile must resolve in shouldRunHook');

  // quorum_active keeps only non-empty strings.
  assert.deepEqual(config.quorum_active, ['codex-1', 'gemini-1'],
    '🔴 quorum_active not filtered to non-empty strings (config-loader.js ~391)');

  // orchestrator_slot_family non-string → default string.
  assert.equal(typeof config.orchestrator_slot_family, 'string',
    '🔴 non-string orchestrator_slot_family not coerced (config-loader.js ~397)');
  assert.equal(config.orchestrator_slot_family, DEFAULT_CONFIG.orchestrator_slot_family);

  // hook_priorities drops the invalid entries, keeps the valid one.
  assert.equal(config.hook_priorities['nf-stop'], undefined, 'negative priority removed');
  assert.equal(config.hook_priorities['nf-prompt'], undefined, 'non-integer priority removed');
  assert.equal(config.hook_priorities['nf-ok'], 200, 'valid priority kept');
});

// ─────────────────────────────────────────────────────────────────────────────
// B4 (loadConfig precedence under the round-1 plain-object guard): a malformed
// layer must be IGNORED while the other valid layer survives — the guard must not
// over-reach and drop BOTH. Two directions:
//   (i)  valid project + ARRAY global → project wins, global-array ignored, no
//        numeric garbage keys leak in;
//   (ii) valid global + MISSING project → global survives (not reset to DEFAULT).
// ─────────────────────────────────────────────────────────────────────────────
test('B4: precedence — valid layer survives when the OTHER layer is array/missing', () => {
  // (i) valid project + array global
  {
    const home = mkTempDir('nf-adv2-b4i-home-');
    const proj = mkTempDir('nf-adv2-b4i-proj-');
    const oldHome = process.env.HOME;
    try {
      writeNfJson(home, JSON.stringify([1, 2, 3]));             // array global → ignore
      writeNfJson(proj, JSON.stringify({ fail_mode: 'closed', proj_marker: 'P' }));
      process.env.HOME = home;

      let config;
      quiet(() => { config = loadConfig(proj); });

      assert.equal(config.fail_mode, 'closed', 'valid project must survive an array global');
      assert.equal(config.proj_marker, 'P', 'project-only key must survive');
      const numericKeys = Object.keys(config).filter((k) => /^\d+$/.test(k));
      assert.deepEqual(numericKeys, [], '🔴 array global leaked numeric keys (config-loader.js ~666 guard)');
    } finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(proj, { recursive: true, force: true });
    }
  }

  // (ii) valid global + missing project
  {
    const home = mkTempDir('nf-adv2-b4ii-home-');
    const proj = mkTempDir('nf-adv2-b4ii-proj-');  // no nf.json written → project missing
    const oldHome = process.env.HOME;
    try {
      writeNfJson(home, JSON.stringify({ fail_mode: 'closed', global_marker: 'G' }));
      process.env.HOME = home;

      let config;
      quiet(() => { config = loadConfig(proj); });

      assert.equal(config.fail_mode, 'closed', '🔴 valid global dropped when project missing');
      assert.equal(config.global_marker, 'G', 'global-only key must survive a missing project');
    } finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(proj, { recursive: true, force: true });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// B5 (shouldRunHook edge — INVARIANT): non-string profiles never crash and fall
// back to standard; and membership is an EXACT basename match. Hooks pass the
// extensionless basename ('nf-prompt'), so a stray '.js' suffix must NOT match
// (documents the contract the call sites rely on — see grep: every call passes
// 'nf-<name>' with no extension).
// ─────────────────────────────────────────────────────────────────────────────
test('B5: shouldRunHook tolerates non-string profiles and matches basenames exactly', () => {
  for (const p of [0, 1, {}, [], '', null, undefined, NaN]) {
    let res;
    assert.doesNotThrow(() => { res = shouldRunHook('nf-prompt', p); },
      'non-string profile ' + JSON.stringify(p) + ' must not crash the shared gate');
    assert.equal(res, true, 'profile ' + JSON.stringify(p) + ' falls back to standard (nf-prompt on)');
  }
  // Exact-match contract: extensionless name matches; '.js' suffix does not.
  assert.equal(shouldRunHook('nf-prompt', 'standard'), true, 'extensionless basename matches');
  assert.equal(shouldRunHook('nf-prompt.js', 'standard'), false,
    'a .js-suffixed name must NOT match (call sites pass extensionless basenames)');
});

// ─────────────────────────────────────────────────────────────────────────────
// B6 (numeric sub-field completeness — INVARIANT): the remaining stall_detection /
// smart_compact / budget numeric fields, when given out-of-range/garbage values via
// a partial object (the shallow-merge replace pattern), are each coerced to an
// in-range value and the missing siblings are restored. Mirrors what nf-stall /
// smart-compact / budget consumers dereference.
// ─────────────────────────────────────────────────────────────────────────────
test('B6: stall_detection/smart_compact/budget numeric fields coerced + siblings restored', () => {
  const config = quiet(() => validateConfig({
    ...clone(DEFAULT_CONFIG),
    stall_detection: { timeout_s: 0, consecutive_threshold: -1 },     // bad + missing check_commits
    smart_compact: { context_warn_pct: 150 },                         // out of range + missing enabled
    budget: { session_limit_tokens: 10, warn_pct: 95, downgrade_pct: 10 }, // too-small limit + bad order
  }));

  // stall_detection
  assert.ok(Number.isInteger(config.stall_detection.timeout_s) && config.stall_detection.timeout_s >= 1,
    'timeout_s coerced to positive integer');
  assert.ok(Number.isInteger(config.stall_detection.consecutive_threshold) && config.stall_detection.consecutive_threshold >= 1,
    'consecutive_threshold coerced to >= 1');
  assert.equal(typeof config.stall_detection.check_commits, 'boolean', 'missing check_commits restored');

  // smart_compact
  assert.ok(config.smart_compact.context_warn_pct >= 1 && config.smart_compact.context_warn_pct <= 99,
    'context_warn_pct coerced into 1-99');
  assert.equal(typeof config.smart_compact.enabled, 'boolean', 'missing smart_compact.enabled restored');

  // budget
  assert.ok(config.budget.session_limit_tokens === null || config.budget.session_limit_tokens >= 1000,
    'too-small session_limit_tokens coerced to null');
  assert.ok(config.budget.warn_pct >= 1 && config.budget.warn_pct < config.budget.downgrade_pct,
    'budget warn_pct kept strictly below downgrade_pct after bad ordering');
  assert.ok(config.budget.downgrade_pct >= 1 && config.budget.downgrade_pct <= 100,
    'downgrade_pct within 1-100');
});

#!/usr/bin/env node
// hooks/config-loader-load-adversarial.test.cjs
// ADVERSARIAL suite for hooks/config-loader.js — focus: loadConfig (two-layer
// merge + fail-open), shouldRunHook (profile gating), validateHookInput (stdin
// schema). Field-coercion in validateConfig is covered by a sibling suite; not
// duplicated here.
//
// Isolation: each test that touches the GLOBAL layer overrides process.env.HOME
// to a fresh temp dir so os.homedir() resolves to a sandbox — the real
// ~/.claude/nf.json is NEVER read or written. Project dirs are temp dirs.
// stderr is suppressed per-test (warnings are expected) and restored in finally.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  loadConfig,
  DEFAULT_CONFIG,
  shouldRunHook,
  validateHookInput,
} = require('./config-loader');

// ── helpers ──────────────────────────────────────────────────────────────────
function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function writeNfJson(dir, content) {
  const cfgDir = path.join(dir, '.claude');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'nf.json'), content, 'utf8');
}
// Run fn with stderr swallowed (returns captured stderr string).
function withSilencedStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try { fn(); } finally { process.stderr.write = orig; }
  return chunks.join('');
}

// ============================================================================
// loadConfig — true two-layer merge + fail-open
// ============================================================================

// ADV-LOAD-1 (INVARIANT): genuine global+project precedence via HOME override.
// Existing suite only exercises the project layer; this drives BOTH layers and
// asserts project-wins on an overlapping key while a global-only key survives.
test('ADV-LOAD-1: project layer overrides global for same key; global-only key survives', async () => {
  const home = mkTempDir('nf-advload1-home-');
  const proj = mkTempDir('nf-advload1-proj-');
  const oldHome = process.env.HOME;
  try {
    // Global sets fail_mode=closed AND a key only it defines.
    writeNfJson(home, JSON.stringify({ fail_mode: 'closed', global_only_marker: 'G' }));
    // Project sets fail_mode=open (overlapping key — must win).
    writeNfJson(proj, JSON.stringify({ fail_mode: 'open' }));

    process.env.HOME = home;
    assert.equal(os.homedir(), home, 'precondition: HOME override must redirect homedir()');

    let config;
    withSilencedStderr(() => { config = loadConfig(proj); });

    // Project wins on the overlapping key.
    assert.equal(config.fail_mode, 'open', 'project fail_mode must override global');
    // Global-only key survives the shallow merge.
    assert.equal(config.global_only_marker, 'G', 'a key set only in global must survive');
    // DEFAULT-sourced keys still present.
    assert.ok(Array.isArray(config.quorum_commands), 'DEFAULT keys must remain');
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// ADV-LOAD-2 (INVARIANT): BOTH layers corrupt JSON → fail-open, never throw.
// A corrupt config must never crash a hook; loadConfig must degrade to a usable
// DEFAULT-based config and keep stdout (the hook decision channel) clean.
test('ADV-LOAD-2: corrupt global AND corrupt project → usable DEFAULT config, no throw, no stdout', async () => {
  const home = mkTempDir('nf-advload2-home-');
  const proj = mkTempDir('nf-advload2-proj-');
  const oldHome = process.env.HOME;
  const stdoutChunks = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  try {
    writeNfJson(home, '{ corrupt global :');
    writeNfJson(proj, 'not json at all }}}');
    process.env.HOME = home;

    process.stdout.write = (chunk) => { stdoutChunks.push(String(chunk)); return true; };

    let config;
    const stderr = withSilencedStderr(() => {
      assert.doesNotThrow(() => { config = loadConfig(proj); }, 'loadConfig must not throw on corrupt config');
    });

    process.stdout.write = origStdout;

    assert.ok(config && typeof config === 'object', 'must return a usable config object');
    assert.ok(['open', 'closed'].includes(config.fail_mode), 'fail_mode must be valid');
    assert.ok(Array.isArray(config.quorum_commands), 'quorum_commands must be a DEFAULT array');
    assert.ok(stderr.includes('[nf] WARNING:'), 'malformed config must warn on stderr');
    assert.equal(stdoutChunks.length, 0, 'stdout (decision channel) must stay empty');
  } finally {
    process.stdout.write = origStdout;
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// ADV-LOAD-3 (GAP): a non-object top-level config file (a JSON array) is spread
// into the merged config, leaking garbage numeric keys ("0","1","2",...).
// readConfigFile returns the parsed array; loadConfig does
// `{ ...DEFAULT_CONFIG, ...projectObj }` with no Array.isArray guard, so the
// array's indices become config keys. A non-object config should be IGNORED, not
// shredded into the config. This test asserts the SAFE behavior and FAILS today.
test('ADV-LOAD-3: array-typed top-level config must not spread numeric garbage keys (GAP)', async () => {
  const home = mkTempDir('nf-advload3-home-');     // empty global (no nf.json)
  const proj = mkTempDir('nf-advload3-proj-');
  const oldHome = process.env.HOME;
  try {
    writeNfJson(proj, JSON.stringify([1, 2, 3]));   // top-level JSON array
    process.env.HOME = home;

    let config;
    withSilencedStderr(() => { config = loadConfig(proj); });

    const numericKeys = Object.keys(config).filter((k) => /^\d+$/.test(k));
    assert.deepEqual(
      numericKeys, [],
      'array-typed config must be ignored, not spread into numeric keys (got ' + JSON.stringify(numericKeys) + ')'
    );
    // Core config must still be intact regardless.
    assert.ok(Array.isArray(config.quorum_commands), 'DEFAULT quorum_commands must survive');
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// ============================================================================
// shouldRunHook — profile gating (wrong gate = hook silently mis-configured)
// ============================================================================

// ADV-SRH-1 (GAP): an "unknown profile string" that collides with an inherited
// Object.prototype member ('constructor', 'toString', 'hasOwnProperty', ...).
// The gate is `HOOK_PROFILE_MAP[profile] ? profile : 'standard'` — a truthiness
// check that returns the inherited Object constructor (truthy) for 'constructor',
// so validProfile='constructor' and `HOOK_PROFILE_MAP['constructor'].has(...)`
// throws "….has is not a function". The function's own contract is "unknown
// profile → fall back to standard"; it must NOT crash for ANY unknown string.
// Asserts the SAFE fallback and FAILS today (throws). Defense-in-depth: this
// shared gate underlies every hook; a thrown error here is a fail-CLOSED crash.
test('ADV-SRH-1: inherited-prototype profile string falls back to standard, must not crash (GAP)', async () => {
  for (const poisoned of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.doesNotThrow(
      () => shouldRunHook('nf-prompt', poisoned),
      'shouldRunHook must not throw for unknown profile ' + JSON.stringify(poisoned)
    );
    // Fallback to 'standard' means nf-prompt (a standard hook) is enabled.
    assert.equal(
      shouldRunHook('nf-prompt', poisoned), true,
      'profile ' + JSON.stringify(poisoned) + ' must behave like standard (nf-prompt enabled)'
    );
  }
});

// ADV-SRH-2 (INVARIANT): benign unknown profiles and a strict-only membership
// check. Verifies the documented fallback path is correct (does NOT degrade to a
// permissive/empty set) and that a hook gated OUT of minimal stays gated out —
// i.e. the gate neither wrongly-enables nor wrongly-disables.
test('ADV-SRH-2: benign unknown profiles fall back to standard; minimal correctly gates out nf-stop', async () => {
  for (const p of ['paranoid', '', null, undefined, 42, {}]) {
    assert.equal(shouldRunHook('nf-prompt', p), true, 'unknown profile ' + JSON.stringify(p) + ' → standard (nf-prompt on)');
    assert.equal(shouldRunHook('nf-stop', p), true, 'unknown profile ' + JSON.stringify(p) + ' → standard (nf-stop on)');
  }
  // nf-stop is a safety/quorum gate present in standard+strict but NOT minimal.
  assert.equal(shouldRunHook('nf-stop', 'minimal'), false, 'nf-stop must be gated OUT of minimal');
  assert.equal(shouldRunHook('nf-stop', 'strict'), true, 'nf-stop must be ON in strict');
  // An unknown hook basename is never a member of any profile.
  assert.equal(shouldRunHook('nf-does-not-exist', 'standard'), false, 'unknown hook basename → false');
});

// ============================================================================
// validateHookInput — stdin schema (wrong verdict = hook crashes or rejects good)
// ============================================================================

// ADV-VHI-1 (GAP): an ARRAY payload. The root guard rejects non-objects via
// `typeof input !== 'object' || input === null`, but `typeof [] === 'object'`,
// so an array slips through. For an event WITH a required field (PreToolUse) the
// array is then rejected (no 'tool_name' in []), but for an event with NO
// required fields (Stop / SessionStart / SessionEnd / PreCompact / SubagentStop)
// the array is reported VALID. Same structurally-broken input → opposite verdicts.
// A hook using validateHookInput as a shape gate would proceed on an array for
// Stop. Asserts arrays are consistently rejected; FAILS today for Stop.
test('ADV-VHI-1: array payload must be rejected consistently (not "valid" for no-required-field events) (GAP)', async () => {
  // Baseline: array IS correctly rejected where a required field exists.
  assert.equal(
    validateHookInput('PreToolUse', []).valid, false,
    'array rejected for PreToolUse (missing required tool_name)'
  );
  // GAP: the same array is accepted for an event with no required fields.
  const stopVerdict = validateHookInput('Stop', []);
  assert.equal(
    stopVerdict.valid, false,
    'array payload must NOT be treated as a valid object for Stop (got valid:' + stopVerdict.valid + ')'
  );
});

// ADV-VHI-2 (INVARIANT): the fail-open / fail-closed contract hooks rely on.
// Unknown event type → valid (fail-open, forward-compatible). Known event with a
// missing/wrong-typed required field → invalid (fail-closed). null/non-object
// root → invalid with not_object. Null optional fields are ignored. These must
// hold together or hooks either crash on bad input or reject good input.
test('ADV-VHI-2: unknown event fails open; known-event bad required fails closed; null root rejected', async () => {
  // Unknown event → pass-through.
  assert.equal(validateHookInput('SomeFutureEvent', { anything: 1 }).valid, true, 'unknown event must fail-open');
  assert.equal(validateHookInput('SomeFutureEvent', {}).valid, true, 'unknown event with empty obj must fail-open');
  // Known event, missing required → fail-closed with the field reported.
  const miss = validateHookInput('UserPromptSubmit', {});
  assert.equal(miss.valid, false, 'missing required prompt must fail');
  assert.ok(miss.errors.some((e) => e.field === 'prompt' && e.error === 'missing'), 'reports prompt missing');
  // Known event, required present but wrong type → fail-closed.
  const wrong = validateHookInput('UserPromptSubmit', { prompt: 123 });
  assert.equal(wrong.valid, false, 'wrong-typed prompt must fail');
  assert.ok(wrong.errors.some((e) => e.field === 'prompt' && e.error === 'wrong_type'), 'reports prompt wrong_type');
  // null / non-object root → not_object.
  for (const bad of [null, 'str', 42, true, undefined]) {
    const r = validateHookInput('PreToolUse', bad);
    assert.equal(r.valid, false, JSON.stringify(bad) + ' root must be invalid');
    assert.ok(r.errors.some((e) => e.error === 'not_object'), JSON.stringify(bad) + ' must report not_object');
  }
  // Null optional field is ignored (present-but-null ≠ wrong type).
  assert.equal(validateHookInput('PostToolUse', { tool_name: 'Read', tool_response: null }).valid, true, 'null optional ignored');
});

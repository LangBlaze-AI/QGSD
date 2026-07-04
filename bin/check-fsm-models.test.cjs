'use strict';

// Unit tests for bin/check-fsm-models.cjs — the FSM→TLA loop-closure sweep.
// The pure logic (resolveSpec pairing + toInvariantOnlyCfg rewriting) runs jar-free
// and is where the FP-safety lives: never pair to a default model, and never leave a
// PROPERTY/deadlock check in the cfg. The end-to-end TLC runs gate on jar presence.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkFsmModels, resolveSpec, toInvariantOnlyCfg } = require('./check-fsm-models.cjs');

function resolveJar() {
  try { return require('./resolve-formal-tools.cjs').resolveTlaJar(process.cwd()); }
  catch (_) { const h = path.join(process.env.HOME || '', '.local/share/nf-formal/tla/tla2tools.jar'); return fs.existsSync(h) ? h : null; }
}
const JAR = resolveJar();
const HAVE_TLC = !!(JAR && fs.existsSync(JAR));

// ── resolveSpec: cfg→spec pairing, FP-safe (skip, never default) ─────────────

test('resolveSpec matches an explicit <Name>.tla reference in the cfg header', () => {
  const cfg = '\\* model for QGSDActivityTracking\n\\* see QGSDActivityTracking.tla\nCONSTANT MaxBound = 4\n';
  const spec = resolveSpec('MCactivity', cfg, ['QGSDActivityTracking.tla', 'NFQuorum.tla']);
  assert.strictEqual(spec, 'QGSDActivityTracking.tla');
});

test('resolveSpec falls to the naming heuristic (NF-prefixed) when no header ref', () => {
  const spec = resolveSpec('MCStopHook', 'CONSTANT MaxBound = 4\n', ['NFStopHook.tla', 'NFQuorum.tla']);
  assert.strictEqual(spec, 'NFStopHook.tla');
});

test('resolveSpec matches the _xstate convention', () => {
  const spec = resolveSpec('MCTestFsm', 'CONSTANT MaxBound = 4\n', ['TestFsm_xstate.tla', 'NFQuorum.tla']);
  assert.strictEqual(spec, 'TestFsm_xstate.tla');
});

test('resolveSpec returns null (SKIP) when unresolved — NEVER a default fallback', () => {
  // The FP-safety core: an unpairable cfg must not silently model-check NFQuorum.tla.
  const spec = resolveSpec('MCtotallyunknownthing', 'CONSTANT MaxBound = 4\n', ['NFQuorum.tla', 'NFStopHook.tla']);
  assert.strictEqual(spec, null);
});

// ── toInvariantOnlyCfg: strip PROPERTY/deadlock, keep INVARIANT ──────────────

test('toInvariantOnlyCfg keeps CONSTANT/SPEC/INVARIANT and drops PROPERTY', () => {
  const cfg = [
    'CONSTANT MaxBound = 4',
    'SPECIFICATION Spec',
    'INVARIANT TypeOK',
    'PROPERTY Liveness',
    'CHECK_DEADLOCK TRUE',
  ].join('\n');
  const out = toInvariantOnlyCfg(cfg);
  assert.ok(/CONSTANT MaxBound = 4/.test(out));
  assert.ok(/SPECIFICATION Spec/.test(out));
  assert.ok(/INVARIANT TypeOK/.test(out));
  assert.ok(!/PROPERTY/.test(out), 'PROPERTY line must be stripped (liveness not FP-safe on sequential specs)');
  assert.ok(/CHECK_DEADLOCK FALSE/.test(out), 'deadlock check forced off');
  assert.ok(!/CHECK_DEADLOCK TRUE/.test(out));
});

test('toInvariantOnlyCfg drops multi-line PROPERTY continuation lines', () => {
  const cfg = [
    'SPECIFICATION Spec',
    'INVARIANT TypeOK',
    'PROPERTIES',
    '    EventuallyDone',
    '    AlwaysProgress',
    'INVARIANT Bounded',
  ].join('\n');
  const out = toInvariantOnlyCfg(cfg);
  assert.ok(/INVARIANT TypeOK/.test(out));
  assert.ok(/INVARIANT Bounded/.test(out), 'an INVARIANT after the PROPERTY block is retained');
  assert.ok(!/EventuallyDone/.test(out) && !/AlwaysProgress/.test(out), 'property continuation lines dropped');
});

test('toInvariantOnlyCfg returns null for a PROPERTY-only cfg (out of step-1 scope)', () => {
  const cfg = 'SPECIFICATION Spec\nPROPERTY Liveness\nCHECK_DEADLOCK FALSE\n';
  assert.strictEqual(toInvariantOnlyCfg(cfg), null);
});

// ── end-to-end ───────────────────────────────────────────────────────────────

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nf-fsm-t-')); }
function writeTla(root, name, content) {
  const dir = path.join(root, '.planning', 'formal', 'tla');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

test('no tla dir → clean, never a crash', () => {
  const root = tmpRoot();
  try {
    const r = checkFsmModels(root);
    assert.ok(r && typeof r.count === 'number');
    if (HAVE_TLC) { assert.strictEqual(r.skipped, false); assert.strictEqual(r.count, 0); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('checks a paired FSM model INVARIANT-only and detects a real violation (when TLC present)', { skip: !HAVE_TLC }, () => {
  const root = tmpRoot();
  try {
    // A bounded parameterized model whose INVARIANT is reachably false, plus a PROPERTY
    // that would fail vacuously on this sequential spec — the sweep must run the
    // INVARIANT (and flag it) while IGNORING the PROPERTY.
    writeTla(root, 'FsmBad.tla', [
      '---- MODULE FsmBad ----',
      'EXTENDS Naturals',
      'CONSTANT MaxBound',
      'VARIABLES x',
      'Init == x = 0',
      'Next == x < MaxBound /\\ x\' = x + 1',
      'Bounded == x < MaxBound',       // reachably violated: x reaches MaxBound
      'Stuck == <>(x = 99)',           // liveness that never holds — must be ignored
      'Spec == Init /\\ [][Next]_<<x>>',
      '====',
    ].join('\n'));
    writeTla(root, 'MCFsmBad.cfg', [
      '\\* model for FsmBad.tla',
      'CONSTANT MaxBound = 3',
      'SPECIFICATION Spec',
      'INVARIANT Bounded',
      'PROPERTY Stuck',
      'CHECK_DEADLOCK FALSE',
    ].join('\n'));
    const r = checkFsmModels(root);
    assert.strictEqual(r.skipped, false);
    assert.strictEqual(r.count, 1, 'the INVARIANT violation is caught');
    assert.strictEqual(r.findings[0].rule, 'fsm-invariant-violation');
    assert.strictEqual(r.findings[0].source, 'fsm-transpiled');
    assert.strictEqual(r.findings[0].invariant, 'Bounded');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a paired FSM model with a holding INVARIANT is clean (when TLC present)', { skip: !HAVE_TLC }, () => {
  const root = tmpRoot();
  try {
    writeTla(root, 'FsmOk.tla', [
      '---- MODULE FsmOk ----',
      'EXTENDS Naturals',
      'CONSTANT MaxBound',
      'VARIABLES x',
      'Init == x = 0',
      'Next == x < MaxBound /\\ x\' = x + 1',
      'Bounded == x <= MaxBound',      // always holds
      'Spec == Init /\\ [][Next]_<<x>>',
      '====',
    ].join('\n'));
    writeTla(root, 'MCFsmOk.cfg', 'CONSTANT MaxBound = 3\nSPECIFICATION Spec\nINVARIANT Bounded\n');
    const r = checkFsmModels(root);
    assert.strictEqual(r.count, 0);
    assert.strictEqual(r.checked, 1, 'the model was actually checked (not skipped)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an unpairable cfg is skipped, not run against a wrong model (when TLC present)', { skip: !HAVE_TLC }, () => {
  const root = tmpRoot();
  try {
    // cfg references no resolvable spec → resolveSpec returns null → skip.
    writeTla(root, 'Real.tla', '---- MODULE Real ----\nEXTENDS Naturals\nVARIABLES x\nInit == x=0\nNext == x\'=x\nBad == x = 1\nSpec == Init /\\ [][Next]_<<x>>\n====');
    writeTla(root, 'MCnonexistent.cfg', 'CONSTANT MaxBound = 3\nSPECIFICATION Spec\nINVARIANT Bad\n');
    const r = checkFsmModels(root);
    assert.strictEqual(r.count, 0, 'unpaired cfg produced no finding (not run against Real.tla)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

'use strict';

// Unit tests for bin/check-model-invariants.cjs — the TLC-backed model-check sweep.
// These are SKIP-AWARE: when tla2tools.jar / Java isn't available the sweep returns
// { skipped: true } and the detection assertions are skipped rather than failing.
// Where TLC IS present, they assert a clean baseline (a safe concrete model produces
// 0 findings) and real detection of a reachable safety-invariant violation.
//
// analyzeModel() (pure cfg-generation logic) is tested unconditionally — it needs no
// jar and is where the false-positive-avoidance rules live (spec/invariant selection).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkModelInvariants, analyzeModel } = require('./check-model-invariants.cjs');

function resolveJar() {
  try {
    const { resolveTlaJar } = require('./resolve-formal-tools.cjs');
    return resolveTlaJar(process.cwd());
  } catch (_) {
    const home = path.join(process.env.HOME || '', '.local', 'share', 'nf-formal', 'tla', 'tla2tools.jar');
    return fs.existsSync(home) ? home : null;
  }
}
const JAR = resolveJar();
const HAVE_TLC = !!(JAR && fs.existsSync(JAR));

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nf-mc-t-')); }
function writeModel(root, name, content) {
  const dir = path.join(root, '.planning', 'formal', 'tla');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

const SAFE = [
  '---- MODULE Safe ----',
  'EXTENDS Naturals',
  'VARIABLES x',
  'Init == x = 0',
  'Bump == x < 3 /\\ x\' = x + 1',
  'Next == Bump',
  'Bounded == x <= 3',
  'vars == <<x>>',
  'Spec == Init /\\ [][Next]_vars',
  '====',
].join('\n');

const VIOLATING = [
  '---- MODULE Bad ----',
  'EXTENDS Naturals',
  'VARIABLES lockA, lockB',
  'Init == lockA = 0 /\\ lockB = 0',
  'AcquireA == lockA = 0 /\\ lockA\' = 1 /\\ lockB\' = lockB',
  'AcquireB == lockB = 0 /\\ lockB\' = 1 /\\ lockA\' = lockA',
  'Next == AcquireA \\/ AcquireB',
  'NoDeadlock == ~(lockA = 1 /\\ lockB = 1)',
  'vars == <<lockA, lockB>>',
  'Spec == Init /\\ [][Next]_vars',
  '====',
].join('\n');

// ── analyzeModel: pure cfg-generation logic (no jar needed) ──────────────────

test('analyzeModel picks the temporal Spec and only nullary safety invariants', () => {
  const { spec, invs } = analyzeModel(SAFE);
  assert.strictEqual(spec, 'Spec', 'the [][Next]_vars def is the SPECIFICATION');
  assert.ok(invs.includes('Bounded'), 'a nullary boolean state predicate is an invariant candidate');
  // Init/Next/vars and the action defs (primed) must NOT be treated as invariants.
  assert.ok(!invs.includes('Init'));
  assert.ok(!invs.includes('Next'));
  assert.ok(!invs.includes('Bump'), 'a primed (action) def is not a safety invariant');
  assert.ok(!invs.includes('vars'));
});

test('analyzeModel prefers a def literally named Spec over another [][ def', () => {
  const m = [
    'Init == x = 0', 'Next == x\' = x',
    'Other == Init /\\ [][Next]_vars',
    'Spec == Init /\\ [][Next]_vars',
    'Inv == x = 0',
  ].join('\n');
  const { spec } = analyzeModel(m);
  assert.strictEqual(spec, 'Spec');
});

test('analyzeModel excludes temporal/liveness properties from invariants', () => {
  const m = [
    'Init == x = 0', 'Next == x\' = x + 1',
    'Spec == Init /\\ [][Next]_vars',
    'Liveness == <>(x = 5)',          // temporal → not a safety invariant
    'Fair == WF_vars(Next)',          // fairness → not an invariant
    'TypeOK == x \\in Nat',           // nullary safety predicate → IS a candidate
  ].join('\n');
  const { invs } = analyzeModel(m);
  assert.ok(invs.includes('TypeOK'));
  assert.ok(!invs.includes('Liveness'));
  assert.ok(!invs.includes('Fair'));
});

// ── checkModelInvariants: fail-open + real TLC runs ──────────────────────────

test('fail-open: no .tla dir → clean (skipped:false, count:0), never a crash', () => {
  const root = tmpRoot();
  try {
    const r = checkModelInvariants(root);
    assert.ok(r && typeof r.count === 'number');
    if (HAVE_TLC) {
      assert.strictEqual(r.skipped, false);
      assert.strictEqual(r.count, 0);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a safe concrete model produces 0 findings (when TLC present)', { skip: !HAVE_TLC }, () => {
  const root = tmpRoot();
  try {
    writeModel(root, 'Safe.tla', SAFE);
    const r = checkModelInvariants(root);
    assert.strictEqual(r.skipped, false);
    assert.strictEqual(r.count, 0, 'a model whose invariant always holds is clean');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('detects a reachable invariant violation (when TLC present)', { skip: !HAVE_TLC }, () => {
  const root = tmpRoot();
  try {
    writeModel(root, 'Bad.tla', VIOLATING);
    const r = checkModelInvariants(root);
    assert.strictEqual(r.skipped, false);
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.findings[0].rule, 'invariant-violation');
    assert.strictEqual(r.findings[0].invariant, 'NoDeadlock');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('parameterized (CONSTANTS) models are skipped, not flagged (when TLC present)', { skip: !HAVE_TLC }, () => {
  const root = tmpRoot();
  try {
    // A CONSTANTS model needs a hand cfg to bound it; auto-cfg would error. It must
    // be silently skipped (concrete-only scope), never a false finding or a crash.
    const param = [
      '---- MODULE Param ----',
      'CONSTANTS N',
      'VARIABLES x',
      'Init == x = 0',
      'Next == x\' = (x + 1) % N',
      'Inv == x < N',
      'vars == <<x>>',
      'Spec == Init /\\ [][Next]_vars',
      '====',
    ].join('\n');
    writeModel(root, 'Param.tla', param);
    const r = checkModelInvariants(root);
    assert.strictEqual(r.skipped, false);
    assert.strictEqual(r.count, 0, 'CONSTANTS model is out of scope → not flagged');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('_TTrace_ error-trace models are ignored (when TLC present)', { skip: !HAVE_TLC }, () => {
  const root = tmpRoot();
  try {
    // A leftover _TTrace_ file from a prior TLC run must never be re-checked.
    writeModel(root, 'Bad_TTrace_123.tla', VIOLATING);
    const r = checkModelInvariants(root);
    assert.strictEqual(r.count, 0, '_TTrace_ files are skipped by name');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

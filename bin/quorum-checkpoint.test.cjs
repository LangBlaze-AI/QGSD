'use strict';
// bin/quorum-checkpoint.test.cjs
// Test suite for bin/quorum-checkpoint.cjs — the structured FALLBACK-01
// checkpoint writer/validator (issue #172).
//
// Run: node --test bin/quorum-checkpoint.test.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'quorum-checkpoint.cjs');
const mod = require('./quorum-checkpoint.cjs');

// A minimal, schema-valid checkpoint object.
function validCheckpoint(overrides) {
  return Object.assign({
    round: 1,
    unavail_primaries: ['codex-1'],
    fallback_dispatched: true,
    t1_slots_tried: ['opencode-1'],
    t2_slots_tried: [],
    all_tiers_exhausted: false,
    proceed_reason: 'T1 fallback opencode-1 returned APPROVE',
    timestamp: '2026-05-18T12:00:00.000Z',
    schema_version: 1,
  }, overrides || {});
}

function tmpRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qckpt-${label}-`));
}

// ── validateCheckpoint ───────────────────────────────────────────────────────

test('validateCheckpoint: a well-formed checkpoint passes', () => {
  const { valid, errors } = mod.validateCheckpoint(validCheckpoint());
  assert.strictEqual(valid, true, errors.join('; '));
  assert.deepStrictEqual(errors, []);
});

test('validateCheckpoint: missing required field fails', () => {
  const cp = validCheckpoint();
  delete cp.proceed_reason;
  const { valid, errors } = mod.validateCheckpoint(cp);
  assert.strictEqual(valid, false);
  assert.ok(errors.some(e => /proceed_reason/.test(e)), errors.join('; '));
});

test('validateCheckpoint: wrong field type fails', () => {
  const { valid, errors } = mod.validateCheckpoint(validCheckpoint({ round: '1' }));
  assert.strictEqual(valid, false);
  assert.ok(errors.some(e => /round/.test(e)), errors.join('; '));
});

test('validateCheckpoint: round below minimum fails', () => {
  const { valid } = mod.validateCheckpoint(validCheckpoint({ round: 0 }));
  assert.strictEqual(valid, false);
});

test('validateCheckpoint: empty proceed_reason fails (minLength)', () => {
  const { valid } = mod.validateCheckpoint(validCheckpoint({ proceed_reason: '' }));
  assert.strictEqual(valid, false);
});

test('validateCheckpoint: unexpected additional property fails', () => {
  const { valid, errors } = mod.validateCheckpoint(validCheckpoint({ injected: 'x' }));
  assert.strictEqual(valid, false);
  assert.ok(errors.some(e => /injected/.test(e)), errors.join('; '));
});

test('validateCheckpoint: unknown schema_version fails (enum)', () => {
  const { valid } = mod.validateCheckpoint(validCheckpoint({ schema_version: 99 }));
  assert.strictEqual(valid, false);
});

test('validateCheckpoint: non-object input fails cleanly', () => {
  for (const bad of [null, 'string', 42, [1, 2]]) {
    const { valid } = mod.validateCheckpoint(bad);
    assert.strictEqual(valid, false, `expected ${JSON.stringify(bad)} to be invalid`);
  }
});

test('validateCheckpoint: non-string array item fails', () => {
  const { valid } = mod.validateCheckpoint(validCheckpoint({ unavail_primaries: ['ok', 7] }));
  assert.strictEqual(valid, false);
});

// ── checkpointSatisfiesFallback ──────────────────────────────────────────────

test('checkpointSatisfiesFallback: true when fallback_dispatched', () => {
  assert.strictEqual(mod.checkpointSatisfiesFallback(
    validCheckpoint({ fallback_dispatched: true, all_tiers_exhausted: false })), true);
});

test('checkpointSatisfiesFallback: true when all_tiers_exhausted', () => {
  assert.strictEqual(mod.checkpointSatisfiesFallback(
    validCheckpoint({ fallback_dispatched: false, all_tiers_exhausted: true })), true);
});

test('checkpointSatisfiesFallback: false when neither', () => {
  assert.strictEqual(mod.checkpointSatisfiesFallback(
    validCheckpoint({ fallback_dispatched: false, all_tiers_exhausted: false })), false);
});

// ── buildCheckpoint ──────────────────────────────────────────────────────────

test('buildCheckpoint: fills timestamp and schema_version, normalizes lists', () => {
  const cp = mod.buildCheckpoint({
    round: 2,
    fallbackDispatched: false,
    allTiersExhausted: true,
    proceedReason: 'all tiers exhausted',
  });
  assert.strictEqual(cp.schema_version, mod.CHECKPOINT_SCHEMA_VERSION);
  assert.ok(typeof cp.timestamp === 'string' && cp.timestamp.length > 0);
  assert.deepStrictEqual(cp.unavail_primaries, []);
  assert.deepStrictEqual(cp.t1_slots_tried, []);
  assert.strictEqual(mod.validateCheckpoint(cp).valid, true);
});

// ── writeCheckpoint / readCheckpoint ─────────────────────────────────────────

test('writeCheckpoint + readCheckpoint round-trip', () => {
  const root = tmpRoot('rt');
  try {
    const cp = validCheckpoint({ round: 3 });
    const dest = mod.writeCheckpoint(root, cp);
    assert.ok(dest.endsWith(path.join('.planning', 'quorum', 'checkpoints', 'round-3.json')));
    const res = mod.readCheckpoint(root, 3);
    assert.strictEqual(res.exists, true);
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.satisfied, true);
    assert.deepStrictEqual(res.checkpoint, cp);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeCheckpoint: refuses to write an invalid checkpoint', () => {
  const root = tmpRoot('bad');
  try {
    const cp = validCheckpoint();
    delete cp.timestamp;
    assert.throws(() => mod.writeCheckpoint(root, cp), /schema validation/);
    // Nothing should have been written.
    assert.strictEqual(fs.existsSync(mod.checkpointPath(root, 1)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readCheckpoint: missing file reports exists:false', () => {
  const root = tmpRoot('missing');
  try {
    const res = mod.readCheckpoint(root, 1);
    assert.strictEqual(res.exists, false);
    assert.strictEqual(res.valid, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readCheckpoint: invalid JSON reports valid:false', () => {
  const root = tmpRoot('badjson');
  try {
    const p = mod.checkpointPath(root, 1);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{ this is not json', 'utf8');
    const res = mod.readCheckpoint(root, 1);
    assert.strictEqual(res.exists, true);
    assert.strictEqual(res.valid, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readCheckpoint: schema-invalid file reports valid:false', () => {
  const root = tmpRoot('badschema');
  try {
    const p = mod.checkpointPath(root, 1);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ round: 1 }), 'utf8');
    const res = mod.readCheckpoint(root, 1);
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.satisfied, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readCheckpoint: valid but unsatisfying checkpoint → satisfied:false', () => {
  const root = tmpRoot('unsat');
  try {
    mod.writeCheckpoint(root, validCheckpoint({
      fallback_dispatched: false, all_tiers_exhausted: false,
    }));
    const res = mod.readCheckpoint(root, 1);
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.satisfied, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── parseList / parseBool ────────────────────────────────────────────────────

test('parseList: comma-separated, trimmed, empty tokens dropped', () => {
  assert.deepStrictEqual(mod.parseList('a, b ,c'), ['a', 'b', 'c']);
  assert.deepStrictEqual(mod.parseList('none'), []);
  assert.deepStrictEqual(mod.parseList('empty-pool'), []);
  assert.deepStrictEqual(mod.parseList('not needed'), []);
  assert.deepStrictEqual(mod.parseList(''), []);
  assert.deepStrictEqual(mod.parseList(undefined), []);
});

test('parseBool: accepts true/false, rejects anything else', () => {
  assert.strictEqual(mod.parseBool('true', 'f'), true);
  assert.strictEqual(mod.parseBool('false', 'f'), false);
  assert.throws(() => mod.parseBool('yes', 'f'), /must be/);
});

test('renderHtmlComment: includes all checkpoint fields', () => {
  const html = mod.renderHtmlComment(validCheckpoint());
  assert.ok(html.includes('<!-- FALLBACK_CHECKPOINT'));
  assert.ok(html.includes('fallback_dispatched: true'));
  assert.ok(html.includes('all_tiers_exhausted: false'));
  assert.ok(html.includes('-->'));
});

// ── CLI ──────────────────────────────────────────────────────────────────────

function runCli(args, cwd) {
  const r = spawnSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8', timeout: 5000 });
  return { stdout: r.stdout || '', stderr: r.stderr || '', code: r.status };
}

test('CLI: valid invocation writes a schema-valid file and exits 0', () => {
  const root = tmpRoot('cli-ok');
  try {
    const { stdout, code } = runCli([
      '--round', '1', '--cwd', root,
      '--unavail-primaries', 'codex-1,gemini-1',
      '--fallback-dispatched', 'true',
      '--t1-slots', 'opencode-1',
      '--t2-slots', 'none',
      '--all-tiers-exhausted', 'false',
      '--proceed-reason', 'T1 fallback succeeded',
    ], root);
    assert.strictEqual(code, 0, stdout);
    assert.ok(stdout.includes('<!-- FALLBACK_CHECKPOINT'), 'stdout must emit the HTML comment');
    assert.ok(stdout.includes('FALLBACK-01 checkpoint written'));
    const res = mod.readCheckpoint(root, 1);
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.satisfied, true);
    assert.deepStrictEqual(res.checkpoint.unavail_primaries, ['codex-1', 'gemini-1']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: --key=value form is accepted', () => {
  const root = tmpRoot('cli-eq');
  try {
    const { code } = runCli([
      '--round=2', `--cwd=${root}`,
      '--fallback-dispatched=false', '--all-tiers-exhausted=true',
      '--proceed-reason=all tiers exhausted',
    ], root);
    assert.strictEqual(code, 0);
    assert.strictEqual(mod.readCheckpoint(root, 2).satisfied, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: missing required flag exits 1', () => {
  const root = tmpRoot('cli-miss');
  try {
    const { code, stderr } = runCli([
      '--round', '1', '--cwd', root,
      '--fallback-dispatched', 'true', '--all-tiers-exhausted', 'false',
    ], root);
    assert.strictEqual(code, 1);
    assert.ok(/proceed-reason/.test(stderr), stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: invalid boolean value exits 1', () => {
  const root = tmpRoot('cli-bool');
  try {
    const { code } = runCli([
      '--round', '1', '--cwd', root,
      '--fallback-dispatched', 'maybe', '--all-tiers-exhausted', 'false',
      '--proceed-reason', 'x',
    ], root);
    assert.strictEqual(code, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: non-positive --round exits 1', () => {
  const root = tmpRoot('cli-round');
  try {
    for (const bad of ['0', 'abc', '-1']) {
      const { code } = runCli([
        '--round', bad, '--cwd', root,
        '--fallback-dispatched', 'true', '--all-tiers-exhausted', 'false',
        '--proceed-reason', 'x',
      ], root);
      assert.strictEqual(code, 1, `--round ${bad} should fail`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: UNAVAIL present with no fallback prints a WARNING but still exits 0', () => {
  const root = tmpRoot('cli-warn');
  try {
    const { stdout, code } = runCli([
      '--round', '1', '--cwd', root,
      '--unavail-primaries', 'codex-1',
      '--fallback-dispatched', 'false',
      '--all-tiers-exhausted', 'false',
      '--proceed-reason', 'incomplete',
    ], root);
    assert.strictEqual(code, 0);
    assert.ok(/WARNING/.test(stdout), stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

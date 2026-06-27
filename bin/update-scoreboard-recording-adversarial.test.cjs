#!/usr/bin/env node
'use strict';
// Adversarial test suite for bin/update-scoreboard.cjs — the quorum's PERSISTENT MEMORY.
// Focus: vote/verdict RECORDING + validation + RECOMPUTE + loadData fail-open.
//
//   node --test bin/update-scoreboard-recording-adversarial.test.cjs
//
// Mirrors bin/update-scoreboard.test.cjs: spawn the CLI as a subprocess (so a
// process.exit() never contaminates the runner) and operate only on temp files.
// NEVER touches ~/.claude, .planning, or the repo's real scoreboard.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCOREBOARD_PATH = path.join(__dirname, 'update-scoreboard.cjs');
const { emptyData, computeDeliveryStats, computeFlakiness, loadScoreDeltas, DEFAULT_SCORE_DELTAS } = require('./update-scoreboard.cjs');

function runCLI(args, extraEnv) {
  const result = spawnSync('node', [SCOREBOARD_PATH, ...args], {
    encoding: 'utf8',
    timeout: 8000,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.status };
}

function tmpScoreboard() {
  return path.join(os.tmpdir(), 'nf-sb-adv-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
}

function cleanup(filePath) { try { fs.unlinkSync(filePath); } catch (_) {} }

// ---------------------------------------------------------------------------
// ADV-1 (loadData fail-open) — a valid-JSON but wrong-shape scoreboard.
// loadData (line 213) only restores categories/slots/availability; it does NOT
// restore `models`. An empty-object scoreboard `{}` therefore reaches the record
// path with data.models === undefined and the default subcommand crashes
// (`data.models[model]` line ~1076) → FATAL exit 1, the vote is LOST and the
// scoreboard is never updated.
// EXPECTED (correct): loadData degrades to a usable structure; the vote persists.
// ---------------------------------------------------------------------------
test('ADV-1: wrong-shape (empty-object) scoreboard must degrade, not crash, and the vote must persist', () => {
  const sb = tmpScoreboard();
  try {
    fs.writeFileSync(sb, '{}', 'utf8'); // valid JSON, wrong shape (no models/rounds)
    const { exitCode } = runCLI([
      '--model', 'claude', '--result', 'TP', '--task', 'adv1', '--round', '1',
      '--verdict', 'APPROVE', '--scoreboard', sb,
    ]);
    assert.strictEqual(exitCode, 0, 'recording onto an empty-object scoreboard must not crash (loadData fail-open)');
    const data = JSON.parse(fs.readFileSync(sb, 'utf8'));
    assert.ok(Array.isArray(data.rounds), 'rounds must be restored to an array');
    const r = data.rounds.find(x => x && x.task === 'adv1' && x.round === 1);
    assert.ok(r, 'the vote round must be recorded');
    assert.strictEqual(r.votes.claude, 'TP', 'the claude vote must be persisted exactly');
    assert.strictEqual(data.models.claude.score, 1, 'a single TP must recompute to score 1');
  } finally { cleanup(sb); }
});

// ---------------------------------------------------------------------------
// ADV-2 (loadData fail-open / corrupt round) — a `null` entry inside rounds[].
// loadData does not sanitise individual rounds. The default record path's
// `data.rounds.findIndex(r => r.task === ...)` (line ~1112) dereferences the null
// → FATAL exit 1. A SINGLE corrupt round poisons the whole file: the new vote
// cannot be written AND the prior valid round becomes unreachable.
// EXPECTED (correct): the corrupt round is tolerated; prior valid rounds survive
// and the new vote is appended.
// ---------------------------------------------------------------------------
test('ADV-2: a corrupt null round must not crash recording or destroy prior valid rounds', () => {
  const sb = tmpScoreboard();
  try {
    const base = emptyData();
    base.rounds = [
      { date: '06-27', task: 'old', round: 1, votes: { claude: 'TP' }, verdict: 'APPROVE' },
      null, // corrupt entry
    ];
    fs.writeFileSync(sb, JSON.stringify(base), 'utf8');

    const { exitCode } = runCLI([
      '--model', 'claude', '--result', 'TN', '--task', 'newt', '--round', '2',
      '--verdict', 'APPROVE', '--scoreboard', sb,
    ]);
    assert.strictEqual(exitCode, 0, 'a null round in the array must not crash a new record');

    const data = JSON.parse(fs.readFileSync(sb, 'utf8'));
    assert.ok(data.rounds.some(r => r && r.task === 'old' && r.round === 1),
      'the prior valid round must survive (not be lost to a crash)');
    assert.ok(data.rounds.some(r => r && r.task === 'newt' && r.round === 2),
      'the new vote must be recorded');
  } finally { cleanup(sb); }
});

// ---------------------------------------------------------------------------
// ADV-3 (RECORDING validation — #268 class) — merge-wave declares
// `const VALID_RESULTS = new Set([...])` (line ~922) but NEVER uses it. A vote
// file carrying a bogus result code is written verbatim into the scoreboard and
// counted as an invocation (denominator for per-slot success rate) while scoring
// nothing — polluting the quorum's persistent memory exactly like the #268 verdict
// bug. EXPECTED (correct): an invalid result code is rejected/skipped, never
// persisted as a vote.
// ---------------------------------------------------------------------------
test('ADV-3: merge-wave must not persist an invalid result code into the scoreboard', () => {
  const sb = tmpScoreboard();
  const dir = path.join(os.tmpdir(), 'nf-mw-adv-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(dir, { recursive: true });
  try {
    const vote = { slot: 'claude-1', modelId: 'm/x', result: 'BOGUS', verdict: 'APPROVE' };
    fs.writeFileSync(path.join(dir, 'vote-claude-1-badt-1-a.json'), JSON.stringify(vote));

    const { exitCode } = runCLI(['merge-wave', '--dir', dir, '--task', 'badt', '--round', '1', '--scoreboard', sb]);
    assert.strictEqual(exitCode, 0, 'merge-wave should exit 0');

    const data = JSON.parse(fs.readFileSync(sb, 'utf8'));
    const VALID = new Set(['TP', 'TN', 'FP', 'FN', 'TP+', 'TN+', 'UNAVAIL', '']);
    const round = (data.rounds || []).find(r => r && r.task === 'badt' && r.round === 1);
    if (round && round.votes) {
      for (const [k, v] of Object.entries(round.votes)) {
        assert.ok(VALID.has(v), `invalid result code "${v}" must NOT be persisted for ${k} (unused VALID_RESULTS Set)`);
      }
    }
    const slot = (data.slots || {})['claude-1:m/x'];
    if (slot) {
      assert.strictEqual(slot.invocations, 0,
        'a bogus result must NOT inflate slot invocations (would corrupt the success-rate denominator)');
    }
  } finally {
    cleanup(sb);
    try { fs.readdirSync(dir).forEach(f => fs.unlinkSync(path.join(dir, f))); fs.rmdirSync(dir); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// ADV-4 (validation enforcement — invariant) — a wrong-cased verdict ("approve")
// and a negative round must BOTH be rejected (non-zero exit) and leave an existing
// scoreboard byte-for-byte UNCHANGED; a subsequent valid record must persist
// exactly. Guards the #268 validation contract against silent pollution.
// ---------------------------------------------------------------------------
test('ADV-4: invalid verdict/round are rejected and leave the scoreboard untouched; a valid record persists exactly', () => {
  const sb = tmpScoreboard();
  try {
    // Seed a known-good scoreboard via a valid record.
    const seed = runCLI(['--model', 'gemini', '--result', 'TN', '--task', 'seed', '--round', '1',
      '--verdict', 'APPROVE', '--scoreboard', sb]);
    assert.strictEqual(seed.exitCode, 0, 'seed record must succeed');
    const before = fs.readFileSync(sb, 'utf8');

    // (a) wrong-CASE verdict — must be rejected, scoreboard unchanged.
    const badVerdict = runCLI(['--model', 'claude', '--result', 'TP', '--task', 'x', '--round', '1',
      '--verdict', 'approve', '--scoreboard', sb]);
    assert.strictEqual(badVerdict.exitCode, 1, 'a wrong-cased verdict ("approve") must be rejected');
    assert.match(badVerdict.stderr, /--verdict must be one of/, 'stderr must explain the verdict constraint');
    assert.strictEqual(fs.readFileSync(sb, 'utf8'), before, 'rejected verdict must leave the scoreboard byte-unchanged');

    // (b) negative round — must be rejected, scoreboard unchanged.
    const badRound = runCLI(['--model', 'claude', '--result', 'TP', '--task', 'x', '--round', '-3',
      '--verdict', 'APPROVE', '--scoreboard', sb]);
    assert.strictEqual(badRound.exitCode, 1, 'a negative --round must be rejected');
    assert.strictEqual(fs.readFileSync(sb, 'utf8'), before, 'rejected round must leave the scoreboard byte-unchanged');

    // (c) a valid record persists exactly.
    const ok = runCLI(['--model', 'claude', '--result', 'FP', '--task', 'seed', '--round', '1',
      '--verdict', 'BLOCK', '--scoreboard', sb]);
    assert.strictEqual(ok.exitCode, 0, 'valid record must succeed');
    const data = JSON.parse(fs.readFileSync(sb, 'utf8'));
    const r = data.rounds.find(x => x && x.task === 'seed' && x.round === 1);
    assert.strictEqual(r.votes.claude, 'FP', 'claude FP vote persisted exactly');
    assert.strictEqual(r.votes.gemini, 'TN', 'prior gemini TN vote preserved in the same round');
    assert.strictEqual(r.verdict, 'BLOCK', 'verdict updated to BLOCK');
    assert.strictEqual(data.models.claude.score, -3, 'claude FP recomputes to -3');
    assert.strictEqual(data.models.claude.fp, 1, 'claude fp count is 1');
    assert.strictEqual(data.models.gemini.score, 5, 'gemini TN score unchanged at 5');
  } finally { cleanup(sb); }
});

// ---------------------------------------------------------------------------
// ADV-5 (recompute/deltas robustness — invariant) — the exported recompute-ish
// helpers must degrade on a corrupt round (null entry / missing votes) without
// throwing or producing NaN, and the score-delta table must always be numeric
// (fail-open to DEFAULT_SCORE_DELTAS, never NaN).
// ---------------------------------------------------------------------------
test('ADV-5: delivery/flakiness helpers tolerate corrupt rounds; score deltas are always numeric (no NaN)', () => {
  // Corrupt + missing-votes rounds must not throw (try/catch fail-open contract).
  const corrupt = { rounds: [null, { task: 'a', round: 1 /* no votes */ }, { task: 'b', round: 2, votes: null }], slots: {} };
  assert.doesNotThrow(() => computeDeliveryStats(corrupt), 'computeDeliveryStats must not throw on corrupt rounds');
  assert.doesNotThrow(() => computeFlakiness(JSON.parse(JSON.stringify(corrupt))), 'computeFlakiness must not throw on corrupt rounds');

  // Empty-rounds delivery stats are well-formed (no NaN percentages).
  const empty = computeDeliveryStats({ rounds: [], slots: {} });
  assert.strictEqual(empty.delivery_stats.total_rounds, 0, 'empty rounds → total_rounds 0');

  // DEFAULT_SCORE_DELTAS: every code maps to a finite number.
  for (const [k, v] of Object.entries(DEFAULT_SCORE_DELTAS)) {
    assert.strictEqual(typeof v, 'number', `delta ${JSON.stringify(k)} must be a number`);
    assert.ok(Number.isFinite(v), `delta ${JSON.stringify(k)} must be finite (no NaN)`);
  }

  // loadScoreDeltas() fail-open: returns an object whose deltas are all numeric.
  const { deltas } = loadScoreDeltas();
  assert.ok(deltas && typeof deltas === 'object', 'loadScoreDeltas must return a deltas object');
  for (const k of ['TP', 'TN', 'FP', 'FN', 'TP+', 'TN+', 'UNAVAIL', '']) {
    assert.strictEqual(typeof deltas[k], 'number', `loaded delta ${JSON.stringify(k)} must be numeric`);
    assert.ok(Number.isFinite(deltas[k]), `loaded delta ${JSON.stringify(k)} must be finite`);
  }
});

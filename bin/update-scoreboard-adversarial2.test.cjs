#!/usr/bin/env node
'use strict';
// Adversarial test suite — ROUND 2 — for bin/update-scoreboard.cjs (the quorum's
// PERSISTENT MEMORY). Round 1 fixed 6 corrupt-input gaps in loadData / mergeWave /
// get-availability / set-availability. This suite REGRESSION-CHECKS those fixes
// (a valid scoreboard / valid result code / genuine cooldown must STILL behave
// correctly — the hardening must not have broken the happy path) and hunts for a
// DIFFERENT real gap in the same class.
//
//   node --test bin/update-scoreboard-adversarial2.test.cjs
//
// Drives the CLI as a subprocess (so a process.exit() can't contaminate the runner)
// against throwaway --scoreboard / --dir under os.tmpdir(). NEVER touches ~/.claude,
// .planning, or the repo's real scoreboard. All cooldown windows use far-past /
// far-future instants so wall-clock jitter can't flip an assertion.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCOREBOARD_BIN = path.join(__dirname, 'update-scoreboard.cjs');

function runCLI(args, extraEnv) {
  const result = spawnSync('node', [SCOREBOARD_BIN, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.status };
}

function uniqTmp(suffix) {
  return path.join(os.tmpdir(), `nf-sb-adv2-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
}
function writeRaw(p, str) { fs.writeFileSync(p, str, 'utf8'); }
function writeJSON(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8'); }
function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function writeVote(dir, name, obj) { fs.writeFileSync(path.join(dir, name), JSON.stringify(obj), 'utf8'); }

// ===========================================================================
// ADV2-1  (REGRESSION — loadData normalization must NOT wipe populated fields)
//
// Round 1 added a from-scratch normalization to loadData. The danger of a
// normalize-everything pass is that it RESETS valid populated data. A fully
// populated scoreboard (real categories, availability, team, and a mix of valid
// + one corrupt round) must round-trip with all the VALID content intact; only
// the genuinely-corrupt round may be dropped. Recompute legitimately rebuilds
// model stats from rounds, so we assert the NON-recomputed fields (categories,
// availability, team, prior valid rounds) survive verbatim and the new vote is
// appended with correct recomputed math.
// ===========================================================================
test('ADV2-1: a populated scoreboard round-trips through loadData with valid fields intact; only the corrupt round is dropped', () => {
  const sb = uniqTmp('.json');
  try {
    writeJSON(sb, {
      models: {
        claude: { score: 5, tp: 0, tn: 1, fp: 0, fn: 0, impr: 0, invocations: 1 },
        gemini: { score: 1, tp: 1, tn: 0, fp: 0, fn: 0, impr: 0, invocations: 1 },
      },
      slots: { 'codex-1:m/x': { slot: 'codex-1', model: 'm/x', score: 1, tp: 1, tn: 0, fp: 0, fn: 0, impr: 0, invocations: 1 } },
      categories: { Correctness: ['null-deref', 'off-by-one'], Security: ['injection'] },
      availability: { 'gemini-1': { available_at_iso: '2999-01-01T00:00:00.000Z', reason: 'usage limit', set_at: '2026-06-27T00:00:00.000Z' } },
      team: { fingerprint: 'abc123def456', captured_at: '2026-06-27T00:00:00.000Z', claude_model: 'opus', agents: {}, mcps: [], plugins: [] },
      rounds: [
        { date: '06-26', task: 'old-a', round: 1, votes: { claude: 'TN' }, verdict: 'APPROVE' },
        { date: '06-26', task: 'old-b', round: 1, votes: { gemini: 'TP' }, verdict: 'BLOCK' },
        null, // corrupt — must be dropped, must NOT poison the rest
      ],
    });

    const { exitCode } = runCLI([
      '--model', 'claude', '--result', 'TP', '--task', 'fresh', '--round', '9', '--verdict', 'APPROVE',
      '--scoreboard', sb,
    ]);
    assert.strictEqual(exitCode, 0, 'recording onto a populated scoreboard must succeed');

    const d = readJSON(sb);

    // Non-recomputed fields must survive verbatim (normalization must not reset them).
    assert.deepStrictEqual(d.categories, { Correctness: ['null-deref', 'off-by-one'], Security: ['injection'] },
      'categories must round-trip unchanged');
    assert.ok(d.availability && d.availability['gemini-1'] && d.availability['gemini-1'].available_at_iso === '2999-01-01T00:00:00.000Z',
      'availability window must round-trip unchanged');
    assert.ok(d.team && d.team.fingerprint === 'abc123def456', 'team fingerprint must round-trip unchanged');
    assert.ok(d.slots && d.slots['codex-1:m/x'], 'pre-existing slot must survive');

    // Prior valid rounds survive; the corrupt null round is the only one dropped.
    assert.ok(d.rounds.some(r => r && r.task === 'old-a'), 'valid round old-a must survive');
    assert.ok(d.rounds.some(r => r && r.task === 'old-b'), 'valid round old-b must survive');
    assert.ok(d.rounds.some(r => r && r.task === 'fresh' && r.round === 9), 'new vote must be appended');
    assert.ok(d.rounds.every(r => r && typeof r === 'object'), 'no null/corrupt round may remain after normalization');

    // Recompute is from-scratch over surviving rounds: claude has TN (old-a) + TP (fresh) = 5 + 1 = 6.
    assert.strictEqual(d.models.claude.score, 6, 'claude recompute = TN(5)+TP(1) over surviving rounds');
    assert.strictEqual(d.models.gemini.score, 1, 'gemini recompute = TP(1) from surviving round old-b');
  } finally { rm(sb); }
});

// ===========================================================================
// ADV2-2  (REGRESSION — VALID_RESULTS enforcement must still ACCEPT every
// canonical code). Round 1 wired merge-wave to the canonical VALID_RESULTS and
// deleted a dead local Set. The guard `if (result !== '' && !VALID_RESULTS...)`
// must NOT reject a legitimate code: every one of TP/TN/FP/FN/TP+/TN+/UNAVAIL,
// the UNAVAILABLE→UNAVAIL normalization, and the empty-string Mode-A case must
// STILL persist. Only genuinely-bogus codes are skipped.
// ===========================================================================
test('ADV2-2: merge-wave still accepts every canonical result code (TP/TN/FP/FN/TP+/TN+/UNAVAIL, UNAVAILABLE→UNAVAIL, and Mode-A "")', () => {
  const sb = uniqTmp('.json');
  const dir = uniqTmp('-dir');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const task = 'codes';
    // Each canonical code on a distinct model, all in round 1.
    const mapping = {
      claude:   'TP',
      gemini:   'TN',
      opencode: 'FP',
      copilot:  'FN',
      codex:    'TP+',
      deepseek: 'TN+',
      minimax:  'UNAVAIL',
      kimi:     'UNAVAILABLE', // typo variant — must normalize to UNAVAIL and persist
    };
    let i = 0;
    for (const [model, result] of Object.entries(mapping)) {
      writeVote(dir, `vote-${model}-${task}-1-${String(i++).padStart(2, '0')}.json`,
        { model, result, verdict: 'APPROVE' });
    }
    // A genuinely-bogus code on a valid model — must be the ONLY thing skipped.
    writeVote(dir, `vote-llama4-${task}-1-zz.json`, { model: 'llama4', result: 'NONSENSE', verdict: 'APPROVE' });

    const r1 = runCLI(['merge-wave', '--dir', dir, '--task', task, '--round', '1', '--scoreboard', sb]);
    assert.strictEqual(r1.exitCode, 0, 'merge-wave must exit 0');

    const d = readJSON(sb);
    const round = d.rounds.find(r => r && r.task === task && r.round === 1);
    assert.ok(round, 'round must exist');
    const v = round.votes;
    assert.strictEqual(v.claude,   'TP',      'TP must persist');
    assert.strictEqual(v.gemini,   'TN',      'TN must persist');
    assert.strictEqual(v.opencode, 'FP',      'FP must persist');
    assert.strictEqual(v.copilot,  'FN',      'FN must persist');
    assert.strictEqual(v.codex,    'TP+',     'TP+ must persist (not rejected by the new guard)');
    assert.strictEqual(v.deepseek, 'TN+',     'TN+ must persist (not rejected by the new guard)');
    assert.strictEqual(v.minimax,  'UNAVAIL', 'UNAVAIL must persist');
    assert.strictEqual(v.kimi,     'UNAVAIL', 'UNAVAILABLE must normalize to UNAVAIL and persist');
    assert.ok(!('llama4' in v), 'only the genuinely-bogus NONSENSE code is skipped');

    // Recompute sanity: TP+ scores improvement, TN+ scores constructive — both must count.
    assert.strictEqual(d.models.codex.tp, 1, 'TP+ counts a tp');
    assert.strictEqual(d.models.codex.impr, 1, 'TP+ counts an improvement');
    assert.strictEqual(d.models.deepseek.tn, 1, 'TN+ counts a tn');
    assert.strictEqual(d.models.deepseek.impr, 1, 'TN+ counts an improvement');

    // Mode-A: an empty result still records the verdict/round for audit, no scored vote.
    const dir2 = uniqTmp('-dir2');
    fs.mkdirSync(dir2, { recursive: true });
    writeVote(dir2, `vote-claude-${task}-2-aa.json`, { model: 'claude', result: '', verdict: 'CONSENSUS' });
    const r2 = runCLI(['merge-wave', '--dir', dir2, '--task', task, '--round', '2', '--scoreboard', sb]);
    assert.strictEqual(r2.exitCode, 0, 'Mode-A merge-wave must exit 0');
    const d2 = readJSON(sb);
    const modeA = d2.rounds.find(r => r && r.task === task && r.round === 2);
    assert.ok(modeA, 'Mode-A round must be recorded for audit trail');
    assert.strictEqual(modeA.verdict, 'CONSENSUS', 'Mode-A verdict must persist');
    assert.deepStrictEqual(modeA.votes, {}, 'Mode-A round carries no scored vote');
    rm(dir2);
  } finally { rm(sb); rm(dir); }
});

// ===========================================================================
// ADV2-3  (REGRESSION — availability fail-open must NOT mark a real cooldown
// available). Round 1 made get-availability fail OPEN on a corrupt/missing
// available_at_iso. The risk: the fix is too aggressive and reports a GENUINE
// future cooldown as available. A real future window must STILL be is_available=
// false with a correct positive remaining_ms; a real past window reports
// available; and set-availability with a valid hint must round-trip.
// ===========================================================================
test('ADV2-3: a genuine future cooldown is still benched (is_available=false); a past window is available; set/get round-trips', () => {
  const sb = uniqTmp('.json');
  try {
    // (a) Genuine future + genuine past windows, written directly with valid ISO.
    writeJSON(sb, {
      models: {}, slots: {}, categories: {}, rounds: [],
      availability: {
        'future-1': { available_at_iso: '2999-01-01T00:00:00.000Z', available_at_local: 'far future', reason: 'usage limit', set_at: '2026-06-27T00:00:00.000Z' },
        'past-1':   { available_at_iso: '2000-01-01T00:00:00.000Z', available_at_local: 'far past',   reason: 'rate limit',  set_at: '2026-06-27T00:00:00.000Z' },
      },
    });
    const g = runCLI(['get-availability', '--scoreboard', sb]);
    assert.strictEqual(g.exitCode, 0, 'get-availability must not crash on valid windows');
    const out = JSON.parse(g.stdout);

    assert.strictEqual(out['future-1'].is_available, false,
      'a GENUINE far-future cooldown must remain benched — fail-open must not free it');
    assert.ok(out['future-1'].remaining_ms > 60_000,
      `a real future window must report a positive remaining_ms, got ${out['future-1'].remaining_ms}`);
    assert.ok(Number.isFinite(out['future-1'].remaining_ms), 'remaining_ms must be finite');

    assert.strictEqual(out['past-1'].is_available, true, 'a genuine past window must report available');
    assert.strictEqual(out['past-1'].remaining_ms, 0, 'a past window has 0 remaining');

    // (b) set-availability with a VALID relative hint round-trips to a real cooldown.
    const sb2 = uniqTmp('.json');
    try {
      const s = runCLI(['set-availability', '--slot', 'codex-1', '--message', 'usage limit, restart in 10 hours', '--scoreboard', sb2]);
      assert.strictEqual(s.exitCode, 0, 'set-availability with a valid hint must succeed');
      const written = readJSON(sb2).availability['codex-1'];
      assert.ok(written && Number.isFinite(new Date(written.available_at_iso).getTime()),
        'a valid hint must record a representable available_at_iso (not skipped as Invalid Date)');
      const g2 = JSON.parse(runCLI(['get-availability', '--scoreboard', sb2]).stdout);
      assert.strictEqual(g2['codex-1'].is_available, false, 'a freshly-set 10h cooldown must be benched');
      assert.ok(g2['codex-1'].remaining_ms > 8 * 3_600_000 && g2['codex-1'].remaining_ms <= 10 * 3_600_000,
        `10h cooldown remaining_ms must be ~8-10h, got ${g2['codex-1'].remaining_ms}`);
    } finally { rm(sb2); }
  } finally { rm(sb); }
});

// ===========================================================================
// ADV2-4  (NEW GAP — the round-1 normalization is asymmetric: it guards
// `rounds` with Array.isArray but guards `models`/`slots`/`categories`/
// `availability`/`delivery_stats` with only `typeof x !== 'object'`. Arrays pass
// `typeof [] === 'object'`, so a `models: []` scoreboard is NOT normalized to the
// object shape. The record path then sets array.claude = {...} (a non-index
// property), and JSON.stringify DROPS non-index props of an array — so every
// recomputed model stat is SILENTLY LOST on write. The CLI even prints the
// correct in-memory score, masking the data loss. This is the SAME defect class
// the round-1 fix targeted (wrong-shape → degrade), just missed for the object
// fields. 🔴 dropped valid data — bin/update-scoreboard.cjs:229.
// ===========================================================================
test('ADV2-4: a scoreboard whose `models` is an ARRAY must not silently drop recomputed model stats on write', () => {
  const sb = uniqTmp('.json');
  try {
    // valid JSON, wrong shape: models is [] (an array passes `typeof === "object"`).
    writeRaw(sb, '{"models":[],"slots":{},"categories":{},"rounds":[],"availability":{}}');

    const { exitCode, stdout } = runCLI([
      '--model', 'claude', '--result', 'TN', '--task', 'arrmodels', '--round', '1', '--verdict', 'APPROVE',
      '--scoreboard', sb,
    ]);
    assert.strictEqual(exitCode, 0, 'recording must not crash');
    assert.match(stdout, /score: 5/, 'the CLI computes the score in memory (TN=+5)');

    const d = readJSON(sb);
    // The round persisted, proving the write happened — but were the stats kept?
    assert.ok(d.rounds.some(r => r && r.task === 'arrmodels'), 'the round must persist');

    // The high-stakes invariant: the recomputed stat the CLI just printed must be
    // readable back from the file. On the current code models stays `[]` and
    // models.claude is undefined → the score is GONE (silent data loss).
    assert.ok(d.models && !Array.isArray(d.models),
      'models must be normalized to an object so its keyed stats survive JSON.stringify (array drops them)');
    assert.ok(d.models.claude && typeof d.models.claude === 'object',
      'claude model stats must be persisted, not dropped as a non-index array property');
    assert.strictEqual(d.models.claude.score, 5,
      'the TN(+5) the CLI reported must survive the write — otherwise the scoreboard silently loses every score');
  } finally { rm(sb); }
});

// ===========================================================================
// ADV2-5  (default record path under corrupt input + idempotency). With loadData
// now normalizing, the most-used subcommand must persist a vote even when the
// existing file carries a null round, and a re-record of the SAME (model, task,
// round) must be idempotent — overwrite-in-place, not append a duplicate round
// or double-count the score.
// ===========================================================================
test('ADV2-5: default record path tolerates a null round and re-recording the same (model,task,round) is idempotent', () => {
  const sb = uniqTmp('.json');
  try {
    writeJSON(sb, {
      models: { claude: { score: 0, tp: 0, tn: 0, fp: 0, fn: 0, impr: 0, invocations: 0 } },
      slots: {}, categories: {}, availability: {},
      rounds: [
        { date: '06-26', task: 'keep', round: 1, votes: { gemini: 'TP' }, verdict: 'APPROVE' },
        null, // corrupt
      ],
    });

    const first = runCLI(['--model', 'claude', '--result', 'TN', '--task', 'idem', '--round', '1', '--verdict', 'APPROVE', '--scoreboard', sb]);
    assert.strictEqual(first.exitCode, 0, 'first record must succeed despite the null round');

    let d = readJSON(sb);
    assert.ok(d.rounds.some(r => r && r.task === 'keep'), 'prior valid round must survive');
    assert.strictEqual(d.rounds.filter(r => r && r.task === 'idem' && r.round === 1).length, 1, 'exactly one idem round');
    assert.strictEqual(d.models.claude.score, 5, 'claude TN scores +5');
    assert.strictEqual(d.models.claude.invocations, 1, 'one invocation');

    // Re-record the SAME (model, task, round) — must overwrite in place, no duplicate, no double-count.
    const second = runCLI(['--model', 'claude', '--result', 'TN', '--task', 'idem', '--round', '1', '--verdict', 'APPROVE', '--scoreboard', sb]);
    assert.strictEqual(second.exitCode, 0, 'idempotent re-record must succeed');

    d = readJSON(sb);
    assert.strictEqual(d.rounds.filter(r => r && r.task === 'idem' && r.round === 1).length, 1,
      're-recording must NOT append a duplicate round');
    assert.strictEqual(d.models.claude.score, 5, 'score must stay 5 — recompute is idempotent, not additive');
    assert.strictEqual(d.models.claude.invocations, 1, 'invocations must stay 1, not double-count');
  } finally { rm(sb); }
});

// ===========================================================================
// ADV2-6  (recompute robustness — a round whose `votes` is a NON-object). loadData
// drops non-object ROUNDS but does not sanitise a non-object `votes` inside an
// otherwise-valid round. recomputeStats/recomputeSlots/computeDeliveryStats/
// computeFlakiness must tolerate `votes` being a string or number without throwing
// or emitting NaN when a fresh vote is recorded alongside.
// ===========================================================================
test('ADV2-6: a round whose `votes` is a string/number must not crash recompute or produce NaN scores', () => {
  const sb = uniqTmp('.json');
  try {
    writeJSON(sb, {
      models: { claude: { score: 0, tp: 0, tn: 0, fp: 0, fn: 0, impr: 0, invocations: 0 } },
      slots: {}, categories: {}, availability: {},
      rounds: [
        { date: '06-26', task: 'weird-str', round: 1, votes: 'abc' },   // votes is a string
        { date: '06-26', task: 'weird-num', round: 2, votes: 42 },      // votes is a number
      ],
    });

    const { exitCode, stderr } = runCLI([
      '--model', 'claude', '--result', 'TP', '--task', 'sane', '--round', '3', '--verdict', 'APPROVE',
      '--scoreboard', sb,
    ]);
    assert.strictEqual(exitCode, 0, `recompute must not crash on non-object votes; stderr: ${stderr}`);

    const d = readJSON(sb);
    // Every model stat must be a finite number — never NaN (which JSON-serialises as null).
    for (const [name, m] of Object.entries(d.models)) {
      for (const field of ['score', 'tp', 'tn', 'fp', 'fn', 'impr', 'invocations']) {
        assert.ok(typeof m[field] === 'number' && Number.isFinite(m[field]),
          `models.${name}.${field} must be a finite number, got ${JSON.stringify(m[field])}`);
      }
    }
    assert.strictEqual(d.models.claude.score, 1, 'the sane TP vote still scores +1 (weird rounds contribute nothing)');
    // delivery_stats must be present and numeric (computeDeliveryStats survived the weird votes).
    assert.ok(d.delivery_stats && Number.isFinite(d.delivery_stats.total_rounds),
      'delivery_stats.total_rounds must be finite after weird-votes rounds');
  } finally { rm(sb); }
});

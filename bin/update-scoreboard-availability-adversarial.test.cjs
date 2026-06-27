#!/usr/bin/env node
'use strict';
// Adversarial test suite for bin/update-scoreboard.cjs
//   Focus: AVAILABILITY / COOLDOWN windows, MERGE-WAVE atomicity, and init-team.
//   Vote recording / recompute math is covered by a sibling suite — NOT duplicated here.
//
// Run: node --test bin/update-scoreboard-availability-adversarial.test.cjs
//
// Each test drives the CLI as a subprocess (so process.exit() can't contaminate the
// runner) against a throwaway --scoreboard / --dir under os.tmpdir(). No real
// ~/.claude, no .planning, no real scoreboard is ever touched. All cooldown
// windows use far-past / far-future instants so wall-clock jitter can't flip an
// assertion.

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
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
    signal: result.signal,
  };
}

function uniqTmp(suffix) {
  return path.join(
    os.tmpdir(),
    `nf-sb-avail-adv-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`
  );
}

function writeScoreboard(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function readScoreboard(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function baseScoreboard(extra) {
  return Object.assign(
    {
      models: {},
      slots: {},
      categories: {},
      rounds: [],
      availability: {},
    },
    extra || {}
  );
}

function rm(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

// ---------------------------------------------------------------------------
// AVAIL-ADV-1  (GAP probe — high-stakes "stuck in cooldown forever")
//
// A corrupt availability entry whose available_at_iso is unparseable (here:
// the key is entirely MISSING; an equivalent failure occurs with a garbage
// string). get-availability does:
//     available_at_ms = new Date(avail.available_at_iso).getTime()  // NaN
//     is_available    = available_at_ms <= now                      // NaN<=now => false
//     remaining_ms    = Math.max(0, available_at_ms - now)          // NaN
// A NaN comparison is ALWAYS false, so the slot is reported is_available=false
// and is silently EXCLUDED from the quorum *forever* — and remaining_ms/display
// are NaN. A corrupt entry must FAIL-OPEN to available (the slot degrades to
// usable), not be permanently benched.
// ---------------------------------------------------------------------------
test('AVAIL-ADV-1: corrupt availability entry (unparseable date) must fail-open to available, not stick in cooldown forever', () => {
  const sb = uniqTmp('.json');
  try {
    writeScoreboard(sb, baseScoreboard({
      availability: {
        // available_at_iso intentionally absent -> new Date(undefined) -> NaN
        'codex-1': { available_at_local: 'corrupt', reason: 'usage limit', set_at: new Date().toISOString() },
        // a second entry with an outright garbage date string
        'gemini-1': { available_at_iso: 'not-a-real-date', available_at_local: 'corrupt', reason: 'rate limit', set_at: new Date().toISOString() },
      },
    }));

    const { stdout, exitCode } = runCLI(['get-availability', '--scoreboard', sb]);
    assert.strictEqual(exitCode, 0, 'get-availability must not crash on a corrupt entry');

    const out = JSON.parse(stdout);

    for (const key of ['codex-1', 'gemini-1']) {
      const entry = out[key];
      assert.ok(entry, `${key} must appear in output`);
      // remaining_ms must be a finite number, never NaN (JSON-serialised as null)
      assert.ok(
        typeof entry.remaining_ms === 'number' && Number.isFinite(entry.remaining_ms),
        `${key}.remaining_ms must be a finite number, got ${JSON.stringify(entry.remaining_ms)}`
      );
      assert.ok(
        !String(entry.remaining_display).includes('NaN'),
        `${key}.remaining_display must not contain NaN, got "${entry.remaining_display}"`
      );
      // The high-stakes invariant: a corrupt window must NOT permanently exclude
      // the slot. Fail-open => is_available === true.
      assert.strictEqual(
        entry.is_available, true,
        `${key} with a corrupt available_at_iso must fail-open to available (is_available=true), ` +
        `otherwise the slot is silently EXCLUDED from the quorum forever`
      );
    }
  } finally {
    rm(sb);
  }
});

// ---------------------------------------------------------------------------
// AVAIL-ADV-2  (GAP probe — merge-wave loses valid data on a wrong-shape file)
//
// A vote file that is valid JSON but the WRONG SHAPE: the literal `null`.
// JSON.parse("null") succeeds (so the parse-guard at the read step passes it
// through), then the apply loop does `vote.result` on null -> TypeError ->
// the whole mergeWave() rejects -> main() FATAL exit 1 *before* the single
// atomic write. Every valid sibling vote in the same wave is therefore LOST
// (never persisted). One bad file must not abort the whole transaction.
// ---------------------------------------------------------------------------
test('AVAIL-ADV-2: merge-wave with a wrong-shape (null) vote file must not abort the wave / lose the valid sibling vote', () => {
  const sb = uniqTmp('.json');
  const dir = uniqTmp('-dir');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const task = 'qtask';
    const round = 1;
    // valid vote (model mode)
    fs.writeFileSync(
      path.join(dir, `vote-claude-${task}-${round}-aaa.json`),
      JSON.stringify({ model: 'claude', result: 'TP', verdict: 'APPROVE' }),
      'utf8'
    );
    // wrong-shape but parseable: literal null
    fs.writeFileSync(
      path.join(dir, `vote-znull-${task}-${round}-bbb.json`),
      'null',
      'utf8'
    );

    const { exitCode } = runCLI([
      'merge-wave', '--dir', dir, '--task', task, '--round', String(round), '--scoreboard', sb,
    ]);

    assert.strictEqual(exitCode, 0, 'merge-wave must exit 0 — a single wrong-shape file must not crash the wave');
    assert.ok(fs.existsSync(sb), 'scoreboard must have been written (valid vote must persist)');

    const data = readScoreboard(sb);
    const round1 = (data.rounds || []).find(r => r.task === task && r.round === round);
    assert.ok(round1, 'the valid vote must produce a round entry');
    assert.strictEqual(
      round1.votes.claude, 'TP',
      'the valid claude TP vote must NOT be lost because a sibling file was wrong-shape'
    );
  } finally {
    rm(sb);
    rm(dir);
  }
});

// ---------------------------------------------------------------------------
// AVAIL-ADV-3  (GAP probe — set-availability crashes on an absurd duration)
//
// An error message hinting an absurdly large cooldown ("retry in
// 99999999999 hours") makes available_at = new Date(now + huge) = Invalid
// Date. setAvailability then calls hint.available_at.toISOString() which
// THROWS RangeError("Invalid time value") -> FATAL exit 1. A nonsense
// duration must be handled gracefully (clamped or skipped), never crash the
// availability writer (which would also leave the cooldown unrecorded).
// ---------------------------------------------------------------------------
test('AVAIL-ADV-3: set-availability with an absurdly-large duration must not crash on Invalid Date', () => {
  const sb = uniqTmp('.json');
  try {
    const { exitCode, stderr } = runCLI([
      'set-availability',
      '--slot', 'codex-1',
      '--message', 'rate limit exceeded, retry in 99999999999 hours',
      '--scoreboard', sb,
    ]);

    // Require genuine success (exit 0), not merely "not 1" — `notStrictEqual(1)` would
    // also pass on a timeout or a signal kill (exitCode null). The fix makes
    // set-availability return gracefully (exit 0) and simply not record the bad window.
    assert.strictEqual(
      exitCode, 0,
      `set-availability must exit 0 (graceful) on an absurd duration, not FATAL-crash; stderr was: ${stderr}`
    );
    assert.ok(
      !/Invalid time value/.test(stderr),
      `must not throw "Invalid time value"; stderr was: ${stderr}`
    );

    // If it did write an entry, get-availability must read it back without NaN.
    if (fs.existsSync(sb)) {
      const { stdout, exitCode: gx } = runCLI(['get-availability', '--scoreboard', sb]);
      assert.strictEqual(gx, 0, 'get-availability must read the entry back without crashing');
      const out = JSON.parse(stdout);
      const e = out['codex-1'];
      if (e) {
        assert.ok(
          typeof e.remaining_ms === 'number' && Number.isFinite(e.remaining_ms),
          `codex-1.remaining_ms must be finite, got ${JSON.stringify(e.remaining_ms)}`
        );
      }
    }
  } finally {
    rm(sb);
  }
});

// ---------------------------------------------------------------------------
// AVAIL-ADV-4  (robustness invariant — parse-error path IS guarded)
//
// A truncated / non-JSON wave file alongside a valid one. The read step's
// try/catch skips the unparseable file with a WARNING and applies the valid
// one. (Contrast with AVAIL-ADV-2: this guards the *parse*, that one the
// *shape*.)
// ---------------------------------------------------------------------------
test('AVAIL-ADV-4: merge-wave skips a truncated/unparseable file and still applies the valid vote', () => {
  const sb = uniqTmp('.json');
  const dir = uniqTmp('-dir');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const task = 'rtask';
    const round = 2;
    fs.writeFileSync(
      path.join(dir, `vote-gemini-${task}-${round}-aaa.json`),
      JSON.stringify({ model: 'gemini', result: 'TN', verdict: 'APPROVE' }),
      'utf8'
    );
    // truncated JSON
    fs.writeFileSync(
      path.join(dir, `vote-trunc-${task}-${round}-bbb.json`),
      '{ "model": "claude", "result": "TP"',
      'utf8'
    );

    const { exitCode } = runCLI([
      'merge-wave', '--dir', dir, '--task', task, '--round', String(round), '--scoreboard', sb,
    ]);

    assert.strictEqual(exitCode, 0, 'merge-wave must exit 0 with a truncated file present');
    const data = readScoreboard(sb);
    const r = (data.rounds || []).find(x => x.task === task && x.round === round);
    assert.ok(r, 'valid vote must produce a round entry');
    assert.strictEqual(r.votes.gemini, 'TN', 'valid gemini vote must be applied');
    assert.ok(!('claude' in r.votes), 'truncated claude vote must be skipped, not partially applied');
  } finally {
    rm(sb);
    rm(dir);
  }
});

// ---------------------------------------------------------------------------
// AVAIL-ADV-5  (cross-subcommand invariant — recording a vote must not clobber
// a live cooldown window, and vice-versa)
// ---------------------------------------------------------------------------
test('AVAIL-ADV-5: recording a normal round vote preserves an existing availability window (no clobber)', () => {
  const sb = uniqTmp('.json');
  try {
    // 1) establish a far-future cooldown window for codex-1
    const set = runCLI([
      'set-availability', '--slot', 'codex-1',
      '--message', 'usage limit, restart in 10 hours', '--scoreboard', sb,
    ]);
    assert.strictEqual(set.exitCode, 0, 'set-availability must succeed');
    const beforeIso = readScoreboard(sb).availability['codex-1'].available_at_iso;
    assert.ok(beforeIso, 'availability window must be written');

    // 2) record an unrelated normal model vote
    const rec = runCLI([
      '--model', 'claude', '--result', 'TP',
      '--task', 'unrelated', '--round', '1', '--verdict', 'APPROVE',
      '--scoreboard', sb,
    ]);
    assert.strictEqual(rec.exitCode, 0, 'recording a vote must succeed');

    // 3) the cooldown window must survive untouched
    const after = readScoreboard(sb);
    assert.ok(after.availability && after.availability['codex-1'], 'codex-1 cooldown must NOT be wiped by a vote');
    assert.strictEqual(
      after.availability['codex-1'].available_at_iso, beforeIso,
      'cooldown available_at_iso must be byte-identical after recording an unrelated vote'
    );

    // and get-availability still reports it as on cooldown (far future)
    const get = runCLI(['get-availability', '--scoreboard', sb]);
    const out = JSON.parse(get.stdout);
    assert.strictEqual(out['codex-1'].is_available, false, 'a 10h cooldown must still be in effect');
    assert.ok(out['codex-1'].remaining_ms > 60_000, 'remaining_ms must reflect a multi-hour window');
  } finally {
    rm(sb);
  }
});

// ---------------------------------------------------------------------------
// AVAIL-ADV-6  (init-team invariant — malformed --team must not corrupt rounds
// and must be idempotent)
// ---------------------------------------------------------------------------
test('AVAIL-ADV-6: init-team with malformed --team JSON preserves existing rounds and is idempotent', () => {
  const sb = uniqTmp('.json');
  const fakeClaudeJson = uniqTmp('-claude.json');
  try {
    // a fake ~/.claude.json so the real one is never read
    fs.writeFileSync(fakeClaudeJson, JSON.stringify({ mcpServers: {}, plugins: [] }), 'utf8');
    // an existing scoreboard with a real round of data
    writeScoreboard(sb, baseScoreboard({
      rounds: [{ date: '06-27', task: 'pre-existing', round: 1, votes: { claude: 'TP' }, verdict: 'APPROVE' }],
    }));

    const env = { NF_CLAUDE_JSON: fakeClaudeJson, CLAUDE_MODEL: 'claude-opus-test' };

    const r1 = runCLI(['init-team', '--team', '{ this is : not json }', '--scoreboard', sb], env);
    assert.strictEqual(r1.exitCode, 0, 'init-team must not crash on malformed --team JSON');

    const d1 = readScoreboard(sb);
    assert.strictEqual(d1.rounds.length, 1, 'existing rounds must be preserved');
    assert.strictEqual(d1.rounds[0].task, 'pre-existing', 'existing round content must be intact');
    assert.ok(d1.team && typeof d1.team.fingerprint === 'string' && d1.team.fingerprint.length > 0,
      'a team fingerprint must still be written');

    // idempotent: same inputs => "no change", fingerprint stable, rounds intact
    const r2 = runCLI(['init-team', '--team', '{ this is : not json }', '--scoreboard', sb], env);
    assert.strictEqual(r2.exitCode, 0, 'second init-team must succeed');
    assert.ok(/no change/.test(r2.stdout), `second run must report "no change", got: ${r2.stdout}`);

    const d2 = readScoreboard(sb);
    assert.strictEqual(d2.team.fingerprint, d1.team.fingerprint, 'fingerprint must be stable across identical runs');
    assert.strictEqual(d2.rounds.length, 1, 'rounds must remain intact after a second init-team');
  } finally {
    rm(sb);
    rm(fakeClaudeJson);
  }
});

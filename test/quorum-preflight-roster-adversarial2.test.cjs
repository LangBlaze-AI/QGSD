#!/usr/bin/env node
'use strict';

/**
 * quorum-preflight-roster-adversarial2.test.cjs  (ROUND 2)
 *
 * Round 1 (quorum-preflight-roster-adversarial.test.cjs) found & locked 3 corrupt-config
 * gaps in bin/quorum-preflight.cjs:
 *   (a) findProviders() now filters null / non-object / nameless provider entries;
 *   (b) readConfig() coerces quorum_active to an array of non-empty strings;
 *   (c) readConfig() coerces max_quorum_size to a positive integer (default 3).
 *
 * Round 2 hunts for DIFFERENT real gaps and — critically — for a REGRESSION in those
 * three fixes (a coercion that now drops a LEGITIMATE value), plus extends fail-open
 * coverage to the paths Round 1 did NOT exercise:
 *   - `--all` / `--all --no-probe`  (the path nf-prompt.js DISP-01 and quorum.md call)
 *   - `--ensure-services`           (service auto-start mode)
 * Round 1 only proved fail-open on `--team` / `--quorum-active` / `--max-quorum-size`.
 *
 * Hermetic harness — identical isolation contract to Round 1 (it MUST isolate cwd or
 * the repo's own .claude/nf.json wins via project-precedence):
 *   - HOME → temp dir  →  global ~/.claude/nf.json layer
 *   - cwd  → temp dir  →  project .claude/nf.json layer (PROJECT WINS)
 *   - UNIFIED_PROVIDERS_CONFIG → temp providers.json (step-1 resolver override)
 *   - NF_CLAUDE_JSON unset so the real ~/.claude.json is never consulted
 * No source is edited; nothing touches the real ~/.claude or .planning.
 *
 * Run: node --test test/quorum-preflight-roster-adversarial2.test.cjs
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SCRIPT = path.join(__dirname, '..', 'bin', 'quorum-preflight.cjs');

const tmpDirs = [];
function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

function asFile(content) {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/**
 * Build an isolated global(HOME)+project(cwd)+providers sandbox and run the CLI.
 * (Byte-for-byte the Round-1 harness — same isolation guarantees.)
 */
function runCli(args, { globalCfg, projCfg, providers } = {}) {
  const home = mkTmp('nf-roster2-home-');
  const proj = mkTmp('nf-roster2-proj-');

  if (globalCfg !== undefined) {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'nf.json'), asFile(globalCfg));
  }
  if (projCfg !== undefined) {
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.claude', 'nf.json'), asFile(projCfg));
  }

  const env = { ...process.env, HOME: home };
  delete env.NF_CLAUDE_JSON; // never consult the real ~/.claude.json
  if (providers !== undefined) {
    const pPath = path.join(home, 'providers.json');
    fs.writeFileSync(pPath, asFile(providers));
    env.UNIFIED_PROVIDERS_CONFIG = pPath;
  } else {
    delete env.UNIFIED_PROVIDERS_CONFIG;
  }

  return spawnSync('node', [SCRIPT, ...args], { cwd: proj, env, encoding: 'utf8' });
}

describe('quorum-preflight roster selection — adversarial round 2 (regression + new paths)', () => {

  // ── 1. 🔴 REGRESSION (critical): the string-filter must NOT drop a VALID roster ─
  // Round-1 fix (b) rewrote quorum_active through `.filter(s => typeof s === 'string'
  // && s.length > 0)`. A too-aggressive filter (or a precedence bug introduced
  // alongside it) would silently drop legitimate slot names → a degraded quorum that
  // looks "configured" but dispatches fewer models. Pin that a fully-valid array of
  // real slot names round-trips UNCHANGED through both --quorum-active and --team,
  // AND that project-over-global precedence still resolves to the winning layer.
  it('a VALID quorum_active survives the coercion unchanged (no dropped slot) and precedence holds', () => {
    const providers = {
      providers: [
        { name: 'codex-1',  model: 'gpt',    mainTool: 'codex' },
        { name: 'gemini-1', model: 'gem',    mainTool: 'gemini' },
        { name: 'claude-1', model: 'claude', mainTool: 'claude' },
      ],
    };
    // global corrupt (non-array) is overridden by a VALID project array → project wins,
    // and the valid array must pass the string-filter intact.
    const res = runCli(['--quorum-active'], {
      globalCfg: { quorum_active: 'codex-1' },                 // corrupt global
      projCfg:   { quorum_active: ['codex-1', 'gemini-1'] },   // VALID project (winner)
      providers,
    });
    assert.equal(res.status, 0, `exit 0 expected; stderr: ${res.stderr}`);
    assert.deepEqual(JSON.parse(res.stdout), ['codex-1', 'gemini-1'],
      'the string-filter must not drop a legitimate slot — exactly the project array survives');

    // And --team must select EXACTLY those two (allowlist applied, no over/under-selection).
    const team = runCli(['--team'], {
      projCfg: { quorum_active: ['codex-1', 'gemini-1'] },
      providers,
    });
    assert.equal(team.status, 0, `--team exit 0; stderr: ${team.stderr}`);
    assert.deepEqual(Object.keys(JSON.parse(team.stdout)).sort(), ['codex-1', 'gemini-1'],
      'a valid quorum_active must select exactly its slots — claude-1 excluded, the two kept');
  });

  // ── 2. 🔴 REGRESSION (critical): the integer-floor must NOT bump a VALID small cap ─
  // Round-1 fix (c) defaults to 3 on invalid input. A floor implemented as
  // `Math.max(3, n)` (instead of `>= 1 ? n : 3`) would silently raise a deliberate
  // cap of 1 or 2 up to 3 — over-dispatching slots the user capped. Also pin the
  // numeric-string acceptance: "2" must coerce to 2 (Number("2")===2), while a
  // non-numeric "2x" must fall back to the default 3, not leak NaN/"2x".
  it('a VALID small max_quorum_size (1, 2, "2") passes through; only junk falls back to 3', () => {
    const cases = [
      [1,    '1'],   // explicit small cap must NOT be floored up to 3
      [2,    '2'],
      ['2',  '2'],   // numeric string coerces cleanly
      ['2x', '3'],   // non-numeric → default
      [0,    '3'],   // non-positive → default
    ];
    for (const [input, expected] of cases) {
      const res = runCli(['--max-quorum-size'], { projCfg: { max_quorum_size: input } });
      assert.equal(res.status, 0, `exit 0 expected for ${JSON.stringify(input)}; stderr: ${res.stderr}`);
      const out = res.stdout.trim();
      assert.match(out, /^\d+$/, `must emit a bare integer for ${JSON.stringify(input)}, got "${out}"`);
      assert.equal(out, expected,
        `max_quorum_size=${JSON.stringify(input)} must emit ${expected} (a small valid cap must not be floored up)`);
    }
  });

  // ── 3. 🔴 REGRESSION (critical): the null-filter must KEEP every valid provider ──
  // Round-1 fix (a) filters provider entries through `p && typeof p === 'object' &&
  // p.name`. An over-broad predicate would drop legitimate providers. Confirm a
  // providers.json of ALL-valid entries keeps ALL of them, and that the allowlist
  // selects the named subset without losing any valid entry.
  it('an all-valid providers.json keeps every provider (null-filter drops none)', () => {
    const providers = {
      providers: [
        { name: 'codex-1',  model: 'gpt',    mainTool: 'codex' },
        { name: 'gemini-1', model: 'gem',    mainTool: 'gemini' },
        { name: 'claude-1', model: 'claude', mainTool: 'claude' },
        { name: 'copilot-1', model: 'gpt-4', mainTool: 'copilot' },
      ],
    };
    // empty quorum_active = "all" → all 4 must appear (filter must not silently drop a valid one)
    const all = runCli(['--all', '--no-probe'], { projCfg: { quorum_active: [] }, providers });
    assert.equal(all.status, 0, `exit 0 expected; stderr: ${all.stderr}`);
    assert.deepEqual(Object.keys(JSON.parse(all.stdout).team).sort(),
      ['claude-1', 'codex-1', 'copilot-1', 'gemini-1'],
      'all four valid providers must survive the null-filter');

    // named subset of 3 → exactly those 3 (no valid entry lost to the filter)
    const team = runCli(['--team'], {
      projCfg: { quorum_active: ['codex-1', 'gemini-1', 'copilot-1'] },
      providers,
    });
    assert.equal(team.status, 0, `--team exit 0; stderr: ${team.stderr}`);
    assert.deepEqual(Object.keys(JSON.parse(team.stdout)).sort(),
      ['codex-1', 'copilot-1', 'gemini-1'],
      'every named valid provider must be kept by the filter');
  });

  // ── 4. NEW PATH — `--all` (probe + --no-probe) must ALSO fail-open on corrupt config ─
  // Round 1 proved fail-open on --team/--quorum-active only. But nf-prompt.js (DISP-01)
  // and quorum.md/solve-diagnose.md call `--all`, which ADDITIONALLY runs buildTeam,
  // probeHealth, the type-sort, and dedupBySlotIdentity over the active providers — any
  // of which could deref a corrupt entry. Throw ALL THREE round-1 corruptions at once
  // (null provider entry + non-array quorum_active + invalid max_quorum_size) and require
  // a usable JSON roster + exit 0 on BOTH the probe and no-probe forms.
  it('`--all --no-probe` fails open on a null entry + non-array quorum_active + invalid cap', () => {
    const res = runCli(['--all', '--no-probe'], {
      projCfg:   { quorum_active: 'codex-1', max_quorum_size: 0 }, // both corrupt
      providers: { providers: [null, { name: 'codex-1', model: 'gpt', mainTool: 'codex' }] },
    });
    assert.equal(res.status, 0, `--all --no-probe must fail-open, not crash; stderr: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.ok(Array.isArray(out.quorum_active), 'quorum_active must be a JSON array');
    assert.ok(Number.isInteger(out.max_quorum_size) && out.max_quorum_size >= 1,
      `max_quorum_size must be a positive integer, got ${out.max_quorum_size}`);
    assert.equal(typeof out.team, 'object', 'team must be an object');
    assert.ok(out.team['codex-1'], 'the healthy slot must survive the corrupt null sibling');
  });

  it('`--all` (probe ON) fails open on the same corruption — emits available/unavailable slot lists', () => {
    // mainTool points at a binary that does not exist → Layer-1 ENOENT resolves fast
    // (no network, no real binary spawned), so the probe path stays hermetic & quick.
    const res = runCli(['--all'], {
      projCfg:   { quorum_active: 'codex-1', max_quorum_size: -5 },
      providers: { providers: [null, { name: 'codex-1', model: 'gpt', mainTool: 'nf-nonexistent-binary-xyz' }] },
    });
    assert.equal(res.status, 0, `--all (probe) must fail-open, not crash; stderr: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.ok(Array.isArray(out.available_slots), 'probe output must include an available_slots array');
    assert.ok(Array.isArray(out.unavailable_slots), 'probe output must include an unavailable_slots array');
    assert.ok(Number.isInteger(out.max_quorum_size) && out.max_quorum_size >= 1,
      'cap must still normalize to a positive integer on the probe path');
    // The lone CLI slot has no real binary → it must land in unavailable_slots, never crash.
    const accounted = out.available_slots.concat(out.unavailable_slots.map(s => s.name));
    assert.ok(accounted.includes('codex-1'),
      'the surviving slot must be accounted for in exactly one tier, not lost to a crash');
  });

  // ── 5. NEW PATH — `--ensure-services` must fail-open on corrupt config (no crash) ──
  // The service-auto-start mode filters active providers and iterates p.service. Round 1
  // never touched it. A null provider entry (now filtered) + non-array quorum_active must
  // not crash it — it must reach its terminal "OK" and exit 0.
  it('`--ensure-services` fails open on a null provider entry + non-array quorum_active', () => {
    const res = runCli(['--ensure-services'], {
      projCfg:   { quorum_active: 'codex-1' },
      // entries carry NO `service` block → ensureServices is a guarded no-op (hermetic: nothing is spawned)
      providers: { providers: [null, { name: 'codex-1', model: 'gpt', mainTool: 'codex' }] },
    });
    assert.equal(res.status, 0, `--ensure-services must fail-open, not crash; stderr: ${res.stderr}`);
    assert.match(res.stdout, /OK/, '--ensure-services must reach its terminal OK on corrupt config');
  });

  // ── 6. DEEPER SHAPES — duplicates / mixed-case / whitespace / missing model ───────
  // Probe the matching/dedup semantics the round-1 normalization does NOT touch:
  //   - duplicate slot names in quorum_active must collapse to a single team entry
  //     (team is keyed by name) — never crash, never double an object key;
  //   - case/whitespace variants are matched EXACTLY (canonical names only) and must
  //     not corrupt the team or crash the build;
  //   - a provider object missing `model`/`display_provider` must not crash buildTeam
  //     or dedupBySlotIdentity (the "model|provider" key becomes "|", which dedup skips).
  it('duplicate / mixed-case / whitespace names + a model-less provider never crash and match sanely', () => {
    const providers = {
      providers: [
        { name: 'codex-1', model: 'gpt', mainTool: 'codex' }, // exact canonical name
        { name: 'modelless-1', mainTool: 'x' },               // missing model & display_provider
      ],
    };
    const res = runCli(['--team'], {
      // 'codex-1' duped; 'Codex-1' wrong case; '  codex-1  ' padded; 'modelless-1' real.
      projCfg: { quorum_active: ['codex-1', 'codex-1', 'Codex-1', '  codex-1  ', 'modelless-1'] },
      providers,
    });
    assert.equal(res.status, 0, `must not crash on dup/case/whitespace/model-less; stderr: ${res.stderr}`);
    const team = JSON.parse(res.stdout);
    // Exact matches only: the canonical 'codex-1' (deduped to one key) and 'modelless-1'.
    // The mis-cased / padded variants do NOT match a provider, so they neither add nor
    // corrupt entries — fail-open by exact-name matching.
    assert.deepEqual(Object.keys(team).sort(), ['codex-1', 'modelless-1'],
      'duplicate names collapse to one entry; case/whitespace variants match nothing; no crash');
    assert.ok(!('model' in team['modelless-1']) || team['modelless-1'].model === undefined,
      'a model-less provider builds without inventing a model and without crashing dedup');
  });
});

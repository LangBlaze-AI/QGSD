#!/usr/bin/env node
'use strict';

/**
 * quorum-preflight-roster-adversarial.test.cjs
 *
 * ADVERSARIAL roster-selection tests for bin/quorum-preflight.cjs — the logic that
 * decides WHICH slots are eligible to dispatch. A bug here = wrong quorum roster:
 * a healthy slot silently EXCLUDED (degraded/blocked quorum) or a stale/corrupt
 * value INCLUDED. This file targets the known `quorum_active`-drift bug class.
 *
 * Root structural risk under test: bin/quorum-preflight.cjs::readConfig() (~L77)
 * does a raw `Object.assign` merge and does NOT run config-loader.js::validateConfig().
 * validateConfig() exists *specifically* to coerce a non-array quorum_active to []
 * and to floor an invalid quorum size — preflight bypasses all of it. Likewise
 * buildTeam() (~L96) dereferences `p.name` with no null-guard. These are the exact
 * two-code-path divergences that produced the historical config-drift bugs.
 *
 * Hermetic harness (mirrors test/quorum-preflight-maintool-healthy.test.cjs):
 *   - HOME → temp dir  →  global ~/.claude/nf.json layer
 *   - cwd  → temp dir  →  project .claude/nf.json layer (PROJECT WINS)
 *   - UNIFIED_PROVIDERS_CONFIG → temp providers.json (step-1 resolver override)
 *   - NF_CLAUDE_JSON unset so the real ~/.claude.json is never consulted
 * No source is edited; nothing touches the real ~/.claude or .planning.
 *
 * Run: node --test test/quorum-preflight-roster-adversarial.test.cjs
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
 * @param {string[]} args            CLI args, e.g. ['--quorum-active']
 * @param {object}   opts
 * @param {*}        opts.globalCfg  contents for ~/.claude/nf.json (string or obj)
 * @param {*}        opts.projCfg    contents for <cwd>/.claude/nf.json (string or obj)
 * @param {*}        opts.providers  contents for providers.json (string or obj)
 */
function runCli(args, { globalCfg, projCfg, providers } = {}) {
  const home = mkTmp('nf-roster-home-');
  const proj = mkTmp('nf-roster-proj-');

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

describe('quorum-preflight roster selection — adversarial', () => {
  // ── 1. PRECEDENCE GUARD: project quorum_active overrides global ───────────
  // Documented invariant (config-loader.js L176-177): shallow merge, project
  // replaces global. The whole drift-bug class is rooted in this precedence, so
  // pin it. Regression here = wrong roster sourced from the stale global layer.
  it('project quorum_active OVERRIDES global quorum_active', () => {
    const res = runCli(['--quorum-active'], {
      globalCfg: { quorum_active: ['gemini-1', 'claude-1'] },
      projCfg:   { quorum_active: ['codex-1'] },
    });
    assert.equal(res.status, 0, `exit 0 expected; stderr: ${res.stderr}`);
    const roster = JSON.parse(res.stdout);
    assert.deepEqual(roster, ['codex-1'],
      'project layer must win — global roster must not leak through');
  });

  // ── 2. 🔴 CORRUPT-ROSTER GAP: non-array quorum_active is emitted verbatim ──
  // readConfig() never runs validateConfig(), which would coerce a non-array
  // quorum_active to []. A hand-edited `"quorum_active": "codex-1"` (string
  // instead of array) is echoed raw, so `--quorum-active` emits a JSON STRING,
  // not an array. Any consumer doing array iteration / `jq '.[]'` over the
  // roster breaks, and buildTeam's String.prototype.includes does substring
  // matching → wrong slots selected. The roster contract is "JSON array".
  it('non-array (string) quorum_active must not emit a corrupt non-array roster', () => {
    const res = runCli(['--quorum-active'], {
      projCfg: { quorum_active: 'codex-1' }, // malformed: string, not array
    });
    assert.equal(res.status, 0, `must not crash; stderr: ${res.stderr}`);
    const roster = JSON.parse(res.stdout);
    assert.ok(Array.isArray(roster),
      `--quorum-active must always emit a JSON array; got ${JSON.stringify(roster)} (${typeof roster})`);
    // Every roster element must be a slot-name string (no nulls/numbers leaking through).
    assert.ok(roster.every(s => typeof s === 'string'),
      `roster entries must all be strings; got ${JSON.stringify(roster)}`);
  });

  // ── 3. 🔴 FAIL-OPEN GAP: a null entry in providers.json crashes roster build ─
  // buildTeam() (L96) dereferences `p.name` with no null-guard. A corrupt
  // providers.json with a null entry makes `--team` (and `--all`) throw
  // "Cannot read properties of null (reading 'name')" → main().catch → exit 1
  // with an empty stdout. A crash here blocks the ENTIRE quorum from forming.
  // Expected: degrade past the bad entry, return a sane roster, exit 0.
  it('a null entry in providers.json must NOT crash roster build (--team)', () => {
    const res = runCli(['--team'], {
      providers: { providers: [null, { name: 'codex-1', model: 'gpt', mainTool: 'codex' }] },
    });
    assert.equal(res.status, 0,
      `--team must fail-open on a null provider entry, not crash; ` +
      `status=${res.status} stderr=${res.stderr}`);
    assert.ok(res.stdout.trim().length > 0, '--team must still emit JSON, not empty stdout');
    const team = JSON.parse(res.stdout);
    assert.equal(typeof team, 'object');
    assert.ok(team['codex-1'], 'the healthy slot must survive the corrupt sibling entry');
  });

  // ── 4. FAIL-OPEN GUARD: empty quorum_active = ALL configured slots ────────
  // Documented (config-loader L174): [] means "all discovered slots participate".
  // Regression = empty allowlist collapsing to ZERO slots (blocked quorum).
  it('empty quorum_active includes ALL configured providers, not zero', () => {
    const providers = {
      providers: [
        { name: 'codex-1',  model: 'gpt',    mainTool: 'codex' },
        { name: 'gemini-1', model: 'gem',    mainTool: 'gemini' },
        { name: 'claude-1', model: 'claude', mainTool: 'claude' },
      ],
    };
    const res = runCli(['--all', '--no-probe'], {
      projCfg: { quorum_active: [] },
      providers,
    });
    assert.equal(res.status, 0, `exit 0 expected; stderr: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.deepEqual(
      Object.keys(out.team).sort(),
      ['claude-1', 'codex-1', 'gemini-1'],
      'empty quorum_active must fail-open to the full configured fleet',
    );
  });

  // ── 5. 🔴 INVALID-CAP GAP: max_quorum_size is emitted with no validation ───
  // `--max-quorum-size` does `String(cfg.max_quorum_size ?? 3)` with NO floor or
  // integer coercion (config-loader floors quorum.maxSize at 1 — preflight's flat
  // key has no equivalent). So 0/-2 → a roster cap that silently EXCLUDES every
  // healthy slot; 1.5/"abc" → non-integer stdout that breaks quorum.md's shell
  // integer comparison (the same contract issue #196 locked in for the ANSI case).
  // The cap must always be a positive integer.
  it('invalid max_quorum_size must degrade to a positive-integer cap', () => {
    for (const bad of [0, -2, 1.5, 'abc']) {
      const res = runCli(['--max-quorum-size'], {
        projCfg: { max_quorum_size: bad },
      });
      assert.equal(res.status, 0, `exit 0 expected for ${JSON.stringify(bad)}; stderr: ${res.stderr}`);
      const out = res.stdout.trim();
      assert.match(out, /^\d+$/,
        `max_quorum_size=${JSON.stringify(bad)} must emit a bare non-negative integer, got "${out}"`);
      assert.ok(Number.parseInt(out, 10) >= 1,
        `max_quorum_size=${JSON.stringify(bad)} must floor to >= 1 (a cap of ${out} silently excludes slots)`);
    }
  });

  // ── 6. DRIFT GUARD: a stale slot (not in providers) is dropped, not fatal ──
  // quorum_active naming a slot that no longer exists in providers.json must be
  // silently dropped (fail-open), while real listed slots survive. No crash,
  // valid JSON, exit 0.
  it('a stale quorum_active slot is dropped while real slots survive', () => {
    const providers = {
      providers: [
        { name: 'codex-1', model: 'gpt', mainTool: 'codex' },
      ],
    };
    const res = runCli(['--all', '--no-probe'], {
      projCfg: { quorum_active: ['ghost-9', 'codex-1'] }, // ghost-9 is stale
      providers,
    });
    assert.equal(res.status, 0, `must not crash on a stale slot; stderr: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.deepEqual(Object.keys(out.team), ['codex-1'],
      'stale slot must be dropped; the real slot must remain in the roster');
  });
});

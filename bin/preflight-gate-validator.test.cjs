#!/usr/bin/env node
'use strict';
// bin/preflight-gate-validator.test.cjs — P3 + P5 of the long-open #293, extracted fresh.
//
// P5 validateProviders: a malformed slot does not announce itself. It fails at dispatch,
// mid-quorum, as an opaque UNAVAIL. This repo has shipped that twice — a missing
// args_template crashed every slot on `.map` (ARGS-TEMPLATE-01), and a slot with neither
// `cli` nor `mainTool` handed null to spawn() and took the whole quorum offline (#197).
// Both were visible in the config the whole time.
//
// P3 computeQuorumGate: "available < max_quorum_size -> BLOCK unless --force-quorum" was
// prose in quorum.md for an LLM to interpret. A gate that depends on a model reading a
// paragraph correctly is not a gate.

const { test } = require('node:test');
const assert = require('node:assert');
const { validateProviders, computeQuorumGate } = require('./quorum-preflight.cjs');

// ── P5 ───────────────────────────────────────────────────────────────────────

test('PGV-1: a well-formed roster is clean', () => {
  const r = validateProviders([
    { name: 'codex-1', type: 'subprocess', mainTool: 'codex', args_template: ['exec', '{prompt}'] },
    { name: 'api-1', type: 'http', baseUrl: 'https://x/v1', apiKeyEnv: 'X_KEY' },  // pragma: allowlist secret
  ]);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.valid, true);
});

test('PGV-2: catches the two failures that actually took quorums down', () => {
  // spawn(null) — #197.
  const noCli = validateProviders([{ name: 'a', type: 'subprocess' }]);
  assert.match(noCli.errors.join(' '), /neither 'cli' nor 'mainTool'/);
  // A template that drops the prompt — the CLI runs with flags and no question.
  const noPrompt = validateProviders([
    { name: 'b', type: 'subprocess', mainTool: 'x', args_template: ['exec'] },
  ]);
  assert.match(noPrompt.errors.join(' '), /no \{prompt\} placeholder/);
});

test('PGV-3: duplicate names are an error, not last-wins', () => {
  const r = validateProviders([
    { name: 'dup', type: 'subprocess', mainTool: 'x', args_template: ['{prompt}'] },
    { name: 'dup', type: 'subprocess', mainTool: 'y', args_template: ['{prompt}'] },
  ]);
  assert.match(r.errors.join(' '), /duplicate name/);
  assert.strictEqual(r.valid, false);
});

test('PGV-4: http slots need a base URL and some auth', () => {
  assert.match(validateProviders([{ name: 'h', type: 'http', apiKeyEnv: 'K' }]).errors.join(' '), /missing 'baseUrl'/);  // pragma: allowlist secret
  assert.match(validateProviders([{ name: 'h', type: 'http', baseUrl: 'https://x' }]).errors.join(' '), /no 'apiKeyEnv'/);
  // An inline token in env counts as auth.
  assert.deepStrictEqual(
    validateProviders([{ name: 'h', type: 'http', baseUrl: 'https://x', env: { ANTHROPIC_AUTH_TOKEN: 't' } }]).errors, []);  // pragma: allowlist secret
});

test('PGV-5: garbage timeouts WARN rather than error — they are ignored, not fatal', () => {
  const r = validateProviders([
    { name: 'w', type: 'subprocess', mainTool: 'x', args_template: ['{prompt}'], ttfb_timeout_ms: true, idle_timeout_ms: -1 },
  ]);
  assert.deepStrictEqual(r.errors, [], 'a bad timeout still dispatches, so it must not be an error');
  assert.strictEqual(r.warnings.length, 2);
  assert.match(r.warnings.join(' '), /ttfb_timeout_ms/);
});

test('PGV-6: never throws on hostile input', () => {
  for (const bad of [null, undefined, 'string', 42, [null], [{}], [{ name: 'x' }]]) {
    assert.doesNotThrow(() => validateProviders(bad), `threw on ${JSON.stringify(bad)}`);
  }
});

// ── P3 ───────────────────────────────────────────────────────────────────────

test('PGV-7: full roster is neither degraded nor blocked', () => {
  const g = computeQuorumGate({ availableCount: 7, maxQuorumSize: 7, minLiveVoters: 2 });
  assert.strictEqual(g.quorum_met, true);
  assert.strictEqual(g.degraded, false);
  assert.strictEqual(g.blocked, false);
  assert.strictEqual(g.waiver_required, false);
});

test('PGV-8: degraded and blocked are DIFFERENT states', () => {
  // The distinction prose kept losing: below max but above the floor still runs.
  const degraded = computeQuorumGate({ availableCount: 3, maxQuorumSize: 7, minLiveVoters: 2 });
  assert.strictEqual(degraded.degraded, true);
  assert.strictEqual(degraded.blocked, false, 'above the floor must still dispatch');
  assert.strictEqual(degraded.waiver_required, false);

  const blocked = computeQuorumGate({ availableCount: 1, maxQuorumSize: 7, minLiveVoters: 2 });
  assert.strictEqual(blocked.blocked, true);
  assert.strictEqual(blocked.waiver_required, true);
});

test('PGV-9: --force-quorum waives a block and records that it did', () => {
  const g = computeQuorumGate({ availableCount: 1, maxQuorumSize: 7, minLiveVoters: 2, forceQuorum: true });
  assert.strictEqual(g.blocked, false, 'an explicit waiver unblocks');
  assert.strictEqual(g.waiver_used, true, 'and the waiver must be recorded, not silent');
  assert.strictEqual(g.waiver_required, true);
});

test('PGV-10: force-quorum does not fabricate a healthy gate', () => {
  // The failure mode worth preventing: a waiver that makes the panel look fine.
  const g = computeQuorumGate({ availableCount: 1, maxQuorumSize: 7, minLiveVoters: 2, forceQuorum: true });
  assert.strictEqual(g.quorum_met, false);
  assert.match(g.gate_reason, /below the floor/);
});

test('PGV-11: garbage inputs fall back to safe defaults instead of NaN', () => {
  const g = computeQuorumGate({ availableCount: undefined, maxQuorumSize: 'x', minLiveVoters: 0 });
  assert.strictEqual(g.available_count, 0);
  assert.strictEqual(g.max_quorum_size, 3);
  assert.strictEqual(g.min_live_voters, 2);
  assert.strictEqual(g.blocked, true, 'zero available must block, not NaN-compare to false');
});

// ── Wiring: the two orderings that made these functions look correct in isolation
//    while being wrong in the pipeline. Both were review findings on the first version.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TMP = [];
process.on('exit', () => { for (const d of TMP) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } });

function runPreflight(providers, argv = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-pf-'));
  TMP.push(dir);
  const pj = path.join(dir, 'providers.json');
  fs.writeFileSync(pj, JSON.stringify({ providers }), 'utf8');
  const res = spawnSync(process.execPath, [
    path.join(__dirname, 'quorum-preflight.cjs'), '--all', '--no-probe', ...argv,
  ], { cwd: dir, encoding: 'utf8', timeout: 60000,
       env: { ...process.env, UNIFIED_PROVIDERS_CONFIG: pj } });
  let json = null;
  try { json = JSON.parse((res.stdout || '').split('\n').filter(Boolean).pop()); } catch (_) {}
  return { json, stderr: res.stderr || '' };
}

test('PGV-12: a corrupt roster entry reaches the validator, not just the filter', () => {
  // findProviders() strips null/nameless entries so the rest of preflight degrades
  // gracefully — which meant the validator never saw them and reported valid:true on
  // a roster it had never actually inspected.
  const { json, stderr } = runPreflight([null, { name: 'ok', type: 'subprocess', mainTool: 'x', args_template: ['{prompt}'] }]);
  assert.ok(json, 'preflight produced no JSON');
  assert.strictEqual(json.validation.valid, false, 'a [null] entry must be reported, not silently filtered');
  assert.match(stderr, /CONFIG ERROR/);
});

test('PGV-13: a corrupt entry does not wedge the preflight (still fail-open)', () => {
  // The validator reports; it must never block. The rest of the output must survive.
  const { json } = runPreflight([null, { name: 'ok', type: 'subprocess', mainTool: 'x', args_template: ['{prompt}'] }]);
  assert.ok(json.team, 'team output must still be produced alongside the diagnostic');
});

#!/usr/bin/env node
'use strict';
// bin/no-shipped-user-config.test.cjs
//
// nForma must not ship POPULATED user config. A user's quorum config is theirs:
// `~/.claude/nf.json` is generated at install from the MCP servers *they* have
// (buildRequiredModelsFromMcp / buildActiveSlots in bin/install.js), and
// `bin/providers.json` ships empty so install can scan their PATH and build it.
//
// This gate exists because we did ship one, and it rotted in two directions at once:
//
//   `templates/nf.json` — read by nothing in the codebase — shipped `required_models`
//   pointing at `mcp__codex-cli-1__` / `mcp__gemini-cli-1__`, slot names that no
//   longer exist, AND carried committed nf-benchmark mutation residue: BENCH-073's
//   `hooks: { "nf-bench-hook": { event: "InvalidLifecycle", command: "echo test" } }`,
//   five stacked copies of BENCH-077's `includes: ["nf-aux.json"]` (one per run),
//   BENCH-075's `solve.oscillation_window`, BENCH-078's zeroed
//   `context_monitor.warning_threshold` — and BENCH-072 had DELETED the entire
//   `quorum` block, so the shipped "quorum config template" had no quorum section.
//   The benchmark mutates SUT files in place and does not restore them, so anything
//   config-shaped that we track is a standing re-pollution target.
//
// The rule this pins: nothing in the npm tarball may carry user quorum/provider
// config as DATA. Behavior defaults belong in code (hooks/config-loader.js
// DEFAULT_CONFIG); project scaffolding templates (core/templates/) are fine — they
// describe a project's own planning state, not the user's model fleet.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

// Top-level keys that mean "this file IS someone's fleet/quorum config", not code.
const USER_CONFIG_KEYS = [
  'required_models',   // quorum model roster with tool prefixes
  'quorum_commands',   // which /nf: commands are gated
  'quorum_active',     // which slots participate
  'quorum_instructions',
  'mcpServers',        // ~/.claude.json shape
  'providers',         // providers.json shape
];

// The ONLY shipped file allowed to carry one of those keys, and only while empty.
const ALLOWED = new Map([['bin/providers.json', 'must be an empty provider list']]);

// Positive entries of package.json `files` (the "!"-prefixed ones are exclusions).
const SHIPPED_ROOTS = (pkg.files || []).filter(f => !f.startsWith('!'));

function walkJson(dir, acc = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return acc; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJson(full, acc);
    else if (e.name.endsWith('.json') && !/\.test\./.test(e.name)) acc.push(full);
  }
  return acc;
}

test('SHIPCFG-1: bin/providers.json ships EMPTY — the user\'s slots are built on their machine', () => {
  const p = path.join(REPO, 'bin', 'providers.json');
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepStrictEqual(
    data, { providers: [] },
    'bin/providers.json must ship as {"providers": []}. A populated one would hand every ' +
    'installing user someone else\'s slot roster (and, if env is inlined, their endpoints).',
  );
});

test('SHIPCFG-2: templates/nf.json is not resurrected', () => {
  assert.strictEqual(
    fs.existsSync(path.join(REPO, 'templates', 'nf.json')), false,
    'templates/nf.json was deleted: nothing read it, its slot prefixes were stale, and ' +
    'nf-benchmark kept mutating it in place (BENCH-072/073/075/077/078 residue was ' +
    'committed and shipped). User config is generated per-machine at install.',
  );
});

test('SHIPCFG-3: no packaged file carries user quorum/provider config as data', () => {
  const offenders = [];
  for (const root of SHIPPED_ROOTS) {
    const abs = path.join(REPO, root);
    let stat;
    try { stat = fs.statSync(abs); } catch (_) { continue; } // a `files` entry may be a glob
    const files = stat.isDirectory() ? walkJson(abs) : [abs];
    for (const f of files) {
      const rel = path.relative(REPO, f).split(path.sep).join('/');
      let data;
      try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { continue; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      const hit = USER_CONFIG_KEYS.filter(k => Object.prototype.hasOwnProperty.call(data, k));
      if (hit.length > 0 && !ALLOWED.has(rel)) offenders.push(`${rel} (${hit.join(', ')})`);
    }
  }
  assert.deepStrictEqual(
    offenders, [],
    'These packaged files carry user config as data:\n  ' + offenders.join('\n  ') +
    '\nnForma must not ship a fleet config. Generate it at install from what the user ' +
    'actually has (see buildRequiredModelsFromMcp in bin/install.js), or put behavior ' +
    'defaults in DEFAULT_CONFIG (hooks/config-loader.js) where they are code, not data.',
  );
});

test('SHIPCFG-4: the gate actually inspects the packaged tree (non-vacuous)', () => {
  // Guards the sweep itself: if `files` were renamed or the walker silently returned
  // nothing, SHIPCFG-3 would pass by finding no files at all.
  assert.ok(SHIPPED_ROOTS.includes('bin'), 'package.json files must still ship bin/');
  const scanned = walkJson(path.join(REPO, 'bin'));
  assert.ok(scanned.length > 0, 'the JSON walker found no files under bin/ — the sweep is vacuous');
  assert.ok(
    scanned.some(f => f.endsWith(`${path.sep}providers.json`)),
    'the sweep must reach bin/providers.json, the one file the allowlist covers',
  );
});

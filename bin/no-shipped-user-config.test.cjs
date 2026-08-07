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
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');

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
const ALLOWED = new Set(['bin/providers.json']);

// The packaged file list comes from npm itself, not from re-deriving package.json
// `files`. Re-deriving means reimplementing npm's glob/negation/ignore-file
// precedence, and any entry the reimplementation can't resolve (a glob like
// `config/**`) gets silently skipped — a gate that quietly stops looking is worse
// than no gate. `--ignore-scripts` keeps prepack/prepublishOnly (which runs
// build:hooks) from firing during a test. Takes ~1s.
function packagedFiles() {
  const res = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: REPO, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024,
  });
  assert.ok(
    res.status === 0 && res.stdout,
    `npm pack --dry-run failed (status=${res.status}); this gate needs npm's own file ` +
    `list to be authoritative — do not fall back to walking package.json "files".\n${res.stderr || ''}`,
  );
  // npm prints notices on stderr; --json puts the payload on stdout.
  return JSON.parse(res.stdout)[0].files.map(f => f.path);
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

test('SHIPCFG-3: no file in the npm tarball carries user quorum/provider config as data', () => {
  const offenders = [];
  for (const rel of packagedFiles()) {
    if (!rel.endsWith('.json') || /\.test\./.test(rel)) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8')); } catch (_) { continue; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const hit = USER_CONFIG_KEYS.filter(k => Object.prototype.hasOwnProperty.call(data, k));
    if (hit.length > 0 && !ALLOWED.has(rel)) offenders.push(`${rel} (${hit.join(', ')})`);
  }
  assert.deepStrictEqual(
    offenders, [],
    'These files in the npm tarball carry user config as data:\n  ' + offenders.join('\n  ') +
    '\nnForma must not ship a fleet config. Generate it at install from what the user ' +
    'actually has (see buildRequiredModelsFromMcp in bin/install.js), or put behavior ' +
    'defaults in DEFAULT_CONFIG (hooks/config-loader.js) where they are code, not data.',
  );
});

test('SHIPCFG-4: the gate actually inspects the tarball (non-vacuous)', () => {
  // Guards the sweep itself: if npm's output shape changed or the list came back
  // empty, SHIPCFG-3 would pass by scanning nothing.
  const files = packagedFiles();
  assert.ok(files.length > 100, `npm resolved only ${files.length} packaged files — the sweep is vacuous`);
  assert.ok(
    files.includes('bin/providers.json'),
    'the sweep must reach bin/providers.json, the one file the allowlist covers',
  );
  assert.ok(
    files.some(f => f.endsWith('.json') && f !== 'bin/providers.json' && f !== 'package.json'),
    'the sweep must see JSON files beyond the allowlisted one',
  );
});

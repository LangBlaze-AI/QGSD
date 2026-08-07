#!/usr/bin/env node
'use strict';
// bin/install-providers-precedence.test.cjs
//
// When bin/providers.json ships empty (it always does — see no-shipped-user-config),
// install.js RECONSTRUCTS the user's providers.json from ~/.claude.json mcpServers and
// overlays whatever it can recover for each slot. It gathers that overlay from four
// candidate files, documented as being "in order of freshness":
//
//   1. ~/.claude/nf-bin/providers.json                      ← canonical LIVE file
//   2. ~/.claude/nf-local-patches/nf-bin/providers.json     ← backup
//   3. ~/.claude/nf-local-patches/nf/bin/providers.json     ← legacy backup
//   4. ~/.claude/nf/bin/providers.json                      ← legacy live
//
// The loop used `map.set(name, entry)` unconditionally, so the LAST candidate won —
// inverting the stated order. On a real machine that meant a nf-local-patches backup
// from 2026-05-13 overwrote the live entry for 7 slots on EVERY install, silently
// reverting per-slot tuning (ttfb_timeout_ms, inter_chunk_ceiling_ms, model, env).
// It was found because freshly-set ttfb_timeout_ms values kept vanishing after
// `install.js --claude --global`.
//
// The invariant: backups recover slots the live file has LOST; they never override it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'install.js'), 'utf8');

// The reconstruction runs deep inside install.js's global-install path, behind a real
// ~/.claude.json and filesystem writes. Rather than drive that, extract the gather loop
// and execute it — the defect lives entirely in this loop's precedence.
function gatherLoop() {
  const start = SRC.indexOf('for (const candidatePath of [globalProvidersJson');
  assert.ok(start !== -1, 'install.js lost its providers.json candidate-gather loop');
  const end = SRC.indexOf('catch (_) { /* skip unreadable / malformed */ }', start);
  assert.ok(end !== -1, 'could not find the end of the gather loop');
  return SRC.slice(start, end + 'catch (_) { /* skip unreadable / malformed */ }'.length) + '\n}';
}

function runGather(files) {
  const existingByName = new Map();
  const fsStub = {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error('ENOENT');
      return files[p];
    },
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'fs', 'existingByName', 'globalProvidersJson', 'patchedProvidersPathNfBin',
    'patchedProvidersPathLegacy', 'legacyProvidersPath', gatherLoop(),
  );
  fn(fsStub, existingByName, 'LIVE', 'BACKUP', 'LEGACY_BACKUP', 'LEGACY_LIVE');
  return existingByName;
}

const liveEntry   = { name: 'claude-z-ai', ttfb_timeout_ms: 150000, model: 'tuned' };
const staleEntry  = { name: 'claude-z-ai', model: 'from-may' }; // no ttfb — the 2026-05-13 shape

test('IPP-1: the LIVE file wins over a stale backup listing the same slot', () => {
  const got = runGather({
    LIVE:          JSON.stringify({ providers: [liveEntry] }),
    LEGACY_BACKUP: JSON.stringify({ providers: [staleEntry] }),
  });
  const e = got.get('claude-z-ai');
  assert.strictEqual(e.ttfb_timeout_ms, 150000,
    'a stale backup must not revert live per-slot tuning — this is the bug that ate ttfb_timeout_ms');
  assert.strictEqual(e.model, 'tuned');
});

test('IPP-2: a backup still RECOVERS a slot the live file no longer has', () => {
  // The reason the backups are consulted at all. Narrowing precedence must not break it.
  const got = runGather({
    LIVE:          JSON.stringify({ providers: [{ name: 'claude-1' }] }),
    LEGACY_BACKUP: JSON.stringify({ providers: [{ name: 'claude-minimax', model: 'recovered' }] }),
  });
  assert.ok(got.has('claude-minimax'), 'a slot missing from live must still be recoverable');
  assert.strictEqual(got.get('claude-minimax').model, 'recovered');
});

test('IPP-3: precedence follows the documented order across all four candidates', () => {
  const got = runGather({
    LIVE:          JSON.stringify({ providers: [{ name: 'a', src: 'live' }] }),
    BACKUP:        JSON.stringify({ providers: [{ name: 'a', src: 'backup' }, { name: 'b', src: 'backup' }] }),
    LEGACY_BACKUP: JSON.stringify({ providers: [{ name: 'b', src: 'legacy-backup' }, { name: 'c', src: 'legacy-backup' }] }),
    LEGACY_LIVE:   JSON.stringify({ providers: [{ name: 'c', src: 'legacy-live' }, { name: 'd', src: 'legacy-live' }] }),
  });
  assert.strictEqual(got.get('a').src, 'live');
  assert.strictEqual(got.get('b').src, 'backup');
  assert.strictEqual(got.get('c').src, 'legacy-backup');
  assert.strictEqual(got.get('d').src, 'legacy-live');
});

test('IPP-4: a malformed or nameless entry cannot poison the map', () => {
  const got = runGather({
    LIVE:          '{ not json',
    LEGACY_BACKUP: JSON.stringify({ providers: [null, { noName: true }, { name: 'ok', src: 'kept' }] }),
  });
  assert.strictEqual(got.get('ok').src, 'kept');
  assert.ok(!got.has(undefined), 'a nameless entry must not be keyed as undefined');
});

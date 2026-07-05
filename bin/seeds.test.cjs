'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { slugify, nextSeedId, looksFormal, plant, list } = require('./seeds.cjs');

const BIN = path.join(__dirname, 'seeds.cjs');
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'seeds-')); }

test('slugify + looksFormal', () => {
  assert.strictEqual(slugify('Add a Retry Queue!'), 'add-a-retry-queue');
  assert.strictEqual(looksFormal('add a TLA+ invariant for the wizard'), true);
  assert.strictEqual(looksFormal('tweak the button color'), false);
});

test('plant writes a dormant seed and auto-numbers', () => {
  const root = tmp();
  try {
    const a = plant(root, { text: 'first idea', now: '2026-07-05T00:00:00Z' });
    const b = plant(root, { text: 'second idea', trigger: 'when we add auth', now: '2026-07-05T00:00:00Z' });
    assert.strictEqual(a.id, 'SEED-001');
    assert.strictEqual(b.id, 'SEED-002');
    const seeds = list(root, 'all');
    assert.strictEqual(seeds.length, 2);
    assert.strictEqual(seeds[0].status, 'dormant');
    assert.strictEqual(seeds[1].trigger, 'when we add auth');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fusion: a formally-relevant seed is auto-tagged formal', () => {
  const root = tmp();
  try {
    const r = plant(root, { text: 'prove the state machine has no deadlock', now: '2026-07-05T00:00:00Z' });
    assert.strictEqual(r.formal, true);
    const s = list(root, 'all')[0];
    assert.strictEqual(s.formal, true);
    assert.match(fs.readFileSync(r.path, 'utf8'), /close-formal-gaps/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('list --status filters; empty dir → []', () => {
  const root = tmp();
  try {
    assert.deepStrictEqual(list(root, 'all'), []);
    plant(root, { text: 'x', now: '2026-07-05T00:00:00Z' });
    assert.strictEqual(list(root, 'dormant').length, 1);
    assert.strictEqual(list(root, 'promoted').length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('CLI: plant then list --json; plant text before flags', () => {
  const root = tmp();
  try {
    execFileSync(process.execPath, [BIN, 'plant', 'ship a retry queue', '--trigger', 'when load > 1k', '--scope', 'infra', '--root', root], { encoding: 'utf8' });
    const out = execFileSync(process.execPath, [BIN, 'list', '--json', '--root', root], { encoding: 'utf8' });
    const seeds = JSON.parse(out);
    assert.strictEqual(seeds.length, 1);
    assert.strictEqual(seeds[0].title, 'ship a retry queue');
    assert.strictEqual(seeds[0].scope, 'infra');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('CLI: promote prints a non-destructive backlog entry', () => {
  const root = tmp();
  try {
    execFileSync(process.execPath, [BIN, 'plant', 'add liveness invariant', '--root', root], { encoding: 'utf8' });
    const out = execFileSync(process.execPath, [BIN, 'promote', 'SEED-001', '--root', root], { encoding: 'utf8' });
    assert.match(out, /Phase 999\.x: add liveness invariant/);
    assert.match(out, /close-formal-gaps/); // auto-formal
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

#!/usr/bin/env node
'use strict';

// bin/semaphore-concurrency.test.cjs
// Regression gate for issue #201:
//   1. N parallel child processes contending for the same provider key never
//      exceed the concurrency cap (no over-admission), and never get the same
//      real slot index at once (no double-holder).
//   2. failures.json (via atomicUpdateJson) loses no records under concurrent
//      writers — the exact correlated-outage scenario #192/#190 need to observe.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PC_MODULE = require.resolve('./provider-concurrency.cjs');
const CQS_MODULE = require.resolve('./call-quorum-slot.cjs');
const LOCK_DIR = path.join(os.tmpdir(), 'nf-provider-locks');

function rmKey(key) {
  try {
    if (!fs.existsSync(LOCK_DIR)) return;
    for (const f of fs.readdirSync(LOCK_DIR)) {
      if (f.startsWith(`${key}-`)) {
        try { fs.unlinkSync(path.join(LOCK_DIR, f)); } catch (_) {}
      }
    }
  } catch (_) {}
}

after(() => {
  try {
    if (!fs.existsSync(LOCK_DIR)) return;
    for (const f of fs.readdirSync(LOCK_DIR)) {
      if (f.startsWith('stress-pc-')) {
        try { fs.unlinkSync(path.join(LOCK_DIR, f)); } catch (_) {}
      }
    }
  } catch (_) {}
});

// ─── Stress child: acquire → record interval → hold → release ──────────────────
// Each child appends one JSON line {slotIndex, acqMs, relMs} after releasing.
// The parent replays the intervals to confirm:
//   - at most `cap` real slots (slotIndex !== null) overlap at any instant
//   - no two overlapping real intervals share the same slotIndex
const STRESS_CHILD = [
  "(async () => {",
  "  const m = require(process.env.PC_MODULE);",
  "  const key = process.env.PC_KEY;",
  "  const cap = Number(process.env.PC_CAP);",
  "  const hold = Number(process.env.PC_HOLD);",
  "  const out = process.env.PC_OUT;",
  "  const fs = require('fs');",
  "  const lock = await m.acquireSlot(key, cap, 15000);",
  "  const acqMs = Date.now();",
  "  await new Promise(r => setTimeout(r, hold));",
  "  const relMs = Date.now();",
  "  if (lock && lock.release) lock.release();",
  "  fs.appendFileSync(out, JSON.stringify({ slotIndex: lock.slotIndex, acqMs, relMs }) + '\\n');",
  "})().catch(e => { process.stderr.write(String(e) + '\\n'); process.exit(1); });",
].join('\n');

function spawnStressChild(key, cap, holdMs, outPath) {
  return spawn(process.execPath, ['-e', STRESS_CHILD], {
    stdio: 'ignore',
    env: {
      ...process.env,
      PC_MODULE: PC_MODULE,
      PC_KEY: key,
      PC_CAP: String(cap),
      PC_HOLD: String(holdMs),
      PC_OUT: outPath,
    },
  });
}

test('N parallel acquirers never exceed the cap and never double-hold a slot', async () => {
  const key = `stress-pc-${process.pid}-${Date.now()}`;
  const cap = 3;
  const N = 12;
  const holdMs = 120;
  const outPath = path.join(os.tmpdir(), `nf-pc-stress-${process.pid}-${Date.now()}.jsonl`);
  try {
    fs.writeFileSync(outPath, '');
    const children = Array.from({ length: N }, () => spawnStressChild(key, cap, holdMs, outPath));
    await Promise.all(children.map(c => new Promise((res) => c.on('exit', res))));

    const lines = fs.readFileSync(outPath, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, N, 'every child must record exactly one acquire/release interval');
    const intervals = lines.map(l => JSON.parse(l));

    // Only real slots (slotIndex !== null) count against the cap; null = fail-open.
    const real = intervals.filter(i => i.slotIndex !== null);
    assert.ok(real.length > 0, 'at least some acquirers should win a real slot');

    // Build a sweep of acquire/release events and track peak overlap + per-slot holders.
    const events = [];
    for (const iv of real) {
      events.push({ t: iv.acqMs, kind: 'acq', slot: iv.slotIndex });
      events.push({ t: iv.relMs, kind: 'rel', slot: iv.slotIndex });
    }
    // Sort by time; process releases before acquires at the same timestamp so a
    // hand-off (release then re-acquire of the same slot) does not count as overlap.
    events.sort((a, b) => (a.t - b.t) || (a.kind === 'rel' ? -1 : 1));

    let live = 0;
    let peak = 0;
    const slotHeld = new Map();
    for (const e of events) {
      if (e.kind === 'acq') {
        live++;
        peak = Math.max(peak, live);
        const held = (slotHeld.get(e.slot) || 0) + 1;
        slotHeld.set(e.slot, held);
        assert.ok(held <= 1, `slot ${e.slot} double-held — two processes admitted to one slot`);
      } else {
        live--;
        slotHeld.set(e.slot, (slotHeld.get(e.slot) || 1) - 1);
      }
    }
    assert.ok(peak <= cap, `peak concurrent real holders ${peak} must not exceed cap ${cap}`);
  } finally {
    rmKey(key);
    try { fs.unlinkSync(outPath); } catch (_) {}
  }
});

// ─── Concurrent failures.json writers lose no records ──────────────────────────
const { atomicUpdateJson } = require('./call-quorum-slot.cjs');

// Child appends a unique record to a shared JSON array via atomicUpdateJson.
const WRITER_CHILD = [
  "const { atomicUpdateJson } = require(process.env.CQS_MODULE);",
  "const file = process.env.AUJ_FILE;",
  "const id = process.env.AUJ_ID;",
  "atomicUpdateJson(file, (cur) => {",
  "  const arr = Array.isArray(cur) ? cur : [];",
  "  arr.push({ id });",
  "  return arr;",
  "}, []);",
].join('\n');

function spawnWriter(file, id) {
  return spawn(process.execPath, ['-e', WRITER_CHILD], {
    stdio: 'ignore',
    env: { ...process.env, CQS_MODULE: CQS_MODULE, AUJ_FILE: file, AUJ_ID: String(id) },
  });
}

test('atomicUpdateJson: concurrent writers lose no records', async () => {
  const file = path.join(os.tmpdir(), `nf-auj-${process.pid}-${Date.now()}.json`);
  const N = 20;
  try {
    const children = Array.from({ length: N }, (_, i) => spawnWriter(file, i));
    const codes = await Promise.all(
      children.map(c => new Promise((res) => c.on('exit', (code) => res(code))))
    );
    assert.ok(codes.every(c => c === 0), 'all writer children should exit cleanly');

    const records = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(records), 'file should remain a valid JSON array');
    assert.equal(records.length, N, `all ${N} concurrent writes must be preserved (got ${records.length})`);
    const ids = new Set(records.map(r => r.id));
    assert.equal(ids.size, N, 'every writer record must be distinct and present (none lost or clobbered)');
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
    try { fs.unlinkSync(file + '.lock'); } catch (_) {}
  }
});

test('atomicUpdateJson: torn/garbage existing file does not wipe a fresh write', () => {
  const file = path.join(os.tmpdir(), `nf-auj-torn-${process.pid}-${Date.now()}.json`);
  try {
    fs.writeFileSync(file, '[{"id":0},{"id":1'); // truncated/torn JSON
    // A writer reading torn JSON falls back to [] internally; the point is it must
    // still produce a valid array and not throw.
    atomicUpdateJson(file, (cur) => {
      const arr = Array.isArray(cur) ? cur : [];
      arr.push({ id: 'recovered' });
      return arr;
    }, []);
    const records = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(records));
    assert.ok(records.some(r => r.id === 'recovered'), 'new record must be written even over a torn file');
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
    try { fs.unlinkSync(file + '.lock'); } catch (_) {}
  }
});

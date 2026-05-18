#!/usr/bin/env node
'use strict';

// bin/provider-concurrency.test.cjs
// Tests for the file-based provider concurrency semaphore.
// Covers issue #176: PID-based locks must not leave stale locks on crash.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const { acquireSlot, releaseSlot, providerKeyFromUrl } = require('./provider-concurrency.cjs');

const MODULE_PATH = require.resolve('./provider-concurrency.cjs');
const LOCK_DIR = path.join(os.tmpdir(), 'nf-provider-locks');

// ─── Test helpers ──────────────────────────────────────────────────────────────

let keyCounter = 0;
function uniqueKey() {
  return `test-pc-${process.pid}-${Date.now()}-${keyCounter++}`;
}

function lockPathFor(key, slotIndex) {
  return path.join(LOCK_DIR, `${key}-${slotIndex}.lock`);
}

function ensureLockDir() {
  if (!fs.existsSync(LOCK_DIR)) fs.mkdirSync(LOCK_DIR, { recursive: true });
}

function writeLock(key, slotIndex, content) {
  ensureLockDir();
  fs.writeFileSync(lockPathFor(key, slotIndex), JSON.stringify(content));
}

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

// Mirrors provider-concurrency.cjs's internal boot-time derivation.
function currentBootTimeSec() {
  return Math.floor(Date.now() / 1000 - os.uptime());
}

// Poll for a file to appear — used before entering the synchronous acquireSlot()
// busy-wait, while the event loop is still free.
function waitForFile(p, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (fs.existsSync(p)) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`timed out waiting for ${p}`));
      }
    }, 15);
  });
}

// Child that grabs the only slot for `key`, then either SIGKILLs itself after
// NF_PC_SELFKILL_MS (simulating a crash) or stays alive until the parent kills it.
const CHILD_SCRIPT = [
  "const m = require(process.env.NF_PC_MODULE);",
  "m.acquireSlot(process.env.NF_PC_KEY, 1, 5000);",
  "const sk = Number(process.env.NF_PC_SELFKILL_MS || 0);",
  "if (sk > 0) { setTimeout(() => process.kill(process.pid, 'SIGKILL'), sk); }",
  "else { setInterval(() => {}, 1 << 30); }",
].join('\n');

function holderEnv(key, selfKillMs) {
  return {
    ...process.env,
    NF_PC_MODULE: MODULE_PATH,
    NF_PC_KEY: key,
    NF_PC_SELFKILL_MS: String(selfKillMs || 0),
  };
}

// Direct child holder — the test process is its parent and must reap it via
// once(child, 'exit') so its PID frees up.
function spawnHolder(key, selfKillMs) {
  return spawn(process.execPath, ['-e', CHILD_SCRIPT], {
    stdio: 'ignore',
    env: holderEnv(key, selfKillMs),
  });
}

// Launcher that spawns a DETACHED holder then exits. Once the launcher exits the
// holder is re-parented to init/launchd, which reaps it the instant it dies — so
// process.kill(pid, 0) reports ESRCH promptly. A direct child, by contrast, would
// linger as an unreaped zombie (still "alive" to kill(pid,0)) for as long as the
// test process is blocked inside acquireSlot's synchronous busy-wait.
const LAUNCHER_SCRIPT = [
  "const { spawn } = require('child_process');",
  "const h = spawn(process.execPath, ['-e', process.env.NF_PC_HOLDER_SRC], {",
  "  detached: true, stdio: 'ignore', env: process.env,",
  "});",
  "h.unref();",
  "process.exit(0);",
].join('\n');

function spawnDetachedHolder(key, selfKillMs) {
  return spawn(process.execPath, ['-e', LAUNCHER_SCRIPT], {
    stdio: 'ignore',
    env: { ...holderEnv(key, selfKillMs), NF_PC_HOLDER_SRC: CHILD_SCRIPT },
  });
}

after(() => {
  // Sweep any leftover test locks regardless of which test created them.
  try {
    if (!fs.existsSync(LOCK_DIR)) return;
    for (const f of fs.readdirSync(LOCK_DIR)) {
      if (f.startsWith('test-pc-')) {
        try { fs.unlinkSync(path.join(LOCK_DIR, f)); } catch (_) {}
      }
    }
  } catch (_) {}
});

// ─── Basic acquire / release ───────────────────────────────────────────────────

test('acquireSlot returns acquired:true and slot 0 when no locks exist', () => {
  const key = uniqueKey();
  try {
    const result = acquireSlot(key, 1, 100);
    assert.equal(result.acquired, true);
    assert.equal(result.slotIndex, 0);
    assert.equal(typeof result.release, 'function');
    result.release();
  } finally {
    rmKey(key);
  }
});

test('acquireSlot fills distinct slots up to max_concurrency, then fails open', () => {
  const key = uniqueKey();
  const maxConc = 2;
  const slots = [];
  try {
    for (let i = 0; i < maxConc; i++) {
      const result = acquireSlot(key, maxConc, 100);
      assert.equal(result.acquired, true);
      assert.equal(result.slotIndex, i, `slot ${i} should be acquired in order`);
      slots.push(result);
    }
    // Overflow: all slots held by this (live) process — must fail open without
    // a real slot, proving the concurrency cap is still enforced.
    const overflow = acquireSlot(key, maxConc, 50);
    assert.equal(overflow.acquired, true);
    assert.equal(overflow.slotIndex, null);
    overflow.release();
  } finally {
    slots.forEach((s) => s.release());
    rmKey(key);
  }
});

test('release() removes the lock file', () => {
  const key = uniqueKey();
  try {
    const result = acquireSlot(key, 1, 100);
    const lockPath = lockPathFor(key, result.slotIndex);
    assert.ok(fs.existsSync(lockPath), 'lock file should exist after acquire');
    result.release();
    assert.ok(!fs.existsSync(lockPath), 'lock file should be gone after release');
  } finally {
    rmKey(key);
  }
});

test('releaseSlot(key, index) removes the lock file', () => {
  const key = uniqueKey();
  try {
    const result = acquireSlot(key, 1, 100);
    const lockPath = lockPathFor(key, result.slotIndex);
    assert.ok(fs.existsSync(lockPath));
    releaseSlot(key, result.slotIndex);
    assert.ok(!fs.existsSync(lockPath));
  } finally {
    rmKey(key);
  }
});

test('double-release is idempotent', () => {
  const key = uniqueKey();
  try {
    const result = acquireSlot(key, 1, 100);
    result.release();
    result.release(); // must not throw
    releaseSlot(key, 0); // also safe when already released
  } finally {
    rmKey(key);
  }
});

// ─── Stale lock reclamation (issue #176) ───────────────────────────────────────

test('reclaims a slot whose holder PID no longer exists', () => {
  const key = uniqueKey();
  try {
    // A crashed holder leaves a lock file with a dead PID.
    writeLock(key, 0, {
      pid: 999999,
      ts: new Date().toISOString(),
      bootTime: currentBootTimeSec(),
      slot: `${key}-0`,
    });
    const result = acquireSlot(key, 1, 200);
    assert.equal(result.acquired, true);
    assert.equal(result.slotIndex, 0, 'stale lock with dead PID should be reclaimed');
    result.release();
  } finally {
    rmKey(key);
  }
});

test('reclaims a slot whose lock is older than the TTL', () => {
  const key = uniqueKey();
  try {
    // Live PID + current boot, but the timestamp is 6 minutes old (> 5min TTL).
    writeLock(key, 0, {
      pid: process.pid,
      ts: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
      bootTime: currentBootTimeSec(),
      slot: `${key}-0`,
    });
    const result = acquireSlot(key, 1, 200);
    assert.equal(result.slotIndex, 0, 'TTL-expired lock should be reclaimed');
    result.release();
  } finally {
    rmKey(key);
  }
});

test('reclaims a lock left over from a previous boot even if its PID is alive', () => {
  const key = uniqueKey();
  try {
    // Our own (alive) PID and a fresh timestamp — only the boot time betrays it
    // as stale. After a reboot, PIDs are reused, so liveness alone is not enough.
    writeLock(key, 0, {
      pid: process.pid,
      ts: new Date().toISOString(),
      bootTime: 1, // epoch — unmistakably a previous boot
      slot: `${key}-0`,
    });
    const result = acquireSlot(key, 1, 200);
    assert.equal(result.slotIndex, 0, 'pre-boot lock should be reclaimed');
    result.release();
  } finally {
    rmKey(key);
  }
});

test('does NOT reclaim a fresh lock held by a live process', () => {
  const key = uniqueKey();
  let held;
  try {
    held = acquireSlot(key, 1, 100);
    assert.equal(held.slotIndex, 0);
    // A second acquire (maxConcurrency 1) must not steal the live slot.
    const overflow = acquireSlot(key, 1, 250);
    assert.equal(overflow.acquired, true);
    assert.equal(overflow.slotIndex, null, 'live lock must not be reclaimed');
    overflow.release();
  } finally {
    if (held) held.release();
    rmKey(key);
  }
});

test('malformed lock file is removed and the slot reclaimed', () => {
  const key = uniqueKey();
  try {
    ensureLockDir();
    fs.writeFileSync(lockPathFor(key, 0), 'not-json{{{');
    const result = acquireSlot(key, 1, 200);
    assert.equal(result.slotIndex, 0, 'malformed lock should be reclaimed');
    result.release();
  } finally {
    rmKey(key);
  }
});

// ─── Crash recovery with real processes ────────────────────────────────────────

test('a SIGKILLed holder leaves no permanently stale lock', async () => {
  const key = uniqueKey();
  const lockPath = lockPathFor(key, 0);
  const child = spawnHolder(key, 0); // stays alive until we kill it
  try {
    await waitForFile(lockPath, 8000);
    // Holder is alive and owns the only slot.
    child.kill('SIGKILL');
    await once(child, 'exit');
    // SIGKILL gave the holder no chance to run its release path.
    assert.ok(fs.existsSync(lockPath), 'killed holder should leave a stale lock file');

    // No manual `rm` — the next acquisition must reclaim it on its own.
    const result = acquireSlot(key, 1, 3000);
    assert.equal(result.acquired, true);
    assert.equal(result.slotIndex, 0, 'should reclaim the SIGKILLed holder\'s slot');
    result.release();
  } finally {
    try { child.kill('SIGKILL'); } catch (_) {}
    rmKey(key);
  }
});

test('reclaims a slot when the holder dies mid-wait (in-loop stale cleanup)', async () => {
  const key = uniqueKey();
  const lockPath = lockPathFor(key, 0);
  // Detached holder grabs the only slot, then SIGKILLs itself ~600ms later.
  const launcher = spawnDetachedHolder(key, 600);
  try {
    await once(launcher, 'exit'); // reap the launcher; holder now belongs to init
    await waitForFile(lockPath, 8000);
    // We enter acquireSlot() while the holder is still alive. Its synchronous
    // busy-wait blocks our event loop, but the holder is a separate OS process
    // and dies on its own. Stale cleanup runs on every retry pass, so the freed
    // slot must be handed to us — not left until our acquire times out.
    const t0 = Date.now();
    const result = acquireSlot(key, 1, 10000);
    const waited = Date.now() - t0;

    assert.equal(result.acquired, true);
    assert.equal(
      result.slotIndex,
      0,
      'must reclaim the freed slot mid-wait, not time out to fail-open (null)'
    );
    assert.ok(waited < 9000, `should reclaim well before timeout (waited ${waited}ms)`);
    result.release();
  } finally {
    // Best-effort: kill the holder by the PID recorded in its lock file.
    try {
      const c = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (c && c.pid) process.kill(c.pid, 'SIGKILL');
    } catch (_) {}
    rmKey(key);
  }
});

// ─── Fail-open behavior ────────────────────────────────────────────────────────

test('acquireSlot fails open (acquired:true, slotIndex:null) on fs errors', () => {
  const key = uniqueKey();
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = () => {
    throw new Error('simulated fs failure');
  };
  try {
    const result = acquireSlot(key, 1, 100);
    assert.equal(result.acquired, true, 'must fail open so dispatch is never blocked');
    assert.equal(result.slotIndex, null);
    assert.equal(typeof result.release, 'function');
    result.release(); // no-op, must not throw
  } finally {
    fs.writeFileSync = originalWrite;
    rmKey(key);
  }
});

// ─── providerKeyFromUrl ────────────────────────────────────────────────────────

test('providerKeyFromUrl derives a distinct key per host and path', () => {
  const v1 = providerKeyFromUrl('https://api.together.xyz/v1');
  const v2 = providerKeyFromUrl('https://api.together.xyz/v2');
  const other = providerKeyFromUrl('https://api.example.com/v1');

  assert.notEqual(v1, v2, 'different paths → different keys');
  assert.notEqual(v1, other, 'different hosts → different keys');
  assert.match(v1, /^[a-z0-9-]+$/, 'key should be lowercase alphanumeric + dashes');
  assert.ok(v1.includes('together'));
  assert.ok(v1.includes('v1'));
});

test('providerKeyFromUrl falls back to a hash for an invalid URL', () => {
  const key = providerKeyFromUrl('not a url');
  assert.match(key, /^provider-[a-f0-9]{8}$/, 'invalid URL should hash to provider-<hash>');
  // Deterministic: the same invalid input yields the same key.
  assert.equal(key, providerKeyFromUrl('not a url'));
});

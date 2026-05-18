'use strict';

/**
 * provider-concurrency.cjs — File-based provider concurrency semaphore
 *
 * Implements provider-level concurrency control via lock files in /tmp/nf-provider-locks/.
 * Prevents rate-limit cascades when multiple quorum slots share the same API provider
 * (e.g., 6 Together.xyz slots firing simultaneously).
 *
 * Crash resilience
 * ----------------
 * Lock files are best-effort cleaned up when their holder exits normally. A holder
 * that crashes, is SIGKILLed, or whose parent shell terminates abruptly cannot run
 * its release path, so its lock file persists with a stale PID. To keep those stale
 * locks from blocking subsequent acquisitions until a manual `rm`, every acquisition
 * attempt reclaims locks whose holder is gone:
 *   1. dead PID            — `process.kill(pid, 0)` reports the process no longer exists
 *   2. previous boot       — the lock's recorded boot time predates the current boot
 *                            (defends against PID reuse after a reboot)
 *   3. TTL expiry          — the lock is older than STALE_TTL_MS (backstop for the
 *                            rare case of PID reuse within the same boot)
 * Critically, this reclaim runs on *every* pass of the acquire retry loop — so a slot
 * freed by a crash that happens *while another caller is waiting* becomes available
 * within one backoff cycle, not only at the next fresh acquireSlot() call.
 *
 * Exports:
 *   - acquireSlot(providerKey, maxConcurrency, timeoutMs): acquire a slot
 *   - releaseSlot(providerKey, slotIndex): release a slot
 *   - providerKeyFromUrl(baseUrl): derive a lock key from a provider baseUrl
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ─── Config ────────────────────────────────────────────────────────────────────
const LOCK_DIR = path.join(os.tmpdir(), 'nf-provider-locks');
const STALE_TTL_MS = 5 * 60 * 1000; // 5 minutes — backstop for same-boot PID reuse
const BACKOFF_BASE_MS = 200; // base backoff: 200ms * attempt + jitter
// Boot time is derived from os.uptime(), which has second resolution and can drift
// slightly under clock adjustments — only treat a difference beyond this as a reboot.
const BOOT_DRIFT_TOLERANCE_SEC = 120;

// ─── Helper: normalize and hash baseUrl to lock key ────────────────────────────
function providerKeyFromUrl(baseUrl) {
  // Extract protocol, host, and path from the baseUrl
  // E.g., "https://api.together.xyz/v1" -> "api-together-xyz-v1"
  try {
    const url = new URL(baseUrl);
    const hostPart = url.hostname.replace(/\./g, '-'); // api.together.xyz -> api-together-xyz
    const pathPart = url.pathname.replace(/^\//, '').replace(/\//g, '-') || 'root'; // /v1 -> v1
    return `${hostPart}-${pathPart}`.toLowerCase();
  } catch (_) {
    // Fallback for invalid URLs: hash the baseUrl
    const hash = crypto.createHash('sha256').update(baseUrl).digest('hex').slice(0, 8);
    return `provider-${hash}`;
  }
}

// ─── Helper: check if a process is running ────────────────────────────────────
function isProcessRunning(pid) {
  // A non-positive / non-integer PID can never identify a live process.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // process.kill(pid, 0) returns nothing if process exists, throws if not
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH → no such process. EPERM → the process exists but is owned by another
    // user; it is still alive, so its lock must NOT be reclaimed as stale.
    return !!err && err.code === 'EPERM';
  }
}

// ─── Helper: approximate system boot time (epoch seconds) ──────────────────────
// PIDs are reused after a reboot, so a stale lock from a previous boot can carry a
// PID that now belongs to an unrelated live process. Comparing boot times catches
// that case regardless of PID liveness.
function currentBootTimeSec() {
  return Math.floor(Date.now() / 1000 - os.uptime());
}

// ─── Helper: decide whether a parsed lock file is stale ────────────────────────
function isLockStale(content, bootNow) {
  // Holder process is gone — the most common stale case (crash / SIGKILL).
  if (!isProcessRunning(content && content.pid)) return true;

  // Lock recorded a boot time that differs from the current boot → it predates a
  // reboot, so its still-"alive" PID has almost certainly been reused.
  const lockBoot = content && content.bootTime;
  if (Number.isInteger(lockBoot) &&
      Math.abs(lockBoot - bootNow) > BOOT_DRIFT_TOLERANCE_SEC) {
    return true;
  }

  // TTL backstop: covers PID reuse within the same boot (no reboot, dead holder's
  // PID handed to a live process). A missing/unparseable timestamp counts as old.
  const parsedTs = Date.parse(content && content.ts);
  const ageMs = Number.isNaN(parsedTs) ? Infinity : Date.now() - parsedTs;
  return ageMs > STALE_TTL_MS;
}

// ─── Helper: clean up stale lock files ────────────────────────────────────────
function cleanupStaleLocks(providerKey, maxConcurrency) {
  try {
    const bootNow = currentBootTimeSec();
    // Check all slots for this provider
    for (let i = 0; i < maxConcurrency; i++) {
      const lockPath = path.join(LOCK_DIR, `${providerKey}-${i}.lock`);
      if (!fs.existsSync(lockPath)) continue;

      try {
        const content = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (isLockStale(content, bootNow)) {
          fs.unlinkSync(lockPath);
        }
      } catch (_) {
        // Malformed lock file (or it vanished mid-read) — remove it.
        try { fs.unlinkSync(lockPath); } catch (_) {}
      }
    }
  } catch (err) {
    // Cleanup errors are non-fatal — log but continue
    process.stderr.write(`[provider-concurrency] cleanup error: ${err}\n`);
  }
}

// ─── Acquire a slot with staggered backoff ─────────────────────────────────────
function acquireSlot(providerKey, maxConcurrency, timeoutMs) {
  // Fail-open pattern: any error returns acquired:true (proceed without lock)
  try {
    // Ensure lock directory exists
    if (!fs.existsSync(LOCK_DIR)) {
      fs.mkdirSync(LOCK_DIR, { recursive: true });
    }

    // Try to acquire an available slot with staggered backoff
    const startTime = Date.now();
    let attempt = 0;

    while (true) {
      // Reclaim stale locks on EVERY pass — not just once up front. A slot freed
      // by a holder that crashed while we were already waiting becomes available
      // within one backoff cycle instead of blocking until our timeout.
      cleanupStaleLocks(providerKey, maxConcurrency);

      // Try each slot in order
      for (let slotIndex = 0; slotIndex < maxConcurrency; slotIndex++) {
        const lockPath = path.join(LOCK_DIR, `${providerKey}-${slotIndex}.lock`);

        // Try to create the lock file exclusively (fail if exists)
        try {
          const lockContent = JSON.stringify({
            pid: process.pid,
            ts: new Date().toISOString(),
            bootTime: currentBootTimeSec(),
            slot: `${providerKey}-${slotIndex}`,
          });
          fs.writeFileSync(lockPath, lockContent, { flag: 'wx' }); // wx = write exclusive

          // Successfully acquired
          return {
            acquired: true,
            slotIndex,
            release: () => {
              try {
                fs.unlinkSync(lockPath);
              } catch (_) {
                // Idempotent: double-release is safe
              }
            },
          };
        } catch (err) {
          // EEXIST = slot occupied, try next slot
          if (err.code === 'EEXIST') continue;
          // Other errors are non-fatal in fail-open mode
          throw err;
        }
      }

      // All slots occupied — wait with backoff
      const elapsedMs = Date.now() - startTime;
      if (elapsedMs >= timeoutMs) {
        // Timeout — return fail-open (proceed without lock)
        return {
          acquired: true,
          slotIndex: null,
          release: () => {}, // no-op
        };
      }

      // Staggered backoff: 200ms * attempt + jitter (0-100ms)
      const delayMs = BACKOFF_BASE_MS * (attempt + 1) + Math.random() * 100;
      const remainingMs = timeoutMs - elapsedMs;
      const actualDelayMs = Math.min(delayMs, remainingMs);

      // Sleep synchronously using busy-wait (non-blocking version would need async)
      // For simplicity and synchronous API, we use setTimeout's event loop
      const deadline = Date.now() + actualDelayMs;
      while (Date.now() < deadline) {
        // Busy-wait — fs operations implicitly yield
      }

      attempt++;
    }
  } catch (err) {
    // Fail-open: any error returns acquired:true (proceed without lock)
    // This ensures concurrency control failures never block dispatch
    return {
      acquired: true,
      slotIndex: null,
      release: () => {}, // no-op
    };
  }
}

// ─── Release a slot by removing its lock file ──────────────────────────────────
function releaseSlot(providerKey, slotIndex) {
  // Fail-open: release errors never throw
  try {
    if (slotIndex === null) return; // Was acquired without lock (fail-open path)
    const lockPath = path.join(LOCK_DIR, `${providerKey}-${slotIndex}.lock`);
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch (_) {
    // Non-fatal — fail-open
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────────
module.exports = {
  acquireSlot,
  releaseSlot,
  providerKeyFromUrl,
};

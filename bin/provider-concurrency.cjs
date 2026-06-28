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
 *   - acquireSlot(providerKey, maxConcurrency, timeoutMs): async — acquire a slot
 *   - releaseSlot(providerKey, slotIndex): pid-checked release of a slot
 *   - providerKeyFromUrl(baseUrl): derive a lock key from a provider baseUrl
 *
 * acquireSlot is async: the inter-attempt wait is `await setTimeout` (not a busy-
 * wait), so it yields the event loop and never pins a core or starves the I/O
 * callback that would release the slot it is waiting for.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ─── Config ────────────────────────────────────────────────────────────────────
const LOCK_DIR = path.join(os.tmpdir(), 'nf-provider-locks');
// STALE_TTL_MS must stay strictly ABOVE the maximum quorum request timeout, otherwise
// a lock can be reclaimed mid-flight while its holder is still legitimately waiting on
// the HTTP response. The longest acquire/dispatch timeout in the codebase is ~5 min, so
// 10 min leaves a safe margin while still bounding same-boot PID-reuse exposure.
const STALE_TTL_MS = 10 * 60 * 1000; // 10 minutes — strictly > max request timeout
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
    // Fallback for invalid URLs (incl. null/undefined/non-string): hash a string form.
    const hash = crypto.createHash('sha256').update(String(baseUrl)).digest('hex').slice(0, 8);
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
          // Rename-then-verify reclaim. A bare read-judge-unlink races a fresh
          // acquirer: between our stale verdict and the unlink, the original holder
          // could release and a new holder write a live lock at the same path — and
          // we would delete that live lock, admitting two holders to one slot.
          // Instead, atomically rename the suspect lock out of the way (rename is the
          // exclusive claim here), re-read the renamed file, and only delete it if it
          // STILL matches the stale verdict. If the file changed (or rename failed
          // because someone already replaced it), we leave the live lock untouched.
          const reclaimPath = `${lockPath}.reclaim.${process.pid}.${Date.now()}`;
          try {
            fs.renameSync(lockPath, reclaimPath);
          } catch (_) {
            // Lost the race (file vanished or was replaced) — nothing to reclaim.
            continue;
          }
          try {
            const recheck = JSON.parse(fs.readFileSync(reclaimPath, 'utf8'));
            if (isLockStale(recheck, bootNow)) {
              fs.unlinkSync(reclaimPath); // confirmed stale → free the slot
            } else {
              // It became live between read and rename — restore it.
              try { fs.renameSync(reclaimPath, lockPath); } catch (_) {
                try { fs.unlinkSync(reclaimPath); } catch (_) {}
              }
            }
          } catch (_) {
            // Renamed file is unreadable/gone — it was at best a malformed stale lock.
            try { fs.unlinkSync(reclaimPath); } catch (_) {}
          }
        }
      } catch (_) {
        // Unparseable lock. With atomic link-publish above, a live lock is never
        // visible half-written, so this is a genuinely corrupt leftover — but never
        // naive-unlink it (that was the over-admission race): rename it out of the
        // way to claim it exclusively, then drop the renamed copy. If the rename
        // loses (someone already replaced the path with a fresh live lock), leave it.
        const reclaimPath = `${lockPath}.reclaim.${process.pid}.${i}`;
        try {
          fs.renameSync(lockPath, reclaimPath);
          try { fs.unlinkSync(reclaimPath); } catch (_) {}
        } catch (_) { /* lost the race — a live lock now sits at lockPath; leave it */ }
      }
    }
  } catch (err) {
    // Cleanup errors are non-fatal — log but continue
    process.stderr.write(`[provider-concurrency] cleanup error: ${err}\n`);
  }
}

// ─── Helper: async sleep that yields the event loop ────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Helper: pid-checked release — unlink only if WE still hold the lock ────────
// A bare unlink-by-path frees whatever lock sits at the path, even one that a
// stale-reclaim handed to a different holder after ours expired. Read the lock
// first and only remove it when its pid + slot match this process.
function releaseOwnLock(lockPath, providerKey, slotIndex) {
  try {
    const content = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (content && content.pid === process.pid &&
        content.slot === `${providerKey}-${slotIndex}`) {
      fs.unlinkSync(lockPath);
    }
    // Not ours (reclaimed + re-acquired by someone else) — leave it alone.
  } catch (_) {
    // Missing/malformed → nothing of ours to remove. Idempotent.
  }
}

// ─── Acquire a slot with staggered backoff (async) ─────────────────────────────
// Async so the inter-attempt wait yields the event loop (callers are already
// async). A synchronous busy-wait pinned a core at 100% and could starve the very
// I/O callback that releases the lock we are waiting on.
async function acquireSlot(providerKey, maxConcurrency, timeoutMs) {
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

        // Atomically create the lock file exclusively AND fully-formed.
        // A plain writeFileSync(..., {flag:'wx'}) creates the file and THEN writes
        // content in separate steps, so a concurrent cleanupStaleLocks could read it
        // mid-write, see partial/empty JSON, judge it "malformed", and delete this
        // live lock — admitting two holders to one slot. Instead write the full
        // content into a private temp file first, then linkSync it into place:
        // linkSync is atomic and exclusive (EEXIST if the slot is taken), and the
        // lock only ever becomes visible already complete.
        const tmpPath = `${lockPath}.new.${process.pid}.${slotIndex}`;
        try {
          const lockContent = JSON.stringify({
            pid: process.pid,
            ts: new Date().toISOString(),
            bootTime: currentBootTimeSec(),
            slot: `${providerKey}-${slotIndex}`,
          });
          fs.writeFileSync(tmpPath, lockContent); // fully written before it is visible
          fs.linkSync(tmpPath, lockPath);         // atomic exclusive publish (EEXIST if taken)
          fs.unlinkSync(tmpPath);                 // tmp no longer needed; lock lives at lockPath

          // Successfully acquired
          return {
            acquired: true,
            slotIndex,
            release: () => releaseOwnLock(lockPath, providerKey, slotIndex),
          };
        } catch (err) {
          try { fs.unlinkSync(tmpPath); } catch (_) {} // never leak the temp file
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

      // Yield the event loop for the backoff window. Critically non-blocking: a
      // SIGKILLed holder's lock is reclaimed by another waiter's I/O, and the HTTP
      // response that releases the slot we want can fire while we wait here.
      await sleep(actualDelayMs);

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
    // pid-checked: only remove the lock if it is still ours — never a lock that a
    // stale-reclaim has since handed to a different live holder.
    releaseOwnLock(lockPath, providerKey, slotIndex);
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

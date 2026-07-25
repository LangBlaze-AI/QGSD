'use strict';

/**
 * bin/quorum-sessions-store.cjs — per-slot, per-invocation session marker.
 *
 * Layout: <repo>/.planning/quorum/sessions/<slot>-<invocation>.json
 *   {
 *     "family":     "codex",
 *     "thread_id":  "019f98e2-...",     // codex only; null for CWD-scoped families
 *     "started_at": "2026-07-25T...",
 *     "round":      2                  // last round completed
 *   }
 *
 * round-1:  write the file (no thread_id until parseSessionId runs).
 * round-2+: read the file, pass thread_id to buildResumeArgv.
 * terminal:  delete the file (convergence or escalation).
 *
 * SAFETY: written under .planning/, which is gitignored or local-only. The file
 * never contains model responses — only a session identifier. No secret risk.
 */

const fs = require('fs');
const path = require('path');

function sessionsDir(repoDir) {
  return path.join(repoDir || process.cwd(), '.planning', 'quorum', 'sessions');
}

function sessionPath(repoDir, slotName, invocationId) {
  return path.join(sessionsDir(repoDir), `${slotName}-${invocationId}.json`);
}

function read(repoDir, slotName, invocationId) {
  try {
    return JSON.parse(fs.readFileSync(sessionPath(repoDir, slotName, invocationId), 'utf8'));
  } catch (_) { return null; }
}

/**
 * Best-effort GC: remove session files older than `maxAgeMs` (default 24h).
 * Fail-open: any IO error is swallowed. Runs synchronously, called once per
 * call-quorum-slot invocation to keep the .planning/quorum/sessions/ directory
 * from growing unbounded across many invocations.
 */
function gcStale(repoDir, maxAgeMs = 24 * 3600 * 1000) {
  const dir = sessionsDir(repoDir);
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return 0; }
  const now = Date.now();
  let removed = 0;
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    const fp = path.join(dir, f);
    try {
      const st = fs.statSync(fp);
      if (now - st.mtimeMs > maxAgeMs) { fs.unlinkSync(fp); removed++; }
    } catch (_) { /* skip */ }
  }
  return removed;
}

function write(repoDir, slotName, invocationId, record) {
  const dir = sessionsDir(repoDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sessionPath(repoDir, slotName, invocationId), JSON.stringify(record, null, 2));
}

function del(repoDir, slotName, invocationId) {
  try { fs.unlinkSync(sessionPath(repoDir, slotName, invocationId)); } catch (_) {}
}

/** Delete every session file for a given invocation (terminal cleanup). */
function cleanup(repoDir, invocationId) {
  const dir = sessionsDir(repoDir);
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(`-${invocationId}.json`)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
      }
    }
  } catch (_) { /* dir may not exist */ }
}

module.exports = { sessionsDir, sessionPath, read, write, del, cleanup, gcStale };

#!/usr/bin/env node
'use strict';

/**
 * delegate-session-store.cjs — worker-session persistence (piece #2).
 *
 * Piece #1 (delegate-session.cjs) captures a worker's session id per call. This
 * remembers, across the manager's own steps/turns, WHICH session id belongs to an
 * in-flight delegated task — keyed by a stable task identifier (e.g. a quick-task
 * slug). So a multi-step delegated task can resume the SAME worker even across a
 * context compaction or a separate nf:quick invocation, instead of starting cold.
 *
 * Store shape: { version: 1, sessions: { <taskKey>: { session_id, family, cwd,
 *   step_count, created_at, updated_at } } }. Fail-open: a missing/corrupt file
 *   reads as empty. Session ids are ephemeral/per-machine → the file is gitignored.
 *
 * PURE  : getSession, recordStep, clearSession
 * IMPURE: loadStore, saveStore, updateSession (load→record→save convenience)
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_STORE_PATH = '.planning/delegate-sessions.json';

function emptyStore() { return { version: 1, sessions: {} }; }

/** IMPURE — read the store; fail-open to empty on missing/corrupt/wrong-shape. */
function loadStore(storePath = DEFAULT_STORE_PATH) {
  try {
    if (!fs.existsSync(storePath)) return emptyStore();
    const j = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    // typeof [] === 'object', so an array-shaped `sessions` must be rejected explicitly.
    if (!j || typeof j !== 'object' || !j.sessions || typeof j.sessions !== 'object' || Array.isArray(j.sessions)) {
      return emptyStore();
    }
    return j;
  } catch (_) {
    return emptyStore(); // corrupt JSON must not crash the delegation step
  }
}

/** IMPURE — persist the store (creates the parent dir). */
function saveStore(storePath, store) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store || emptyStore(), null, 2) + '\n', 'utf8');
}

/** PURE — the session record for a task key, or null. */
function getSession(store, taskKey) {
  if (!store || !store.sessions || !taskKey) return null;
  return store.sessions[taskKey] || null;
}

/**
 * PURE — return a NEW store with one worker step recorded for taskKey. Increments
 * step_count and refreshes session_id/family/cwd (keeping prior values when a field
 * is omitted). Does not mutate the input.
 * @param {object} store
 * @param {string} taskKey
 * @param {{session_id?:string, family?:string, cwd?:string}} info
 * @param {string} nowIso - timestamp (injected for determinism)
 */
function recordStep(store, taskKey, info = {}, nowIso) {
  const base = (store && store.sessions && typeof store.sessions === 'object') ? store : emptyStore();
  const prev = base.sessions[taskKey] || { step_count: 0, created_at: nowIso };
  return {
    version: base.version || 1,
    sessions: {
      ...base.sessions,
      [taskKey]: {
        session_id: info.session_id || prev.session_id || null,
        family: info.family || prev.family || null,
        cwd: info.cwd || prev.cwd || null,
        step_count: (prev.step_count || 0) + 1,
        created_at: prev.created_at || nowIso,
        updated_at: nowIso,
      },
    },
  };
}

/** PURE — return a NEW store with taskKey removed. */
function clearSession(store, taskKey) {
  if (!store || !store.sessions || !(taskKey in store.sessions)) return store || emptyStore();
  const sessions = { ...store.sessions };
  delete sessions[taskKey];
  return { version: store.version || 1, sessions };
}

/**
 * IMPURE — load→recordStep→save in one call. Returns the recorded session record.
 * @returns {{session_id, family, cwd, step_count, created_at, updated_at}}
 */
function updateSession(storePath, taskKey, info, nowIso = new Date().toISOString()) {
  const store = loadStore(storePath);
  const next = recordStep(store, taskKey, info, nowIso);
  saveStore(storePath, next);
  return next.sessions[taskKey];
}

module.exports = {
  DEFAULT_STORE_PATH,
  emptyStore,
  loadStore,
  saveStore,
  getSession,
  recordStep,
  clearSession,
  updateSession,
};

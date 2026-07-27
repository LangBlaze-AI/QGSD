'use strict';

/**
 * bin/quorum-resume.cjs — opt-in thread persistence for the quorum loop.
 *
 * By default the quorum is STATELESS: each round spawns a fresh CLI invocation
 * with prior-round outputs spliced into the prompt. That's the documented CE-5
 * semantics ("the team has nothing left to add" — the convergence check diffs
 * the orchestrator-injected prompt state, not thread memory).
 *
 * With quorum.persistent_threads = true, this module enables per-slot CLI session
 * continuity:
 *   - codex:  uses `codex exec resume <thread_id>` after the first round
 *   - claude: uses `-p --resume <session_id>` after the first round
 *   - agy:    uses `-c` (CWD-scoped continue, no id needed)
 *   - kimi:   uses `-c` (CWD-scoped continue, no id needed)
 *
 * Other families fall back to stateless. The convergence check is unchanged
 * because it still diffs prompt-injected state — thread memory is an ADDITIONAL
 * layer, not a replacement.
 *
 * SAFETY: opt-in via config flag. Default false. No behavior change for callers
 * who don't set the flag.
 */

const fs = require('fs');
const path = require('path');

// ── Per-family resume registry ────────────────────────────────────────────────
// freshArgs  : round 1 (or stateless path)
// resumeArgs : round 2+
// parseId    : extract session id from round-1 stdout (null = no id needed, CWD-scoped)
// supportsSession : does this family have a resume mechanism at all?
const QUORUM_RESUME = {
  codex: {
    supportsSession: true,
    freshArgs: (prompt) => ['exec', '--json', '--skip-git-repo-check', prompt],
    resumeArgs: (prompt, sessionId) => ['exec', 'resume', sessionId, '--json', '--skip-git-repo-check', prompt],
    parseId: parseCodexJsonlId,
  },
  claude: {
    supportsSession: true,
    freshArgs: (prompt) => ['-p', prompt],
    resumeArgs: (prompt, sessionId) => ['-p', '--resume', sessionId, prompt],
    parseId: parseClaudeJsonId,
  },
  agy: {
    supportsSession: true,
    freshArgs: (prompt) => ['-p', prompt],
    resumeArgs: (prompt /* sessionId unused */) => ['-c', '-p', prompt],
    parseId: () => null,
  },
  kimi: {
    supportsSession: true,
    freshArgs: (prompt) => ['-p', prompt],
    resumeArgs: (prompt) => ['-c', '-p', prompt],
    parseId: () => null,
  },
};

function parseCodexJsonlId(stdout) {
  for (const line of String(stdout || '').split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    try {
      const ev = JSON.parse(t);
      if (ev.type === 'thread.started' && ev.thread_id) return ev.thread_id;
    } catch (_) { /* skip non-JSON lines */ }
  }
  return null;
}

function parseClaudeJsonId(stdout) {
  const raw = String(stdout || '');
  const i = raw.indexOf('{');
  if (i < 0) return null;
  try {
    const j = JSON.parse(raw.slice(i));
    return j.session_id || null;
  } catch (_) { return null; }
}

/**
 * PURE — given a family and an existing session id, return the argv fragment
 * to insert into the slot's spawn argv (right after the family binary).
 * Returns [] if the family doesn't support resume or if the session id is absent.
 */
/**
 * buildResumeArgv — return the COMPLETE resume argv for the family.
 *
 * Caller (call-quorum-slot.cjs) replaces argsTemplate with this when persistent
 * threads are enabled. The returned argv includes the `{prompt}` placeholder so the
 * existing substitution loop handles it uniformly. Lengths may differ from the
 * fresh args_template — that's expected; resume forms have different verb structures.
 */
function buildResumeArgv(family, prompt, sessionId) {
  const cap = QUORUM_RESUME[family];
  if (!cap || !cap.supportsSession) return [];
  if (family === 'agy' || family === 'kimi') {
    // CWD-scoped — no id needed; `-c` plus the original prompt form.
    return ['-c', '-p', '{prompt}'];
  }
  if (!sessionId) return [];
  // codex:  ['exec', 'resume', <id>, '--json', '--skip-git-repo-check', '{prompt}']
  // claude: ['-p', '--resume', <id>, '{prompt}']
  if (family === 'codex') return ['exec', 'resume', sessionId, '--json', '--skip-git-repo-check', '{prompt}'];
  if (family === 'claude') return ['-p', '--resume', sessionId, '{prompt}'];
  return [];
}

/**
 * PURE — parse a round-1 stdout for a session id, per family.
 */
function parseSessionId(family, stdout) {
  const cap = QUORUM_RESUME[family];
  if (!cap || !cap.parseId) return null;
  return cap.parseId(stdout);
}

module.exports = { QUORUM_RESUME, buildResumeArgv, parseSessionId };

#!/usr/bin/env node
'use strict';

/**
 * delegate-loop.cjs — worker + auditor orchestration (piece #4).
 *
 * Ties pieces #1–3 into one delegated step:
 *   1. WORKER (resumable session) implements the step goal, editing files.
 *   2. Capture + persist the worker's session id (store, piece #2).
 *   3. AUDITOR (fresh, independent, read-only) reviews the resulting git diff.
 *   4. DECIDE — APPROVE → accept; REVISE → send the issues back to the SAME worker
 *      session and re-audit (up to maxRevisions); BLOCK → stop.
 *
 * The manager (Claude) decomposes a task into steps and calls runDelegatedStep per
 * step; this module owns the worker↔auditor cycle for one step. Every subprocess/IO
 * dependency is injectable, so the whole loop is unit-testable without a live model.
 *
 * PURE  : decideNext, buildRevisePrompt
 * IMPURE: gitDiff, runDelegatedStep
 */

const { spawnSync } = require('child_process');
const { runWorkerStep } = require('./delegate-session.cjs');
const { runAudit } = require('./delegate-auditor.cjs');
const sessionStore = require('./delegate-session-store.cjs');

/**
 * PURE — decide what to do after an audit verdict.
 * @returns {'accept'|'block'|'revise'|'exhausted'}
 */
function decideNext(verdict, revisions, maxRevisions) {
  if (verdict === 'APPROVE') return 'accept';
  if (verdict === 'BLOCK') return 'block';
  // REVISE (or anything unrecognized — auditor already fails safe to REVISE)
  return revisions >= maxRevisions ? 'exhausted' : 'revise';
}

/**
 * PURE — the worker's follow-up prompt after a REVISE, carrying the auditor's issues.
 */
function buildRevisePrompt(issues, stepGoal) {
  const lines = ['An independent auditor reviewed your last change and requires revisions.'];
  if (stepGoal) lines.push('Original step goal: ' + stepGoal);
  lines.push('Fix EACH issue below in the same files, then reply DONE:');
  for (const i of (Array.isArray(issues) ? issues : [])) lines.push('- ' + i);
  if (!issues || issues.length === 0) lines.push('- (auditor gave no specifics — re-check correctness and completeness)');
  return lines.join('\n');
}

/**
 * IMPURE — unified git diff (staged+unstaged) of the working tree in cwd.
 */
function gitDiff(cwd, spawnSyncFn = spawnSync) {
  try {
    const r = spawnSyncFn('git', ['--no-pager', 'diff', 'HEAD', '--no-color'], {
      cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 10 * 1024 * 1024,
    });
    const out = (r && r.stdout) ? r.stdout : '';
    return out.trim() ? out : '(no diff)';
  } catch (_) {
    return '(diff unavailable)';
  }
}

/**
 * IMPURE — orchestrate one delegated step: worker → audit → (revise loop) → decide.
 *
 * @param {object} opts
 * @param {string} opts.taskKey        - stable id for the in-flight task (store key)
 * @param {string} opts.stepGoal       - what the worker should accomplish this step
 * @param {string} [opts.workerFamily='codex']
 * @param {string} [opts.auditorFamily='claude']  - MUST differ from worker for independence
 * @param {string} [opts.cwd]
 * @param {string} [opts.storePath]
 * @param {number} [opts.maxRevisions=2]
 * @param {string} [opts.taskContext]
 * Injectables (tests): workerFn, auditFn, diffFn, storeApi, now
 * @returns {Promise<object>} { decision, verdict, session_id, diff, audit, revisions, history }
 */
async function runDelegatedStep(opts = {}) {
  const {
    taskKey, stepGoal,
    workerFamily = 'codex', auditorFamily = 'claude',
    cwd = process.cwd(), storePath = sessionStore.DEFAULT_STORE_PATH,
    maxRevisions = 2, taskContext,
    workerFn = runWorkerStep, auditFn = runAudit, diffFn = gitDiff,
    storeApi = sessionStore, now = () => new Date().toISOString(),
    workerTimeout, auditTimeout,
  } = opts;

  if (auditorFamily === workerFamily) {
    // Not fatal, but the auditor's value comes from independence — surface it.
    process.stderr.write('[delegate-loop] WARNING: auditorFamily === workerFamily — the audit is not independent\n');
  }

  const initial = storeApi.getSession(storeApi.loadStore(storePath), taskKey) || {};
  let sessionId = initial.session_id || null;
  let prompt = stepGoal;
  let revisions = 0;
  const history = [];

  while (true) {
    const w = await workerFn({ family: workerFamily, prompt, cwd, sessionId, timeout: workerTimeout });
    sessionId = w.session_id || sessionId;
    // Persist the (possibly newly-captured) session id after every worker turn.
    try { storeApi.updateSession(storePath, taskKey, { session_id: sessionId, family: workerFamily, cwd }, now()); } catch (_) { /* store is best-effort */ }

    if (!w || w.status !== 'ok') {
      return { decision: 'worker_error', verdict: null, session_id: sessionId, worker_error: (w && w.error) || 'unknown', revisions, history };
    }

    const diff = diffFn(cwd);
    const audit = await auditFn({ family: auditorFamily, stepGoal, diff, taskContext, cwd, timeout: auditTimeout });
    history.push({ revision: revisions, verdict: audit.verdict, issues: audit.issues, summary: audit.summary });

    const next = decideNext(audit.verdict, revisions, maxRevisions);
    if (next === 'accept')    return { decision: 'accepted',  verdict: 'APPROVE', session_id: sessionId, diff, audit, revisions, history };
    if (next === 'block')     return { decision: 'blocked',   verdict: 'BLOCK',   session_id: sessionId, diff, audit, revisions, history };
    if (next === 'exhausted') return { decision: 'exhausted', verdict: 'REVISE',  session_id: sessionId, diff, audit, revisions, history };

    // revise → same worker session, next turn
    revisions += 1;
    prompt = buildRevisePrompt(audit.issues, stepGoal);
  }
}

module.exports = { decideNext, buildRevisePrompt, gitDiff, runDelegatedStep };

// ── CLI: one delegated step ────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (f, d) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
  runDelegatedStep({
    taskKey: get('--task-key', 'adhoc'),
    stepGoal: get('--goal', ''),
    workerFamily: get('--worker', 'codex'),
    auditorFamily: get('--auditor', 'claude'),
    cwd: get('--cwd', process.cwd()),
    maxRevisions: parseInt(get('--max-revisions', '2'), 10),
    taskContext: get('--context', undefined),
  }).then((r) => {
    process.stdout.write(JSON.stringify({ decision: r.decision, verdict: r.verdict, revisions: r.revisions, session_id: r.session_id, history: r.history }, null, 2) + '\n');
    process.exit(r.decision === 'accepted' ? 0 : 1);
  }).catch((e) => { process.stderr.write('[delegate-loop] ' + e.message + '\n'); process.exit(2); });
}

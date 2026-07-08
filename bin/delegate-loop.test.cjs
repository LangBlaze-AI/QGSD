'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { decideNext, buildRevisePrompt, runDelegatedStep } = require('./delegate-loop.cjs');

describe('decideNext (pure)', () => {
  it('APPROVE → accept', () => assert.equal(decideNext('APPROVE', 0, 2), 'accept'));
  it('BLOCK → block (even at revision 0)', () => assert.equal(decideNext('BLOCK', 0, 2), 'block'));
  it('REVISE under the cap → revise', () => assert.equal(decideNext('REVISE', 1, 2), 'revise'));
  it('REVISE at the cap → exhausted', () => assert.equal(decideNext('REVISE', 2, 2), 'exhausted'));
  it('unrecognized verdict is treated as revise (auditor already fails safe)', () => assert.equal(decideNext('???', 0, 2), 'revise'));
});

describe('buildRevisePrompt (pure)', () => {
  it('lists each issue and restates the goal', () => {
    const p = buildRevisePrompt(['fix A', 'fix B'], 'add guard');
    assert.match(p, /independent auditor/);
    assert.match(p, /Original step goal: add guard/);
    assert.match(p, /- fix A/);
    assert.match(p, /- fix B/);
  });
  it('handles an empty issue list gracefully', () => {
    assert.match(buildRevisePrompt([], 'g'), /re-check correctness/);
  });
});

// ── runDelegatedStep with injected worker/audit/diff/store ──────────────────────
function makeStore() {
  const mem = { version: 1, sessions: {} };
  return {
    DEFAULT_STORE_PATH: 'mem',
    loadStore: () => mem,
    getSession: (s, k) => mem.sessions[k] || null,
    updateSession: (_p, k, info) => { mem.sessions[k] = { ...(mem.sessions[k] || {}), ...info, step_count: ((mem.sessions[k] || {}).step_count || 0) + 1 }; return mem.sessions[k]; },
    _mem: mem,
  };
}
const okWorker = (session_id = 'W-1') => async () => ({ status: 'ok', session_id, text: 'DONE' });
const constAudit = (verdict, issues = []) => async () => ({ verdict, issues, summary: 's', status: 'ok' });

describe('runDelegatedStep (injected)', () => {
  it('worker ok + auditor APPROVE → accepted, 0 revisions, session persisted', async () => {
    const storeApi = makeStore();
    const r = await runDelegatedStep({
      taskKey: 't1', stepGoal: 'do X', cwd: '/repo', storeApi, now: () => 'NOW',
      workerFn: okWorker('W-1'), auditFn: constAudit('APPROVE'), diffFn: () => '+ change',
    });
    assert.equal(r.decision, 'accepted');
    assert.equal(r.revisions, 0);
    assert.equal(r.session_id, 'W-1');
    assert.equal(storeApi._mem.sessions['t1'].session_id, 'W-1', 'worker session persisted');
  });

  it('REVISE once then APPROVE → accepted after 1 revision; worker RESUMED with the revise prompt', async () => {
    const storeApi = makeStore();
    const prompts = [];
    const workerFn = async ({ prompt, sessionId }) => { prompts.push({ prompt, sessionId }); return { status: 'ok', session_id: 'W-1', text: 'DONE' }; };
    let n = 0;
    const auditFn = async () => (n++ === 0 ? { verdict: 'REVISE', issues: ['missing await'], summary: '', status: 'ok' } : { verdict: 'APPROVE', issues: [], status: 'ok' });
    const r = await runDelegatedStep({ taskKey: 't2', stepGoal: 'goal', storeApi, workerFn, auditFn, diffFn: () => 'd', now: () => 'NOW' });
    assert.equal(r.decision, 'accepted');
    assert.equal(r.revisions, 1);
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0].prompt, 'goal', 'first turn uses the step goal');
    assert.match(prompts[1].prompt, /missing await/, 'second turn sends the auditor issues');
    assert.equal(prompts[1].sessionId, 'W-1', 'second turn RESUMES the same worker session');
  });

  it('auditor keeps saying REVISE → exhausted at maxRevisions', async () => {
    const r = await runDelegatedStep({
      taskKey: 't3', stepGoal: 'g', storeApi: makeStore(), maxRevisions: 2,
      workerFn: okWorker(), auditFn: constAudit('REVISE', ['x']), diffFn: () => 'd', now: () => 'NOW',
    });
    assert.equal(r.decision, 'exhausted');
    assert.equal(r.revisions, 2);
    assert.equal(r.history.length, 3, 'initial + 2 revisions audited');
  });

  it('NaN maxRevisions is sanitized to the default (does NOT loop forever)', async () => {
    let calls = 0;
    const workerFn = async () => { calls++; return { status: 'ok', session_id: 'W', text: 'DONE' }; };
    const r = await runDelegatedStep({
      taskKey: 'nan', stepGoal: 'g', storeApi: makeStore(), maxRevisions: NaN,
      workerFn, auditFn: constAudit('REVISE', ['x']), diffFn: () => 'd', now: () => 'NOW',
    });
    assert.equal(r.decision, 'exhausted', 'must terminate, not spin');
    assert.equal(r.revisions, 2, 'falls back to default max of 2');
    assert.equal(calls, 3, 'initial + 2 revisions, then stop');
  });

  it('auditor BLOCK → blocked immediately', async () => {
    const r = await runDelegatedStep({
      taskKey: 't4', stepGoal: 'g', storeApi: makeStore(),
      workerFn: okWorker(), auditFn: constAudit('BLOCK', ['deletes a guard']), diffFn: () => 'd', now: () => 'NOW',
    });
    assert.equal(r.decision, 'blocked');
    assert.equal(r.revisions, 0);
  });

  it('worker error → worker_error (no audit attempted)', async () => {
    let audited = false;
    const r = await runDelegatedStep({
      taskKey: 't5', stepGoal: 'g', storeApi: makeStore(),
      workerFn: async () => ({ status: 'error', session_id: 'W-1', error: 'timeout' }),
      auditFn: async () => { audited = true; return constAudit('APPROVE')(); }, diffFn: () => 'd', now: () => 'NOW',
    });
    assert.equal(r.decision, 'worker_error');
    assert.match(r.worker_error, /timeout/);
    assert.equal(audited, false, 'no audit after a worker error');
  });
});

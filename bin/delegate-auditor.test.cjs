'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildAuditPrompt, parseAuditVerdict, runAudit } = require('./delegate-auditor.cjs');

describe('buildAuditPrompt', () => {
  it('includes the step goal, the diff, and a strict verdict-block instruction', () => {
    const p = buildAuditPrompt({ stepGoal: 'add null guard', diff: '- a\n+ b', taskContext: 'harden parser' });
    assert.match(p, /INDEPENDENT code auditor/);
    assert.match(p, /read-only review/);
    assert.match(p, /Step goal: add null guard/);
    assert.match(p, /- a\n\+ b/);
    assert.match(p, /harden parser/);
    assert.match(p, /VERDICT: <APPROVE\|REVISE\|BLOCK>/);
  });
  it('tolerates missing fields', () => {
    assert.doesNotThrow(() => buildAuditPrompt({}));
    assert.match(buildAuditPrompt({}), /\(empty diff\)/);
  });
});

describe('parseAuditVerdict', () => {
  it('parses APPROVE with no issues', () => {
    const r = parseAuditVerdict('Looks good.\nVERDICT: APPROVE\nISSUES:\n- none\nSUMMARY: correct and complete');
    assert.equal(r.verdict, 'APPROVE');
    assert.deepEqual(r.issues, []);
    assert.equal(r.summary, 'correct and complete');
    assert.equal(r.parsed, true);
  });
  it('parses REVISE with a list of concrete issues', () => {
    const r = parseAuditVerdict('VERDICT: REVISE\nISSUES:\n- missing await on line 12\n- test asserts nothing\nSUMMARY: two fixes needed');
    assert.equal(r.verdict, 'REVISE');
    assert.deepEqual(r.issues, ['missing await on line 12', 'test asserts nothing']);
  });
  it('parses BLOCK', () => {
    assert.equal(parseAuditVerdict('VERDICT: BLOCK\nISSUES:\n- deletes a security guard\nSUMMARY: unsafe').verdict, 'BLOCK');
  });
  it('scans the LAST verdict block if the model restates it', () => {
    const r = parseAuditVerdict('draft VERDICT: APPROVE ... on reflection:\nVERDICT: BLOCK\nISSUES:\n- regressions\nSUMMARY: no');
    assert.equal(r.verdict, 'BLOCK');
  });
  it('FAILS SAFE to REVISE when there is no verdict block (never silent APPROVE)', () => {
    const r = parseAuditVerdict('I think it is probably fine honestly');
    assert.equal(r.verdict, 'REVISE');
    assert.equal(r.parsed, false);
  });
});

describe('runAudit (injected runFn)', () => {
  it('dispatches a FRESH, READ-ONLY reviewer (no sessionId) and returns the parsed verdict', async () => {
    let seen;
    const runFn = async (opts) => { seen = opts; return { status: 'ok', text: 'VERDICT: APPROVE\nISSUES:\n- none\nSUMMARY: ok' }; };
    const r = await runAudit({ family: 'claude', stepGoal: 'g', diff: 'd', cwd: '/repo', runFn });
    assert.equal(r.verdict, 'APPROVE');
    assert.equal(r.status, 'ok');
    assert.equal(seen.family, 'claude');
    assert.equal(seen.sandbox, 'read-only', 'auditor must be read-only');
    assert.equal(seen.sessionId, undefined, 'auditor must be fresh (no session)');
  });
  it('a dead auditor fails safe to REVISE (never APPROVE)', async () => {
    const runFn = async () => ({ status: 'error', error: 'timeout' });
    const r = await runAudit({ family: 'claude', stepGoal: 'g', diff: 'd', runFn });
    assert.equal(r.verdict, 'REVISE');
    assert.equal(r.status, 'error');
    assert.match(r.issues[0], /auditor dispatch failed/);
  });
});

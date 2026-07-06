'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { detectSituation } = require('./smart-entry.cjs');

const P = (over) => ({ number: '1', disk_status: 'in-progress', plan_count: 0, summary_count: 0, roadmap_complete: false, ...over });

test('no roadmap + no phases → no-project', () => {
  const r = detectSituation({ roadmapExists: false, phases: [] });
  assert.strictEqual(r.situation, 'no-project');
  assert.strictEqual(r.actions[0].command, '/nf:new-project');
});

test('paused / blocked read from STATE take precedence', () => {
  assert.strictEqual(detectSituation({ roadmapExists: true, phases: [P()], stateText: 'Status: paused' }).situation, 'paused');
  assert.strictEqual(detectSituation({ roadmapExists: true, phases: [P()], stateText: 'BLOCKED on auth' }).situation, 'blocked');
});

test('active phase with no plan → planning (recommends plan-phase N)', () => {
  const r = detectSituation({ roadmapExists: true, phases: [P({ plan_count: 0 })] });
  assert.strictEqual(r.situation, 'planning');
  assert.ok(r.actions.some((a) => a.command === '/nf:plan-phase 1' && a.recommended));
});

test('planned but no summary → executing', () => {
  const r = detectSituation({ roadmapExists: true, phases: [P({ plan_count: 2, summary_count: 0 })] });
  assert.strictEqual(r.situation, 'executing');
  assert.strictEqual(r.actions[0].command, '/nf:execute-phase 1');
});

test('built but not verified → verify-pending; verify-failed → harden', () => {
  const base = P({ plan_count: 2, summary_count: 2 });
  assert.strictEqual(detectSituation({ roadmapExists: true, phases: [base], activeArtifacts: { hasVerification: false } }).situation, 'verify-pending');
  const vf = detectSituation({ roadmapExists: true, phases: [base], activeArtifacts: { hasVerification: true, verifyFailed: true } });
  assert.strictEqual(vf.situation, 'verify-failed');
  assert.strictEqual(vf.actions[0].command, '/nf:harden 1');
});

test('all complete → idle-stranded (or complete when STATE says so)', () => {
  const done = [{ number: '1', disk_status: 'complete', roadmap_complete: true }];
  assert.strictEqual(detectSituation({ roadmapExists: true, phases: done }).situation, 'idle-stranded');
  assert.strictEqual(detectSituation({ roadmapExists: true, phases: done, stateText: 'Milestone complete' }).situation, 'complete');
});

test('fusion: open formal gaps add a close-formal-gaps action to any in-project situation', () => {
  const r = detectSituation({ roadmapExists: true, phases: [P({ plan_count: 2, summary_count: 0 })], formalGaps: 3 });
  assert.ok(r.actions.some((a) => a.command === '/nf:close-formal-gaps' && /3 open formal/.test(a.label)));
});

test('every situation always includes /nf:progress (never strands the user)', () => {
  for (const ctx of [{ roadmapExists: false, phases: [] }, { roadmapExists: true, phases: [P()] }]) {
    assert.ok(detectSituation(ctx).actions.some((a) => a.command === '/nf:progress'));
  }
});

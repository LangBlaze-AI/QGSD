#!/usr/bin/env node
'use strict';
// bin/daintree-fleet.test.cjs
// Unit tests for the Daintree fleet-substrate helper (#405).
// Each test names the measured failure it prevents.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  BOX_TAIL_LINES,
  extractPendingInput,
  assertWorkspace,
  classifyPane,
  sendGuard,
  interpretSendResult,
} = require('./daintree-fleet.cjs');

const NOW = 1_700_000_000_000;
const mins = (n) => NOW - n * 60000;

// A pane tail as actually rendered: input box, then separator, then status bar.
const STATUS_BAR = [
  '─────────────────────────────',
  '  ⬆ /nf:update │ Opus │ repo ███░░░ 31% (309K)',
  '  ● claude-1 │ ● codex-1 │ ● copilot-1',
  '  ⏵⏵ bypass permissions on · ← 1 agent',
  '                                      /rc',
];
const paneTail = (box) => ['  prior agent output line', '', '─────────────────────────────',
  `❯ ${box}`, ...STATUS_BAR].join('\n');

describe('extractPendingInput', () => {
  it('recovers unsubmitted text from the input box', () => {
    assert.strictEqual(extractPendingInput(paneTail('push it')), 'push it');
  });

  it('returns null for an empty box', () => {
    assert.strictEqual(extractPendingInput(paneTail('')), null);
  });

  it('MEASURED TRAP: a tail shorter than the status bar cannot see the box', () => {
    // The box renders ABOVE the status bar. Requesting too few lines returns a
    // window that excludes it, and the caller reads "no pending input" — which
    // is how six queued instructions stayed invisible for an hour.
    const full = paneTail('push it').split('\n');
    const tooShort = full.slice(-5).join('\n');   // status bar only
    const deepEnough = full.slice(-BOX_TAIL_LINES).join('\n');
    assert.strictEqual(extractPendingInput(tooShort), null, 'shallow tail must miss it');
    assert.strictEqual(extractPendingInput(deepEnough), 'push it', 'BOX_TAIL_LINES must reach it');
  });

  it('accepts array-shaped recentOutput', () => {
    assert.strictEqual(extractPendingInput(paneTail('go').split('\n')), 'go');
  });
});

describe('assertWorkspace', () => {
  const wrap = (id, path) => ({ _meta: { 'org.daintree/resolved-workspace': { workspaceId: id, workspacePath: path } } });

  it('passes when the resolved workspace matches', () => {
    assert.strictEqual(assertWorkspace(wrap('abc123', '/repo/a'), 'abc123').valid, true);
  });

  it('MEASURED TRAP: fails closed when the host flipped to another project', () => {
    const r = assertWorkspace(wrap('zzz999', '/other/project'), 'abc123');
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /workspace flip/);
    assert.match(r.error, /other\/project/);
  });

  it('is a no-op when no expectation is supplied', () => {
    assert.strictEqual(assertWorkspace(wrap('abc123', '/repo/a'), '').valid, true);
  });
});

describe('classifyPane', () => {
  const base = { terminalId: 'terminal-aaaaaaaa-1', title: 'IMPLEMENTER', agentState: 'waiting' };

  it('MEASURED TRAP: waiting + pending input is UNDELIVERED, never IDLE', () => {
    // agentState alone collapses these. Retasking on the IDLE reading overwrites
    // the instruction the agent was blocked on.
    const c = classifyPane({ ...base, lastTransitionAt: mins(12), recentOutput: paneTail('push it') }, NOW);
    assert.strictEqual(c.kind, 'UNDELIVERED');
    assert.strictEqual(c.pendingInput, 'push it');
    assert.match(c.action, /do NOT retask/);
  });

  it('waiting past threshold with an empty box is IDLE', () => {
    const c = classifyPane({ ...base, lastTransitionAt: mins(12), recentOutput: paneTail('') }, NOW);
    assert.strictEqual(c.kind, 'IDLE');
  });

  it('waiting under threshold is WORKING, not IDLE', () => {
    const c = classifyPane({ ...base, lastTransitionAt: mins(2), recentOutput: paneTail('') }, NOW);
    assert.strictEqual(c.kind, 'WORKING');
  });

  it('MEASURED TRAP: an empty scrollback is a DEAD pane even though the clock moved', () => {
    // lastTransitionAt advances on a dead pane, so it cannot establish liveness.
    const c = classifyPane({ ...base, lastTransitionAt: mins(1), recentOutput: '❯ ' }, NOW);
    assert.strictEqual(c.kind, 'DEAD');
  });

  it('a long-abandoned pane is DEAD regardless of content', () => {
    const c = classifyPane({ ...base, lastTransitionAt: mins(1200), recentOutput: paneTail('') }, NOW);
    assert.strictEqual(c.kind, 'DEAD');
  });

  it('honours a custom idle threshold', () => {
    const p = { ...base, lastTransitionAt: mins(6), recentOutput: paneTail('') };
    assert.strictEqual(classifyPane(p, NOW, { idleMinutes: 5 }).kind, 'IDLE');
    assert.strictEqual(classifyPane(p, NOW, { idleMinutes: 30 }).kind, 'WORKING');
  });
});

describe('sendGuard', () => {
  const classified = (kind, pendingInput = null) => ({ kind, pendingInput });

  it('MEASURED TRAP: refuses to overwrite pending input, and reports what it would destroy', () => {
    const g = sendGuard(classified('UNDELIVERED', 'push pr993-fix'));
    assert.strictEqual(g.allowed, false);
    assert.strictEqual(g.displaced, 'push pr993-fix');
    assert.match(g.reason, /discard/);
  });

  it('MEASURED TRAP: refuses a pane with no live agent', () => {
    const g = sendGuard(classified('DEAD'));
    assert.strictEqual(g.allowed, false);
    assert.match(g.reason, /shell command/);
  });

  it('allows an overwrite only when explicitly forced', () => {
    const g = sendGuard(classified('UNDELIVERED', 'keep sweeping'), { force: true });
    assert.strictEqual(g.allowed, true);
    assert.strictEqual(g.displaced, 'keep sweeping');
  });

  it('allows a clean send', () => {
    assert.strictEqual(sendGuard(classified('IDLE')).allowed, true);
  });
});

describe('interpretSendResult', () => {
  it('MEASURED TRAP: never reports delivery from an acknowledgement', () => {
    // {"sent": true} was returned for a dead pane, a flipped workspace, and text
    // that landed unsubmitted. Acknowledgement and delivery are different claims.
    const r = interpretSendResult({ sent: true });
    assert.strictEqual(r.acknowledged, true);
    assert.strictEqual(r.delivered, null);
    assert.match(r.note, /off-pane effect/);
  });

  it('treats a missing/false ack as not acknowledged', () => {
    assert.strictEqual(interpretSendResult(null).acknowledged, false);
    assert.strictEqual(interpretSendResult({}).acknowledged, false);
  });
});

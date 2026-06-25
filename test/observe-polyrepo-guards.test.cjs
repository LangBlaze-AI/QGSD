'use strict';

// Dogfood Batch 3c (F48): the observe pipeline and polyrepo crashed on wrong-shape
// state — a non-array `sources`/`results`/`debt_entries`/`repos`, a null session
// sourceConfig, or a session file with a null mtime (which threw INSIDE the
// handler's try/catch and silently discarded every detected issue). Each is guarded.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin');

describe('observe-render tolerates a non-array results', () => {
  const { renderObserveOutput } = require(path.join(BIN, 'observe-render.cjs'));
  it('does not crash on null / string', () => {
    assert.doesNotThrow(() => renderObserveOutput(null));
    assert.doesNotThrow(() => renderObserveOutput('not-an-array'));
  });
});

describe('observe-registry dispatchAll tolerates a non-array sources', () => {
  const { dispatchAll } = require(path.join(BIN, 'observe-registry.cjs'));
  it('returns without a .map crash on null', async () => {
    await assert.doesNotReject(() => dispatchAll(null, {}));
  });
});

describe('session-insights handler tolerates null config + null mtime', () => {
  const si = require(path.join(BIN, 'observe-handler-session-insights.cjs'));
  it('handleSessionInsights(null) does not crash', () => {
    assert.doesNotThrow(() => si.handleSessionInsights(null, {}));
  });
  it('analyzeSession survives a missing name / null mtime (no silent issue-drop crash)', () => {
    if (typeof si.analyzeSession !== 'function') return; // exported guard
    assert.doesNotThrow(() => si.analyzeSession({ name: undefined, mtime: null, content: '' }));
  });
});

describe('polyrepo loadGroup normalizes a non-array repos (no for-of/.length crash)', () => {
  it('a group whose repos is a string lists as 0 repos', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-poly-'));
    try {
      fs.mkdirSync(path.join(home, '.claude', 'polyrepos'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'polyrepos', 'g.json'), JSON.stringify({ name: 'g', repos: 'notarray' }));
      const out = execFileSync(process.execPath, [path.join(BIN, 'polyrepo.cjs'), 'list'], {
        encoding: 'utf8', env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.match(out, /g \(0 repos\)/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

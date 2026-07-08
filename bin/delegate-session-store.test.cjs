'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  emptyStore, loadStore, saveStore, getSession, recordStep, clearSession, updateSession,
} = require('./delegate-session-store.cjs');

const T = '2026-07-08T00:00:00.000Z';
const T2 = '2026-07-08T00:05:00.000Z';

describe('recordStep (pure)', () => {
  it('first step creates a record with step_count 1 and created_at', () => {
    const s = recordStep(emptyStore(), 'task-42', { session_id: 'S1', family: 'codex', cwd: '/repo' }, T);
    const rec = s.sessions['task-42'];
    assert.deepEqual(
      { session_id: rec.session_id, family: rec.family, cwd: rec.cwd, step_count: rec.step_count, created_at: rec.created_at, updated_at: rec.updated_at },
      { session_id: 'S1', family: 'codex', cwd: '/repo', step_count: 1, created_at: T, updated_at: T }
    );
  });

  it('second step increments step_count, keeps created_at, refreshes session_id + updated_at', () => {
    let s = recordStep(emptyStore(), 'task-42', { session_id: 'S1', family: 'codex', cwd: '/repo' }, T);
    s = recordStep(s, 'task-42', { session_id: 'S1' }, T2);
    const rec = s.sessions['task-42'];
    assert.equal(rec.step_count, 2);
    assert.equal(rec.created_at, T, 'created_at preserved');
    assert.equal(rec.updated_at, T2);
    assert.equal(rec.family, 'codex', 'omitted family kept from prior');
    assert.equal(rec.cwd, '/repo', 'omitted cwd kept from prior');
  });

  it('does not mutate the input store', () => {
    const before = emptyStore();
    const frozen = JSON.stringify(before);
    recordStep(before, 'k', { session_id: 'x' }, T);
    assert.equal(JSON.stringify(before), frozen);
  });

  it('tolerates a garbage store (fresh base)', () => {
    const s = recordStep(null, 'k', { session_id: 'x' }, T);
    assert.equal(s.sessions['k'].session_id, 'x');
  });
});

describe('getSession / clearSession (pure)', () => {
  it('getSession returns the record or null', () => {
    const s = recordStep(emptyStore(), 'a', { session_id: 'S' }, T);
    assert.equal(getSession(s, 'a').session_id, 'S');
    assert.equal(getSession(s, 'missing'), null);
    assert.equal(getSession(null, 'a'), null);
  });
  it('clearSession removes a key immutably', () => {
    const s = recordStep(emptyStore(), 'a', { session_id: 'S' }, T);
    const cleared = clearSession(s, 'a');
    assert.equal(getSession(cleared, 'a'), null);
    assert.equal(getSession(s, 'a').session_id, 'S', 'original untouched');
  });
});

describe('loadStore (fail-open)', () => {
  it('missing file → empty store', () => {
    assert.deepEqual(loadStore(path.join(os.tmpdir(), 'nope-' + Math.random().toString(36).slice(2))), emptyStore());
  });
  it('corrupt JSON → empty store (no throw)', () => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dss-')), 's.json');
    fs.writeFileSync(p, '{ not json');
    assert.deepEqual(loadStore(p), emptyStore());
  });
  it('wrong-shape JSON (no sessions object) → empty store', () => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dss-')), 's.json');
    fs.writeFileSync(p, '{"version":1,"sessions":[]}');
    assert.deepEqual(loadStore(p), emptyStore());
  });
});

describe('updateSession (round-trip)', () => {
  it('persists across steps and resumes the same session id', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-'));
    const p = path.join(dir, '.planning', 'delegate-sessions.json');
    const r1 = updateSession(p, 'quick-99', { session_id: 'SESS-A', family: 'codex', cwd: dir }, T);
    assert.equal(r1.step_count, 1);
    // Reload from disk (simulates a later manager turn) and resume.
    const reloaded = loadStore(p);
    assert.equal(getSession(reloaded, 'quick-99').session_id, 'SESS-A', 'session survives a reload');
    const r2 = updateSession(p, 'quick-99', { session_id: 'SESS-A' }, T2);
    assert.equal(r2.step_count, 2);
    assert.equal(loadStore(p).sessions['quick-99'].updated_at, T2);
  });
});

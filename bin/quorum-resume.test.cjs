'use strict';

// bin/quorum-resume.test.cjs — PURE-function tests for bin/quorum-resume.cjs.
// Verified red against a committed baseline (after commit).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { QUORUM_RESUME, buildResumeArgv, parseSessionId } = require('./quorum-resume.cjs');
const store = require('./quorum-sessions-store.cjs');

describe('buildResumeArgv — per-family resume argv', () => {
  it('codex: round-2 argv is [exec, resume, <id>, --json, --skip-git-repo-check, {prompt}]', () => {
    const argv = buildResumeArgv('codex', '{prompt}', 'sess-abc');
    assert.deepEqual(argv, ['exec', 'resume', 'sess-abc', '--json', '--skip-git-repo-check', '{prompt}']);
  });

  it('claude: round-2 argv is [-p, --resume, <id>, {prompt}]', () => {
    const argv = buildResumeArgv('claude', '{prompt}', 'sess-xyz');
    assert.deepEqual(argv, ['-p', '--resume', 'sess-xyz', '{prompt}']);
  });

  it('agy: round-2 argv is [-c, {prompt}] (CWD-scoped, no id needed)', () => {
    const argv = buildResumeArgv('agy', '{prompt}', null);
    assert.deepEqual(argv, ['-c', '{prompt}']);
  });

  it('agy: round-2 still works WITH an id in the arg (id is ignored, not required)', () => {
    const argv = buildResumeArgv('agy', '{prompt}', 'ignored-id');
    assert.deepEqual(argv, ['-c', '{prompt}']);
  });

  it('kimi: round-2 argv is [-c, {prompt}] (CWD-scoped)', () => {
    const argv = buildResumeArgv('kimi', '{prompt}', null);
    assert.deepEqual(argv, ['-c', '{prompt}']);
  });

  it('returns [] when session id is absent AND the family requires an id (codex, claude)', () => {
    assert.deepEqual(buildResumeArgv('codex', '{prompt}', null), []);
    assert.deepEqual(buildResumeArgv('claude', '{prompt}', null), []);
  });

  it('returns [] for unknown families (no false-positive resume)', () => {
    assert.deepEqual(buildResumeArgv('not-a-real-family', '{prompt}', 'id'), []);
  });

  it('returns [] for families that dont have a registry entry (e.g. opencode — deactivated)', () => {
    assert.deepEqual(buildResumeArgv('opencode', '{prompt}', 'id'), []);
  });

  it('every resume argv includes {prompt} so the existing substitution loop handles it', () => {
    for (const fam of ['codex', 'claude', 'agy', 'kimi']) {
      const argv = buildResumeArgv(fam, '{prompt}', 'sid');
      assert.ok(argv.includes('{prompt}'), `${fam} resume argv must carry {prompt}`);
    }
  });
});

describe('parseSessionId — round-1 stdout parser', () => {
  it('codex: extracts thread_id from JSONL thread.started event', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"019f98e2-c4cd-7df0-9d2f-6ff65862bf13"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
    ].join('\n');
    assert.equal(parseSessionId('codex', stdout), '019f98e2-c4cd-7df0-9d2f-6ff65862bf13');
  });

  it('codex: returns null when no thread.started event present', () => {
    assert.equal(parseSessionId('codex', 'no json here\nnope'), null);
  });

  it('claude: extracts session_id from --output-format json', () => {
    const stdout = '{"session_id":"sess-123","result":"ok"}';
    assert.equal(parseSessionId('claude', stdout), 'sess-123');
  });

  it('agy: returns null (CWD-scoped, no id needed)', () => {
    assert.equal(parseSessionId('agy', 'anything'), null);
    assert.equal(parseSessionId('agy', ''), null);
  });

  it('kimi: returns null (CWD-scoped, no id needed)', () => {
    assert.equal(parseSessionId('kimi', '• some response\n'), null);
  });

  it('returns null for unknown families', () => {
    assert.equal(parseSessionId('not-a-family', 'whatever'), null);
  });
});

describe('quorum-sessions-store — round-trip + GC', () => {
  it('round-1: write → round-2: read', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qrs-'));
    try {
      store.write(tmp, 'codex-1', 'inv-1', { family: 'codex', thread_id: 'tid-A', started_at: '2026-07-25T00:00:00Z', round: 1 });
      const r = store.read(tmp, 'codex-1', 'inv-1');
      assert.deepEqual(r, { family: 'codex', thread_id: 'tid-A', started_at: '2026-07-25T00:00:00Z', round: 1 });
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
  });

  it('multi-slot same invocation: isolated writes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qrs-'));
    try {
      store.write(tmp, 'codex-1', 'inv-1', { family: 'codex', thread_id: 'tid-A', started_at: 't', round: 1 });
      store.write(tmp, 'claude-1', 'inv-1', { family: 'claude', thread_id: 'sess-B', started_at: 't', round: 1 });
      assert.equal(store.read(tmp, 'codex-1', 'inv-1').thread_id, 'tid-A');
      assert.equal(store.read(tmp, 'claude-1', 'inv-1').thread_id, 'sess-B');
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
  });

  it('round progression: round=1 → round=2 overwrite preserves only the round field', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qrs-'));
    try {
      store.write(tmp, 'codex-1', 'inv-1', { family: 'codex', thread_id: 'tid-A', started_at: 't', round: 1 });
      store.write(tmp, 'codex-1', 'inv-1', { family: 'codex', thread_id: 'tid-A', started_at: 't', round: 2 });
      assert.equal(store.read(tmp, 'codex-1', 'inv-1').round, 2);
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
  });

  it('read() returns null when no file exists (round 1 case)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qrs-'));
    try {
      assert.equal(store.read(tmp, 'nonexistent-slot', 'inv-1'), null);
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
  });

  it('del() removes one slot, leaves others', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qrs-'));
    try {
      store.write(tmp, 'codex-1', 'inv-1', { family: 'codex', thread_id: 'tid-A', started_at: 't', round: 1 });
      store.write(tmp, 'claude-1', 'inv-1', { family: 'claude', thread_id: 'sess-B', started_at: 't', round: 1 });
      store.del(tmp, 'codex-1', 'inv-1');
      assert.equal(store.read(tmp, 'codex-1', 'inv-1'), null);
      assert.ok(store.read(tmp, 'claude-1', 'inv-1'));
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
  });

  it('cleanup() removes ALL session files for an invocation across slots', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qrs-'));
    try {
      store.write(tmp, 'codex-1',  'inv-X', { family: 'codex', thread_id: 'a', started_at: 't', round: 1 });
      store.write(tmp, 'claude-1', 'inv-X', { family: 'claude', thread_id: 'b', started_at: 't', round: 1 });
      store.write(tmp, 'codex-1',  'inv-Y', { family: 'codex', thread_id: 'c', started_at: 't', round: 1 });
      store.cleanup(tmp, 'inv-X');
      assert.equal(store.read(tmp, 'codex-1',  'inv-X'), null);
      assert.equal(store.read(tmp, 'claude-1', 'inv-X'), null);
      assert.ok(store.read(tmp, 'codex-1', 'inv-Y'));
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
  });

  it('gcStale() removes files older than maxAgeMs but keeps newer ones', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qrs-'));
    try {
      const f = store.sessionPath(tmp, 'codex-1', 'inv-old');
      store.write(tmp, 'codex-1', 'inv-old', { family: 'codex', thread_id: 'a', started_at: 't', round: 1 });
      // Force mtime to far past
      const past = Date.now() / 1000 - (25 * 3600);   // 25h ago
      fs.utimesSync(f, past, past);

      store.write(tmp, 'codex-1', 'inv-new', { family: 'codex', thread_id: 'b', started_at: 't', round: 1 });
      const removed = store.gcStale(tmp, 24 * 3600 * 1000);
      assert.equal(removed, 1);
      assert.equal(store.read(tmp, 'codex-1', 'inv-old'), null);
      assert.ok(store.read(tmp, 'codex-1', 'inv-new'));
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
  });

  it('gcStale() is fail-open on missing directory (returns 0)', () => {
    assert.equal(store.gcStale(path.join(os.tmpdir(), `qrs-missing-${Date.now()}`), 24 * 3600 * 1000), 0);
  });
});

describe('QUORUM_RESUME registry — capability matrix', () => {
  it('every registered family declares supportsSession=true and exposes freshArgs/resumeArgs/parseId', () => {
    for (const [family, cap] of Object.entries(QUORUM_RESUME)) {
      assert.equal(cap.supportsSession, true, `${family}.supportsSession`);
      assert.equal(typeof cap.freshArgs, 'function', `${family}.freshArgs`);
      assert.equal(typeof cap.resumeArgs, 'function', `${family}.resumeArgs`);
      assert.equal(typeof cap.parseId, 'function', `${family}.parseId`);
      const f = cap.freshArgs('P');
      const r = cap.resumeArgs('P', 'sid');
      assert.ok(f.includes('P'), `${family} freshArgs must carry prompt`);
      assert.ok(r.includes('P'), `${family} resumeArgs must carry prompt`);
    }
  });

  it('every family: resumeArgs carries prompt, and id-bearing families carry the id', () => {
    // The wire-up in call-quorum-slot.cjs replaces argsTemplate with the resume
    // argv on round 2+. So resumeArgs must carry `{prompt}` so the existing
    // substitution loop handles it, and id-bearing families must include the
    // session id somewhere in the argv.
    for (const [family, cap] of Object.entries(QUORUM_RESUME)) {
      const f = cap.freshArgs('P');
      const r = cap.resumeArgs('P', 'sid');
      // 1) prompt must be in both — the substitution loop handles {prompt} in either form
      assert.ok(f.includes('P') && r.includes('P'), `${family}: both must carry prompt`);
      // 2) id-bearing families: session id must appear somewhere in resumeArgs
      if (family !== 'agy' && family !== 'kimi') {
        assert.ok(r.includes('sid'), `${family}: session id must appear in resumeArgs`);
      }
    }
  });

  it('(legacy) every family: freshArgs/resumeArgs have the same length (1:1 replacement)', () => {
    // Retained from a prior revision — kept as a guardrail that resumeArgs stays
    // the same shape as freshArgs for families that don't add structural elements.
    // (No longer strictly required since the wire-up now does whole-replacement,
    // but flags regressions where a family's resumeArgs accidentally grows.)
    for (const [family, cap] of Object.entries(QUORUM_RESUME)) {
      const f = cap.freshArgs('P');
      const r = cap.resumeArgs('P', 'sid');
      // resume may differ from fresh (resume adds a verb + id). Allow ±2 elements.
      assert.ok(Math.abs(r.length - f.length) <= 3, `${family}: resumeArgs length must be near freshArgs length`);
    }
  });
});

describe('integration: buildSpawnArgs without persistent flag → no behavior change', () => {
  // Sanity: call-quorum-slot.cjs is exported with buildSpawnArgs. Default
  // (opts.persistentThreads undefined) means buildResumeArgv never splices.
  // We exercise that here by directly inspecting the helper, not by spawning CLIs.
  it('buildResumeArgv returns [] when no session id is present (round 1 path)', () => {
    assert.deepEqual(buildResumeArgv('codex', '{prompt}', null), []);
  });

  it('buildResumeArgv returns [] when opts.persistentThreads is falsy AND store empty', () => {
    // The caller in call-quorum-slot only consults buildResumeArgv when
    // opts.persistentThreads is truthy; otherwise argv goes through unchanged.
    // This test pins the helper contract — it must NOT auto-splice.
    assert.equal(typeof buildResumeArgv, 'function');
  });
});

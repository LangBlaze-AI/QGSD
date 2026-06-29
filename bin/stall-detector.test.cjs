'use strict';
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { detectStalledSlots, shouldEscalate, formatStallReport } = require('./stall-detector.cjs');

// Helper: create temp dir with quorum-failures.json
function makeTempProject(failures) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-test-'));
  const quorumDir = path.join(tmpDir, '.planning', 'quorum');
  fs.mkdirSync(quorumDir, { recursive: true });
  if (failures !== undefined) {
    fs.writeFileSync(path.join(quorumDir, 'failures.json'), JSON.stringify(failures), 'utf8');
  }
  return tmpDir;
}

function cleanTmp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// --- detectStalledSlots ---

describe('detectStalledSlots', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) cleanTmp(tmpDir); });

  it('returns empty for missing file', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-test-'));
    const result = detectStalledSlots(tmpDir, {});
    assert.deepEqual(result, []);
  });

  it('returns empty for empty array', () => {
    tmpDir = makeTempProject([]);
    const result = detectStalledSlots(tmpDir, {});
    assert.deepEqual(result, []);
  });

  it('counts consecutive TIMEOUT from end', () => {
    tmpDir = makeTempProject([
      { slot: 'codex-1', reason: 'SUCCESS' },
      { slot: 'codex-1', reason: 'TIMEOUT', ts: '2026-03-06T10:00:00Z' },
      { slot: 'codex-1', reason: 'TIMEOUT', ts: '2026-03-06T10:01:00Z' },
    ]);
    const result = detectStalledSlots(tmpDir, {});
    assert.equal(result.length, 1);
    assert.equal(result[0].slot, 'codex-1');
    assert.equal(result[0].consecutiveTimeouts, 2);
  });

  it('stops at non-TIMEOUT', () => {
    tmpDir = makeTempProject([
      { slot: 'codex-1', reason: 'TIMEOUT' },
      { slot: 'codex-1', reason: 'SUCCESS' },
      { slot: 'codex-1', reason: 'TIMEOUT', ts: '2026-03-06T10:02:00Z' },
    ]);
    const result = detectStalledSlots(tmpDir, {});
    assert.equal(result[0].consecutiveTimeouts, 1);
  });

  it('handles multiple slots independently', () => {
    tmpDir = makeTempProject([
      { slot: 'codex-1', reason: 'TIMEOUT' },
      { slot: 'codex-1', reason: 'TIMEOUT' },
      { slot: 'codex-1', reason: 'TIMEOUT' },
      { slot: 'gemini-1', reason: 'SUCCESS' },
    ]);
    const result = detectStalledSlots(tmpDir, {});
    assert.equal(result.length, 1);
    assert.equal(result[0].slot, 'codex-1');
    assert.equal(result[0].consecutiveTimeouts, 3);
  });

  it('fail-open on malformed JSON', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-test-'));
    const quorumDir = path.join(tmpDir, '.planning', 'quorum');
    fs.mkdirSync(quorumDir, { recursive: true });
    fs.writeFileSync(path.join(quorumDir, 'failures.json'), 'NOT JSON', 'utf8');
    const result = detectStalledSlots(tmpDir, {});
    assert.deepEqual(result, []);
  });

  it('does not lose detection when a record slot is named __proto__', () => {
    tmpDir = makeTempProject([
      { slot: '__proto__', reason: 'TIMEOUT' },
      { slot: 'codex-1', reason: 'TIMEOUT' },
      { slot: 'codex-1', reason: 'TIMEOUT' },
    ]);
    const result = detectStalledSlots(tmpDir, {});
    const codex = result.find(r => r.slot === 'codex-1');
    assert.ok(codex, 'codex-1 stall must still be detected despite a __proto__ record');
    assert.equal(codex.consecutiveTimeouts, 2);
  });

  it('skips null/non-object records instead of dropping all detection', () => {
    tmpDir = makeTempProject([
      null,
      { slot: 'codex-1', reason: 'TIMEOUT' },
      { slot: 'codex-1', reason: 'TIMEOUT' },
    ]);
    const result = detectStalledSlots(tmpDir, {});
    const codex = result.find(r => r.slot === 'codex-1');
    assert.ok(codex, 'valid records must still be processed despite a null entry');
    assert.equal(codex.consecutiveTimeouts, 2);
  });
});

// --- shouldEscalate ---

describe('shouldEscalate', () => {
  it('returns false when below threshold', () => {
    const stalled = [{ slot: 'codex-1', consecutiveTimeouts: 1 }];
    const result = shouldEscalate(stalled, { stall_detection: { consecutive_threshold: 2, check_commits: false } }, '/tmp');
    assert.equal(result.escalate, false);
    assert.equal(result.reason, 'below_threshold');
  });

  it('returns true when at threshold', () => {
    const stalled = [{ slot: 'codex-1', consecutiveTimeouts: 2 }];
    const result = shouldEscalate(stalled, { stall_detection: { consecutive_threshold: 2, check_commits: false } }, '/tmp');
    assert.equal(result.escalate, true);
    assert.equal(result.stalledSlots.length, 1);
  });

  it('does not throw when given null/undefined stalledSlots', () => {
    assert.doesNotThrow(() => shouldEscalate(null, { stall_detection: { check_commits: false } }, '/tmp'));
    const result = shouldEscalate(undefined, { stall_detection: { check_commits: false } }, '/tmp');
    assert.equal(result.escalate, false);
  });

  it('returns false when commits active', () => {
    // Create a real git repo with a recent commit
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-git-'));
    try {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'test'], {
        cwd: tmpDir, stdio: 'pipe',
        env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.com' },
      });
      const stalled = [{ slot: 'codex-1', consecutiveTimeouts: 3 }];
      const result = shouldEscalate(stalled, { stall_detection: { consecutive_threshold: 2, check_commits: true } }, tmpDir);
      assert.equal(result.escalate, false);
      assert.equal(result.reason, 'commits_active');
    } finally {
      cleanTmp(tmpDir);
    }
  });
});

// --- formatStallReport ---

describe('formatStallReport', () => {
  it('returns null when not escalating', () => {
    const result = formatStallReport({ escalate: false });
    assert.equal(result, null);
  });

  it('produces structured report', () => {
    const result = formatStallReport({
      escalate: true,
      stalledSlots: [{ slot: 'codex-1', consecutiveTimeouts: 3, lastSeen: '2026-03-06T10:00:00Z' }],
    });
    assert.equal(result.type, 'stall_report');
    assert.ok(result.ts);
    assert.equal(result.stalled_slots.length, 1);
    assert.equal(result.stalled_slots[0].slot, 'codex-1');
    assert.ok(result.recommendation);
    assert.ok(result.message.includes('STALL DETECTED'));
    assert.ok(result.message.includes('codex-1'));
  });
});

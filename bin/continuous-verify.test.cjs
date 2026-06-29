'use strict';
// bin/continuous-verify.test.cjs
// Tests for continuous verification engine.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  runChecks,
  shouldTriggerVerification,
  evaluateCondition,
  evaluateAllConditions,
  getVerifyState,
  saveVerifyState,
  initVerifyState,
} = require('./continuous-verify.cjs');

let tmpDir;

function freshTmp() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-test-'));
  return tmpDir;
}

function cleanTmp() {
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

describe('continuous-verify', () => {

  describe('initVerifyState', () => {
    it('returns correct default structure', () => {
      const state = initVerifyState('test-phase');
      assert.equal(state.version, 1);
      assert.equal(state.phase, 'test-phase');
      assert.equal(state.max_runs, 3);
      assert.equal(state.runs_used, 0);
      assert.equal(state.timeout_ms, 5000);
      assert.deepStrictEqual(state.accumulated_files, []);
      assert.equal(state.last_run, null);
      assert.deepStrictEqual(state.runs, []);
    });
  });

  describe('getVerifyState / saveVerifyState', () => {
    before(() => freshTmp());
    after(() => cleanTmp());

    it('returns null when file does not exist', () => {
      const result = getVerifyState(tmpDir);
      assert.equal(result, null);
    });

    it('round-trips state correctly (save then get)', () => {
      const state = initVerifyState('roundtrip');
      state.runs_used = 2;
      state.accumulated_files = ['a.js', 'b.js'];
      saveVerifyState(tmpDir, state);

      const loaded = getVerifyState(tmpDir);
      assert.deepStrictEqual(loaded, state);
    });

    it('returns null on malformed JSON (fail-open)', () => {
      const filePath = path.join(tmpDir, '.planning', 'continuous-verify.json');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '{ broken json !!!', 'utf8');

      const result = getVerifyState(tmpDir);
      assert.equal(result, null);
    });
  });

  describe('shouldTriggerVerification', () => {
    it('returns false for non-Write/Edit tools', () => {
      const state = initVerifyState('test');
      assert.equal(shouldTriggerVerification('Read', {}, state), false);
      assert.equal(shouldTriggerVerification('Grep', {}, state), false);
      assert.equal(shouldTriggerVerification('Bash', {}, state), false);
    });

    it('returns false when budget exhausted', () => {
      const state = initVerifyState('test');
      state.runs_used = 3;
      assert.equal(shouldTriggerVerification('Write', { file_path: 'a.js' }, state), false);
    });

    it('accumulates unique files (no duplicates)', () => {
      const state = initVerifyState('test');
      shouldTriggerVerification('Write', { file_path: 'a.js' }, state);
      shouldTriggerVerification('Write', { file_path: 'a.js' }, state);
      shouldTriggerVerification('Edit', { file_path: 'a.js' }, state);
      assert.equal(state.accumulated_files.length, 1);
    });

    it('returns true when 5+ files accumulated', () => {
      const state = initVerifyState('test');
      shouldTriggerVerification('Write', { file_path: 'a.js' }, state);
      shouldTriggerVerification('Write', { file_path: 'b.js' }, state);
      shouldTriggerVerification('Write', { file_path: 'c.js' }, state);
      shouldTriggerVerification('Write', { file_path: 'd.js' }, state);
      const result = shouldTriggerVerification('Write', { file_path: 'e.js' }, state);
      assert.equal(result, true);
    });

    it('returns true when test file modified', () => {
      const state = initVerifyState('test');
      const result = shouldTriggerVerification('Write', { file_path: 'src/foo.test.js' }, state);
      assert.equal(result, true);
    });

    it('returns true when config file modified', () => {
      const state = initVerifyState('test');
      const result = shouldTriggerVerification('Edit', { file_path: 'package.json' }, state);
      assert.equal(result, true);
    });

    it('returns false when <5 files and no test/config file', () => {
      const state = initVerifyState('test');
      const result = shouldTriggerVerification('Write', { file_path: 'src/utils.js' }, state);
      assert.equal(result, false);
    });

    it('does not throw when state is missing accumulated_files (corrupt/legacy state)', () => {
      const state = { version: 1, phase: 'x', runs_used: 0, max_runs: 3 };
      let result;
      assert.doesNotThrow(() => {
        result = shouldTriggerVerification('Write', { file_path: 'a.js' }, state);
      });
      assert.equal(result, false);
    });

    it('does not throw when accumulated_files is null', () => {
      const state = { version: 1, phase: 'x', runs_used: 0, max_runs: 3, accumulated_files: null };
      let result;
      assert.doesNotThrow(() => {
        result = shouldTriggerVerification('Edit', { file_path: 'package.json' }, state);
      });
      // package.json is a config file, so it should still trigger
      assert.equal(result, true);
    });

    it('does not throw on non-string file_path (number/array/object)', () => {
      const state = initVerifyState('test');
      let result;
      assert.doesNotThrow(() => {
        result = shouldTriggerVerification('Write', { file_path: 123 }, state);
      });
      assert.equal(result, false);
      assert.deepStrictEqual(state.accumulated_files, []); // non-string not accumulated
      assert.doesNotThrow(() => shouldTriggerVerification('Write', { file_path: ['x.test.js'] }, state));
      assert.doesNotThrow(() => shouldTriggerVerification('Write', { file_path: { p: 'x' } }, state));
    });
  });

  describe('evaluateCondition', () => {
    before(() => freshTmp());
    after(() => cleanTmp());

    it('file_exists: returns pass=true for existing file', () => {
      const testFile = path.join(tmpDir, 'exists.txt');
      fs.writeFileSync(testFile, 'hello', 'utf8');
      const result = evaluateCondition(tmpDir, { type: 'file_exists', path: 'exists.txt' });
      assert.equal(result.pass, true);
      assert.equal(result.type, 'file_exists');
    });

    it('file_exists: returns pass=false for missing file', () => {
      const result = evaluateCondition(tmpDir, { type: 'file_exists', path: 'no-such-file.txt' });
      assert.equal(result.pass, false);
      assert.equal(result.type, 'file_exists');
    });

    it('command_pass: blocks disallowed command', () => {
      const result = evaluateCondition(tmpDir, { type: 'command_pass', command: 'echo hello' });
      assert.equal(result.pass, false);
      assert.equal(result.reason, 'command not in allowlist');
      assert.equal(result.type, 'command_pass');
    });

    it('command_pass: false returns pass=false', () => {
      const result = evaluateCondition(tmpDir, { type: 'command_pass', command: 'false' });
      assert.equal(result.pass, false);
      assert.equal(result.type, 'command_pass');
    });

    it('unknown type: returns pass=true with reason', () => {
      const result = evaluateCondition(tmpDir, { type: 'mystery_type' });
      assert.equal(result.pass, true);
      assert.equal(result.reason, 'unknown condition type');
    });

    it('error in condition: returns pass=true (fail-open)', () => {
      const result = evaluateCondition(tmpDir, null);
      assert.equal(result.pass, true);
    });
  });

  describe('evaluateAllConditions', () => {
    before(() => freshTmp());
    after(() => cleanTmp());

    it('empty conditions array returns all_pass=true', () => {
      const result = evaluateAllConditions(tmpDir, []);
      assert.equal(result.all_pass, true);
      assert.deepStrictEqual(result.results, []);
    });

    it('null conditions returns all_pass=true', () => {
      const result = evaluateAllConditions(tmpDir, null);
      assert.equal(result.all_pass, true);
      assert.deepStrictEqual(result.results, []);
    });

    it('undefined conditions returns all_pass=true', () => {
      const result = evaluateAllConditions(tmpDir, undefined);
      assert.equal(result.all_pass, true);
      assert.deepStrictEqual(result.results, []);
    });

    it('mixed pass/fail returns all_pass=false', () => {
      const existingFile = path.join(tmpDir, 'real.txt');
      fs.writeFileSync(existingFile, 'data', 'utf8');

      const result = evaluateAllConditions(tmpDir, [
        { type: 'file_exists', path: 'real.txt' },
        { type: 'file_exists', path: 'nonexistent-xyz.txt' },
      ]);
      assert.equal(result.all_pass, false);
      assert.equal(result.results.length, 2);
      assert.equal(result.results[0].pass, true);
      assert.equal(result.results[1].pass, false);
    });
  });

  describe('runChecks', () => {
    it('returns structured result with timestamp and checks array', () => {
      const result = runChecks('/tmp', ['some-file.js'], 5000);
      assert.ok(result.timestamp);
      assert.ok(Array.isArray(result.checks));
      assert.ok(Array.isArray(result.files_checked));
    });

    it('handles empty files list gracefully', () => {
      const result = runChecks('/tmp', [], 5000);
      assert.ok(result.timestamp);
      assert.equal(result.checks.length, 0);
    });
  });

  describe('CLI fail-open', () => {
    it('exits 0 with no args', () => {
      const { spawnSync } = require('child_process');
      const result = spawnSync('node', [path.join(__dirname, 'continuous-verify.cjs')], {
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(result.status, 0);
    });
  });
});

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { isNumericThreshold } = require('./isNumericThreshold.cjs');

describe('isNumericThreshold', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'is-numeric-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true for spec ref with numeric .cfg value', () => {
    const safetyDir = path.join(tmpDir, 'safety');
    fs.mkdirSync(safetyDir, { recursive: true });
    fs.writeFileSync(path.join(safetyDir, 'MCsafety.cfg'), 'MaxDeliberation = 5\n');

    assert.strictEqual(isNumericThreshold('spec:safety/MCsafety.cfg:MaxDeliberation', { specDir: tmpDir }), true);
  });

  it('returns false for requirement reference', () => {
    assert.strictEqual(isNumericThreshold('requirement:DEBT-01', { specDir: tmpDir }), false);
  });

  it('returns false for spec ref without param key (invariant)', () => {
    assert.strictEqual(isNumericThreshold('spec:safety/invariant-consistency', { specDir: tmpDir }), false);
  });

  it('returns false for null formalRef', () => {
    assert.strictEqual(isNumericThreshold(null, { specDir: tmpDir }), false);
  });

  it('returns true for numeric JSON value', () => {
    const safetyDir = path.join(tmpDir, 'safety');
    fs.mkdirSync(safetyDir, { recursive: true });
    fs.writeFileSync(path.join(safetyDir, 'thresholds.json'), JSON.stringify({ timeout: 30 }));

    assert.strictEqual(isNumericThreshold('spec:safety/thresholds.json:timeout', { specDir: tmpDir }), true);
  });

  it('returns false for string JSON value', () => {
    const safetyDir = path.join(tmpDir, 'safety');
    fs.mkdirSync(safetyDir, { recursive: true });
    fs.writeFileSync(path.join(safetyDir, 'thresholds.json'), JSON.stringify({ name: 'safety' }));

    assert.strictEqual(isNumericThreshold('spec:safety/thresholds.json:name', { specDir: tmpDir }), false);
  });

  it('returns false for missing spec file (fail-open)', () => {
    assert.strictEqual(isNumericThreshold('spec:nonexistent/file.cfg:Param', { specDir: tmpDir }), false);
  });

  it('returns false (fail-open) when options.specDir is a non-string', () => {
    // path.join inside extractFormalExpected throws ERR_INVALID_ARG_TYPE on a
    // non-string specDir (it runs before that module's try block);
    // isNumericThreshold must absorb it, not propagate.
    assert.strictEqual(
      isNumericThreshold('spec:safety/MCsafety.cfg:MaxDeliberation', { specDir: 5 }),
      false
    );
    assert.strictEqual(
      isNumericThreshold('spec:safety/MCsafety.cfg:MaxDeliberation', { specDir: ['a'] }),
      false
    );
  });

  it('returns false for a non-finite (Infinity) cfg value', () => {
    const safetyDir = path.join(tmpDir, 'safety');
    fs.mkdirSync(safetyDir, { recursive: true });
    fs.writeFileSync(path.join(safetyDir, 'MCsafety.cfg'), 'MaxDeliberation = Infinity\n');
    assert.strictEqual(
      isNumericThreshold('spec:safety/MCsafety.cfg:MaxDeliberation', { specDir: tmpDir }),
      false
    );
  });
});

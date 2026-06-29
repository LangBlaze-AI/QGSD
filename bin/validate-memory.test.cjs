'use strict';

// Dogfood regression (F48): /nf:review-requirements crashed when the requirements
// envelope had a non-array `requirements` (e.g. a partially-written object/string)
// — `requirements.map(...)` in checkContradictions / the count in checkStaleCounts
// threw a raw TypeError. Both now treat a non-array as empty.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkContradictions, checkStaleCounts } = require('./validate-memory.cjs');

function tmpProject(envelope) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-vm-'));
  fs.mkdirSync(path.join(dir, '.planning', 'formal'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'formal', 'requirements.json'), JSON.stringify(envelope));
  return dir;
}

describe('validate-memory non-array requirements guard', () => {
  it('checkContradictions does not crash on a non-array `requirements`', () => {
    const dir = tmpProject({ requirements: 'not-an-array' });
    try {
      const findings = checkContradictions('MEMORY mentions REQ-99 and CLAUDE.md', dir);
      assert.ok(Array.isArray(findings), 'returns findings array, no throw');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checkContradictions tolerates null elements inside requirements', () => {
    const dir = tmpProject({ requirements: [null, { id: 'REQ-1', text: 'x' }] });
    try {
      assert.doesNotThrow(() => checkContradictions('refers to REQ-1', dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checkStaleCounts reports 0 (not a string length) for a non-array `requirements`', () => {
    const dir = tmpProject({ requirements: 'xxxxx' }); // 5 chars — must NOT be read as count 5
    try {
      // memory claims 3 reqs; actual must be 0 (non-array), so a stale_count finding fires
      const findings = checkStaleCounts('This project has 3 reqs tracked.', dir);
      const stale = findings.find((f) => f.type === 'stale_count');
      assert.ok(stale, 'a stale_count finding should fire');
      assert.match(stale.message, /envelope has 0/, 'count is 0, not the string length 5');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('validate-memory fail-open on unreadable MEMORY.md', () => {
  it('validateMemory does not throw when the memory path is a directory (EISDIR)', () => {
    const { validateMemory } = require('./validate-memory.cjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-vm-'));
    const memDir = path.join(dir, 'MEMORY.md');
    fs.mkdirSync(memDir); // a *directory* named MEMORY.md — existsSync() returns true
    try {
      let result;
      assert.doesNotThrow(() => {
        result = validateMemory({ cwd: dir, memoryPath: memDir, quiet: true });
      });
      assert.ok(Array.isArray(result.findings), 'returns a findings array, no throw');
      assert.equal(result.findings.length, 0, 'no findings when memory is unreadable');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('validate-memory non-string content guard', () => {
  it('checkStaleCounts does not crash on a null memoryContent', () => {
    const dir = tmpProject({ requirements: [] });
    try {
      let findings;
      assert.doesNotThrow(() => { findings = checkStaleCounts(null, dir); });
      assert.ok(Array.isArray(findings), 'returns findings array, no throw');
      assert.equal(findings.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('validate-memory findMemoryPath input guard', () => {
  it('returns null for a non-string cwd instead of throwing', () => {
    const { findMemoryPath } = require('./validate-memory.cjs');
    let result;
    assert.doesNotThrow(() => { result = findMemoryPath(undefined); });
    assert.equal(result, null);
    assert.doesNotThrow(() => findMemoryPath(42));
  });
});

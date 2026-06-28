'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  parseIssueSelection,
  buildTargetsManifest,
  writeTargetsManifest,
  readTargetsManifest
} = require('./observe-solve-pipe.cjs');

describe('parseIssueSelection', () => {
  it('parses comma-separated numbers', () => {
    assert.deepStrictEqual(parseIssueSelection('solve 1,3,5', 10), [0, 2, 4]);
  });

  it('parses ranges', () => {
    assert.deepStrictEqual(parseIssueSelection('solve 1-3', 10), [0, 1, 2]);
  });

  it('parses mixed commas and ranges', () => {
    assert.deepStrictEqual(parseIssueSelection('solve 1-3,7,9', 10), [0, 1, 2, 6, 8]);
  });

  it('filters out-of-bounds indices', () => {
    assert.deepStrictEqual(parseIssueSelection('solve 1,5,20', 5), [0, 4]);
  });

  it('deduplicates indices', () => {
    assert.deepStrictEqual(parseIssueSelection('solve 1,1,2,2', 5), [0, 1]);
  });

  it('returns empty array for empty input', () => {
    assert.deepStrictEqual(parseIssueSelection('', 5), []);
    assert.deepStrictEqual(parseIssueSelection(null, 5), []);
    assert.deepStrictEqual(parseIssueSelection('solve', 5), []);
  });

  it('returns empty array for invalid numbers', () => {
    assert.deepStrictEqual(parseIssueSelection('solve abc', 5), []);
  });

  it('handles bare solve prefix with single number', () => {
    assert.deepStrictEqual(parseIssueSelection('solve 2', 5), [1]);
  });

  it('tolerates whitespace around numbers and commas', () => {
    assert.deepStrictEqual(parseIssueSelection('solve 1, 3, 5', 10), [0, 2, 4]);
    assert.deepStrictEqual(parseIssueSelection('solve  1 , 3 , 5 ', 10), [0, 2, 4]);
  });

  it('handles reversed ranges', () => {
    assert.deepStrictEqual(parseIssueSelection('solve 3-1', 10), [0, 1, 2]);
  });

  it('does not hang on a huge range (loop bounded by maxIndex)', () => {
    // Upper bound is enormous but maxIndex is small; must clamp, not iterate billions of times.
    // A synchronous unbounded loop cannot be caught by node:test's timeout option, so assert
    // both correctness and that it returns near-instantly (well under any reasonable bound).
    const t0 = Date.now();
    const result = parseIssueSelection('solve 1-9999999999', 5);
    const elapsed = Date.now() - t0;
    assert.deepStrictEqual(result, [0, 1, 2, 3, 4]);
    assert.ok(elapsed < 1000, `expected near-instant return, took ${elapsed}ms (loop not clamped to maxIndex)`);
  });
});

describe('buildTargetsManifest', () => {
  it('produces correct schema with version and targets array', () => {
    const issues = [
      { id: 'issue-1', title: 'Bug A', severity: 'error', source_type: 'internal', issue_type: 'issue', _route: '/nf:debug', fingerprint: 'fp1' },
      { id: 'issue-2', title: 'Drift B', severity: 'warning', source_type: 'internal', issue_type: 'drift', formal_parameter_key: 'PARAM.X' }
    ];
    const manifest = buildTargetsManifest(issues);

    assert.strictEqual(manifest.version, 1);
    assert.strictEqual(manifest.source, 'observe');
    assert.ok(manifest.created_at);
    assert.strictEqual(manifest.targets.length, 2);
    assert.deepStrictEqual(manifest.targets[0], {
      id: 'issue-1',
      title: 'Bug A',
      severity: 'error',
      source_type: 'internal',
      issue_type: 'issue',
      _route: '/nf:debug',
      formal_ref: null,
      fingerprint: 'fp1'
    });
    assert.strictEqual(manifest.targets[1].formal_ref, 'PARAM.X');
    assert.strictEqual(manifest.targets[1]._route, null);
  });

  it('handles empty array', () => {
    const manifest = buildTargetsManifest([]);
    assert.deepStrictEqual(manifest.targets, []);
    assert.strictEqual(manifest.version, 1);
  });

  it('handles null input', () => {
    const manifest = buildTargetsManifest(null);
    assert.deepStrictEqual(manifest.targets, []);
  });

  it('skips null / non-object entries instead of crashing', () => {
    const manifest = buildTargetsManifest([null, { id: 'ok', title: 'T', severity: 'error', source_type: 'internal', issue_type: 'issue' }]);
    assert.strictEqual(manifest.targets.length, 1);
    assert.strictEqual(manifest.targets[0].id, 'ok');
  });
});

describe('writeTargetsManifest + readTargetsManifest round-trip', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-pipe-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes and reads back a manifest', () => {
    const manifest = buildTargetsManifest([
      { id: 'test-1', title: 'Test Issue', severity: 'warning', source_type: 'internal', issue_type: 'issue' }
    ]);
    const outPath = path.join(tmpDir, 'targets.json');
    const result = writeTargetsManifest(manifest, outPath);

    assert.strictEqual(result.path, outPath);
    assert.strictEqual(result.count, 1);

    const read = readTargetsManifest(outPath);
    assert.ok(read);
    assert.strictEqual(read.version, 1);
    assert.strictEqual(read.targets.length, 1);
    assert.strictEqual(read.targets[0].title, 'Test Issue');
  });

  it('creates parent directories if needed', () => {
    const outPath = path.join(tmpDir, 'sub', 'dir', 'targets.json');
    const manifest = buildTargetsManifest([]);
    writeTargetsManifest(manifest, outPath);
    assert.ok(fs.existsSync(outPath));
  });
});

describe('readTargetsManifest', () => {
  it('returns null for missing file', () => {
    assert.strictEqual(readTargetsManifest('/nonexistent/path/targets.json'), null);
  });

  it('returns null for invalid JSON', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-pipe-test-'));
    const badPath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(badPath, 'not json', 'utf8');
    assert.strictEqual(readTargetsManifest(badPath), null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for wrong version', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-pipe-test-'));
    const badPath = path.join(tmpDir, 'wrongver.json');
    fs.writeFileSync(badPath, JSON.stringify({ version: 2, targets: [] }), 'utf8');
    assert.strictEqual(readTargetsManifest(badPath), null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for non-array targets', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-pipe-test-'));
    const badPath = path.join(tmpDir, 'badtargets.json');
    fs.writeFileSync(badPath, JSON.stringify({ version: 1, targets: 'not-array' }), 'utf8');
    assert.strictEqual(readTargetsManifest(badPath), null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

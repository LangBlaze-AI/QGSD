// Requirements: TLINK-02
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { discoverTestFiles, hasExistingAnnotation, querySuggestion, injectAnnotation } = require('../bin/annotate-tests.cjs');

// ── hasExistingAnnotation ───────────────────────────────────────────────────

describe('hasExistingAnnotation', () => {
  test('detects @requirement annotation', () => {
    assert.ok(hasExistingAnnotation('// @requirement FOO-01\ntest("x", () => {});'));
  });

  test('detects @req annotation', () => {
    assert.ok(hasExistingAnnotation('// @req BAR-02\ntest("x", () => {});'));
  });

  test('detects // Requirements: header', () => {
    assert.ok(hasExistingAnnotation('// Requirements: BAZ-03, BAZ-04\n'));
  });

  test('returns false for unannotated content', () => {
    assert.ok(!hasExistingAnnotation('const x = 1;\ntest("x", () => {});'));
  });
});

// ── querySuggestion ─────────────────────────────────────────────────────────

describe('querySuggestion', () => {
  // Mock proximity index and reach function
  const mockPi = {
    nodes: {
      'code_file::test/foo.test.cjs': {
        type: 'code_file',
        id: 'test/foo.test.cjs',
        edges: [{ to: 'requirement::REQ-01', rel: 'declares', source: 'source-annotation' }],
      },
      'requirement::REQ-01': {
        type: 'requirement',
        id: 'REQ-01',
        edges: [],
      },
      'code_file::test/no-link.test.cjs': {
        type: 'code_file',
        id: 'test/no-link.test.cjs',
        edges: [],
      },
    },
  };

  function mockReach(pi, startNode, maxDepth, filter) {
    if (startNode === 'code_file::test/foo.test.cjs') {
      return { '1': [{ key: 'requirement::REQ-01', type: 'requirement', rel: 'declares' }] };
    }
    return {};
  }

  test('returns suggestion for file with proximity node', () => {
    const result = querySuggestion(mockPi, mockReach, 'test/foo.test.cjs');
    assert.ok(result, 'should return a suggestion');
    assert.strictEqual(result.requirement, 'REQ-01');
    assert.ok(result.confidence >= 0.4, 'confidence should be >= 0.4');
  });

  test('returns null for file without proximity node', () => {
    const result = querySuggestion(mockPi, mockReach, 'test/unknown.test.cjs');
    assert.strictEqual(result, null, 'should return null for unknown file');
  });

  test('returns null for file with no reachable requirements', () => {
    const result = querySuggestion(mockPi, mockReach, 'test/no-link.test.cjs');
    assert.strictEqual(result, null, 'should return null when no requirements reachable');
  });

  test('returns null when pi has no nodes property (corrupt/partial index)', () => {
    assert.strictEqual(querySuggestion({}, mockReach, 'test/foo.test.cjs'), null);
  });

  test('returns null when pi is null', () => {
    assert.strictEqual(querySuggestion(null, mockReach, 'test/foo.test.cjs'), null);
  });

  test('returns null when pi is an array (wrong shape)', () => {
    assert.strictEqual(querySuggestion([], mockReach, 'test/foo.test.cjs'), null);
  });
});

// ── discoverTestFiles ───────────────────────────────────────────────────────

describe('discoverTestFiles', () => {
  test('returns [] for null/undefined dirs', () => {
    assert.deepStrictEqual(discoverTestFiles(null), []);
    assert.deepStrictEqual(discoverTestFiles(undefined), []);
  });

  test('returns [] for a non-array (string) dirs', () => {
    assert.deepStrictEqual(discoverTestFiles('test'), []);
  });
});

// ── injectAnnotation ────────────────────────────────────────────────────────

describe('injectAnnotation', () => {
  test('injects annotation at top of file (no shebang)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'annotate-test-'));
    const tmpFile = path.join(tmpDir, 'test.cjs');
    fs.writeFileSync(tmpFile, "'use strict';\nconst x = 1;\n");

    injectAnnotation(tmpFile, 'FOO-01');

    const result = fs.readFileSync(tmpFile, 'utf8');
    const lines = result.split('\n');
    assert.strictEqual(lines[0], '// @requirement FOO-01');
    assert.strictEqual(lines[1], "'use strict';");

    // Cleanup
    fs.unlinkSync(tmpFile);
    fs.rmdirSync(tmpDir);
  });

  test('injects annotation after shebang', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'annotate-test-'));
    const tmpFile = path.join(tmpDir, 'test.cjs');
    fs.writeFileSync(tmpFile, "#!/usr/bin/env node\n'use strict';\n");

    injectAnnotation(tmpFile, 'BAR-02');

    const result = fs.readFileSync(tmpFile, 'utf8');
    const lines = result.split('\n');
    assert.strictEqual(lines[0], '#!/usr/bin/env node');
    assert.strictEqual(lines[1], '// @requirement BAR-02');
    assert.strictEqual(lines[2], "'use strict';");

    // Cleanup
    fs.unlinkSync(tmpFile);
    fs.rmdirSync(tmpDir);
  });
});

// ── CLI integration ─────────────────────────────────────────────────────────

describe('annotate-tests CLI', () => {
  test('runs without error when proximity-index.json exists', () => {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync('node', ['bin/annotate-tests.cjs'], {
      cwd: path.join(__dirname, '..'),
      timeout: 10000,
    });
    assert.strictEqual(result.status, 0, 'should exit 0: ' + (result.stderr || '').toString());
  });

  test('--json mode outputs valid JSON array', () => {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync('node', ['bin/annotate-tests.cjs', '--json'], {
      cwd: path.join(__dirname, '..'),
      timeout: 10000,
    });
    assert.strictEqual(result.status, 0, 'should exit 0');
    const stdout = result.stdout.toString().trim();
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed), 'output should be a JSON array');
  });
});

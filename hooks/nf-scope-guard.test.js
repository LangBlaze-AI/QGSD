'use strict';
// hooks/nf-scope-guard.test.js
// Tests for the scope guard PreToolUse hook.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Import the exported functions
const {
  extractTargetPath,
  isFileInScope,
  readScopeContract,
  getCurrentBranch,
} = require('./nf-scope-guard');

// TC-SG-01: extractTargetPath(null) returns null
it('TC-SG-01: extractTargetPath(null) returns null', () => {
  assert.strictEqual(extractTargetPath(null), null);
});

// TC-SG-02: extractTargetPath({ file_path: 'hooks/foo.js' }) returns 'hooks/foo.js'
it('TC-SG-02: extractTargetPath with file_path returns the path', () => {
  const result = extractTargetPath({ file_path: 'hooks/foo.js' });
  assert.strictEqual(result, 'hooks/foo.js');
});

// TC-SG-03: extractTargetPath({ files: [{ file_path: 'src/bar.ts' }] }) returns 'src/bar.ts'
it('TC-SG-03: extractTargetPath with files array returns first file path', () => {
  const result = extractTargetPath({ files: [{ file_path: 'src/bar.ts' }] });
  assert.strictEqual(result, 'src/bar.ts');
});

// TC-SG-04: extractTargetPath({ files: [] }) returns null
it('TC-SG-04: extractTargetPath with empty files array returns null', () => {
  const result = extractTargetPath({ files: [] });
  assert.strictEqual(result, null);
});

// TC-SG-05: isFileInScope('hooks/nf-scope-guard.js', null) returns true (no branchEntry = all in scope)
it('TC-SG-05: isFileInScope with null branchEntry returns true', () => {
  const result = isFileInScope('hooks/nf-scope-guard.js', null);
  assert.strictEqual(result, true);
});

// TC-SG-06: isFileInScope('hooks/nf-scope-guard.js', { out_of_scope: [] }) returns true (empty out_of_scope)
it('TC-SG-06: isFileInScope with empty out_of_scope returns true', () => {
  const result = isFileInScope('hooks/nf-scope-guard.js', { out_of_scope: [] });
  assert.strictEqual(result, true);
});

// TC-SG-07: isFileInScope('bin/install.js', { out_of_scope: ['bin/'] }) returns false (prefix match on 'bin/')
it('TC-SG-07: isFileInScope with matching out_of_scope prefix returns false', () => {
  const result = isFileInScope('bin/install.js', { out_of_scope: ['bin/'] });
  assert.strictEqual(result, false);
});

// TC-SG-08: isFileInScope('hooks/nf-scope-guard.js', { out_of_scope: ['bin/'] }) returns true (not in out_of_scope)
it('TC-SG-08: isFileInScope with non-matching out_of_scope returns true', () => {
  const result = isFileInScope('hooks/nf-scope-guard.js', { out_of_scope: ['bin/'] });
  assert.strictEqual(result, true);
});

// TC-SG-09: Trailing slash normalization: isFileInScope('bin/install.js', { out_of_scope: ['bin'] }) returns false
it('TC-SG-09: isFileInScope normalizes trailing slashes for matching', () => {
  const result = isFileInScope('bin/install.js', { out_of_scope: ['bin'] });
  assert.strictEqual(result, false);
});

// TC-SG-13: isFileInScope must match on a path-segment boundary, not a bare string prefix
it('TC-SG-13: isFileInScope does not flag a sibling dir sharing the pattern prefix', () => {
  // 'binutils/' is NOT under 'bin/', so the file is in scope.
  assert.strictEqual(isFileInScope('binutils/tool.js', { out_of_scope: ['bin/'] }), true);
  assert.strictEqual(isFileInScope('binary.js', { out_of_scope: ['bin'] }), true);
  // Regression guard: genuine descendants and exact matches still flagged.
  assert.strictEqual(isFileInScope('bin/install.js', { out_of_scope: ['bin/'] }), false);
  assert.strictEqual(isFileInScope('bin', { out_of_scope: ['bin'] }), false);
});

// TC-SG-14: isFileInScope tolerates a non-string targetPath (fail-open, no throw)
it('TC-SG-14: isFileInScope does not throw on a non-string targetPath', () => {
  assert.doesNotThrow(() => isFileInScope(42, { out_of_scope: ['bin/'] }));
  assert.strictEqual(isFileInScope(42, { out_of_scope: ['bin/'] }), true);
  assert.strictEqual(isFileInScope({}, { out_of_scope: ['bin/'] }), true);
});

// TC-SG-10: readScopeContract with nonexistent path returns null
it('TC-SG-10: readScopeContract with nonexistent path returns null', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-sg-test-'));
  try {
    const result = readScopeContract(tempDir);
    assert.strictEqual(result, null);
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

// TC-SG-11: readScopeContract with malformed JSON returns null
it('TC-SG-11: readScopeContract with malformed JSON returns null', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-sg-test-'));
  try {
    const claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const contractPath = path.join(claudeDir, 'scope-contract.json');
    fs.writeFileSync(contractPath, '{bad json', 'utf8');

    const result = readScopeContract(tempDir);
    assert.strictEqual(result, null);
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

// TC-SG-12: getCurrentBranch with a valid git repo returns a string or null (detached HEAD in CI)
it('TC-SG-12: getCurrentBranch with valid git repo returns branch name', () => {
  // Use the current working directory (which is a git repo).
  // CI may run in detached HEAD state, in which case the function correctly returns null.
  const result = getCurrentBranch(process.cwd());
  assert.ok(result === null || typeof result === 'string', 'getCurrentBranch should return null or a string');
  if (result !== null) {
    assert.ok(result.length > 0, 'branch name should not be empty');
  }
});

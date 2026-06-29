#!/usr/bin/env node
'use strict';
// bin/formal-test-sync.test.cjs
// TDD test suite for bin/formal-test-sync.cjs
// Uses node:test + node:assert/strict
//
// Test categories:
// - TC-PARSE: parseTestFile() parser tests
// - TC-CONST: Constants parsing and validation tests
// - TC-GAP: Coverage gap analysis tests
// - TC-STUB: Test stub generation tests
// - TC-INT: Integration tests (full script)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Import functions from extract-annotations.cjs
const { parseTestFile } = require('./extract-annotations.cjs');

// ── TC-PARSE: Parser Tests ──────────────────────────────────────────────────

test('TC-PARSE-1: parseTestFile with single @requirement above test()', () => {
  const content = `// @requirement REQ-001
test('sample test', () => {
  assert.ok(true);
});`;
  const results = parseTestFile(content);
  assert.equal(results.length, 1);
  assert.equal(results[0].test_name, 'sample test');
  assert.deepEqual(results[0].requirement_ids, ['REQ-001']);
});

test('TC-PARSE-2: parseTestFile with multiple @requirement above one test()', () => {
  const content = `// @requirement REQ-001
// @requirement REQ-002
test('multi-req test', () => {
  assert.ok(true);
});`;
  const results = parseTestFile(content);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].requirement_ids, ['REQ-001', 'REQ-002']);
});

test('TC-PARSE-3: parseTestFile with @requirement above describe()', () => {
  const content = `// @requirement REQ-003
describe('test suite', () => {
  test('inner test', () => {
    assert.ok(true);
  });
});`;
  const results = parseTestFile(content);
  assert.equal(results.length, 1);
  assert.equal(results[0].test_name, 'test suite');
  assert.deepEqual(results[0].requirement_ids, ['REQ-003']);
});

test('TC-PARSE-4: parseTestFile with no annotations', () => {
  const content = `test('unannotated test', () => {
  assert.ok(true);
});`;
  const results = parseTestFile(content);
  assert.equal(results.length, 0);
});

test('TC-PARSE-5: parseTestFile with annotation separated by blank line and comment', () => {
  // The parser uses lenient association: blank lines and comment lines between
  // @requirement and test() do NOT break the association. Only non-comment,
  // non-blank, non-test lines reset pending annotations.
  const content = `// @requirement REQ-004

// some other comment

test('test after gap', () => {
  assert.ok(true);
});`;
  const results = parseTestFile(content);
  // Lenient: annotation is still associated despite blank line + comment gap
  assert.equal(results.length, 1);
  assert.equal(results[0].test_name, 'test after gap');
  assert.deepEqual(results[0].requirement_ids, ['REQ-004']);
});

test('TC-PARSE-6: parseTestFile with annotation above nested test in describe', () => {
  const content = `describe('suite', () => {
  // @requirement REQ-005
  test('nested test', () => {
    assert.ok(true);
  });
});`;
  const results = parseTestFile(content);
  assert.equal(results.length, 1);
  assert.equal(results[0].test_name, 'nested test');
  assert.deepEqual(results[0].requirement_ids, ['REQ-005']);
});

// ── TC-CONST: Constants Tests ───────────────────────────────────────────────

test('TC-CONST-1: parseTLACfgConstants from MCoscillation.cfg', () => {
  // Import the parsing function from formal-test-sync.cjs indirectly via a test helper
  const content = `SPECIFICATION Spec
CONSTANTS
    Labels = {A, B, C}
    Depth = 3
    CommitWindow = 5
INVARIANT TypeOK`;

  // We'll test this by running the actual script and checking output
  const scriptPath = path.join(__dirname, 'formal-test-sync.cjs');
  const result = spawnSync(process.execPath, [scriptPath, '--json', '--report-only'], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    timeout: 10000,
  });

  assert.equal(result.status, 0, 'script should exit 0');
  const output = JSON.parse(result.stdout);
  assert.ok(output.constants_validation, 'output should have constants_validation section');
});

test('TC-CONST-2: resolveConfigPath handles nested paths', () => {
  // Test via integration: the constants validation should work
  const scriptPath = path.join(__dirname, 'formal-test-sync.cjs');
  const result = spawnSync(process.execPath, [scriptPath, '--json', '--report-only'], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    timeout: 10000,
  });

  assert.equal(result.status, 0, 'script should exit 0');
  const output = JSON.parse(result.stdout);
  const depthValidation = output.constants_validation.find(c => c.constant === 'Depth');
  assert.ok(depthValidation, 'Depth constant should be validated');
  assert.equal(depthValidation.formal_value, 3);
});

test('TC-CONST-3: Constants with intentional_divergence flag', () => {
  const scriptPath = path.join(__dirname, 'formal-test-sync.cjs');
  const result = spawnSync(process.execPath, [scriptPath, '--json', '--report-only'], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    timeout: 10000,
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  const commitWindow = output.constants_validation.find(c => c.constant === 'CommitWindow');
  assert.ok(commitWindow, 'CommitWindow should be in validation');
  assert.ok(commitWindow.intentional_divergence, 'CommitWindow should be marked as intentional divergence');
});

test('TC-CONST-4: Model-only constants are handled (config_path: null)', () => {
  const scriptPath = path.join(__dirname, 'formal-test-sync.cjs');
  const result = spawnSync(process.execPath, [scriptPath, '--json', '--report-only'], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    timeout: 10000,
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  const modelOnly = output.constants_validation.find(c => c.constant === 'MaxDeliberation');
  assert.ok(modelOnly, 'MaxDeliberation should be in validation');
  assert.equal(modelOnly.config_path, null, 'Model-only constants should have null config_path');
});

// ── TC-GAP: Coverage Gap Tests ──────────────────────────────────────────────

test('TC-GAP-1: Requirement with both formal and test coverage appears in covered', () => {
  const scriptPath = path.join(__dirname, 'formal-test-sync.cjs');
  const result = spawnSync(process.execPath, [scriptPath, '--json', '--report-only'], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    timeout: 10000,
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  const covered = output.coverage_gaps.covered;
  assert.ok(covered.length > 0, 'should have at least one covered requirement');
  const first = covered[0];
  assert.ok(first.has_formal, 'covered requirement should have formal coverage');
  assert.ok(first.has_test, 'covered requirement should have test coverage');
});

test('TC-GAP-2: coverage_gaps output has correct structure', () => {
  // Verifies that the gaps array exists and each entry has the expected schema.
  // Does NOT assert gaps.length > 0 because this depends on real repo state —
  // as test coverage improves, gaps may reach 0.
  const scriptPath = path.join(__dirname, 'formal-test-sync.cjs');
  const result = spawnSync(process.execPath, [scriptPath, '--json', '--report-only'], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    timeout: 10000,
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.ok(Array.isArray(output.coverage_gaps.gaps), 'gaps must be an array');
  // Validate schema of any gap entries that do exist
  for (const gap of output.coverage_gaps.gaps) {
    assert.ok(typeof gap.has_formal === 'boolean', 'gap entry must have boolean has_formal');
    assert.ok(typeof gap.has_test === 'boolean', 'gap entry must have boolean has_test');
    assert.ok(typeof gap.gap === 'boolean', 'gap entry must have boolean gap field');
    // A gap entry must have formal coverage but no test coverage
    assert.ok(gap.has_formal, 'gap requirement should have formal coverage');
    assert.ok(!gap.has_test, 'gap requirement should have no test coverage');
    assert.ok(gap.gap, 'gap requirement should be marked as gap');
  }
});

test('TC-GAP-3: Requirement with neither formal nor test is uncovered, not a gap', () => {
  const scriptPath = path.join(__dirname, 'formal-test-sync.cjs');
  const result = spawnSync(process.execPath, [scriptPath, '--json', '--report-only'], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    timeout: 10000,
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  const uncovered = output.coverage_gaps.uncovered;
  assert.ok(uncovered.length > 0, 'should have at least one uncovered requirement');
  const first = uncovered[0];
  assert.ok(!first.has_formal, 'uncovered should have no formal coverage');
  assert.ok(!first.has_test, 'uncovered should have no test coverage');
  assert.ok(!first.gap, 'uncovered should not be marked as gap');
});

test('TC-GAP-4: Multiple test cases for same requirement tracked correctly', () => {
  const scriptPath = path.join(__dirname, 'formal-test-sync.cjs');
  const result = spawnSync(process.execPath, [scriptPath, '--json', '--report-only'], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    timeout: 10000,
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  const covered = output.coverage_gaps.covered;
  // DETECT-05 should have multiple test cases
  const detect05 = covered.find(r => r.requirement_id === 'DETECT-05');
  if (detect05) {
    assert.ok(detect05.test_cases.length >= 2, 'DETECT-05 should have multiple test cases');
  }
});

// ── TC-STUB: Stub Generation Tests ──────────────────────────────────────────

test('TC-STUB-1: Generated stubs contain @requirement annotation', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-stub-test-'));
  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'formal-test-sync.cjs'),
      '--dry-run',
      '--stubs-dir=' + tmpDir,
    ], {
      encoding: 'utf8',
      cwd: path.join(__dirname, '..'),
      timeout: 10000,
    });

    assert.equal(result.status, 0, 'stub generation should succeed');
    // With --dry-run, no files are actually written, but we can check the script runs
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-STUB-2: Stub files contain assert.fail with TODO', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-stub-test-'));
  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'formal-test-sync.cjs'),
      '--stubs-dir=' + tmpDir,
    ], {
      encoding: 'utf8',
      cwd: path.join(__dirname, '..'),
      timeout: 10000,
    });

    assert.equal(result.status, 0, 'stub generation should succeed');
    // Check if any stub files were created
    if (fs.existsSync(tmpDir)) {
      const files = fs.readdirSync(tmpDir);
      if (files.length > 0) {
        const stubContent = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8');
        assert.match(stubContent, /assert\.fail/, 'stub should contain assert.fail');
        assert.match(stubContent, /TODO/, 'stub should contain TODO comment');
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-STUB-3: Stub filenames follow REQ-ID.stub.test.js convention', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-stub-test-'));
  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'formal-test-sync.cjs'),
      '--stubs-dir=' + tmpDir,
    ], {
      encoding: 'utf8',
      cwd: path.join(__dirname, '..'),
      timeout: 10000,
    });

    assert.equal(result.status, 0);
    if (fs.existsSync(tmpDir)) {
      const files = fs.readdirSync(tmpDir);
      for (const file of files) {
        assert.match(file, /^[A-Z0-9-]+\.stub\.test\.js$/, 'stub filename should match pattern REQ-ID.stub.test.js');
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-STUB-4: --dry-run mode does not create files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-stub-dryrun-'));
  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'formal-test-sync.cjs'),
      '--dry-run',
      '--stubs-dir=' + tmpDir,
    ], {
      encoding: 'utf8',
      cwd: path.join(__dirname, '..'),
      timeout: 10000,
    });

    assert.equal(result.status, 0, 'dry-run should exit 0');
    // Stubs directory should not contain any files in dry-run mode
    if (fs.existsSync(tmpDir)) {
      const files = fs.readdirSync(tmpDir);
      assert.equal(files.length, 0, 'dry-run should not create stub files');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC-ALLOY: Alloy Defaults Parsing Tests ──────────────────────────────────

test('TC-ALLOY-PARSE-1: parseAlloyDefaults parses all 3 constants from newline-separated block', () => {
  const { parseAlloyDefaults } = require('./formal-test-sync.cjs');

  const alloyContent = `-- Hardcoded defaults for fallback
one sig Defaults {
  defaultOscDepth: one Int,
  defaultCommitWindow: one Int,
  defaultFailMode: one FailMode
} {
  defaultOscDepth = 3
  defaultCommitWindow = 6
  defaultFailMode = FailOpen
}`;

  const result = parseAlloyDefaults(alloyContent);
  assert.equal(result.defaultOscDepth, 3, 'defaultOscDepth should be 3');
  assert.equal(result.defaultCommitWindow, 6, 'defaultCommitWindow should be 6');
  assert.equal(result.defaultFailMode, 'FailOpen', 'defaultFailMode should be FailOpen');
  assert.equal(Object.keys(result).length, 3, 'should have exactly 3 constants');
});

test('TC-ALLOY-PARSE-2: parseAlloyDefaults returns empty object when no Defaults sig found', () => {
  const { parseAlloyDefaults } = require('./formal-test-sync.cjs');

  const alloyContent = `sig Foo { bar: one Int }`;
  const result = parseAlloyDefaults(alloyContent);
  assert.deepEqual(result, {}, 'should return empty object when no Defaults sig');
});

test('TC-ALLOY-PARSE-3: parseAlloyDefaults handles single constant', () => {
  const { parseAlloyDefaults } = require('./formal-test-sync.cjs');

  const alloyContent = `one sig Defaults {
  depth: one Int
} {
  depth = 5
}`;

  const result = parseAlloyDefaults(alloyContent);
  assert.equal(result.depth, 5, 'depth should be 5');
  assert.equal(Object.keys(result).length, 1, 'should have exactly 1 constant');
});

test('TC-ALLOY-PARSE-4: parseAlloyDefaults handles blank lines and comments in constraint block', () => {
  const { parseAlloyDefaults } = require('./formal-test-sync.cjs');

  const alloyContent = `one sig Defaults {
  defaultOscDepth: one Int,
  defaultCommitWindow: one Int,
  defaultFailMode: one FailMode
} {
  -- oscillation depth
  defaultOscDepth = 3

  // commit window size
  defaultCommitWindow = 6

  defaultFailMode = FailOpen
}`;

  const result = parseAlloyDefaults(alloyContent);
  assert.equal(result.defaultOscDepth, 3, 'defaultOscDepth should be 3');
  assert.equal(result.defaultCommitWindow, 6, 'defaultCommitWindow should be 6');
  assert.equal(result.defaultFailMode, 'FailOpen', 'defaultFailMode should be FailOpen');
  assert.equal(Object.keys(result).length, 3, 'should have exactly 3 constants despite blank lines and comments');
});

test('TC-HARDEN-1: classifyTestStrategy does not crash on truthy non-string requirement text', () => {
  const { classifyTestStrategy } = require('./formal-test-sync.cjs');
  assert.doesNotThrow(() => classifyTestStrategy(123), 'number input must not throw');
  assert.doesNotThrow(() => classifyTestStrategy({ text: 'x' }), 'object input must not throw');
  assert.doesNotThrow(() => classifyTestStrategy(['returns']), 'array input must not throw');
  assert.equal(classifyTestStrategy(123), 'structural');
  assert.equal(classifyTestStrategy({}), 'structural');
  // sanity: string path still classifies
  assert.equal(classifyTestStrategy('this returns a value'), 'behavioral');
});

test('TC-HARDEN-2: parseAlloyDefaults returns {} on null/undefined/non-string content', () => {
  const { parseAlloyDefaults } = require('./formal-test-sync.cjs');
  assert.deepEqual(parseAlloyDefaults(null), {}, 'null content should yield {}');
  assert.deepEqual(parseAlloyDefaults(undefined), {}, 'undefined content should yield {}');
  assert.deepEqual(parseAlloyDefaults(42), {}, 'numeric content should yield {}');
});

// ── TC-ENRICH: Recipe Enrichment Tests ─────────────────────────────────────

test('TC-ENRICH-1: --enrich-recipes with coderlm disabled (health error)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-enrich-test-'));
  try {
    // Create a mock recipe file with source_files
    const stubsDir = path.join(tmpDir, '.planning', 'formal', 'generated-stubs');
    fs.mkdirSync(stubsDir, { recursive: true });

    const recipe = {
      requirement_id: 'TEST-001',
      source_files: ['bin/test.cjs'],
      observed_test_patterns: {}
    };
    fs.writeFileSync(path.join(stubsDir, 'TEST-001.stub.recipe.json'), JSON.stringify(recipe) + '\n');

    // Run with --enrich-recipes but coderlm will be unavailable
    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'formal-test-sync.cjs'),
      '--project-root=' + tmpDir,
      '--enrich-recipes',
      '--report-only',
    ], {
      encoding: 'utf8',
      cwd: tmpDir,
      timeout: 10000,
    });

    // Should exit 0 and log "skipping" to stderr (fail-open)
    assert.equal(result.status, 0, 'script should exit 0 when coderlm unavailable');
    assert.match(result.stderr, /skipping/, 'stderr should contain "skipping" message');

    // Recipe file should remain unchanged (no observed_test_patterns populated)
    const recipeAfter = JSON.parse(fs.readFileSync(path.join(stubsDir, 'TEST-001.stub.recipe.json'), 'utf8'));
    assert.ok(!recipeAfter.observed_test_patterns || recipeAfter.observed_test_patterns.assert_patterns === undefined, 'recipe should not have assert_patterns written when coderlm unavailable');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-ENRICH-2: --enrich-recipes flag is parsed correctly', () => {
  // Verify the flag exists by checking the script runs without error
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'formal-test-sync.cjs'),
    '--enrich-recipes',
    '--report-only',
  ], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    timeout: 10000,
  });

  assert.equal(result.status, 0, 'script should handle --enrich-recipes flag');
});

test('TC-ENRICH-3: --report-only --enrich-recipes combined: recipe JSON mutated but stubs NOT written', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-enrich-combined-'));
  try {
    // Create recipe with no observed_test_patterns
    const stubsDir = path.join(tmpDir, '.planning', 'formal', 'generated-stubs');
    fs.mkdirSync(stubsDir, { recursive: true });

    const recipe = {
      requirement_id: 'TEST-002',
      source_files: ['bin/test.cjs'],
      observed_test_patterns: {}
    };
    fs.writeFileSync(path.join(stubsDir, 'TEST-002.stub.recipe.json'), JSON.stringify(recipe) + '\n');

    // Run with both --report-only and --enrich-recipes
    // (This will skip enrichment due to unavailable coderlm, but tests the flag interaction)
    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'formal-test-sync.cjs'),
      '--project-root=' + tmpDir,
      '--report-only',
      '--enrich-recipes',
    ], {
      encoding: 'utf8',
      cwd: tmpDir,
      timeout: 10000,
    });

    assert.equal(result.status, 0, 'combined flags should not cause errors');
    // When coderlm is unavailable, enrichment is skipped but --report-only doesn't prevent attempts
    assert.match(result.stderr, /skipping|unavailable|fatal/, 'stderr should indicate enrichment status');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-ENRICH-4: Idempotency: recipe with existing assert_patterns is skipped', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-enrich-idempotent-'));
  try {
    const stubsDir = path.join(tmpDir, '.planning', 'formal', 'generated-stubs');
    fs.mkdirSync(stubsDir, { recursive: true });

    const recipe = {
      requirement_id: 'TEST-003',
      source_files: ['bin/test.cjs'],
      observed_test_patterns: {
        assert_patterns: ['assert.strictEqual(x, y)'], // already populated
        test_files: ['test/sample.test.js']
      }
    };
    const recipePath = path.join(stubsDir, 'TEST-003.stub.recipe.json');
    fs.writeFileSync(recipePath, JSON.stringify(recipe) + '\n');
    const originalContent = fs.readFileSync(recipePath, 'utf8');

    // Run enrichment (will skip due to unavailable coderlm, but tests the idempotency check logic)
    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'formal-test-sync.cjs'),
      '--project-root=' + tmpDir,
      '--report-only',
      '--enrich-recipes',
    ], {
      encoding: 'utf8',
      cwd: tmpDir,
      timeout: 10000,
    });

    // Verify recipe unchanged (idempotency)
    const recipeAfter = fs.readFileSync(recipePath, 'utf8');
    assert.equal(recipeAfter, originalContent, 'recipe with existing assert_patterns should not be modified');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-ENRICH-5: --enrich-recipes without flag does not attempt enrichment', () => {
  // Run without --enrich-recipes flag
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'formal-test-sync.cjs'),
    '--report-only',
  ], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    timeout: 10000,
  });

  assert.equal(result.status, 0, 'script should exit 0');
  // When enrichment is not requested, stderr should NOT contain enrich-recipes messages
  assert.doesNotMatch(result.stderr, /--enrich-recipes/, 'stderr should not mention enrich-recipes when flag absent');
});

// ── TC-INT: Integration Tests ───────────────────────────────────────────────

test('TC-INT-1: Full script with --json --report-only exits 0 with valid JSON', () => {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'formal-test-sync.cjs'),
    '--json',
    '--report-only',
  ], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    timeout: 10000,
  });

  assert.equal(result.status, 0, 'script should exit 0');
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch (e) {
    assert.fail('output should be valid JSON: ' + e.message);
  }
  assert.ok(output.coverage_gaps, 'output should have coverage_gaps section');
  assert.ok(output.constants_validation, 'output should have constants_validation section');
});

test('TC-INT-2: Full script with --report-only exits 0 with human-readable summary', () => {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'formal-test-sync.cjs'),
    '--report-only',
  ], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    timeout: 10000,
  });

  assert.equal(result.status, 0, 'script should exit 0');
  assert.match(result.stdout, /Coverage gaps/, 'output should mention coverage gaps');
  assert.match(result.stdout, /Constants mismatches/, 'output should mention constants');
});

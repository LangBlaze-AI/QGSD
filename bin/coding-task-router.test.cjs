#!/usr/bin/env node
'use strict';
// bin/coding-task-router.test.cjs
// Tests for coding-task-router.cjs — Mode C coding delegation
// Pattern: coding-task-router\.cjs|buildCodingPrompt|parseCodingResult|routeCodingTask|selectSlot

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// ── Load module ─────────────────────────────────────────────────────────────
let mod;
try {
  mod = require(path.resolve(__dirname, './coding-task-router.cjs'));
} catch (e) {
  mod = null;
}

// ── STRUCTURAL TESTS ────────────────────────────────────────────────────────

test('module exists: bin/coding-task-router.cjs can be required without error', () => {
  assert.ok(mod, 'bin/coding-task-router.cjs not found');
});

test('exports: buildCodingPrompt is exported as a function', () => {
  assert.ok(mod, 'module not loaded');
  assert.strictEqual(typeof mod.buildCodingPrompt, 'function');
});

test('exports: parseCodingResult is exported as a function', () => {
  assert.ok(mod, 'module not loaded');
  assert.strictEqual(typeof mod.parseCodingResult, 'function');
});

test('exports: routeCodingTask is exported as a function', () => {
  assert.ok(mod, 'module not loaded');
  assert.strictEqual(typeof mod.routeCodingTask, 'function');
});

test('exports: selectSlot is exported as a function', () => {
  assert.ok(mod, 'module not loaded');
  assert.strictEqual(typeof mod.selectSlot, 'function');
});

// ── buildCodingPrompt TESTS ─────────────────────────────────────────────────

test('buildCodingPrompt produces prompt with all sections', () => {
  assert.ok(mod, 'module not loaded');
  const prompt = mod.buildCodingPrompt({
    task: 'Add a login function',
    repoDir: '/tmp/test-repo',
    files: ['src/auth.js', 'src/utils.js'],
    constraints: ['use CommonJS', 'do not modify tests'],
    context: 'Previous attempt failed with TypeError',
  });

  assert.ok(prompt.includes('=== TASK ==='), 'missing TASK section');
  assert.ok(prompt.includes('Add a login function'), 'missing task text');
  assert.ok(prompt.includes('=== REPOSITORY ==='), 'missing REPOSITORY section');
  assert.ok(prompt.includes('/tmp/test-repo'), 'missing repo dir');
  assert.ok(prompt.includes('=== FILES ==='), 'missing FILES section');
  assert.ok(prompt.includes('src/auth.js'), 'missing file entry');
  assert.ok(prompt.includes('=== CONSTRAINTS ==='), 'missing CONSTRAINTS section');
  assert.ok(prompt.includes('use CommonJS'), 'missing constraint');
  assert.ok(prompt.includes('=== CONTEXT ==='), 'missing CONTEXT section');
  assert.ok(prompt.includes('TypeError'), 'missing context text');
  assert.ok(prompt.includes('=== OUTPUT FORMAT ==='), 'missing OUTPUT FORMAT section');
  assert.ok(prompt.includes('status: SUCCESS | PARTIAL | FAILED'), 'missing status instruction');
});

test('buildCodingPrompt with no optional fields produces valid prompt', () => {
  assert.ok(mod, 'module not loaded');
  const prompt = mod.buildCodingPrompt({
    task: 'Refactor the parser',
    repoDir: '/tmp/repo',
  });

  assert.ok(prompt.includes('=== TASK ==='), 'missing TASK section');
  assert.ok(prompt.includes('Refactor the parser'), 'missing task text');
  assert.ok(prompt.includes('=== REPOSITORY ==='), 'missing REPOSITORY section');
  assert.ok(!prompt.includes('=== FILES ==='), 'FILES section should be absent');
  assert.ok(!prompt.includes('=== CONSTRAINTS ==='), 'CONSTRAINTS section should be absent');
  assert.ok(!prompt.includes('=== CONTEXT ==='), 'CONTEXT section should be absent');
  assert.ok(prompt.includes('=== OUTPUT FORMAT ==='), 'missing OUTPUT FORMAT section');
});

test('buildCodingPrompt does not throw on missing opts object (null-input)', () => {
  assert.ok(mod, 'module not loaded');
  assert.doesNotThrow(() => mod.buildCodingPrompt(), 'should not throw with no args');
  const prompt = mod.buildCodingPrompt();
  assert.ok(prompt.includes('=== TASK ==='), 'missing TASK section');
  assert.ok(prompt.includes('(no task specified)'), 'should fall back to placeholder task');
  assert.ok(prompt.includes('=== OUTPUT FORMAT ==='), 'missing OUTPUT FORMAT section');
});

// ── parseCodingResult TESTS ─────────────────────────────────────────────────

test('parseCodingResult extracts structured fields from well-formed output', () => {
  assert.ok(mod, 'module not loaded');
  const output = [
    'status: SUCCESS',
    'files_modified: [src/auth.js, src/utils.js]',
    'summary: Implemented the login function with JWT support',
    'diff_preview: |',
    '  +function login() { return jwt.sign({}); }',
  ].join('\n');

  const result = mod.parseCodingResult(output);
  assert.strictEqual(result.status, 'SUCCESS');
  assert.deepStrictEqual(result.filesModified, ['src/auth.js', 'src/utils.js']);
  assert.ok(result.summary.includes('login function'), 'summary missing expected content');
  assert.ok(result.rawOutput === output, 'rawOutput should match input');
});

test('parseCodingResult handles malformed output gracefully (fail-open)', () => {
  assert.ok(mod, 'module not loaded');
  const result = mod.parseCodingResult('Some random output with no structure');

  assert.strictEqual(result.status, 'UNKNOWN', 'should default to UNKNOWN');
  assert.deepStrictEqual(result.filesModified, [], 'should default to empty array');
  assert.ok(result.summary.length > 0, 'should have some summary');
  assert.ok(result.rawOutput.includes('Some random output'), 'rawOutput preserved');
});

test('parseCodingResult handles empty string (fail-open)', () => {
  assert.ok(mod, 'module not loaded');
  const result = mod.parseCodingResult('');

  assert.strictEqual(result.status, 'UNKNOWN');
  assert.deepStrictEqual(result.filesModified, []);
  assert.strictEqual(result.rawOutput, '');
});

test('parseCodingResult handles null/undefined input', () => {
  assert.ok(mod, 'module not loaded');
  const result = mod.parseCodingResult(null);

  assert.strictEqual(result.status, 'UNKNOWN');
  assert.deepStrictEqual(result.filesModified, []);
});

test('parseCodingResult extracts FAILED status', () => {
  assert.ok(mod, 'module not loaded');
  const output = 'status: FAILED\nsummary: compilation error in main.js';
  const result = mod.parseCodingResult(output);

  assert.strictEqual(result.status, 'FAILED');
  assert.ok(result.summary.includes('compilation error'), 'summary should contain error description');
});

test('parseCodingResult extracts PARTIAL status', () => {
  assert.ok(mod, 'module not loaded');
  const output = 'status: PARTIAL\nfiles_modified: [src/a.js]\nsummary: Partially implemented';
  const result = mod.parseCodingResult(output);

  assert.strictEqual(result.status, 'PARTIAL');
  assert.deepStrictEqual(result.filesModified, ['src/a.js']);
});

// ── selectSlot TESTS ────────────────────────────────────────────────────────

test('selectSlot returns first file-access subprocess provider', () => {
  assert.ok(mod, 'module not loaded');
  const providers = [
    { name: 'claude-1', type: 'http', has_file_access: false },
    { name: 'codex-1', type: 'subprocess', has_file_access: true },
    { name: 'gemini-1', type: 'subprocess', has_file_access: true },
  ];

  const result = mod.selectSlot('implement', providers);
  assert.strictEqual(result, 'codex-1');
});

test('selectSlot returns null when no suitable providers exist', () => {
  assert.ok(mod, 'module not loaded');
  const providers = [
    { name: 'claude-1', type: 'http', has_file_access: false },
    { name: 'claude-2', type: 'http', has_file_access: false },
  ];

  const result = mod.selectSlot('implement', providers);
  assert.strictEqual(result, null);
});

test('selectSlot returns null for empty array', () => {
  assert.ok(mod, 'module not loaded');
  assert.strictEqual(mod.selectSlot('fix', []), null);
});

test('selectSlot returns null for non-array input', () => {
  assert.ok(mod, 'module not loaded');
  assert.strictEqual(mod.selectSlot('fix', null), null);
  assert.strictEqual(mod.selectSlot('fix', undefined), null);
});

test('selectSlot skips null/non-object provider entries and still selects a valid one', () => {
  assert.ok(mod, 'module not loaded');
  const providers = [
    null,
    'garbage',
    { name: 'codex-1', type: 'subprocess', has_file_access: true },
  ];
  const result = mod.selectSlot('implement', providers);
  assert.strictEqual(result, 'codex-1', 'a single corrupt entry must not drop valid providers');
});

// ── INTEGRATION TESTS: Full prompt-build -> parse round-trip ────────────────

test('integration: full round-trip — buildCodingPrompt -> mock output -> parseCodingResult (SUCCESS)', () => {
  assert.ok(mod, 'module not loaded');

  // Step 1: Build a coding prompt
  const prompt = mod.buildCodingPrompt({
    task: 'Add error handling to the database module',
    repoDir: '/tmp/integration-test',
    files: ['src/db.js'],
    constraints: ['use CommonJS'],
    context: 'Previous version had unhandled promise rejections',
  });

  // Verify prompt contains the task
  assert.ok(prompt.includes('Add error handling to the database module'), 'prompt missing task');
  assert.ok(prompt.includes('=== OUTPUT FORMAT ==='), 'prompt missing output format instructions');

  // Step 2: Simulate a well-formed agent response
  const mockOutput = [
    'I have analyzed the database module and added error handling.',
    '',
    'status: SUCCESS',
    'files_modified: [src/db.js]',
    'summary: Added try-catch blocks around all database operations and proper error propagation',
    'diff_preview: |',
    '  +try {',
    '  +  await db.query(sql);',
    '  +} catch (err) {',
    '  +  logger.error(err);',
    '  +  throw new DatabaseError(err.message);',
    '  +}',
  ].join('\n');

  // Step 3: Parse the result
  const result = mod.parseCodingResult(mockOutput);

  assert.strictEqual(result.status, 'SUCCESS');
  assert.deepStrictEqual(result.filesModified, ['src/db.js']);
  assert.ok(result.summary.includes('try-catch'), 'summary should describe changes');
  assert.ok(result.rawOutput === mockOutput, 'rawOutput preserved');
});

test('integration: full round-trip — buildCodingPrompt -> mock output -> parseCodingResult (PARTIAL)', () => {
  assert.ok(mod, 'module not loaded');

  const prompt = mod.buildCodingPrompt({
    task: 'Refactor auth module to use JWT',
    repoDir: '/tmp/partial-test',
    files: ['src/auth.js', 'src/middleware.js'],
  });

  assert.ok(prompt.includes('Refactor auth module'), 'prompt missing task');

  const mockOutput = [
    'status: PARTIAL',
    'files_modified: [src/auth.js]',
    'summary: Refactored auth.js to use JWT but middleware.js needs manual migration',
  ].join('\n');

  const result = mod.parseCodingResult(mockOutput);

  assert.strictEqual(result.status, 'PARTIAL');
  assert.deepStrictEqual(result.filesModified, ['src/auth.js']);
  assert.ok(result.summary.includes('middleware.js needs manual'), 'summary should explain partial');
});

test('integration: error handling path — parseCodingResult with only status FAILED', () => {
  assert.ok(mod, 'module not loaded');

  const mockOutput = 'status: FAILED\nsummary: compilation error — missing import for jwt module';
  const result = mod.parseCodingResult(mockOutput);

  assert.strictEqual(result.status, 'FAILED');
  assert.ok(result.summary.includes('compilation error'), 'summary should describe failure');
  assert.deepStrictEqual(result.filesModified, [], 'no files modified on failure');
});

test('integration: error handling path — empty output returns fail-open result', () => {
  assert.ok(mod, 'module not loaded');

  const result = mod.parseCodingResult('');
  assert.strictEqual(result.status, 'UNKNOWN');
  assert.deepStrictEqual(result.filesModified, []);
  assert.strictEqual(result.diffPreview, null);
});

test('integration: prompt contains all required sections for agent consumption', () => {
  assert.ok(mod, 'module not loaded');

  const prompt = mod.buildCodingPrompt({
    task: 'Write unit tests for parser',
    repoDir: '/home/user/project',
    files: ['src/parser.js', 'test/parser.test.js'],
    constraints: ['use node:test framework', 'minimum 80% coverage'],
    context: 'Parser currently has no tests',
  });

  // Verify all sections are present and ordered
  const taskIdx = prompt.indexOf('=== TASK ===');
  const repoIdx = prompt.indexOf('=== REPOSITORY ===');
  const filesIdx = prompt.indexOf('=== FILES ===');
  const constraintsIdx = prompt.indexOf('=== CONSTRAINTS ===');
  const contextIdx = prompt.indexOf('=== CONTEXT ===');
  const formatIdx = prompt.indexOf('=== OUTPUT FORMAT ===');

  assert.ok(taskIdx >= 0, 'TASK section missing');
  assert.ok(repoIdx > taskIdx, 'REPOSITORY should follow TASK');
  assert.ok(filesIdx > repoIdx, 'FILES should follow REPOSITORY');
  assert.ok(constraintsIdx > filesIdx, 'CONSTRAINTS should follow FILES');
  assert.ok(contextIdx > constraintsIdx, 'CONTEXT should follow CONSTRAINTS');
  assert.ok(formatIdx > contextIdx, 'OUTPUT FORMAT should be last');
});

// ── selectSlot with policy layer (backward compat) ──────────────────────────

test('selectSlot still returns first file-access subprocess provider (backward compat with policy layer)', () => {
  assert.ok(mod, 'module not loaded');
  const providers = [
    { name: 'claude-1', type: 'http', has_file_access: false },
    { name: 'codex-1', type: 'subprocess', has_file_access: true },
    { name: 'gemini-1', type: 'subprocess', has_file_access: true },
  ];

  const result = mod.selectSlot('implement', providers);
  assert.strictEqual(result, 'codex-1', 'should delegate through policy layer and get same result');
});

// ── recordRoutingReward TESTS ───────────────────────────────────────────────

test('recordRoutingReward is exported as a function', () => {
  assert.ok(mod, 'module not loaded');
  assert.strictEqual(typeof mod.recordRoutingReward, 'function');
});

test('recordRoutingReward does not throw on call', () => {
  assert.ok(mod, 'module not loaded');
  assert.doesNotThrow(() => {
    mod.recordRoutingReward({ taskType: 'implement', slot: 'codex-1', reward: 0.9, latencyMs: 500 });
  });
});

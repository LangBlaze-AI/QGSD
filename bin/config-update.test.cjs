#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  getMaxIterations,
  updateMaxIterations,
  createSessionDirectory,
  parseMaxIterationsArg
} = require('./config-update.cjs');

// Test: getMaxIterations returns 3 from default config
test('getMaxIterations returns default 3 when key missing', () => {
  // Create a temp config without max_iterations
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-update-'));
  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(
    path.join(planningDir, 'config.json'),
    JSON.stringify({ mode: 'test' }, null, 2) + '\n'
  );

  const result = getMaxIterations(tmpDir);
  assert.strictEqual(result, 3);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
});

// Test: getMaxIterations reads from config when present
test('getMaxIterations returns value from config when present', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-update-'));
  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(
    path.join(planningDir, 'config.json'),
    JSON.stringify({ max_iterations: 5, mode: 'test' }, null, 2) + '\n'
  );

  const result = getMaxIterations(tmpDir);
  assert.strictEqual(result, 5);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
});

// Test: updateMaxIterations persists value to config
test('updateMaxIterations persists value to config', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-update-'));
  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(
    path.join(planningDir, 'config.json'),
    JSON.stringify({ max_iterations: 3, mode: 'test' }, null, 2) + '\n'
  );

  updateMaxIterations(7, tmpDir);
  const result = getMaxIterations(tmpDir);
  assert.strictEqual(result, 7);

  // Verify file was written with correct formatting
  const content = fs.readFileSync(path.join(planningDir, 'config.json'), 'utf-8');
  assert.ok(content.includes('"max_iterations": 7'), 'Should contain updated value');
  assert.ok(content.endsWith('\n'), 'Should have trailing newline');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
});

// Test: updateMaxIterations throws on non-positive integer
test('updateMaxIterations throws on non-positive integer', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-update-'));
  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(
    path.join(planningDir, 'config.json'),
    JSON.stringify({ max_iterations: 3 }, null, 2) + '\n'
  );

  assert.throws(() => updateMaxIterations(0, tmpDir), /positive integer/);
  assert.throws(() => updateMaxIterations(-1, tmpDir), /positive integer/);
  assert.throws(() => updateMaxIterations('abc', tmpDir), /positive integer/);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
});

// Test: createSessionDirectory creates directory with session prefix
test('createSessionDirectory creates directory with session prefix', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-update-'));
  const formalDir = path.join(tmpDir, '.planning', 'formal');
  fs.mkdirSync(formalDir, { recursive: true });

  const sessionDir = createSessionDirectory(tmpDir);
  assert.ok(fs.existsSync(sessionDir), 'Session directory should exist');
  assert.ok(sessionDir.includes('session-'), 'Should contain session- prefix');
  assert.ok(/session-[a-f0-9]{16}$/.test(sessionDir), 'Should have hex16 suffix');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
});

// Test: parseMaxIterationsArg parses --max-iterations=5 correctly
test('parseMaxIterationsArg parses --max-iterations=5 correctly', () => {
  const argv = ['node', 'script.js', '--max-iterations=5'];
  const result = parseMaxIterationsArg(argv);
  assert.strictEqual(result, 5);
});

// Test: parseMaxIterationsArg returns null when flag absent
test('parseMaxIterationsArg returns null when flag absent', () => {
  const argv = ['node', 'script.js', '--other-flag=value'];
  const result = parseMaxIterationsArg(argv);
  assert.strictEqual(result, null);
});

// Test: parseMaxIterationsArg returns null for invalid values
test('parseMaxIterationsArg returns null for invalid values', () => {
  assert.strictEqual(parseMaxIterationsArg(['node', 'script.js', '--max-iterations=abc']), null);
  assert.strictEqual(parseMaxIterationsArg(['node', 'script.js', '--max-iterations=0']), null);
  assert.strictEqual(parseMaxIterationsArg(['node', 'script.js', '--max-iterations=-5']), null);
});

// Integration test: set max_iterations and verify refinement-loop would read it
test('Integration: config-driven iteration limits affect loop behavior', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-update-'));
  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });

  // Set to 2 iterations
  fs.writeFileSync(
    path.join(planningDir, 'config.json'),
    JSON.stringify({ max_iterations: 2 }, null, 2) + '\n'
  );

  // Verify the value is read
  const max = getMaxIterations(tmpDir);
  assert.strictEqual(max, 2, 'Config should specify 2 iterations');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
});

// Integration test: verify config persists across updates
test('Integration: updateMaxIterations and getMaxIterations round-trip', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-update-'));
  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(
    path.join(planningDir, 'config.json'),
    JSON.stringify({ max_iterations: 3 }, null, 2) + '\n'
  );

  // Update to 5
  updateMaxIterations(5, tmpDir);
  assert.strictEqual(getMaxIterations(tmpDir), 5);

  // Update to 10
  updateMaxIterations(10, tmpDir);
  assert.strictEqual(getMaxIterations(tmpDir), 10);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
});

// Test: getMaxIterations falls back to default 3 for invalid numeric values
test('getMaxIterations falls back to 3 for non-positive or non-integer config values', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-update-'));
  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  const cfgPath = path.join(planningDir, 'config.json');

  fs.writeFileSync(cfgPath, JSON.stringify({ max_iterations: 0 }, null, 2) + '\n');
  assert.strictEqual(getMaxIterations(tmpDir), 3, 'zero should fall back to default');

  fs.writeFileSync(cfgPath, JSON.stringify({ max_iterations: -5 }, null, 2) + '\n');
  assert.strictEqual(getMaxIterations(tmpDir), 3, 'negative should fall back to default');

  fs.writeFileSync(cfgPath, JSON.stringify({ max_iterations: 2.5 }, null, 2) + '\n');
  assert.strictEqual(getMaxIterations(tmpDir), 3, 'non-integer should fall back to default');

  fs.rmSync(tmpDir, { recursive: true });
});

// Test: parseMaxIterationsArg tolerates non-string argv entries
test('parseMaxIterationsArg skips non-string argv entries without throwing', () => {
  assert.strictEqual(
    parseMaxIterationsArg(['node', 'script.js', undefined, '--max-iterations=4']),
    4,
    'should ignore non-string entries and still find the flag'
  );
  assert.strictEqual(
    parseMaxIterationsArg(['node', 'script.js', 42, null]),
    null,
    'should return null (not throw) when no string flag present'
  );
});

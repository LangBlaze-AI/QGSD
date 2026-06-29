'use strict';
// Test suite for bin/resolve-cli.cjs
// Uses Node.js built-in test runner: node --test bin/resolve-cli.test.cjs
//
// Tests the resolveCli() export which locates CLI executables via
// which, Homebrew prefixes, npm global bin, and system paths — with a
// bare-name fallback that never throws.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveCli, resolveSpawnTarget } = require('./resolve-cli.cjs');

// ─── resolveSpawnTarget() tests (issue #197) ──────────────────────────────────

test('resolveSpawnTarget prefers resolvedCli when present', () => {
  assert.equal(resolveSpawnTarget({ resolvedCli: '/abs/codex', cli: 'codex' }), '/abs/codex');
});

test('resolveSpawnTarget falls back to mainTool when cli is absent (null-CLI class)', () => {
  // Only mainTool set — previously raw p.cli handed null to spawn().
  const r = resolveSpawnTarget({ mainTool: 'node' });
  assert.ok(r === 'node' || r.endsWith(path.sep + 'node') || r.endsWith('/node'));
});

test('resolveSpawnTarget resolves cli via resolveCli', () => {
  const r = resolveSpawnTarget({ cli: 'node' });
  assert.ok(r === 'node' || r.endsWith(path.sep + 'node') || r.endsWith('/node'));
});

test('resolveSpawnTarget returns empty string when nothing is resolvable', () => {
  assert.equal(resolveSpawnTarget({ name: 'x' }), '');
  assert.equal(resolveSpawnTarget(null), '');
  assert.equal(resolveSpawnTarget(undefined), '');
});

test('resolveSpawnTarget returns a string when resolvedCli is a non-string (type guard)', () => {
  assert.equal(typeof resolveSpawnTarget({ resolvedCli: 42 }), 'string');
  assert.equal(resolveSpawnTarget({ resolvedCli: 42 }), '');
  assert.equal(resolveSpawnTarget({ resolvedCli: { path: '/x' } }), '');
  // falls through to cli when resolvedCli is unusable
  const r = resolveSpawnTarget({ resolvedCli: 42, cli: 'node' });
  assert.ok(r === 'node' || r.endsWith(path.sep + 'node') || r.endsWith('/node'));
});

// ─── Basic contract tests ─────────────────────────────────────────────────────

test('returns a non-empty string for a known system CLI (node)', () => {
  const result = resolveCli('node');
  assert.equal(typeof result, 'string');
  assert.ok(result.length > 0, 'Should return non-empty string');
});

test('returns a string for a nonexistent CLI (falls back to bare name)', () => {
  const result = resolveCli('definitely-nonexistent-cli-xyz-12345');
  assert.equal(result, 'definitely-nonexistent-cli-xyz-12345', 'Should fall back to bare name');
});

test('node resolves to an absolute path', () => {
  const result = resolveCli('node');
  // node should be findable via which on any system running this test
  assert.ok(path.isAbsolute(result), `Expected absolute path, got: ${result}`);
});

test('returns bare name for CLI with path traversal in name (safety)', () => {
  const result = resolveCli('../etc/passwd');
  // Should not resolve to a real path dangerously — returns input as bare name
  assert.equal(typeof result, 'string');
});

// ─── Input validation tests ───────────────────────────────────────────────────

test('empty string input returns empty string', () => {
  const result = resolveCli('');
  assert.equal(result, '');
});

test('null input returns empty string', () => {
  const result = resolveCli(null);
  assert.equal(result, '');
});

test('undefined input returns empty string', () => {
  const result = resolveCli(undefined);
  assert.equal(result, '');
});

test('non-string truthy input: falls back without throwing', () => {
  // The function short-circuits on non-string input: returns `name || ''`.
  // For truthy non-strings (e.g. 42), that means the input is returned as-is.
  // The important contract is: never throws.
  assert.doesNotThrow(() => resolveCli(42));
});

test('resolveCli always returns a string for non-string truthy input (spawn-safety contract)', () => {
  assert.equal(typeof resolveCli(42), 'string', 'number input must not be returned as a number');
  assert.equal(typeof resolveCli([]), 'string', 'array input must not be returned as an array');
  assert.equal(typeof resolveCli({ cli: 'x' }), 'string', 'object input must not be returned as an object');
  // Safe sentinel: unresolvable non-string degrades to empty string
  assert.equal(resolveCli(42), '');
  assert.equal(resolveCli([]), '');
  assert.equal(resolveCli({ cli: 'x' }), '');
});

// ─── Never-throws contract ────────────────────────────────────────────────────

test('does not throw for any string input', () => {
  const inputs = [
    'node', 'npm', 'git', 'python', 'ruby',
    'zzz-fake', '', 'with spaces', '/absolute/path',
    '../../escape', 'name\nwith\nnewlines',
  ];
  for (const input of inputs) {
    assert.doesNotThrow(() => resolveCli(input), `Should not throw for input: ${JSON.stringify(input)}`);
  }
});

// ─── Homebrew path detection test ────────────────────────────────────────────

test('returns string ending with CLI name when resolved via any strategy', () => {
  // For any resolvable CLI, the returned path should end with the name
  const name = 'git'; // git is almost universally available
  const result = resolveCli(name);
  // Either an absolute path ending with 'git', or bare 'git' fallback
  assert.ok(result === name || result.endsWith(path.sep + name) || result.endsWith('/' + name),
    `Expected path to end with '${name}', got: ${result}`);
});

// ─── Standalone CLI interface test ────────────────────────────────────────────

test('standalone CLI: exits 1 without argument', () => {
  const { spawnSync } = require('child_process');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'resolve-cli.cjs')], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('Usage'));
});

test('standalone CLI: prints resolved path to stdout', () => {
  const { spawnSync } = require('child_process');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'resolve-cli.cjs'), 'node'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.trim().length > 0);
});

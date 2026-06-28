'use strict';

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'formal-coverage-intersect.cjs');

/**
 * Run formal-coverage-intersect.cjs with given args in a specific cwd.
 */
function run(args, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: cwd || process.cwd(),
  });
}

/**
 * Create a temporary project structure with scope.json files.
 */
function createTmpProject(modules) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fci-test-'));
  const specDir = path.join(tmpDir, '.planning', 'formal', 'spec');

  for (const mod of modules) {
    const modDir = path.join(specDir, mod.name);
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(
      path.join(modDir, 'scope.json'),
      JSON.stringify(mod.scope, null, 2),
      'utf8'
    );
  }

  return tmpDir;
}

// ─── Test 1: exits 1 when no --files provided ──────────────────────────────
test('exits 1 when no --files provided', () => {
  const result = run([]);
  assert.strictEqual(result.status, 1, 'Expected exit code 1 for missing --files');
  assert.ok(result.stderr.includes('--files is required'), 'Should show usage error');
});

// ─── Test 2: exits 0 with help flag ────────────────────────────────────────
test('exits 0 with --help flag', () => {
  const result = run(['--help']);
  assert.strictEqual(result.status, 0, 'Expected exit code 0 for --help');
  assert.ok(result.stdout.includes('Usage:'), 'Should show help text');
});

// ─── Test 3: exits 2 when no spec directory exists ─────────────────────────
test('exits 2 when no spec directory exists', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fci-test-'));
  const result = run(['--files', 'hooks/nf-stop.js'], tmpDir);
  assert.strictEqual(result.status, 2, 'Expected exit code 2 for missing spec dir');
  const json = JSON.parse(result.stdout);
  assert.strictEqual(json.intersections_found, false);
  assert.strictEqual(json.total_modules_affected, 0);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Test 4: finds intersection with matching file ─────────────────────────
test('finds intersection with matching file', () => {
  const tmpDir = createTmpProject([
    {
      name: 'quorum',
      scope: {
        source_files: ['bin/run-quorum.cjs', 'hooks/nf-prompt.js', 'hooks/nf-stop.js'],
        concepts: ['quorum'],
        requirements: []
      }
    }
  ]);

  const result = run(['--files', 'hooks/nf-stop.js'], tmpDir);
  assert.strictEqual(result.status, 0, 'Expected exit code 0 for intersection found');
  const json = JSON.parse(result.stdout);
  assert.strictEqual(json.intersections_found, true);
  assert.strictEqual(json.total_modules_affected, 1);
  assert.strictEqual(json.modules[0].name, 'quorum');
  assert.deepStrictEqual(json.modules[0].matched_files, ['hooks/nf-stop.js']);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Test 5: no intersection for unrelated file ────────────────────────────
test('no intersection for unrelated file', () => {
  const tmpDir = createTmpProject([
    {
      name: 'quorum',
      scope: {
        source_files: ['bin/run-quorum.cjs', 'hooks/nf-stop.js'],
        concepts: ['quorum'],
        requirements: []
      }
    }
  ]);

  const result = run(['--files', 'src/unrelated.js'], tmpDir);
  assert.strictEqual(result.status, 2, 'Expected exit code 2 for no intersection');
  const json = JSON.parse(result.stdout);
  assert.strictEqual(json.intersections_found, false);
  assert.strictEqual(json.total_modules_affected, 0);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Test 6: glob matching works (e.g., bin/*.cjs) ────────────────────────
test('glob matching works with wildcard patterns', () => {
  const tmpDir = createTmpProject([
    {
      name: 'breaker',
      scope: {
        source_files: ['hooks/*.js'],
        concepts: ['breaker'],
        requirements: []
      }
    }
  ]);

  const result = run(['--files', 'hooks/nf-circuit-breaker.js'], tmpDir);
  assert.strictEqual(result.status, 0, 'Expected exit code 0 for glob match');
  const json = JSON.parse(result.stdout);
  assert.strictEqual(json.intersections_found, true);
  assert.strictEqual(json.modules[0].name, 'breaker');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Test 7: multiple modules can match the same file ──────────────────────
test('multiple modules can match the same file', () => {
  const tmpDir = createTmpProject([
    {
      name: 'quorum',
      scope: {
        source_files: ['hooks/nf-stop.js'],
        concepts: ['quorum'],
        requirements: []
      }
    },
    {
      name: 'stop-hook',
      scope: {
        source_files: ['hooks/nf-stop.js'],
        concepts: ['stop'],
        requirements: []
      }
    }
  ]);

  const result = run(['--files', 'hooks/nf-stop.js'], tmpDir);
  assert.strictEqual(result.status, 0, 'Expected exit code 0 for multiple matches');
  const json = JSON.parse(result.stdout);
  assert.strictEqual(json.intersections_found, true);
  assert.strictEqual(json.total_modules_affected, 2);
  const names = json.modules.map(m => m.name).sort();
  assert.deepStrictEqual(names, ['quorum', 'stop-hook']);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Test 8: skips scope.json with parse errors ────────────────────────────
test('skips scope.json with parse errors gracefully', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fci-test-'));
  const specDir = path.join(tmpDir, '.planning', 'formal', 'spec', 'broken');
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, 'scope.json'), 'NOT VALID JSON', 'utf8');

  // Add a valid module too
  const validDir = path.join(tmpDir, '.planning', 'formal', 'spec', 'valid');
  fs.mkdirSync(validDir, { recursive: true });
  fs.writeFileSync(path.join(validDir, 'scope.json'), JSON.stringify({
    source_files: ['hooks/*.js'],
    concepts: [],
    requirements: []
  }), 'utf8');

  const result = run(['--files', 'hooks/nf-stop.js'], tmpDir);
  assert.strictEqual(result.status, 0, 'Expected exit code 0 — broken module skipped, valid matched');
  const json = JSON.parse(result.stdout);
  assert.strictEqual(json.intersections_found, true);
  assert.strictEqual(json.modules[0].name, 'valid');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Test 9: multiple files, some match, some don't ────────────────────────
test('handles multiple input files with partial matches', () => {
  const tmpDir = createTmpProject([
    {
      name: 'quorum',
      scope: {
        source_files: ['bin/run-quorum.cjs'],
        concepts: ['quorum'],
        requirements: []
      }
    }
  ]);

  const result = run(['--files', 'bin/run-quorum.cjs,src/unrelated.js'], tmpDir);
  assert.strictEqual(result.status, 0, 'Expected exit code 0 for partial match');
  const json = JSON.parse(result.stdout);
  assert.strictEqual(json.intersections_found, true);
  assert.deepStrictEqual(json.modules[0].matched_files, ['bin/run-quorum.cjs']);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Test 10: works against real project spec directory ────────────────────
test('detects intersection against real project scope.json files', () => {
  // This test runs against the actual project — it should find quorum module for hooks/nf-stop.js
  const result = run(['--files', 'hooks/nf-stop.js']);
  // We expect exit 0 because quorum/scope.json has hooks/nf-stop.js in source_files
  assert.strictEqual(result.status, 0, 'Expected exit code 0 for real project intersection');
  const json = JSON.parse(result.stdout);
  assert.strictEqual(json.intersections_found, true);
  assert.ok(json.modules.some(m => m.name === 'quorum'), 'Should find quorum module');
});

// ─── Test 11: skips scope.json that is valid JSON `null` without crashing ───
test('skips scope.json that is valid JSON null without crashing (fail-open)', () => {
  const tmpDir = createTmpProject([
    // createTmpProject does JSON.stringify(null) -> writes the literal "null"
    { name: 'null-mod', scope: null },
    {
      name: 'valid',
      scope: { source_files: ['hooks/*.js'], concepts: [], requirements: [] }
    }
  ]);

  // 'null-mod' sorts before 'valid', so the null module is scanned first and
  // must NOT abort the run before the valid module is reached.
  const result = run(['--files', 'hooks/nf-stop.js'], tmpDir);
  assert.strictEqual(result.status, 0, 'Expected exit 0 — null module skipped, valid matched (currently crashes with exit 1)');
  const json = JSON.parse(result.stdout);
  assert.strictEqual(json.intersections_found, true);
  assert.ok(json.modules.some(m => m.name === 'valid'), 'Should still find the valid module');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

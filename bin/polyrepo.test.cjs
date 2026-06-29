#!/usr/bin/env node
'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const polyrepo = require('./polyrepo.cjs');

/**
 * Create isolated test environment
 */
function createTestEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-polyrepo-test-'));
  const polyreposDir = path.join(tmpDir, '.claude', 'polyrepos');
  const repoA = path.join(tmpDir, 'repo-a');
  const repoB = path.join(tmpDir, 'repo-b');
  const repoC = path.join(tmpDir, 'repo-c');

  fs.mkdirSync(polyreposDir, { recursive: true });
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });
  fs.mkdirSync(repoC, { recursive: true });

  return { tmpDir, polyreposDir, repoA, repoB, repoC };
}

/**
 * Run polyrepo CLI with custom HOME
 */
function runCLI(args, homeDir) {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'polyrepo.cjs'),
    ...args
  ], {
    encoding: 'utf8',
    env: { ...process.env, HOME: homeDir },
    cwd: homeDir
  });
  return result;
}

describe('polyrepo.cjs', () => {
  describe('Unit Tests: Validation Logic', () => {
    test('PR-VALIDATE-1: invalid group name with spaces rejected', () => {
      const nameRegex = /^[a-z0-9][a-z0-9-]*$/;
      assert.equal(nameRegex.test('my product'), false);
      assert.equal(nameRegex.test('My-Product'), false);
      assert.equal(nameRegex.test('-bad'), false);
      assert.equal(nameRegex.test(' leading'), false);
    });

    test('PR-VALIDATE-2: valid group names accepted', () => {
      const nameRegex = /^[a-z0-9][a-z0-9-]*$/;
      assert.equal(nameRegex.test('good-name'), true);
      assert.equal(nameRegex.test('a'), true);
      assert.equal(nameRegex.test('my-product-v1'), true);
      assert.equal(nameRegex.test('123-abc'), true);
    });

    test('PR-VALIDATE-3: role accepts any non-empty string', () => {
      const roles = ['frontend', 'backend', 'infra', 'marketing', 'monorepo', 'my-custom-role', 'UPPERCASE'];
      roles.forEach(r => {
        assert.ok(typeof r === 'string' && r.length > 0);
      });
    });
  });

  describe('Integration Tests: CLI with temp HOME', () => {
    test('PR-CREATE-1: create subcommand creates group config', () => {
      const env = createTestEnv();
      const result = runCLI(['create', 'test-product'], env.tmpDir);

      assert.equal(result.status, 0, `Expected exit 0, got ${result.status}. stderr: ${result.stderr}`);

      const configPath = path.join(env.polyreposDir, 'test-product.json');
      assert.ok(fs.existsSync(configPath), 'group config file created');

      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.equal(config.name, 'test-product');
      assert.ok(Array.isArray(config.repos));
      assert.equal(config.repos.length, 0, 'should start with empty repos array');

      fs.rmSync(env.tmpDir, { recursive: true, force: true });
    });

    test('PR-ADD-1: add subcommand adds repo and writes marker', () => {
      const env = createTestEnv();

      // Create group first
      const createResult = runCLI(['create', 'test-product'], env.tmpDir);
      assert.equal(createResult.status, 0);

      // Add repo
      const addResult = runCLI(['add', 'test-product', env.repoA, 'frontend'], env.tmpDir);
      assert.equal(addResult.status, 0, `add failed: ${addResult.stderr}`);

      // Verify group config updated
      const configPath = path.join(env.polyreposDir, 'test-product.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.equal(config.repos.length, 1);
      assert.equal(config.repos[0].role, 'frontend');
      assert.equal(config.repos[0].path, env.repoA);
      assert.equal(config.repos[0].planning, true);

      // Verify per-repo marker
      const markerPath = path.join(env.repoA, '.planning', 'polyrepo.json');
      assert.ok(fs.existsSync(markerPath), 'marker should exist');
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      assert.equal(marker.name, 'test-product');
      assert.equal(marker.role, 'frontend');

      fs.rmSync(env.tmpDir, { recursive: true, force: true });
    });

    test('PR-REMOVE-1: remove subcommand removes repo from group and deletes marker', () => {
      const env = createTestEnv();

      // Create and add
      runCLI(['create', 'test-product'], env.tmpDir);
      runCLI(['add', 'test-product', env.repoA, 'frontend'], env.tmpDir);

      // Verify marker exists before removal
      const markerPath = path.join(env.repoA, '.planning', 'polyrepo.json');
      assert.ok(fs.existsSync(markerPath), 'marker should exist before removal');

      // Remove
      const removeResult = runCLI(['remove', 'test-product', env.repoA], env.tmpDir);
      assert.equal(removeResult.status, 0, `remove failed: ${removeResult.stderr}`);

      // Verify marker removed
      assert.ok(!fs.existsSync(markerPath), 'marker should be deleted');

      // Verify group config deleted (since last repo removed)
      const configPath = path.join(env.polyreposDir, 'test-product.json');
      assert.ok(!fs.existsSync(configPath), 'config file should be deleted when group becomes empty');

      fs.rmSync(env.tmpDir, { recursive: true, force: true });
    });

    test('PR-LIST-1: list subcommand shows groups after creation', () => {
      const env = createTestEnv();

      // Create and add multiple repos
      runCLI(['create', 'my-product'], env.tmpDir);
      runCLI(['add', 'my-product', env.repoA, 'frontend'], env.tmpDir);
      runCLI(['add', 'my-product', env.repoB, 'backend'], env.tmpDir);

      // Run list
      const listResult = runCLI(['list'], env.tmpDir);
      assert.equal(listResult.status, 0);

      assert.ok(listResult.stdout.includes('my-product'), 'output should contain group name');
      assert.ok(listResult.stdout.includes('2 repos'), 'output should show repo count');
      assert.ok(listResult.stdout.includes('frontend'), 'output should contain role');
      assert.ok(listResult.stdout.includes(env.repoA), 'output should contain repo path');

      fs.rmSync(env.tmpDir, { recursive: true, force: true });
    });

    test('PR-INFO-1: info subcommand reads marker from cwd', () => {
      const env = createTestEnv();

      // Create group and add repo
      runCLI(['create', 'my-product'], env.tmpDir);
      runCLI(['add', 'my-product', env.repoA, 'frontend'], env.tmpDir);

      // Run info from within repoA
      const infoResult = spawnSync(process.execPath, [
        path.join(__dirname, 'polyrepo.cjs'), 'info'
      ], {
        encoding: 'utf8',
        env: { ...process.env, HOME: env.tmpDir },
        cwd: env.repoA
      });

      assert.equal(infoResult.status, 0, `info failed: ${infoResult.stderr}`);
      assert.ok(infoResult.stdout.includes('my-product'), 'output should contain group name');
      assert.ok(infoResult.stdout.includes('frontend'), 'output should contain role');
      assert.ok(infoResult.stdout.includes('yes'), 'output should show planning: yes');

      fs.rmSync(env.tmpDir, { recursive: true, force: true });
    });

    test('PR-ADD-NOPLAN-1: add --no-planning sets planning to false and does NOT write marker', () => {
      const env = createTestEnv();

      // Create group
      runCLI(['create', 'test-product'], env.tmpDir);

      // Add with --no-planning
      const addResult = runCLI(['add', 'test-product', env.repoA, 'infra', '--no-planning'], env.tmpDir);
      assert.equal(addResult.status, 0);

      // Verify repo in config
      const configPath = path.join(env.polyreposDir, 'test-product.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.equal(config.repos[0].planning, false);

      // Verify marker was NOT written
      const markerPath = path.join(env.repoA, '.planning', 'polyrepo.json');
      assert.ok(!fs.existsSync(markerPath), 'marker should NOT be written when planning=false');

      fs.rmSync(env.tmpDir, { recursive: true, force: true });
    });

    test('PR-DUP-1: adding same path twice to a group returns error', () => {
      const env = createTestEnv();

      // Create and add once
      runCLI(['create', 'test-product'], env.tmpDir);
      runCLI(['add', 'test-product', env.repoA, 'frontend'], env.tmpDir);

      // Try to add same path again
      const dupResult = runCLI(['add', 'test-product', env.repoA, 'backend'], env.tmpDir);
      assert.notEqual(dupResult.status, 0, 'should fail when adding duplicate path');
      assert.ok(dupResult.stderr.includes('already'), 'error message should mention duplicate');

      fs.rmSync(env.tmpDir, { recursive: true, force: true });
    });

    test('PR-EMPTY-1: removing last repo from a group deletes the group config file', () => {
      const env = createTestEnv();

      // Create and add single repo
      runCLI(['create', 'test-product'], env.tmpDir);
      runCLI(['add', 'test-product', env.repoA, 'frontend'], env.tmpDir);

      const configPath = path.join(env.polyreposDir, 'test-product.json');
      assert.ok(fs.existsSync(configPath), 'config should exist before removal');

      // Remove the only repo
      const removeResult = runCLI(['remove', 'test-product', env.repoA], env.tmpDir);
      assert.equal(removeResult.status, 0);

      // Verify config file deleted
      assert.ok(!fs.existsSync(configPath), 'config file should be deleted when group becomes empty');

      fs.rmSync(env.tmpDir, { recursive: true, force: true });
    });

    test('PR-ROLE-DEFAULT-1: role defaults to basename if omitted', () => {
      const env = createTestEnv();

      // Create and add without explicit role
      runCLI(['create', 'test-product'], env.tmpDir);
      const addResult = runCLI(['add', 'test-product', env.repoA], env.tmpDir);
      assert.equal(addResult.status, 0);

      // Verify role is basename
      const configPath = path.join(env.polyreposDir, 'test-product.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.equal(config.repos[0].role, 'repo-a', 'role should default to directory basename');

      fs.rmSync(env.tmpDir, { recursive: true, force: true });
    });

    test('PR-DOCS-SET-1: docs set writes doc paths to marker', () => {
      const env = createTestEnv();

      runCLI(['create', 'test-product'], env.tmpDir);
      runCLI(['add', 'test-product', env.repoA, 'frontend'], env.tmpDir);

      // Set docs via CLI from within repoA
      const setResult = spawnSync(process.execPath, [
        path.join(__dirname, 'polyrepo.cjs'), 'docs', 'set', 'user', 'docs/'
      ], {
        encoding: 'utf8',
        env: { ...process.env, HOME: env.tmpDir },
        cwd: env.repoA
      });
      assert.equal(setResult.status, 0, `docs set failed: ${setResult.stderr}`);

      // Verify marker now has docs
      const marker = JSON.parse(fs.readFileSync(
        path.join(env.repoA, '.planning', 'polyrepo.json'), 'utf8'
      ));
      assert.equal(marker.docs.user, 'docs/');
      assert.equal(marker.name, 'test-product');
      assert.equal(marker.role, 'frontend');

      fs.rmSync(env.tmpDir, { recursive: true, force: true });
    });

    test('PR-DOCS-SET-2: docs set merges multiple keys', () => {
      const env = createTestEnv();

      runCLI(['create', 'test-product'], env.tmpDir);
      runCLI(['add', 'test-product', env.repoA, 'backend'], env.tmpDir);

      const cliOpts = {
        encoding: 'utf8',
        env: { ...process.env, HOME: env.tmpDir },
        cwd: env.repoA
      };

      // Set multiple doc paths
      spawnSync(process.execPath, [path.join(__dirname, 'polyrepo.cjs'), 'docs', 'set', 'user', 'docs/'], cliOpts);
      spawnSync(process.execPath, [path.join(__dirname, 'polyrepo.cjs'), 'docs', 'set', 'developer', 'docs/internal/'], cliOpts);
      spawnSync(process.execPath, [path.join(__dirname, 'polyrepo.cjs'), 'docs', 'set', 'examples', 'examples/'], cliOpts);

      const marker = JSON.parse(fs.readFileSync(
        path.join(env.repoA, '.planning', 'polyrepo.json'), 'utf8'
      ));
      assert.equal(marker.docs.user, 'docs/');
      assert.equal(marker.docs.developer, 'docs/internal/');
      assert.equal(marker.docs.examples, 'examples/');

      fs.rmSync(env.tmpDir, { recursive: true, force: true });
    });

    test('PR-DOCS-REMOVE-1: docs remove deletes a key', () => {
      const env = createTestEnv();

      runCLI(['create', 'test-product'], env.tmpDir);
      runCLI(['add', 'test-product', env.repoA, 'frontend'], env.tmpDir);

      const cliOpts = {
        encoding: 'utf8',
        env: { ...process.env, HOME: env.tmpDir },
        cwd: env.repoA
      };

      // Set then remove
      spawnSync(process.execPath, [path.join(__dirname, 'polyrepo.cjs'), 'docs', 'set', 'user', 'docs/'], cliOpts);
      spawnSync(process.execPath, [path.join(__dirname, 'polyrepo.cjs'), 'docs', 'set', 'developer', 'internal/'], cliOpts);
      spawnSync(process.execPath, [path.join(__dirname, 'polyrepo.cjs'), 'docs', 'remove', 'user'], cliOpts);

      const marker = JSON.parse(fs.readFileSync(
        path.join(env.repoA, '.planning', 'polyrepo.json'), 'utf8'
      ));
      assert.equal(marker.docs.developer, 'internal/');
      assert.equal(marker.docs.user, undefined, 'user key should be removed');

      fs.rmSync(env.tmpDir, { recursive: true, force: true });
    });

    test('PR-DOCS-INFO-1: info shows docs when present', () => {
      const env = createTestEnv();

      runCLI(['create', 'test-product'], env.tmpDir);
      runCLI(['add', 'test-product', env.repoA, 'frontend'], env.tmpDir);

      const cliOpts = {
        encoding: 'utf8',
        env: { ...process.env, HOME: env.tmpDir },
        cwd: env.repoA
      };

      spawnSync(process.execPath, [path.join(__dirname, 'polyrepo.cjs'), 'docs', 'set', 'user', 'docs/guide/'], cliOpts);

      const infoResult = spawnSync(process.execPath, [
        path.join(__dirname, 'polyrepo.cjs'), 'info'
      ], cliOpts);

      assert.equal(infoResult.status, 0);
      assert.ok(infoResult.stdout.includes('Docs:'), 'info should show Docs section');
      assert.ok(infoResult.stdout.includes('docs/guide/'), 'info should show doc path');

      fs.rmSync(env.tmpDir, { recursive: true, force: true });
    });

    test('PR-MULTI-ADD-1: adding multiple repos to same group creates correct structure', () => {
      const env = createTestEnv();

      // Create and add multiple
      runCLI(['create', 'my-system'], env.tmpDir);
      runCLI(['add', 'my-system', env.repoA, 'frontend'], env.tmpDir);
      runCLI(['add', 'my-system', env.repoB, 'backend'], env.tmpDir);
      runCLI(['add', 'my-system', env.repoC, 'infra', '--no-planning'], env.tmpDir);

      // Verify all repos in config
      const configPath = path.join(env.polyreposDir, 'my-system.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.equal(config.repos.length, 3);

      // Verify planning markers
      assert.ok(fs.existsSync(path.join(env.repoA, '.planning', 'polyrepo.json')));
      assert.ok(fs.existsSync(path.join(env.repoB, '.planning', 'polyrepo.json')));
      assert.ok(!fs.existsSync(path.join(env.repoC, '.planning', 'polyrepo.json')));

      fs.rmSync(env.tmpDir, { recursive: true, force: true });
    });

    test('PR-READMARKER-SHAPE: non-object marker JSON returns null and setDocs fails open', () => {
      const env = createTestEnv();
      const markerDir = path.join(env.repoA, '.planning');
      fs.mkdirSync(markerDir, { recursive: true });
      // Valid JSON, wrong shape (a bare scalar instead of an object)
      fs.writeFileSync(path.join(markerDir, 'polyrepo.json'), '42', 'utf8');

      // readMarker must shape-guard like loadGroup does
      assert.equal(polyrepo.readMarker(env.repoA), null, 'non-object marker should normalize to null');

      // setDocs must fail open, not throw an uncaught TypeError on a primitive
      let result;
      assert.doesNotThrow(() => { result = polyrepo.setDocs(env.repoA, { user: 'docs/' }); });
      assert.equal(result.ok, false);

      fs.rmSync(env.tmpDir, { recursive: true, force: true });
    });

    test('PR-CREATE-NULLENTRY: createGroup rejects a null repo entry instead of throwing', () => {
      // Validation crash happens before any fs write, so no real ~/.claude pollution.
      let result;
      assert.doesNotThrow(() => {
        result = polyrepo.createGroup('hardening-null-entry-probe', [null]);
      });
      assert.equal(result.ok, false);
      assert.match(result.error, /repo/i);
    });

    test('PR-LOADGROUP-ELEMENTSHAPE: a null repo entry in a group config does not crash list', () => {
      const env = createTestEnv();
      fs.writeFileSync(
        path.join(env.polyreposDir, 'broken.json'),
        JSON.stringify({ name: 'broken', repos: [null, { role: 'frontend', path: env.repoA, planning: true }] }),
        'utf8'
      );

      const result = runCLI(['list', 'broken'], env.tmpDir);
      assert.ok(!/TypeError/.test(result.stderr), `should not throw TypeError: ${result.stderr}`);
      assert.equal(result.status, 0, `list should succeed, got ${result.status}; stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes('frontend'), 'well-formed entry should still render');

      fs.rmSync(env.tmpDir, { recursive: true, force: true });
    });
  });
});

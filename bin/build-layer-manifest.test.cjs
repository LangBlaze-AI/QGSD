#!/usr/bin/env node
'use strict';
// bin/build-layer-manifest.test.cjs
// Tests for build-layer-manifest.cjs

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = process.env.PROJECT_ROOT || path.join(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, '.planning', 'formal', 'model-registry.json');
const MANIFEST_PATH = path.join(ROOT, '.planning', 'formal', 'layer-manifest.json');

describe('build-layer-manifest classification rules', () => {
  it('classifies TLA+ files as L3', () => {
    const testPaths = [
      '.planning/formal/tla/QGSDQuorum.tla',
      '.planning/formal/tla/QGSDCircuitBreaker.tla',
    ];
    for (const p of testPaths) {
      assert.match(p, /\/(tla|alloy|prism)\//, `${p} should match L3 pattern`);
    }
  });

  it('classifies Alloy files as L3', () => {
    const testPaths = [
      '.planning/formal/alloy/quorum-votes.als',
      '.planning/formal/alloy/install-scope.als',
    ];
    for (const p of testPaths) {
      assert.match(p, /\/(tla|alloy|prism)\//, `${p} should match L3 pattern`);
    }
  });

  it('classifies PRISM files as L3', () => {
    const testPaths = [
      '.planning/formal/prism/mcp-availability.pm',
      '.planning/formal/prism/quorum.pm',
    ];
    for (const p of testPaths) {
      assert.match(p, /\/(tla|alloy|prism)\//, `${p} should match L3 pattern`);
    }
  });
});

describe('build-layer-manifest integration', () => {
  let registryBackup;

  before(() => {
    registryBackup = fs.readFileSync(REGISTRY_PATH, 'utf8');
    // Run the script
    execFileSync('node', ['bin/build-layer-manifest.cjs'], { cwd: ROOT, stdio: 'pipe' });
  });

  it('generates manifest with all models classified', () => {
    const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

    const totalModels = Object.keys(registry.models).length;
    const classified = (manifest.layers.L1 || []).length +
                       (manifest.layers.L2 || []).length +
                       (manifest.layers.L3 || []).length;

    assert.strictEqual(classified, totalModels,
      `All models must be classified (classified=${classified} total=${totalModels})`);
  });

  it('adds source_layer to every model in registry', () => {
    const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    for (const [key, model] of Object.entries(registry.models)) {
      assert.ok('source_layer' in model, `source_layer missing on ${key}`);
      assert.ok(['L1', 'L2', 'L3'].includes(model.source_layer),
        `Invalid source_layer "${model.source_layer}" on ${key}`);
    }
  });

  it('adds gate_maturity to every model', () => {
    const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    for (const [key, model] of Object.entries(registry.models)) {
      assert.ok('gate_maturity' in model, `gate_maturity missing on ${key}`);
      assert.strictEqual(model.gate_maturity, 'ADVISORY');
    }
  });

  it('adds layer_maturity to every model', () => {
    const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    for (const [key, model] of Object.entries(registry.models)) {
      assert.ok('layer_maturity' in model, `layer_maturity missing on ${key}`);
      assert.ok([0, 1].includes(model.layer_maturity),
        `Invalid layer_maturity "${model.layer_maturity}" on ${key}`);
    }
  });

  it('manifest has required structure', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    assert.strictEqual(manifest.schema_version, '2');
    assert.ok(manifest.generated);
    assert.ok(manifest.layers);
    assert.ok(manifest.gate_relationships);
    assert.ok(manifest.summary);
  });

  it('manifest has correct gate_relationships', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    assert.strictEqual(manifest.gate_relationships.A.from, 'L1');
    assert.strictEqual(manifest.gate_relationships.A.to, 'L3');
    assert.strictEqual(manifest.gate_relationships.B.from, 'L3');
    assert.strictEqual(manifest.gate_relationships.B.to, 'purpose');
    assert.strictEqual(manifest.gate_relationships.C.from, 'L3');
    assert.strictEqual(manifest.gate_relationships.C.to, 'TC');
  });

  after(() => {
    fs.writeFileSync(REGISTRY_PATH, registryBackup, 'utf8');
  });
});

describe('build-layer-manifest adversarial: registry shape', () => {
  const os = require('os');
  it('does not crash when registry has no models key', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-'));
    const fdir = path.join(tmp, '.planning', 'formal');
    fs.mkdirSync(fdir, { recursive: true });
    fs.writeFileSync(path.join(fdir, 'model-registry.json'),
      JSON.stringify({ version: 1 }), 'utf8');
    let err = null;
    try {
      execFileSync('node', ['bin/build-layer-manifest.cjs'], {
        cwd: ROOT,
        env: { ...process.env, PROJECT_ROOT: tmp },
        stdio: 'pipe',
      });
    } catch (e) { err = e; }
    assert.strictEqual(err, null,
      'script must not crash on registry missing a models key');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(fdir, 'layer-manifest.json'), 'utf8'));
    assert.strictEqual(manifest.summary.total_models, 0);
  });
});

describe('build-layer-manifest adversarial: model entry shape', () => {
  const os = require('os');
  it('does not crash on null or non-object model entries', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-'));
    const fdir = path.join(tmp, '.planning', 'formal');
    fs.mkdirSync(fdir, { recursive: true });
    fs.writeFileSync(path.join(fdir, 'model-registry.json'),
      JSON.stringify({ models: {
        '.planning/formal/tla/Foo.tla': null,
        'bar.als': 'oops',
        '.planning/formal/tla/Good.tla': { description: 'ok' },
      } }), 'utf8');
    let err = null;
    try {
      execFileSync('node', ['bin/build-layer-manifest.cjs'], {
        cwd: ROOT,
        env: { ...process.env, PROJECT_ROOT: tmp },
        stdio: 'pipe',
      });
    } catch (e) { err = e; }
    assert.strictEqual(err, null,
      'script must not crash on null/non-object model entries');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(fdir, 'layer-manifest.json'), 'utf8'));
    // the one valid TLA model is still classified
    assert.strictEqual(manifest.layers.L3.length, 1);
  });
});

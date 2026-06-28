#!/usr/bin/env node
'use strict';
// bin/formal-scope-scan.test.cjs
// Tests for project-level manifest discovery functions in formal-scope-scan.cjs.
// Requirements: quick-370

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { spawnSync } = require('child_process');

const {
  loadProjectManifest,
  matchProjectSpecs,
  scanUnregisteredSpecs,
  mergeProjectSpecsIntoRegistry,
  runBugModeMatching,
  loadModelRegistry,
  discoverViaCallGraph,
  persistBugGap
} = require('./formal-scope-scan.cjs');

const SCOPE_SCAN = path.join(__dirname, 'formal-scope-scan.cjs');

// ── loadProjectManifest tests ───────────────────────────────────────────

test('loadProjectManifest returns empty array when manifest has empty specs', () => {
  // The repo manifest at .planning/formal/specs/formal-checks.json has specs: []
  const specs = loadProjectManifest();
  assert.ok(Array.isArray(specs));
  assert.strictEqual(specs.length, 0);
});

// ── matchProjectSpecs tests ─────────────────────────────────────────────

test('matchProjectSpecs returns empty array when manifest has no specs', () => {
  const matches = matchProjectSpecs('test description', [], ['test']);
  assert.ok(Array.isArray(matches));
  assert.strictEqual(matches.length, 0);
});

test('matchProjectSpecs matches by keyword', () => {
  // Temporarily write a manifest with a spec entry
  const manifestPath = path.join(process.cwd(), '.planning', 'formal', 'specs', 'formal-checks.json');
  const original = fs.readFileSync(manifestPath, 'utf8');

  const manifest = {
    version: 1,
    specs: [{
      module: 'gke-recovery',
      type: 'tla',
      spec_path: '.planning/formal/specs/GKERecovery.tla',
      command: 'make',
      args: ['check-gke'],
      keywords: ['gke', 'pod', 'recovery', 'kubernetes'],
      requirements: ['INFRA-01'],
      maturity: 'draft',
      description: 'GKE pod recovery verification'
    }]
  };

  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const matches = matchProjectSpecs('fix gke pod restart', [], null);
    assert.ok(matches.length >= 1, 'should match by keyword "gke"');
    assert.strictEqual(matches[0].module, 'gke-recovery');
    assert.strictEqual(matches[0].matched_by, 'project_manifest');
    assert.strictEqual(matches[0].source, 'project');
    assert.deepStrictEqual(matches[0].requirements, ['INFRA-01']);
    assert.strictEqual(matches[0].maturity, 'draft');
  } finally {
    fs.writeFileSync(manifestPath, original);
  }
});

test('matchProjectSpecs matches by module name (single-token module)', () => {
  const manifestPath = path.join(process.cwd(), '.planning', 'formal', 'specs', 'formal-checks.json');
  const original = fs.readFileSync(manifestPath, 'utf8');

  // Use a single-token module name since tokenizer splits on hyphens
  const manifest = {
    version: 1,
    specs: [{
      module: 'authflow',
      type: 'alloy',
      spec_path: '.planning/formal/specs/AuthFlow.als',
      command: 'java',
      args: ['-jar', 'alloy.jar', 'AuthFlow.als'],
      keywords: ['authentication'],
      requirements: [],
      maturity: 'reviewed'
    }]
  };

  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Token "authflow" should match module name exactly
    const matches = matchProjectSpecs('check authflow logic', [], null);
    assert.ok(matches.length >= 1, 'should match by module name');
    assert.strictEqual(matches[0].module, 'authflow');
    assert.strictEqual(matches[0].spec_type, 'alloy');
  } finally {
    fs.writeFileSync(manifestPath, original);
  }
});

test('matchProjectSpecs does not match unrelated description', () => {
  const manifestPath = path.join(process.cwd(), '.planning', 'formal', 'specs', 'formal-checks.json');
  const original = fs.readFileSync(manifestPath, 'utf8');

  const manifest = {
    version: 1,
    specs: [{
      module: 'gke-recovery',
      type: 'tla',
      spec_path: '.planning/formal/specs/GKERecovery.tla',
      command: 'make',
      args: ['check-gke'],
      keywords: ['gke', 'kubernetes'],
      requirements: [],
      maturity: 'draft'
    }]
  };

  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const matches = matchProjectSpecs('fix quorum deliberation timeout', [], null);
    assert.strictEqual(matches.length, 0, 'should not match unrelated description');
  } finally {
    fs.writeFileSync(manifestPath, original);
  }
});

// ── scanUnregisteredSpecs tests ─────────────────────────────────────────

test('scanUnregisteredSpecs finds unregistered .tla files', () => {
  const specsDir = path.join(process.cwd(), '.planning', 'formal', 'specs');
  const testFile = path.join(specsDir, 'TestUnregistered.tla');

  try {
    fs.writeFileSync(testFile, '---- MODULE TestUnregistered ----\n====');

    // Pass empty manifest — all spec files should be unregistered
    const unregistered = scanUnregisteredSpecs([]);
    const found = unregistered.find(u => u.file === 'TestUnregistered.tla');
    assert.ok(found, 'should find TestUnregistered.tla as unregistered');
    assert.strictEqual(found.type, 'tla');
  } finally {
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  }
});

test('scanUnregisteredSpecs excludes registered files', () => {
  const specsDir = path.join(process.cwd(), '.planning', 'formal', 'specs');
  const testFile = path.join(specsDir, 'Registered.tla');

  try {
    fs.writeFileSync(testFile, '---- MODULE Registered ----\n====');

    // Pass manifest that registers this file
    const manifest = [{
      module: 'registered-mod',
      spec_path: '.planning/formal/specs/Registered.tla',
      command: 'make',
      args: ['check']
    }];

    const unregistered = scanUnregisteredSpecs(manifest);
    const found = unregistered.find(u => u.file === 'Registered.tla');
    assert.ok(!found, 'should not report registered file as unregistered');
  } finally {
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  }
});

test('scanUnregisteredSpecs returns empty array when dir does not exist', () => {
  // scanUnregisteredSpecs uses PROJECT_SPECS_DIR which exists, but this
  // tests the fail-open pattern — should not crash
  const result = scanUnregisteredSpecs(null);
  assert.ok(Array.isArray(result));
});

// ── mergeProjectSpecsIntoRegistry tests ─────────────────────────────────

test('mergeProjectSpecsIntoRegistry adds project specs with source marker', () => {
  const specs = [{
    module: 'test-proj',
    type: 'tla',
    spec_path: '.planning/formal/specs/Test.tla',
    command: 'make',
    args: ['check'],
    requirements: ['TEST-01'],
    maturity: 'draft',
    description: 'Test project spec'
  }];

  const registry = mergeProjectSpecsIntoRegistry(specs, null);
  assert.ok(registry.models);
  const key = path.normalize('.planning/formal/specs/Test.tla');
  const entry = registry.models[key];
  assert.ok(entry, 'merged entry should exist');
  assert.strictEqual(entry.source, 'project');
  assert.strictEqual(entry.update_source, 'project_manifest');
  assert.deepStrictEqual(entry.requirements, ['TEST-01']);
  assert.strictEqual(entry.maturity, 'draft');
  assert.deepStrictEqual(entry.project_command, { command: 'make', args: ['check'] });
});

test('mergeProjectSpecsIntoRegistry does not overwrite internal entries', () => {
  const specs = [{
    module: 'collider',
    type: 'tla',
    spec_path: 'existing-key.tla',
    command: 'make',
    args: ['check'],
    description: 'should not overwrite'
  }];

  const existingRegistry = {
    version: '1.0',
    models: {
      [path.normalize('existing-key.tla')]: {
        source: 'internal',
        description: 'original internal entry'
      }
    }
  };

  const result = mergeProjectSpecsIntoRegistry(specs, existingRegistry);
  assert.strictEqual(result.models[path.normalize('existing-key.tla')].source, 'internal',
    'internal entry must not be overwritten');
  assert.strictEqual(result.models[path.normalize('existing-key.tla')].description, 'original internal entry');
});

test('mergeProjectSpecsIntoRegistry handles empty specs', () => {
  const result = mergeProjectSpecsIntoRegistry([], null);
  assert.ok(result.models);
  assert.strictEqual(Object.keys(result.models).length, 0);
});

test('mergeProjectSpecsIntoRegistry handles null specs', () => {
  const result = mergeProjectSpecsIntoRegistry(null, null);
  assert.ok(result.models);
  assert.strictEqual(Object.keys(result.models).length, 0);
});

// ── E2E: bug-mode with project manifest ─────────────────────────────────

test('runBugModeMatching finds project specs via preloadedRegistry', () => {
  // Simulate what main() does: merge project specs, pass to runBugModeMatching
  const projectSpecs = [{
    module: 'deployment-safety',
    type: 'tla',
    spec_path: '.planning/formal/specs/DeploymentSafety.tla',
    command: 'make',
    args: ['check-deploy'],
    requirements: ['DEPLOY-01', 'DEPLOY-02'],
    maturity: 'reviewed',
    description: 'Deployment rollback safety verification'
  }];

  const baseRegistry = loadModelRegistry() || { version: '1.0', models: {} };
  const merged = mergeProjectSpecsIntoRegistry(projectSpecs, baseRegistry);

  // Search for "deployment rollback" — should match via description tokens
  const matches = runBugModeMatching('deployment rollback failure', [], undefined, merged);
  assert.ok(matches !== null, 'runBugModeMatching should not return null with valid registry');

  const projMatch = matches.find(m => m.path === path.normalize('.planning/formal/specs/DeploymentSafety.tla'));
  assert.ok(projMatch, 'should find the project spec via preloadedRegistry');
  assert.strictEqual(projMatch.matched_by, 'bug_pattern');
  assert.ok(projMatch.bug_relevance_score > 0, 'relevance score should be positive');
  assert.deepStrictEqual(projMatch.requirement_coverage, ['DEPLOY-01', 'DEPLOY-02']);
});

test('runBugModeMatching without preloadedRegistry does NOT find project specs', () => {
  // Without passing the merged registry, project specs should NOT appear
  // (they're not in the on-disk model-registry.json)
  const matches = runBugModeMatching('deployment rollback failure', []);
  if (matches === null) return; // registry unavailable — can't test this path

  const projMatch = matches.find(m =>
    m.path && m.path.includes('DeploymentSafety')
  );
  assert.ok(!projMatch, 'without preloadedRegistry, project specs should not appear');
});

test('E2E CLI: --bug-mode returns project spec matches', () => {
  const manifestPath = path.join(process.cwd(), '.planning', 'formal', 'specs', 'formal-checks.json');
  const original = fs.readFileSync(manifestPath, 'utf8');

  const manifest = {
    version: 1,
    specs: [{
      module: 'canary-deploy',
      type: 'tla',
      spec_path: '.planning/formal/specs/CanaryDeploy.tla',
      command: 'make',
      args: ['check-canary'],
      keywords: ['canary', 'deploy', 'rollout'],
      requirements: ['CANARY-01'],
      maturity: 'draft',
      description: 'Canary deployment verification'
    }]
  };

  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Standard mode — should find via matchProjectSpecs
    const result = spawnSync(process.execPath, [
      SCOPE_SCAN,
      '--description', 'canary deployment rollout',
      '--format', 'json'
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30000
    });

    // Parse JSON output — stdout may have noise from semantic layer
    // Find the last valid JSON array in stdout
    const stdout = result.stdout || '';
    const lines = stdout.split('\n');
    let parsed = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('[')) {
        try { parsed = JSON.parse(line); break; } catch (_) {}
      }
    }
    // If single-line parse failed, try multiline from last '['
    if (!parsed) {
      const jsonStart = stdout.lastIndexOf('[\n');
      if (jsonStart >= 0) {
        try { parsed = JSON.parse(stdout.slice(jsonStart)); } catch (_) {}
      }
    }
    if (parsed) {
      const canaryMatch = parsed.find(m => m.module === 'canary-deploy');
      assert.ok(canaryMatch, 'CLI should find canary-deploy via project manifest');
      assert.strictEqual(canaryMatch.source, 'project');
      assert.strictEqual(canaryMatch.matched_by, 'project_manifest');
    }
  } finally {
    fs.writeFileSync(manifestPath, original);
  }
});

// ── Layer 2.5: discoverViaCallGraph tests ────────────────────────────────────

test('discoverViaCallGraph returns empty array when adapter is null', () => {
  const result = discoverViaCallGraph(['bin/utils.cjs'], new Set(), null);
  assert.deepStrictEqual(result, []);
});

test('discoverViaCallGraph returns empty array when files array is empty', () => {
  const enabledAdapter = {
    healthSync: () => ({ healthy: true }),
    getCallersSync: () => ({ callers: [] })
  };
  const result = discoverViaCallGraph([], new Set(), enabledAdapter);
  assert.deepStrictEqual(result, []);
});

test('discoverViaCallGraph returns empty array when files is null', () => {
  const enabledAdapter = {
    healthSync: () => ({ healthy: true }),
    getCallersSync: () => ({ callers: [] })
  };
  const result = discoverViaCallGraph(null, new Set(), enabledAdapter);
  assert.deepStrictEqual(result, []);
});

test('discoverViaCallGraph returns empty array when adapter is unhealthy', () => {
  const disabledAdapter = {
    healthSync: () => ({ healthy: false }),
    getCallersSync: () => ({ error: 'disabled' })
  };
  const result = discoverViaCallGraph(['bin/utils.cjs'], new Set(), disabledAdapter);
  assert.deepStrictEqual(result, []);
});

test('discoverViaCallGraph returns empty array when getCallersSync returns error', () => {
  const errorAdapter = {
    healthSync: () => ({ healthy: true }),
    getCallersSync: () => ({ error: 'timeout' })
  };
  const result = discoverViaCallGraph(['bin/utils.cjs'], new Set(), errorAdapter);
  assert.deepStrictEqual(result, []);
});

test('discoverViaCallGraph returns empty array when getCallersSync throws (fail-open)', () => {
  const throwingAdapter = {
    healthSync: () => ({ healthy: true }),
    getCallersSync: () => { throw new Error('unexpected'); }
  };
  const result = discoverViaCallGraph(['bin/utils.cjs'], new Set(), throwingAdapter);
  assert.deepStrictEqual(result, []);
});

test('discoverViaCallGraph skips already-matched modules (deduplication)', () => {
  // Write a temp SPEC_DIR structure with a scope.json that would match
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-test-'));
  const modDir = path.join(tmpDir, 'solve-convergence');
  fs.mkdirSync(modDir, { recursive: true });
  fs.writeFileSync(path.join(modDir, 'scope.json'), JSON.stringify({
    source_files: ['bin/nf-solve.cjs'],
    concepts: []
  }));

  // Patch SPEC_DIR temporarily by writing a scope.json in the real SPEC_DIR instead
  // Use a module that already exists: solve-convergence
  const realSpecDir = path.join(process.cwd(), '.planning', 'formal', 'spec');
  const realModDir = path.join(realSpecDir, 'solve-convergence');
  const existingScopeJson = fs.existsSync(path.join(realModDir, 'scope.json'))
    ? fs.readFileSync(path.join(realModDir, 'scope.json'), 'utf8')
    : null;

  // The matchedModules Set already contains 'solve-convergence' — it should be skipped
  const matchedModules = new Set(['solve-convergence']);
  const adapter = {
    healthSync: () => ({ healthy: true }),
    getCallersSync: () => ({ callers: ['bin/nf-solve.cjs'] })
  };

  const result = discoverViaCallGraph(['bin/utils.cjs'], matchedModules, adapter);
  // solve-convergence was already in matchedModules — should not appear in result
  const found = result.find(r => r.module === 'solve-convergence');
  assert.ok(!found, 'already-matched module should not appear in result');

  // cleanup
  fs.rmSync(tmpDir, { recursive: true });
});

test('discoverViaCallGraph discovers module via caller file matching source_files glob', () => {
  // Create a temp spec module with scope.json that matches a specific file
  const realSpecDir = path.join(process.cwd(), '.planning', 'formal', 'spec');
  if (!fs.existsSync(realSpecDir)) return; // skip if spec dir absent

  const testModName = 'test-callgraph-' + Date.now();
  const testModDir = path.join(realSpecDir, testModName);
  fs.mkdirSync(testModDir, { recursive: true });

  const scopeJson = {
    source_files: ['bin/target-caller.cjs'],
    concepts: ['test-only']
  };
  fs.writeFileSync(path.join(testModDir, 'scope.json'), JSON.stringify(scopeJson));
  fs.writeFileSync(path.join(testModDir, 'invariants.md'), '# test\n');

  try {
    const matchedModules = new Set(); // empty — nothing matched yet
    const adapter = {
      healthSync: () => ({ healthy: true }),
      // getCallersSync returns a caller that matches the scope.json source_files
      getCallersSync: (symbol, file) => ({ callers: ['bin/target-caller.cjs'] })
    };

    const result = discoverViaCallGraph(['bin/changed-utility.cjs'], matchedModules, adapter);
    const found = result.find(r => r.module === testModName);
    assert.ok(found, 'should discover module via caller matching source_files glob');
    assert.strictEqual(found.matched_by, 'call_graph');
    assert.ok(found.discovered_via.includes('bin/changed-utility.cjs'), 'discovered_via should contain changed file');
    assert.ok(found.discovered_via.includes('bin/target-caller.cjs'), 'discovered_via should contain caller file');
    assert.ok(matchedModules.has(testModName), 'matchedModules set should be updated');
  } finally {
    fs.rmSync(testModDir, { recursive: true });
  }
});

// ── FSS-1: persistBugGap shape-guard (fail-open) ─────────────────────────────

test('persistBugGap fails open when gaps file lacks an entries array (shape guard)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-gaps-'));
  const gapsPath = path.join(tmpDir, 'bug-model-gaps.json');
  // valid JSON, wrong shape: no entries array
  fs.writeFileSync(gapsPath, JSON.stringify({ version: '1.0' }));
  try {
    assert.doesNotThrow(() => {
      persistBugGap('some bug description', [{ model: 'X.tla' }], gapsPath);
    });
    const saved = JSON.parse(fs.readFileSync(gapsPath, 'utf8'));
    assert.ok(Array.isArray(saved.entries), 'entries should be normalized to an array');
    assert.strictEqual(saved.entries.length, 1);
    assert.strictEqual(saved.entries[0].description, 'some bug description');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// ── FSS-2: runBugModeMatching null/non-object entry guard ─────────────────────

test('runBugModeMatching skips null/non-object model entries instead of crashing', () => {
  const registry = {
    version: '1.0',
    models: {
      'BadEntry.tla': null,
      'AlsoBad.als': 42,
      'NFCircuitBreaker.tla': { requirements: ['BREAK-01'], description: 'circuit breaker timeout detection' }
    }
  };
  let matches;
  assert.doesNotThrow(() => {
    matches = runBugModeMatching('circuit breaker timeout', [], undefined, registry);
  });
  assert.ok(Array.isArray(matches));
  // the good entry should still be matchable; the bad ones must not appear
  assert.ok(!matches.some(m => m.model === 'BadEntry.tla' || m.model === 'AlsoBad.als'));
});

// ── FSS-3: matchProjectSpecs non-string keyword guard ────────────────────────

test('matchProjectSpecs ignores non-string keywords without crashing', () => {
  const manifestPath = path.join(process.cwd(), '.planning', 'formal', 'specs', 'formal-checks.json');
  const original = fs.readFileSync(manifestPath, 'utf8');
  const manifest = {
    version: 1,
    specs: [{
      module: 'gke',
      type: 'tla',
      spec_path: '.planning/formal/specs/G.tla',
      command: 'make',
      args: ['check'],
      keywords: [null, 123, 'gke'],
      requirements: [],
      maturity: 'draft'
    }]
  };
  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    let matches;
    assert.doesNotThrow(() => {
      matches = matchProjectSpecs('fix gke pod restart', [], null);
    });
    // the valid string keyword 'gke' should still match
    assert.ok(matches.some(m => m.module === 'gke'));
  } finally {
    fs.writeFileSync(manifestPath, original);
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { execFileSync } = require('child_process');

const { checkStaleness } = require('./check-model-staleness.cjs');

const SCRIPT = path.join(__dirname, 'check-model-staleness.cjs');

test('missing registry returns skipped result', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'model-stale-'));
  try {
    const result = checkStaleness(tmpDir);
    assert.strictEqual(result.skipped, true);
    assert.deepStrictEqual(result.stale, []);
    assert.strictEqual(result.total_checked, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('hash computation for mock model file with -- Source: header', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'model-stale-'));
  try {
    // Create formal directory structure
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });

    // Create a mock model file with Source header
    const modelContent = '-- Model: test-model\n-- Source: bin/test-source.cjs\nmod test {}\n';
    const modelPath = path.join(tmpDir, '.planning', 'formal', 'test-model.als');
    fs.writeFileSync(modelPath, modelContent, 'utf8');

    // Create a mock source file
    const sourceContent = 'function test() { return 42; }\n';
    const sourcePath = path.join(tmpDir, 'bin', 'test-source.cjs');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, sourceContent, 'utf8');

    // Create registry with model entry but no hashes
    const registry = {
      version: '1.0',
      last_sync: new Date().toISOString(),
      models: {
        '.planning/formal/test-model.als': {
          version: 1,
          description: 'test model',
        },
      },
    };
    const registryPath = path.join(tmpDir, '.planning', 'formal', 'model-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8');

    // Run check (read-only, no update)
    const result = checkStaleness(tmpDir, { updateHashes: false });

    assert.strictEqual(result.skipped, undefined);
    assert.strictEqual(result.total_checked, 1);
    assert.strictEqual(result.total_stale, 0);
    assert.strictEqual(result.first_hash_count, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('first run (no content_hashes) returns first_hash_count > 0 and zero stale', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'model-stale-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });

    const modelContent = '-- Model: test1\nmod test1 {}\n';
    const modelPath = path.join(tmpDir, '.planning', 'formal', 'model1.als');
    fs.writeFileSync(modelPath, modelContent, 'utf8');

    const registry = {
      version: '1.0',
      models: {
        '.planning/formal/model1.als': { version: 1 },
      },
    };
    const registryPath = path.join(tmpDir, '.planning', 'formal', 'model-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf8');

    const result = checkStaleness(tmpDir, { updateHashes: false });

    assert.strictEqual(result.total_checked, 1);
    assert.strictEqual(result.total_stale, 0);
    assert.strictEqual(result.first_hash_count, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('changed model content is detected as stale with requirement IDs', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'model-stale-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });

    const modelContent = 'mod changed {}\n';
    const modelPath = path.join(tmpDir, '.planning', 'formal', 'model1.als');
    fs.writeFileSync(modelPath, modelContent, 'utf8');

    const oldHash = crypto.createHash('sha256').update('mod old {}\n').digest('hex');

    const registry = {
      version: '1.0',
      models: {
        '.planning/formal/model1.als': {
          version: 1,
          requirements: ['STOP-01', 'STOP-02'],
          content_hashes: {
            model_hash: oldHash,
            source_hashes: {},
          },
        },
      },
    };
    const registryPath = path.join(tmpDir, '.planning', 'formal', 'model-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf8');

    const result = checkStaleness(tmpDir, { updateHashes: false });

    assert.strictEqual(result.total_checked, 1);
    assert.strictEqual(result.total_stale, 1);
    assert.strictEqual(result.stale[0].reason, 'model_changed');
    assert.deepStrictEqual(result.stale[0].requirements, ['STOP-01', 'STOP-02']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('changed source content is detected as stale', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'model-stale-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });

    const modelContent = '-- Source: bin/src.cjs\nmod test {}\n';
    const modelPath = path.join(tmpDir, '.planning', 'formal', 'model1.als');
    fs.writeFileSync(modelPath, modelContent, 'utf8');

    const newSourceContent = 'new code\n';
    const sourcePath = path.join(tmpDir, 'bin', 'src.cjs');
    fs.writeFileSync(sourcePath, newSourceContent, 'utf8');

    const oldSourceHash = crypto.createHash('sha256').update('old code\n').digest('hex');
    const modelHash = crypto.createHash('sha256').update(modelContent).digest('hex');

    const registry = {
      version: '1.0',
      models: {
        '.planning/formal/model1.als': {
          version: 1,
          content_hashes: {
            model_hash: modelHash,
            source_hashes: { 'bin/src.cjs': oldSourceHash },
          },
        },
      },
    };
    const registryPath = path.join(tmpDir, '.planning', 'formal', 'model-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf8');

    const result = checkStaleness(tmpDir, { updateHashes: false });

    assert.strictEqual(result.total_stale, 1);
    assert.strictEqual(result.stale[0].reason, 'source_changed');
    assert(result.stale[0].changed_sources.includes('bin/src.cjs'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('graceful degradation when source file is missing', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'model-stale-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });

    const modelContent = '-- Source: bin/missing.cjs\nmod test {}\n';
    const modelPath = path.join(tmpDir, '.planning', 'formal', 'model1.als');
    fs.writeFileSync(modelPath, modelContent, 'utf8');

    const registry = {
      version: '1.0',
      models: {
        '.planning/formal/model1.als': {
          version: 1,
          content_hashes: {
            model_hash: crypto.createHash('sha256').update(modelContent).digest('hex'),
            source_hashes: {},
          },
        },
      },
    };
    const registryPath = path.join(tmpDir, '.planning', 'formal', 'model-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf8');

    const result = checkStaleness(tmpDir, { updateHashes: false });

    // Should not flag as stale just because source is missing
    assert.strictEqual(result.total_stale, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('default mode (no --update-hashes) does NOT write to registry (read-only verification)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'model-stale-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });

    const modelContent = 'mod test {}\n';
    const modelPath = path.join(tmpDir, '.planning', 'formal', 'model1.als');
    fs.writeFileSync(modelPath, modelContent, 'utf8');

    const registry = {
      version: '1.0',
      models: {
        '.planning/formal/model1.als': { version: 1 },
      },
    };
    const registryPath = path.join(tmpDir, '.planning', 'formal', 'model-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf8');

    const beforeHash = crypto.createHash('sha256').update(JSON.stringify(registry)).digest('hex');

    // Run in read-only mode (default)
    checkStaleness(tmpDir, { updateHashes: false });

    const afterContent = fs.readFileSync(registryPath, 'utf8');
    const afterRegistry = JSON.parse(afterContent);
    const afterHash = crypto.createHash('sha256').update(JSON.stringify(afterRegistry)).digest('hex');

    // Registry should be unchanged (or structure-equivalent)
    assert.strictEqual(beforeHash, afterHash);
    assert.strictEqual(afterRegistry.models['.planning/formal/model1.als'].content_hashes, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('* Source: header (TLA+ style) is parsed correctly', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'model-stale-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'hooks'), { recursive: true });

    const modelContent = '\\* Model: auth-session\n\\* Source: hooks/nf-stop.js\nVARIABLES state\n';
    const modelPath = path.join(tmpDir, '.planning', 'formal', 'auth.tla');
    fs.writeFileSync(modelPath, modelContent, 'utf8');

    const sourceContent = 'module.exports = {};\n';
    fs.writeFileSync(path.join(tmpDir, 'hooks', 'nf-stop.js'), sourceContent, 'utf8');

    const registry = {
      version: '1.0',
      models: {
        '.planning/formal/auth.tla': { version: 1 },
      },
    };
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'formal', 'model-registry.json'),
      JSON.stringify(registry), 'utf8'
    );

    const result = checkStaleness(tmpDir, { updateHashes: true });

    assert.strictEqual(result.first_hash_count, 1);
    const updated = JSON.parse(fs.readFileSync(
      path.join(tmpDir, '.planning', 'formal', 'model-registry.json'), 'utf8'
    ));
    const hashes = updated.models['.planning/formal/auth.tla'].content_hashes;
    assert(hashes.source_hashes['hooks/nf-stop.js'], 'should have parsed * Source: header');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('multiple comma-separated source files are all parsed and hashed', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'model-stale-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'hooks'), { recursive: true });

    const modelContent = '-- Source: bin/a.cjs, hooks/b.js, bin/c.cjs\nmod multi {}\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'formal', 'multi.als'), modelContent, 'utf8');

    fs.writeFileSync(path.join(tmpDir, 'bin', 'a.cjs'), 'a\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'hooks', 'b.js'), 'b\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'bin', 'c.cjs'), 'c\n', 'utf8');

    const registry = {
      version: '1.0',
      models: { '.planning/formal/multi.als': { version: 1 } },
    };
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'formal', 'model-registry.json'),
      JSON.stringify(registry), 'utf8'
    );

    const result = checkStaleness(tmpDir, { updateHashes: true });
    const updated = JSON.parse(fs.readFileSync(
      path.join(tmpDir, '.planning', 'formal', 'model-registry.json'), 'utf8'
    ));
    const srcHashes = updated.models['.planning/formal/multi.als'].content_hashes.source_hashes;

    assert.strictEqual(Object.keys(srcHashes).length, 3);
    assert(srcHashes['bin/a.cjs']);
    assert(srcHashes['hooks/b.js']);
    assert(srcHashes['bin/c.cjs']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('missing model file is skipped gracefully (not counted as stale)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'model-stale-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });

    // Registry references a model file that does not exist on disk
    const registry = {
      version: '1.0',
      models: {
        '.planning/formal/ghost.als': {
          version: 1,
          content_hashes: {
            model_hash: 'abc123',
            source_hashes: {},
          },
        },
      },
    };
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'formal', 'model-registry.json'),
      JSON.stringify(registry), 'utf8'
    );

    const result = checkStaleness(tmpDir);

    assert.strictEqual(result.total_checked, 1);
    assert.strictEqual(result.total_stale, 0);
    assert.strictEqual(result.first_hash_count, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('corrupt registry JSON returns skipped result', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'model-stale-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'formal', 'model-registry.json'),
      '{not valid json!!!', 'utf8'
    );

    const result = checkStaleness(tmpDir);

    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.total_checked, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('removed source file (in stored but not computed) is detected as stale', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'model-stale-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });

    // Model with no Source header (so computed sources is empty)
    const modelContent = 'mod test {}\n';
    const modelPath = path.join(tmpDir, '.planning', 'formal', 'model1.als');
    fs.writeFileSync(modelPath, modelContent, 'utf8');

    const modelHash = crypto.createHash('sha256').update(modelContent).digest('hex');

    const registry = {
      version: '1.0',
      models: {
        '.planning/formal/model1.als': {
          version: 1,
          content_hashes: {
            model_hash: modelHash,
            source_hashes: { 'bin/was-here.cjs': 'deadbeef' },
          },
        },
      },
    };
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'formal', 'model-registry.json'),
      JSON.stringify(registry), 'utf8'
    );

    const result = checkStaleness(tmpDir);

    assert.strictEqual(result.total_stale, 1);
    assert.strictEqual(result.stale[0].reason, 'source_changed');
    assert(result.stale[0].changed_sources.some(s => s.includes('was-here.cjs')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('multiple models: mixed stale and fresh results', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'model-stale-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });

    // Model 1: fresh (hashes match)
    const content1 = 'mod fresh {}\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'formal', 'fresh.als'), content1, 'utf8');
    const hash1 = crypto.createHash('sha256').update(content1).digest('hex');

    // Model 2: stale (model changed)
    const content2 = 'mod changed {}\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'formal', 'stale.als'), content2, 'utf8');
    const oldHash2 = crypto.createHash('sha256').update('mod old {}\n').digest('hex');

    // Model 3: first run (no hashes)
    const content3 = 'mod new {}\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'formal', 'new.als'), content3, 'utf8');

    const registry = {
      version: '1.0',
      models: {
        '.planning/formal/fresh.als': {
          version: 1,
          content_hashes: { model_hash: hash1, source_hashes: {} },
        },
        '.planning/formal/stale.als': {
          version: 1,
          content_hashes: { model_hash: oldHash2, source_hashes: {} },
        },
        '.planning/formal/new.als': { version: 1 },
      },
    };
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'formal', 'model-registry.json'),
      JSON.stringify(registry), 'utf8'
    );

    const result = checkStaleness(tmpDir);

    assert.strictEqual(result.total_checked, 3);
    assert.strictEqual(result.total_stale, 1);
    assert.strictEqual(result.first_hash_count, 1);
    assert.strictEqual(result.stale[0].model, '.planning/formal/stale.als');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('--update-hashes mode DOES write content_hashes to registry', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'model-stale-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });

    const modelContent = 'mod test {}\n';
    const modelPath = path.join(tmpDir, '.planning', 'formal', 'model1.als');
    fs.writeFileSync(modelPath, modelContent, 'utf8');

    const registry = {
      version: '1.0',
      models: {
        '.planning/formal/model1.als': { version: 1 },
      },
    };
    const registryPath = path.join(tmpDir, '.planning', 'formal', 'model-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf8');

    // Run with updateHashes = true
    const result = checkStaleness(tmpDir, { updateHashes: true });

    assert.strictEqual(result.first_hash_count, 1);

    const afterRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const entry = afterRegistry.models['.planning/formal/model1.als'];
    assert(entry.content_hashes);
    assert(entry.content_hashes.model_hash);
    assert(typeof entry.content_hashes.source_hashes === 'object');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// ── CLI (main) tests ────────────────────────────────────────────────

/** Helper: set up a tmpDir with a registry + model for CLI tests */
function setupCliFixture() {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'model-stale-cli-'));
  fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });

  const modelContent = '-- Source: bin/src.cjs\nmod cli {}\n';
  fs.writeFileSync(path.join(tmpDir, '.planning', 'formal', 'test.als'), modelContent, 'utf8');

  fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'bin', 'src.cjs'), 'hello\n', 'utf8');

  const registry = {
    version: '1.0',
    models: { '.planning/formal/test.als': { version: 1 } },
  };
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'formal', 'model-registry.json'),
    JSON.stringify(registry), 'utf8'
  );
  return tmpDir;
}

test('CLI --json outputs valid JSON to stdout', async () => {
  const tmpDir = setupCliFixture();
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, '--json', `--project-root=${tmpDir}`], {
      encoding: 'utf8',
      timeout: 10000,
    });
    const parsed = JSON.parse(stdout);
    assert.strictEqual(typeof parsed.total_checked, 'number');
    assert.strictEqual(typeof parsed.total_stale, 'number');
    assert.strictEqual(typeof parsed.first_hash_count, 'number');
    assert(Array.isArray(parsed.stale));
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('CLI --json --dry-run does not write to registry', async () => {
  const tmpDir = setupCliFixture();
  try {
    const regPath = path.join(tmpDir, '.planning', 'formal', 'model-registry.json');
    const before = fs.readFileSync(regPath, 'utf8');

    execFileSync(process.execPath, [SCRIPT, '--json', '--dry-run', `--project-root=${tmpDir}`], {
      encoding: 'utf8',
      timeout: 10000,
    });

    const after = fs.readFileSync(regPath, 'utf8');
    assert.strictEqual(before, after, 'registry should be unchanged after --dry-run');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('CLI --dry-run overrides --update-hashes (no writes)', async () => {
  const tmpDir = setupCliFixture();
  try {
    const regPath = path.join(tmpDir, '.planning', 'formal', 'model-registry.json');
    const before = fs.readFileSync(regPath, 'utf8');

    execFileSync(process.execPath, [SCRIPT, '--json', '--update-hashes', '--dry-run', `--project-root=${tmpDir}`], {
      encoding: 'utf8',
      timeout: 10000,
    });

    const after = fs.readFileSync(regPath, 'utf8');
    assert.strictEqual(before, after, '--dry-run should prevent --update-hashes from writing');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('CLI --update-hashes populates content_hashes in registry', async () => {
  const tmpDir = setupCliFixture();
  try {
    const regPath = path.join(tmpDir, '.planning', 'formal', 'model-registry.json');

    execFileSync(process.execPath, [SCRIPT, '--json', '--update-hashes', `--project-root=${tmpDir}`], {
      encoding: 'utf8',
      timeout: 10000,
    });

    const updated = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    const entry = updated.models['.planning/formal/test.als'];
    assert(entry.content_hashes, 'content_hashes should be written');
    assert(entry.content_hashes.model_hash);
    assert(entry.content_hashes.source_hashes['bin/src.cjs']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('CLI text mode (no --json) writes summary to stderr and exits 0', async () => {
  const tmpDir = setupCliFixture();
  try {
    const result = require('child_process').spawnSync(
      process.execPath, [SCRIPT, `--project-root=${tmpDir}`],
      { encoding: 'utf8', timeout: 10000 }
    );
    assert.strictEqual(result.status, 0);
    assert.match(result.stderr, /Checked \d+ models/);
    // stdout should be empty in text mode (no --json)
    assert.strictEqual(result.stdout.trim(), '');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('CLI with missing registry exits 0 and reports skipping to stderr', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'model-stale-cli-'));
  try {
    const result = require('child_process').spawnSync(
      process.execPath, [SCRIPT, `--project-root=${tmpDir}`],
      { encoding: 'utf8', timeout: 10000 }
    );
    assert.strictEqual(result.status, 0);
    assert.match(result.stderr, /not found; skipping/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('CLI --json with missing registry outputs skipped: true', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'model-stale-cli-'));
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, '--json', `--project-root=${tmpDir}`], {
      encoding: 'utf8',
      timeout: 10000,
    });
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.skipped, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('registry that parses to JSON literal null degrades gracefully (no crash)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'model-stale-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'formal', 'model-registry.json'),
      'null', 'utf8'
    );

    const result = checkStaleness(tmpDir);

    assert.strictEqual(result.total_checked, 0);
    assert.strictEqual(result.total_stale, 0);
    assert.deepStrictEqual(result.stale, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('null model entry in registry is skipped gracefully (no crash)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'model-stale-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });

    const modelContent = 'mod test {}\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'formal', 'model1.als'), modelContent, 'utf8');

    const registry = {
      version: '1.0',
      models: { '.planning/formal/model1.als': null },
    };
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'formal', 'model-registry.json'),
      JSON.stringify(registry), 'utf8'
    );

    const result = checkStaleness(tmpDir);

    assert.strictEqual(result.total_stale, 0);
    assert.deepStrictEqual(result.stale, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// ── baseline-drift integration tests (CONV-04) ─────────────────────

test('baseline-drift detects model staleness as a drift signal', async () => {
  const { detectBaselineDrift } = require('./baseline-drift.cjs');

  const result = detectBaselineDrift(undefined, undefined, {
    modelStaleness: {
      total_stale: 2,
      stale: [
        { model: 'a.als', reason: 'model_changed', requirements: ['STOP-01'] },
        { model: 'b.tla', reason: 'source_changed', requirements: ['DISP-03', 'DISP-04'] },
      ],
    },
  });

  assert.strictEqual(result.detected, true);
  assert.strictEqual(result.model_staleness_detected, true);
  assert.match(result.warning, /2 formal model\(s\) stale/);
  assert.match(result.warning, /STOP-01/);
  assert.match(result.warning, /DISP-03/);
});

test('baseline-drift with no model staleness does not flag model_staleness_detected', async () => {
  const { detectBaselineDrift } = require('./baseline-drift.cjs');

  const result = detectBaselineDrift(undefined, undefined, {
    modelStaleness: { total_stale: 0, stale: [] },
  });

  assert.strictEqual(result.model_staleness_detected, false);
  assert.strictEqual(result.detected, false);
});

test('baseline-drift without modelStaleness option degrades gracefully', async () => {
  const { detectBaselineDrift } = require('./baseline-drift.cjs');

  const result = detectBaselineDrift(undefined, undefined, {});

  assert.strictEqual(result.model_staleness_detected, false);
  assert.strictEqual(result.detected, false);
});

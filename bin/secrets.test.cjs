#!/usr/bin/env node
// Test suite for bin/secrets.cjs
// Uses Node.js built-in test runner: node --test bin/secrets.test.cjs
//
// Strategy:
//   - All tests use real temp directories with os.homedir patched so that
//     the module-level SECRETS_PATH constant resolves into a temp directory.
//   - No external dependencies (keytar removed — secrets are plaintext JSON).

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');

const SECRETS_PATH = path.join(__dirname, 'secrets.cjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = path.join(
    os.tmpdir(),
    'nf-secrets-' + Date.now() + '-' + Math.random().toString(36).slice(2)
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function clearSecretsCache() {
  delete require.cache[require.resolve(SECRETS_PATH)];
}

/**
 * Patch os.homedir to return tmpDir, clear the secrets module cache, require
 * a fresh copy of secrets.cjs (which captures the patched homedir for its
 * module-level SECRETS_PATH constant), then return the fresh module.
 */
function requireSecretsWithTmpHome(tmpDir) {
  clearSecretsCache();
  os.homedir = () => tmpDir;
  return require(SECRETS_PATH);
}

function restoreHomedir(real) {
  os.homedir = real;
}

/**
 * Write secrets JSON into <tmpDir>/.claude/nf-secrets.json.
 */
function writeSecrets(tmpDir, secrets) {
  const secretsPath = path.join(tmpDir, '.claude', 'nf-secrets.json');
  fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
  fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), 'utf8');
}

/**
 * Write a fake ~/.claude.json into tmpDir.
 */
function writeClaudeJson(tmpDir, content) {
  const filePath = path.join(tmpDir, '.claude.json');
  if (typeof content === 'string') {
    fs.writeFileSync(filePath, content, 'utf8');
  } else {
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
  }
}

// ─── SERVICE constant ─────────────────────────────────────────────────────────

test('SERVICE constant equals "nforma"', () => {
  clearSecretsCache();
  const { SERVICE } = require(SECRETS_PATH);
  assert.equal(SERVICE, 'nforma');
  clearSecretsCache();
});

// ─── Module export shape ──────────────────────────────────────────────────────

test('module exports the expected named exports', () => {
  clearSecretsCache();
  const mod = require(SECRETS_PATH);
  const expected = [
    'set', 'get', 'delete', 'list', 'hasKey', 'syncToClaudeJson', 'SERVICE',
    'patchClaudeJsonForKey', 'patchCcrConfigForKey', 'CCR_KEY_MAP',
  ];
  for (const name of expected) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(mod, name),
      `Expected export "${name}" to be present`
    );
  }
  assert.equal(typeof mod.set,                   'function', 'set should be a function');
  assert.equal(typeof mod.get,                   'function', 'get should be a function');
  assert.equal(typeof mod.delete,                'function', 'delete should be a function');
  assert.equal(typeof mod.list,                  'function', 'list should be a function');
  assert.equal(typeof mod.hasKey,                'function', 'hasKey should be a function');
  assert.equal(typeof mod.syncToClaudeJson,      'function', 'syncToClaudeJson should be a function');
  assert.equal(typeof mod.patchClaudeJsonForKey, 'function', 'patchClaudeJsonForKey should be a function');
  assert.equal(typeof mod.patchCcrConfigForKey,  'function', 'patchCcrConfigForKey should be a function');
  assert.equal(typeof mod.CCR_KEY_MAP,           'object',   'CCR_KEY_MAP should be an object');
  assert.equal(typeof mod.SERVICE,               'string',   'SERVICE should be a string');
  clearSecretsCache();
});

// ─── hasKey ───────────────────────────────────────────────────────────────────

test('hasKey: returns true when key exists in store', () => {
  const tmpDir = makeTmpDir();
  writeSecrets(tmpDir, { MY_API_KEY: 'val1', ANOTHER_KEY: 'val2' });

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    assert.equal(mod.hasKey('MY_API_KEY'),   true,  'MY_API_KEY should be found');
    assert.equal(mod.hasKey('ANOTHER_KEY'),  true,  'ANOTHER_KEY should be found');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }
});

test('hasKey: returns false for key not in store', () => {
  const tmpDir = makeTmpDir();
  writeSecrets(tmpDir, { SOME_OTHER_KEY: 'val' });

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    assert.equal(mod.hasKey('NONEXISTENT_KEY'), false);
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }
});

test('hasKey: returns false when secrets file does not exist', () => {
  const tmpDir = makeTmpDir();

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    assert.equal(mod.hasKey('ANY_KEY'), false);
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }
});

test('hasKey: returns false when secrets file contains invalid JSON', () => {
  const tmpDir = makeTmpDir();
  const secretsDir = path.join(tmpDir, '.claude');
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.writeFileSync(path.join(secretsDir, 'nf-secrets.json'), '{ not valid json }', 'utf8');

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    assert.equal(mod.hasKey('ANY_KEY'), false);
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }
});

test('hasKey: returns false when store is empty object', () => {
  const tmpDir = makeTmpDir();
  writeSecrets(tmpDir, {});

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    assert.equal(mod.hasKey('ANY_KEY'), false);
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }
});

test('hasKey: returns false for null values in store', () => {
  const tmpDir = makeTmpDir();
  writeSecrets(tmpDir, { NULL_KEY: null });

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    assert.equal(mod.hasKey('NULL_KEY'), false);
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }
});

// ─── set / get / delete / list ────────────────────────────────────────────────

test('set, get, delete round-trip works correctly', async () => {
  const tmpDir = makeTmpDir();

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    // Set a key
    await mod.set('nforma', 'TEST_KEY', 'test-value');
    assert.equal(mod.hasKey('TEST_KEY'), true, 'key should exist after set');

    // Get it back
    const val = await mod.get('nforma', 'TEST_KEY');
    assert.equal(val, 'test-value', 'get should return the stored value');

    // Delete it
    const deleted = await mod.delete('nforma', 'TEST_KEY');
    assert.equal(deleted, true, 'delete should return true for existing key');
    assert.equal(mod.hasKey('TEST_KEY'), false, 'key should not exist after delete');

    // Get after delete
    const gone = await mod.get('nforma', 'TEST_KEY');
    assert.equal(gone, null, 'get should return null after delete');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }
});

test('list returns all stored credentials', async () => {
  const tmpDir = makeTmpDir();
  writeSecrets(tmpDir, { KEY_A: 'val-a', KEY_B: 'val-b' });

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    const creds = await mod.list('nforma');
    assert.equal(creds.length, 2, 'should return 2 credentials');
    const map = Object.fromEntries(creds.map(c => [c.account, c.password]));
    assert.equal(map.KEY_A, 'val-a');
    assert.equal(map.KEY_B, 'val-b');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }
});

test('list filters out null values', async () => {
  const tmpDir = makeTmpDir();
  writeSecrets(tmpDir, { GOOD_KEY: 'val', NULL_KEY: null });

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    const creds = await mod.list('nforma');
    assert.equal(creds.length, 1, 'should return only non-null credentials');
    assert.equal(creds[0].account, 'GOOD_KEY');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }
});

test('set, get, delete, list all return Promises', async () => {
  const tmpDir = makeTmpDir();

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    const setResult    = mod.set('nforma', 'TEST_KEY', 'test-val');
    const getResult    = mod.get('nforma', 'TEST_KEY');
    const deleteResult = mod.delete('nforma', 'TEST_KEY');
    const listResult   = mod.list('nforma');

    assert.ok(typeof setResult.then    === 'function', 'set() should return a Promise');
    assert.ok(typeof getResult.then    === 'function', 'get() should return a Promise');
    assert.ok(typeof deleteResult.then === 'function', 'delete() should return a Promise');
    assert.ok(typeof listResult.then   === 'function', 'list() should return a Promise');

    await Promise.allSettled([setResult, getResult, deleteResult, listResult]);
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }
});

// ─── syncToClaudeJson ─────────────────────────────────────────────────────────

test('syncToClaudeJson: patches matching env keys across multiple servers', async () => {
  const tmpDir = makeTmpDir();

  writeSecrets(tmpDir, {
    OPENAI_API_KEY: 'sk-test-abc123',
    ANTHROPIC_KEY:  'sk-ant-xyz789',
  });

  writeClaudeJson(tmpDir, {
    mcpServers: {
      'my-server': {
        command: 'node',
        args: ['server.js'],
        env: {
          OPENAI_API_KEY: 'old-openai-value',
          UNRELATED_KEY:  'should-not-change',
        },
      },
      'another-server': {
        command: 'python',
        args: ['run.py'],
        env: {
          ANTHROPIC_KEY: 'old-anthropic-value',
        },
      },
    },
  });

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    await mod.syncToClaudeJson('nforma');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  const written = JSON.parse(
    fs.readFileSync(path.join(tmpDir, '.claude.json'), 'utf8')
  );
  assert.equal(
    written.mcpServers['my-server'].env.OPENAI_API_KEY,
    'sk-test-abc123',
    'OPENAI_API_KEY should be patched with the credential value'
  );
  assert.equal(
    written.mcpServers['my-server'].env.UNRELATED_KEY,
    'should-not-change',
    'UNRELATED_KEY should be left untouched'
  );
  assert.equal(
    written.mcpServers['another-server'].env.ANTHROPIC_KEY,
    'sk-ant-xyz789',
    'ANTHROPIC_KEY in another-server should be patched'
  );
});

test('syncToClaudeJson: does not write claude.json when secrets store is empty', async () => {
  const tmpDir = makeTmpDir();
  writeSecrets(tmpDir, {});

  writeClaudeJson(tmpDir, {
    mcpServers: { 'my-server': { env: { KEY: 'original' } } },
  });

  const claudeJsonPath = path.join(tmpDir, '.claude.json');
  const mtimeBefore = fs.statSync(claudeJsonPath).mtimeMs;

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    await mod.syncToClaudeJson('nforma');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  const mtimeAfter = fs.statSync(claudeJsonPath).mtimeMs;
  assert.equal(
    mtimeAfter,
    mtimeBefore,
    'claude.json should NOT be rewritten when secrets store is empty'
  );
});

test('syncToClaudeJson: does not write claude.json when no env key matches any credential', async () => {
  const tmpDir = makeTmpDir();
  writeSecrets(tmpDir, { UNRELATED_SECRET: 'val' });

  writeClaudeJson(tmpDir, {
    mcpServers: {
      'my-server': {
        env: { DIFFERENT_KEY: 'original-value' },
      },
    },
  });

  const claudeJsonPath = path.join(tmpDir, '.claude.json');
  const mtimeBefore = fs.statSync(claudeJsonPath).mtimeMs;

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    await mod.syncToClaudeJson('nforma');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  const mtimeAfter = fs.statSync(claudeJsonPath).mtimeMs;
  assert.equal(
    mtimeAfter,
    mtimeBefore,
    'claude.json should NOT be rewritten when no env keys match credentials'
  );
});

test('syncToClaudeJson: exits silently when claude.json does not exist', async () => {
  const tmpDir = makeTmpDir();
  writeSecrets(tmpDir, { SOME_KEY: 'some-value' });

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    await assert.doesNotReject(
      () => mod.syncToClaudeJson('nforma'),
      'syncToClaudeJson should not throw when claude.json is absent'
    );
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  assert.equal(
    fs.existsSync(path.join(tmpDir, '.claude.json')),
    false,
    'claude.json should not be created by syncToClaudeJson'
  );
});

test('syncToClaudeJson: exits silently when claude.json contains invalid JSON', async () => {
  const tmpDir = makeTmpDir();
  const corruptContent = '{ this is not : valid JSON !!!';
  writeClaudeJson(tmpDir, corruptContent);
  writeSecrets(tmpDir, { SOME_KEY: 'some-value' });

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    await assert.doesNotReject(
      () => mod.syncToClaudeJson('nforma'),
      'syncToClaudeJson should not throw on invalid JSON'
    );
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  const still = fs.readFileSync(path.join(tmpDir, '.claude.json'), 'utf8');
  assert.equal(still, corruptContent, 'corrupt file should not be overwritten');
});

test('syncToClaudeJson: exits silently when mcpServers is missing from claude.json', async () => {
  const tmpDir = makeTmpDir();
  writeClaudeJson(tmpDir, { someOtherConfig: { key: 'value' } });
  writeSecrets(tmpDir, { SOME_KEY: 'some-value' });

  const claudeJsonPath  = path.join(tmpDir, '.claude.json');
  const contentBefore   = fs.readFileSync(claudeJsonPath, 'utf8');

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    await assert.doesNotReject(
      () => mod.syncToClaudeJson('nforma'),
      'syncToClaudeJson should not throw when mcpServers is absent'
    );
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  const contentAfter = fs.readFileSync(claudeJsonPath, 'utf8');
  assert.equal(contentAfter, contentBefore, 'claude.json should not be modified when mcpServers absent');
});

test('syncToClaudeJson: exits silently when mcpServers is not an object', async () => {
  const tmpDir = makeTmpDir();
  writeClaudeJson(tmpDir, { mcpServers: 'not-an-object' });
  writeSecrets(tmpDir, { SOME_KEY: 'some-value' });

  const claudeJsonPath = path.join(tmpDir, '.claude.json');
  const contentBefore  = fs.readFileSync(claudeJsonPath, 'utf8');

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    await assert.doesNotReject(
      () => mod.syncToClaudeJson('nforma'),
      'syncToClaudeJson should not throw when mcpServers is a non-object'
    );
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  const contentAfter = fs.readFileSync(claudeJsonPath, 'utf8');
  assert.equal(contentAfter, contentBefore, 'claude.json should not be modified');
});

test('syncToClaudeJson: skips servers without env block, patches servers that have one', async () => {
  const tmpDir = makeTmpDir();
  writeSecrets(tmpDir, { SOME_KEY: 'patched-value' });

  writeClaudeJson(tmpDir, {
    mcpServers: {
      'server-no-env': {
        command: 'node',
        args: ['server.js'],
      },
      'server-with-env': {
        command: 'node',
        args: ['other.js'],
        env: { SOME_KEY: 'original' },
      },
    },
  });

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    await mod.syncToClaudeJson('nforma');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  const written = JSON.parse(
    fs.readFileSync(path.join(tmpDir, '.claude.json'), 'utf8')
  );
  assert.ok(
    !written.mcpServers['server-no-env'].env,
    'server without env block should not have env added'
  );
  assert.equal(
    written.mcpServers['server-with-env'].env.SOME_KEY,
    'patched-value',
    'server with matching env key should be patched'
  );
});

test('syncToClaudeJson: writes valid JSON with 2-space indent after patching', async () => {
  const tmpDir = makeTmpDir();
  writeSecrets(tmpDir, { API_KEY: 'secret-value' });

  writeClaudeJson(tmpDir, {
    mcpServers: {
      'test-server': {
        env: { API_KEY: 'old-value' },
      },
    },
  });

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    await mod.syncToClaudeJson('nforma');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  const raw    = fs.readFileSync(path.join(tmpDir, '.claude.json'), 'utf8');
  const parsed = JSON.parse(raw);

  assert.equal(
    parsed.mcpServers['test-server'].env.API_KEY,
    'secret-value',
    'API_KEY should be patched to secret-value'
  );
  assert.ok(
    raw.includes('\n  '),
    'output JSON should use 2-space indentation'
  );
});

test('syncToClaudeJson: patches all matching credentials across one server', async () => {
  const tmpDir = makeTmpDir();
  writeSecrets(tmpDir, { KEY_A: 'value-a', KEY_B: 'value-b', KEY_C: 'value-c' });

  writeClaudeJson(tmpDir, {
    mcpServers: {
      'multi-server': {
        env: {
          KEY_A: 'orig-a',
          KEY_B: 'orig-b',
          KEY_C: 'orig-c',
        },
      },
    },
  });

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    await mod.syncToClaudeJson('nforma');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  const written = JSON.parse(
    fs.readFileSync(path.join(tmpDir, '.claude.json'), 'utf8')
  );
  assert.equal(written.mcpServers['multi-server'].env.KEY_A, 'value-a');
  assert.equal(written.mcpServers['multi-server'].env.KEY_B, 'value-b');
  assert.equal(written.mcpServers['multi-server'].env.KEY_C, 'value-c');
});

// ─── CCR_KEY_MAP ──────────────────────────────────────────────────────────────

test('CCR_KEY_MAP maps the three provider env keys to their CCR provider names', () => {
  clearSecretsCache();
  const { CCR_KEY_MAP } = require(SECRETS_PATH);
  assert.equal(CCR_KEY_MAP['FIREWORKS_API_KEY'], 'fireworks', 'FIREWORKS_API_KEY → fireworks');
  assert.equal(CCR_KEY_MAP['AKASHML_API_KEY'],   'akashml',   'AKASHML_API_KEY → akashml');
  assert.equal(CCR_KEY_MAP['TOGETHER_API_KEY'],  'together',  'TOGETHER_API_KEY → together');
  clearSecretsCache();
});

// ─── patchClaudeJsonForKey ────────────────────────────────────────────────────

test('patchClaudeJsonForKey: patches matching env key and leaves others unchanged', () => {
  const tmpDir = makeTmpDir();
  writeClaudeJson(tmpDir, {
    mcpServers: {
      'srv': { env: { FIREWORKS_API_KEY: 'old', OTHER: 'unchanged' } },
    },
  });

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    mod.patchClaudeJsonForKey('FIREWORKS_API_KEY', 'new-val');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  const out = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude.json'), 'utf8'));
  assert.equal(out.mcpServers['srv'].env.FIREWORKS_API_KEY, 'new-val', 'key should be patched');
  assert.equal(out.mcpServers['srv'].env.OTHER, 'unchanged', 'unrelated key should be untouched');
});

test('patchClaudeJsonForKey: patches across multiple servers', () => {
  const tmpDir = makeTmpDir();
  writeClaudeJson(tmpDir, {
    mcpServers: {
      'srv-a': { env: { AKASHML_API_KEY: 'old-a', OTHER: 'keep' } },
      'srv-b': { env: { AKASHML_API_KEY: 'old-b' } },
    },
  });

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    mod.patchClaudeJsonForKey('AKASHML_API_KEY', 'new-akash');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  const out = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude.json'), 'utf8'));
  assert.equal(out.mcpServers['srv-a'].env.AKASHML_API_KEY, 'new-akash');
  assert.equal(out.mcpServers['srv-b'].env.AKASHML_API_KEY, 'new-akash');
  assert.equal(out.mcpServers['srv-a'].env.OTHER, 'keep');
});

test('patchClaudeJsonForKey: does not throw when claude.json absent', () => {
  const tmpDir = makeTmpDir();

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    assert.doesNotThrow(() => mod.patchClaudeJsonForKey('ANY_KEY', 'val'));
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }
});

test('patchClaudeJsonForKey: no write when key not present in any env block', () => {
  const tmpDir = makeTmpDir();
  writeClaudeJson(tmpDir, {
    mcpServers: { 'srv': { env: { OTHER: 'original' } } },
  });

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    mod.patchClaudeJsonForKey('MISSING_KEY', 'val');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  const out = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude.json'), 'utf8'));
  assert.equal(out.mcpServers['srv'].env.OTHER, 'original', 'content should be unchanged');
});

test('patchClaudeJsonForKey: uses atomic write (no partial file on crash)', () => {
  const tmpDir = makeTmpDir();
  writeClaudeJson(tmpDir, {
    mcpServers: { 'srv': { env: { TOGETHER_API_KEY: 'old' } } },
  });

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    mod.patchClaudeJsonForKey('TOGETHER_API_KEY', 'new-together');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  assert.equal(
    fs.existsSync(path.join(tmpDir, '.claude.json.tmp')), false,
    '.claude.json.tmp should not exist after successful write'
  );
  const raw = fs.readFileSync(path.join(tmpDir, '.claude.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw), 'patched file must be valid JSON');
});

// ─── patchCcrConfigForKey ─────────────────────────────────────────────────────

test('patchCcrConfigForKey: patches matching provider api_key', () => {
  const tmpDir = makeTmpDir();
  const ccrDir = path.join(tmpDir, '.claude-code-router');
  fs.mkdirSync(ccrDir, { recursive: true });
  const configPath = path.join(ccrDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    providers: [
      { name: 'fireworks', api_key: 'old-fw' },
      { name: 'together',  api_key: 'together-key' },
    ],
  }));

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    mod.patchCcrConfigForKey('FIREWORKS_API_KEY', 'new-fw-key');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  const out = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(out.providers[0].api_key, 'new-fw-key', 'fireworks api_key should be patched');
  assert.equal(out.providers[1].api_key, 'together-key', 'together api_key should be unchanged');
});

test('patchCcrConfigForKey: unknown env key → no-op', () => {
  const tmpDir = makeTmpDir();
  const ccrDir = path.join(tmpDir, '.claude-code-router');
  fs.mkdirSync(ccrDir, { recursive: true });
  const configPath = path.join(ccrDir, 'config.json');
  const original = JSON.stringify({ providers: [{ name: 'fireworks', api_key: 'orig' }] });
  fs.writeFileSync(configPath, original);

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    mod.patchCcrConfigForKey('ANTHROPIC_KEY', 'some-val');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  assert.equal(fs.readFileSync(configPath, 'utf8'), original, 'file should be unchanged for unknown key');
});

test('patchCcrConfigForKey: does not throw when config file absent', () => {
  const tmpDir = makeTmpDir();

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    assert.doesNotThrow(() => mod.patchCcrConfigForKey('FIREWORKS_API_KEY', 'fw-key'));
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }
});

// ===========================================================================
// ADVERSARIAL SECURITY PROBES — cross-slot credential leak / mis-resolution.
// Written to FAIL on a real defect. All fs writes stay inside os.tmpdir().
// ===========================================================================

// PRIME SUSPECT — env-key collision across slots.
// syncToClaudeJson keys its credMap by the env-var NAME (account). The flat
// secrets store can therefore hold only ONE value per env-var name. When two
// different slots both expose `ANTHROPIC_AUTH_TOKEN` in their claude.json env
// (with DIFFERENT real tokens), sync writes the single stored value into BOTH
// servers — so one slot dispatches with the OTHER slot's credential. LEAK.
//
// The set-secret.cjs flow (set raw KEY → syncToClaudeJson) is exactly this:
// two `set('nforma','ANTHROPIC_AUTH_TOKEN', …)` calls collapse to one survivor.
test('SECURITY: syncToClaudeJson must not write one slot\'s token into a different slot sharing the same env key (collision leak)', async () => {
  const tmpDir = makeTmpDir();

  // Two slots were each provisioned a DIFFERENT real ANTHROPIC_AUTH_TOKEN, but
  // the flat store keyed by env-var name can only retain the last writer.
  writeSecrets(tmpDir, { ANTHROPIC_AUTH_TOKEN: 'minimax-REAL-token-zzz' });

  writeClaudeJson(tmpDir, {
    mcpServers: {
      'claude-z-ai':   { command: 'claude', env: { ANTHROPIC_AUTH_TOKEN: 'zai-REAL-token-aaa' } },
      'claude-minimax':{ command: 'claude', env: { ANTHROPIC_AUTH_TOKEN: 'minimax-REAL-token-zzz' } },
    },
  });

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    await mod.syncToClaudeJson('nforma');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  const written = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude.json'), 'utf8'));
  const zaiTok     = written.mcpServers['claude-z-ai'].env.ANTHROPIC_AUTH_TOKEN;
  const minimaxTok = written.mcpServers['claude-minimax'].env.ANTHROPIC_AUTH_TOKEN;

  // The z-ai slot must keep its OWN token, never inherit minimax's.
  assert.notEqual(
    zaiTok, minimaxTok,
    'CREDENTIAL LEAK: claude-z-ai is now dispatching with claude-minimax\'s ANTHROPIC_AUTH_TOKEN'
  );
  assert.equal(
    zaiTok, 'zai-REAL-token-aaa',
    'claude-z-ai env token was overwritten with another slot\'s credential'
  );
});

// Root cause of the collision: a flat store keyed by env-var name cannot hold
// two distinct per-slot values for the same env key.
test('SECURITY: two slots\' tokens are retained when stored namespaced (the supported per-slot path)', async () => {
  // A flat KV store keyed by raw env-var name inherently holds ONE value per key, so
  // two RAW `set(...,'ANTHROPIC_AUTH_TOKEN',...)` calls collapse to one — by design.
  // The supported, leak-free way to give two slots DIFFERENT tokens is namespaced
  // storage (`<slot>__<KEY>`), which the provisioning paths (this session's setup +
  // migrate-plaintext-tokens.cjs) use and which syncToClaudeJson now resolves
  // namespaced-first. Both per-slot tokens must survive, distinctly.
  const tmpDir = makeTmpDir();
  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    await mod.set('nforma', 'claude-z-ai__ANTHROPIC_AUTH_TOKEN', 'zai-REAL-token-aaa');
    await mod.set('nforma', 'claude-minimax__ANTHROPIC_AUTH_TOKEN', 'minimax-REAL-token-zzz');
    const creds = await mod.list('nforma');
    const byAcct = Object.fromEntries(creds.map(c => [c.account, c.password]));
    assert.equal(byAcct['claude-z-ai__ANTHROPIC_AUTH_TOKEN'], 'zai-REAL-token-aaa');
    assert.equal(byAcct['claude-minimax__ANTHROPIC_AUTH_TOKEN'], 'minimax-REAL-token-zzz');
    assert.notEqual(
      byAcct['claude-z-ai__ANTHROPIC_AUTH_TOKEN'],
      byAcct['claude-minimax__ANTHROPIC_AUTH_TOKEN'],
      'namespaced storage must keep the two slots\' tokens distinct'
    );
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }
});

// Mis-resolution — namespaced store keys are never synced.
// bin/migrate-plaintext-tokens.cjs stores secrets NAMESPACED as `<slot>__<KEY>`
// (and call-quorum-slot reads them that way to avoid collisions). But
// syncToClaudeJson matches credMap[<raw env key>], so a credMap full of
// `claude-z-ai__ANTHROPIC_AUTH_TOKEN` keys never matches the raw env key
// `ANTHROPIC_AUTH_TOKEN` → claude.json mcpServers env is NEVER patched and keeps
// its stale `${…}` placeholder. The two storage formats are mutually incompatible.
test('SECURITY: syncToClaudeJson resolves namespaced (slot__KEY) secrets — the format migrate-plaintext-tokens actually writes', async () => {
  const tmpDir = makeTmpDir();

  writeSecrets(tmpDir, {
    'claude-z-ai__ANTHROPIC_AUTH_TOKEN':    'zai-REAL-token-aaa',
    'claude-minimax__ANTHROPIC_AUTH_TOKEN': 'minimax-REAL-token-zzz',
  });

  writeClaudeJson(tmpDir, {
    mcpServers: {
      'claude-z-ai':    { command: 'claude', env: { ANTHROPIC_AUTH_TOKEN: '${ANTHROPIC_AUTH_TOKEN}' } },
      'claude-minimax': { command: 'claude', env: { ANTHROPIC_AUTH_TOKEN: '${ANTHROPIC_AUTH_TOKEN}' } },
    },
  });

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    await mod.syncToClaudeJson('nforma');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  const written = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude.json'), 'utf8'));
  assert.equal(
    written.mcpServers['claude-z-ai'].env.ANTHROPIC_AUTH_TOKEN, 'zai-REAL-token-aaa',
    'namespaced secret was never synced — claude-z-ai env still holds the unresolved ${…} placeholder'
  );
  assert.equal(
    written.mcpServers['claude-minimax'].env.ANTHROPIC_AUTH_TOKEN, 'minimax-REAL-token-zzz',
    'namespaced secret was never synced for claude-minimax'
  );
});

// ROUND 2 — atomic-write failure must not corrupt ~/.claude.json.
// syncToClaudeJson writes a tmp file then renames. There is NO try/catch around
// that write, so if writeFileSync throws (disk full, tmp path unwritable) the
// call rejects — but the WHOLE point of write-tmp-then-rename is that the live
// ~/.claude.json (every slot's credentials + config) is never left half-written.
// We force the tmp write to fail by pre-creating `.claude.json.tmp` as a
// DIRECTORY (writeFileSync onto a dir → EISDIR), then assert the original file
// is byte-identical and still parseable. A non-atomic implementation would have
// truncated/corrupted the real file here. All writes stay inside os.tmpdir().
test('SECURITY: syncToClaudeJson atomic-write failure must not corrupt or truncate ~/.claude.json', async () => {
  const tmpDir = makeTmpDir();
  writeSecrets(tmpDir, { API_KEY: 'new-secret-value' });
  writeClaudeJson(tmpDir, {
    mcpServers: { 'srv': { command: 'claude', env: { API_KEY: 'old-but-valid' } } },
  });

  const claudeJsonPath = path.join(tmpDir, '.claude.json');
  const original = fs.readFileSync(claudeJsonPath, 'utf8');

  // Booby-trap the atomic-write target so the tmp write throws.
  fs.mkdirSync(claudeJsonPath + '.tmp', { recursive: true });

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    // May reject (no try/catch around the write); we only care that the live
    // file is never corrupted by a failed write.
    try { await mod.syncToClaudeJson('nforma'); } catch (_) { /* expected */ }
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  const after = fs.readFileSync(claudeJsonPath, 'utf8');
  assert.equal(after, original, 'live ~/.claude.json must be byte-identical after a failed atomic write');
  assert.doesNotThrow(() => JSON.parse(after), 'live ~/.claude.json must remain valid JSON after a failed write');
});

// ROUND 2 — namespaced secret for slot-A must not bleed into sibling slot-B.
// Round 1 tested two slots that were BOTH namespaced. The adversarial mixed case:
// only slot-A has a namespaced secret in the store (NO raw env-key entry), while
// sibling slot-B carries its OWN concrete token under the same shared env-key
// name. After sync, slot-A must receive its namespaced value, and slot-B must
// keep its own concrete token — never inherit slot-A's, and never be blanked.
// A regression that reintroduced a raw fallback, or that mis-scoped the
// namespaced write, would surface here as a cross-slot credential leak.
test('SECURITY: a namespaced secret for one slot must not overwrite a sibling slot holding its own concrete token', async () => {
  const tmpDir = makeTmpDir();

  // Only z-ai is provisioned namespaced. No raw ANTHROPIC_AUTH_TOKEN in the store.
  writeSecrets(tmpDir, { 'claude-z-ai__ANTHROPIC_AUTH_TOKEN': 'zai-REAL-token-aaa' });

  writeClaudeJson(tmpDir, {
    mcpServers: {
      'claude-z-ai':    { command: 'claude', env: { ANTHROPIC_AUTH_TOKEN: '${ANTHROPIC_AUTH_TOKEN}' } },
      'claude-minimax': { command: 'claude', env: { ANTHROPIC_AUTH_TOKEN: 'minimax-OWN-concrete-zzz' } },
    },
  });

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    await mod.syncToClaudeJson('nforma');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  const written  = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude.json'), 'utf8'));
  const zaiTok     = written.mcpServers['claude-z-ai'].env.ANTHROPIC_AUTH_TOKEN;
  const minimaxTok = written.mcpServers['claude-minimax'].env.ANTHROPIC_AUTH_TOKEN;

  assert.equal(zaiTok, 'zai-REAL-token-aaa', 'z-ai must receive its own namespaced token');
  assert.equal(
    minimaxTok, 'minimax-OWN-concrete-zzz',
    'CREDENTIAL LEAK/CLOBBER: minimax must keep its own concrete token, not inherit z-ai\'s nor be blanked'
  );
});

// ROUND 2 — malformed / mismatched credMap accounts must never be misapplied.
// syncToClaudeJson builds the lookup key as `serverName + '__' + envKey` and does
// an EXACT match (it never splits the account). Adversarial store contents:
//   - an account whose env-key half doesn't exist in any server's env,
//   - a multi-`__` account (a__b__c) that could be mis-split by a naive parser,
//   - a leading-`__` (empty-slot) account.
// None of these should crash, and none should be written into the real slot
// (which carries only an unresolved placeholder and has no matching credential).
test('SECURITY: malformed/mismatched namespaced accounts are never misapplied and never crash', async () => {
  const tmpDir = makeTmpDir();

  writeSecrets(tmpDir, {
    'realslot__SOME_OTHER_KEY': 'wrong-key-value',  // env-key half absent from realslot.env
    'a__b__c':                  'multi-underscore',  // would mis-split on a naive parser
    '__ANTHROPIC_AUTH_TOKEN':   'leading-empty-slot',// empty slot half
    // NOTE: deliberately NO raw 'ANTHROPIC_AUTH_TOKEN' and NO
    // 'realslot__ANTHROPIC_AUTH_TOKEN' → nothing legitimately matches realslot.
  });

  writeClaudeJson(tmpDir, {
    mcpServers: {
      'realslot': { command: 'claude', env: { ANTHROPIC_AUTH_TOKEN: '${ANTHROPIC_AUTH_TOKEN}' } },
    },
  });

  const claudeJsonPath = path.join(tmpDir, '.claude.json');
  const before = fs.readFileSync(claudeJsonPath, 'utf8');

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    await assert.doesNotReject(() => mod.syncToClaudeJson('nforma'), 'malformed accounts must not crash sync');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  const after = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
  assert.equal(
    after.mcpServers['realslot'].env.ANTHROPIC_AUTH_TOKEN, '${ANTHROPIC_AUTH_TOKEN}',
    'no malformed account may be written into realslot — its placeholder must remain untouched'
  );
  // Nothing matched → file should not have been rewritten at all.
  assert.equal(fs.readFileSync(claudeJsonPath, 'utf8'), before, 'unmatched sync must not rewrite claude.json');
});

test('patchCcrConfigForKey: patches all providers with matching name (case-insensitive)', () => {
  const tmpDir = makeTmpDir();
  const ccrDir = path.join(tmpDir, '.claude-code-router');
  fs.mkdirSync(ccrDir, { recursive: true });
  const configPath = path.join(ccrDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    providers: [
      { name: 'Fireworks', api_key: 'old-1' },
      { name: 'FIREWORKS', api_key: 'old-2' },
    ],
  }));

  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    mod.patchCcrConfigForKey('FIREWORKS_API_KEY', 'new-fw');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }

  const out = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(out.providers[0].api_key, 'new-fw', 'Fireworks (title case) should be patched');
  assert.equal(out.providers[1].api_key, 'new-fw', 'FIREWORKS (upper case) should be patched');
});

// ─── HARDEN: syncToClaudeJson idempotency ────────────────────────────────────

test('SECURITY/perf: syncToClaudeJson is idempotent — a no-change sync does NOT rewrite ~/.claude.json', async () => {
  // When the env already holds the exact secret value, sync must not rewrite the file
  // (avoids mtime churn / file-watcher wakeups / concurrent-sync races).
  const tmpDir = makeTmpDir();
  writeSecrets(tmpDir, { OPENAI_API_KEY: 'sk-final' });
  writeClaudeJson(tmpDir, {
    mcpServers: { only: { command: 'node', env: { OPENAI_API_KEY: 'sk-final' } } },
  });
  const claudeJsonPath = path.join(tmpDir, '.claude.json');
  const realHomedir = os.homedir.bind(os);
  const mod = requireSecretsWithTmpHome(tmpDir);
  try {
    // First sync resolves it (value already equal → no write); capture mtime.
    await mod.syncToClaudeJson('nforma');
    const before = fs.statSync(claudeJsonPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 12));
    await mod.syncToClaudeJson('nforma');
    const after = fs.statSync(claudeJsonPath).mtimeMs;
    assert.equal(after, before, 'an unchanged sync must not rewrite the file');
    // And the value is still correct.
    const out = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    assert.equal(out.mcpServers.only.env.OPENAI_API_KEY, 'sk-final');
  } finally {
    restoreHomedir(realHomedir);
    clearSecretsCache();
  }
});

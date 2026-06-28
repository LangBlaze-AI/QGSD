#!/usr/bin/env node
// Test suite for bin/ccr-secure-config.cjs
// Uses Node.js built-in test runner: node --test bin/ccr-secure-config.test.cjs
//
// Strategy:
//   ccr-secure-config.cjs has no exports — it is a pure CLI script.  All tests
//   use spawnSync to run it as a child process.
//
//   To control:
//     • secrets.cjs location  — we copy the CLI into a temp dir and plant a fake
//       secrets.cjs stub next to it.  findSecrets() checks __dirname-relative path
//       as second candidate, so the stub is discovered automatically.
//     • CONFIG_PATH (~/.claude-code-router/config.json) — we set the HOME env var
//       to the temp dir so that os.homedir() returns our controlled directory.
//
//   For every test:
//     1. Create a temp dir.
//     2. Copy ccr-secure-config.cjs into it (so __dirname resolves there).
//     3. Optionally write a fake secrets.cjs stub next to it.
//     4. Optionally write a fake config.json at <tmpDir>/.claude-code-router/config.json.
//     5. Run the script with HOME=<tmpDir>.
//     6. Assert exit code, stdout, stderr.

'use strict';

const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const fs         = require('fs');
const os         = require('os');
const path       = require('path');
const { spawnSync } = require('child_process');

const CLI_SRC = path.join(__dirname, 'ccr-secure-config.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = path.join(
    os.tmpdir(),
    'nf-ccr-' + Date.now() + '-' + Math.random().toString(36).slice(2)
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Copy the CLI source into tmpDir so that __dirname-relative resolution works.
 * Returns the path to the copied script.
 */
function installCli(tmpDir) {
  const dest = path.join(tmpDir, 'ccr-secure-config.cjs');
  fs.copyFileSync(CLI_SRC, dest);
  return dest;
}

/**
 * Plant a fake secrets.cjs next to the CLI in tmpDir.
 * secretsExports is an object describing mock behaviour:
 *   { akash, together, fireworks, throwMessage }
 *
 * If throwMessage is set the `get` function throws that message.
 * Otherwise returns the per-key values (undefined treated as null).
 */
function plantSecrets(tmpDir, { akash = null, together = null, fireworks = null, throwMessage = null } = {}) {
  const body = throwMessage
    ? `
'use strict';
module.exports = {
  async get(service, key) {
    throw new Error(${JSON.stringify(throwMessage)});
  },
};
`
    : `
'use strict';
const KEYS = {
  AKASHML_API_KEY:    ${JSON.stringify(akash)},
  TOGETHER_API_KEY:   ${JSON.stringify(together)},
  FIREWORKS_API_KEY:  ${JSON.stringify(fireworks)},
};
module.exports = {
  async get(service, key) { return KEYS[key] || null; },
};
`;
  fs.writeFileSync(path.join(tmpDir, 'secrets.cjs'), body, 'utf8');
}

/**
 * Write a fake config.json at <tmpDir>/.claude-code-router/config.json.
 * content can be a JS object (will be JSON-stringified) or a raw string.
 */
function writeConfig(tmpDir, content) {
  const dir = path.join(tmpDir, '.claude-code-router');
  fs.mkdirSync(dir, { recursive: true });
  const raw = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  fs.writeFileSync(path.join(dir, 'config.json'), raw, 'utf8');
}

/**
 * Read back the config.json that the script would have written.
 */
function readConfig(tmpDir) {
  return JSON.parse(
    fs.readFileSync(path.join(tmpDir, '.claude-code-router', 'config.json'), 'utf8')
  );
}

/**
 * Run the CLI from tmpDir with HOME pointing to tmpDir.
 */
function run(tmpDir, extraEnv = {}) {
  const script = path.join(tmpDir, 'ccr-secure-config.cjs');
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    timeout:  5000,
    env: {
      ...process.env,
      HOME: tmpDir,
      ...extraEnv,
    },
  });
  return {
    stdout:   result.stdout  || '',
    stderr:   result.stderr  || '',
    exitCode: result.status,
  };
}

// ─── Test 1: secrets.cjs not found → exits 0, stderr message ─────────────────

test('exits 0 with diagnostic when secrets.cjs is not found', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  // No secrets.cjs planted — both candidate paths will be absent
  // (installed path: <HOME>/.claude/nf-bin/secrets.cjs also absent)
  const { exitCode, stderr } = run(tmpDir);
  assert.equal(exitCode, 0, 'should exit 0 (fail-silent) when secrets not found');
  assert.ok(
    stderr.includes('secrets.cjs not found'),
    `expected "secrets.cjs not found" in stderr, got: ${stderr}`
  );
});

// ─── Test 2: secrets.get throws → exits 0, stderr mentions store ──────────────

test('exits 0 with diagnostic when secrets.get throws', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { throwMessage: 'secrets store error' });
  const { exitCode, stderr } = run(tmpDir);
  assert.equal(exitCode, 0, 'should exit 0 when secrets store is unavailable');
  assert.ok(
    stderr.includes('secrets store unavailable'),
    `expected "secrets store unavailable" in stderr, got: ${stderr}`
  );
});

// ─── Test 3: all three keys missing (null) → exits 0, stderr about no keys ───

test('exits 0 with diagnostic when all provider keys are null', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { akash: null, together: null, fireworks: null });
  const { exitCode, stderr } = run(tmpDir);
  assert.equal(exitCode, 0, 'should exit 0 when no provider keys are stored');
  assert.ok(
    stderr.includes('No CCR provider keys found'),
    `expected "No CCR provider keys found" in stderr, got: ${stderr}`
  );
});

// ─── Test 4: config.json missing → exits 1 ───────────────────────────────────

test('exits 1 when config.json does not exist', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { akash: 'ak-key-123' });
  // No config.json written
  const { exitCode, stderr } = run(tmpDir);
  assert.equal(exitCode, 1, 'should exit 1 when config.json is absent');
  assert.ok(
    stderr.includes('Could not read'),
    `expected "Could not read" in stderr, got: ${stderr}`
  );
});

// ─── Test 5: config.json is invalid JSON → exits 1 ───────────────────────────

test('exits 1 when config.json contains invalid JSON', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { akash: 'ak-key-123' });
  writeConfig(tmpDir, '{ this is not valid json !!!');
  const { exitCode, stderr } = run(tmpDir);
  assert.equal(exitCode, 1, 'should exit 1 on JSON parse error');
  assert.ok(
    stderr.includes('Could not read'),
    `expected "Could not read" in stderr, got: ${stderr}`
  );
});

// ─── Test 6: config.json has no providers array → exits 1 ────────────────────

test('exits 1 when config.json has no providers array', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { akash: 'ak-key-123' });
  writeConfig(tmpDir, { notProviders: [] });
  const { exitCode, stderr } = run(tmpDir);
  assert.equal(exitCode, 1, 'should exit 1 when providers array is missing');
  assert.ok(
    stderr.includes('no providers array'),
    `expected "no providers array" in stderr, got: ${stderr}`
  );
});

// ─── Test 7: providers is a non-array value → exits 1 ────────────────────────

test('exits 1 when config.json providers field is not an array', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { akash: 'ak-key-123' });
  writeConfig(tmpDir, { providers: 'not-an-array' });
  const { exitCode, stderr } = run(tmpDir);
  assert.equal(exitCode, 1, 'should exit 1 when providers is not an array');
  assert.ok(
    stderr.includes('no providers array'),
    `expected "no providers array" in stderr, got: ${stderr}`
  );
});

// ─── Test 8: happy path — all three keys patched, exits 0 ────────────────────

test('patches all three provider keys and exits 0', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, {
    akash:     'ak-secret-111',
    together:  'tg-secret-222',
    fireworks: 'fw-secret-333',
  });
  writeConfig(tmpDir, {
    providers: [
      { name: 'akashml',   api_key: 'old-ak'  },
      { name: 'together',  api_key: 'old-tg'  },
      { name: 'fireworks', api_key: 'old-fw'  },
    ],
  });

  const { exitCode, stdout } = run(tmpDir);
  assert.equal(exitCode, 0, 'should exit 0 on success');
  assert.ok(
    stdout.includes('Populated 3 provider key(s)'),
    `expected "Populated 3 provider key(s)" in stdout, got: ${stdout}`
  );

  const cfg = readConfig(tmpDir);
  assert.equal(cfg.providers[0].api_key, 'ak-secret-111', 'akashml key should be patched');
  assert.equal(cfg.providers[1].api_key, 'tg-secret-222', 'together key should be patched');
  assert.equal(cfg.providers[2].api_key, 'fw-secret-333', 'fireworks key should be patched');
});

// ─── Test 9: only akash key set, together/fireworks null → patches 1 ─────────

test('patches only the akashml key when together and fireworks are null', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { akash: 'ak-only-key', together: null, fireworks: null });
  writeConfig(tmpDir, {
    providers: [
      { name: 'akashml',   api_key: 'old-ak'  },
      { name: 'together',  api_key: 'old-tg'  },
      { name: 'fireworks', api_key: 'old-fw'  },
    ],
  });

  const { exitCode, stdout } = run(tmpDir);
  assert.equal(exitCode, 0, 'should exit 0');
  assert.ok(
    stdout.includes('Populated 1 provider key(s)'),
    `expected "Populated 1 provider key(s)" in stdout, got: ${stdout}`
  );

  const cfg = readConfig(tmpDir);
  assert.equal(cfg.providers[0].api_key, 'ak-only-key', 'akashml should be patched');
  assert.equal(cfg.providers[1].api_key, 'old-tg',      'together should remain unchanged');
  assert.equal(cfg.providers[2].api_key, 'old-fw',      'fireworks should remain unchanged');
});

// ─── Test 10: provider name matching is case-insensitive ─────────────────────

test('matches provider names case-insensitively (AkashML, Together, Fireworks)', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, {
    akash:     'ak-ci-key',
    together:  'tg-ci-key',
    fireworks: 'fw-ci-key',
  });
  writeConfig(tmpDir, {
    providers: [
      { name: 'AkashML',   api_key: 'old' },
      { name: 'Together',  api_key: 'old' },
      { name: 'Fireworks', api_key: 'old' },
    ],
  });

  const { exitCode, stdout } = run(tmpDir);
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes('Populated 3 provider key(s)'), stdout);

  const cfg = readConfig(tmpDir);
  assert.equal(cfg.providers[0].api_key, 'ak-ci-key');
  assert.equal(cfg.providers[1].api_key, 'tg-ci-key');
  assert.equal(cfg.providers[2].api_key, 'fw-ci-key');
});

// ─── Test 11: providers without a name field are skipped ─────────────────────

test('skips providers that have no name field', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { akash: 'ak-key', together: 'tg-key', fireworks: 'fw-key' });
  writeConfig(tmpDir, {
    providers: [
      { api_key: 'nameless-old'       },    // no name
      { name: 'akashml', api_key: 'old' },
    ],
  });

  const { exitCode, stdout } = run(tmpDir);
  assert.equal(exitCode, 0);
  // Only 1 provider has a matching name
  assert.ok(stdout.includes('Populated 1 provider key(s)'), stdout);

  const cfg = readConfig(tmpDir);
  assert.equal(cfg.providers[0].api_key, 'nameless-old', 'nameless provider should be untouched');
  assert.equal(cfg.providers[1].api_key, 'ak-key',       'named provider should be patched');
});

// ─── Test 12: unrecognised provider names are not patched ────────────────────

test('does not patch providers whose names are not in the key map', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { akash: 'ak-key', together: null, fireworks: null });
  writeConfig(tmpDir, {
    providers: [
      { name: 'openai',    api_key: 'old-openai' },
      { name: 'anthropic', api_key: 'old-ant'    },
      { name: 'akashml',   api_key: 'old-ak'     },
    ],
  });

  const { exitCode, stdout } = run(tmpDir);
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes('Populated 1 provider key(s)'), stdout);

  const cfg = readConfig(tmpDir);
  assert.equal(cfg.providers[0].api_key, 'old-openai', 'openai should not be patched');
  assert.equal(cfg.providers[1].api_key, 'old-ant',    'anthropic should not be patched');
  assert.equal(cfg.providers[2].api_key, 'ak-key',     'akashml should be patched');
});

// ─── Test 13: config.json written back as valid JSON ─────────────────────────

test('written config.json is valid JSON that preserves non-provider fields', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { akash: 'ak-k', together: null, fireworks: null });
  writeConfig(tmpDir, {
    version: '2.0',
    logLevel: 'info',
    providers: [
      { name: 'akashml', api_key: 'old', timeout: 30 },
    ],
  });

  const { exitCode } = run(tmpDir);
  assert.equal(exitCode, 0);

  const cfg = readConfig(tmpDir);
  assert.equal(cfg.version,  '2.0',  'version field should be preserved');
  assert.equal(cfg.logLevel, 'info', 'logLevel field should be preserved');
  assert.equal(cfg.providers[0].timeout, 30, 'provider timeout field should be preserved');
  assert.equal(cfg.providers[0].api_key, 'ak-k', 'api_key should be updated');
});

// ─── Test 14: config.json written with restrictive permissions ────────────────

test('written config.json has mode 600', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { akash: 'ak-perm-key' });
  writeConfig(tmpDir, {
    providers: [{ name: 'akashml', api_key: 'old' }],
  });

  const { exitCode } = run(tmpDir);
  assert.equal(exitCode, 0);

  const configPath = path.join(tmpDir, '.claude-code-router', 'config.json');
  const mode = fs.statSync(configPath).mode & 0o777;
  assert.equal(mode, 0o600, `config.json should have mode 600, got ${mode.toString(8)}`);
});

// ─── Test 15: empty providers array → exits 0, patches 0 keys ────────────────

test('exits 0 with "Populated 0" when providers array is empty', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { akash: 'ak-key' });
  writeConfig(tmpDir, { providers: [] });

  const { exitCode, stdout } = run(tmpDir);
  assert.equal(exitCode, 0);
  assert.ok(
    stdout.includes('Populated 0 provider key(s)'),
    `expected "Populated 0 provider key(s)", got: ${stdout}`
  );
});

// ─── Test 16: secrets.cjs found in installed global path (~/.claude/nf-bin) ─

test('finds secrets.cjs at the installed global path (~/.claude/nf-bin/secrets.cjs)', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  // Plant secrets at the installed path (first candidate): <HOME>/.claude/nf-bin/secrets.cjs
  const installedDir = path.join(tmpDir, '.claude', 'nf-bin');
  fs.mkdirSync(installedDir, { recursive: true });
  const body = `
'use strict';
module.exports = {
  async get(service, key) {
    if (key === 'AKASHML_API_KEY') return 'installed-ak-key';
    return null;
  },
};
`;
  fs.writeFileSync(path.join(installedDir, 'secrets.cjs'), body, 'utf8');
  // Do NOT plant a local secrets.cjs — the installed path should win
  writeConfig(tmpDir, {
    providers: [{ name: 'akashml', api_key: 'old' }],
  });

  const { exitCode, stdout } = run(tmpDir);
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes('Populated 1 provider key(s)'), stdout);

  const cfg = readConfig(tmpDir);
  assert.equal(cfg.providers[0].api_key, 'installed-ak-key');
});

// ─── Test 17: config.json written with 2-space indentation ───────────────────

test('config.json is written with 2-space JSON indentation', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { akash: 'ak-indent-key' });
  writeConfig(tmpDir, {
    providers: [{ name: 'akashml', api_key: 'old' }],
  });

  const { exitCode } = run(tmpDir);
  assert.equal(exitCode, 0);

  const raw = fs.readFileSync(
    path.join(tmpDir, '.claude-code-router', 'config.json'),
    'utf8'
  );
  // JSON.stringify(_, null, 2) produces lines indented with exactly 2 spaces
  assert.ok(raw.includes('\n  '), 'output should use 2-space indentation');
  // Sanity: must still be valid JSON
  assert.doesNotThrow(() => JSON.parse(raw), 'output must be valid JSON');
});

// ─── Test 18: providers array contains null entries — crashes (documents actual behavior) ───

test('exits 1 when providers array contains a null entry (null.name throws)', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { akash: 'ak-key' });
  // A null element causes `provider.name` to throw a TypeError at runtime.
  // The top-level .catch() handler converts this to exit 1.
  const raw = JSON.stringify({ providers: [null, { name: 'akashml', api_key: 'old' }] }, null, 2);
  writeConfig(tmpDir, raw);

  const { exitCode, stderr } = run(tmpDir);
  assert.equal(exitCode, 1, 'accessing .name on null causes an uncaught error → exit 1');
  assert.ok(
    stderr.includes('[ccr-secure-config]') && stderr.includes('Unexpected error'),
    `expected Unexpected error message in stderr, got: ${stderr}`
  );
});

// ─── Test 19: no stdout on failure paths ────────────────────────────────────

test('produces no stdout output when exiting 0 because no keys found', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { akash: null, together: null, fireworks: null });

  const { exitCode, stdout } = run(tmpDir);
  assert.equal(exitCode, 0);
  assert.equal(stdout.trim(), '', `expected empty stdout, got: ${stdout}`);
});

// ─── Test 20: stderr prefix on secrets store error ────────────────────────────

test('stderr store-unavailable message carries [ccr-secure-config] prefix', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { throwMessage: 'simulated store error' });

  const { stderr } = run(tmpDir);
  assert.ok(
    stderr.includes('[ccr-secure-config]'),
    `expected [ccr-secure-config] prefix in stderr, got: ${stderr}`
  );
  assert.ok(
    stderr.includes('simulated store error'),
    `expected the thrown message text in stderr, got: ${stderr}`
  );
});

// ─── Test 21: stderr prefix on "no keys found" ───────────────────────────────

test('stderr no-keys message carries [ccr-secure-config] prefix', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { akash: null, together: null, fireworks: null });

  const { stderr } = run(tmpDir);
  assert.ok(
    stderr.includes('[ccr-secure-config]'),
    `expected [ccr-secure-config] prefix in stderr, got: ${stderr}`
  );
});

// ─── Test 22: simultaneous akash + fireworks keys, together absent ────────────

test('patches akashml and fireworks when together key is null', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { akash: 'ak-two', together: null, fireworks: 'fw-two' });
  writeConfig(tmpDir, {
    providers: [
      { name: 'akashml',   api_key: 'old-ak' },
      { name: 'together',  api_key: 'old-tg' },
      { name: 'fireworks', api_key: 'old-fw' },
    ],
  });

  const { exitCode, stdout } = run(tmpDir);
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes('Populated 2 provider key(s)'), stdout);

  const cfg = readConfig(tmpDir);
  assert.equal(cfg.providers[0].api_key, 'ak-two',  'akashml should be patched');
  assert.equal(cfg.providers[1].api_key, 'old-tg',  'together should remain unchanged');
  assert.equal(cfg.providers[2].api_key, 'fw-two',  'fireworks should be patched');
});

// ─── Test 23: duplicate provider name entries — both patched ─────────────────

test('patches all entries when the same provider name appears more than once', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { akash: 'ak-dup' });
  writeConfig(tmpDir, {
    providers: [
      { name: 'akashml', api_key: 'first-old'  },
      { name: 'akashml', api_key: 'second-old' },
    ],
  });

  const { exitCode, stdout } = run(tmpDir);
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes('Populated 2 provider key(s)'), stdout);

  const cfg = readConfig(tmpDir);
  assert.equal(cfg.providers[0].api_key, 'ak-dup', 'first akashml entry should be patched');
  assert.equal(cfg.providers[1].api_key, 'ak-dup', 'second akashml entry should be patched');
});

// ─── Test 24: does not hang — resolves within timeout ────────────────────────

test('resolves within 3 seconds (no-hang contract) on missing secrets', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  // No secrets.cjs — fast-fail path

  const start = Date.now();
  const { exitCode } = run(tmpDir);
  const elapsed = Date.now() - start;

  assert.equal(exitCode, 0, 'should exit 0');
  assert.ok(elapsed < 3000, `should finish within 3s, took ${elapsed}ms`);
});

// ─── Test 25 (CSC-1): provider named "constructor" must not match via inherited prop ───

test('does not match/corrupt a provider named "constructor" (inherited-prop via `in`)', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { akash: 'ak-key' });
  writeConfig(tmpDir, {
    providers: [
      { name: 'constructor', api_key: 'keep-me' },
      { name: 'akashml',     api_key: 'old'     },
    ],
  });

  const { exitCode, stdout } = run(tmpDir);
  assert.equal(exitCode, 0);
  assert.ok(
    stdout.includes('Populated 1 provider key(s)'),
    `expected only akashml patched, got: ${stdout}`
  );

  const cfg = readConfig(tmpDir);
  assert.equal(cfg.providers[0].api_key, 'keep-me', 'provider named "constructor" must not be matched/corrupted');
  assert.equal(cfg.providers[1].api_key, 'ak-key', 'akashml should be patched');
});

// ─── Test 26 (CSC-2): non-string truthy provider name is skipped, not crashed ───

test('skips a provider whose name is a non-string truthy value instead of crashing', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { akash: 'ak-key' });
  // name as a number — provider.name.toLowerCase() throws under current code
  const raw = JSON.stringify({
    providers: [
      { name: 123,       api_key: 'numeric-name' },
      { name: 'akashml', api_key: 'old'          },
    ],
  }, null, 2);
  writeConfig(tmpDir, raw);

  const { exitCode, stdout } = run(tmpDir);
  assert.equal(exitCode, 0, 'a non-string name must not abort the whole config write');
  assert.ok(stdout.includes('Populated 1 provider key(s)'), stdout);

  const cfg = readConfig(tmpDir);
  assert.equal(cfg.providers[0].api_key, 'numeric-name', 'numeric-name provider untouched');
  assert.equal(cfg.providers[1].api_key, 'ak-key', 'akashml should be patched');
});

// ─── Test 27 (CSC-3): config.json that is literally `null` exits gracefully ───

test('exits 1 gracefully (no Unexpected error) when config.json is literally null', () => {
  const tmpDir = makeTmpDir();
  installCli(tmpDir);
  plantSecrets(tmpDir, { akash: 'ak-key' });
  writeConfig(tmpDir, 'null');

  const { exitCode, stderr } = run(tmpDir);
  assert.equal(exitCode, 1);
  assert.ok(
    stderr.includes('no providers array'),
    `expected graceful "no providers array", got: ${stderr}`
  );
});

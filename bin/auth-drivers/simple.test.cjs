'use strict';
// Tests for bin/auth-drivers/simple.cjs
// node --test bin/auth-drivers/simple.test.cjs

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const os       = require('os');
const fs       = require('fs');
const path     = require('path');

const SIMPLE_PATH = require.resolve('./simple.cjs');

// Build a minimal JWT with the given payload (no real signing needed for decode tests).
function makeJwt(payload) {
  const header  = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body    = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

// Write a temp credential file, run fn(provider), then clean up.
function withTempCreds(fileContent, fn) {
  const tmp = path.join(os.tmpdir(), 'simple-driver-test-' + Date.now() + '.json');
  fs.writeFileSync(tmp, JSON.stringify(fileContent));
  const provider = { oauth_rotation: { active_file: tmp } };
  try { return fn(provider); }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

const driver = require('./simple.cjs');

// ─── 1. Interface contract ────────────────────────────────────────────────────

test('simple driver exports all 4 required interface methods', () => {
  for (const m of ['list', 'switch', 'addCredentialFile', 'extractAccountName']) {
    assert.strictEqual(typeof driver[m], 'function', `missing method: ${m}()`);
  }
});

// ─── 2. list() ────────────────────────────────────────────────────────────────

test('list returns empty array (no account pool for simple providers)', () => {
  assert.deepStrictEqual(driver.list({}), []);
});

test('list ignores provider argument and always returns []', () => {
  assert.deepStrictEqual(driver.list({ name: 'opencode-1', auth: { type: 'simple' } }), []);
});

// ─── 3. switch() ──────────────────────────────────────────────────────────────

test('switch throws with a "not supported" message', () => {
  assert.throws(
    () => driver.switch({}, 'any-account'),
    (err) => {
      assert.ok(
        err.message.toLowerCase().includes('not supported'),
        `expected "not supported" in: ${err.message}`,
      );
      return true;
    },
  );
});

// ─── 4. addCredentialFile() ───────────────────────────────────────────────────

test('addCredentialFile returns null (simple providers have no file to poll)', () => {
  assert.strictEqual(driver.addCredentialFile({}), null);
});

// ─── 5. extractAccountName() ──────────────────────────────────────────────────

test('extractAccountName returns null when no oauth_rotation.active_file configured', () => {
  assert.strictEqual(driver.extractAccountName({}), null);
});

test('extractAccountName decodes top-level id_token JWT (Gemini-style)', () => {
  withTempCreds(
    { id_token: makeJwt({ email: 'user@gemini-style.com' }) },
    (provider) => {
      assert.strictEqual(driver.extractAccountName(provider), 'user@gemini-style.com');
    },
  );
});

test('extractAccountName decodes nested tokens.id_token JWT (Codex-style)', () => {
  withTempCreds(
    { tokens: { id_token: makeJwt({ email: 'jonathanborduas@gmail.com' }) } },
    (provider) => {
      assert.strictEqual(driver.extractAccountName(provider), 'jonathanborduas@gmail.com');
    },
  );
});

test('extractAccountName returns null when active_file does not exist', () => {
  const provider = { oauth_rotation: { active_file: '/nonexistent/path/auth.json' } };
  assert.strictEqual(driver.extractAccountName(provider), null);
});

test('extractAccountName returns null when JWT has no email claim', () => {
  withTempCreds(
    { tokens: { id_token: makeJwt({ sub: 'user-abc123', aud: 'myapp' }) } },
    (provider) => {
      assert.strictEqual(driver.extractAccountName(provider), null);
    },
  );
});

test('extractAccountName returns null when credential file has no JWT', () => {
  withTempCreds(
    { OPENAI_API_KEY: 'sk-abc123', last_refresh: 12345 },
    (provider) => {
      assert.strictEqual(driver.extractAccountName(provider), null);
    },
  );
});

test('extractAccountName returns null when identity_detect pattern has no capture group', () => {
  const tmp = path.join(os.tmpdir(), 'simple-driver-iddetect-' + Date.now() + '.txt');
  fs.writeFileSync(tmp, 'oauth_token: abc123xyz\n');
  const provider = { identity_detect: { file: tmp, pattern: 'oauth_token: \\w+' } };
  try {
    // Pattern matches but declares no capture group -> m[1] is undefined.
    // Must return null (documented contract), not undefined.
    assert.strictEqual(driver.extractAccountName(provider), null);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
});

test('extractAccountName returns null when JWT email claim is not a string', () => {
  withTempCreds(
    { id_token: makeJwt({ email: { primary: 'user@x.com' } }) },
    (provider) => {
      assert.strictEqual(driver.extractAccountName(provider), null);
    },
  );
});

// ─── 6. add() ─────────────────────────────────────────────────────────────────

test('add resolves without error (terminal already ran auth.login; nothing to capture)', async () => {
  await assert.doesNotReject(() => driver.add({}, 'ignored'));
});

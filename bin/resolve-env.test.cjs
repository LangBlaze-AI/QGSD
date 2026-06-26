'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isSecretKey, toPlaceholder, isPlaceholder,
  resolveEnvPlaceholders, resolveSinglePlaceholder,
  findPlaintextSecrets, maskSecrets, findUnresolvedPlaceholders,
  extractPlaceholderVar, namespacedSecretKey,
  SECRET_KEY_RE, PLACEHOLDER_RE,
} = require('./resolve-env.cjs');

// ---------------------------------------------------------------------------
// isSecretKey
// ---------------------------------------------------------------------------

test('isSecretKey: matches *_API_KEY', () => {
  assert.equal(isSecretKey('ANTHROPIC_API_KEY'), true);
  assert.equal(isSecretKey('OPENAI_API_KEY'), true);
  assert.equal(isSecretKey('MY_CUSTOM_API_KEY'), true);
});

test('isSecretKey: matches *_AUTH_TOKEN', () => {
  assert.equal(isSecretKey('ANTHROPIC_AUTH_TOKEN'), true);
  assert.equal(isSecretKey('ZAI_AUTH_TOKEN'), true);
});

test('isSecretKey: matches *_TOKEN', () => {
  assert.equal(isSecretKey('BEARER_TOKEN'), true);
  assert.equal(isSecretKey('ACCESS_TOKEN'), true);
});

test('isSecretKey: does not match non-secret keys', () => {
  assert.equal(isSecretKey('ANTHROPIC_BASE_URL'), false);
  assert.equal(isSecretKey('MODEL'), false);
  assert.equal(isSecretKey('CLAUDE_DEFAULT_MODEL'), false);
  assert.equal(isSecretKey('PROVIDER_SLOT'), false);
});

// ---------------------------------------------------------------------------
// toPlaceholder
// ---------------------------------------------------------------------------

test('toPlaceholder: wraps key in ${...}', () => {
  assert.equal(toPlaceholder('ANTHROPIC_API_KEY'), '${ANTHROPIC_API_KEY}');
  assert.equal(toPlaceholder('ANTHROPIC_AUTH_TOKEN'), '${ANTHROPIC_AUTH_TOKEN}');
});

// ---------------------------------------------------------------------------
// isPlaceholder
// ---------------------------------------------------------------------------

test('isPlaceholder: detects ${VAR} strings', () => {
  assert.equal(isPlaceholder('${ANTHROPIC_API_KEY}'), true);
  assert.equal(isPlaceholder('${FOO_BAR}'), true);
});

test('isPlaceholder: rejects non-placeholder strings', () => {
  assert.equal(isPlaceholder('sk-ant-12345'), false);
  assert.equal(isPlaceholder('${partial'), false);
  assert.equal(isPlaceholder('text${VAR}text'), false);
  assert.equal(isPlaceholder(''), false);
});

// ---------------------------------------------------------------------------
// resolveSinglePlaceholder
// ---------------------------------------------------------------------------

test('resolveSinglePlaceholder: resolves from process.env', () => {
  process.env._NF_TEST_RESOLVE_ME = 'resolved-value';
  assert.equal(resolveSinglePlaceholder('${_NF_TEST_RESOLVE_ME}'), 'resolved-value');
  delete process.env._NF_TEST_RESOLVE_ME;
});

test('resolveSinglePlaceholder: returns original when not a placeholder', () => {
  assert.equal(resolveSinglePlaceholder('plain-value'), 'plain-value');
  assert.equal(resolveSinglePlaceholder('https://api.example.com'), 'https://api.example.com');
});

test('resolveSinglePlaceholder: returns original when env var missing', () => {
  assert.equal(resolveSinglePlaceholder('${_NF_DEFINITELY_NOT_SET_XYZ}'), '${_NF_DEFINITELY_NOT_SET_XYZ}');
});

// ---------------------------------------------------------------------------
// resolveEnvPlaceholders
// ---------------------------------------------------------------------------

test('resolveEnvPlaceholders: resolves all placeholders', () => {
  process.env._NF_TEST_KEY1 = 'value1';
  process.env._NF_TEST_KEY2 = 'value2';
  const env = {
    API_KEY: '${_NF_TEST_KEY1}',
    BASE_URL: 'https://example.com',
    AUTH_TOKEN: '${_NF_TEST_KEY2}',
  };
  const resolved = resolveEnvPlaceholders(env);
  assert.deepEqual(resolved, {
    API_KEY: 'value1',
    BASE_URL: 'https://example.com',
    AUTH_TOKEN: 'value2',
  });
  delete process.env._NF_TEST_KEY1;
  delete process.env._NF_TEST_KEY2;
});

test('resolveEnvPlaceholders: handles empty/null env', () => {
  assert.deepEqual(resolveEnvPlaceholders({}), {});
  assert.deepEqual(resolveEnvPlaceholders(null), {});
  assert.deepEqual(resolveEnvPlaceholders(undefined), {});
});

test('resolveEnvPlaceholders: leaves unresolved placeholders as-is', () => {
  const env = { TOKEN: '${_NF_MISSING_VAR}' };
  const resolved = resolveEnvPlaceholders(env);
  assert.equal(resolved.TOKEN, '${_NF_MISSING_VAR}');
});

// ---------------------------------------------------------------------------
// findPlaintextSecrets
// ---------------------------------------------------------------------------

test('findPlaintextSecrets: finds plaintext secret values', () => {
  const env = {
    ANTHROPIC_API_KEY: 'sk-ant-12345',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    ANTHROPIC_AUTH_TOKEN: 'tok-secret',
  };
  const found = findPlaintextSecrets(env);
  assert.equal(found.length, 2);
  assert.equal(found[0].key, 'ANTHROPIC_API_KEY');
  assert.equal(found[0].value, 'sk-ant-12345');
  assert.equal(found[1].key, 'ANTHROPIC_AUTH_TOKEN');
  assert.equal(found[1].value, 'tok-secret');
});

test('findPlaintextSecrets: skips placeholder values', () => {
  const env = {
    ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}',
    ANTHROPIC_AUTH_TOKEN: '${ANTHROPIC_AUTH_TOKEN}',
  };
  assert.equal(findPlaintextSecrets(env).length, 0);
});

test('findPlaintextSecrets: handles empty env', () => {
  assert.deepEqual(findPlaintextSecrets({}), []);
  assert.deepEqual(findPlaintextSecrets(null), []);
});

// ---------------------------------------------------------------------------
// maskSecrets
// ---------------------------------------------------------------------------

test('maskSecrets: converts plaintext secrets to placeholders', () => {
  const env = {
    ANTHROPIC_API_KEY: 'sk-ant-12345',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    ANTHROPIC_AUTH_TOKEN: 'tok-secret',
    MODEL: 'claude-opus-4-6',
  };
  const { masked, secrets } = maskSecrets(env);
  assert.equal(masked.ANTHROPIC_API_KEY, '${ANTHROPIC_API_KEY}');
  assert.equal(masked.ANTHROPIC_AUTH_TOKEN, '${ANTHROPIC_AUTH_TOKEN}');
  assert.equal(masked.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
  assert.equal(masked.MODEL, 'claude-opus-4-6');
  assert.equal(secrets.length, 2);
  assert.equal(secrets[0].key, 'ANTHROPIC_API_KEY');
  assert.equal(secrets[0].value, 'sk-ant-12345');
  assert.equal(secrets[1].key, 'ANTHROPIC_AUTH_TOKEN');
  assert.equal(secrets[1].value, 'tok-secret');
});

test('maskSecrets: no-op when all secrets already placeholders', () => {
  const env = { ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}' };
  const { masked, secrets } = maskSecrets(env);
  assert.equal(masked.ANTHROPIC_API_KEY, '${ANTHROPIC_API_KEY}');
  assert.equal(secrets.length, 0);
});

// ---------------------------------------------------------------------------
// findUnresolvedPlaceholders
// ---------------------------------------------------------------------------

test('findUnresolvedPlaceholders: finds keys with missing env vars', () => {
  const env = {
    API_KEY: '${_NF_MISSING_1}',
    BASE_URL: 'https://example.com',
    TOKEN: '${_NF_MISSING_2}',
  };
  const unresolved = findUnresolvedPlaceholders(env);
  assert.deepEqual(unresolved, ['API_KEY', 'TOKEN']);
});

test('findUnresolvedPlaceholders: empty when all resolved', () => {
  process.env._NF_TEST_RESOLVE_ALL = 'yes';
  const env = { TOKEN: '${_NF_TEST_RESOLVE_ALL}' };
  assert.deepEqual(findUnresolvedPlaceholders(env), []);
  delete process.env._NF_TEST_RESOLVE_ALL;
});

// ---------------------------------------------------------------------------
// extractPlaceholderVar
// ---------------------------------------------------------------------------

test('extractPlaceholderVar: extracts variable name from ${VAR}', () => {
  assert.equal(extractPlaceholderVar('${ANTHROPIC_API_KEY}'), 'ANTHROPIC_API_KEY');
  assert.equal(extractPlaceholderVar('${FOO_BAR}'), 'FOO_BAR');
});

test('extractPlaceholderVar: returns null for non-placeholder strings', () => {
  assert.equal(extractPlaceholderVar('plain-value'), null);
  assert.equal(extractPlaceholderVar(''), null);
  assert.equal(extractPlaceholderVar('text${VAR}text'), null);
});

test('extractPlaceholderVar: returns null for null/undefined', () => {
  assert.equal(extractPlaceholderVar(null), null);
  assert.equal(extractPlaceholderVar(undefined), null);
});

// ---------------------------------------------------------------------------
// namespacedSecretKey
// ---------------------------------------------------------------------------

test('namespacedSecretKey: combines slot and env key', () => {
  assert.equal(namespacedSecretKey('claude-z-ai', 'ANTHROPIC_AUTH_TOKEN'), 'claude-z-ai__ANTHROPIC_AUTH_TOKEN');
  assert.equal(namespacedSecretKey('claude-minimax', 'ANTHROPIC_API_KEY'), 'claude-minimax__ANTHROPIC_API_KEY');
});

// ===========================================================================
// ADVERSARIAL SECURITY PROBES — credential-leak / mis-resolution hunting.
// These are written to FAIL on a real defect.
// ===========================================================================

// --- isSecretKey / maskSecrets false-negative leak class --------------------
// SECRET_KEY_RE only matches /_(API_KEY|AUTH_TOKEN|TOKEN)$/. Any secret-bearing
// env var that does not end in one of those three suffixes is classified as
// NON-secret, so maskSecrets leaves its plaintext value in place. In the live
// flow (bin/migrate-plaintext-tokens.cjs) that plaintext value is then written
// straight back into providers.json on disk — i.e. the migration that is
// supposed to strip plaintext silently leaves it behind. LEAK.

test('SECURITY: isSecretKey classifies AWS_SECRET_ACCESS_KEY as a secret (false-negative leak)', () => {
  // AWS_SECRET_ACCESS_KEY ends in _ACCESS_KEY, not _API_KEY → regex miss.
  assert.equal(
    isSecretKey('AWS_SECRET_ACCESS_KEY'), true,
    'AWS_SECRET_ACCESS_KEY holds a credential but is not recognized as a secret key'
  );
});

test('SECURITY: maskSecrets masks every credential-bearing key shape (not just *_API_KEY/*_TOKEN)', () => {
  const env = {
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', // _ACCESS_KEY suffix → missed
    ANTHROPIC_KEY:         'sk-ant-realsecretvalue000000000000000000', // *_KEY (not *_API_KEY) → missed
    OPENAI_SECRET:         'sk-proj-anotherrealsecret00000000000000',   // *_SECRET → missed
    DB_PASSWORD:           'hunter2-super-secret-password',             // *_PASSWORD → missed
    authToken:             'camelCase-bearer-token-value',              // no underscore suffix → missed
  };
  const { masked, secrets } = maskSecrets(env);
  const leaked = Object.entries(masked).filter(([, v]) => !isPlaceholder(v)).map(([k]) => k);
  assert.deepEqual(
    leaked, [],
    'these credential-bearing keys were left as plaintext in the masked output: ' + leaked.join(', ')
  );
  assert.equal(secrets.length, 5, 'all five credential values should have been extracted to the secrets array');
});

// --- resolveSinglePlaceholder re-expansion / injection guard ----------------
// If a resolved value itself contains ${OTHER}, it must be returned LITERALLY
// (no second expansion pass) — otherwise a stored secret value could be used to
// inject a reference to a different env var. This probe documents the behavior;
// it is expected to PASS (resolveSinglePlaceholder does a single pass).

test('SECURITY: resolveSinglePlaceholder does NOT re-expand a resolved value containing ${OTHER}', () => {
  process.env._NF_SEC_OUTER = '${_NF_SEC_INNER}';
  process.env._NF_SEC_INNER = 'inner-secret-should-not-appear';
  try {
    const out = resolveSinglePlaceholder('${_NF_SEC_OUTER}');
    assert.equal(
      out, '${_NF_SEC_INNER}',
      'resolved value must be returned literally, not recursively expanded into the inner secret'
    );
    assert.notEqual(out, 'inner-secret-should-not-appear', 'inner secret must never leak via double expansion');
  } finally {
    delete process.env._NF_SEC_OUTER;
    delete process.env._NF_SEC_INNER;
  }
});

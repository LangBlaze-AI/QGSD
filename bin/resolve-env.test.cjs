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

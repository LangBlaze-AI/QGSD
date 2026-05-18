'use strict';

// Placeholder resolution for secret env values stored in providers.json.
// Secret keys (*_API_KEY, *_AUTH_TOKEN, *_TOKEN) are written as ${VAR} placeholders
// in providers.json and resolved from process.env at dispatch time. Actual values
// are stored in the secrets store (~/.claude/nf-secrets.json) via bin/secrets.cjs.

const SECRET_KEY_RE = /_(API_KEY|AUTH_TOKEN|TOKEN)$/;
const PLACEHOLDER_RE = /^\$\{([^}]+)\}$/;

function isSecretKey(key) {
  return SECRET_KEY_RE.test(key);
}

function toPlaceholder(key) {
  return '${' + key + '}';
}

function isPlaceholder(value) {
  return PLACEHOLDER_RE.test(String(value));
}

// Resolve all ${VAR} placeholders in an env object from process.env.
// Returns a new object with resolved values. Keys that can't be resolved
// are left as-is (the literal ${VAR} string) so the caller can detect and
// report them.
function resolveEnvPlaceholders(envObj) {
  const resolved = {};
  for (const [k, v] of Object.entries(envObj || {})) {
    resolved[k] = resolveSinglePlaceholder(v);
  }
  return resolved;
}

// Resolve a single value that might be a ${VAR} placeholder.
function resolveSinglePlaceholder(value) {
  const m = String(value).match(PLACEHOLDER_RE);
  if (m) {
    const envVarName = m[1];
    if (process.env[envVarName] !== undefined) {
      return process.env[envVarName];
    }
  }
  return value;
}

// Scan an env object for secret keys with plaintext (non-placeholder) values.
// Returns an array of { key, value } pairs.
function findPlaintextSecrets(envObj) {
  const found = [];
  for (const [k, v] of Object.entries(envObj || {})) {
    if (isSecretKey(k) && !isPlaceholder(v)) {
      found.push({ key: k, value: v });
    }
  }
  return found;
}

// Convert all plaintext secret values in an env object to ${VAR} placeholders.
// Returns { masked: { key: '${KEY}', ... }, secrets: [{ key, value }, ...] }
function maskSecrets(envObj) {
  const masked = { ...envObj };
  const secrets = [];
  for (const k of Object.keys(masked)) {
    if (isSecretKey(k) && !isPlaceholder(masked[k])) {
      secrets.push({ key: k, value: masked[k] });
      masked[k] = toPlaceholder(k);
    }
  }
  return { masked, secrets };
}

// Check if any ${VAR} placeholders in an env object are unresolved (not in process.env).
// Returns an array of unresolvable key names.
function findUnresolvedPlaceholders(envObj) {
  const unresolved = [];
  for (const [k, v] of Object.entries(envObj || {})) {
    const m = String(v).match(PLACEHOLDER_RE);
    if (m && process.env[m[1]] === undefined) {
      unresolved.push(k);
    }
  }
  return unresolved;
}

module.exports = {
  isSecretKey,
  toPlaceholder,
  isPlaceholder,
  resolveEnvPlaceholders,
  resolveSinglePlaceholder,
  findPlaintextSecrets,
  maskSecrets,
  findUnresolvedPlaceholders,
  SECRET_KEY_RE,
  PLACEHOLDER_RE,
};

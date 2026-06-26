'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const SERVICE = 'nforma';

const SECRETS_PATH = path.join(os.homedir(), '.claude', 'nf-secrets.json');
// Legacy index path — readIndex still checks this for backward compat migration
const LEGACY_INDEX_PATH = path.join(os.homedir(), '.claude', 'nf-key-index.json');

// Read the secrets store (plaintext JSON file)
function readStore() {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(SECRETS_PATH), { recursive: true });
  const tmpPath = SECRETS_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, SECRETS_PATH);
}

// Check if a key exists — reads local JSON store
function hasKey(key) {
  const store = readStore();
  return Object.prototype.hasOwnProperty.call(store, key) && store[key] != null;
}

async function set(_service, key, value) {
  const store = readStore();
  store[key] = value;
  writeStore(store);
}

async function get(_service, key) {
  const store = readStore();
  return store[key] || null;
}

async function del(_service, key) {
  const store = readStore();
  const existed = Object.prototype.hasOwnProperty.call(store, key);
  delete store[key];
  writeStore(store);
  return existed;
}

async function list(_service) {
  const store = readStore();
  return Object.entries(store)
    .filter(([, v]) => v != null)
    .map(([account, password]) => ({ account, password }));
}

/**
 * Reads all secrets from the local store,
 * then patches matching env keys in every mcpServers entry in ~/.claude.json.
 *
 * Algorithm:
 *   1. Load all credentials for the service (account = env var name, password = value)
 *   2. Read ~/.claude.json (parse JSON; if missing/corrupt, log warning and return)
 *   3. Iterate claudeJson.mcpServers — for each server with an `env` block,
 *      for each credential whose account name appears as a key in `env`,
 *      overwrite `env[account]` with the credential's password.
 *   4. Write the patched JSON back to ~/.claude.json with 2-space indent.
 */
async function syncToClaudeJson(_service) {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');

  const claudeJsonPath = path.join(os.homedir(), '.claude.json');

  let credentials;
  try {
    credentials = await list(_service);
  } catch (e) {
    process.stderr.write('[nf-secrets] secrets store unavailable: ' + e.message + '\n');
    return;
  }

  if (!credentials || credentials.length === 0) return;

  // Build a lookup map: { ACCOUNT_NAME: password }
  const credMap = {};
  for (const c of credentials) {
    credMap[c.account] = c.password;
  }

  let raw;
  try {
    raw = fs.readFileSync(claudeJsonPath, 'utf8');
  } catch (e) {
    process.stderr.write('[nf-secrets] ~/.claude.json not found, skipping sync\n');
    return;
  }

  let claudeJson;
  try {
    claudeJson = JSON.parse(raw);
  } catch (e) {
    process.stderr.write('[nf-secrets] ~/.claude.json is invalid JSON, skipping sync\n');
    return;
  }

  if (!claudeJson.mcpServers || typeof claudeJson.mcpServers !== 'object') return;

  // A value is "fillable" (safe to overwrite) when it's an unresolved ${VAR}
  // placeholder, empty, or absent — i.e. it's not a concrete provisioned credential.
  const isFillable = (v) => v == null || v === '' || (typeof v === 'string' && /^\$\{[^}]+\}$/.test(v));

  // Count how many mcpServers define each env key. A RAW (non-namespaced) secret may
  // overwrite a CONCRETE value only when its key is unique to one server; when ≥2
  // servers share the key NAME, overwriting a concrete value risks writing one slot's
  // credential into another (the ANTHROPIC_AUTH_TOKEN cross-slot leak). For shared
  // keys, a raw secret only fills placeholders — use a namespaced `<slot>__<KEY>`
  // secret to set a per-slot value.
  const keyServerCount = {};
  for (const s of Object.values(claudeJson.mcpServers)) {
    if (s && s.env && typeof s.env === 'object') {
      for (const k of Object.keys(s.env)) keyServerCount[k] = (keyServerCount[k] || 0) + 1;
    }
  }

  let patched = 0;
  for (const serverName of Object.keys(claudeJson.mcpServers)) {
    const server = claudeJson.mcpServers[serverName];
    // Guard `server` itself: a null/non-object mcpServers entry in a hand-edited or
    // malformed ~/.claude.json would otherwise throw on `server.env` and crash the sync.
    if (!server || typeof server !== 'object' || !server.env || typeof server.env !== 'object') continue;
    for (const envKey of Object.keys(server.env)) {
      // Namespaced secret (`<slot>__<KEY>`) is unambiguous → always apply (mirrors
      // call-quorum-slot / unified-mcp-server, and lets namespaced secrets actually
      // sync — the old raw-only match never fired for them → stale ${PLACEHOLDER}).
      const namespaced = credMap[serverName + '__' + envKey];
      let value;
      if (namespaced !== undefined) {
        value = namespaced;
      } else if (credMap[envKey] !== undefined &&
                 (keyServerCount[envKey] === 1 || isFillable(server.env[envKey]))) {
        value = credMap[envKey];
      }
      // Only write (and count) when the value actually changes — keeps sync
      // idempotent so an unchanged ~/.claude.json isn't rewritten on every session
      // start (avoids needless mtime churn / file-watcher wakeups / concurrent-sync races).
      if (value !== undefined && server.env[envKey] !== value) {
        server.env[envKey] = value;
        patched++;
      }
    }
  }

  if (patched > 0) {
    const tmpPath = claudeJsonPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(claudeJson, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, claudeJsonPath);
  }
}

// Maps env var names to CCR provider names (used by patchCcrConfigForKey).
const CCR_KEY_MAP = {
  FIREWORKS_API_KEY: 'fireworks',
  AKASHML_API_KEY:   'akashml',
  TOGETHER_API_KEY:  'together',
};

/**
 * Synchronously patch a single env key across all mcpServers in ~/.claude.json.
 * Uses atomic write (write to .tmp then rename) to avoid partial files on crash.
 * No-op if claude.json is missing or the key is not found in any env block.
 */
function patchClaudeJsonForKey(envKey, value) {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  const tmpPath = claudeJsonPath + '.tmp';

  let raw;
  try { raw = fs.readFileSync(claudeJsonPath, 'utf8'); } catch (_) { return; }

  let claudeJson;
  try { claudeJson = JSON.parse(raw); } catch (_) { return; }

  if (!claudeJson.mcpServers || typeof claudeJson.mcpServers !== 'object') return;

  let patched = 0;
  for (const serverName of Object.keys(claudeJson.mcpServers)) {
    const server = claudeJson.mcpServers[serverName];
    // Guard `server` itself: a null/non-object mcpServers entry in a hand-edited or
    // malformed ~/.claude.json would otherwise throw on `server.env` and crash the sync.
    if (!server || typeof server !== 'object' || !server.env || typeof server.env !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(server.env, envKey)) {
      server.env[envKey] = value;
      patched++;
    }
  }

  if (patched > 0) {
    fs.writeFileSync(tmpPath, JSON.stringify(claudeJson, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, claudeJsonPath);
  }
}

/**
 * Synchronously patch a provider's api_key in ~/.claude-code-router/config.json.
 * Uses CCR_KEY_MAP to resolve envKey → provider name, then patches all matching
 * providers (case-insensitive name match). No-op if key is unknown or file missing.
 */
function patchCcrConfigForKey(envKey, value) {
  const providerName = CCR_KEY_MAP[envKey];
  if (!providerName) return;

  const configPath = path.join(os.homedir(), '.claude-code-router', 'config.json');

  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch (_) { return; }

  let config;
  try { config = JSON.parse(raw); } catch (_) { return; }

  if (!Array.isArray(config.providers)) return;

  let patched = 0;
  for (const provider of config.providers) {
    if (provider.name && provider.name.toLowerCase() === providerName.toLowerCase()) {
      provider.api_key = value;
      patched++;
    }
  }

  if (patched > 0) {
    const tmpPath = configPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, configPath);
  }
}

module.exports = { set, get, delete: del, list, hasKey, syncToClaudeJson, patchClaudeJsonForKey, patchCcrConfigForKey, CCR_KEY_MAP, SERVICE };

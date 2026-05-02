'use strict';

/**
 * Pure functions and shared helpers for manage-agents CLI and blessed TUI.
 * No interactive dependencies (inquirer, blessed). This module provides:
 * - File I/O helpers: readClaudeJson, writeClaudeJson, readProvidersJson, writeProvidersJson
 * - Configuration parsing: readNfJson, readCcrConfigSafe, getGlobalMcpServers
 * - Provider management: fetchProviderModels, probeProviderUrl, probeAllSlots, liveDashboard
 * - Pure transformation functions exported in _pure namespace
 *
 * Consumers: bin/agents.cjs (blessed TUI)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { spawnSync } = require('child_process');
const { resolveCli } = require('./resolve-cli.cjs');
const { updateAgents, getUpdateStatuses } = require('./update-agents.cjs');

// File paths
const CLAUDE_JSON_PATH = path.join(os.homedir(), '.claude.json');
const CLAUDE_JSON_TMP = CLAUDE_JSON_PATH + '.tmp';
const NF_JSON_PATH = path.join(os.homedir(), '.claude', 'nf.json');
const CCR_CONFIG_PATH = path.join(os.homedir(), '.claude-code-router', 'config.json');
const UPDATE_LOG_PATH = path.join(os.homedir(), '.claude', 'nf-update.log');
const PROVIDERS_JSON_PATH = path.join(__dirname, 'providers.json');
const PROVIDERS_JSON_TMP = PROVIDERS_JSON_PATH + '.tmp';

// Provider preset library — hardcoded table (user-extensible presets deferred to v0.11+)
// Source: MEMORY.md Provider Map (2026-02-22)
const PROVIDER_PRESETS = [
  { name: 'AkashML',       value: 'https://api.akashml.com/v1',             label: 'AkashML       (api.akashml.com/v1)' },
  { name: 'Together.xyz',  value: 'https://api.together.xyz/v1',            label: 'Together.xyz  (api.together.xyz/v1)' },
  { name: 'Fireworks.ai',  value: 'https://api.fireworks.ai/inference/v1',  label: 'Fireworks.ai  (api.fireworks.ai/inference/v1)' },
];

const CCR_KEY_NAMES = [
  { key: 'AKASHML_API_KEY',   label: 'AkashML API Key'     },
  { key: 'TOGETHER_API_KEY',  label: 'Together.xyz API Key' },
  { key: 'FIREWORKS_API_KEY', label: 'Fireworks API Key'    },
];

const POLICY_MENU_CHOICES = [
  { name: 'auto   — check for updates on startup', value: 'auto' },
  { name: 'prompt — ask before updating',          value: 'prompt' },
  { name: 'skip   — never check for updates',      value: 'skip' },
];

const UPDATE_LOG_DEFAULT_MAX_AGE_MS = 86400000; // 24 hours

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

function readClaudeJson() {
  if (!fs.existsSync(CLAUDE_JSON_PATH)) {
    throw new Error(`~/.claude.json not found at ${CLAUDE_JSON_PATH}`);
  }
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`~/.claude.json: ${err.message}`);
  }
}

function writeClaudeJson(data) {
  fs.writeFileSync(CLAUDE_JSON_TMP, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(CLAUDE_JSON_TMP, CLAUDE_JSON_PATH);
}

function getGlobalMcpServers(data) {
  return data.mcpServers || {};
}

// Fetch model list from a provider's /models endpoint (5s timeout, fail-silent)
function fetchProviderModels(baseUrl, apiKey) {
  return new Promise((resolve) => {
    if (!baseUrl) return resolve(null);
    let url;
    try {
      const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
      url = new URL(base + '/models');
    } catch {
      return resolve(null);
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          'Authorization': apiKey ? `Bearer ${apiKey}` : '',
          'Accept': 'application/json',
        },
        timeout: 5000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const list = (parsed.data || parsed.models || [])
              .map((m) => (typeof m === 'string' ? m : m.id))
              .filter(Boolean)
              .sort();
            resolve(list.length ? list : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Probe a provider URL — returns { healthy, latencyMs, statusCode, error }
// Counts HTTP 200/401/403/404/422 as healthy (provider is reachable).
function probeProviderUrl(baseUrl, apiKey) {
  return new Promise((resolve) => {
    if (!baseUrl) return resolve({ healthy: false, latencyMs: 0, statusCode: null, error: 'No URL provided' });
    let url;
    try {
      const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
      url = new URL(base + '/models');
    } catch {
      return resolve({ healthy: false, latencyMs: 0, statusCode: null, error: `Invalid URL: ${baseUrl}` });
    }
    const lib = url.protocol === 'https:' ? https : http;
    const start = Date.now();
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          'Authorization': apiKey ? `Bearer ${apiKey}` : '',
          'Accept': 'application/json',
          'User-Agent': 'nf-manage-agents/1.0',
        },
        timeout: 7000,
      },
      (res) => {
        const latencyMs = Date.now() - start;
        res.resume();
        res.on('end', () => {
          const healthy = [200, 401, 403, 404, 422].includes(res.statusCode);
          resolve({ healthy, latencyMs, statusCode: res.statusCode, error: null });
        });
      }
    );
    req.on('error', (e) => {
      resolve({ healthy: false, latencyMs: Date.now() - start, statusCode: null, error: e.message });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ healthy: false, latencyMs: Date.now() - start, statusCode: null, error: 'Timed out after 7000ms' });
    });
    req.end();
  });
}

/**
 * Classify a probeProviderUrl() result into a key validity verdict.
 * probeResult: { healthy: bool, latencyMs: int, statusCode: int|null, error: string|null }
 * Returns: 'ok' | 'invalid' | 'unreachable'
 */
function classifyProbeResult(probeResult) {
  if (!probeResult || !probeResult.healthy) {
    return 'unreachable';
  }
  if (probeResult.statusCode === 401) {
    return 'invalid';
  }
  return 'ok';
}

/**
 * Write key validity status to nf.json under agent_config[slotName].key_status.
 */
function writeKeyStatus(slotName, status, filePath) {
  const nfCfg = readNfJson(filePath);
  if (!nfCfg.agent_config) nfCfg.agent_config = {};
  if (!nfCfg.agent_config[slotName]) nfCfg.agent_config[slotName] = {};
  nfCfg.agent_config[slotName].key_status = {
    status,
    checkedAt: new Date().toISOString(),
  };
  writeNfJson(nfCfg, filePath);
}

/**
 * Format a Date.now() timestamp as HH:MM:SS.
 * Returns '—' if ts is null/undefined/falsy.
 * Pure function — no side effects.
 */
function formatTimestamp(ts) {
  if (!ts) return '\u2014';
  return new Date(ts).toTimeString().slice(0, 8);
}

/**
 * Build the full dashboard display as an array of strings.
 * Pure function — no process.stdout.write, no side effects.
 */
function buildDashboardLines(slots, mcpServers, healthMap, lastUpdated) {
  const providerIdx = getProviderIndex();
  const lines = [];
  lines.push('  nForma Live Health Dashboard');
  lines.push('  ' + '\u2500'.repeat(60));
  lines.push('');

  for (const slotName of slots) {
    const cfg = mcpServers[slotName] || {};
    const env = cfg.env || {};
    const providerMeta = providerIdx.get(slotName);

    // Resolve display model: env override → providers.json → fallback
    const model = env.CLAUDE_DEFAULT_MODEL
      || (providerMeta && providerMeta.model)
      || '\u2014';

    // Resolve display provider: env URL → providers.json display_provider → command fallback
    let provider;
    if (env.ANTHROPIC_BASE_URL) {
      provider = env.ANTHROPIC_BASE_URL
        .replace(/^https?:\/\//, '')
        .replace(/\/v\d+\/?$/, '')
        .replace(/\/.*$/, '');
    } else if (providerMeta && providerMeta.display_provider) {
      provider = providerMeta.display_provider;
    } else {
      provider = cfg.command || '\u2014';
    }

    const probe = healthMap[slotName];
    let status;
    if (!probe) {
      status = '\x1b[90m\u2014\x1b[0m';
    } else if (probe.error === 'subprocess') {
      status = '\x1b[90msubprocess\x1b[0m';
    } else if (probe.healthy) {
      status = '\x1b[32m\u2713 UP (' + probe.latencyMs + 'ms)\x1b[0m';
    } else {
      status = '\x1b[31m\u2717 DOWN\x1b[0m';
    }
    lines.push(
      '  ' +
      slotName.padEnd(14) + ' ' +
      provider.slice(0, 24).padEnd(24) + ' ' +
      model.slice(0, 30).padEnd(30) + ' ' +
      status
    );
  }

  lines.push('');

  const stale = lastUpdated && Date.now() - lastUpdated > 60_000;
  const ts = formatTimestamp(lastUpdated);
  lines.push(
    '  Last updated: ' + ts +
    (stale ? '  \x1b[33m[stale]\x1b[0m' : '')
  );
  lines.push('  [space/r] refresh   [q/Esc] exit');
  return lines;
}

// Return a likely upgrade model ID, or null if current is already latest
function detectUpgrade(current, available) {
  if (!current || !available) return null;
  // Match: optional-namespace/Name-VX.Y  or  Name-VX-Y
  const vRe = /^(.*?)[-./]?v?(\d+(?:[._]\d+)?)$/i;
  const cm = current.match(vRe);
  if (!cm) return null;
  const [, cBase, cVer] = cm;
  const cV = parseFloat(cVer.replace('_', '.'));
  let best = null;
  let bestV = cV;
  const prefixLen = Math.max(4, Math.floor(cBase.length * 0.6));
  for (const m of available) {
    const mm = m.match(vRe);
    if (!mm) continue;
    const [, mBase, mVer] = mm;
    if (!mBase.toLowerCase().startsWith(cBase.toLowerCase().slice(0, prefixLen))) continue;
    const mV = parseFloat(mVer.replace('_', '.'));
    if (mV > bestV) { bestV = mV; best = m; }
  }
  return best;
}

// Masked API key for display
function maskKey(key) {
  if (!key) return '(not set)';
  if (key.length <= 12) return '***';
  return key.slice(0, 8) + '...' + key.slice(-4);
}

// Short provider hostname for display
function shortProvider(cfg) {
  if (cfg.env && cfg.env.ANTHROPIC_BASE_URL) {
    return cfg.env.ANTHROPIC_BASE_URL
      .replace(/^https?:\/\//, '')
      .replace(/\/v\d+\/?$/, '')
      .replace(/\/.*$/, '');
  }
  if (cfg.command === 'npx') return 'npx';
  return cfg.command || '—';
}

// ---------------------------------------------------------------------------
// Providers JSON helpers
// ---------------------------------------------------------------------------

function readProvidersJson() {
  if (!fs.existsSync(PROVIDERS_JSON_PATH)) {
    return { providers: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(PROVIDERS_JSON_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`providers.json: ${err.message}`);
  }
}

function writeProvidersJson(data) {
  fs.writeFileSync(PROVIDERS_JSON_TMP, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(PROVIDERS_JSON_TMP, PROVIDERS_JSON_PATH);
}

/**
 * detectInstalledProviders(providers) — filter providers to those whose CLI binary is present.
 *
 * Rules:
 * - HTTP-only slots (no `cli` field OR type === 'http') are always included.
 * - For subprocess/ccr slots, use the already-resolved `resolvedCli` field if present,
 *   otherwise fall back to `cli`. This function MUST be called after the resolveCli() loop
 *   in unified-mcp-server.mjs so that resolvedCli is populated before probing.
 *   If resolvedCli is absent (e.g. called out-of-order or in isolation), the raw `cli`
 *   field is used as a best-effort fallback. Test with fs.accessSync(path, fs.constants.X_OK).
 * - De-duplicate probes: slots sharing the same binary path (e.g. multiple ccr-* slots
 *   added by /nf:mcp-setup that all point at /opt/homebrew/bin/ccr) check the filesystem
 *   only once per unique path.
 * - Fail-open: any unexpected error returns the full providers list unchanged.
 *
 * @param {Array} providers - array of provider objects from providers.json
 * @returns {Array} filtered array containing only providers with installed CLIs
 */
function detectInstalledProviders(providers) {
  if (!Array.isArray(providers)) return providers || [];
  try {
    const checked = new Map(); // binaryPath -> boolean (installed)
    return providers.filter(p => {
      // HTTP-only slots have no CLI to probe — always include
      if (!p.cli || p.type === 'http') return true;
      // Use resolvedCli (set by resolveCli() loop) if available; fall back to raw cli field
      const binaryPath = p.resolvedCli || p.cli;
      if (checked.has(binaryPath)) return checked.get(binaryPath);
      let installed = false;
      try {
        fs.accessSync(binaryPath, fs.constants.X_OK);
        installed = true;
      } catch (_) {
        // binary not found or not executable — slot excluded
      }
      checked.set(binaryPath, installed);
      if (!installed) {
        // stderr: per-slot exclusion diagnostic (type included to disambiguate shared-name slots)
        process.stderr.write(`[manage-agents-core] detectInstalledProviders: ${p.name} (type=${p.type || 'subprocess'}) excluded — CLI not found: ${binaryPath}\n`);
      }
      return installed;
    });
  } catch (err) {
    // Fail-open: unexpected error — return full list unchanged
    process.stderr.write(`[manage-agents-core] detectInstalledProviders: unexpected error, using full list: ${err.message}\n`);
    return providers;
  }
}

// ---------------------------------------------------------------------------
// nForma JSON helpers
// ---------------------------------------------------------------------------

function readNfJson(filePath) {
  const p = filePath || NF_JSON_PATH;
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeNfJson(data, filePath) {
  const p = filePath || NF_JSON_PATH;
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function writeUpdatePolicy(slotName, policy, filePath) {
  const nfCfg = readNfJson(filePath);
  if (!nf.agent_config) nf.agent_config = {};
  if (!nf.agent_config[slotName]) nf.agent_config[slotName] = {};
  nf.agent_config[slotName].update_policy = policy;
  writeNfJson(nfCfg, filePath);
}

// ---------------------------------------------------------------------------
// Pure transformation functions
// ---------------------------------------------------------------------------

function deriveSecretAccount(slotName) {
  return 'ANTHROPIC_API_KEY_' + slotName.toUpperCase().replace(/-/g, '_');
}

function buildKeyStatus(authType, slotName, secretsLib) {
  if (authType === 'sub') return '\x1b[36m[sub]\x1b[0m';
  const account = deriveSecretAccount(slotName);
  if (secretsLib && secretsLib.hasKey(account)) return '\x1b[32m[key \u2713]\x1b[0m';
  return '\x1b[90m[no key]\x1b[0m';
}

function buildAgentChoiceLabel(name, cfg, providerMap, agentCfg, secretsLib) {
  cfg = cfg || {};
  const env = cfg.env || {};
  providerMap = providerMap || {};
  agentCfg = agentCfg || {};

  const slot = env.PROVIDER_SLOT;
  const p = slot ? providerMap[slot] : null;
  let model;
  if (p) {
    model = p.model || p.mainTool || '\u2014';
  } else {
    model = env.CLAUDE_DEFAULT_MODEL || cfg.command || '?';
  }

  const authType = agentCfg[name] && agentCfg[name].auth_type;
  const keyStatus = buildKeyStatus(authType, name, secretsLib);

  return `${name.padEnd(14)} ${model.slice(0, 36).padEnd(36)} ${keyStatus}`;
}

function applyKeyUpdate(updates, secretAccount, newEnv, secretsLib) {
  if (!('apiKey' in updates)) return newEnv;
  if (updates.apiKey === '__REMOVE__') {
    delete newEnv.ANTHROPIC_API_KEY;
    if (secretsLib) secretsLib.delete('nforma', secretAccount);
  } else {
    delete newEnv.ANTHROPIC_API_KEY;
    if (secretsLib) {
      secretsLib.set('nforma', secretAccount, updates.apiKey);
    } else {
      newEnv.ANTHROPIC_API_KEY = updates.apiKey;
    }
  }
  return newEnv;
}

async function applyCcrProviderUpdate(subAction, selectedKey, keyValue, secretsLib) {
  if (subAction === 'set') {
    await secretsLib.set('nforma', selectedKey, keyValue);
    return { action: 'set', key: selectedKey };
  }
  if (subAction === 'remove') {
    await secretsLib.delete('nforma', selectedKey);
    return { action: 'remove', key: selectedKey };
  }
  return null;
}

function slotToFamily(slotName) {
  return slotName.replace(/-\d+$/, '');
}

function getWlDisplay(family, scoreboardData) {
  if (!scoreboardData) return '\u2014';
  const entry = scoreboardData.models && scoreboardData.models[family];
  if (!entry) return '\u2014';
  return String(entry.tp || 0) + 'W/' + String(entry.fn || 0) + 'L';
}

function readCcrConfigSafe(ccrConfigPath) {
  const p = ccrConfigPath || CCR_CONFIG_PATH;
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function getCcrProviderForSlot(model, ccrConfig) {
  if (!ccrConfig || !model) return null;
  for (const provider of (ccrConfig.providers || [])) {
    if ((provider.models || []).includes(model)) {
      return provider.name;
    }
  }
  return null;
}

function getKeyInvalidBadge(slotName, agentConfig, hasKeyFn) {
  const slotCfg = agentConfig && agentConfig[slotName];
  if (!slotCfg) return '';
  const ks = slotCfg.key_status;
  if (!ks || ks.status !== 'invalid') return '';
  if (!hasKeyFn || !hasKeyFn(slotName)) return '';
  return ' [key invalid]';
}

function findPresetForUrl(url) {
  if (!url) return '__custom__';
  const found = PROVIDER_PRESETS.find((p) => p.value === url);
  return found ? found.value : '__custom__';
}

function buildCloneEntry(sourceCfg, newName) {
  const sourceEnv = (sourceCfg && sourceCfg.env) || {};
  const newEnv = {};
  if (sourceEnv.ANTHROPIC_BASE_URL)    newEnv.ANTHROPIC_BASE_URL    = sourceEnv.ANTHROPIC_BASE_URL;
  if (sourceEnv.CLAUDE_DEFAULT_MODEL)  newEnv.CLAUDE_DEFAULT_MODEL  = sourceEnv.CLAUDE_DEFAULT_MODEL;
  if (sourceEnv.CLAUDE_MCP_TIMEOUT_MS) newEnv.CLAUDE_MCP_TIMEOUT_MS = sourceEnv.CLAUDE_MCP_TIMEOUT_MS;
  newEnv.PROVIDER_SLOT = newName;
  return {
    type: (sourceCfg && sourceCfg.type) || 'stdio',
    command: (sourceCfg && sourceCfg.command) || 'node',
    args: (sourceCfg && sourceCfg.args) ? [...sourceCfg.args] : [],
    env: newEnv,
  };
}

function buildTimeoutChoices(slots, mcpServers, providersData) {
  const providers = (providersData && providersData.providers) || [];
  return slots.map((slotName) => {
    const cfg = mcpServers[slotName] || {};
    const providerSlot = (cfg.env && cfg.env.PROVIDER_SLOT) || slotName;
    const provider = providers.find((p) => p.name === providerSlot) || null;
    const currentMs = provider
      ? (provider.quorum_timeout_ms != null ? provider.quorum_timeout_ms
         : provider.timeout_ms != null ? provider.timeout_ms
         : null)
      : null;
    return { slotName, providerSlot, currentMs };
  });
}

function applyTimeoutUpdate(providersData, providerSlot, newTimeoutMs) {
  const providers = (providersData.providers || []).map((p) =>
    p.name === providerSlot ? { ...p, quorum_timeout_ms: newTimeoutMs } : { ...p }
  );
  return { ...providersData, providers };
}

function buildPolicyChoices(currentPolicy) {
  return POLICY_MENU_CHOICES.map((c) => ({
    ...c,
    name: c.value === currentPolicy
      ? c.name + '  \x1b[90m\u2190 current\x1b[0m'
      : c.name,
  }));
}

function validateTimeout(value) {
  // Blank/empty/null/undefined means "keep current" — valid state, return ms: null
  if (value === '' || value === null || value === undefined) {
    return { valid: true, ms: null };
  }

  const parsed = parseInt(value, 10);

  // Check if parsing failed (NaN) or result is non-positive
  if (isNaN(parsed) || parsed <= 0) {
    return { valid: false, error: `Timeout must be a positive number (got: ${value})` };
  }

  return { valid: true, ms: parsed };
}

function validateUpdatePolicy(policy) {
  // Valid policies derived from POLICY_MENU_CHOICES
  const validPolicies = POLICY_MENU_CHOICES.map((c) => c.value);

  if (validPolicies.includes(policy)) {
    return { valid: true, policy };
  }

  return {
    valid: false,
    error: `Unknown update policy '${policy}'. Valid values: ${validPolicies.join(', ')}`
  };
}

function buildUpdateLogEntry(slotName, status, detail) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    slot: slotName,
    status,
    detail: detail != null ? detail : null,
  }) + '\n';
}

function parseUpdateLogErrors(logContent, maxAgeMs) {
  if (!logContent) return [];
  const cutoff = Date.now() - (maxAgeMs != null ? maxAgeMs : UPDATE_LOG_DEFAULT_MAX_AGE_MS);
  return logContent
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .filter((e) => e.status === 'ERROR' && new Date(e.ts).getTime() > cutoff);
}

function buildBackupPath(claudeJsonPath, isoTimestamp) {
  return claudeJsonPath + '.pre-import.' + isoTimestamp;
}

function buildRedactedEnv(env) {
  if (!env || typeof env !== 'object') return {};
  const SENSITIVE_RE = /(_KEY|_SECRET|_TOKEN|_PASSWORD)$/i;
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => [k, SENSITIVE_RE.test(k) ? '__redacted__' : v])
  );
}

function buildExportData(claudeJsonData) {
  const out = JSON.parse(JSON.stringify(claudeJsonData));
  const servers = out.mcpServers || {};
  for (const cfg of Object.values(servers)) {
    if (cfg.env) cfg.env = buildRedactedEnv(cfg.env);
  }
  return out;
}

function validateImportSchema(parsed) {
  const errors = [];
  const ALLOWED_COMMANDS = ['node', 'npx'];
  const HOME_PATH_RE = /^\/(Users|home)\//;

  if (!parsed || typeof parsed !== 'object') {
    errors.push('Root must be a JSON object');
    return errors;
  }

  const servers = parsed.mcpServers || {};
  for (const [slotName, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (cfg.command && !ALLOWED_COMMANDS.includes(cfg.command)) {
      errors.push(`${slotName}: command must be "node" or "npx", got "${cfg.command}"`);
    }
    if (Array.isArray(cfg.args)) {
      for (const arg of cfg.args) {
        if (typeof arg === 'string' && HOME_PATH_RE.test(arg)) {
          errors.push(`${slotName}: args must not contain absolute home paths (found: ${arg})`);
        }
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Async helpers: probing, health checks, updates
// ---------------------------------------------------------------------------

/**
 * Probe a single slot and persist key_status to nf.json if the provider responded.
 * Does NOT persist for timeout/network errors (statusCode is null) -- this is
 * a provider/network issue, not a key validity issue.
 * @param {string} slotName - MCP server slot name (e.g. 'claude-1')
 * @param {string} baseUrl - Provider base URL (e.g. 'https://api.akashml.com/v1')
 * @param {string} apiKey - API key for authentication
 * @returns {Promise<Object>} The raw probe result from probeProviderUrl
 */
async function probeAndPersistKey(slotName, baseUrl, apiKey) {
  const probe = await probeProviderUrl(baseUrl, apiKey);
  // Only persist status if provider actually responded (statusCode present).
  // Do NOT persist for timeout/network errors (statusCode is null) -- this is
  // a provider/network issue, not a key validity issue (see invariants.md).
  if (probe.healthy || probe.statusCode) {
    const status = classifyProbeResult(probe);
    writeKeyStatus(slotName, status);
  }
  return probe;
}

/**
 * Probe a subprocess provider by running its health_check_args (e.g., --version).
 * Mirrors the logic in unified-mcp-server.mjs runSubprocessHealthCheck().
 * @param {object} provider  Entry from providers.json
 * @returns {{ healthy: boolean, latencyMs: number, statusCode: null, error: string|null, type: string }}
 */
function probeSubprocess(provider) {
  const cliPath = provider.resolvedCli || provider.cli;
  if (!cliPath) {
    return { healthy: false, latencyMs: 0, statusCode: null, error: 'No CLI path', type: 'subprocess' };
  }
  const bareName = cliPath.split('/').pop();
  const resolved = resolveCli(bareName);
  const args = provider.health_check_args || ['--version'];
  const start = Date.now();
  try {
    const result = spawnSync(resolved, args, {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const latencyMs = Date.now() - start;
    const output = (result.stdout || '') + (result.stderr || '');
    if (result.error) {
      return { healthy: false, latencyMs, statusCode: null, error: result.error.message, type: 'subprocess' };
    }
    const healthy = result.status === 0 || (output.length > 0 && !output.startsWith('[spawn error'));
    return { healthy, latencyMs, statusCode: null, error: healthy ? null : output.slice(0, 200).trim(), type: 'subprocess' };
  } catch (err) {
    return { healthy: false, latencyMs: Date.now() - start, statusCode: null, error: err.message, type: 'subprocess' };
  }
}

// Build a name→provider lookup from providers.json (cached per call)
let _providerIndex = null;
function getProviderIndex() {
  if (_providerIndex) return _providerIndex;
  try {
    const data = readProvidersJson();
    _providerIndex = new Map((data.providers || []).map(p => [p.name, p]));
  } catch (_) {
    _providerIndex = new Map();
  }
  return _providerIndex;
}

async function probeAllSlots(mcpServers, slots, secretsLib) {
  const providerIdx = getProviderIndex();
  const results = await Promise.all(slots.map(async (slotName) => {
    const cfg = mcpServers[slotName] || {};
    const env = cfg.env || {};

    // HTTP provider path (legacy — has ANTHROPIC_BASE_URL in env)
    if (env.ANTHROPIC_BASE_URL) {
      const account = deriveSecretAccount(slotName);
      let apiKey = env.ANTHROPIC_API_KEY || '';
      if (secretsLib) {
        try {
          const k = await secretsLib.get('nforma', account);
          if (k) apiKey = k;
        } catch (_) {}
      }
      const probe = await probeAndPersistKey(slotName, env.ANTHROPIC_BASE_URL, apiKey);
      return [slotName, probe];
    }

    // Subprocess provider path — probe via CLI health_check_args
    const provider = providerIdx.get(slotName);
    if (provider && provider.cli) {
      const probe = probeSubprocess(provider);
      return [slotName, probe];
    }

    // Unknown provider type — no way to probe
    return [slotName, { healthy: null, latencyMs: 0, statusCode: null, error: 'no-probe', type: 'unknown' }];
  }));
  return Object.fromEntries(results);
}

async function runAutoUpdateCheck(getStatusesFn = getUpdateStatuses, nfJsonPath = null) {
  const check = async () => {
    let nfCfg;
    try { nfCfg = readNfJson(nfJsonPath); } catch { return; }
    const agentConfig = nfCfg.agent_config || {};
    const autoSlots = Object.keys(agentConfig).filter(
      (s) => agentConfig[s] && agentConfig[s].update_policy === 'auto'
    );
    if (!autoSlots.length) return;

    try {
      fs.mkdirSync(path.dirname(UPDATE_LOG_PATH), { recursive: true });
    } catch (_) {}

    let statuses;
    try {
      statuses = await getStatusesFn();
    } catch (err) {
      for (const slot of autoSlots) {
        fs.appendFileSync(UPDATE_LOG_PATH, buildUpdateLogEntry(slot, 'ERROR', `getUpdateStatuses failed: ${err.message}`));
      }
      return;
    }

    let providerMap = {};
    try {
      const pdata = readProvidersJson();
      for (const p of (pdata.providers || [])) providerMap[p.name] = p;
    } catch (_) {}

    for (const slot of autoSlots) {
      const p = providerMap[slot];
      const binName = p && p.cli ? path.basename(p.cli) : null;
      const statusEntry = binName ? statuses.get(binName) : undefined;
      let status, detail;
      if (!statusEntry) {
        status = 'SKIP';
        detail = binName ? 'no update info available for slot' : 'no provider record for slot';
      } else if (statusEntry.error) {
        status = 'ERROR';
        detail = statusEntry.error;
      } else if (statusEntry.status === 'update-available') {
        status = 'UPDATE_AVAILABLE';
        detail = statusEntry.latest || null;
      } else {
        status = 'OK';
        detail = statusEntry.current || null;
      }
      try {
        fs.appendFileSync(UPDATE_LOG_PATH, buildUpdateLogEntry(slot, status, detail));
      } catch (_) {}
    }
  };

  const timeout = new Promise((resolve) => setTimeout(resolve, 20000));
  try {
    await Promise.race([check(), timeout]);
  } catch (_) {}
}

async function liveDashboard() {
  const readline = require('readline');
  const data = readClaudeJson();
  const mcpServers = getGlobalMcpServers(data);
  const slots = Object.keys(mcpServers);

  let secretsLib = null;
  try { secretsLib = require('./secrets.cjs'); } catch (_) {}

  let lastProbe = null;
  let lastUpdated = null;

  const update = async () => {
    lastProbe = await probeAllSlots(mcpServers, slots, secretsLib);
    lastUpdated = Date.now();
  };

  const render = () => {
    const lines = buildDashboardLines(slots, mcpServers, lastProbe || {}, lastUpdated);
    process.stdout.write('\x1b[2J\x1b[0;0H' + lines.join('\n') + '\n');
  };

  if (!process.stdout.isTTY) {
    await update();
    render();
    return;
  }

  await update();
  render();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setRawMode(true);

  return new Promise((resolve) => {
    const onKey = async (chunk) => {
      const char = String.fromCharCode(chunk);
      if (char === 'q' || char === '\u001b') {
        rl.setRawMode(false);
        rl.close();
        process.stdout.write('\x1b[?1049l');
        resolve();
      } else if (char === ' ' || char === 'r') {
        await update();
        render();
      }
    };
    process.stdin.on('data', onKey);
    process.stdout.write('\x1b[?1049h');
  });
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = { readClaudeJson, writeClaudeJson, getGlobalMcpServers };

module.exports._pure = {
  deriveSecretAccount,
  maskKey,
  buildKeyStatus,
  buildAgentChoiceLabel,
  applyKeyUpdate,
  applyCcrProviderUpdate,
  readNfJson,
  writeNfJson,
  slotToFamily,
  getWlDisplay,
  readCcrConfigSafe,
  getCcrProviderForSlot,
  getKeyInvalidBadge,
  findPresetForUrl,
  buildCloneEntry,
  classifyProbeResult,
  writeKeyStatus,
  formatTimestamp,
  buildDashboardLines,
  buildTimeoutChoices,
  applyTimeoutUpdate,
  buildPolicyChoices,
  validateTimeout,
  validateUpdatePolicy,
  buildUpdateLogEntry,
  parseUpdateLogErrors,
  probeAndPersistKey,
  probeAllSlots,
  liveDashboard,
  runAutoUpdateCheck,
  buildBackupPath,
  buildRedactedEnv,
  buildExportData,
  validateImportSchema,
  readProvidersJson,
  writeProvidersJson,
  writeUpdatePolicy,
  detectUpgrade,
  shortProvider,
  fetchProviderModels,
  probeProviderUrl,
  detectInstalledProviders,
};

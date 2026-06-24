#!/usr/bin/env node
// unified-mcp-server.mjs — config-driven MCP stdio server
// Implements raw JSON-RPC stdio (no SDK dependency)
// Wraps multiple CLI providers as MCP tools, driven by providers.json
//
// Modes:
//   default         — exposes all providers as slot-named tools (unified-1 usage)
//   PROVIDER_SLOT=X — exposes only provider X with its original tool names

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { createRequire } from 'module';
import fs from 'fs';
import https from 'https';
import http from 'http';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { resolveCli, resolveSpawnTarget: sharedResolveSpawnTarget } = require('./resolve-cli.cjs');
const { resolveProvidersConfig } = require('./resolve-providers.cjs');
const { _pure: { detectInstalledProviders } } = require('./manage-agents-core.cjs');
const { resolveEnvPlaceholders, findUnresolvedPlaceholders } = require('./resolve-env.cjs');
const { extractPlaceholderVar, namespacedSecretKey } = require('./resolve-env.cjs');

// ─── Load providers config ─────────────────────────────────────────────────────
// Single source of truth (issue #197): resolve-providers.cjs. Order = UNIFIED_PROVIDERS_CONFIG
// env → ~/.claude.json pointer → __dirname (non-empty) → ~/.claude/nf-bin/providers.json
// (`'.claude', 'nf-bin', 'providers.json'`) → legacy ~/.claude/nf/bin (non-empty).
// The shipped repo source is empty by design (populated at install time); the resolver
// skips it so Claude Code MCP entries lacking UNIFIED_PROVIDERS_CONFIG still find the
// installed copy instead of exiting with "Unknown PROVIDER_SLOT" on session start.
function loadProvidersConfig() {
  const resolved = resolveProvidersConfig({ baseDir: __dirname });
  if (resolved) return resolved;
  // Last resort: empty so the warning path triggers below (server starts with zero tools).
  return { path: join(__dirname, 'providers.json'), data: { providers: [] } };
}

let configPath, providers;
try {
  const loaded = loadProvidersConfig();
  configPath = loaded.path;
  providers = loaded.data.providers;
} catch (e) {
  process.stderr.write(`[unified-mcp-server] Failed to load config: ${e.message}\n`);
  process.exit(1);
}

// Guard: handle empty providers array gracefully
if (!Array.isArray(providers) || providers.length === 0) {
  process.stderr.write(`[unified-mcp-server] WARNING: No providers configured in ${configPath} — server will start with zero tools\n`);
  providers = providers || [];
}

// Resolve CLI paths at startup (XPLAT-01: cross-platform path discovery)
for (const provider of providers) {
  if (provider.type === 'subprocess') {
    // `cli` is optional in providers.json — when absent, fall back to `mainTool`
    // as the bare binary name. Without this fallback, `provider.resolvedCli`
    // stays unset and the spawn at runtime hands `null` to child_process.spawn,
    // failing with ENOENT/EINVAL and reporting healthy:false at ~1ms latency.
    const cliSource = provider.cli || provider.mainTool;
    if (!cliSource) continue;
    const bareName = cliSource.split('/').pop();
    provider.resolvedCli = resolveCli(bareName);
    if (cliSource !== provider.resolvedCli) {
      process.stderr.write(`[mcp] Resolved ${bareName}: ${cliSource} -> ${provider.resolvedCli}\n`);
    }
    // Also resolve service commands if present (e.g., ccr start/stop/status)
    if (provider.service) {
      for (const key of ['start', 'stop', 'status']) {
        if (provider.service[key] && provider.service[key][0]) {
          const svcBareName = provider.service[key][0];
          const resolvedSvc = resolveCli(svcBareName);
          if (resolvedSvc !== svcBareName) {
            provider.service[key][0] = resolvedSvc;
          }
        }
      }
    }
  }
}

// ─── Filter to installed CLIs only (DYNAMIC-SLOTS-01) ──────────────────────────
// resolvedCli was set in the loop above; detectInstalledProviders uses it for probing.
// Calling detectInstalledProviders AFTER this loop is required — if called before,
// resolvedCli will be absent and the function falls back to the raw cli field.
// HTTP-only slots are always included regardless of CLI detection.
providers = detectInstalledProviders(providers);
if (providers.length === 0) {
  // WARNING severity: zero tools means the server starts but can dispatch nothing.
  // This is a stronger signal than per-slot exclusion and should be visible in logs.
  process.stderr.write('[unified-mcp-server] WARNING: No installed providers found after CLI detection — server will start with zero tools\n');
}

// ─── PROVIDER_SLOT mode detection ─────────────────────────────────────────────
const SLOT = process.env.PROVIDER_SLOT ?? null;
const slotProvider = SLOT ? providers.find(p => p.name === SLOT) : null;

if (SLOT && !slotProvider) {
  process.stderr.write(`[unified-mcp-server] Unknown PROVIDER_SLOT: ${SLOT}\n`);
  process.exit(1);
}

// ─── MCP response helpers ──────────────────────────────────────────────────────
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// ─── Tool definitions ──────────────────────────────────────────────────────────

/** All-providers mode: one tool per provider using provider name as tool name */
function buildAllProviderTools() {
  return providers.map(p => ({
    name: p.name,
    description: p.description,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The prompt or task to send to the provider CLI',
        },
        timeout_ms: {
          type: 'number',
          description: `Timeout in milliseconds (default: ${p.timeout_ms ?? 300000})`,
        },
      },
      required: ['prompt'],
    },
  }));
}

const PROMPT_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'The prompt or task to send' },
    timeout_ms: { type: 'number', description: 'Timeout in milliseconds' },
  },
  required: ['prompt'],
};

const NO_ARGS_SCHEMA = { type: 'object', properties: {}, required: [] };

/** PROVIDER_SLOT mode: expose original tool names for the given provider */
function buildSlotTools(provider) {
  const tools = [];

  // Universal: ping
  tools.push({
    name: 'ping',
    description: 'Test connectivity by echoing a message back.',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string', default: '', description: 'Message to echo' } },
      required: [],
    },
  });

  // Universal: identity
  tools.push({
    name: 'identity',
    description: 'Get server identity: name, version, active LLM model, and MCP server name. Used by nForma to fingerprint the active quorum team.',
    inputSchema: NO_ARGS_SCHEMA,
  });

  if (provider.type === 'subprocess') {
    // Main tool
    tools.push({
      name: provider.mainTool,
      description: provider.description,
      inputSchema: PROMPT_SCHEMA,
    });

    // Help tool
    tools.push({
      name: 'help',
      description: `Display ${provider.mainTool} CLI help and available options.`,
      inputSchema: NO_ARGS_SCHEMA,
    });

    // Extra tools
    for (const extra of provider.extraTools ?? []) {
      tools.push({
        name: extra.name,
        description: extra.description,
        inputSchema: extra.checkUpdate ? NO_ARGS_SCHEMA : PROMPT_SCHEMA,
      });
    }

    // health_check tool for subprocess providers — always registered;
    // execution defaults to ['--version'] when health_check_args is missing
    tools.push({
      name: 'health_check',
      description: 'Test CLI availability by running a lightweight command (e.g. --version). Returns { healthy, latencyMs, type: "subprocess" }.',
      inputSchema: NO_ARGS_SCHEMA,
    });

    // deep_health_check tool for subprocess providers
    tools.push({
      name: 'deep_health_check',
      description: 'Deep inference probe: sends a trivial prompt through the full CLI pipeline and classifies the result. Returns { healthy, latencyMs, layer, error } where layer is BINARY_MISSING | SERVICE_DOWN | AUTH_EXPIRED | QUOTA_EXCEEDED | INFERENCE_TIMEOUT | INFERENCE_OK.',
      inputSchema: NO_ARGS_SCHEMA,
    });
  } else if (provider.type === 'ccr') {
    // CCR (Claude Code Router) — proxy binary, exposes same interface as subprocess
    tools.push({
      name: 'ask',
      description: provider.description,
      inputSchema: PROMPT_SCHEMA,
    });
    tools.push({
      name: 'help',
      description: 'Display CCR CLI help and available options.',
      inputSchema: NO_ARGS_SCHEMA,
    });
    // Always registered; execution defaults to ['--version'] when health_check_args is missing
    tools.push({
      name: 'health_check',
      description: 'Test CCR binary availability. Returns { healthy, latencyMs, type: "ccr" }.',
      inputSchema: NO_ARGS_SCHEMA,
    });

    // deep_health_check tool for ccr providers
    tools.push({
      name: 'deep_health_check',
      description: 'Deep inference probe: sends a trivial prompt through the full CLI pipeline and classifies the result. Returns { healthy, latencyMs, layer, error } where layer is BINARY_MISSING | SERVICE_DOWN | AUTH_EXPIRED | QUOTA_EXCEEDED | INFERENCE_TIMEOUT | INFERENCE_OK.',
      inputSchema: NO_ARGS_SCHEMA,
    });
  } else if (provider.type === 'http') {
    // claude tool
    tools.push({
      name: 'claude',
      description: 'Execute Claude Code CLI in non-interactive mode for AI assistance',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The coding task, question, or analysis request' },
          timeout_ms: { type: 'number', description: 'Timeout in milliseconds' },
        },
        required: ['prompt'],
      },
    });

    // health_check tool
    tools.push({
      name: 'health_check',
      description: 'Verify the upstream LLM endpoint is reachable by making a minimal API call. Returns { healthy, latencyMs, model } or { healthy: false, error }.',
      inputSchema: NO_ARGS_SCHEMA,
    });

    // deep_health_check tool for http providers
    tools.push({
      name: 'deep_health_check',
      description: 'Deep inference probe: sends a trivial prompt through the full CLI pipeline and classifies the result. Returns { healthy, latencyMs, layer, error } where layer is BINARY_MISSING | SERVICE_DOWN | AUTH_EXPIRED | QUOTA_EXCEEDED | INFERENCE_TIMEOUT | INFERENCE_OK.',
      inputSchema: NO_ARGS_SCHEMA,
    });
  }

  return tools;
}

function buildTools() {
  if (slotProvider) return buildSlotTools(slotProvider);
  return buildAllProviderTools();
}

// ─── Subprocess execution ──────────────────────────────────────────────────────
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB
const MAX_RESPONSE = 25 * 1024; // 25KB — MCP result size safety net

function truncateResponse(text) {
  if (text !== null && text !== undefined && typeof text !== 'string') text = JSON.stringify(text);
  if (typeof text !== 'string' || text.length <= MAX_RESPONSE) return text;
  const originalLen = text.length;
  const suffix = `\n\n[TRUNCATED by unified-mcp-server: ${originalLen} chars -> ${MAX_RESPONSE} chars]`;
  return text.slice(0, MAX_RESPONSE - suffix.length) + suffix;
}

/**
 * Resolve the executable to hand to child_process.spawn for a subprocess provider.
 *
 * Mirrors the 3-tier fallback in bin/call-quorum-slot.cjs (PR #161/#164):
 *   resolvedCli (absolute path, populated by the startup resolution loop) →
 *   cli (raw providers.json field) → mainTool (bare binary name).
 *
 * The startup loop normally populates `resolvedCli`, but it only runs for
 * `type === 'subprocess'` providers and skips any with no `cli`/`mainTool`.
 * When it doesn't run, the previous `provider.resolvedCli ?? provider.cli`
 * expression could be `null` — and `providers.json` carries `cli: null` for
 * mainTool-only slots, so spawn received `null` and threw the opaque
 * `TypeError [ERR_INVALID_ARG_TYPE]: The "file" argument must be of type
 * string. Received null`, taking the whole quorum offline. Throwing a named
 * error here turns that into a diagnosable `[spawn error: ...]` instead.
 *
 * @param {object} provider
 * @returns {string} a non-empty executable name or path
 */
function resolveSpawnTarget(provider) {
  // Delegate to the shared resolver (resolve-cli.cjs) — the last divergent copy
  // of this logic (issue #197 family). The local version returned a BARE name
  // (resolvedCli || cli || mainTool); the shared one runs cli/mainTool through
  // resolveCli (absolute path / which / Homebrew / npm), so a slot whose
  // resolvedCli wasn't pre-populated at startup still resolves to a real
  // executable instead of a bare name that can fail under a GUI-launched PATH.
  // Keep the throw-on-empty contract this server's spawn sites rely on.
  const target = sharedResolveSpawnTarget(provider);
  if (!target) {
    throw new Error(`provider ${provider.name} has no resolvable CLI (cli, resolvedCli, and mainTool all empty)`);
  }
  return target;
}

async function runProvider(provider, toolArgs) {
  const prompt = toolArgs.prompt;
  const timeoutMs = toolArgs.timeout_ms ?? provider.timeout_ms ?? 300000;

  // Substitute {prompt} placeholder in args_template
  const args = provider.args_template.map(a =>
    a === '{prompt}' ? prompt : a
  );

  const env = { ...process.env, ...resolveEnvPlaceholders(provider.env ?? {}) };

  // Check for unresolved ${VAR} placeholders — these indicate missing secrets
  const unresolved = findUnresolvedPlaceholders(provider.env ?? {});
  if (unresolved.length > 0) {
    process.stderr.write(`[unified-mcp-server] WARNING: unresolved placeholder(s) in slot ${provider.name}: ${unresolved.join(', ')} — set in env or run /nf:mcp-setup to store in secrets\n`);
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(resolveSpawnTarget(provider), args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve(`[spawn error: ${err.message}]`);
      return;
    }

    child.stdin.end(); // providers are non-interactive; close stdin immediately

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        try { if (!child.killed) child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      }, 5000);
    }, timeoutMs);

    child.stdout.on('data', d => {
      if (!truncated) {
        const chunk = d.toString();
        if (stdout.length + chunk.length > MAX_BUFFER) {
          stdout += chunk.slice(0, MAX_BUFFER - stdout.length);
          truncated = true;
        } else {
          stdout += chunk;
        }
      }
    });

    child.stderr.on('data', d => {
      stderr += d.toString().slice(0, 4096); // keep stderr brief
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const output = stdout || stderr || '(no output)';
      const suffix = timedOut
        ? `\n\n[TIMED OUT after ${timeoutMs}ms]`
        : truncated ? '\n\n[OUTPUT TRUNCATED at 10MB]' : '';
      const exitNote = (code !== 0 && !timedOut) ? `\n\n[exit code ${code}]` : '';
      resolve(output + suffix + exitNote);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(`[spawn error: ${err.message}]`);
    });
  });
}

/** Run a subprocess with explicit args (used for help, extraTools) */
async function runSubprocessWithArgs(provider, args, timeoutMs = 30000) {
  const env = { ...process.env, ...resolveEnvPlaceholders(provider.env ?? {}) };

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(resolveSpawnTarget(provider), args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve(`[spawn error: ${err.message}]`);
      return;
    }

    child.stdin.end();
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString().slice(0, 4096); });

    child.on('close', () => {
      clearTimeout(timer);
      resolve(stdout || stderr || '(no output)');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(`[spawn error: ${err.message}]`);
    });
  });
}

/** Run npm view opencode version to check for updates */
async function runCheckUpdate() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('npm', ['view', 'opencode', 'version'], {
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve(`[error checking update: ${err.message}]`);
      return;
    }

    child.stdin.end();
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => { child.kill('SIGTERM'); }, 30000);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString().slice(0, 1000); });

    child.on('close', () => {
      clearTimeout(timer);
      resolve(stdout.trim() || stderr || '(no output)');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(`[error: ${err.message}]`);
    });
  });
}

// ─── HTTP provider execution ───────────────────────────────────────────────────
async function runHttpProvider(provider, toolArgs) {
  const prompt = toolArgs.prompt;
  const timeoutMs = toolArgs.timeout_ms ?? provider.timeout_ms ?? 120000;
  const apiKey = process.env[provider.apiKeyEnv] ?? '';

  const body = JSON.stringify({
    model: provider.model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  });

  const url = new URL(provider.baseUrl + '/chat/completions');
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Content-Length': Buffer.byteLength(body),
    },
  };

  return new Promise((resolve) => {
    let timedOut = false;
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (timedOut) return;
        try {
          const parsed = JSON.parse(data);
          const content = parsed?.choices?.[0]?.message?.content;
          if (content) {
            resolve(content);
          } else {
            resolve(`[HTTP error: unexpected response shape] ${data.slice(0, 500)}`);
          }
        } catch (e) {
          resolve(`[HTTP error: JSON parse failed] ${data.slice(0, 500)}`);
        }
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
      resolve(`[TIMED OUT after ${timeoutMs}ms]`);
    }, timeoutMs);

    req.on('error', (err) => {
      clearTimeout(timer);
      resolve(`[HTTP request error: ${err.message}]`);
    });

    req.on('close', () => clearTimeout(timer));

    req.write(body);
    req.end();
  });
}

/** Slot-mode HTTP execution: reads ANTHROPIC_BASE_URL/KEY/MODEL from env */
async function runSlotHttpProvider(provider, toolArgs) {
  const effectiveProvider = {
    ...provider,
    baseUrl: process.env.ANTHROPIC_BASE_URL ?? provider.baseUrl,
    model: process.env.CLAUDE_DEFAULT_MODEL ?? provider.model,
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    timeout_ms: parseInt(process.env.CLAUDE_MCP_TIMEOUT_MS ?? '0') || provider.timeout_ms,
  };
  return runHttpProvider(effectiveProvider, toolArgs);
}

/** health_check: POST minimal request, return { healthy, latencyMs, model } */
async function runHealthCheck(provider) {
  const baseUrl = process.env.ANTHROPIC_BASE_URL ?? provider.baseUrl;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env[provider.apiKeyEnv] ?? '';
  const model = process.env.CLAUDE_DEFAULT_MODEL ?? provider.model;
  const timeoutMs = parseInt(process.env.CLAUDE_MCP_HEALTH_TIMEOUT_MS ?? '30000');

  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 1,
    stream: false,
  });

  const url = new URL(baseUrl + '/chat/completions');
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const startTime = Date.now();

  return new Promise((resolve) => {
    let timedOut = false;
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (timedOut) return;
        const latencyMs = Date.now() - startTime;
        try {
          const parsed = JSON.parse(data);
          if (parsed?.choices || parsed?.id) {
            resolve({ healthy: true, latencyMs, model });
          } else if (parsed?.error) {
            resolve({ healthy: false, error: parsed.error.message ?? JSON.stringify(parsed.error), latencyMs });
          } else {
            resolve({ healthy: false, error: `Unexpected response: ${data.slice(0, 200)}`, latencyMs });
          }
        } catch (e) {
          resolve({ healthy: false, error: `JSON parse failed: ${data.slice(0, 200)}`, latencyMs });
        }
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
      resolve({ healthy: false, error: `Timed out after ${timeoutMs}ms`, latencyMs: timeoutMs });
    }, timeoutMs);

    req.on('error', (err) => {
      clearTimeout(timer);
      resolve({ healthy: false, error: err.message, latencyMs: Date.now() - startTime });
    });

    req.on('close', () => clearTimeout(timer));

    req.write(body);
    req.end();
  });
}

/** Build identity JSON for slot mode */
function buildIdentityResult(provider) {
  let version = '0.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    version = pkg.version ?? version;
  } catch (_) { /* ignore */ }

  let model;
  if (provider.type === 'http') {
    model = process.env.CLAUDE_DEFAULT_MODEL ?? provider.model;
  } else {
    // Start with static fallback from providers.json, or binary name
    model = provider.model ?? provider.mainTool ?? provider.cli;
    // Attempt dynamic detection via model_detect config
    if (provider.model_detect?.file && provider.model_detect?.pattern) {
      try {
        const detectPath = provider.model_detect.file.replace(/^~/, os.homedir());
        const content = fs.readFileSync(detectPath, 'utf8');
        const match = content.match(new RegExp(provider.model_detect.pattern, 'm'));
        if (match?.[1]) model = match[1];
      } catch (_) { /* fall through to static value */ }
    }
  }

  return JSON.stringify({
    name: 'unified-mcp-server',
    version,
    slot: provider.name,
    type: provider.type,
    model,
    display_provider: provider.display_provider ?? null,
    provider: provider.description,
    install_method: 'nf-monorepo',
  });
}

async function runSubprocessHealthCheck(provider) {
  const args = provider.health_check_args ?? ['--version'];
  const startTime = Date.now();
  const output = await runSubprocessWithArgs(provider, args, 10000);
  const latencyMs = Date.now() - startTime;
  const healthy = !output.startsWith('[spawn error') && !output.startsWith('[TIMED');
  return JSON.stringify({ healthy, latencyMs, type: 'subprocess' });
}

async function runDeepHealthCheck(provider) {
  const probe = provider.deep_probe;
  if (!probe) {
    return JSON.stringify({ healthy: false, latencyMs: 0, layer: 'BINARY_MISSING', error: 'No deep_probe config' });
  }

  const timeoutMs = probe.timeout_ms ?? 20000;

  // Step 1: Check binary exists — same 3-tier fallback as resolveSpawnTarget
  // (resolvedCli → cli → mainTool) so mainTool-only slots resolve here too.
  const binaryPath = provider.resolvedCli || provider.cli || provider.mainTool;
  try {
    fs.accessSync(binaryPath, fs.constants.X_OK);
  } catch (_) {
    return JSON.stringify({ healthy: false, latencyMs: 0, layer: 'BINARY_MISSING', error: `CLI not found: ${binaryPath}` });
  }

  // Step 2: If service config exists, check service status (with 3s timeout to prevent hangs)
  if (provider.service?.status) {
    let statusOutput;
    try {
      statusOutput = await Promise.race([
        runSubprocessWithArgs(
          { cli: provider.service.status[0], env: provider.env ?? {} },
          provider.service.status.slice(1),
          5000
        ),
        new Promise((_, reject) => setTimeout(() => reject(new Error('status check hung')), 3000))
      ]);
    } catch (_) {
      // Status command itself hung — treat as SERVICE_DOWN
      return JSON.stringify({ healthy: false, latencyMs: 0, layer: 'SERVICE_DOWN', error: 'Service status command timed out (3s)' });
    }
    // If status command indicates service is not running, report SERVICE_DOWN
    const down = statusOutput.toLowerCase().includes('not running') ||
                 statusOutput.toLowerCase().includes('stopped') ||
                 statusOutput.startsWith('[spawn error');
    if (down) {
      return JSON.stringify({ healthy: false, latencyMs: 0, layer: 'SERVICE_DOWN', error: statusOutput.trim() });
    }
  }

  // Step 3: Run the actual inference probe
  const startTime = Date.now();
  const probeArgs = provider.args_template.map(a => a === '{prompt}' ? probe.prompt : a);
  const output = await runSubprocessWithArgs(provider, probeArgs, timeoutMs);
  const latencyMs = Date.now() - startTime;

  // Classify the result
  if (output.startsWith('[spawn error')) {
    return JSON.stringify({ healthy: false, latencyMs, layer: 'BINARY_MISSING', error: output });
  }
  if (output.includes('[TIMED OUT') || output.includes('TIMED OUT')) {
    return JSON.stringify({ healthy: false, latencyMs, layer: 'INFERENCE_TIMEOUT', error: `Timed out after ${timeoutMs}ms` });
  }

  const lower = output.toLowerCase();
  if (lower.includes('401') || lower.includes('unauthorized') || (lower.includes('auth') && lower.includes('expired'))) {
    return JSON.stringify({ healthy: false, latencyMs, layer: 'AUTH_EXPIRED', error: output.slice(0, 300) });
  }
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('quota')) {
    return JSON.stringify({ healthy: false, latencyMs, layer: 'QUOTA_EXCEEDED', error: output.slice(0, 300) });
  }

  // Check for expected probe response
  if (output.includes(probe.expect)) {
    return JSON.stringify({ healthy: true, latencyMs, layer: 'INFERENCE_OK', error: null });
  }

  // Fallback: got output but no expected string — re-check ALL error keywords before declaring OK
  const ERROR_KEYWORDS = ['401', '429', 'unauthorized', 'quota', 'rate limit', 'auth', 'expired', 'forbidden', '403'];
  const hasErrorSignal = ERROR_KEYWORDS.some(kw => lower.includes(kw));
  if (hasErrorSignal) {
    if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('403')) {
      return JSON.stringify({ healthy: false, latencyMs, layer: 'AUTH_EXPIRED', error: output.slice(0, 300) });
    }
    if (lower.includes('429') || lower.includes('rate limit') || lower.includes('quota')) {
      return JSON.stringify({ healthy: false, latencyMs, layer: 'QUOTA_EXCEEDED', error: output.slice(0, 300) });
    }
    if (lower.includes('auth') && lower.includes('expired')) {
      return JSON.stringify({ healthy: false, latencyMs, layer: 'AUTH_EXPIRED', error: output.slice(0, 300) });
    }
  }

  // No error keywords AND we got substantial output — inference worked, model just didn't echo PROBE_OK exactly
  if (output.length > 5 && !output.startsWith('[')) {
    return JSON.stringify({ healthy: true, latencyMs, layer: 'INFERENCE_OK', error: null });
  }

  return JSON.stringify({ healthy: false, latencyMs, layer: 'INFERENCE_TIMEOUT', error: output.slice(0, 300) });
}

/** Deep health check for HTTP providers — sends probe prompt via HTTP API */
async function runDeepHealthCheckHttp(provider) {
  const probe = provider.deep_probe;
  if (!probe) {
    return JSON.stringify({ healthy: false, latencyMs: 0, layer: 'BINARY_MISSING', error: 'No deep_probe config' });
  }

  const timeoutMs = probe.timeout_ms ?? 20000;
  const startTime = Date.now();

  try {
    const output = await runSlotHttpProvider(provider, { prompt: probe.prompt, timeout_ms: timeoutMs });
    const latencyMs = Date.now() - startTime;

    if (output.includes('[TIMED OUT')) {
      return JSON.stringify({ healthy: false, latencyMs, layer: 'INFERENCE_TIMEOUT', error: `Timed out after ${timeoutMs}ms` });
    }
    if (output.includes('[HTTP request error') || output.includes('[HTTP error')) {
      return JSON.stringify({ healthy: false, latencyMs, layer: 'BINARY_MISSING', error: output.slice(0, 300) });
    }

    const lower = output.toLowerCase();
    if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('403')) {
      return JSON.stringify({ healthy: false, latencyMs, layer: 'AUTH_EXPIRED', error: output.slice(0, 300) });
    }
    if (lower.includes('429') || lower.includes('rate limit') || lower.includes('quota')) {
      return JSON.stringify({ healthy: false, latencyMs, layer: 'QUOTA_EXCEEDED', error: output.slice(0, 300) });
    }

    if (output.includes(probe.expect)) {
      return JSON.stringify({ healthy: true, latencyMs, layer: 'INFERENCE_OK', error: null });
    }

    // Got output without error signals — inference likely worked
    if (output.length > 5 && !output.startsWith('[')) {
      return JSON.stringify({ healthy: true, latencyMs, layer: 'INFERENCE_OK', error: null });
    }

    return JSON.stringify({ healthy: false, latencyMs, layer: 'INFERENCE_TIMEOUT', error: output.slice(0, 300) });
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    return JSON.stringify({ healthy: false, latencyMs, layer: 'INFERENCE_TIMEOUT', error: err.message });
  }
}

// ─── Slot mode tool dispatcher ────────────────────────────────────────────────
async function handleSlotToolCall(toolName, toolArgs) {
  if (toolName === 'ping') {
    const message = toolArgs.prompt ?? 'pong';
    return `${message} (slot: ${slotProvider.name})`;
  }

  if (toolName === 'identity') {
    return buildIdentityResult(slotProvider);
  }

  if (slotProvider.type === 'subprocess') {
    if (toolName === 'help') {
      return runSubprocessWithArgs(slotProvider, slotProvider.helpArgs ?? ['--help']);
    }

    if (toolName === slotProvider.mainTool) {
      return runProvider(slotProvider, toolArgs);
    }

    const extra = (slotProvider.extraTools ?? []).find(e => e.name === toolName);
    if (extra) {
      if (extra.checkUpdate) return runCheckUpdate();
      // Run with extra's own args_template
      return runProvider({ ...slotProvider, args_template: extra.args_template }, toolArgs);
    }

    if (toolName === 'health_check' && slotProvider.health_check_args) {
      return runSubprocessHealthCheck(slotProvider);
    }

    if (toolName === 'deep_health_check') {
      return runDeepHealthCheck(slotProvider);
    }
  }

  if (slotProvider.type === 'ccr') {
    if (toolName === 'help') {
      return runSubprocessWithArgs(slotProvider, slotProvider.helpArgs ?? ['--help']);
    }
    if (toolName === 'ask') {
      return runProvider(slotProvider, toolArgs);
    }
    if (toolName === 'health_check' && slotProvider.health_check_args) {
      const result = await runSubprocessHealthCheck(slotProvider);
      // Override type field to 'ccr' for clarity
      try {
        const parsed = JSON.parse(result);
        return JSON.stringify({ ...parsed, type: 'ccr' });
      } catch (_) { return result; }
    }

    if (toolName === 'deep_health_check') {
      return runDeepHealthCheck(slotProvider);
    }
  }

  if (slotProvider.type === 'http') {
    if (toolName === 'claude') {
      return runSlotHttpProvider(slotProvider, toolArgs);
    }
    if (toolName === 'health_check') {
      return JSON.stringify(await runHealthCheck(slotProvider));
    }

    if (toolName === 'deep_health_check') {
      return runDeepHealthCheckHttp(slotProvider);
    }
  }

  return null; // unknown tool
}

// ─── Request handlers ──────────────────────────────────────────────────────────
const toolMap = new Map(providers.map(p => [p.name, p]));

async function handleRequest(req) {
  const { id, method, params } = req;

  if (method === 'initialize') {
    sendResult(id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: slotProvider ? `${slotProvider.mainTool}-mcp-server` : 'unified-mcp-server', version: '1.0.0' },
      capabilities: { tools: {} },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return; // no response for notifications
  }

  if (method === 'tools/list') {
    sendResult(id, { tools: buildTools() });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments ?? {};

    // ── PROVIDER_SLOT mode dispatch ──────────────────────────────────────────
    if (slotProvider) {
      let output;
      try {
        output = await handleSlotToolCall(toolName, toolArgs);
      } catch (err) {
        sendResult(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        });
        return;
      }

      if (output === null) {
        sendResult(id, {
          content: [{ type: 'text', text: `Unknown tool in slot ${slotProvider.name}: ${toolName}` }],
          isError: true,
        });
      } else {
        sendResult(id, {
          content: [{ type: 'text', text: truncateResponse(output) }],
          isError: false,
        });
      }
      return;
    }

    // ── All-providers mode dispatch ──────────────────────────────────────────
    const provider = toolMap.get(toolName);

    if (!provider) {
      sendResult(id, {
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
        isError: true,
      });
      return;
    }

    try {
      const output = provider.type === 'http'
        ? await runHttpProvider(provider, toolArgs)
        : await runProvider(provider, toolArgs);
      sendResult(id, {
        content: [{ type: 'text', text: truncateResponse(output) }],
        isError: false,
      });
    } catch (err) {
      sendResult(id, {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      });
    }
    return;
  }

  // Unknown method — return method not found error
  if (id !== undefined && id !== null) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────
async function main() {
  // ─── API key bootstrap ────────────────────────────────────────────────────────
  // If running in PROVIDER_SLOT mode, load the slot's API key from the local
  // secrets store at startup. Falls back to ANTHROPIC_API_KEY already in
  // process.env (backward-compat).
  if (SLOT && !process.env.ANTHROPIC_API_KEY) {
    const secretsAccount = 'ANTHROPIC_API_KEY_' + SLOT.toUpperCase().replace(/-/g, '_');
    try {
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      const secrets = require('./secrets.cjs');
      const secret = await secrets.get('nforma', secretsAccount);
      if (secret) {
        process.env.ANTHROPIC_API_KEY = secret;
        process.stderr.write(`[unified-mcp-server] Loaded API key for slot ${SLOT} from secrets store\n`);
      }
    } catch (e) {
      // secrets store unavailable or no entry — continue without it
      process.stderr.write(`[unified-mcp-server] secrets unavailable for slot ${SLOT}: ${e.message}\n`);
    }
  }

  // ─── ${VAR} placeholder bootstrap ──────────────────────────────────────────
  // Load secrets for ${VAR} placeholders in the active slot's provider.env.
  // The fan-out import (issue 169) writes secret values as ${KEY} placeholders
  // in providers.json and stores actual values in the secrets store. Without
  // this bootstrap, spawn-time resolution would fail with a missing env var.
  // Secrets are namespaced by slot name (<slot>__<key>) to prevent collisions
  // when multiple providers share the same env key with different values.
  if (SLOT && slotProvider && slotProvider.env) {
    try {
      const { isPlaceholder } = require('./resolve-env.cjs');
      const secrets = require('./secrets.cjs');
      let loaded = 0;
      for (const [k, v] of Object.entries(slotProvider.env)) {
        const envVarName = extractPlaceholderVar(v);
        if (envVarName !== null && process.env[envVarName] === undefined) {
          // Try namespaced key first, then fall back to unnamespaced
          const secret = await secrets.get('nforma', namespacedSecretKey(SLOT, envVarName))
                        ?? await secrets.get('nforma', envVarName);
          if (secret) {
            process.env[envVarName] = secret;
            loaded++;
          }
        }
      }
      if (loaded > 0) {
        process.stderr.write(`[unified-mcp-server] Loaded ${loaded} secret(s) for slot ${SLOT} from secrets store\n`);
      }
    } catch (e) {
      process.stderr.write(`[unified-mcp-server] secrets bootstrap for slot ${SLOT}: ${e.message}\n`);
    }
  }

  // ─── Stdin line reader ────────────────────────────────────────────────────────
  const rl = createInterface({ input: process.stdin });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch (e) {
      sendError(null, -32700, 'Parse error');
      return;
    }
    await handleRequest(req);
  });

  rl.on('close', () => process.exit(0));

  const slotLabel = SLOT ? ` [slot: ${SLOT}]` : ' [all-providers]';
  process.stderr.write(`[unified-mcp-server] started${slotLabel}\n`);
}

main();

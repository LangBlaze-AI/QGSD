#!/usr/bin/env node
'use strict';

/**
 * check-provider-health.cjs
 *
 * Fast HTTP probe of the underlying LLM providers behind claude-mcp-server.
 * Reads ~/.claude.json → extracts ANTHROPIC_BASE_URL per server → groups by
 * provider → hits GET /models with a short connect timeout.
 *
 * A 200 or 401/403 means the provider is UP (server responded).
 * A timeout or connection error means it's DOWN.
 *
 * No LLM inference is performed — this completes in ~2–3 seconds.
 *
 * TTL cache at ~/.claude/nf-provider-cache.json:
 *   - DOWN entries: 5 minutes TTL
 *   - UP entries:   3 minutes TTL
 *   Cache is read before probing; stale or missing → probe runs normally.
 *   After each probe, result is written back to cache.
 *
 * Usage:
 *   node bin/check-provider-health.cjs [--timeout-ms N] [--json] [--no-cache] [--cache-status]
 *
 * Exit codes:
 *   0 = all providers healthy
 *   1 = one or more providers unhealthy
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const { loadProviders } = require('./resolve-providers.cjs');

// ─── Project root lookup (for quorum-failures.json) ───────────────────────────
function findProjectRoot() {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.planning'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const args         = process.argv.slice(2);
const getArg       = (f) => { const i = args.indexOf(f); return i !== -1 && args[i+1] ? args[i+1] : null; };
const hasFlag      = (f) => args.includes(f);
const TIMEOUT_MS   = parseInt(getArg('--timeout-ms') ?? '7000', 10);
const JSON_OUT     = hasFlag('--json');
const NO_CACHE     = hasFlag('--no-cache');
const CACHE_STATUS = hasFlag('--cache-status');

// ─── TTL cache constants ──────────────────────────────────────────────────────
const CACHE_FILE    = path.join(os.homedir(), '.claude', 'nf-provider-cache.json');
const TTL_DOWN_MS   = 300000; // 5 minutes
const TTL_UP_MS     = 180000; // 3 minutes

// ─── Load / save cache ────────────────────────────────────────────────────────
function loadCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.entries === 'object') return parsed;
  } catch (_) {}
  return { entries: {} };
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    // Non-fatal: cache write failure does not abort health check
    process.stderr.write('[cache] Write failed: ' + e.message + '\n');
  }
}

function getCachedResult(cache, baseUrl) {
  const entry = cache.entries[baseUrl];
  if (!entry) return null;
  const ttl = entry.healthy ? TTL_UP_MS : TTL_DOWN_MS;
  const age = Date.now() - entry.cachedAt;
  if (age < ttl) return entry;
  return null; // stale
}

// --cache-status: print cache file contents and exit
if (CACHE_STATUS) {
  const cache = loadCache();
  const now = Date.now();
  const entries = Object.entries(cache.entries);
  if (entries.length === 0) {
    console.log('Cache file: ' + CACHE_FILE);
    console.log('No entries cached yet.');
    process.exit(0);
  }
  console.log('Cache file: ' + CACHE_FILE);
  console.log('Entries: ' + entries.length);
  console.log('');
  for (const [baseUrl, entry] of entries) {
    const ttl = entry.healthy ? TTL_UP_MS : TTL_DOWN_MS;
    const age = now - entry.cachedAt;
    const remaining = ttl - age;
    const status = entry.healthy ? 'UP' : 'DOWN';
    const fresh = remaining > 0;
    const expiresIn = fresh ? Math.round(remaining / 1000) + 's' : 'EXPIRED';
    console.log(`  ${status.padEnd(5)} ${baseUrl}`);
    console.log(`         latencyMs=${entry.latencyMs}  statusCode=${entry.statusCode}  expires=${expiresIn}`);
  }
  process.exit(0);
}

// ─── Load provider map from ~/.claude.json ────────────────────────────────────
let mcpServers = {};
try {
  const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
  mcpServers = raw.mcpServers ?? {};
} catch (e) {
  console.error('Could not read ~/.claude.json:', e.message);
  process.exit(1);
}

// Load quorum_active from ~/.claude/nf.json (project config takes precedence)
let quorumActive = [];
try {
  const globalQnf = path.join(os.homedir(), '.claude', 'nf.json');
  const projQnf   = path.join(process.cwd(), '.claude', 'nf.json');
  for (const cfgPath of [globalQnf, projQnf]) {
    try {
      const cfgRaw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (Array.isArray(cfgRaw.quorum_active)) quorumActive = cfgRaw.quorum_active;
    } catch (_) {}
  }
} catch (_) {}

// Filter mcpServers by quorum_active (empty quorumActive = all servers participate)
const activeMcpServers = (quorumActive.length > 0)
  ? Object.fromEntries(Object.entries(mcpServers).filter(([name]) => quorumActive.includes(name)))
  : mcpServers;

// ─── Load providers.json for PROVIDER_SLOT-based slot discovery ──────────────
// Single source of truth (issue #197). Canonical installed path:
// ~/.claude/nf-bin/providers.json (`'.claude', 'nf-bin', 'providers.json'`).
const providersJson = loadProviders({ baseDir: __dirname }) || [];

// Build lookup: slotName -> { baseUrl, apiKeyEnv, model } from providers.json
const slotLookup = {};
for (const p of providersJson) {
  if (p.type === 'http' && p.baseUrl) {
    slotLookup[p.name] = { baseUrl: p.baseUrl, apiKeyEnv: p.apiKeyEnv, model: p.model ?? '?' };
  }
}

// Build: providerBaseUrl -> { servers: [], apiKey }
const providers = {};
for (const [name, cfg] of Object.entries(activeMcpServers)) {
  const env     = cfg.env ?? {};

  // Path 1: Legacy ANTHROPIC_BASE_URL in MCP server env
  let baseUrl = env.ANTHROPIC_BASE_URL;
  let apiKey  = env.ANTHROPIC_API_KEY;
  let model   = env.CLAUDE_DEFAULT_MODEL ?? '?';

  // Path 2: PROVIDER_SLOT-based slots — resolve baseUrl from providers.json
  if (!baseUrl && env.PROVIDER_SLOT && slotLookup[env.PROVIDER_SLOT]) {
    const sl = slotLookup[env.PROVIDER_SLOT];
    baseUrl = sl.baseUrl;
    model = sl.model;
    // Resolve API key from environment variable name
    if (sl.apiKeyEnv && process.env[sl.apiKeyEnv]) {
      apiKey = process.env[sl.apiKeyEnv];
    }
  }

  if (!baseUrl) continue;

  if (!providers[baseUrl]) {
    providers[baseUrl] = { servers: [], apiKey: apiKey || providers[baseUrl]?.apiKey };
  }
  providers[baseUrl].servers.push({ name, model });
}

// ─── Quorum Failure Patterns printer ─────────────────────────────────────────
function printQuorumFailures() {
  if (JSON_OUT) return;
  try {
    let failuresPath;
    try {
      const pp = require('./planning-paths.cjs');
      failuresPath = pp.resolve(findProjectRoot(), 'quorum-failures');
    } catch (_) {
      failuresPath = path.join(findProjectRoot(), '.planning', 'quorum-failures.json');
    }
    if (!fs.existsSync(failuresPath)) return;

    let records;
    try {
      records = JSON.parse(fs.readFileSync(failuresPath, 'utf8'));
      if (!Array.isArray(records)) records = [];
    } catch (_) { return; }

    const fYellow = (s) => `\x1b[33m${s}\x1b[0m`;
    const fRed    = (s) => `\x1b[31m${s}\x1b[0m`;
    const fBold   = (s) => `\x1b[1m${s}\x1b[0m`;
    const fCyan   = (s) => `\x1b[36m${s}\x1b[0m`;
    const fDim    = (s) => `\x1b[2m${s}\x1b[0m`;

    const hints = {
      CLI_SYNTAX: 'Check CLI args_template in providers.json for this slot',
      TIMEOUT:    'Check provider timeout_ms in providers.json or increase --timeout arg',
      AUTH:       'Check API key env var / OAuth token for this slot',
      UNKNOWN:    'Check stderr output in pattern field above',
    };

    let warnEmitted = false;
    const bySlot = {};
    for (const r of records) {
      if (!bySlot[r.slot]) bySlot[r.slot] = {};
      if (!bySlot[r.slot][r.error_type]) bySlot[r.slot][r.error_type] = r;
    }

    for (const [slotName, byType] of Object.entries(bySlot)) {
      for (const [errorType, rec] of Object.entries(byType)) {
        if (rec.count >= 3) {
          if (!warnEmitted) {
            console.log(fYellow('━━━ QUORUM SLOT FAILURE PATTERNS ━━━'));
            console.log();
            warnEmitted = true;
          }
          console.log(`  ${fYellow('WARN')}  quorum slot "${fCyan(slotName)}" has ${fRed(String(rec.count))} ${fBold(errorType)} failures (last: ${fDim(rec.last_seen)})`);
          console.log(`        ${fDim('Pattern:')} ${fDim(rec.pattern)}`);
          console.log(`        ${fDim('Hint:')} ${fDim(hints[errorType] ?? hints.UNKNOWN)}`);
          console.log();
        }
      }
    }
  } catch (_) { /* silently skip — never crash health check */ }
}

if (Object.keys(providers).length === 0) {
  // Under --json the output must stay valid JSON: callers (e.g. quorum.md)
  // JSON.parse() it. A plain human string here threw on CLI-only setups.
  if (JSON_OUT) {
    console.log('[]');
  } else {
    console.log('No HTTP-backed MCP slots found (checked ANTHROPIC_BASE_URL and PROVIDER_SLOT with providers.json).');
    printQuorumFailures();
  }
  process.exit(0);
}

// ─── HTTP probe ───────────────────────────────────────────────────────────────
function probeUrl(baseUrl, apiKey) {
  return new Promise((resolve) => {
    // Hit /models — standard OpenAI-compat endpoint
    // A 401/403 = server up (auth required); 200 = server up (open); timeout = down
    let probeUrl;
    try {
      const u = new URL(baseUrl);
      // Normalize: strip trailing /v1 if present, re-add /v1/models
      const base = u.origin + (u.pathname.replace(/\/$/, ''));
      probeUrl = `${base}/models`;
    } catch {
      return resolve({ healthy: false, statusCode: null, error: `Invalid URL: ${baseUrl}`, latencyMs: 0 });
    }

    const start = Date.now();
    const parsed = new URL(probeUrl);
    const lib = parsed.protocol === 'https:' ? https : http;

    const headers = { 'User-Agent': 'nf-health-check/1.0' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   'GET',
        headers,
        timeout:  TIMEOUT_MS,
      },
      (res) => {
        const latencyMs = Date.now() - start;
        // Consume response body to free socket
        res.resume();
        res.on('end', () => {
          // 200, 401, 403 all mean the server is alive
          const healthy = [200, 401, 403, 404, 422].includes(res.statusCode);
          resolve({ healthy, statusCode: res.statusCode, error: null, latencyMs });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      const latencyMs = Date.now() - start;
      resolve({ healthy: false, statusCode: null, error: `Timed out after ${TIMEOUT_MS}ms`, latencyMs });
    });

    req.on('error', (e) => {
      const latencyMs = Date.now() - start;
      resolve({ healthy: false, statusCode: null, error: e.message, latencyMs });
    });

    req.end();
  });
}

// ─── Run probes (sequential to avoid thundering-herd on same provider) ────────
async function main() {
  const results = [];
  const cache = loadCache();

  for (const [baseUrl, { servers, apiKey }] of Object.entries(providers)) {
    // Extract a friendly provider name from the URL
    let providerName;
    try {
      providerName = new URL(baseUrl).hostname.replace(/^api\./, '').replace(/\.com$|\.ai$|\.xyz$/, '');
    } catch {
      providerName = baseUrl;
    }

    let probe;
    const cached = NO_CACHE ? null : getCachedResult(cache, baseUrl);

    if (cached) {
      // Use cached result — log to stderr only in non-JSON mode to avoid polluting JSON output
      probe = {
        healthy:    cached.healthy,
        statusCode: cached.statusCode,
        error:      cached.error ?? null,
        latencyMs:  cached.latencyMs,
      };
      if (!JSON_OUT) {
        const ttl = cached.healthy ? TTL_UP_MS : TTL_DOWN_MS;
        const remaining = Math.round((ttl - (Date.now() - cached.cachedAt)) / 1000);
        const statusStr = cached.healthy ? 'UP' : 'DOWN';
        process.stderr.write(`[cache] ${providerName} = ${statusStr} (cached, expires in ${remaining}s)\n`);
      }
    } else {
      // Run the HTTP probe
      probe = await probeUrl(baseUrl, apiKey);
      // Write result back to cache
      cache.entries[baseUrl] = {
        healthy:    probe.healthy,
        statusCode: probe.statusCode,
        error:      probe.error,
        latencyMs:  probe.latencyMs,
        cachedAt:   Date.now(),
      };
      saveCache(cache);
    }

    results.push({
      provider:   providerName,
      baseUrl,
      servers:    servers.map(s => s.name),
      models:     servers.map(s => s.model),
      healthy:    probe.healthy,
      statusCode: probe.statusCode,
      latencyMs:  probe.latencyMs,
      error:      probe.error,
    });
  }

  // ── Output ───────────────────────────────────────────────────────────────────
  if (JSON_OUT) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    const green = (s) => `\x1b[32m${s}\x1b[0m`;
    const red   = (s) => `\x1b[31m${s}\x1b[0m`;
    const yellow= (s) => `\x1b[33m${s}\x1b[0m`;
    const dim   = (s) => `\x1b[2m${s}\x1b[0m`;
    const bold  = (s) => `\x1b[1m${s}\x1b[0m`;
    const cyan  = (s) => `\x1b[36m${s}\x1b[0m`;

    console.log(`\n${bold('━━━ LLM PROVIDER HEALTH CHECK ━━━')}`);
    console.log(dim(` Probe: GET /models  |  Timeout: ${TIMEOUT_MS}ms  |  ${new Date().toISOString().slice(0,19).replace('T',' ')} UTC`));
    console.log();

    for (const r of results) {
      const icon    = r.healthy ? green('✓') : red('✗');
      const status  = r.healthy
        ? green(`UP   [${r.statusCode}]`)
        : red(`DOWN [${r.statusCode ?? 'timeout'}]`);
      const lat     = r.latencyMs < 500 ? green(`${r.latencyMs}ms`) : yellow(`${r.latencyMs}ms`);

      console.log(`  ${icon}  ${bold(r.provider.padEnd(14))}  ${status.padEnd(20)}  ${lat}`);
      console.log(`     ${dim(r.baseUrl)}`);

      for (let i = 0; i < r.servers.length; i++) {
        const serverHealthy = r.healthy;
        const dot = serverHealthy ? green('•') : red('•');
        console.log(`     ${dot} ${cyan(r.servers[i].padEnd(22))} ${dim(r.models[i])}`);
      }

      if (r.error) {
        console.log(`     ${red('→')} ${dim(r.error)}`);
      }
      console.log();
    }

    const unhealthy = results.filter(r => !r.healthy);
    if (unhealthy.length > 0) {
      console.log(red(`${unhealthy.length}/${results.length} providers DOWN — skip these MCP servers in quorum:`));
      for (const r of unhealthy) {
        r.servers.forEach(s => console.log(`  • ${s}`));
      }
      console.log();
      console.log(dim('  Tip: run again in a few minutes — AkashML/Fireworks have intermittent outages.'));
    } else {
      console.log(green('  All providers healthy ✓'));
    }
    console.log();
  }

  // ── Quorum Failure Patterns ──────────────────────────────────────────────────
  printQuorumFailures();

  process.exit(results.some(r => !r.healthy) ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });

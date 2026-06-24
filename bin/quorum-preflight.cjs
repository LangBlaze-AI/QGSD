#!/usr/bin/env node
'use strict';

/**
 * quorum-preflight.cjs — extract quorum config and team identity from nf.json + providers.json
 *
 * Replaces three inline `node -e` snippets in quorum.md that caused shell-escaping
 * failures (LLMs escaping `!` as `\!` inside node -e strings).
 *
 * Usage:
 *   node quorum-preflight.cjs --quorum-active       # → JSON array of active slot names
 *   node quorum-preflight.cjs --max-quorum-size      # → integer (default 3)
 *   node quorum-preflight.cjs --team                  # → JSON { slotName: { model } }
 *   node quorum-preflight.cjs --all                   # → JSON with health, available_slots, unavailable_slots (probe on by default)
 *   node quorum-preflight.cjs --all --no-probe        # → JSON { quorum_active, max_quorum_size, team } (skip health probes)
 *
 * All modes read from ~/.claude/nf.json (global) merged with $CWD/.claude/nf.json (project).
 * --team and --all also read providers.json (same search logic as call-quorum-slot.cjs).
 *
 * --probe flag (with --all only): runs two-layer parallel health probes:
 *   Layer 1: Binary probe — spawns CLI binary with health_check_args (3s timeout)
 *   Layer 2: Upstream API probe — GET /models for HTTP slots (5s timeout, TTL cache)
 *
 * Exit code: always 0. Output: JSON to stdout.
 */

const fs              = require('fs');
const path            = require('path');
const os              = require('os');
const { spawn, execFileSync } = require('child_process');
const { resolveCli }  = require('./resolve-cli.cjs');
const https           = require('https');
const http            = require('http');
const { resolveSpawnTarget } = require('./resolve-cli.cjs');
const { loadProviders } = require('./resolve-providers.cjs');

// Probe is ON by default for --all; --no-probe to skip, --probe still accepted for compat
const NO_PROBE = process.argv.includes('--no-probe');
const PROBE = !NO_PROBE;

// ─── Time-budget parsing ────────────────────────────────────────────────────
// --budget-ms <n> threads a soft deadline that --all degrades within: when the
// budget is tight it skips service auto-start (ensureServices) and the Layer 2
// upstream API probes (the slow paths) so the caller gets a timely answer rather
// than a SIGTERM-induced fail-open. Absent flag → no budget (fully backward
// compatible: ensureServices stays opt-in via --ensure-services / --start-services).
function parseBudgetMs() {
  const i = process.argv.indexOf('--budget-ms');
  if (i !== -1 && process.argv[i + 1] !== undefined) {
    const n = Number(process.argv[i + 1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}
const BUDGET_MS = parseBudgetMs();
// Layer 2 upstream probes are the slow, network-bound path. Skip them when the
// budget cannot accommodate a full 5s round-trip with headroom.
const L2_MIN_BUDGET_MS = 5500;
const SKIP_L2 = BUDGET_MS !== null && BUDGET_MS < L2_MIN_BUDGET_MS;
// Service auto-start can poll for tens of seconds; only ever runs when explicitly
// requested AND the budget (if any) is generous enough to absorb it.
const ENSURE_SERVICES_REQUESTED =
  process.argv.includes('--ensure-services') || process.argv.includes('--start-services');
const ENSURE_SERVICES_BUDGET_MS = 70000; // worst case ~65s/down service + slack
const ALLOW_ENSURE_SERVICES =
  ENSURE_SERVICES_REQUESTED && (BUDGET_MS === null || BUDGET_MS >= ENSURE_SERVICES_BUDGET_MS);

// ─── TTL cache constants (shared with check-provider-health.cjs) ────────────
const CACHE_FILE  = path.join(os.homedir(), '.claude', 'nf-provider-cache.json');
const TTL_UP_MS   = 180000; // 3 minutes
const TTL_DOWN_MS = 300000; // 5 minutes
const TTL_BIN_MS  = 60000;  // 1 minute — Layer-1 CLI-binary presence rarely changes
                            // within a prompt burst; caching it avoids re-spawning
                            // every slot's binary on every UserPromptSubmit.

// ─── Read merged nf.json config ─────────────────────────────────────────────
function readConfig() {
  const globalCfg = path.join(os.homedir(), '.claude', 'nf.json');
  const projCfg   = path.join(process.cwd(), '.claude', 'nf.json');
  let cfg = {};
  for (const f of [globalCfg, projCfg]) {
    try { Object.assign(cfg, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (_) {}
  }
  return cfg;
}

// ─── Find providers.json ─────────────────────────────────────────────────────
// Delegates to the single source of truth in resolve-providers.cjs (issue #197).
// Canonical installed path: ~/.claude/nf-bin/providers.json
// (`'.claude', 'nf-bin', 'providers.json'`). Returns [] when no populated file is found.
function findProviders() {
  return loadProviders({ baseDir: __dirname }) || [];
}

// ─── Build team JSON from providers + config ────────────────────────────────
function buildTeam(providers, active) {
  const team = {};
  for (const p of providers) {
    if (active.length > 0 && !active.includes(p.name)) continue;
    team[p.name] = {
      model: p.model,
      display_provider: p.display_provider || p.provider,
      quorum_timeout_ms: p.quorum_timeout_ms ?? 300000,
      idle_timeout_ms: p.idle_timeout_ms ?? 90000,
    };
  }
  return team;
}

// ─── DEDUP-01 — composite (model, display_provider) deduplication ──────────
// Pure function: given an ordered slot list and a provider lookup, partition
// into kept slots and demoted-to-backup slots. Two slots collide only when both
// (model, display_provider) tuples are equal — so Daintree fan-out slots that
// share a model string but route to different upstreams via ANTHROPIC_BASE_URL
// (claude-z-ai, claude-minimax) stay distinct from the vanilla claude-1.
function dedupBySlotIdentity(orderedSlots, providerByName) {
  const keyMap = new Map();
  for (const [name, p] of providerByName) {
    keyMap.set(name, `${p.model || ''}|${p.display_provider || p.provider || ''}`);
  }
  const seen = new Set();
  const kept = [];
  const demoted = [];
  for (const slot of orderedSlots) {
    const key = keyMap.get(slot);
    if (key && key !== '|' && seen.has(key)) {
      demoted.push(slot);
    } else {
      if (key && key !== '|') seen.add(key);
      kept.push(slot);
    }
  }
  return { kept, demoted };
}

// ─── URL normalization for dedup ────────────────────────────────────────────
function normalizeBaseUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    u.hostname = u.hostname.toLowerCase();
    // Remove default ports
    if ((u.protocol === 'https:' && u.port === '443') ||
        (u.protocol === 'http:'  && u.port === '80')) {
      u.port = '';
    }
    // Strip trailing slash from pathname
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    if (u.pathname === '/') u.pathname = '';
    return u.origin + u.pathname;
  } catch {
    return urlStr;
  }
}

// ─── Cache helpers (shared pattern with check-provider-health.cjs) ──────────
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
    const dir = path.dirname(CACHE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    process.stderr.write('[cache] Write failed: ' + e.message + '\n');
  }
}

function getCachedResult(cache, baseUrl) {
  const entry = cache.entries[baseUrl];
  if (!entry) return null;
  const ttl = entry.healthy ? TTL_UP_MS : TTL_DOWN_MS;
  const age = Date.now() - entry.cachedAt;
  if (age < ttl) return { ...entry, remainingMs: ttl - age };
  return null; // stale
}

// Layer-1 binary-probe cache. Keyed `bin:<spawnTarget>` and tagged kind:'binary'
// so it never collides with the URL-keyed HTTP entries. A short TTL keeps a
// newly-installed/removed CLI detectable within a minute while collapsing the
// repeated per-prompt binary spawns into a single probe.
function getCachedBinary(cache, key) {
  const entry = cache.entries[key];
  if (!entry || entry.kind !== 'binary') return null;
  const age = Date.now() - entry.cachedAt;
  return age < TTL_BIN_MS ? entry : null;
}

// ─── Layer 1: Binary probe ──────────────────────────────────────────────────
function probeBinary(cli, healthCheckArgs) {
  return new Promise((resolve) => {
    const timeout = 3000;
    try {
      const proc = spawn(cli, healthCheckArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
      });

      let resolved = false;
      const done = (ok, reason) => {
        if (resolved) return;
        resolved = true;
        resolve({ ok, reason });
      };

      proc.on('error', (err) => {
        if (err.code === 'ENOENT') {
          done(false, `binary not found: ${cli}`);
        } else {
          done(false, `spawn error: ${err.message}`);
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          done(true, 'exit 0');
        } else if (code === null) {
          done(false, `timeout after ${timeout}ms`);
        } else {
          done(false, `exit ${code}`);
        }
      });
    } catch (err) {
      resolve({ ok: false, reason: `spawn failed: ${err.message}` });
    }
  });
}

// ─── Layer 2: Upstream API probe (HTTP) ─────────────────────────────────────
function probeUpstreamApi(baseUrl, apiKey) {
  return new Promise((resolve) => {
    const TIMEOUT_MS = 5000;
    let probeTarget;
    try {
      const u = new URL(baseUrl);
      const base = u.origin + u.pathname.replace(/\/$/, '');
      probeTarget = `${base}/models`;
    } catch {
      return resolve({ ok: false, reason: `invalid URL: ${baseUrl}`, latencyMs: 0 });
    }

    const start = Date.now();
    const parsed = new URL(probeTarget);
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
        res.resume();
        res.on('end', () => {
          const healthy = [200, 401, 403, 404, 422].includes(res.statusCode);
          resolve({
            ok: healthy,
            reason: healthy ? `HTTP ${res.statusCode}` : `HTTP ${res.statusCode} (unhealthy)`,
            latencyMs,
            statusCode: res.statusCode,
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      const latencyMs = Date.now() - start;
      resolve({ ok: false, reason: `timeout after ${TIMEOUT_MS}ms`, latencyMs });
    });

    req.on('error', (e) => {
      const latencyMs = Date.now() - start;
      resolve({ ok: false, reason: e.message, latencyMs });
    });

    req.end();
  });
}

// ─── Layer 3: Inference history probe ────────────────────────────────────────
// Reads quorum-failures.json to detect slots that failed inference recently.
// This catches quota exhaustion, rate limits, and other soft failures that
// Layer 1 (binary probe) and Layer 2 (upstream API probe) cannot detect.
// TTL: 30 minutes (matches getRecentlyFailedSlots in nf-prompt.js).
function probeInferenceHistory(ttlMinutes = 30) {
  try {
    const planningPaths = require('./planning-paths.cjs');
    // Use findProjectRoot-like logic to find .planning directory
    let root = process.cwd();
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(root, '.planning'))) break;
      const parent = path.dirname(root);
      if (parent === root) break;
      root = parent;
    }
    const logPath = planningPaths.resolveWithFallback(root, 'quorum-failures');
    if (!fs.existsSync(logPath)) return {};
    const records = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    if (!Array.isArray(records)) return {};
    const cutoff = Date.now() - ttlMinutes * 60 * 1000;
    const result = {};
    for (const r of records) {
      if (new Date(r.last_seen).getTime() > cutoff) {
        result[r.slot] = {
          ok: false,
          reason: `${r.error_type}: ${(r.pattern || '').slice(0, 100)}`,
          error_type: r.error_type,
          count: r.count,
          last_seen: r.last_seen,
        };
      }
    }
    return result;
  } catch (_) { return {}; } // fail-open
}

// ─── Two-layer parallel health probe ────────────────────────────────────────
async function probeHealth(providers) {
  const cache = loadCache();
  const health = {};

  await Promise.all(providers.map(async (p) => {
    const isHttp = p.type === 'http';

    // Layer 1: binary probe (CLI slots only — HTTP slots have no binary)
    // Use the shared spawn-target resolver (issue #197, supersedes #196/#207):
    // raw p.cli is null when only mainTool is set, which previously reported the
    // entire fleet false-dead. resolveSpawnTarget falls back to mainTool.
    const spawnTarget = resolveSpawnTarget(p);
    let layer1Promise;
    if (isHttp) {
      layer1Promise = Promise.resolve({ ok: true, skipped: true, reason: 'HTTP slot — no CLI binary' });
    } else if (!spawnTarget) {
      layer1Promise = Promise.resolve({ ok: false, reason: 'no CLI configured (cli, resolvedCli, mainTool all empty)' });
    } else {
      const binKey = 'bin:' + spawnTarget;
      const cachedBin = getCachedBinary(cache, binKey);
      if (cachedBin) {
        layer1Promise = Promise.resolve({ ok: cachedBin.healthy, reason: cachedBin.reason, cacheAge: 'cached' });
      } else {
        layer1Promise = probeBinary(spawnTarget, p.health_check_args || []).then((result) => {
          cache.entries[binKey] = { kind: 'binary', healthy: result.ok, reason: result.reason, cachedAt: Date.now() };
          saveCache(cache);
          return { ...result, cacheAge: 'fresh' };
        });
      }
    }

    // Layer 2: upstream API probe (HTTP slots only)
    let layer2Promise;
    let baseUrl, apiKey;
    if (isHttp) {
      // HTTP slots have baseUrl and apiKeyEnv directly in providers.json
      baseUrl = p.baseUrl;
      apiKey = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
    }

    if (!isHttp) {
      layer2Promise = Promise.resolve({ ok: true, skipped: true, reason: 'no upstream API' });
    } else if (SKIP_L2) {
      // Budget too tight for a network round-trip — degrade to Layer 1 only.
      layer2Promise = Promise.resolve({ ok: true, skipped: true, reason: 'layer2 skipped (budget)' });
    } else if (!baseUrl) {
      layer2Promise = Promise.resolve({ ok: true, skipped: true, reason: 'baseUrl not configured' });
    } else {
      const normalizedUrl = normalizeBaseUrl(baseUrl);
      // Check cache first
      const cached = getCachedResult(cache, normalizedUrl);
      if (cached) {
        const remaining = Math.round(cached.remainingMs / 1000);
        layer2Promise = Promise.resolve({
          ok: cached.healthy,
          reason: cached.healthy ? `HTTP ${cached.statusCode}` : (cached.error || 'cached DOWN'),
          latencyMs: cached.latencyMs,
          cacheAge: `cached`,
        });
      } else {
        // Run live probe
        layer2Promise = probeUpstreamApi(baseUrl, apiKey).then((result) => {
          // Write to cache
          cache.entries[normalizedUrl] = {
            healthy:    result.ok,
            statusCode: result.statusCode ?? null,
            error:      result.ok ? null : result.reason,
            latencyMs:  result.latencyMs,
            cachedAt:   Date.now(),
          };
          saveCache(cache);
          return { ...result, cacheAge: 'fresh' };
        });
      }
    }

    // Run both layers in parallel
    const [layer1, layer2] = await Promise.all([layer1Promise, layer2Promise]);

    health[p.name] = {
      healthy: layer1.ok && layer2.ok,
      layer1: { ok: layer1.ok, reason: layer1.reason },
      layer2: {
        ok: layer2.ok,
        reason: layer2.reason,
        ...(layer2.skipped ? { skipped: true } : {}),
        ...(layer2.latencyMs !== undefined ? { latencyMs: layer2.latencyMs } : {}),
        ...(layer2.cacheAge ? { cacheAge: layer2.cacheAge } : {}),
      },
    };
  }));

  return health;
}

// ─── Service auto-start (pre-probe) ─────────────────────────────────────────
function ensureServices(providers) {
  // Deduplicate by unique service.status command
  const checked = new Set();

  for (const p of providers) {
    if (!p.service || !p.service.status || !p.service.start) continue;

    const key = JSON.stringify(p.service.status);
    if (checked.has(key)) continue;
    checked.add(key);

    const [statusCmd, ...statusArgs] = p.service.status;
    const [startCmd, ...startArgs] = p.service.start;

    // Check if service is running
    let needsStart = false;
    try {
      const out = execFileSync(statusCmd, statusArgs, { encoding: 'utf8', timeout: 5000 });
      if (/not running|stopped/i.test(out)) {
        needsStart = true;
      }
    } catch (_) {
      // Status check failed — skip this service (fail-open)
      process.stderr.write(`[preflight] Service ${statusCmd} ${statusArgs.join(' ')} status check failed, skipping\n`);
      continue;
    }

    if (!needsStart) continue;

    // Auto-start the service (fire-and-forget, then poll for readiness)
    process.stderr.write(`[preflight] Service ${startCmd} ${startArgs.join(' ')} is down, starting...\n`);
    try {
      // Spawn as detached background process — don't wait for it to exit.
      // The poll loop below will detect when the service is ready.
      const child = require('child_process').spawn(startCmd, startArgs, {
        detached: true, stdio: 'ignore'
      });
      child.unref();
    } catch (e) {
      process.stderr.write(`[preflight] Service ${startCmd} ${startArgs.join(' ')} spawn failed: ${e.message}\n`);
      continue;
    }

    // Poll for readiness: 1s interval, up to 10 iterations
    let started = false;
    const pollStart = Date.now();
    for (let i = 0; i < 10; i++) {
      try {
        execFileSync('sleep', ['1']);
      } catch (_) {}
      try {
        const out = execFileSync(statusCmd, statusArgs, { encoding: 'utf8', timeout: 5000 });
        if (!/not running|stopped/i.test(out)) {
          started = true;
          break;
        }
      } catch (_) {
        // Poll check failed — continue polling
      }
    }

    const elapsed = Math.round((Date.now() - pollStart) / 1000);
    if (started) {
      process.stderr.write(`[preflight] Service ${startCmd} ${startArgs.join(' ')} started (${elapsed}s)\n`);
    } else {
      process.stderr.write(`[preflight] Service ${startCmd} ${startArgs.join(' ')} failed to start after ${elapsed}s\n`);
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const mode = process.argv[2] || '--all';
  const cfg  = readConfig();

  if (mode === '--quorum-active') {
    console.log(JSON.stringify(cfg.quorum_active || []));
  } else if (mode === '--max-quorum-size') {
    // Write an explicit string — console.log of a Number is ANSI-colorized under
    // FORCE_COLOR, which breaks quorum.md's shell integer comparison (issue #196).
    process.stdout.write(String(cfg.max_quorum_size ?? 3) + '\n');
  } else if (mode === '--team') {
    const providers = findProviders();
    const active    = cfg.quorum_active || [];
    console.log(JSON.stringify(buildTeam(providers, active)));
  } else if (mode === '--ensure-services') {
    const providers = findProviders();
    const active    = cfg.quorum_active || [];
    const activeProviders = active.length > 0
      ? providers.filter(p => active.includes(p.name))
      : providers;
    ensureServices(activeProviders);
    console.log('OK');
  } else if (mode === '--all') {
    const providers    = findProviders();
    const active       = cfg.quorum_active || [];
    const team         = buildTeam(providers, active);
    const maxSize      = cfg.max_quorum_size ?? 3;

    const output = { quorum_active: active, max_quorum_size: maxSize, team };

    if (PROBE) {
      // Filter providers to only active ones
      const activeProviders = active.length > 0
        ? providers.filter(p => active.includes(p.name))
        : providers;

      // Service auto-start is OFF by default in --all: it can poll for tens of
      // seconds per down service, blowing any time budget and (worse) auto-spawning
      // services inside what callers treat as a read-only probe. It now runs only
      // when explicitly requested AND the budget allows. Use the dedicated
      // `--ensure-services` mode (or pass --ensure-services to --all) to start them.
      if (ALLOW_ENSURE_SERVICES) {
        ensureServices(activeProviders);
      }
      const health = await probeHealth(activeProviders);

      // Layer 3: inference history — check if slots failed inference recently
      const inferenceHistory = probeInferenceHistory();

      // Merge Layer 3 into health results
      for (const [name, h] of Object.entries(health)) {
        if (inferenceHistory[name]) {
          h.layer3 = inferenceHistory[name];
          // A slot is unhealthy if Layer 1 OR 2 OR 3 fails
          h.healthy = h.healthy && inferenceHistory[name].ok;
        } else {
          h.layer3 = { ok: true, reason: 'no recent failures' };
        }
      }

      output.health = health;
      output.available_slots = [];
      output.unavailable_slots = [];

      for (const [name, h] of Object.entries(health)) {
        if (h.healthy) {
          output.available_slots.push(name);
        } else {
          const reason = !h.layer1.ok
            ? `layer1: ${h.layer1.reason}`
            : !h.layer2.ok
            ? `layer2: ${h.layer2.reason}`
            : h.layer3 && !h.layer3.ok
            ? `layer3: ${h.layer3.reason}`
            : 'unknown';
          output.unavailable_slots.push({ name, reason });
        }
      }

      // NOTE: nf-prompt.js also tiers slots independently via auth_type in its
      // quorum injection logic. This sort covers the quorum.md direct-read path
      // (workflows that consume preflight JSON output directly).

      // Build name-to-type lookup from activeProviders
      const typeMap = new Map(activeProviders.map(p => [p.name, p.type]));
      const originalOrder = new Map(output.available_slots.map((s, i) => [s, i]));

      // Sort available_slots: CLI primary (type !== 'http') before HTTP backup (type === 'http')
      output.available_slots.sort((a, b) => {
        const aIsBackup = typeMap.get(a) === 'http' ? 1 : 0;
        const bIsBackup = typeMap.get(b) === 'http' ? 1 : 0;
        if (aIsBackup !== bIsBackup) return aIsBackup - bIsBackup;
        return originalOrder.get(a) - originalOrder.get(b); // preserve probe order within tier
      });

      // ─── Model dedup guard (DEDUP-01) ────────────────────────────────────
      const providerByName = new Map(activeProviders.map(p => [p.name, p]));
      const { kept: deduped, demoted: dedupedOut } = dedupBySlotIdentity(output.available_slots, providerByName);
      if (dedupedOut.length > 0) {
        process.stderr.write(`[preflight] Dedup: ${dedupedOut.length} duplicate (model, display_provider) pair(s) moved to backup: ${dedupedOut.join(', ')}\n`);
      }
      output.available_slots = deduped;
      output.deduped_slots = dedupedOut;

      // Add transparency fields
      output.primary_slots = output.available_slots.filter(s => typeMap.get(s) !== 'http');
      output.backup_slots = output.available_slots.filter(s => typeMap.get(s) === 'http').concat(dedupedOut);

      // Emit stderr log when backup slots exist
      if (output.backup_slots.length > 0) {
        process.stderr.write(`[preflight] Tiered ordering: ${output.primary_slots.length} primary (CLI) + ${output.backup_slots.length} backup (HTTP API)\n`);
      }
    }

    console.log(JSON.stringify(output));
  } else {
    console.error(`Unknown mode: ${mode}`);
    console.error('Usage: node quorum-preflight.cjs [--quorum-active|--max-quorum-size|--team|--all] [--probe]');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { dedupBySlotIdentity, probeHealth, findProviders };

#!/usr/bin/env node
'use strict';

/**
 * quorum-preflight-probe-adversarial.test.cjs
 *
 * ADVERSARIAL coverage for the HEALTH-PROBING path of bin/quorum-preflight.cjs
 * (`--all`, probe ON by default). Roster *selection* (quorum_active / max-size /
 * dedup) is covered elsewhere — this file targets the availability *decision*:
 * a HEALTHY slot wrongly excluded, or a DOWN slot wrongly dispatched.
 *
 * Failure modes hunted here (each test fails on a real defect):
 *   - stale cache mis-serve (an expired UP/DOWN/binary entry served instead of
 *     re-probing) → 🔴 healthy-slot-marked-unavailable / down-slot-marked-available
 *   - cross-key cache contamination (one slot's verdict applied to another)
 *   - one bad/hung slot taking down the whole --all roster (no isolation)
 *   - a missing binary crashing the probe instead of marking the slot down
 *   - --budget-ms degradation (SKIP_L2) either hanging or mis-marking slots
 *   - --no-probe still touching the network
 *
 * Strategy: drive the EXPORTED probeHealth() in a child process with HOME set to
 * a temp dir (so the TTL cache lands there and can be seeded/inspected), against
 * a LOCAL fake HTTP server (never a real provider). Mirrors the spawn + temp-HOME
 * + fake-CLI patterns in quorum-preflight-binary-cache.test.cjs.
 *
 * Run: node --test test/quorum-preflight-probe-adversarial.test.cjs
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'bin', 'quorum-preflight.cjs');

// TTL constants are NOT exported by the source — mirror them from
// bin/quorum-preflight.cjs (~lines 70-72). If they drift, the "stale" offsets
// below stay > TTL so the intent (force a re-probe) holds.
const TTL_UP_MS = 180000;  // source: TTL_UP_MS
const TTL_BIN_MS = 60000;  // source: TTL_BIN_MS
const CACHE_REL = path.join('.claude', 'nf-provider-cache.json');

// ─── temp HOME + cache helpers ──────────────────────────────────────────────
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-probe-adv-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return home;
}
function seedCache(home, entries) {
  fs.writeFileSync(path.join(home, CACHE_REL), JSON.stringify({ entries }, null, 2), 'utf8');
}
function readCache(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, CACHE_REL), 'utf8')); }
  catch { return null; }
}
// Cache key for an HTTP slot == normalizeBaseUrl(baseUrl) in the source. For our
// path-less http://127.0.0.1:PORT URLs that normalizer yields the origin WITH a
// trailing slash (a URL object always reports pathname '/'), e.g.
// "http://127.0.0.1:PORT/". Matching it exactly is what makes the cache-hit tests
// meaningful (an origin-without-slash key silently misses → false negatives).
function httpCacheKey(url) { return new URL(url).origin + '/'; }

// Spawn a node child ASYNCHRONOUSLY and resolve its stdout. Async (not
// execFileSync) is mandatory: the fake HTTP server runs in THIS process, and a
// synchronous child would freeze the parent event loop so the server could never
// answer the probe (it would always time out). Rejects on non-zero exit so a
// crashed probe surfaces as a thrown error, not a silent pass.
function execNode(argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      env: { ...process.env, HOME: opts.home, ...(opts.env || {}) },
      cwd: opts.home,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child timed out\n' + err)); }, 25000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`child exited ${code}\n${err}`));
    });
  });
}

// Runs the exported probeHealth(providers) in a child with HOME=home and the
// given extra argv (so --budget-ms is parsed at module load). Returns the health
// object.
async function runProbe(home, providers, opts = {}) {
  const args = opts.args || [];
  const helper = path.join(home, `h-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(helper, `
'use strict';
const { probeHealth } = require(${JSON.stringify(SCRIPT)});
const providers = ${JSON.stringify(providers)};
(async () => {
  const health = await probeHealth(providers);
  process.stdout.write('NFJSON:' + JSON.stringify(health));
})().catch((e) => { process.stderr.write('PROBE_THREW:' + (e && e.stack || e) + '\\n'); process.exit(7); });
`);
  const out = await execNode([helper, ...args], { home });
  const i = out.indexOf('NFJSON:');
  if (i === -1) throw new Error('probeHealth produced no output: ' + out);
  return JSON.parse(out.slice(i + 'NFJSON:'.length));
}

// ─── local fake HTTP server (never a real provider) ─────────────────────────
function startServer(handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, sockets, port, url: `http://127.0.0.1:${port}` });
    });
  });
}
async function stopServer(s) {
  if (!s) return;
  for (const sock of s.sockets) { try { sock.destroy(); } catch (_) {} }
  await new Promise((r) => s.server.close(() => r()));
}

const NODE = process.execPath; // a binary guaranteed present & exit-0-able

// ════════════════════════════════════════════════════════════════════════════
describe('quorum-preflight --all health probe (adversarial)', () => {

  // ── 1. STALE UP cache must be re-probed — never served past TTL ───────────
  // A cached "healthy:true" entry older than TTL_UP_MS must NOT short-circuit a
  // now-DOWN upstream. If it did, a dead slot would be dispatched (wasted call /
  // timeout). 🔴 down-slot-marked-available.
  it('a stale UP HTTP cache entry is re-probed; a now-DOWN upstream wins (not served stale)', async () => {
    const home = makeHome();
    let hits = 0;
    const srv = await startServer((req, res) => { hits++; res.statusCode = 500; res.end('down'); });
    try {
      seedCache(home, {
        [httpCacheKey(srv.url)]: {
          healthy: true, statusCode: 200, error: null, latencyMs: 5,
          cachedAt: Date.now() - (TTL_UP_MS + 60000), // well past TTL → stale
        },
      });
      const health = await runProbe(home, [{ name: 'http-stale', type: 'http', baseUrl: srv.url }]);
      assert.equal(health['http-stale'].healthy, false,
        'stale UP entry must be re-probed and the live 500 must mark the slot DOWN');
      assert.ok(hits >= 1, 'a re-probe must actually hit the live upstream (cache was stale)');
    } finally {
      await stopServer(srv);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // ── 2. Cache-key isolation: own fresh UP short-circuits; a FOREIGN key does not
  // (a) a fresh own-key UP serves WITHOUT touching the network (correct caching).
  // (b) a fresh UP under a DIFFERENT slot's key must NOT satisfy this slot — it
  //     must re-probe and honor the live DOWN. 🔴 down-slot-marked-available.
  it('fresh own-key UP short-circuits (0 hits); a foreign-key UP is not mis-applied', async () => {
    const home = makeHome();
    let hits = 0;
    const srv = await startServer((req, res) => { hits++; res.statusCode = 500; res.end('down'); });
    try {
      const ownKey = httpCacheKey(srv.url);
      const provider = [{ name: 'http-key', type: 'http', baseUrl: srv.url }];

      // (a) fresh own-key UP → served from cache, server NEVER hit.
      seedCache(home, {
        [ownKey]: { healthy: true, statusCode: 200, error: null, latencyMs: 3, cachedAt: Date.now() },
      });
      let health = await runProbe(home, provider);
      assert.equal(health['http-key'].healthy, true, 'fresh own-key UP should short-circuit to healthy');
      assert.equal(hits, 0, 'fresh cache hit must NOT touch the network');

      // (b) fresh UP under a FOREIGN key only → this slot must re-probe → live 500 → DOWN.
      hits = 0;
      const foreignKey = `http://127.0.0.1:${srv.port + 1}`; // different origin, no server there
      seedCache(home, {
        [foreignKey]: { healthy: true, statusCode: 200, error: null, latencyMs: 3, cachedAt: Date.now() },
      });
      health = await runProbe(home, provider);
      assert.equal(health['http-key'].healthy, false,
        "a foreign slot's UP cache must NOT mark this slot available");
      assert.ok(hits >= 1, 'with only a foreign-key entry the slot must re-probe its own upstream');
    } finally {
      await stopServer(srv);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // ── 3. STALE Layer-1 binary cache must be re-probed ───────────────────────
  // A binary entry older than TTL_BIN_MS that says healthy:false must NOT keep a
  // now-present/working binary marked dead. 🔴 healthy-slot-marked-unavailable.
  it('a stale binary (L1) cache entry is re-probed; a working binary overrides stale DOWN', async () => {
    const home = makeHome();
    try {
      const binKey = 'bin:' + NODE; // resolveSpawnTarget → resolvedCli === NODE
      seedCache(home, {
        [binKey]: {
          kind: 'binary', healthy: false, reason: 'STALE-DOWN',
          cachedAt: Date.now() - (TTL_BIN_MS + 60000), // past TTL → stale
        },
      });
      const health = await runProbe(home, [{
        name: 'bin-stale', resolvedCli: NODE, health_check_args: ['-e', 'process.exit(0)'],
      }]);
      assert.equal(health['bin-stale'].healthy, true,
        'stale binary DOWN must be re-probed; a working binary (exit 0) must be HEALTHY');
      assert.doesNotMatch(health['bin-stale'].layer1.reason || '', /STALE-DOWN/,
        'the stale reason must be replaced by a fresh probe result');
      const cache = readCache(home);
      assert.equal(cache.entries[binKey].healthy, true, 'the stale binary entry must be overwritten with the fresh UP verdict');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // ── 4. PARALLEL ISOLATION: one hung slot must not stall/empty the roster ──
  // A slot whose upstream never responds must time out and be marked DOWN while a
  // HEALTHY sibling stays available and the whole call still resolves (bounded by
  // the probe timeout, not hung forever). 🔴 one-bad-slot-crashes/stalls-roster.
  it('one hung HTTP slot times out DOWN while a healthy sibling stays available (no stall, no crash)', async () => {
    const home = makeHome();
    const good = await startServer((req, res) => { res.statusCode = 200; res.end('{}'); });
    const hung = await startServer(() => { /* never responds */ });
    try {
      const t0 = Date.now();
      const health = await runProbe(home, [
        { name: 'http-good', type: 'http', baseUrl: good.url },
        { name: 'http-hung', type: 'http', baseUrl: hung.url },
      ]);
      const elapsed = Date.now() - t0;
      assert.equal(health['http-good'].healthy, true, 'the healthy sibling must remain AVAILABLE');
      assert.equal(health['http-hung'].healthy, false, 'the hung slot must be marked DOWN');
      assert.match(health['http-hung'].layer2.reason || '', /timeout/i, 'hung slot DOWN reason should be a timeout');
      // Probe timeout is 5s; allow node startup slack but prove it is BOUNDED.
      assert.ok(elapsed < 12000, `--all must resolve bounded by the probe timeout, took ${elapsed}ms`);
    } finally {
      await stopServer(good);
      await stopServer(hung);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // ── 5. AVAILABILITY DECISION: a missing binary → DOWN, never a crash ──────
  // A slot whose CLI binary does not exist must be marked unavailable with an
  // explicit reason; a healthy sibling stays available; the probe never throws.
  it('a missing CLI binary marks the slot DOWN (explicit reason) without crashing the roster', async () => {
    const home = makeHome();
    try {
      const health = await runProbe(home, [
        { name: 'bin-missing', cli: '/no/such/path/nf-binary-xyz-123' },
        { name: 'bin-ok', resolvedCli: NODE, health_check_args: ['-e', 'process.exit(0)'] },
      ]);
      assert.equal(health['bin-missing'].healthy, false, 'a missing binary must be DOWN');
      assert.match(health['bin-missing'].layer1.reason || '', /not found|ENOENT|spawn/i,
        'the DOWN reason must explain the missing binary');
      assert.equal(health['bin-ok'].healthy, true, 'a sibling with a working binary must stay AVAILABLE');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // ── 6. BUDGET-MS DEGRADATION (SKIP_L2) + safe defaults ────────────────────
  // --budget-ms below L2_MIN_BUDGET_MS (5500) must skip Layer 2: the slot degrades
  // to AVAILABLE (Layer-1 only) without hitting the upstream — so a hung upstream
  // does NOT stall it. And --budget-ms 0 / non-numeric must fall back to "no
  // budget" (full probe), never accidentally trip SKIP_L2 or hang.
  it('--budget-ms below the L2 floor skips the network probe (fast degrade); 0/non-numeric use the safe default', async () => {
    const home = makeHome();
    const hung = await startServer(() => { /* never responds */ });
    const good = await startServer((req, res) => { res.statusCode = 200; res.end('{}'); });
    try {
      // Tight budget → SKIP_L2. Point at the HUNG upstream: if L2 ran it would
      // block ~5s; skipping it must keep the slot AVAILABLE and return fast.
      const t0 = Date.now();
      const skipped = await runProbe(home, [{ name: 'http-budget', type: 'http', baseUrl: hung.url }],
        { args: ['--budget-ms', '1000'] });
      const elapsed = Date.now() - t0;
      assert.equal(skipped['http-budget'].healthy, true, 'tight budget must degrade the slot to AVAILABLE (L1 only)');
      assert.equal(skipped['http-budget'].layer2.skipped, true, 'Layer 2 must be marked skipped under a tight budget');
      assert.match(skipped['http-budget'].layer2.reason || '', /budget/i, 'skip reason should cite the budget');
      assert.ok(elapsed < 4000, `SKIP_L2 must avoid the hung upstream and return fast, took ${elapsed}ms`);

      // budget 0 and a non-numeric value must NOT trip SKIP_L2 (safe default = no budget).
      for (const bad of ['0', 'abc']) {
        const health = await runProbe(home, [{ name: 'http-default', type: 'http', baseUrl: good.url }],
          { args: ['--budget-ms', bad] });
        assert.notEqual(health['http-default'].layer2.skipped, true,
          `--budget-ms ${bad} must fall back to a full probe (no SKIP_L2)`);
        assert.equal(health['http-default'].healthy, true, `--budget-ms ${bad}: healthy upstream must stay AVAILABLE`);
      }
    } finally {
      await stopServer(hung);
      await stopServer(good);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // ── 7. --no-probe performs ZERO upstream network ──────────────────────────
  // Differential: `--all` probes the HTTP slot (server is hit); `--all --no-probe`
  // emits the roster WITHOUT any network and exits 0.
  it('--all probes the upstream but --all --no-probe touches the network 0 times (exit 0)', async () => {
    const home = makeHome();
    // Global+project nf.json resolve to the same file under cwd=home → active=[]
    // → all providers active (no roster filtering).
    fs.writeFileSync(path.join(home, '.claude', 'nf.json'),
      JSON.stringify({ quorum_active: [], max_quorum_size: 3 }), 'utf8');
    let hits = 0;
    const srv = await startServer((req, res) => { hits++; res.statusCode = 200; res.end('{}'); });
    const provFile = path.join(home, 'providers.json');
    fs.writeFileSync(provFile, JSON.stringify({
      providers: [{ name: 'test-http', type: 'http', baseUrl: srv.url }],
    }));

    // Async child (execNode) so the in-process fake server can answer the probe.
    const runCli = (args) => execNode([SCRIPT, ...args], { home, env: { UNIFIED_PROVIDERS_CONFIG: provFile } });
    try {
      // --all → the slot is probed (server hit at least once).
      const probed = JSON.parse(await runCli(['--all']));
      assert.ok(Array.isArray(probed.available_slots), '--all must emit available_slots');
      assert.ok(hits >= 1, 'sanity: --all must probe the upstream (server should be hit)');

      // --all --no-probe → no further network, roster fields absent, exit 0.
      hits = 0;
      const noProbe = JSON.parse(await runCli(['--all', '--no-probe']));
      assert.equal(hits, 0, '--no-probe must perform ZERO upstream network');
      assert.equal(noProbe.available_slots, undefined, '--no-probe must not emit available_slots');
      assert.equal(typeof noProbe.team, 'object', '--no-probe still emits the team roster');
    } finally {
      await stopServer(srv);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

});

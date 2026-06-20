'use strict';

/**
 * coderlm-adapter.cjs — HTTP adapter for coderlm symbol/call graph server
 *
 * Provides health checks and symbol query methods with timeout and error handling.
 * All methods return result objects (never throw) following fail-open pattern (CADP-02).
 *
 * v0.42: LRU cache (CADP-01), per-session metrics (CADP-03), call-site hardening (CADP-02).
 */

const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');
const { createLRUCache } = require('./coderlm-cache.cjs');

const DEFAULT_HOST = 'http://localhost:8787';
const API_PREFIX = '/api/v1';
const DEFAULT_TIMEOUT_QUERY = 5000;
const DEFAULT_TIMEOUT_HEALTH = 2000;

// Documentation / prose file extensions that coderlm indexes but which are NOT
// real call sites. The server reports text mentions in these files as "callers",
// which inflates caller-count priority ranking in nf:solve (sweepGitHeatmap /
// sweepCtoR / sweepTtoR). Filtering them out keeps caller counts source-accurate.
const NON_SOURCE_CALLER_EXT = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc']);

// Drop caller entries that live in documentation/prose files (a prose mention of
// a symbol is not a call). Conservative: only removes known doc extensions, never
// touches code files. Tolerates string entries and missing/odd shapes (fail-open).
function filterSourceCallers(callers) {
  if (!Array.isArray(callers)) return callers;
  return callers.filter(c => {
    const file = typeof c === 'string' ? c : (c && c.file);
    if (typeof file !== 'string') return true; // unknown shape — keep, don't lose data
    const dot = file.lastIndexOf('.');
    if (dot < 0) return true;
    return !NON_SOURCE_CALLER_EXT.has(file.slice(dot).toLowerCase());
  });
}

/**
 * Parse a URL string into components.
 * @param {string} url
 * @returns {{protocol: string, hostname: string, port: number|null, path: string}}
 */
function parseUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    return {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : null,
      path: parsed.pathname + (parsed.search || ''),
    };
  } catch (e) {
    return {
      protocol: 'http:',
      hostname: 'localhost',
      port: 8787,
      path: '/',
    };
  }
}

/**
 * Make an HTTP GET request and return result.
 * @param {string} url - Full URL to fetch
 * @param {number} timeout - Request timeout in ms
 * @returns {Promise<{status: number, body: string, error?: string}>}
 */
function httpGet(url, timeout, headers) {
  return new Promise((resolve) => {
    const parsed = parseUrl(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path,
      method: 'GET',
      timeout: timeout,
      headers: headers || {},
    };

    let timedOut = false;
    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (!timedOut) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('timeout', () => {
      timedOut = true;
      req.destroy();
      resolve({ error: 'timeout' });
    });

    req.on('error', (e) => {
      if (!timedOut) {
        const code = e.code || e.message;
        resolve({ error: code });
      }
    });

    req.end();
  });
}

function httpPost(url, body, timeout) {
  return new Promise((resolve) => {
    const parsed = parseUrl(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path,
      method: 'POST',
      timeout: timeout,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    let timedOut = false;
    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (!timedOut) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('timeout', () => {
      timedOut = true;
      req.destroy();
      resolve({ error: 'timeout' });
    });
    req.on('error', (e) => {
      if (!timedOut) {
        resolve({ error: e.code || e.message });
      }
    });
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Create an adapter instance with configurable options.
 * @param {Object} opts - Configuration options
 * @param {string} opts.host - Server URL (default: NF_CODERLM_HOST or http://localhost:8787)
 * @param {number} opts.timeout - Query timeout in ms (default: 5000)
 * @param {number} opts.healthTimeout - Health check timeout in ms (default: 2000)
 * @param {boolean} opts.enabled - Whether adapter is enabled (default: true)
 * @returns {Object} Adapter object with health() and query methods
 */
function createAdapter(opts = {}) {
  // Default: enabled=true — lifecycle module manages server availability.
  // NF_CODERLM_ENABLED env var is no longer required (self-enabling with fail-open).
  // Pass enabled:false explicitly to disable for testing.
  const enabled = opts.enabled !== undefined ? opts.enabled : true;
  const host = opts.host || process.env.NF_CODERLM_HOST || DEFAULT_HOST;
  const timeout = opts.timeout !== undefined ? opts.timeout : DEFAULT_TIMEOUT_QUERY;
  const healthTimeout = opts.healthTimeout !== undefined ? opts.healthTimeout : DEFAULT_TIMEOUT_HEALTH;

  // CADP-01: LRU cache for query results (100 entries, 5-min TTL, per-adapter-instance)
  const _cache = createLRUCache(100, 5 * 60 * 1000);
  // CADP-03: Per-session metrics (accumulated across all query calls on this adapter)
  const _metrics = { queryCount: 0, totalLatencyMs: 0 };
  // coderlm session: created once per adapter, reused for all queries
  let _sessionId = null;

  async function ensureSession() {
    if (_sessionId) return _sessionId;
    try {
      const cwd = process.cwd();
      const result = await httpPost(host + API_PREFIX + '/sessions', { cwd }, timeout);
      if (result.status === 200 || result.status === 201) {
        const parsed = JSON.parse(result.body);
        _sessionId = parsed.session_id;
        return _sessionId;
      }
    } catch (_) { /* fail-open */ }
    return null;
  }

  function ensureSessionSync() {
    if (_sessionId) return _sessionId;
    try {
      const parsed = parseUrl(host);
      const port = parsed.port || (parsed.protocol === 'https:' ? 443 : 80);
      const cwd = process.cwd();
      const script = `
const http = require('http');
const req = http.request(
  { hostname: ${JSON.stringify(parsed.hostname)}, port: ${port}, path: '${API_PREFIX}/sessions', method: 'POST',
    headers: { 'Content-Type': 'application/json' } },
  res => {
    let d = '';
    res.on('data', c => { d += c; });
    res.on('end', () => { process.stdout.write(d); });
  }
);
req.on('error', () => { process.stdout.write('{}'); });
req.write(JSON.stringify({ cwd: ${JSON.stringify(cwd)} }));
req.end();
`;
      const r = spawnSync('node', ['-e', script], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0 && r.stdout) {
        const parsed = JSON.parse(r.stdout.trim());
        if (parsed.session_id) {
          _sessionId = parsed.session_id;
        }
      }
    } catch (_) { /* fail-open */ }
    return _sessionId;
  }

  function sessionHeaders() {
    return _sessionId ? { 'X-Session-Id': _sessionId } : {};
  }

  const adapter = {
    /**
     * Async health check — checks if coderlm server is responding.
     * @returns {Promise<{healthy: boolean, latencyMs: number, error?: string}>}
     */
    async health() {
      if (!enabled) {
        return { healthy: false, latencyMs: 0, error: 'disabled' };
      }
      try {
        const start = Date.now();
        const result = await httpGet(host + API_PREFIX + '/health', healthTimeout);
        const latencyMs = Date.now() - start;
        if (result.error) {
          return { healthy: false, latencyMs, error: result.error };
        }
        if (result.status === 200) {
          return { healthy: true, latencyMs };
        }
        return { healthy: false, latencyMs, error: 'HTTP ' + result.status };
      } catch (e) {
        return { healthy: false, latencyMs: 0, error: e.message }; // CADP-02: never throw
      }
    },

    /**
     * Synchronous health check using spawnSync pattern.
     * Spawns a node process to perform async HTTP check and parse result from stdout.
     * Health checks are NOT cached (always fresh) and do NOT count toward metrics.
     * @returns {{healthy: boolean, latencyMs: number, error?: string}}
     */
    healthSync() {
      if (!enabled) {
        return { healthy: false, latencyMs: 0, error: 'disabled' };
      }
      try {
        const parsed = parseUrl(host);
        const port = parsed.port || (parsed.protocol === 'https:' ? 443 : 80);
        const script = `
const http = require('http');
const https = require('https');
const protocol = ${JSON.stringify(parsed.protocol)};
const hostname = ${JSON.stringify(parsed.hostname)};
const port = ${port};
const timeout = ${healthTimeout};
const client = protocol === 'https:' ? https : http;
async function check() {
  return new Promise(resolve => {
    const start = Date.now();
    let timedOut = false;
    const options = {
      hostname: hostname,
      port: port,
      path: ${JSON.stringify(API_PREFIX + '/health')},
      method: 'GET',
      timeout: timeout
    };
    const req = client.request(options, res => {
      if (!timedOut && res.statusCode === 200) {
        resolve({ healthy: true, latencyMs: Date.now() - start });
      } else {
        resolve({ healthy: false, latencyMs: Date.now() - start, error: 'HTTP ' + (res.statusCode || 0) });
      }
    });
    req.on('timeout', () => {
      timedOut = true;
      req.destroy();
      resolve({ healthy: false, latencyMs: Date.now() - start, error: 'timeout' });
    });
    req.on('error', e => {
      if (!timedOut) {
        resolve({ healthy: false, latencyMs: Date.now() - start, error: e.code || 'error' });
      }
    });
    req.end();
  });
}
check().then(r => console.log(JSON.stringify(r)));
`;
        const result = spawnSync('node', ['-e', script], {
          timeout: healthTimeout + 1000,
          encoding: 'utf8',
        });
        if (result.status === 0 && result.stdout) {
          const parsed = JSON.parse(result.stdout.trim());
          return parsed;
        }
        return { healthy: false, latencyMs: 0, error: 'sync-spawn-failed' };
      } catch (e) {
        return { healthy: false, latencyMs: 0, error: 'sync-spawn-failed' }; // CADP-02: never throw
      }
    },

    /**
     * Get callers of a symbol (async).
     * Checks cache first; on miss, fetches from server and caches result.
     * @param {string} symbol - Symbol name
     * @param {string} file - File path
     * @returns {Promise<{callers?: string[], error?: string}>}
     */
    async getCallers(symbol, file) {
      if (!enabled) {
        return { error: 'disabled' };
      }
      const cacheKey = JSON.stringify({ method: 'getCallers', symbol, file });
      const cached = _cache.get(cacheKey);
      if (cached !== undefined) return cached;
      const start = Date.now();
      try {
        await ensureSession();
        const url = host + API_PREFIX + '/symbols/callers?symbol=' + encodeURIComponent(symbol) + '&file=' + encodeURIComponent(file);
        const result = await httpGet(url, timeout, sessionHeaders());
        _metrics.queryCount++;
        _metrics.totalLatencyMs += Date.now() - start;
        if (result.error) {
          const out = { error: result.error };
          _cache.set(cacheKey, out);
          return out;
        }
        if (result.status === 200) {
          try {
            const parsed = JSON.parse(result.body);
            const out = { callers: filterSourceCallers(parsed.callers || []) };
            _cache.set(cacheKey, out);
            return out;
          } catch {
            const out = { error: 'parse' };
            return out;
          }
        }
        return { error: 'HTTP ' + result.status };
      } catch (e) {
        _metrics.queryCount++;
        _metrics.totalLatencyMs += Date.now() - start;
        return { error: e.message }; // CADP-02: never throw
      }
    },

    /**
     * Synchronous wrapper for getCallers using spawnSync pattern.
     * Checks cache first; on miss, spawns node process to perform async HTTP GET.
     * Tracks queryCount and totalLatencyMs for CADP-03 session metrics.
     * @param {string} symbol - Symbol name
     * @param {string} file - File path
     * @returns {{callers?: string[], error?: string}}
     */
    getCallersSync(symbol, file) {
      if (!enabled) {
        return { error: 'disabled' };
      }
      const cacheKey = JSON.stringify({ method: 'getCallersSync', symbol, file });
      const cached = _cache.get(cacheKey);
      if (cached !== undefined) return cached;
      const start = Date.now();
      try {
        ensureSessionSync();
        const parsed = parseUrl(host);
        const port = parsed.port || (parsed.protocol === 'https:' ? 443 : 80);
        const sessionId = _sessionId || '';
        const script = `
const http = require('http');
const https = require('https');
const protocol = ${JSON.stringify(parsed.protocol)};
const hostname = ${JSON.stringify(parsed.hostname)};
const port = ${port};
const sessionId = ${JSON.stringify(sessionId)};
const symbol = ${JSON.stringify(symbol)};
const file = ${JSON.stringify(file)};
const timeout = ${timeout};
const client = protocol === 'https:' ? https : http;
async function getCallers() {
  return new Promise(resolve => {
    let timedOut = false;
    const path = ${JSON.stringify(API_PREFIX)} + '/symbols/callers?symbol=' + encodeURIComponent(symbol) + '&file=' + encodeURIComponent(file);
    const options = {
      hostname: hostname,
      port: port,
      path: path,
      method: 'GET',
      timeout: timeout,
      headers: sessionId ? { 'X-Session-Id': sessionId } : {}
    };
    const req = client.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (!timedOut) {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              resolve({ callers: parsed.callers || [] });
            } catch (e) {
              resolve({ error: 'parse' });
            }
          } else {
            resolve({ error: 'HTTP ' + res.statusCode });
          }
        }
      });
    });
    req.on('timeout', () => {
      timedOut = true;
      req.destroy();
      resolve({ error: 'timeout' });
    });
    req.on('error', e => {
      if (!timedOut) {
        resolve({ error: e.code || 'error' });
      }
    });
    req.end();
  });
}
getCallers().then(r => console.log(JSON.stringify(r)));
`;
        const result = spawnSync('node', ['-e', script], {
          timeout: timeout + 1000,
          encoding: 'utf8',
        });
        _metrics.queryCount++;
        _metrics.totalLatencyMs += Date.now() - start;
        if (result.status === 0 && result.stdout) {
          const out = JSON.parse(result.stdout.trim());
          if (out && Array.isArray(out.callers)) out.callers = filterSourceCallers(out.callers);
          _cache.set(cacheKey, out);
          return out;
        }
        return { error: 'sync-spawn-failed' };
      } catch (e) {
        _metrics.queryCount++;
        _metrics.totalLatencyMs += Date.now() - start;
        return { error: e.message || 'sync-spawn-failed' }; // CADP-02: never throw
      }
    },

    /**
     * Synchronous wrapper for getImplementation using spawnSync pattern.
     * Checks cache first; on miss, spawns node process to perform async HTTP GET.
     * Tracks queryCount and totalLatencyMs for CADP-03 session metrics.
     *
     * Pre-flight note: the live /implementation endpoint returns { file, line } (not a nested
     * `implementation` object). This matches the shape parsed by the async getImplementation()
     * method. Response does NOT include a callers array, so queryEdgesSync falls back to
     * getCallersSync for caller discovery.
     *
     * @param {string} symbol - Symbol name
     * @returns {{file?: string, line?: number, error?: string}}
     */
    getImplementationSync(symbol) {
      if (!enabled) {
        return { error: 'disabled' };
      }
      const cacheKey = JSON.stringify({ method: 'getImplementationSync', symbol });
      const cached = _cache.get(cacheKey);
      if (cached !== undefined) return cached;
      const start = Date.now();
      try {
        ensureSessionSync();
        const parsed = parseUrl(host);
        const port = parsed.port || (parsed.protocol === 'https:' ? 443 : 80);
        const sessionId = _sessionId || '';
        const script = `
const http = require('http');
const https = require('https');
const protocol = ${JSON.stringify(parsed.protocol)};
const hostname = ${JSON.stringify(parsed.hostname)};
const port = ${port};
const sessionId = ${JSON.stringify(sessionId)};
const symbol = ${JSON.stringify(symbol)};
const timeout = ${timeout};
const client = protocol === 'https:' ? https : http;
async function getImplementation() {
  return new Promise(resolve => {
    let timedOut = false;
    const path = ${JSON.stringify(API_PREFIX)} + '/symbols/implementation?symbol=' + encodeURIComponent(symbol);
    const options = {
      hostname: hostname,
      port: port,
      path: path,
      method: 'GET',
      timeout: timeout,
      headers: sessionId ? { 'X-Session-Id': sessionId } : {}
    };
    const req = client.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (!timedOut) {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              // Live endpoint returns { file, line } — match async getImplementation() shape
              resolve({ file: parsed.file, line: parsed.line });
            } catch (e) {
              resolve({ error: 'parse' });
            }
          } else {
            resolve({ error: 'HTTP ' + res.statusCode });
          }
        }
      });
    });
    req.on('timeout', () => {
      timedOut = true;
      req.destroy();
      resolve({ error: 'timeout' });
    });
    req.on('error', e => {
      if (!timedOut) {
        resolve({ error: e.code || 'error' });
      }
    });
    req.end();
  });
}
getImplementation().then(r => console.log(JSON.stringify(r)));
`;
        const result = spawnSync('node', ['-e', script], {
          timeout: timeout + 1000,
          encoding: 'utf8',
        });
        _metrics.queryCount++;
        _metrics.totalLatencyMs += Date.now() - start;
        if (result.status === 0 && result.stdout) {
          const out = JSON.parse(result.stdout.trim());
          if (out && Array.isArray(out.callers)) out.callers = filterSourceCallers(out.callers);
          _cache.set(cacheKey, out);
          return out;
        }
        return { error: 'sync-spawn-failed' };
      } catch (e) {
        _metrics.queryCount++;
        _metrics.totalLatencyMs += Date.now() - start;
        return { error: e.message || 'sync-spawn-failed' }; // CADP-02: never throw
      }
    },

    /**
     * Get implementation location of a symbol (async).
     * Checks cache first; on miss, fetches from server and caches result.
     * @param {string} symbol - Symbol name
     * @returns {Promise<{file?: string, line?: number, error?: string}>}
     */
    async getImplementation(symbol) {
      if (!enabled) {
        return { error: 'disabled' };
      }
      const cacheKey = JSON.stringify({ method: 'getImplementation', symbol });
      const cached = _cache.get(cacheKey);
      if (cached !== undefined) return cached;
      const start = Date.now();
      try {
        await ensureSession();
        const url = host + API_PREFIX + '/symbols/implementation?symbol=' + encodeURIComponent(symbol);
        const result = await httpGet(url, timeout, sessionHeaders());
        _metrics.queryCount++;
        _metrics.totalLatencyMs += Date.now() - start;
        if (result.error) {
          return { error: result.error };
        }
        if (result.status === 200) {
          try {
            const parsed = JSON.parse(result.body);
            const out = { file: parsed.file, line: parsed.line };
            _cache.set(cacheKey, out);
            return out;
          } catch {
            return { error: 'parse' };
          }
        }
        return { error: 'HTTP ' + result.status };
      } catch (e) {
        _metrics.queryCount++;
        _metrics.totalLatencyMs += Date.now() - start;
        return { error: e.message }; // CADP-02: never throw
      }
    },

    /**
     * Find tests for a file (async).
     * Checks cache first; on miss, fetches from server and caches result.
     * @param {string} file - File path
     * @returns {Promise<{tests?: string[], error?: string}>}
     */
    async findTests(file) {
      if (!enabled) {
        return { error: 'disabled' };
      }
      const cacheKey = JSON.stringify({ method: 'findTests', file });
      const cached = _cache.get(cacheKey);
      if (cached !== undefined) return cached;
      const start = Date.now();
      try {
        await ensureSession();
        const url = host + API_PREFIX + '/symbols/tests?file=' + encodeURIComponent(file);
        const result = await httpGet(url, timeout, sessionHeaders());
        _metrics.queryCount++;
        _metrics.totalLatencyMs += Date.now() - start;
        if (result.error) {
          return { error: result.error };
        }
        if (result.status === 200) {
          try {
            const parsed = JSON.parse(result.body);
            const out = { tests: parsed.tests || [] };
            _cache.set(cacheKey, out);
            return out;
          } catch {
            return { error: 'parse' };
          }
        }
        return { error: 'HTTP ' + result.status };
      } catch (e) {
        _metrics.queryCount++;
        _metrics.totalLatencyMs += Date.now() - start;
        return { error: e.message }; // CADP-02: never throw
      }
    },

    /**
     * Peek at file content between line numbers (async).
     * Checks cache first; on miss, fetches from server and caches result.
     * @param {string} file - File path
     * @param {number} startLine - Start line (inclusive)
     * @param {number} endLine - End line (inclusive)
     * @returns {Promise<{lines?: string[], error?: string}>}
     */
    async peek(file, startLine, endLine) {
      if (!enabled) {
        return { error: 'disabled' };
      }
      const cacheKey = JSON.stringify({ method: 'peek', file, startLine, endLine });
      const cached = _cache.get(cacheKey);
      if (cached !== undefined) return cached;
      const start = Date.now();
      try {
        await ensureSession();
        const url = host + API_PREFIX + '/peek?file=' + encodeURIComponent(file) +
                    '&start=' + encodeURIComponent(startLine) +
                    '&end=' + encodeURIComponent(endLine);
        const result = await httpGet(url, timeout, sessionHeaders());
        _metrics.queryCount++;
        _metrics.totalLatencyMs += Date.now() - start;
        if (result.error) {
          return { error: result.error };
        }
        if (result.status === 200) {
          try {
            const parsed = JSON.parse(result.body);
            const out = { lines: parsed.lines || [] };
            _cache.set(cacheKey, out);
            return out;
          } catch {
            return { error: 'parse' };
          }
        }
        return { error: 'HTTP ' + result.status };
      } catch (e) {
        _metrics.queryCount++;
        _metrics.totalLatencyMs += Date.now() - start;
        return { error: e.message }; // CADP-02: never throw
      }
    },

    /**
     * Get per-session metrics accumulated since adapter creation or last resetCache().
     * Used by nf-solve.cjs to emit CADP-03 diagnostic output to stderr.
     * @returns {{ queryCount: number, cacheHits: number, cacheMisses: number, cacheHitRate: number, totalLatencyMs: number, avgLatencyMs: number }}
     */
    getSessionMetrics() {
      const cacheStats = _cache.stats();
      return {
        queryCount: _metrics.queryCount,
        cacheHits: cacheStats.hits,
        cacheMisses: cacheStats.misses,
        cacheHitRate: cacheStats.hitRate,
        totalLatencyMs: _metrics.totalLatencyMs,
        avgLatencyMs: _metrics.queryCount > 0 ? _metrics.totalLatencyMs / _metrics.queryCount : 0,
      };
    },

    /**
     * Reset the LRU cache and all session metrics.
     * Called at the start of each solve session (CADP-01: cleared at loop start).
     */
    resetCache() {
      _cache.reset();
      _metrics.queryCount = 0;
      _metrics.totalLatencyMs = 0;
    },
  };

  return adapter;
}

/**
 * Standalone health check function.
 * @param {string} host - Server URL (optional, default http://localhost:8787)
 * @param {number} timeout - Timeout in ms (optional, default 2000)
 * @returns {Promise<{healthy: boolean, latencyMs: number, error?: string}>}
 */
async function healthCheck(host, timeout) {
  const url = host || DEFAULT_HOST;
  const t = timeout || DEFAULT_TIMEOUT_HEALTH;
  const start = Date.now();
  const result = await httpGet(url + API_PREFIX + '/health', t);
  const latencyMs = Date.now() - start;
  if (result.error) {
    return { healthy: false, latencyMs, error: result.error };
  }
  if (result.status === 200) {
    return { healthy: true, latencyMs };
  }
  return { healthy: false, latencyMs, error: 'HTTP ' + result.status };
}

module.exports = {
  createAdapter,
  healthCheck,
  filterSourceCallers,
};

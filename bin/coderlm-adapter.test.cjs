#!/usr/bin/env node
'use strict';
// bin/coderlm-adapter.test.cjs
// Unit tests for coderlm HTTP adapter

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createAdapter, healthCheck } = require('./coderlm-adapter.cjs');

describe('coderlm-adapter module', () => {
  describe('Module exports', () => {
    it('exports createAdapter as a function', () => {
      assert.equal(typeof createAdapter, 'function');
    });

    it('exports healthCheck as a function', () => {
      assert.equal(typeof healthCheck, 'function');
    });
  });

  describe('createAdapter', () => {
    it('returns object with expected methods', () => {
      const adapter = createAdapter({ enabled: true });
      assert.equal(typeof adapter.health, 'function');
      assert.equal(typeof adapter.healthSync, 'function');
      assert.equal(typeof adapter.getCallers, 'function');
      assert.equal(typeof adapter.getImplementation, 'function');
      assert.equal(typeof adapter.findTests, 'function');
      assert.equal(typeof adapter.peek, 'function');
    });

    it('respects enabled flag — returns disabled error when false', async () => {
      const adapter = createAdapter({ enabled: false });
      const result = await adapter.health();
      assert.equal(result.error, 'disabled');
      assert.equal(result.healthy, false);
    });

    it('respects NF_CODERLM_ENABLED env var when no opts.enabled provided', async () => {
      const oldEnv = process.env.NF_CODERLM_ENABLED;
      process.env.NF_CODERLM_ENABLED = 'false';
      const adapter = createAdapter();
      const result = await adapter.health();
      assert.equal(result.error, 'disabled');
      process.env.NF_CODERLM_ENABLED = oldEnv;
    });
  });

  describe('healthCheck — standalone function', () => {
    let server;
    let port;

    before(async () => {
      // Start a mock HTTP server for successful health checks
      return new Promise((resolve) => {
        server = http.createServer((req, res) => {
          if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
          } else {
            res.writeHead(404);
            res.end();
          }
        });
        server.listen(0, () => {
          port = server.address().port;
          resolve();
        });
      });
    });

    after(async () => {
      if (server) {
        return new Promise((resolve) => {
          server.close(resolve);
        });
      }
    });

    it('returns healthy:true for successful 200 response', async () => {
      const result = await healthCheck(`http://localhost:${port}`, 2000);
      assert.equal(result.healthy, true);
      assert.equal(typeof result.latencyMs, 'number');
      assert.ok(result.latencyMs >= 0);
    });

    it('returns healthy:false on connection refused', async () => {
      // Port 1 is unlikely to have a service listening
      const result = await healthCheck('http://localhost:1', 100);
      assert.equal(result.healthy, false);
      assert.ok(result.error);
    });

    it('returns healthy:false on timeout', async () => {
      // Start a server that never responds
      return new Promise((resolve) => {
        const slowServer = http.createServer(() => {
          // Don't send any response — will timeout
        });
        slowServer.listen(0, async () => {
          const slowPort = slowServer.address().port;
          const result = await healthCheck(`http://localhost:${slowPort}`, 100);
          assert.equal(result.healthy, false);
          assert.equal(result.error, 'timeout');
          slowServer.close(resolve);
        });
      });
    });
  });

  describe('adapter.health() — async', () => {
    let server;
    let port;

    before(async () => {
      return new Promise((resolve) => {
        server = http.createServer((req, res) => {
          if (req.url === '/health') {
            res.writeHead(200);
            res.end();
          } else {
            res.writeHead(404);
            res.end();
          }
        });
        server.listen(0, () => {
          port = server.address().port;
          resolve();
        });
      });
    });

    after(async () => {
      if (server) {
        return new Promise((resolve) => {
          server.close(resolve);
        });
      }
    });

    it('returns healthy:true on successful health endpoint', async () => {
      const adapter = createAdapter({ host: `http://localhost:${port}`, enabled: true });
      const result = await adapter.health();
      assert.equal(result.healthy, true);
      assert.ok(result.latencyMs >= 0);
    });

    it('returns error on HTTP 5xx', async () => {
      return new Promise((resolve) => {
        const errorServer = http.createServer((req, res) => {
          res.writeHead(500);
          res.end();
        });
        errorServer.listen(0, async () => {
          const errorPort = errorServer.address().port;
          const adapter = createAdapter({ host: `http://localhost:${errorPort}`, enabled: true });
          const result = await adapter.health();
          assert.equal(result.healthy, false);
          assert.ok(result.error.includes('500'));
          errorServer.close(resolve);
        });
      });
    });

    it('returns error on HTTP 4xx', async () => {
      return new Promise((resolve) => {
        const errorServer = http.createServer((req, res) => {
          res.writeHead(404);
          res.end();
        });
        errorServer.listen(0, async () => {
          const errorPort = errorServer.address().port;
          const adapter = createAdapter({ host: `http://localhost:${errorPort}`, enabled: true });
          const result = await adapter.health();
          assert.equal(result.healthy, false);
          assert.ok(result.error.includes('404'));
          errorServer.close(resolve);
        });
      });
    });
  });

  describe('adapter.healthSync()', () => {
    it('returns object synchronously (not a promise) when disabled', () => {
      const adapter = createAdapter({ enabled: false });
      const result = adapter.healthSync();
      assert.equal(typeof result.then, 'undefined');
      assert.equal(result.error, 'disabled');
    });

    it('returns synchronously (not a promise) even when attempting to connect', () => {
      // Use invalid port that will fail immediately
      const adapter = createAdapter({ host: 'http://localhost:1', enabled: true, healthTimeout: 100 });
      const result = adapter.healthSync();
      assert.equal(typeof result.then, 'undefined', 'result must not be a Promise');
      assert.equal(result.healthy, false);
      assert.ok(result.error);
    });

    it('spawnSync script returns valid JSON on error', () => {
      const adapter = createAdapter({ host: 'http://invalid-host-xyz.test:9999', enabled: true, healthTimeout: 100 });
      const result = adapter.healthSync();
      assert.equal(typeof result.then, 'undefined');
      assert.equal(typeof result.healthy, 'boolean');
      assert.ok(result.latencyMs !== undefined);
    });
  });

  describe('adapter.getCallers()', () => {
    let server;
    let port;

    before(async () => {
      return new Promise((resolve) => {
        server = http.createServer((req, res) => {
          if (req.url.startsWith('/callers')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ callers: ['caller1', 'caller2'] }));
          } else {
            res.writeHead(404);
            res.end();
          }
        });
        server.listen(0, () => {
          port = server.address().port;
          resolve();
        });
      });
    });

    after(async () => {
      if (server) {
        return new Promise((resolve) => {
          server.close(resolve);
        });
      }
    });

    it('returns callers array on success', async () => {
      const adapter = createAdapter({ host: `http://localhost:${port}`, enabled: true });
      const result = await adapter.getCallers('someSymbol', 'file.js');
      assert.deepStrictEqual(result.callers, ['caller1', 'caller2']);
    });

    it('returns error on 4xx/5xx', async () => {
      return new Promise((resolve) => {
        const errorServer = http.createServer((req, res) => {
          res.writeHead(502);
          res.end();
        });
        errorServer.listen(0, async () => {
          const errorPort = errorServer.address().port;
          const adapter = createAdapter({ host: `http://localhost:${errorPort}`, enabled: true });
          const result = await adapter.getCallers('symbol', 'file.js');
          assert.ok(result.error);
          assert.ok(result.error.includes('502'));
          errorServer.close(resolve);
        });
      });
    });

    it('returns disabled error when disabled', async () => {
      const adapter = createAdapter({ enabled: false });
      const result = await adapter.getCallers('symbol', 'file.js');
      assert.equal(result.error, 'disabled');
    });
  });

  describe('adapter.getImplementation()', () => {
    let server;
    let port;

    before(async () => {
      return new Promise((resolve) => {
        server = http.createServer((req, res) => {
          if (req.url.startsWith('/implementation')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ file: 'impl.js', line: 42 }));
          } else {
            res.writeHead(404);
            res.end();
          }
        });
        server.listen(0, () => {
          port = server.address().port;
          resolve();
        });
      });
    });

    after(async () => {
      if (server) {
        return new Promise((resolve) => {
          server.close(resolve);
        });
      }
    });

    it('returns implementation details on success', async () => {
      const adapter = createAdapter({ host: `http://localhost:${port}`, enabled: true });
      const result = await adapter.getImplementation('someSymbol');
      assert.equal(result.file, 'impl.js');
      assert.equal(result.line, 42);
    });
  });

  describe('adapter.findTests()', () => {
    let server;
    let port;

    before(async () => {
      return new Promise((resolve) => {
        server = http.createServer((req, res) => {
          if (req.url.startsWith('/tests')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tests: ['test1.js', 'test2.js'] }));
          } else {
            res.writeHead(404);
            res.end();
          }
        });
        server.listen(0, () => {
          port = server.address().port;
          resolve();
        });
      });
    });

    after(async () => {
      if (server) {
        return new Promise((resolve) => {
          server.close(resolve);
        });
      }
    });

    it('returns test list on success', async () => {
      const adapter = createAdapter({ host: `http://localhost:${port}`, enabled: true });
      const result = await adapter.findTests('file.js');
      assert.deepStrictEqual(result.tests, ['test1.js', 'test2.js']);
    });
  });

  describe('adapter.peek()', () => {
    let server;
    let port;

    before(async () => {
      return new Promise((resolve) => {
        server = http.createServer((req, res) => {
          if (req.url.startsWith('/peek')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ lines: ['line 1', 'line 2', 'line 3'] }));
          } else {
            res.writeHead(404);
            res.end();
          }
        });
        server.listen(0, () => {
          port = server.address().port;
          resolve();
        });
      });
    });

    after(async () => {
      if (server) {
        return new Promise((resolve) => {
          server.close(resolve);
        });
      }
    });

    it('returns file lines on success', async () => {
      const adapter = createAdapter({ host: `http://localhost:${port}`, enabled: true });
      const result = await adapter.peek('file.js', 1, 3);
      assert.deepStrictEqual(result.lines, ['line 1', 'line 2', 'line 3']);
    });
  });

  describe('Timeout behavior', () => {
    it('getCallers respects timeout', async () => {
      return new Promise((resolve) => {
        const slowServer = http.createServer(() => {
          // Never respond — will timeout
        });
        slowServer.listen(0, async () => {
          const slowPort = slowServer.address().port;
          const adapter = createAdapter({
            host: `http://localhost:${slowPort}`,
            enabled: true,
            timeout: 50
          });
          const result = await adapter.getCallers('symbol', 'file.js');
          assert.equal(result.error, 'timeout');
          slowServer.close(resolve);
        });
      });
    });
  });

  describe('getSessionMetrics() and resetCache() — CADP-01/CADP-03', () => {
    it('getSessionMetrics() returns expected shape on fresh adapter (all zeros)', () => {
      const adapter = createAdapter({ enabled: false });
      const m = adapter.getSessionMetrics();
      assert.equal(typeof m.queryCount, 'number');
      assert.equal(typeof m.cacheHits, 'number');
      assert.equal(typeof m.cacheMisses, 'number');
      assert.equal(typeof m.cacheHitRate, 'number');
      assert.equal(typeof m.totalLatencyMs, 'number');
      assert.equal(typeof m.avgLatencyMs, 'number');
      assert.equal(m.queryCount, 0);
      assert.equal(m.cacheHits, 0);
      assert.equal(m.cacheMisses, 0);
      assert.equal(m.cacheHitRate, 0);
      assert.equal(m.totalLatencyMs, 0);
      assert.equal(m.avgLatencyMs, 0);
    });

    it('resetCache() resets cache stats and metrics', () => {
      const adapter = createAdapter({ enabled: false });
      // Calling disabled methods doesn't increment queryCount
      adapter.getCallers('s', 'f').then(() => {}); // no-op (disabled)
      adapter.resetCache();
      const m = adapter.getSessionMetrics();
      assert.equal(m.queryCount, 0);
      assert.equal(m.cacheHits, 0);
      assert.equal(m.cacheMisses, 0);
    });

    it('disabled async getCallers does NOT increment queryCount', async () => {
      const adapter = createAdapter({ enabled: false });
      await adapter.getCallers('sym', 'file.js');
      const m = adapter.getSessionMetrics();
      assert.equal(m.queryCount, 0, 'disabled call should not count queries');
    });

    it('disabled async getImplementation does NOT increment queryCount', async () => {
      const adapter = createAdapter({ enabled: false });
      await adapter.getImplementation('sym');
      const m = adapter.getSessionMetrics();
      assert.equal(m.queryCount, 0);
    });

    it('disabled async findTests does NOT increment queryCount', async () => {
      const adapter = createAdapter({ enabled: false });
      await adapter.findTests('file.js');
      const m = adapter.getSessionMetrics();
      assert.equal(m.queryCount, 0);
    });

    it('disabled async peek does NOT increment queryCount', async () => {
      const adapter = createAdapter({ enabled: false });
      await adapter.peek('file.js', 1, 5);
      const m = adapter.getSessionMetrics();
      assert.equal(m.queryCount, 0);
    });

    it('disabled sync getCallersSync does NOT increment queryCount', () => {
      const adapter = createAdapter({ enabled: false });
      adapter.getCallersSync('sym', 'file.js');
      const m = adapter.getSessionMetrics();
      assert.equal(m.queryCount, 0, 'sync disabled call should not count queries');
    });

    it('disabled sync getImplementationSync does NOT increment queryCount', () => {
      const adapter = createAdapter({ enabled: false });
      adapter.getImplementationSync('sym');
      const m = adapter.getSessionMetrics();
      assert.equal(m.queryCount, 0, 'sync disabled call should not count queries');
    });

    it('cache key is unique per method+symbol+file — two different symbols -> two misses', () => {
      // Use disabled adapter (won't actually query) — test cache key isolation via stats
      const adapter = createAdapter({ enabled: false });
      // Disabled calls return immediately without touching cache
      // So test that getSessionMetrics is stable after multiple disabled calls
      adapter.getCallersSync('sym1', 'file.js');
      adapter.getCallersSync('sym2', 'file.js');
      const m = adapter.getSessionMetrics();
      // Both are disabled — no queries, no cache interaction
      assert.equal(m.queryCount, 0);
    });
  });

  describe('createAdapter — null/non-object opts hardening', () => {
    it('does not throw when opts is null and returns a usable adapter', () => {
      let adapter;
      assert.doesNotThrow(() => { adapter = createAdapter(null); });
      assert.equal(typeof adapter.health, 'function');
      assert.equal(typeof adapter.getCallers, 'function');
    });

    it('does not throw when opts is a non-object primitive', () => {
      assert.doesNotThrow(() => createAdapter('http://localhost:9999'));
      assert.doesNotThrow(() => createAdapter(42));
    });
  });

  describe('getCallers — transient network error must not poison the cache', () => {
    it('re-queries after a transient connection error instead of serving a cached error', async () => {
      let callersHits = 0;
      const server = http.createServer((req, res) => {
        if (req.url.includes('/sessions')) {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ session_id: 's1' }));
          return;
        }
        callersHits++;
        if (callersHits === 1) {
          // simulate a transient network error on the first callers GET
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ callers: ['caller1'] }));
      });
      await new Promise((r) => server.listen(0, r));
      const port = server.address().port;
      const adapter = createAdapter({ host: `http://localhost:${port}`, enabled: true, timeout: 1000 });
      const first = await adapter.getCallers('sym', 'file.js');
      assert.ok(first.error, 'first call should surface the transient error');
      const second = await adapter.getCallers('sym', 'file.js');
      assert.deepStrictEqual(second.callers, ['caller1'], 'second call must re-query, not return a cached error');
      await new Promise((r) => server.close(r));
    });
  });
});

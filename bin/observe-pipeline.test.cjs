'use strict';

// bin/observe-pipeline.test.cjs
// Tests for observe-pipeline.cjs — the shared programmatic observe pipeline

// refreshDebtLedger always injects the `internal` source and dispatches it. The
// internal handler's live diagnostic probes (categories 6–14, 17) spawnSync
// installed scripts that hit the network / MCP fleet, so an un-suppressed
// dispatch hangs (>100s). Suppress them fleet-wide for this suite via the same
// env flag the handler honors; the adversarial null/string-opts cases can't pass
// an opts flag, so the env is the only channel that covers every path. Node runs
// each test file in its own child process, so this cannot leak to other suites.
process.env.NF_OBSERVE_SKIP_LIVE_PROBES = '1';

const assert = require('assert');
const { describe, it, before, after } = require('node:test');
const path = require('path');
const fs = require('fs');
const os = require('os');

// refreshDebtLedger loads config from process.cwd()'s .planning/observe-sources.md
// and dispatches every configured source (github → gh, deps → npm, upstream → gh,
// …) — all real subprocess/network calls that hang in CI. These are unit tests of
// refreshDebtLedger's own logic (source injection, zero-state, adversarial opts),
// not integration tests of live sources, so run the whole suite in an empty temp
// cwd: loadObserveConfig then finds no config and only the (probe-suppressed)
// internal source is dispatched. cwd is restored in after().
let _savedCwd;
let _tmpCwd;
before(() => {
  _savedCwd = process.cwd();
  _tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-pipeline-cwd-'));
  // A *valid but source-less* config: loadObserveConfig returns no error (so
  // refreshDebtLedger proceeds to inject the internal source) yet dispatches no
  // real, shell-out-backed source. An entirely empty cwd would instead yield a
  // 'no sources configured' error and short-circuit before injection.
  fs.mkdirSync(path.join(_tmpCwd, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(_tmpCwd, '.planning', 'observe-sources.md'), '---\nsources: []\n---\n');
  process.chdir(_tmpCwd);
});
after(() => {
  process.chdir(_savedCwd);
  fs.rmSync(_tmpCwd, { recursive: true, force: true });
});

describe('observe-pipeline exports', () => {
  it('exports refreshDebtLedger as async function', () => {
    const { refreshDebtLedger } = require('./observe-pipeline.cjs');
    assert.strictEqual(typeof refreshDebtLedger, 'function');
  });

  it('exports registerAllHandlers as function', () => {
    const { registerAllHandlers } = require('./observe-pipeline.cjs');
    assert.strictEqual(typeof registerAllHandlers, 'function');
  });

  it('exports _nfBin as function', () => {
    const { _nfBin } = require('./observe-pipeline.cjs');
    assert.strictEqual(typeof _nfBin, 'function');
  });
});

describe('registerAllHandlers', () => {
  it('registers core handlers without throwing', () => {
    const { registerAllHandlers } = require('./observe-pipeline.cjs');
    const registry = registerAllHandlers();
    assert.ok(registry.listHandlers().includes('github'));
    assert.ok(registry.listHandlers().includes('sentry'));
    assert.ok(registry.listHandlers().includes('internal'));
    assert.ok(registry.listHandlers().includes('upstream'));
    assert.ok(registry.listHandlers().includes('deps'));
  });

  it('can be called twice without "already registered" error', () => {
    const { registerAllHandlers } = require('./observe-pipeline.cjs');
    registerAllHandlers();
    // Second call should not throw thanks to clearHandlers()
    const registry = registerAllHandlers();
    assert.ok(registry.listHandlers().length >= 7);
  });
});

describe('refreshDebtLedger', () => {
  it('returns zero-state when no config exists and source filter blocks all', async () => {
    const { refreshDebtLedger } = require('./observe-pipeline.cjs');
    const result = await refreshDebtLedger({
      sourceFilter: 'nonexistent-source-type',
      skipDebtWrite: true
    });
    assert.strictEqual(result.sourceCount, 0);
    assert.strictEqual(result.written, 0);
    assert.ok(Array.isArray(result.observations));
    assert.ok(Array.isArray(result.results));
  });

  it('always injects internal source when no filter or filter=internal', async () => {
    const { refreshDebtLedger } = require('./observe-pipeline.cjs');
    const result = await refreshDebtLedger({
      sourceFilter: 'internal',
      skipDebtWrite: true
    });
    // Internal handler should have been dispatched
    assert.ok(result.sourceCount >= 1, `sourceCount=${result.sourceCount}`);
    assert.ok(Array.isArray(result.results));
  });
});

describe('refreshDebtLedger adversarial opts', () => {
  it('treats null opts as empty options instead of crashing', async () => {
    const { refreshDebtLedger } = require('./observe-pipeline.cjs');
    const result = await refreshDebtLedger(null);
    assert.ok(result && typeof result === 'object', 'should return a result object');
    assert.ok(Array.isArray(result.observations));
    assert.ok(Array.isArray(result.results));
    assert.strictEqual(typeof result.sourceCount, 'number');
  });

  it('treats a non-object opts (e.g. a string) as empty options', async () => {
    const { refreshDebtLedger } = require('./observe-pipeline.cjs');
    const result = await refreshDebtLedger('github');
    assert.ok(result && typeof result === 'object');
    assert.ok(Array.isArray(result.results));
  });
});

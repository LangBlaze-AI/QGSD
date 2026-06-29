'use strict';

// bin/observe-pipeline.test.cjs
// Tests for observe-pipeline.cjs — the shared programmatic observe pipeline

const assert = require('assert');
const { describe, it } = require('node:test');
const path = require('path');

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

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  registerHandler,
  getHandler,
  listHandlers,
  dispatchSource,
  dispatchAll,
  clearHandlers
} = require('./observe-registry.cjs');

// Reset handlers before each test
beforeEach(() => {
  clearHandlers();
});

describe('registerHandler', () => {
  it('registers a handler function', () => {
    const fn = async () => ({});
    registerHandler('test', fn);
    assert.equal(getHandler('test'), fn);
  });

  it('throws on duplicate registration', () => {
    registerHandler('test', async () => ({}));
    assert.throws(
      () => registerHandler('test', async () => ({})),
      /already registered/
    );
  });

  it('throws if handler is not a function', () => {
    assert.throws(
      () => registerHandler('test', 'not a function'),
      /must be a function/
    );
  });
});

describe('getHandler', () => {
  it('returns null for unregistered type', () => {
    assert.equal(getHandler('nonexistent'), null);
  });

  it('returns registered handler', () => {
    const fn = async () => ({});
    registerHandler('github', fn);
    assert.equal(getHandler('github'), fn);
  });
});

describe('listHandlers', () => {
  it('returns empty array initially', () => {
    assert.deepEqual(listHandlers(), []);
  });

  it('returns registered types', () => {
    registerHandler('github', async () => ({}));
    registerHandler('sentry', async () => ({}));
    const types = listHandlers();
    assert.ok(types.includes('github'));
    assert.ok(types.includes('sentry'));
    assert.equal(types.length, 2);
  });
});

describe('dispatchSource', () => {
  it('calls handler and returns result', async () => {
    const expected = {
      source_label: 'GH',
      source_type: 'github',
      status: 'ok',
      issues: [{ id: 'gh-1', title: 'Test' }]
    };
    registerHandler('github', async () => expected);

    const result = await dispatchSource({ type: 'github', label: 'GH' }, {}, 5);
    assert.deepEqual(result, expected);
  });

  it('returns error status when no handler registered', async () => {
    const result = await dispatchSource({ type: 'unknown', label: 'Unknown' }, {}, 5);
    assert.equal(result.status, 'error');
    assert.ok(result.error.includes('No handler registered'));
    assert.deepEqual(result.issues, []);
  });

  it('returns timeout error when handler exceeds timeout', async () => {
    registerHandler('slow', async () => {
      return new Promise(() => {}); // Never resolves
    });

    const result = await dispatchSource({ type: 'slow', label: 'Slow' }, {}, 0.1);
    assert.equal(result.status, 'error');
    assert.ok(result.error.includes('Timeout'));
    assert.deepEqual(result.issues, []);
  });

  it('catches thrown exceptions and returns error status', async () => {
    registerHandler('broken', async () => {
      throw new Error('Handler crashed');
    });

    const result = await dispatchSource({ type: 'broken', label: 'Broken' }, {}, 5);
    assert.equal(result.status, 'error');
    assert.ok(result.error.includes('Handler crashed'));
    assert.deepEqual(result.issues, []);
  });

  it('passes options to handler', async () => {
    let receivedOptions;
    registerHandler('test', async (config, opts) => {
      receivedOptions = opts;
      return { source_label: 'T', source_type: 'test', status: 'ok', issues: [] };
    });

    await dispatchSource({ type: 'test', label: 'T' }, { sinceOverride: '24h' }, 5);
    assert.equal(receivedOptions.sinceOverride, '24h');
  });

  it('returns the standard error schema instead of throwing on null sourceConfig', async () => {
    const result = await dispatchSource(null, {}, 5);
    assert.equal(result.status, 'error');
    assert.equal(result.source_type, 'unknown');
    assert.deepEqual(result.issues, []);
  });
});

describe('dispatchAll', () => {
  it('runs multiple sources in parallel and returns all results', async () => {
    registerHandler('a', async () => ({
      source_label: 'A', source_type: 'a', status: 'ok', issues: [{ id: 'a-1' }]
    }));
    registerHandler('b', async () => ({
      source_label: 'B', source_type: 'b', status: 'ok', issues: [{ id: 'b-1' }]
    }));

    const results = await dispatchAll([
      { type: 'a', label: 'A', timeout: 5 },
      { type: 'b', label: 'B', timeout: 5 }
    ], {});

    assert.equal(results.length, 2);
    assert.equal(results[0].status, 'ok');
    assert.equal(results[1].status, 'ok');
    assert.equal(results[0].source_label, 'A');
    assert.equal(results[1].source_label, 'B');
  });

  it('includes both fulfilled and failed results', async () => {
    registerHandler('good', async () => ({
      source_label: 'Good', source_type: 'good', status: 'ok', issues: [{ id: 'g-1' }]
    }));
    registerHandler('bad', async () => {
      return new Promise(() => {}); // Never resolves — will timeout
    });

    const results = await dispatchAll([
      { type: 'good', label: 'Good', timeout: 5 },
      { type: 'bad', label: 'Bad', timeout: 0.1 }
    ], {});

    assert.equal(results.length, 2);
    assert.equal(results[0].status, 'ok');
    assert.equal(results[1].status, 'error');
    assert.ok(results[1].error.includes('Timeout'));
  });

  it('handles unregistered source types in dispatch', async () => {
    const results = await dispatchAll([
      { type: 'nonexistent', label: 'Missing', timeout: 5 }
    ], {});

    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'error');
    assert.ok(results[0].error.includes('No handler registered'));
  });

  it('returns empty array for empty sources', async () => {
    const results = await dispatchAll([], {});
    assert.deepEqual(results, []);
  });

  it('does not let a null source entry crash the whole batch (OBS-08 fail-open)', async () => {
    registerHandler('a', async () => ({
      source_label: 'A', source_type: 'a', status: 'ok', issues: [{ id: 'a-1' }]
    }));

    const results = await dispatchAll([null, { type: 'a', label: 'A', timeout: 5 }], {});

    assert.equal(results.length, 2);
    assert.equal(results[0].status, 'error');
    assert.deepEqual(results[0].issues, []);
    assert.equal(results[1].status, 'ok');
    assert.equal(results[1].source_label, 'A');
  });
});

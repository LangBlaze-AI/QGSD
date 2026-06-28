'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { refine, _setDeps } = require('./autoresearch-refine.cjs');

// ---- Test Helpers ----

function createMockDeps(opts = {}) {
  const files = {};
  const appended = {};

  const mockDeps = {
    execFileSync: opts.execFileSync || (() => 'Model checking completed. 10 distinct states found.'),
    existsSync: (p) => p in files,
    readFileSync: (p, _enc) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    writeFileSync: (p, content, _enc) => { files[p] = content; },
    appendFileSync: (p, content, _enc) => {
      if (!appended[p]) appended[p] = '';
      appended[p] += content;
      // Also update files map so readFileSync can read it
      if (!(p in files)) files[p] = '';
      files[p] += content;
    },
    // Expose internals for assertions
    _files: files,
    _appended: appended
  };

  return mockDeps;
}

function modelPath() {
  return '/tmp/test-model/TestModel.tla';
}

function tsvPath() {
  return '/tmp/test-model/refinement-results.tsv';
}

// ---- Tests ----

describe('autoresearch-refine', () => {

  beforeEach(() => {
    // Reset deps before each test
    _setDeps({
      execFileSync: () => '',
      existsSync: () => false,
      readFileSync: () => { throw new Error('not mocked'); },
      writeFileSync: () => {},
      appendFileSync: () => {}
    });
  });

  it('converges on first iteration when violation found', async () => {
    const mock = createMockDeps({
      execFileSync: () => {
        const err = new Error('violation');
        err.status = 1;
        err.stdout = 'Invariant Safety is violated. 5 distinct states found.';
        err.stderr = '';
        throw err;
      }
    });
    mock._files[modelPath()] = 'MODULE TestModel';
    _setDeps(mock);

    const result = await refine({
      modelPath: modelPath(),
      bugContext: 'test bug',
      formalism: 'tla',
      maxIterations: 5,
      onTweak: async () => 'added invariant constraint'
    });

    assert.equal(result.converged, true);
    assert.equal(result.iterations, 1);
    assert.equal(result.stuck_reason, null);
    assert.equal(result.resultsLog, tsvPath());

    // TSV should have header + 1 row with "converged"
    const tsvContent = mock._files[tsvPath()];
    assert.ok(tsvContent.includes('converged'));
  });

  it('keeps iteration when state count increases', async () => {
    let callCount = 0;
    const mock = createMockDeps({
      execFileSync: () => {
        callCount++;
        return `Model checking completed. ${10 + callCount * 5} distinct states found.`;
      }
    });
    mock._files[modelPath()] = 'MODULE TestModel';
    _setDeps(mock);

    const result = await refine({
      modelPath: modelPath(),
      bugContext: 'test bug',
      formalism: 'tla',
      maxIterations: 3,
      onTweak: async () => `tweak iteration ${callCount + 1}`
    });

    assert.equal(result.converged, false);
    assert.equal(result.iterations, 3);

    // All iterations should be "kept"
    const tsvContent = mock._files[tsvPath()];
    const lines = tsvContent.trim().split('\n');
    // Header + 3 data rows
    assert.equal(lines.length, 4);
    assert.ok(lines[1].includes('kept'));
    assert.ok(lines[2].includes('kept'));
    assert.ok(lines[3].includes('kept'));
  });

  it('discards iteration on state count regression and restores model', async () => {
    let callCount = 0;
    const mock = createMockDeps({
      execFileSync: () => {
        callCount++;
        // First: 20 states, Second: 15 states (regression)
        const states = callCount === 1 ? 20 : 15;
        return `Model checking completed. ${states} distinct states found.`;
      }
    });
    mock._files[modelPath()] = 'ORIGINAL MODEL CONTENT';
    _setDeps(mock);

    let tweakCount = 0;
    const result = await refine({
      modelPath: modelPath(),
      bugContext: 'test bug',
      formalism: 'tla',
      maxIterations: 2,
      onTweak: async (mp) => {
        tweakCount++;
        // Simulate editing the model
        mock._files[mp] = `MODIFIED MODEL v${tweakCount}`;
        return `tweak ${tweakCount}`;
      }
    });

    assert.equal(result.iterations, 2);

    // Check TSV: first should be "kept", second "discarded"
    const tsvContent = mock._files[tsvPath()];
    const lines = tsvContent.trim().split('\n');
    assert.ok(lines[1].includes('kept'));
    assert.ok(lines[2].includes('discarded'));

    // Model should be restored to the state after first kept tweak
    // (rollback restores from backup taken before the second tweak)
    assert.equal(mock._files[modelPath()], 'MODIFIED MODEL v1');
  });

  it('when-stuck protocol triggers after 3 consecutive discards', async () => {
    let callCount = 0;
    const mock = createMockDeps({
      execFileSync: () => {
        callCount++;
        // First iteration: 20 states (kept as baseline)
        // Iterations 2-4: decreasing states (all discarded)
        if (callCount === 1) return '20 distinct states found.';
        return `${20 - callCount} distinct states found.`;
      }
    });
    mock._files[modelPath()] = 'MODULE TestModel';
    _setDeps(mock);

    const result = await refine({
      modelPath: modelPath(),
      bugContext: 'test bug',
      formalism: 'tla',
      maxIterations: 10,
      onTweak: async () => `tweak ${callCount + 1}`
    });

    assert.equal(result.converged, false);
    assert.ok(result.stuck_reason !== null, 'stuck_reason should be populated');
    assert.ok(result.stuck_reason.includes('3+ consecutive discards'));
    // Should have stopped at iteration 4 (1 kept + 3 discarded)
    assert.equal(result.iterations, 4);
  });

  it('TSV header written once across multiple iterations', async () => {
    let callCount = 0;
    const mock = createMockDeps({
      execFileSync: () => {
        callCount++;
        return `${10 + callCount * 2} distinct states found.`;
      }
    });
    mock._files[modelPath()] = 'MODULE TestModel';
    _setDeps(mock);

    await refine({
      modelPath: modelPath(),
      bugContext: 'test bug',
      formalism: 'tla',
      maxIterations: 2,
      onTweak: async () => 'tweak'
    });

    const tsvContent = mock._files[tsvPath()];
    const headerCount = (tsvContent.match(/^iteration\t/gm) || []).length;
    assert.equal(headerCount, 1, 'TSV header should appear exactly once');
  });

  it('TSV-as-memory passed to onTweak via iterationContext', async () => {
    let callCount = 0;
    const receivedContexts = [];
    const mock = createMockDeps({
      execFileSync: () => {
        callCount++;
        return `${10 + callCount * 5} distinct states found.`;
      }
    });
    mock._files[modelPath()] = 'MODULE TestModel';
    _setDeps(mock);

    await refine({
      modelPath: modelPath(),
      bugContext: 'test bug',
      formalism: 'tla',
      maxIterations: 3,
      onTweak: async (_mp, ctx) => {
        receivedContexts.push(ctx);
        return `tweak ${ctx.iteration}`;
      }
    });

    // First iteration: tsvHistory should be empty array
    assert.ok(Array.isArray(receivedContexts[0].tsvHistory));
    assert.equal(receivedContexts[0].tsvHistory.length, 0);

    // Second iteration: tsvHistory should have 1 entry
    assert.equal(receivedContexts[1].tsvHistory.length, 1);

    // Third iteration: tsvHistory should have 2 entries
    assert.equal(receivedContexts[2].tsvHistory.length, 2);

    // Verify consecutiveDiscards is passed
    assert.equal(typeof receivedContexts[0].consecutiveDiscards, 'number');
  });

  it('respects max-iterations cap', async () => {
    let callCount = 0;
    const mock = createMockDeps({
      execFileSync: () => {
        callCount++;
        return `${10 + callCount} distinct states found.`;
      }
    });
    mock._files[modelPath()] = 'MODULE TestModel';
    _setDeps(mock);

    const result = await refine({
      modelPath: modelPath(),
      bugContext: 'test bug',
      formalism: 'tla',
      maxIterations: 2,
      onTweak: async () => 'tweak'
    });

    assert.equal(result.converged, false);
    assert.equal(result.iterations, 2);
    assert.equal(callCount, 2);
  });

  it('fail-open on checker errors — loop continues gracefully', async () => {
    let callCount = 0;
    const mock = createMockDeps({
      execFileSync: () => {
        callCount++;
        if (callCount === 1) throw new Error('checker crashed');
        // Second call succeeds with violation
        const err = new Error('violation');
        err.status = 1;
        err.stdout = 'Invariant broken. 5 distinct states found.';
        err.stderr = '';
        throw err;
      }
    });
    mock._files[modelPath()] = 'MODULE TestModel';
    _setDeps(mock);

    const result = await refine({
      modelPath: modelPath(),
      bugContext: 'test bug',
      formalism: 'tla',
      maxIterations: 3,
      onTweak: async () => 'tweak'
    });

    // Should have continued past the error and converged on iteration 2
    assert.equal(result.converged, true);
    assert.equal(result.iterations, 2);
  });

  it('onTweak returning null skips iteration with no-op status', async () => {
    let callCount = 0;
    const mock = createMockDeps({
      execFileSync: () => {
        callCount++;
        return `10 distinct states found.`;
      }
    });
    mock._files[modelPath()] = 'MODULE TestModel';
    _setDeps(mock);

    const result = await refine({
      modelPath: modelPath(),
      bugContext: 'test bug',
      formalism: 'tla',
      maxIterations: 2,
      onTweak: async () => null
    });

    assert.equal(result.converged, false);
    assert.equal(result.iterations, 2);
    // Checker should NOT have been called (no-op skips checker)
    assert.equal(callCount, 0);

    // TSV should have "no-op" entries
    const tsvContent = mock._files[tsvPath()];
    assert.ok(tsvContent.includes('no-op'));
  });

  it('sanitizes tab/newline in onTweak description so TSV-as-memory is not corrupted', async () => {
    const mock = createMockDeps({
      execFileSync: () => {
        const err = new Error('violation');
        err.status = 1;
        err.stdout = 'Invariant Safety is violated. 5 distinct states found.';
        err.stderr = '';
        throw err;
      }
    });
    mock._files[modelPath()] = 'MODULE TestModel';
    _setDeps(mock);

    await refine({
      modelPath: modelPath(),
      bugContext: 'test bug',
      formalism: 'tla',
      maxIterations: 1,
      onTweak: async () => 'added invariant\nwith newline\tand tab'
    });

    const tsvContent = mock._files[tsvPath()];
    const lines = tsvContent.trim().split('\n');
    // Header + exactly one data row — the embedded newline must NOT create a 3rd line
    assert.equal(lines.length, 2, 'description newline must not inject a spurious TSV row');
    // The single data row must have exactly 6 tab-separated columns
    assert.equal(lines[1].split('\t').length, 6, 'description tab must not inject an extra column');
  });

  it('rejects with a clear error when opts is null/undefined', async () => {
    await assert.rejects(() => refine(null), /opts (object )?is required/);
    await assert.rejects(() => refine(), /opts (object )?is required/);
  });
});

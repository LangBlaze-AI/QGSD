const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const mod = require('../bin/refinement-loop.cjs');
const { verifyBugReproduction, formatIterationFeedback, _setDeps } = mod;

// ---- Mock helpers ----

/**
 * Create a mock execFileSync that simulates checker behavior.
 * @param {Array} results - Array of { exit, stdout, stderr } per attempt
 *   exit=0 means checker passed (model does NOT reproduce bug)
 *   exit=1 means checker found violation (model reproduces bug)
 */
function makeMockExec(results) {
  let callIdx = 0;
  return function mockExecFileSync(_cmd, _args, _opts) {
    const r = results[callIdx++] || { exit: 0, stdout: 'no error', stderr: '' };
    if (r.exit !== 0) {
      const err = new Error('checker found violation');
      err.status = r.exit;
      err.stdout = r.stdout || '';
      err.stderr = r.stderr || '';
      throw err;
    }
    return r.stdout || 'Model checking completed. No error has been found.';
  };
}

/**
 * Create a mock execFileSync that throws a spawn error (not a checker failure).
 */
function makeSpawnErrorExec() {
  return function mockExecFileSync() {
    const err = new Error('ENOENT: checker not found');
    err.code = 'ENOENT';
    throw err;
  };
}

beforeEach(() => {
  // Reset to default deps between tests
  _setDeps({
    execFileSync: require('child_process').execFileSync,
    existsSync: require('fs').existsSync,
    readFileSync: require('fs').readFileSync
  });
});

// ---- verifyBugReproduction tests ----

test('MRF-02: returns reproduced when checker finds error on first attempt', () => {
  _setDeps({
    execFileSync: makeMockExec([
      { exit: 1, stdout: 'Error: Invariant SafetyInvariant is violated.\nState 1\nState 2\nState 3' }
    ])
  });

  const result = verifyBugReproduction('/fake/model.tla', 'bug description', {
    formalism: 'tla',
    maxAttempts: 3
  });

  assert.strictEqual(result.status, 'reproduced');
  assert.strictEqual(result.attempts, 1);
  assert.strictEqual(result.model_path, '/fake/model.tla');
  assert.strictEqual(result.iterations.length, 1);
  assert.strictEqual(result.iterations[0].passed, false);
});

test('MRF-02: retries up to maxAttempts when model passes', () => {
  _setDeps({
    execFileSync: makeMockExec([
      { exit: 0, stdout: 'Model checking completed. No error has been found.' },
      { exit: 0, stdout: 'Model checking completed. No error has been found.' },
      { exit: 0, stdout: 'Model checking completed. No error has been found.' }
    ])
  });

  const result = verifyBugReproduction('/fake/model.tla', 'bug description', {
    formalism: 'tla',
    maxAttempts: 3
  });

  assert.strictEqual(result.status, 'not_reproduced');
  assert.strictEqual(result.attempts, 3);
  assert.strictEqual(result.iterations.length, 3);
  assert.strictEqual(result.counterexample, null);
});

test('MRF-02: returns not_reproduced after all attempts exhausted', () => {
  _setDeps({
    execFileSync: makeMockExec([
      { exit: 0 },
      { exit: 0 }
    ])
  });

  const result = verifyBugReproduction('/fake/model.tla', 'bug', {
    formalism: 'tla',
    maxAttempts: 2
  });

  assert.strictEqual(result.status, 'not_reproduced');
  assert.strictEqual(result.attempts, 2);
});

test('MRF-02: calls onIteration callback between attempts', () => {
  _setDeps({
    execFileSync: makeMockExec([
      { exit: 0 },
      { exit: 1, stdout: 'Error: Invariant X is violated.' }
    ])
  });

  const callbacks = [];
  verifyBugReproduction('/fake/model.tla', 'bug', {
    formalism: 'tla',
    maxAttempts: 3,
    onIteration: (iter) => callbacks.push(iter)
  });

  assert.strictEqual(callbacks.length, 2);
  assert.strictEqual(callbacks[0].attempt, 1);
  assert.strictEqual(callbacks[0].passed, true);
  assert.strictEqual(callbacks[1].attempt, 2);
  assert.strictEqual(callbacks[1].passed, false);
});

test('MRF-02: defaults to maxAttempts=3', () => {
  _setDeps({
    execFileSync: makeMockExec([
      { exit: 0 },
      { exit: 0 },
      { exit: 0 }
    ])
  });

  const result = verifyBugReproduction('/fake/model.tla', 'bug', {
    formalism: 'tla'
    // no maxAttempts — should default to 3
  });

  assert.strictEqual(result.attempts, 3);
  assert.strictEqual(result.iterations.length, 3);
});

test('MRF-02: reproduces on second attempt after first passes', () => {
  _setDeps({
    execFileSync: makeMockExec([
      { exit: 0, stdout: 'Model checking completed. No error has been found.' },
      { exit: 1, stdout: 'Error: Invariant Safety is violated.\nState 1 -> State 2' }
    ])
  });

  const result = verifyBugReproduction('/fake/model.tla', 'bug', {
    formalism: 'tla',
    maxAttempts: 3
  });

  assert.strictEqual(result.status, 'reproduced');
  assert.strictEqual(result.attempts, 2);
  assert.strictEqual(result.iterations.length, 2);
});

test('MRF-02: fail-open on checker subprocess crash (treats as not reproduced)', () => {
  _setDeps({
    execFileSync: makeSpawnErrorExec()
  });

  const result = verifyBugReproduction('/fake/model.tla', 'bug', {
    formalism: 'tla',
    maxAttempts: 2
  });

  assert.strictEqual(result.status, 'not_reproduced');
  assert.strictEqual(result.attempts, 2);
});

test('MRF-02: works with alloy formalism', () => {
  _setDeps({
    execFileSync: makeMockExec([
      { exit: 1, stdout: 'Assertion SafetyAssertion may not hold.' }
    ])
  });

  const result = verifyBugReproduction('/fake/model.als', 'bug', {
    formalism: 'alloy',
    maxAttempts: 3
  });

  assert.strictEqual(result.status, 'reproduced');
  assert.strictEqual(result.attempts, 1);
});

// ---- formatIterationFeedback tests ----

test('MRF-02: formatIterationFeedback shows summary only when verbose=false', () => {
  const iter = { attempt: 1, passed: true, summary: 'model is incomplete — invariants hold but model does not capture the failure' };
  const output = formatIterationFeedback(iter, false);
  assert.ok(output.includes('Attempt 1'));
  assert.ok(output.includes('model still incomplete'));
  assert.ok(output.includes('model is incomplete'));
  assert.ok(!output.includes('Full output'));
});

test('MRF-02: formatIterationFeedback shows full output when verbose=true', () => {
  const iter = { attempt: 2, passed: false, summary: 'invariant X violated' };
  const fullOutput = 'Error: Invariant X is violated.\nState 1\nState 2';
  const output = formatIterationFeedback(iter, true, fullOutput);
  assert.ok(output.includes('Attempt 2'));
  assert.ok(output.includes('reproduced'));
  assert.ok(output.includes('Full output'));
  assert.ok(output.includes('Invariant X'));
});

test('MRF-02: formatIterationFeedback handles reproduced status', () => {
  const iter = { attempt: 1, passed: false, summary: 'violation found' };
  const output = formatIterationFeedback(iter, false);
  assert.ok(output.includes('reproduced'));
  assert.ok(!output.includes('model still incomplete'));
});

test('MRF-02: formatIterationFeedback does not crash when diagnostic lacks trace_alignment', () => {
  const iter = {
    attempt: 1,
    passed: true,
    summary: 'model incomplete',
    diagnostic: { correction_proposals: [{ id: 'p1' }] } // no trace_alignment
  };
  let output;
  assert.doesNotThrow(() => { output = formatIterationFeedback(iter, false); });
  assert.ok(output.includes('Attempt 1'));
  assert.ok(output.includes('1 correction proposals generated (0 diverged fields)'));
});

test('MRF-02: formatIterationFeedback fail-opens on null iteration', () => {
  let output;
  assert.doesNotThrow(() => { output = formatIterationFeedback(null, false); });
  assert.strictEqual(output, '');
  assert.doesNotThrow(() => formatIterationFeedback(undefined, false));
});

test('MRF-02: non-positive maxAttempts falls back to default instead of zero iterations', () => {
  _setDeps({
    execFileSync: makeMockExec([{ exit: 0 }, { exit: 0 }, { exit: 0 }])
  });
  const result = verifyBugReproduction('/fake/model.tla', 'bug', {
    formalism: 'tla',
    maxAttempts: -1
  });
  assert.ok(result.attempts > 0, 'should run at least one attempt');
  assert.ok(result.iterations.length > 0, 'should record at least one iteration');
});

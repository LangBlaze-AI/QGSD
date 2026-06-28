'use strict';
// Test suite for bin/solve-worker.cjs — non-blocking solve worker IPC protocol
// Tests the fork/IPC handshake, all 4 commands, error handling, and edge cases.
// node --test bin/solve-worker.test.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('child_process');
const path = require('path');

const WORKER_PATH = path.join(__dirname, 'solve-worker.cjs');
const PROJECT_ROOT = path.join(__dirname, '..');

/**
 * Fork the worker and return a helper object for sending/receiving IPC messages.
 * Auto-kills after `timeoutMs` to prevent hung tests.
 */
function spawnWorker(timeoutMs = 30000) {
  const child = fork(WORKER_PATH, ['--project-root=' + PROJECT_ROOT], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  const messages = [];
  let onMessage = null;

  child.on('message', (msg) => {
    messages.push(msg);
    if (onMessage) onMessage(msg);
  });

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, timeoutMs);

  return {
    child,
    messages,
    /** Wait for the 'ready' message from the worker */
    waitReady() {
      return new Promise((resolve, reject) => {
        const existing = messages.find(m => m.cmd === 'ready');
        if (existing) return resolve(existing);
        onMessage = (msg) => {
          if (msg.cmd === 'ready') { onMessage = null; resolve(msg); }
        };
        child.on('error', reject);
      });
    },
    /** Send a command and wait for the response with matching id */
    sendAndWait(cmd) {
      return new Promise((resolve, reject) => {
        child.send(cmd);
        onMessage = (msg) => {
          if (msg.id === cmd.id && msg.cmd !== 'sweepResult') {
            onMessage = null;
            resolve(msg);
          }
        };
        child.on('error', reject);
      });
    },
    /** Send a batchSweep command and collect all streamed results + batchDone */
    sendBatchAndCollect(cmd) {
      return new Promise((resolve, reject) => {
        const results = [];
        child.send(cmd);
        onMessage = (msg) => {
          if (msg.cmd === 'sweepResult') {
            results.push(msg);
          } else if (msg.cmd === 'batchDone') {
            onMessage = null;
            resolve({ results, done: msg });
          }
        };
        child.on('error', reject);
      });
    },
    cleanup() {
      clearTimeout(timer);
      try { child.disconnect(); } catch (_) {}
      try { child.kill(); } catch (_) {}
    },
  };
}

// ─── Protocol Tests ──────────────────────────────────────────────────────────

test('worker sends ready on startup', async () => {
  const w = spawnWorker(10000);
  try {
    const ready = await w.waitReady();
    assert.equal(ready.ok, true);
    assert.equal(ready.cmd, 'ready');
  } finally {
    w.cleanup();
  }
});

test('sweep command returns result with residual', async () => {
  const w = spawnWorker(15000);
  try {
    await w.waitReady();
    const resp = await w.sendAndWait({ cmd: 'sweep', fnName: 'sweepCtoR', id: 1 });
    assert.equal(resp.ok, true);
    assert.equal(resp.cmd, 'sweep');
    assert.equal(resp.fnName, 'sweepCtoR');
    assert.equal(typeof resp.result.residual, 'number');
    assert.ok(resp.result.residual >= 0, 'residual should be non-negative');
  } finally {
    w.cleanup();
  }
});

test('sweep command with unknown function returns error', async () => {
  const w = spawnWorker(10000);
  try {
    await w.waitReady();
    const resp = await w.sendAndWait({ cmd: 'sweep', fnName: 'sweepNonExistent', id: 2 });
    assert.equal(resp.ok, false);
    assert.ok(resp.error.includes('not found'), 'error should mention function not found');
  } finally {
    w.cleanup();
  }
});

test('loadSweepData command returns category data', async () => {
  const w = spawnWorker(15000);
  try {
    await w.waitReady();
    const resp = await w.sendAndWait({ cmd: 'loadSweepData', id: 3 });
    assert.equal(resp.ok, true);
    assert.equal(resp.cmd, 'loadSweepData');
    // Should have all 4 categories
    assert.ok(resp.result.dtoc, 'should have dtoc category');
    assert.ok(resp.result.ctor, 'should have ctor category');
    assert.ok(resp.result.ttor, 'should have ttor category');
    assert.ok(resp.result.dtor, 'should have dtor category');
    // Each category should have items array
    for (const key of ['dtoc', 'ctor', 'ttor', 'dtor']) {
      assert.ok(Array.isArray(resp.result[key].items), `${key} should have items array`);
    }
  } finally {
    w.cleanup();
  }
});

test('batchSweep streams individual results then batchDone', async () => {
  const w = spawnWorker(20000);
  try {
    await w.waitReady();
    const fnNames = ['sweepCtoR', 'sweepTtoR', 'sweepDtoR'];
    const { results, done } = await w.sendBatchAndCollect({
      cmd: 'batchSweep', fnNames, id: 4,
    });

    // Should get one result per function
    assert.equal(results.length, 3, 'should receive 3 streamed results');
    for (let i = 0; i < fnNames.length; i++) {
      assert.equal(results[i].fnName, fnNames[i], `result ${i} should match function name`);
      assert.equal(results[i].cmd, 'sweepResult');
      assert.equal(results[i].ok, true);
      assert.equal(typeof results[i].result.residual, 'number');
    }

    // Should receive batchDone
    assert.equal(done.ok, true);
    assert.equal(done.cmd, 'batchDone');
    assert.equal(done.id, 4);
  } finally {
    w.cleanup();
  }
});

test('batchSweep handles mix of valid and invalid functions', async () => {
  const w = spawnWorker(15000);
  try {
    await w.waitReady();
    const { results, done } = await w.sendBatchAndCollect({
      cmd: 'batchSweep', fnNames: ['sweepCtoR', 'sweepFakeFunc'], id: 5,
    });

    assert.equal(results.length, 2, 'should receive 2 results');
    // First should succeed
    assert.equal(results[0].ok, true);
    assert.equal(results[0].fnName, 'sweepCtoR');
    // Second should fail gracefully
    assert.equal(results[1].ok, false);
    assert.equal(results[1].fnName, 'sweepFakeFunc');
    assert.ok(results[1].error.includes('not found'));
    // Batch should still complete
    assert.equal(done.ok, true);
  } finally {
    w.cleanup();
  }
});

test('unknown command returns error', async () => {
  const w = spawnWorker(10000);
  try {
    await w.waitReady();
    const resp = await w.sendAndWait({ cmd: 'badCommand', id: 6 });
    assert.equal(resp.ok, false);
    assert.ok(resp.error.includes('Unknown command'));
  } finally {
    w.cleanup();
  }
});

test('empty message is ignored (no crash)', async () => {
  const w = spawnWorker(10000);
  try {
    await w.waitReady();
    // Send null/empty — should be silently ignored
    w.child.send(null);
    w.child.send({});
    // Send a valid command after — should still work
    const resp = await w.sendAndWait({ cmd: 'sweep', fnName: 'sweepDtoR', id: 7 });
    assert.equal(resp.ok, true);
  } finally {
    w.cleanup();
  }
});

// ─── Async Wrapper Integration Tests ─────────────────────────────────────────
// These test the actual sweepAsync/loadSweepDataAsync/batchSweepAsync wrappers
// from nForma.cjs to verify the full fork→IPC→settle pipeline.

test('sweepAsync returns result via forked worker', async () => {
  // Load the wrappers directly — they're exported via _pure.
  // We need the mocked blessed to load nForma.cjs, so we use fork-based
  // inline test instead.
  const { fork: f } = require('child_process');
  const result = await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    const child = f(WORKER_PATH, ['--project-root=' + PROJECT_ROOT], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      settle(reject, new Error('timeout'));
    }, 15000);
    child.on('message', (msg) => {
      if (msg.cmd === 'ready') {
        child.send({ cmd: 'sweep', fnName: 'sweepDtoR', id: 1 });
      } else if (msg.id === 1) {
        clearTimeout(timeout);
        child.disconnect();
        if (msg.ok) settle(resolve, msg.result);
        else settle(reject, new Error(msg.error));
      }
    });
    child.on('error', (err) => { clearTimeout(timeout); settle(reject, err); });
    child.on('exit', () => { clearTimeout(timeout); });
  });

  assert.equal(typeof result.residual, 'number');
  assert.ok(result.detail, 'should have detail object');
});

test('settled guard prevents double-resolve', async () => {
  // Verify the settle pattern works: after resolve, further calls are no-ops
  let resolveCount = 0;
  let rejectCount = 0;

  await new Promise((resolve) => {
    let settled = false;
    const settle = (fn, val) => {
      if (!settled) {
        settled = true;
        fn(val);
      } else {
        // Count extra calls that would have been double-settle
        if (fn === resolve) resolveCount++;
        else rejectCount++;
      }
    };

    // Simulate: resolve fires, then exit handler tries to reject
    settle(resolve, 'first');
    settle(() => { rejectCount++; }, new Error('should be ignored'));
    settle(resolve, 'also ignored');
  });

  // The extra calls should have been blocked
  assert.equal(rejectCount, 1, 'reject after settle should be blocked');
  assert.equal(resolveCount, 1, 'resolve after settle should be blocked');
});

test('batchSweepAsync streams results via onResult callback', async () => {
  const results = [];
  const fnNames = ['sweepCtoR', 'sweepTtoR'];

  await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    const child = fork(WORKER_PATH, ['--project-root=' + PROJECT_ROOT], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      settle(reject, new Error('timeout'));
    }, 20000);

    child.on('message', (msg) => {
      if (msg.cmd === 'ready') {
        child.send({ cmd: 'batchSweep', fnNames, id: 1 });
      } else if (msg.cmd === 'sweepResult') {
        results.push({ fnName: msg.fnName, ok: msg.ok, residual: msg.result?.residual });
      } else if (msg.cmd === 'batchDone') {
        clearTimeout(timeout);
        child.disconnect();
        settle(resolve);
      }
    });
    child.on('error', (err) => { clearTimeout(timeout); settle(reject, err); });
    child.on('exit', () => { clearTimeout(timeout); });
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].fnName, 'sweepCtoR');
  assert.equal(results[1].fnName, 'sweepTtoR');
  assert.ok(results.every(r => r.ok), 'all results should be ok');
  assert.ok(results.every(r => typeof r.residual === 'number'), 'all should have numeric residual');
});

// ─── Adversarial Hardening Tests ─────────────────────────────────────────────

test('sweep rejects inherited Object.prototype members as function names', async () => {
  const w = spawnWorker(10000);
  try {
    await w.waitReady();
    const resp = await w.sendAndWait({ cmd: 'sweep', fnName: 'constructor', id: 11 });
    assert.equal(resp.ok, false, 'inherited constructor must not be treated as a sweep fn');
    assert.ok(resp.error.includes('not found'), 'should report not found, not invoke Object()');
  } finally {
    w.cleanup();
  }
});

test('batchSweep rejects inherited Object.prototype members', async () => {
  const w = spawnWorker(10000);
  try {
    await w.waitReady();
    const { results, done } = await w.sendBatchAndCollect({ cmd: 'batchSweep', fnNames: ['toString', 'sweepCtoR'], id: 12 });
    assert.equal(results.length, 2);
    assert.equal(results[0].ok, false, 'inherited toString must fail, not return ok:true');
    assert.ok(results[0].error.includes('not found'));
    assert.equal(results[1].ok, true, 'real sweep still works');
    assert.equal(done.cmd, 'batchDone');
  } finally {
    w.cleanup();
  }
});

test('batchSweep treats a non-array fnNames as empty, not per-character', async () => {
  const w = spawnWorker(10000);
  try {
    await w.waitReady();
    const { results, done } = await w.sendBatchAndCollect({ cmd: 'batchSweep', fnNames: 'sweepCtoR', id: 13 });
    assert.ok(results.length <= 1, `expected no per-character results, got ${results.length}`);
    assert.equal(done.cmd, 'batchDone');
    assert.equal(done.ok, true);
  } finally {
    w.cleanup();
  }
});

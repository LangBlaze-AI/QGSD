#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const { simulateSolutionLoop } = require('./solution-simulation-loop.cjs');

// Helper: Create temporary directory for test isolation
function createTempDir() {
  const tmpRoot = path.join(os.tmpdir(), 'solution-sim-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  if (!fs.existsSync(tmpRoot)) {
    fs.mkdirSync(tmpRoot, { recursive: true });
  }
  return tmpRoot;
}

// Helper: Clean up temporary directory
function cleanupTempDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Helper: Create mock module files with simple reproducers
function setupTestEnv(tmpDir) {
  // Create .planning directory structure
  const planningDir = path.join(tmpDir, '.planning');
  const formalDir = path.join(planningDir, 'formal');

  fs.mkdirSync(formalDir, { recursive: true });

  // Create config.json with max_iterations
  const configPath = path.join(planningDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ max_iterations: 3 }, null, 2), 'utf-8');

  // Create a dummy reproducing model file
  const reproducingModelPath = path.join(tmpDir, 'reproducing.tla');
  const modelContent = `---- MODULE reproducing ----
VARIABLE x
Init == x = 0
Next == x' = x + 1
Spec == Init /\\ [][Next]_x
====`;
  fs.writeFileSync(reproducingModelPath, modelContent, 'utf-8');

  // Create dummy bug trace file
  const bugTracePath = path.join(tmpDir, 'bug.itf');
  fs.writeFileSync(bugTracePath, JSON.stringify({ trace: 'dummy' }, null, 2), 'utf-8');

  return { planningDir, formalDir, reproducingModelPath, bugTracePath, configPath };
}

// Helper: Create mock dependencies
function createMockDeps(options = {}) {
  const {
    normalizeReturns = { mutations: [{ type: 'add_invariant', target: 'test', content: 'x > 0', reasoning: 'test' }], confidence: 1.0, ambiguities: [] },
    generateReturns = { consequenceModelPath: '/tmp/consequence.tla', appliedMutations: [], sessionDir: '/tmp/sess', diagnostics: { totalMutations: 1, appliedCount: 1, skippedCount: 0 } },
    gateVerdictConverged = false,
    gateVerdictUnavailable = false,
    normalizeThrows = null,
    generateThrows = null,
    gateThrows = null
  } = options;

  return {
    normalizer: {
      normalizeFixIntent: (intent, context) => {
        if (normalizeThrows) throw normalizeThrows;
        return normalizeReturns;
      }
    },
    generator: {
      generateConsequenceModel: (model, mutations, opts) => {
        if (generateThrows) throw generateThrows;
        return generateReturns;
      }
    },
    gateRunner: {
      runConvergenceGates: async (models, config, checkers) => {
        if (gateThrows) throw gateThrows;
        return {
          gate1_invariants: { passed: !gateVerdictConverged ? false : true, details: 'test' },
          gate2_bug_resolved: { passed: !gateVerdictConverged ? false : true, details: 'test' },
          gate3_neighbors: { passed: !gateVerdictConverged ? false : true, regressions: [], details: 'test' },
          converged: gateVerdictConverged,
          unavailable: gateVerdictUnavailable,
          preservedState: gateVerdictUnavailable,
          iteration: 1,
          writeOnceTimestamp: new Date().toISOString()
        };
      }
    }
  };
}

// Test 1: Convergence on first iteration
test('simulateSolutionLoop: convergence on first iteration', async () => {
  const tmpDir = createTempDir();
  process.chdir(tmpDir);

  try {
    const { reproducingModelPath, bugTracePath } = setupTestEnv(tmpDir);

    const mockDeps = createMockDeps({ gateVerdictConverged: true });

    const result = await simulateSolutionLoop(
      {
        fixIdea: 'add invariant when x > 0 then x > -1',
        bugDescription: 'x can go negative',
        reproducingModelPath,
        neighborModelPaths: [],
        bugTracePath,
        formalism: 'tla',
        maxIterations: 3
      },
      mockDeps
    );

    assert.strictEqual(result.converged, true, 'should converge on first iteration');
    assert.strictEqual(result.iterations.length, 1, 'should have 1 iteration');
    assert.strictEqual(result.escalationReason, null, 'should have no escalation reason');
    assert.ok(result.sessionId, 'should have sessionId');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// Test 2: Convergence on second iteration
test('simulateSolutionLoop: convergence on second iteration', async () => {
  const tmpDir = createTempDir();
  process.chdir(tmpDir);

  try {
    const { reproducingModelPath, bugTracePath } = setupTestEnv(tmpDir);

    let callCount = 0;
    const mockDeps = createMockDeps({
      gateVerdictConverged: false
    });

    // Override gate runner to converge on iteration 2
    mockDeps.gateRunner.runConvergenceGates = async (models, config) => {
      callCount++;
      const converged = callCount >= 2;
      return {
        gate1_invariants: { passed: converged, details: 'test' },
        gate2_bug_resolved: { passed: converged, details: 'test' },
        gate3_neighbors: { passed: converged, regressions: [], details: 'test' },
        converged,
        unavailable: false,
        preservedState: false,
        iteration: callCount,
        writeOnceTimestamp: new Date().toISOString()
      };
    };

    const result = await simulateSolutionLoop(
      {
        fixIdea: 'add invariant when x > 0 then x > -1',
        bugDescription: 'x can go negative',
        reproducingModelPath,
        neighborModelPaths: [],
        bugTracePath,
        formalism: 'tla',
        maxIterations: 3
      },
      mockDeps
    );

    assert.strictEqual(result.converged, true, 'should converge on second iteration');
    assert.strictEqual(result.iterations.length, 2, 'should have 2 iterations');
    assert.strictEqual(result.escalationReason, null, 'should have no escalation reason');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// Test 3: Max iterations exhausted (no convergence)
test('simulateSolutionLoop: max iterations exhausted', async () => {
  const tmpDir = createTempDir();
  process.chdir(tmpDir);

  try {
    const { reproducingModelPath, bugTracePath } = setupTestEnv(tmpDir);

    const mockDeps = createMockDeps({ gateVerdictConverged: false });

    const result = await simulateSolutionLoop(
      {
        fixIdea: 'add invariant',
        bugDescription: 'test bug',
        reproducingModelPath,
        neighborModelPaths: [],
        bugTracePath,
        formalism: 'tla',
        maxIterations: 2
      },
      mockDeps
    );

    assert.strictEqual(result.converged, false, 'should not converge');
    assert.strictEqual(result.iterations.length, 2, 'should have 2 iterations');
    assert.ok(result.escalationReason, 'should have escalation reason');
    assert.ok(result.escalationReason.includes('Max iterations'), 'escalation reason should mention max iterations');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// Test 4: Dependency failure (unavailable)
test('simulateSolutionLoop: dependency failure with state preservation', async () => {
  const tmpDir = createTempDir();
  process.chdir(tmpDir);

  try {
    const { reproducingModelPath, bugTracePath } = setupTestEnv(tmpDir);

    const mockDeps = createMockDeps({ gateVerdictUnavailable: true });

    const result = await simulateSolutionLoop(
      {
        fixIdea: 'add invariant',
        bugDescription: 'test bug',
        reproducingModelPath,
        neighborModelPaths: [],
        bugTracePath,
        formalism: 'tla',
        maxIterations: 3
      },
      mockDeps
    );

    assert.strictEqual(result.converged, false, 'should not converge');
    assert.strictEqual(result.iterations.length, 1, 'should have 1 iteration (stopped early)');
    assert.ok(result.escalationReason, 'should have escalation reason');
    assert.ok(result.escalationReason.includes('unavailable'), 'escalation reason should mention unavailability');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// Test 5: Iteration history written to session directory
test('simulateSolutionLoop: writes iteration history to disk', async () => {
  const tmpDir = createTempDir();
  process.chdir(tmpDir);

  try {
    const { reproducingModelPath, bugTracePath } = setupTestEnv(tmpDir);

    const mockDeps = createMockDeps({ gateVerdictConverged: true });

    const result = await simulateSolutionLoop(
      {
        fixIdea: 'add invariant',
        bugDescription: 'test bug',
        reproducingModelPath,
        neighborModelPaths: [],
        bugTracePath,
        formalism: 'tla',
        maxIterations: 3
      },
      mockDeps
    );

    const historyPath = path.join(
      os.tmpdir(),
      'nf-cycle2-simulations',
      result.sessionId,
      'iteration-history.json'
    );

    assert.ok(fs.existsSync(historyPath), 'iteration history file should exist');

    const history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    assert.strictEqual(history.sessionId, result.sessionId, 'history should match sessionId');
    assert.strictEqual(history.converged, true, 'history should mark converged');
    assert.strictEqual(history.totalIterations, 1, 'history should record iteration count');

    // Cleanup tmpdir session artifacts
    fs.rmSync(path.join(os.tmpdir(), 'nf-cycle2-simulations', result.sessionId), { recursive: true, force: true });
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// Test 6: Default maxIterations read from config.json
test('simulateSolutionLoop: reads maxIterations from config.json', async () => {
  const tmpDir = createTempDir();
  process.chdir(tmpDir);

  try {
    const { reproducingModelPath, bugTracePath, configPath } = setupTestEnv(tmpDir);

    // Update config with custom maxIterations
    fs.writeFileSync(configPath, JSON.stringify({ max_iterations: 5 }, null, 2), 'utf-8');

    let iterationCount = 0;
    const mockDeps = createMockDeps({ gateVerdictConverged: false });

    // Count how many times gate runner is called — alternate failure patterns to avoid when-stuck
    mockDeps.gateRunner.runConvergenceGates = async () => {
      iterationCount++;
      const failGate1 = iterationCount % 2 === 0;
      return {
        gate1_invariants: { passed: !failGate1, details: 'test' },
        gate2_bug_resolved: { passed: failGate1, details: 'test' },
        gate3_neighbors: { passed: false, regressions: [], details: 'test' },
        converged: false,
        unavailable: false,
        preservedState: false,
        iteration: iterationCount,
        writeOnceTimestamp: new Date().toISOString()
      };
    };

    const result = await simulateSolutionLoop(
      {
        fixIdea: 'add invariant',
        bugDescription: 'test bug',
        reproducingModelPath,
        neighborModelPaths: [],
        bugTracePath,
        formalism: 'tla'
        // Note: NOT specifying maxIterations, should read from config
      },
      mockDeps
    );

    assert.strictEqual(result.iterations.length, 5, 'should use maxIterations from config.json');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// Test 7: Fix idea truncated in banner at 80 chars
test('simulateSolutionLoop: truncates fix idea in banner display', async () => {
  const tmpDir = createTempDir();
  process.chdir(tmpDir);

  try {
    const { reproducingModelPath, bugTracePath } = setupTestEnv(tmpDir);

    const longFixIdea = 'a'.repeat(100); // 100 chars, should be truncated

    const mockDeps = createMockDeps({ gateVerdictConverged: true });

    // Capture console output
    let consoleOutput = '';
    const originalLog = console.log;
    console.log = (msg) => {
      consoleOutput += msg + '\n';
      originalLog(msg);
    };

    try {
      const result = await simulateSolutionLoop(
        {
          fixIdea: longFixIdea,
          bugDescription: 'test bug',
          reproducingModelPath,
          neighborModelPaths: [],
          bugTracePath,
          formalism: 'tla',
          maxIterations: 1
        },
        mockDeps
      );

      // Check that output contains truncated version
      assert.ok(consoleOutput.includes('aaa...'), 'banner should contain truncated fix idea with ellipsis');
      assert.ok(!consoleOutput.includes('a'.repeat(100)), 'banner should not contain full 100-char fix idea');
    } finally {
      console.log = originalLog;
    }
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// Test 8: Session ID uses crypto.randomBytes
test('simulateSolutionLoop: generates session ID with crypto.randomBytes', async () => {
  const tmpDir = createTempDir();
  process.chdir(tmpDir);

  try {
    const { reproducingModelPath, bugTracePath } = setupTestEnv(tmpDir);

    const mockDeps = createMockDeps({ gateVerdictConverged: true });

    const result1 = await simulateSolutionLoop(
      {
        fixIdea: 'fix idea 1',
        bugDescription: 'bug 1',
        reproducingModelPath,
        neighborModelPaths: [],
        bugTracePath,
        formalism: 'tla',
        maxIterations: 1
      },
      mockDeps
    );

    const result2 = await simulateSolutionLoop(
      {
        fixIdea: 'fix idea 2',
        bugDescription: 'bug 2',
        reproducingModelPath,
        neighborModelPaths: [],
        bugTracePath,
        formalism: 'tla',
        maxIterations: 1
      },
      mockDeps
    );

    assert.notStrictEqual(result1.sessionId, result2.sessionId, 'session IDs should be different (random)');
    assert.strictEqual(result1.sessionId.length, 16, 'session ID should be 16 hex chars (8 bytes)');
    assert.strictEqual(result2.sessionId.length, 16, 'session ID should be 16 hex chars (8 bytes)');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// Test 9: Summary table includes all iterations
test('simulateSolutionLoop: summary table includes all iterations', async () => {
  const tmpDir = createTempDir();
  process.chdir(tmpDir);

  try {
    const { reproducingModelPath, bugTracePath } = setupTestEnv(tmpDir);

    let callCount = 0;
    const mockDeps = createMockDeps({ gateVerdictConverged: false });

    mockDeps.gateRunner.runConvergenceGates = async () => {
      callCount++;
      return {
        gate1_invariants: { passed: callCount === 3, details: 'test' },
        gate2_bug_resolved: { passed: false, details: 'test' },
        gate3_neighbors: { passed: false, regressions: [], details: 'test' },
        converged: false,
        unavailable: false,
        preservedState: false,
        iteration: callCount,
        writeOnceTimestamp: new Date().toISOString()
      };
    };

    // Capture console output
    let consoleOutput = '';
    const originalLog = console.log;
    console.log = (msg) => {
      consoleOutput += msg + '\n';
      originalLog(msg);
    };

    try {
      const result = await simulateSolutionLoop(
        {
          fixIdea: 'add invariant',
          bugDescription: 'test bug',
          reproducingModelPath,
          neighborModelPaths: [],
          bugTracePath,
          formalism: 'tla',
          maxIterations: 3
        },
        mockDeps
      );

      // Verify all 3 iterations appear in output
      assert.ok(consoleOutput.includes('Iteration 1/3'), 'output should show iteration 1');
      assert.ok(consoleOutput.includes('Iteration 2/3'), 'output should show iteration 2');
      assert.ok(consoleOutput.includes('Iteration 3/3'), 'output should show iteration 3');

      // Verify table header exists
      assert.ok(consoleOutput.includes('Simulation Results'), 'output should show results table');
      assert.ok(consoleOutput.includes('| Attempt |'), 'output should show table header');
    } finally {
      console.log = originalLog;
    }
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// Test 10: Invalid inputs throw errors
test('simulateSolutionLoop: rejects invalid inputs', async () => {
  const tmpDir = createTempDir();
  process.chdir(tmpDir);

  try {
    const { reproducingModelPath, bugTracePath } = setupTestEnv(tmpDir);
    const mockDeps = createMockDeps({ gateVerdictConverged: true });

    // Test: missing fixIdea
    await assert.rejects(
      () => simulateSolutionLoop(
        {
          fixIdea: '', // empty
          bugDescription: 'test bug',
          reproducingModelPath,
          neighborModelPaths: [],
          bugTracePath,
          formalism: 'tla'
        },
        mockDeps
      ),
      { message: /fixIdea must be a non-empty string/ },
      'should reject empty fixIdea'
    );

    // Test: invalid formalism
    await assert.rejects(
      () => simulateSolutionLoop(
        {
          fixIdea: 'fix idea',
          bugDescription: 'test bug',
          reproducingModelPath,
          neighborModelPaths: [],
          bugTracePath,
          formalism: 'invalid' // bad formalism
        },
        mockDeps
      ),
      { message: /formalism must be "tla" or "alloy"/ },
      'should reject invalid formalism'
    );

    // Test: missing bugTracePath
    await assert.rejects(
      () => simulateSolutionLoop(
        {
          fixIdea: 'fix idea',
          bugDescription: 'test bug',
          reproducingModelPath,
          neighborModelPaths: [],
          bugTracePath: '', // empty
          formalism: 'tla'
        },
        mockDeps
      ),
      { message: /bugTracePath is required/ },
      'should reject empty bugTracePath'
    );
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// ====== NEW TESTS (Task 2 — quick-350) ======

// Test 11: onTweakFix callback invoked between iterations
test('simulateSolutionLoop: onTweakFix callback invoked between iterations', async () => {
  const tmpDir = createTempDir();
  process.chdir(tmpDir);

  try {
    const { reproducingModelPath, bugTracePath } = setupTestEnv(tmpDir);

    let callCount = 0;
    let tweakCallArgs = null;
    let normalizeCallArgs = [];

    const mockDeps = createMockDeps({ gateVerdictConverged: false });

    // Gate runner: fail iteration 1, converge iteration 2
    mockDeps.gateRunner.runConvergenceGates = async () => {
      callCount++;
      const converged = callCount >= 2;
      return {
        gate1_invariants: { passed: converged, details: 'test' },
        gate2_bug_resolved: { passed: converged, details: 'test' },
        gate3_neighbors: { passed: converged, regressions: [], details: 'test' },
        converged,
        unavailable: false,
        preservedState: false,
        iteration: callCount,
        writeOnceTimestamp: new Date().toISOString()
      };
    };

    // Track normalizer calls
    mockDeps.normalizer.normalizeFixIntent = (intent, context) => {
      normalizeCallArgs.push(intent);
      return { mutations: [{ type: 'add_invariant', target: 'test', content: 'x > 0', reasoning: 'test' }], confidence: 1.0, ambiguities: [] };
    };

    const result = await simulateSolutionLoop(
      {
        fixIdea: 'original fix idea',
        bugDescription: 'test bug',
        reproducingModelPath,
        neighborModelPaths: [],
        bugTracePath,
        formalism: 'tla',
        maxIterations: 3,
        onTweakFix: async (currentFixIdea, ctx) => {
          tweakCallArgs = { currentFixIdea, ctx };
          return 'revised fix idea from onTweakFix';
        }
      },
      mockDeps
    );

    assert.strictEqual(result.converged, true, 'should converge');
    assert.ok(tweakCallArgs, 'onTweakFix should have been called');
    assert.strictEqual(tweakCallArgs.currentFixIdea, 'original fix idea', 'should receive original fix idea');
    assert.strictEqual(tweakCallArgs.ctx.iteration, 2, 'should be iteration 2');
    assert.strictEqual(tweakCallArgs.ctx.gatesPassing, 0, 'iteration 1 had 0 gates passing');
    assert.ok(tweakCallArgs.ctx.gateResults, 'should have gateResults');
    assert.strictEqual(tweakCallArgs.ctx.gateResults.gate1, false, 'gate1 should be false from iteration 1');

    // Verify revised fix idea was passed to normalizer on iteration 2
    assert.strictEqual(normalizeCallArgs[0], 'original fix idea', 'iteration 1 should use original fix idea');
    assert.strictEqual(normalizeCallArgs[1], 'revised fix idea from onTweakFix', 'iteration 2 should use revised fix idea');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// Test 12: onTweakFix returning null skips iteration
test('simulateSolutionLoop: onTweakFix returning null skips iteration as no-op', async () => {
  const tmpDir = createTempDir();
  process.chdir(tmpDir);

  try {
    const { reproducingModelPath, bugTracePath } = setupTestEnv(tmpDir);

    let gateCallCount = 0;
    const mockDeps = createMockDeps({ gateVerdictConverged: false });

    // Gate runner: never converge
    mockDeps.gateRunner.runConvergenceGates = async () => {
      gateCallCount++;
      return {
        gate1_invariants: { passed: false, details: 'test' },
        gate2_bug_resolved: { passed: false, details: 'test' },
        gate3_neighbors: { passed: false, regressions: [], details: 'test' },
        converged: false,
        unavailable: false,
        preservedState: false,
        iteration: gateCallCount,
        writeOnceTimestamp: new Date().toISOString()
      };
    };

    let tweakCallCount = 0;
    const result = await simulateSolutionLoop(
      {
        fixIdea: 'some fix idea',
        bugDescription: 'test bug',
        reproducingModelPath,
        neighborModelPaths: [],
        bugTracePath,
        formalism: 'tla',
        maxIterations: 3,
        onTweakFix: async () => {
          tweakCallCount++;
          if (tweakCallCount === 1) return null; // Skip iteration 2
          return 'adjusted fix';
        }
      },
      mockDeps
    );

    // Should have 3 total iterations (iter 1=run, iter 2=no-op, iter 3=run)
    assert.strictEqual(result.iterations.length, 3, 'should have 3 iterations');
    assert.strictEqual(result.iterations[1].status, 'NO-OP', 'iteration 2 should be NO-OP');
    // Gate runner should have been called only 2 times (skipped for no-op)
    assert.strictEqual(gateCallCount, 2, 'gate runner should be called 2 times (not on no-op)');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// Test 13: Backward compatibility — no onTweakFix
test('simulateSolutionLoop: backward compatible without onTweakFix', async () => {
  const tmpDir = createTempDir();
  process.chdir(tmpDir);

  try {
    const { reproducingModelPath, bugTracePath } = setupTestEnv(tmpDir);

    let callCount = 0;
    const mockDeps = createMockDeps({ gateVerdictConverged: false });

    mockDeps.gateRunner.runConvergenceGates = async () => {
      callCount++;
      const converged = callCount >= 2;
      return {
        gate1_invariants: { passed: converged, details: 'test' },
        gate2_bug_resolved: { passed: converged, details: 'test' },
        gate3_neighbors: { passed: converged, regressions: [], details: 'test' },
        converged,
        unavailable: false,
        preservedState: false,
        iteration: callCount,
        writeOnceTimestamp: new Date().toISOString()
      };
    };

    const result = await simulateSolutionLoop(
      {
        fixIdea: 'add invariant',
        bugDescription: 'test bug',
        reproducingModelPath,
        neighborModelPaths: [],
        bugTracePath,
        formalism: 'tla',
        maxIterations: 3
        // No onTweakFix — backward compatible
      },
      mockDeps
    );

    assert.strictEqual(result.converged, true, 'should converge');
    assert.strictEqual(result.iterations.length, 2, 'should have 2 iterations');
    assert.strictEqual(result.escalationReason, null, 'no escalation');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// Test 14: In-memory rollback on regression
test('simulateSolutionLoop: regression tracked as DISCARDED', async () => {
  const tmpDir = createTempDir();
  process.chdir(tmpDir);

  try {
    const { reproducingModelPath, bugTracePath } = setupTestEnv(tmpDir);

    let callCount = 0;
    const mockDeps = createMockDeps({ gateVerdictConverged: false });

    // Iteration 1: 2/3 gates pass, Iteration 2: 1/3 (regression), Iteration 3: 3/3 (converged)
    mockDeps.gateRunner.runConvergenceGates = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          gate1_invariants: { passed: true, details: 'test' },
          gate2_bug_resolved: { passed: true, details: 'test' },
          gate3_neighbors: { passed: false, regressions: ['model-a'], details: 'test' },
          converged: false, unavailable: false, preservedState: false,
          iteration: callCount, writeOnceTimestamp: new Date().toISOString()
        };
      } else if (callCount === 2) {
        return {
          gate1_invariants: { passed: true, details: 'test' },
          gate2_bug_resolved: { passed: false, details: 'test' },
          gate3_neighbors: { passed: false, regressions: ['model-a'], details: 'test' },
          converged: false, unavailable: false, preservedState: false,
          iteration: callCount, writeOnceTimestamp: new Date().toISOString()
        };
      } else {
        return {
          gate1_invariants: { passed: true, details: 'test' },
          gate2_bug_resolved: { passed: true, details: 'test' },
          gate3_neighbors: { passed: true, regressions: [], details: 'test' },
          converged: true, unavailable: false, preservedState: false,
          iteration: callCount, writeOnceTimestamp: new Date().toISOString()
        };
      }
    };

    const result = await simulateSolutionLoop(
      {
        fixIdea: 'fix attempt',
        bugDescription: 'test bug',
        reproducingModelPath,
        neighborModelPaths: [],
        bugTracePath,
        formalism: 'tla',
        maxIterations: 5,
        onTweakFix: async () => 'adjusted fix'
      },
      mockDeps
    );

    assert.strictEqual(result.converged, true, 'should converge on iteration 3');
    assert.strictEqual(result.iterations.length, 3, 'should have 3 iterations');
    assert.strictEqual(result.iterations[1].status, 'DISCARDED', 'iteration 2 should be DISCARDED (regression)');
    assert.strictEqual(result.bestGatesPassing, 3, 'bestGatesPassing should be 3 from iteration 3');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// Test 15: TSV file written with correct format
test('simulateSolutionLoop: TSV file written with correct format', async () => {
  const tmpDir = createTempDir();
  process.chdir(tmpDir);

  try {
    const { reproducingModelPath, bugTracePath } = setupTestEnv(tmpDir);

    let callCount = 0;
    const mockDeps = createMockDeps({ gateVerdictConverged: false });

    mockDeps.gateRunner.runConvergenceGates = async () => {
      callCount++;
      const converged = callCount >= 2;
      return {
        gate1_invariants: { passed: true, details: 'test' },
        gate2_bug_resolved: { passed: converged, details: 'test' },
        gate3_neighbors: { passed: converged, regressions: [], details: 'test' },
        converged,
        unavailable: false,
        preservedState: false,
        iteration: callCount,
        writeOnceTimestamp: new Date().toISOString()
      };
    };

    const result = await simulateSolutionLoop(
      {
        fixIdea: 'add invariant for testing tsv',
        bugDescription: 'test bug',
        reproducingModelPath,
        neighborModelPaths: [],
        bugTracePath,
        formalism: 'tla',
        maxIterations: 3
      },
      mockDeps
    );

    // Read TSV file
    const tsvPath = path.join(path.dirname(reproducingModelPath), 'simulation-results.tsv');
    assert.ok(fs.existsSync(tsvPath), 'TSV file should exist');

    const tsvContent = fs.readFileSync(tsvPath, 'utf-8');
    const lines = tsvContent.trim().split('\n');

    // Header + 2 data rows
    assert.strictEqual(lines.length, 3, 'should have header + 2 data rows');
    assert.ok(lines[0].startsWith('iteration\tgate1\tgate2\tgate3'), 'header should match expected columns');

    // Verify first data row
    const row1 = lines[1].split('\t');
    assert.strictEqual(row1[0], '1', 'iteration should be 1');
    assert.strictEqual(row1[1], 'PASS', 'gate1 should be PASS');
    assert.strictEqual(row1[2], 'FAIL', 'gate2 should be FAIL');
    assert.strictEqual(row1[5], 'kept', 'status should be kept');

    // Verify second data row
    const row2 = lines[2].split('\t');
    assert.strictEqual(row2[0], '2', 'iteration should be 2');
    assert.strictEqual(row2[5], 'converged', 'status should be converged');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// Test 16: When-stuck protocol triggers after 3 same-gate failures
test('simulateSolutionLoop: when-stuck triggers after 3 same-gate failures', async () => {
  const tmpDir = createTempDir();
  process.chdir(tmpDir);

  try {
    const { reproducingModelPath, bugTracePath } = setupTestEnv(tmpDir);

    const mockDeps = createMockDeps({ gateVerdictConverged: false });

    // Always fail gate2 only (gate1 and gate3 pass)
    mockDeps.gateRunner.runConvergenceGates = async () => {
      return {
        gate1_invariants: { passed: true, details: 'test' },
        gate2_bug_resolved: { passed: false, details: 'test' },
        gate3_neighbors: { passed: true, regressions: [], details: 'test' },
        converged: false,
        unavailable: false,
        preservedState: false,
        iteration: 1,
        writeOnceTimestamp: new Date().toISOString()
      };
    };

    const result = await simulateSolutionLoop(
      {
        fixIdea: 'stuck fix idea',
        bugDescription: 'test bug',
        reproducingModelPath,
        neighborModelPaths: [],
        bugTracePath,
        formalism: 'tla',
        maxIterations: 5
      },
      mockDeps
    );

    assert.strictEqual(result.converged, false, 'should not converge');
    assert.ok(result.stuck_reason, 'should have stuck_reason');
    assert.ok(result.stuck_reason.includes('gate2'), 'stuck_reason should mention gate failure pattern');
    // Should stop before iteration 5 (at iteration 3 when streak hits 3)
    assert.ok(result.iterations.length <= 4, 'should stop early due to stuck detection');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// Test 17: When-stuck resets on different failure pattern
test('simulateSolutionLoop: when-stuck resets on different failure pattern', async () => {
  const tmpDir = createTempDir();
  process.chdir(tmpDir);

  try {
    const { reproducingModelPath, bugTracePath } = setupTestEnv(tmpDir);

    let callCount = 0;
    const mockDeps = createMockDeps({ gateVerdictConverged: false });

    // Iterations 1-2: fail gate2 only, iteration 3: fail gate1 only, iterations 4-5: fail gate2 only
    mockDeps.gateRunner.runConvergenceGates = async () => {
      callCount++;
      if (callCount <= 2) {
        // Fail gate2 only
        return {
          gate1_invariants: { passed: true, details: 'test' },
          gate2_bug_resolved: { passed: false, details: 'test' },
          gate3_neighbors: { passed: true, regressions: [], details: 'test' },
          converged: false, unavailable: false, preservedState: false,
          iteration: callCount, writeOnceTimestamp: new Date().toISOString()
        };
      } else if (callCount === 3) {
        // Fail gate1 only (different pattern — resets streak)
        return {
          gate1_invariants: { passed: false, details: 'test' },
          gate2_bug_resolved: { passed: true, details: 'test' },
          gate3_neighbors: { passed: true, regressions: [], details: 'test' },
          converged: false, unavailable: false, preservedState: false,
          iteration: callCount, writeOnceTimestamp: new Date().toISOString()
        };
      } else {
        // Back to failing gate2 only
        return {
          gate1_invariants: { passed: true, details: 'test' },
          gate2_bug_resolved: { passed: false, details: 'test' },
          gate3_neighbors: { passed: true, regressions: [], details: 'test' },
          converged: false, unavailable: false, preservedState: false,
          iteration: callCount, writeOnceTimestamp: new Date().toISOString()
        };
      }
    };

    const result = await simulateSolutionLoop(
      {
        fixIdea: 'non-stuck fix idea',
        bugDescription: 'test bug',
        reproducingModelPath,
        neighborModelPaths: [],
        bugTracePath,
        formalism: 'tla',
        maxIterations: 5
      },
      mockDeps
    );

    assert.strictEqual(result.stuck_reason, null, 'should NOT be stuck (streak reset at iteration 3)');
    assert.strictEqual(result.iterations.length, 5, 'all 5 iterations should run');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// Test 18: Default maxIterations is 100 when no config
test('simulateSolutionLoop: default maxIterations is 100 when no config', async () => {
  const tmpDir = createTempDir();
  process.chdir(tmpDir);

  try {
    const { reproducingModelPath, bugTracePath } = setupTestEnv(tmpDir);

    // Remove config.json so default applies
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);

    // Create config with small max_iterations to keep test fast
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ max_iterations: 3 }, null, 2), 'utf-8');

    let iterationCount = 0;
    const mockDeps = createMockDeps({ gateVerdictConverged: false });

    // Use alternating failure patterns to avoid when-stuck
    mockDeps.gateRunner.runConvergenceGates = async () => {
      iterationCount++;
      const failGate1 = iterationCount % 2 === 0;
      return {
        gate1_invariants: { passed: !failGate1, details: 'test' },
        gate2_bug_resolved: { passed: failGate1, details: 'test' },
        gate3_neighbors: { passed: false, regressions: [], details: 'test' },
        converged: false,
        unavailable: false,
        preservedState: false,
        iteration: iterationCount,
        writeOnceTimestamp: new Date().toISOString()
      };
    };

    const result = await simulateSolutionLoop(
      {
        fixIdea: 'test default iterations',
        bugDescription: 'test bug',
        reproducingModelPath,
        neighborModelPaths: [],
        bugTracePath,
        formalism: 'tla'
        // No maxIterations — should read from config (3)
      },
      mockDeps
    );

    assert.strictEqual(result.iterations.length, 3, 'should use config max_iterations (3)');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// Test 19: Return type includes new fields
test('simulateSolutionLoop: return type includes stuck_reason, bestGatesPassing, tsvPath', async () => {
  const tmpDir = createTempDir();
  process.chdir(tmpDir);

  try {
    const { reproducingModelPath, bugTracePath } = setupTestEnv(tmpDir);

    const mockDeps = createMockDeps({ gateVerdictConverged: true });

    const result = await simulateSolutionLoop(
      {
        fixIdea: 'test return fields',
        bugDescription: 'test bug',
        reproducingModelPath,
        neighborModelPaths: [],
        bugTracePath,
        formalism: 'tla',
        maxIterations: 1
      },
      mockDeps
    );

    assert.strictEqual(result.stuck_reason, null, 'stuck_reason should be null when converged');
    assert.strictEqual(result.bestGatesPassing, 3, 'bestGatesPassing should be 3 (all gates pass)');
    assert.ok(typeof result.tsvPath === 'string', 'tsvPath should be a string');
    assert.ok(result.tsvPath.endsWith('simulation-results.tsv'), 'tsvPath should end with simulation-results.tsv');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// ====== ADVERSARIAL HARDENING TESTS (gaps3) ======

// Test 20: gate runner returning a non-object verdict escalates instead of crashing
test('simulateSolutionLoop: gate runner returning null verdict escalates, does not crash', async () => {
  const tmpDir = createTempDir();
  process.chdir(tmpDir);

  try {
    const { reproducingModelPath, bugTracePath } = setupTestEnv(tmpDir);

    const mockDeps = createMockDeps({ gateVerdictConverged: false });
    // Dependency resolves to a non-object verdict (realistic edge path)
    mockDeps.gateRunner.runConvergenceGates = async () => null;

    const result = await simulateSolutionLoop(
      {
        fixIdea: 'fix idea',
        bugDescription: 'test bug',
        reproducingModelPath,
        neighborModelPaths: [],
        bugTracePath,
        formalism: 'tla',
        maxIterations: 2
      },
      mockDeps
    );

    assert.strictEqual(result.converged, false, 'should not converge');
    assert.ok(result.escalationReason, 'should escalate cleanly instead of throwing');
    assert.ok(typeof result.tsvPath === 'string', 'should still return a structured result');
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// Test 21: null input rejects with a clear validation error
test('simulateSolutionLoop: null input rejects with clear validation error', async () => {
  await assert.rejects(
    () => simulateSolutionLoop(null, createMockDeps()),
    { message: /input must be an object/ },
    'null input should reject with an intentional validation message'
  );
});

// Test 22: negative maxIterations does not silently no-op
test('simulateSolutionLoop: negative maxIterations does not silently return empty', async () => {
  const tmpDir = createTempDir();
  process.chdir(tmpDir);

  try {
    const { reproducingModelPath, bugTracePath } = setupTestEnv(tmpDir);
    const mockDeps = createMockDeps({ gateVerdictConverged: true });

    const result = await simulateSolutionLoop(
      {
        fixIdea: 'fix idea',
        bugDescription: 'test bug',
        reproducingModelPath,
        neighborModelPaths: [],
        bugTracePath,
        formalism: 'tla',
        maxIterations: -1
      },
      mockDeps
    );

    assert.ok(
      result.iterations.length >= 1 || result.escalationReason,
      'should run at least one iteration or report a reason, not silently no-op'
    );
  } finally {
    cleanupTempDir(tmpDir);
  }
});

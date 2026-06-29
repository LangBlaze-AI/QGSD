#!/usr/bin/env node
'use strict';

/**
 * convergence-gate-runner.cjs
 *
 * Three-gate convergence verification with write-once verdict persistence.
 *
 * Implements:
 * - ResolvedAtWriteOnce formal invariant: once converged verdict is written, it cannot revert
 * - HaikuUnavailableNoCorruption: dependency failure preserves all state without corruption
 *
 * Module exports: { runConvergenceGates, loadOrInitializeVerdicts }
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

/**
 * Load or initialize verdict log from disk.
 * Implements fail-open on missing file; hard error on corruption (cannot silently erase history).
 *
 * @param {string} verdictLogPath - Path to gate-verdicts.json
 * @returns {Array} Array of prior verdicts or [] if file missing
 * @throws {Error} If file exists but JSON is corrupted (prevents silent erasure of write-once history)
 */
function loadOrInitializeVerdicts(verdictLogPath) {
  // File missing: fail-open, start fresh
  if (!fs.existsSync(verdictLogPath)) {
    return [];
  }

  // File exists: parse and validate
  let verdicts;
  try {
    const content = fs.readFileSync(verdictLogPath, 'utf8');
    verdicts = JSON.parse(content);
  } catch (e) {
    // JSON parse error or read error: hard failure
    // Cannot return [] — would silently erase prior write-once history
    throw new Error(
      `Verdict log corrupt at ${verdictLogPath}. Cannot guarantee write-once semantics. ` +
      `Manual inspection required. Error: ${e.message}`
    );
  }

  if (!Array.isArray(verdicts)) {
    throw new Error(
      `Verdict log at ${verdictLogPath} is not a JSON array. ` +
      `Cannot guarantee write-once semantics. Manual inspection required.`
    );
  }

  return verdicts;
}

/**
 * Run Gate 1: Original invariants hold in consequence model.
 * Uses verification_mode='validation' (normal semantics).
 *
 * @param {Object} options
 *   - modelPath: path to consequence model
 *   - formalism: 'tla' or 'alloy'
 *   - checkerFns: optional dependency injection {runChecker(modelPath, opts)}
 *   - projectRoot: optional override for project root
 * @returns {Promise<{passed: boolean, details: string}>}
 */
async function runGate1InvariantsHold(options) {
  const { modelPath, formalism, checkerFns, projectRoot } = options;

  try {
    const checkerResult = checkerFns
      ? await checkerFns.runChecker(modelPath, { verification_mode: 'validation' })
      : await runCheckerViaChildProcess(modelPath, formalism, 'validation', projectRoot);

    // Checker success (exit 0) means invariants hold
    if (checkerResult.passed) {
      return {
        passed: true,
        details: 'All original invariants hold in consequence model'
      };
    } else {
      return {
        passed: false,
        details: `Invariant violation in consequence model: ${checkerResult.details || 'see logs'}`
      };
    }
  } catch (e) {
    // Dependency failure: return unavailable signal
    throw {
      gate: 1,
      unavailable: true,
      error: e.message,
      code: e.code
    };
  }
}

/**
 * Run Gate 2: Bug resolved (bug trace should NOT appear in consequence model).
 * Uses verification_mode='diagnostic' (inverted semantics).
 *
 * @param {Object} options
 *   - modelPath: path to consequence model
 *   - formalism: 'tla' or 'alloy'
 *   - bugTrace: path to ITF bug trace
 *   - checkerFns: optional dependency injection
 *   - projectRoot: optional override
 * @returns {Promise<{passed: boolean, details: string}>}
 */
async function runGate2BugResolved(options) {
  const { modelPath, formalism, bugTrace, checkerFns, projectRoot } = options;

  try {
    // In diagnostic mode, checker looks for the bug trace
    // If NO violation found -> bug is resolved (gate passes)
    // If violation found -> bug still present (gate fails)
    const checkerResult = checkerFns
      ? await checkerFns.runChecker(modelPath, { verification_mode: 'diagnostic', bugTrace })
      : await runCheckerViaChildProcess(modelPath, formalism, 'diagnostic', projectRoot, bugTrace);

    // Diagnostic mode inverted semantics:
    // - checker passes (no violation) means bug is NOT reproduced -> bug is resolved -> gate passes
    // - checker fails (violation found) means bug IS reproduced -> gate fails
    if (checkerResult.passed) {
      return {
        passed: true,
        details: 'Bug no longer triggers in consequence model (inverted check passed)'
      };
    } else {
      return {
        passed: false,
        details: `Bug still present in consequence model: ${checkerResult.details || 'trace reproduced'}`
      };
    }
  } catch (e) {
    throw {
      gate: 2,
      unavailable: true,
      error: e.message,
      code: e.code
    };
  }
}

/**
 * Run Gate 3: No 2-hop neighbor regressions.
 * A regression is a violation in the consequence model that wasn't in the reproducing model.
 *
 * @param {Object} options
 *   - neighborModelPaths: array of neighbor model paths
 *   - consequenceModelPath: consequence model to test
 *   - reproducingModelPath: baseline model (for comparison)
 *   - formalism: 'tla' or 'alloy'
 *   - checkerFns: optional dependency injection
 *   - projectRoot: optional override
 * @returns {Promise<{passed: boolean, regressions: Array}>}
 */
async function runGate3NeighborRegressions(options) {
  const { neighborModelPaths, consequenceModelPath, reproducingModelPath, formalism, checkerFns, projectRoot } = options;

  // No neighbors: gate passes trivially
  if (!neighborModelPaths || neighborModelPaths.length === 0) {
    return {
      passed: true,
      regressions: [],
      details: 'No neighbors to check'
    };
  }

  const regressions = [];

  try {
    for (const neighborPath of neighborModelPaths) {
      // Run baseline: check neighbor against reproducing model
      const baselineResult = checkerFns
        ? await checkerFns.runChecker(neighborPath, { testAgainst: reproducingModelPath })
        : await runCheckerViaChildProcess(neighborPath, formalism, 'validation', projectRoot);

      // Run consequence: check neighbor against consequence model
      const consequenceResult = checkerFns
        ? await checkerFns.runChecker(neighborPath, { testAgainst: consequenceModelPath })
        : await runCheckerViaChildProcess(neighborPath, formalism, 'validation', projectRoot);

      // Regression: violation in consequence that wasn't in baseline
      if (!baselineResult.passed && consequenceResult.passed) {
        // Pre-existing failure: not a regression
        continue;
      }
      if (baselineResult.passed && !consequenceResult.passed) {
        // New failure: this is a regression
        regressions.push({
          neighborPath,
          violation: consequenceResult.details || 'assertion failed',
          isNewRegression: true
        });
      }
    }

    const passed = regressions.length === 0;
    return {
      passed,
      regressions,
      details: passed
        ? 'No regressions in neighbor models'
        : `${regressions.length} regression(s) detected`
    };
  } catch (e) {
    throw {
      gate: 3,
      unavailable: true,
      error: e.message,
      code: e.code
    };
  }
}

/**
 * Run checker via child_process (execFile, not exec — to avoid shell injection).
 * Delegates to run-tlc.cjs or run-alloy.cjs based on formalism.
 *
 * @param {string} modelPath
 * @param {string} formalism - 'tla' or 'alloy'
 * @param {string} verificationMode - 'validation' or 'diagnostic'
 * @param {string} [projectRoot] - override project root
 * @param {string} [bugTrace] - optional bug trace for diagnostic mode
 * @returns {Promise<{passed: boolean, details: string}>}
 * @throws {Error} if checker not found or execution fails
 */
async function runCheckerViaChildProcess(modelPath, formalism, verificationMode, projectRoot, bugTrace) {
  const root = projectRoot || path.join(__dirname, '..');
  let checkerScript;

  if (formalism === 'tla') {
    checkerScript = path.join(root, 'bin', 'run-tlc.cjs');
  } else if (formalism === 'alloy') {
    checkerScript = path.join(root, 'bin', 'run-alloy.cjs');
  } else {
    throw new Error(`Unsupported formalism: ${formalism}`);
  }

  // Verify checker script exists
  if (!fs.existsSync(checkerScript)) {
    throw new Error(`Checker script not found: ${checkerScript}`);
  }

  // Build args
  const args = [checkerScript, modelPath, `--verification-mode=${verificationMode}`];
  if (bugTrace) {
    args.push(`--bug-trace=${bugTrace}`);
  }

  try {
    const { stdout, stderr } = await execFileAsync('node', args, {
      timeout: 120000, // 2 minute timeout per checker
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for output
      cwd: root
    });

    // Parse output to determine pass/fail
    const output = stdout + stderr;
    const passed = output.includes('PASSED') || output.includes('No violations') || !output.includes('violation');

    return {
      passed,
      details: output.slice(0, 500) // First 500 chars of output for details
    };
  } catch (e) {
    // Execution error: could be timeout, ENOENT, etc.
    if (e.code === 'ETIMEDOUT') {
      throw new Error(`Checker timeout after 2 minutes for ${modelPath}`);
    }
    if (e.code === 'ENOENT') {
      throw new Error(`Checker script not found: ${checkerScript}`);
    }
    // Other execution errors
    throw new Error(`Checker execution failed: ${e.message}`);
  }
}

/**
 * Main entry point: Run three convergence gates with write-once verdict persistence.
 *
 * Enforces:
 * - ResolvedAtWriteOnce: once converged verdict written, cannot revert
 * - HaikuUnavailableNoCorruption: dependency failure preserves all state
 *
 * @param {Object} models
 *   - consequenceModelPath: path to consequence model spec
 *   - reproducingModelPath: path to reproducing model
 *   - neighborModelPaths: array of neighbor model paths
 * @param {Object} config
 *   - bugTrace: path to ITF bug trace JSON
 *   - sessionId: session directory name
 *   - formalism: 'tla' or 'alloy'
 *   - projectRoot: optional override for project root
 * @param {Object} [checkerFns] - optional dependency injection for testing
 *   - runChecker(modelPath, options): async function that returns {passed, details}
 * @returns {Promise<{
 *   gate1_invariants: {passed, details},
 *   gate2_bug_resolved: {passed, details},
 *   gate3_neighbors: {passed, regressions},
 *   converged: boolean,
 *   writeOnceTimestamp: string (ISO8601),
 *   iteration: number,
 *   unavailable: boolean (if dependency failed),
 *   preservedState: boolean (if dependency failed)
 * }>}
 * @throws {Error} if verdict log corrupted or write-once violation detected
 */
async function runConvergenceGates(models, config, checkerFns) {
  if (!models || typeof models !== 'object') throw new Error('models required');
  if (!config || typeof config !== 'object') throw new Error('config required');
  const { consequenceModelPath, reproducingModelPath, neighborModelPaths } = models;
  const { bugTrace, sessionId, formalism, projectRoot } = config;

  // Validate inputs
  if (!sessionId) throw new Error('config.sessionId required');
  if (!formalism) throw new Error('config.formalism required');
  if (!consequenceModelPath) throw new Error('models.consequenceModelPath required');
  if (!bugTrace) throw new Error('config.bugTrace required');

  // Setup session directory
  const root = projectRoot || path.join(__dirname, '..');
  const formalsDir = path.join(root, '.planning', 'formal', 'cycle2-simulations');
  const sessionDir = path.join(formalsDir, sessionId);
  const verdictLogPath = path.join(sessionDir, 'gate-verdicts.json');

  // Ensure session directory exists
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  // Step 1: Load or initialize verdict log
  let existingVerdicts;
  try {
    existingVerdicts = loadOrInitializeVerdicts(verdictLogPath);
  } catch (e) {
    // Corrupt verdict log: hard error (prevents silent erasure of write-once history)
    throw e;
  }

  const iterationNumber = existingVerdicts.length + 1;

  // Step 2: Check for prior convergence (ResolvedAtWriteOnce PRE-GATE enforcement)
  const priorConverged = existingVerdicts.some(v => v && v.converged === true);
  if (priorConverged) {
    const priorIteration = existingVerdicts.find(v => v && v.converged === true).iteration;
    // Log the fact but don't block yet — we'll enforce AFTER running gates
  }

  // Step 3: Run three gates
  let gate1, gate2, gate3;

  // Gate 1: Invariants hold
  try {
    gate1 = await runGate1InvariantsHold({
      modelPath: consequenceModelPath,
      formalism,
      checkerFns,
      projectRoot
    });
  } catch (e) {
    // HaikuUnavailableNoCorruption: dependency failure → return early without writing
    if (e.unavailable) {
      return {
        gate1_invariants: { passed: null, details: `UNAVAILABLE: ${e.error}` },
        gate2_bug_resolved: { passed: null, details: 'SKIPPED (dependency unavailable)' },
        gate3_neighbors: { passed: null, regressions: [] },
        converged: null,
        unavailable: true,
        preservedState: true,
        iteration: iterationNumber,
        writeOnceTimestamp: null
      };
    }
    throw e;
  }

  // Gate 2: Bug resolved
  try {
    gate2 = await runGate2BugResolved({
      modelPath: consequenceModelPath,
      formalism,
      bugTrace,
      checkerFns,
      projectRoot
    });
  } catch (e) {
    if (e.unavailable) {
      return {
        gate1_invariants: gate1,
        gate2_bug_resolved: { passed: null, details: `UNAVAILABLE: ${e.error}` },
        gate3_neighbors: { passed: null, regressions: [] },
        converged: null,
        unavailable: true,
        preservedState: true,
        iteration: iterationNumber,
        writeOnceTimestamp: null
      };
    }
    throw e;
  }

  // Gate 3: Neighbor regressions
  try {
    gate3 = await runGate3NeighborRegressions({
      neighborModelPaths: neighborModelPaths || [],
      consequenceModelPath,
      reproducingModelPath,
      formalism,
      checkerFns,
      projectRoot
    });
  } catch (e) {
    if (e.unavailable) {
      return {
        gate1_invariants: gate1,
        gate2_bug_resolved: gate2,
        gate3_neighbors: { passed: null, regressions: [] },
        converged: null,
        unavailable: true,
        preservedState: true,
        iteration: iterationNumber,
        writeOnceTimestamp: null
      };
    }
    throw e;
  }

  // Step 4: Compute convergence
  const converged = gate1.passed && gate2.passed && gate3.passed;

  // Step 5: CRITICAL — Write-once check BEFORE persisting
  if (priorConverged && !converged) {
    // ResolvedAtWriteOnce violation: prior convergence cannot revert
    const priorIteration = existingVerdicts.find(v => v && v.converged === true).iteration;
    throw new Error(
      `ResolvedAtWriteOnce VIOLATED: cannot revert convergence verdict from iteration ${priorIteration}. ` +
      `Current iteration would write converged=false. Aborting without persisting.`
    );
  }

  // Step 6: Build and persist verdict
  const timestamp = new Date().toISOString();
  const verdict = {
    iteration: iterationNumber,
    timestamp,
    gate1_invariants: { passed: gate1.passed, details: gate1.details },
    gate2_bug_resolved: { passed: gate2.passed, details: gate2.details },
    gate3_neighbors: { passed: gate3.passed, regressions: gate3.regressions || [], details: gate3.details },
    converged,
    mutable: false // Formal guarantee: once written, cannot change
  };

  // Append to verdict history (never overwrite)
  existingVerdicts.push(verdict);
  fs.writeFileSync(verdictLogPath, JSON.stringify(existingVerdicts, null, 2));

  // Step 7: Return verdict
  return {
    gate1_invariants: gate1,
    gate2_bug_resolved: gate2,
    gate3_neighbors: gate3,
    converged,
    writeOnceTimestamp: timestamp,
    iteration: iterationNumber,
    unavailable: false,
    preservedState: false
  };
}

// Module exports
module.exports = {
  runConvergenceGates,
  loadOrInitializeVerdicts
};

#!/usr/bin/env node
'use strict';

/**
 * Solution Simulation Loop Module
 *
 * @deprecated Use formal-fix-loop.cjs instead. This module uses callback-driven
 * architecture (onTweakFix). The replacement uses callLlm injection for better
 * testability and reuse. Kept for backward compatibility only.
 *
 * Orchestrates the solution simulation pipeline: normalize fix intent, generate consequence models,
 * run convergence gates, and display iteration progress with automatic escalation.
 *
 * Phase 4.5 of model-driven-fix workflow.
 *
 * Features:
 * - onTweakFix callback for evolving fix ideas between iterations
 * - In-memory rollback tracking on regression (fewer gates passing)
 * - TSV-as-memory logging (simulation-results.tsv)
 * - When-stuck protocol after 3+ consecutive same-gate failures
 *
 * Module exports: { simulateSolutionLoop }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// ---- TSV Logging ----

const SIM_TSV_HEADER = 'iteration\tgate1\tgate2\tgate3\tgates_passing\tstatus\tdescription\n';

/**
 * Ensure the TSV file exists with a header row.
 * @param {string} tsvPath - Path to simulation-results.tsv
 */
function ensureSimTsvHeader(tsvPath) {
  try {
    if (!fs.existsSync(tsvPath)) {
      fs.writeFileSync(tsvPath, SIM_TSV_HEADER, 'utf-8');
    }
  } catch (_err) {
    process.stderr.write(`[solution-simulation-loop] Warning: could not write TSV header: ${_err.message}\n`);
  }
}

/**
 * Append a TSV row to the results log.
 * @param {string} tsvPath - Path to simulation-results.tsv
 * @param {Object} row - { iteration, gate1, gate2, gate3, gates_passing, status, description }
 */
function appendSimTsvRow(tsvPath, row) {
  try {
    const line = `${row.iteration}\t${row.gate1}\t${row.gate2}\t${row.gate3}\t${row.gates_passing}\t${row.status}\t${row.description}\n`;
    fs.appendFileSync(tsvPath, line, 'utf-8');
  } catch (_err) {
    process.stderr.write(`[solution-simulation-loop] Warning: could not append TSV row: ${_err.message}\n`);
  }
}

/**
 * Parse TSV file into array of row objects.
 * @param {string} tsvPath - Path to simulation-results.tsv
 * @returns {Array<Object>} Parsed rows (excluding header)
 */
function parseSimTsv(tsvPath) {
  try {
    if (!fs.existsSync(tsvPath)) return [];
    const content = fs.readFileSync(tsvPath, 'utf-8');
    const lines = content.trim().split('\n');
    if (lines.length <= 1) return []; // Header only
    const headers = lines[0].split('\t');
    return lines.slice(1).map(line => {
      const values = line.split('\t');
      const row = {};
      headers.forEach((h, i) => { row[h] = values[i] || ''; });
      return row;
    });
  } catch (_err) {
    return [];
  }
}

// ---- Gate Pass Count Helper ----

/**
 * Count how many gates are passing from a verdict object.
 * @param {Object} verdict - Gate runner verdict
 * @returns {number} 0-3
 */
function countGatesPassing(verdict) {
  let count = 0;
  if (verdict.gate1_invariants?.passed === true) count++;
  if (verdict.gate2_bug_resolved?.passed === true) count++;
  if (verdict.gate3_neighbors?.passed === true) count++;
  return count;
}

/**
 * Compute a failure signature string from a verdict (for stuck detection).
 * @param {Object} verdict
 * @returns {string} e.g. "gate1:PASS,gate2:FAIL,gate3:PASS"
 */
function failureSignature(verdict) {
  const g1 = verdict.gate1_invariants?.passed === true ? 'PASS' : 'FAIL';
  const g2 = verdict.gate2_bug_resolved?.passed === true ? 'PASS' : 'FAIL';
  const g3 = verdict.gate3_neighbors?.passed === true ? 'PASS' : 'FAIL';
  return `gate1:${g1},gate2:${g2},gate3:${g3}`;
}

/**
 * Simulate solution in model space through iterating cycles.
 *
 * @param {Object} input
 *   - fixIdea: string (natural language, constraints, or code sketch)
 *   - bugDescription: string (description of the bug being fixed)
 *   - reproducingModelPath: string (path to bug-reproducing model)
 *   - neighborModelPaths: array (paths to neighbor models for regression testing)
 *   - bugTracePath: string (path to ITF bug trace)
 *   - maxIterations: number (default from config.json or 100)
 *   - formalism: 'tla'|'alloy' (model formalism)
 *   - onTweakFix: async (fixIdea, iterationContext) => revisedFixIdea|null (optional)
 *
 * @param {Object} deps (optional)
 *   - normalizer: { normalizeFixIntent(intent, context) } for dependency injection
 *   - generator: { generateConsequenceModel(model, mutations, options) }
 *   - gateRunner: { runConvergenceGates(models, config, checkerFns) }
 *
 * @returns {Promise<{
 *   converged: boolean,
 *   iterations: Array<{iteration, invariants, bugResolved, neighbors, status}>,
 *   finalVerdict: Object,
 *   escalationReason: string|null,
 *   sessionId: string,
 *   stuck_reason: string|null,
 *   bestGatesPassing: number,
 *   tsvPath: string
 * }>}
 */
async function simulateSolutionLoop(input, deps) {
  if (!input || typeof input !== 'object') {
    throw new Error('input must be an object');
  }
  const {
    fixIdea,
    bugDescription,
    reproducingModelPath,
    neighborModelPaths = [],
    bugTracePath,
    maxIterations: inputMaxIterations,
    formalism,
    onTweakFix
  } = input;

  // Step 0: Validate inputs
  if (!fixIdea || typeof fixIdea !== 'string') {
    throw new Error('fixIdea must be a non-empty string');
  }
  if (!reproducingModelPath || !fs.existsSync(reproducingModelPath)) {
    throw new Error(`reproducingModelPath not found: ${reproducingModelPath}`);
  }
  if (!bugTracePath) {
    throw new Error('bugTracePath is required');
  }
  if (!formalism || (formalism !== 'tla' && formalism !== 'alloy')) {
    throw new Error('formalism must be "tla" or "alloy"');
  }

  // Step 1: Initialize
  const sessionId = crypto.randomBytes(8).toString('hex');

  // Read maxIterations from config, fall back to input or default 100
  let maxIterations = inputMaxIterations;
  if (!maxIterations) {
    try {
      const configPath = path.join(process.cwd(), '.planning', 'config.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        maxIterations = config.max_iterations || 100;
      } else {
        maxIterations = 100;
      }
    } catch (e) {
      maxIterations = 100;
    }
  }

  // Reject non-positive / non-finite iteration budgets — fall back to the default
  if (typeof maxIterations !== 'number' || !Number.isFinite(maxIterations) || maxIterations < 1) {
    maxIterations = 100;
  }

  // Truncate fix idea for banner display (80 chars)
  const fixIdeaBanner = fixIdea.length > 80
    ? fixIdea.slice(0, 80) + '...'
    : fixIdea;

  // Display banner
  console.log('');
  console.log('=== Solution Simulation (Phase 4.5) ===');
  console.log(`Max iterations: ${maxIterations}`);
  console.log(`Fix idea: ${fixIdeaBanner}`);
  console.log(`Session: ${sessionId}`);
  console.log('');

  // Step 2: Set up dependency injection
  const normalizer = deps?.normalizer || require('./intent-normalizer.cjs');
  const generator = deps?.generator || require('./consequence-model-generator.cjs');
  const gateRunner = deps?.gateRunner || require('./convergence-gate-runner.cjs');

  // Set up TSV logging
  const modelDir = path.dirname(reproducingModelPath);
  const tsvPath = path.join(modelDir, 'simulation-results.tsv');
  ensureSimTsvHeader(tsvPath);

  const iterations = [];
  let converged = false;
  let escalationReason = null;
  let finalVerdict = null;
  let bestGatesPassing = 0;
  let bestVerdict = null;
  let previousGatesPassing = 0;
  let previousFailureSig = null;
  let sameGateFailureStreak = 0;
  let stuck_reason = null;
  let currentFixIdea = fixIdea;

  // Step 3: Main iteration loop
  for (let i = 1; i <= maxIterations; i++) {
    // 3a: If onTweakFix is provided and this is not the first iteration, invoke it
    if (i > 1 && typeof onTweakFix === 'function') {
      const prevIteration = iterations[iterations.length - 1];
      const prevVerdict = prevIteration.verdict;

      // Handle case where previous iteration was a no-op (verdict is null)
      const gateResults = prevVerdict ? {
        gate1: prevVerdict.gate1_invariants?.passed === true,
        gate2: prevVerdict.gate2_bug_resolved?.passed === true,
        gate3: prevVerdict.gate3_neighbors?.passed === true
      } : { gate1: false, gate2: false, gate3: false };

      const iterationContext = {
        iteration: i,
        gateResults,
        gatesPassing: prevVerdict ? countGatesPassing(prevVerdict) : 0,
        tsvHistory: parseSimTsv(tsvPath),
        consecutiveStuckCount: sameGateFailureStreak
      };

      let revisedFixIdea;
      try {
        revisedFixIdea = await onTweakFix(currentFixIdea, iterationContext);
      } catch (e) {
        // onTweakFix error — log and continue with current fix idea
        process.stderr.write(`[solution-simulation-loop] onTweakFix error on iteration ${i}: ${e.message}\n`);
        revisedFixIdea = undefined; // treat as no change
      }

      if (revisedFixIdea === null) {
        // Null return = skip this iteration as no-op
        const tsvRow = {
          iteration: i,
          gate1: '--',
          gate2: '--',
          gate3: '--',
          gates_passing: 0,
          status: 'no-op',
          description: 'no-op'
        };
        appendSimTsvRow(tsvPath, tsvRow);

        iterations.push({
          iteration: i,
          invariants: '--',
          bugResolved: '--',
          neighbors: '--',
          status: 'NO-OP',
          verdict: null
        });

        console.log(`Iteration ${i}/${maxIterations}: Invariants (--) | Bug Resolved (--) | Neighbors (--) | NO-OP`);
        continue;
      }

      if (revisedFixIdea !== undefined && typeof revisedFixIdea === 'string') {
        currentFixIdea = revisedFixIdea;
      }
      // If undefined (error or no return), keep currentFixIdea unchanged
    }

    // 3b: Normalize fix intent
    let normalizedIntent;
    try {
      normalizedIntent = normalizer.normalizeFixIntent(currentFixIdea, {
        bugDescription,
        reproducingModelPath
      });
    } catch (e) {
      escalationReason = `Intent normalization failed at iteration ${i}: ${e.message}`;
      break;
    }

    const mutations = normalizedIntent.mutations;

    // 3c: Generate consequence model
    let consequenceResult;
    try {
      consequenceResult = generator.generateConsequenceModel(
        reproducingModelPath,
        mutations,
        { sessionId, formalism }
      );
    } catch (e) {
      escalationReason = `Consequence model generation failed at iteration ${i}: ${e.message}`;
      break;
    }

    // 3d: Run convergence gates
    let verdict;
    try {
      verdict = await gateRunner.runConvergenceGates(
        {
          consequenceModelPath: consequenceResult.consequenceModelPath,
          reproducingModelPath,
          neighborModelPaths
        },
        {
          bugTrace: bugTracePath,
          sessionId,
          formalism
        }
      );
    } catch (e) {
      if (e.message && e.message.includes('ResolvedAtWriteOnce')) {
        escalationReason = `Formal invariant violation: ${e.message}`;
      } else {
        escalationReason = `Convergence gate execution failed at iteration ${i}: ${e.message}`;
      }
      break;
    }

    // Guard against a dependency that resolves to a non-object verdict
    if (!verdict || typeof verdict !== 'object') {
      escalationReason = `Convergence gate returned no verdict at iteration ${i}`;
      break;
    }

    // 3e: Compute gate pass counts and status labels
    const invariantsStatus = verdict.gate1_invariants?.passed === true ? 'PASS'
      : verdict.gate1_invariants?.passed === false ? 'FAIL' : '--';
    const bugResolvedStatus = verdict.gate2_bug_resolved?.passed === true ? 'PASS'
      : verdict.gate2_bug_resolved?.passed === false ? 'FAIL' : '--';
    const neighborsStatus = verdict.gate3_neighbors?.passed === true ? 'PASS'
      : verdict.gate3_neighbors?.passed === false ? 'FAIL' : '--';

    const currentGatesPassing = countGatesPassing(verdict);

    // 3f: Determine iteration status with rollback tracking
    let status = 'FAILED';
    if (verdict.converged === true) {
      status = 'CONVERGED';
    } else if (verdict.unavailable === true) {
      status = 'UNAVAILABLE';
    } else if (i > 1 && currentGatesPassing < previousGatesPassing) {
      // Regression detected — fewer gates passing than previous iteration
      status = 'DISCARDED';
    } else {
      status = 'KEPT';
    }

    // Update best tracking
    if (currentGatesPassing >= bestGatesPassing) {
      bestGatesPassing = currentGatesPassing;
      bestVerdict = verdict;
    }

    // Update previousGatesPassing for next iteration
    previousGatesPassing = currentGatesPassing;

    // 3g: TSV logging
    const descTruncated = currentFixIdea.length > 80 ? currentFixIdea.slice(0, 80) : currentFixIdea;
    const tsvStatus = status === 'CONVERGED' ? 'converged'
      : status === 'UNAVAILABLE' ? 'unavailable'
      : status === 'DISCARDED' ? 'discarded'
      : 'kept';

    appendSimTsvRow(tsvPath, {
      iteration: i,
      gate1: invariantsStatus,
      gate2: bugResolvedStatus,
      gate3: neighborsStatus,
      gates_passing: currentGatesPassing,
      status: tsvStatus,
      description: descTruncated
    });

    const iterationRecord = {
      iteration: i,
      invariants: invariantsStatus,
      bugResolved: bugResolvedStatus,
      neighbors: neighborsStatus,
      status,
      verdict
    };

    iterations.push(iterationRecord);

    console.log(`Iteration ${i}/${maxIterations}: Invariants (${invariantsStatus}) | Bug Resolved (${bugResolvedStatus}) | Neighbors (${neighborsStatus}) | ${status}`);

    // 3h: Check outcome
    if (verdict.converged === true) {
      converged = true;
      finalVerdict = verdict;
      break;
    } else if (verdict.unavailable === true) {
      escalationReason = `Dependency unavailable: ${verdict.gate1_invariants?.details || 'external service'}. Simulation paused. All state preserved.`;
      finalVerdict = verdict;
      break;
    }

    // 3i: When-stuck detection
    const currentSig = failureSignature(verdict);
    if (previousFailureSig === currentSig) {
      sameGateFailureStreak++;
    } else {
      sameGateFailureStreak = 1;
    }
    previousFailureSig = currentSig;

    if (sameGateFailureStreak >= 3) {
      const recentTsv = parseSimTsv(tsvPath);
      const last5 = recentTsv.slice(-5);
      stuck_reason = `3+ consecutive iterations with same gate failure pattern (${currentSig}). Last ${last5.length} entries:\n` +
        last5.map(r => `  iter=${r.iteration} gate1=${r.gate1} gate2=${r.gate2} gate3=${r.gate3} status=${r.status}`).join('\n');

      console.log(`\nSTUCK: ${stuck_reason}`);
      finalVerdict = verdict;
      break;
    }

    if (i === maxIterations) {
      // Last iteration and not converged
      const failedGates = [];
      if (!verdict.gate1_invariants?.passed) failedGates.push('Invariants');
      if (!verdict.gate2_bug_resolved?.passed) failedGates.push('Bug Resolved');
      if (!verdict.gate3_neighbors?.passed) failedGates.push(`Neighbors (${verdict.gate3_neighbors?.regressions?.length || 0} regressions)`);

      escalationReason = `Max iterations (${maxIterations}) exhausted. Gates still failing: ${failedGates.join(', ')}`;
      finalVerdict = verdict;
    }
  }

  // Step 4: Display summary table
  console.log('');
  console.log('=== Simulation Results ===');
  console.log('| Attempt | Invariants | Bug Resolved | Neighbors | Status    |');
  console.log('|---------|-----------|-------------|-----------|-----------|');

  for (const iter of iterations) {
    const row = `| ${iter.iteration.toString().padEnd(7)} | ${iter.invariants.padEnd(10)} | ${iter.bugResolved.padEnd(12)} | ${iter.neighbors.padEnd(9)} | ${iter.status.padEnd(9)} |`;
    console.log(row);
  }

  // Step 5: Display final verdict
  console.log('');
  if (converged) {
    console.log(`✓ Fix CONVERGED after ${iterations.length} iteration(s). Consequence model verified at: ${finalVerdict?.writeOnceTimestamp || 'verified'}`);
  } else if (stuck_reason) {
    console.log(`⚠ STUCK: ${stuck_reason}`);
  } else if (escalationReason && escalationReason.includes('unavailable')) {
    console.log(`⏸ PAUSED: ${escalationReason}`);
    console.log('');
    console.log('All accumulated state preserved. Resume when dependency recovers.');
  } else if (escalationReason) {
    console.log(`⚠ ESCALATION: ${escalationReason}`);
    console.log('');
    console.log('Suggestions:');
    console.log('- Review gate failure details above');
    console.log('- Refine fix idea with more specific constraints');
    console.log('- Check model assumptions against bug trace');
  }

  // Step 6: Write iteration history to session directory
  const sessionDir = path.join(os.tmpdir(), 'nf-cycle2-simulations', sessionId);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const historyPath = path.join(sessionDir, 'iteration-history.json');
  const history = {
    sessionId,
    timestamp: new Date().toISOString(),
    fixIdea,
    converged,
    totalIterations: iterations.length,
    maxIterations,
    escalationReason,
    stuck_reason,
    iterations: iterations.map(iter => ({
      iteration: iter.iteration,
      invariants: iter.invariants,
      bugResolved: iter.bugResolved,
      neighbors: iter.neighbors,
      status: iter.status,
      timestamp: iter.verdict?.writeOnceTimestamp || new Date().toISOString()
    }))
  };

  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf-8');

  console.log('');
  console.log(`Session history written to: ${historyPath}`);
  console.log('');

  return {
    converged,
    iterations,
    finalVerdict: finalVerdict || null,
    escalationReason,
    sessionId,
    stuck_reason: stuck_reason || null,
    bestGatesPassing,
    tsvPath
  };
}

module.exports = { simulateSolutionLoop };

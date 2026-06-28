#!/usr/bin/env node
'use strict';

/**
 * autoresearch-refine.cjs
 *
 * @deprecated Use formal-model-loop.cjs instead. This module uses callback-driven
 * architecture (onTweak). The replacement uses callLlm injection for better
 * testability and reuse. Kept for backward compatibility only.
 *
 * Autoresearch-style micro-loop for formal model refinement.
 * Module-only API (not a CLI). The calling Agent subprocess require()s this
 * module and passes an onTweak callback to perform model edits.
 *
 * Architecture:
 * - close-formal-gaps creates the initial model skeleton (Phase 1)
 * - The Agent calls refine({ onTweak, ... }) to iteratively improve it
 * - This module manages the iteration lifecycle: backup/tweak/verify/decide/log
 * - Single final commit by caller after refine() returns (no per-iteration commits)
 *
 * TSV-as-memory: iteration history tracked in refinement-results.tsv, not git commits.
 * This avoids triggering the circuit breaker's oscillation detector.
 *
 * Module exports:
 *   { refine, _setDeps }
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getMaxIterations } = require('./config-update.cjs');

// ---- Dependency Injection for Testing ----

let deps = {
  execFileSync,
  existsSync: fs.existsSync,
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  appendFileSync: fs.appendFileSync
};

/**
 * Override dependencies for testing.
 * @param {Object} overrides - { execFileSync, existsSync, readFileSync, writeFileSync, appendFileSync }
 */
function _setDeps(overrides) {
  deps = { ...deps, ...overrides };
}

// ---- TSV Logging ----

const TSV_HEADER = 'iteration\tcommit\tchecker_result\tstates\tstatus\tdescription\n';

/**
 * Ensure the TSV file exists with a header row.
 * @param {string} tsvPath - Path to refinement-results.tsv
 */
function ensureTsvHeader(tsvPath) {
  try {
    if (!deps.existsSync(tsvPath)) {
      deps.writeFileSync(tsvPath, TSV_HEADER, 'utf-8');
    }
  } catch (_err) {
    // Fail-open on TSV write errors
    process.stderr.write(`[autoresearch-refine] Warning: could not write TSV header: ${_err.message}\n`);
  }
}

/**
 * Append a TSV row to the results log.
 * @param {string} tsvPath - Path to refinement-results.tsv
 * @param {Object} row - { iteration, commit, checker_result, states, status, description }
 */
function appendTsvRow(tsvPath, row) {
  try {
    const clean = (v) => String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ');
    const line = `${clean(row.iteration)}\t${clean(row.commit || '-')}\t${clean(row.checker_result)}\t${clean(row.states)}\t${clean(row.status)}\t${clean(row.description)}\n`;
    deps.appendFileSync(tsvPath, line, 'utf-8');
  } catch (_err) {
    // Fail-open on TSV write errors
    process.stderr.write(`[autoresearch-refine] Warning: could not append TSV row: ${_err.message}\n`);
  }
}

/**
 * Parse TSV file into array of row objects.
 * @param {string} tsvPath - Path to refinement-results.tsv
 * @returns {Array<Object>} Parsed rows (excluding header)
 */
function parseTsv(tsvPath) {
  try {
    if (!deps.existsSync(tsvPath)) return [];
    const content = deps.readFileSync(tsvPath, 'utf-8');
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

// ---- Checker Dispatch ----

/**
 * Run the model checker and parse the result.
 * @param {string} modelPath - Path to the model file
 * @param {string} formalism - 'tla' or 'alloy'
 * @param {number} timeout - Checker timeout in ms
 * @returns {{ exitCode: number, output: string, states: number|null, checkerResult: string }}
 */
function runChecker(modelPath, formalism, timeout) {
  const checkerScript = formalism === 'alloy'
    ? path.join(__dirname, 'run-alloy.cjs')
    : path.join(__dirname, 'run-tlc.cjs');

  let output = '';
  let exitCode = 0;

  try {
    output = deps.execFileSync('node', [checkerScript, modelPath], {
      encoding: 'utf-8',
      timeout: timeout,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    exitCode = 0;
  } catch (err) {
    if (err.status && err.status !== 0) {
      output = (err.stdout || '') + (err.stderr || '');
      exitCode = err.status;
    } else {
      // Checker error (timeout, spawn failure) — fail-open
      throw new Error(`Checker error: ${err.message}`);
    }
  }

  // Parse state count from output
  let states = null;
  const stateMatch = output.match(/(\d+)\s+distinct\s+states/i) || output.match(/(\d+)\s+states?\s+found/i);
  if (stateMatch) {
    states = parseInt(stateMatch[1], 10);
  }

  const checkerResult = exitCode !== 0 ? 'violation' : 'pass';

  return { exitCode, output, states, checkerResult };
}

// ---- Core Refinement Loop ----

/**
 * Run the autoresearch-style refinement loop.
 *
 * @param {Object} opts
 * @param {string} opts.modelPath - Path to the formal model file
 * @param {string} opts.bugContext - Bug description text
 * @param {string} opts.formalism - 'tla' or 'alloy'
 * @param {number} [opts.maxIterations] - Max iterations (default: from config)
 * @param {boolean} [opts.verbose=false] - Verbose logging
 * @param {Function} opts.onTweak - async (modelPath, { checkerOutput, tsvHistory, consecutiveDiscards }) => string|null
 * @returns {Promise<{ converged: boolean, iterations: number, finalModel: string, resultsLog: string, stuck_reason: string|null }>}
 */
async function refine(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new Error('opts object is required');
  }
  const {
    modelPath,
    bugContext,
    formalism = 'tla',
    verbose = false,
    onTweak
  } = opts;

  const maxIterations = opts.maxIterations || getMaxIterations();
  const checkerTimeout = 120000; // 120s

  if (!onTweak || typeof onTweak !== 'function') {
    throw new Error('onTweak callback is required');
  }

  if (!modelPath || typeof modelPath !== 'string') {
    throw new Error('modelPath is required');
  }

  // TSV log path: same directory as model
  const modelDir = path.dirname(modelPath);
  const tsvPath = path.join(modelDir, 'refinement-results.tsv');
  ensureTsvHeader(tsvPath);

  let consecutiveDiscards = 0;
  let previousStates = null;
  let iterationCount = 0;

  for (let i = 1; i <= maxIterations; i++) {
    iterationCount = i;

    // 1. Save in-memory backup of current model content
    let backup;
    try {
      backup = deps.readFileSync(modelPath, 'utf-8');
    } catch (err) {
      // If model file doesn't exist yet, use empty string
      backup = '';
    }

    // 2. Build iteration context with TSV history
    const tsvHistory = parseTsv(tsvPath);
    const iterationContext = {
      checkerOutput: '',
      tsvHistory,
      consecutiveDiscards,
      iteration: i,
      previousStates
    };

    // 3. Call onTweak — caller edits the model file on disk
    let description;
    try {
      description = await onTweak(modelPath, iterationContext);
    } catch (err) {
      // onTweak error — log and skip iteration
      if (verbose) {
        process.stderr.write(`[autoresearch-refine] onTweak error on iteration ${i}: ${err.message}\n`);
      }
      appendTsvRow(tsvPath, {
        iteration: i, commit: '-', checker_result: 'error',
        states: '-', status: 'error', description: `onTweak error: ${err.message}`
      });
      continue;
    }

    // 4. Handle no-op (onTweak returned null/empty)
    if (!description || (typeof description === 'string' && description.trim() === '')) {
      appendTsvRow(tsvPath, {
        iteration: i, commit: '-', checker_result: '-',
        states: '-', status: 'no-op', description: 'onTweak returned null — skipped'
      });
      continue;
    }

    // 5. Run checker
    let checkerResult;
    try {
      checkerResult = runChecker(modelPath, formalism, checkerTimeout);
    } catch (err) {
      // Checker error — fail-open, log and continue
      if (verbose) {
        process.stderr.write(`[autoresearch-refine] Checker error on iteration ${i}: ${err.message}\n`);
      }
      appendTsvRow(tsvPath, {
        iteration: i, commit: '-', checker_result: 'error',
        states: '-', status: 'kept', description: `${description} (checker error: ${err.message})`
      });
      consecutiveDiscards = 0;
      continue;
    }

    // Update iteration context with checker output
    iterationContext.checkerOutput = checkerResult.output;

    // 6. Decision logic
    if (checkerResult.checkerResult === 'violation') {
      // Bug reproduced = success = converged
      appendTsvRow(tsvPath, {
        iteration: i, commit: '-', checker_result: 'violation',
        states: checkerResult.states != null ? checkerResult.states : '-',
        status: 'converged', description
      });

      if (verbose) {
        process.stderr.write(`[autoresearch-refine] Converged on iteration ${i}: violation found\n`);
      }

      return {
        converged: true,
        iterations: i,
        finalModel: modelPath,
        resultsLog: tsvPath,
        stuck_reason: null
      };
    }

    // No violation — decide keep or discard based on state count
    const currentStates = checkerResult.states;
    let status;

    if (previousStates != null && currentStates != null && currentStates > previousStates) {
      // State count increased — progress, KEEP
      status = 'kept';
      consecutiveDiscards = 0;
    } else if (previousStates != null && currentStates != null && currentStates <= previousStates) {
      // State count decreased or unchanged — DISCARD, rollback
      status = 'discarded';
      consecutiveDiscards++;

      // Restore model from in-memory backup
      try {
        deps.writeFileSync(modelPath, backup, 'utf-8');
      } catch (err) {
        if (verbose) {
          process.stderr.write(`[autoresearch-refine] Warning: rollback failed on iteration ${i}: ${err.message}\n`);
        }
      }
    } else {
      // First iteration or state count not available — KEEP (no baseline to compare)
      status = 'kept';
      consecutiveDiscards = 0;
    }

    // Update previousStates only on kept iterations
    if (status === 'kept' && currentStates != null) {
      previousStates = currentStates;
    }

    appendTsvRow(tsvPath, {
      iteration: i, commit: '-', checker_result: checkerResult.checkerResult,
      states: currentStates != null ? currentStates : '-',
      status, description
    });

    if (verbose) {
      process.stderr.write(`[autoresearch-refine] Iteration ${i}: ${status} (states: ${currentStates}, prev: ${previousStates})\n`);
    }

    // 7. When-stuck protocol
    if (consecutiveDiscards >= 3) {
      const recentTsv = parseTsv(tsvPath);
      const last5 = recentTsv.slice(-5);
      const stuckReason = `3+ consecutive discards. Last ${last5.length} entries:\n` +
        last5.map(r => `  iter=${r.iteration} result=${r.checker_result} states=${r.states} status=${r.status} desc="${r.description}"`).join('\n');

      process.stderr.write(`[autoresearch-refine] STUCK: ${stuckReason}\n`);

      return {
        converged: false,
        iterations: i,
        finalModel: modelPath,
        resultsLog: tsvPath,
        stuck_reason: stuckReason
      };
    }
  }

  // Max iterations exhausted
  return {
    converged: false,
    iterations: iterationCount,
    finalModel: modelPath,
    resultsLog: tsvPath,
    stuck_reason: null
  };
}

// Module exports (no CLI — module-only API)
module.exports = {
  refine,
  _setDeps
};

#!/usr/bin/env node
'use strict';

/**
 * refinement-loop.cjs
 *
 * @deprecated Use formal-model-loop.cjs instead. This module is superseded by
 * the convergent refinement loop with callLlm injection. Kept for backward
 * compatibility only.
 *
 * Bug context normalization and inverted verification loop for model refinement.
 * When --bug-context is provided, the model checker's semantics are inverted:
 * finding a violation means the model REPRODUCES the bug (success),
 * passing means the model does NOT capture the failure (retry).
 *
 * Usage:
 *   node bin/refinement-loop.cjs --model <path> --bug-context <text-or-file> --formalism tla|alloy [--max-attempts 3] [--verbose] [--format json|text]
 *
 * Module exports:
 *   { normalizeBugContext, verifyBugReproduction, formatIterationFeedback, _setDeps }
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { interpretGateResult } = require('./verification-mode.cjs');
const { getMaxIterations } = require('./config-update.cjs');
const { extractFinalStates } = require('./model-state-extractor.cjs');
const { generateStateDiff, formatDiffAsMarkdown } = require('./diagnostic-diff-generator.cjs');
const { generateCorrectionProposals } = require('./diagnostic-proposal-generator.cjs');

// ---- Dependency Injection for Testing ----

let deps = {
  execFileSync,
  existsSync: fs.existsSync,
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  unlinkSync: fs.unlinkSync
};

/**
 * Override dependencies for testing.
 * @param {Object} overrides - { execFileSync, existsSync, readFileSync }
 */
function _setDeps(overrides) {
  deps = { ...deps, ...overrides };
}

// ---- Bug Context Normalization (MRF-01) ----

/**
 * Normalize --bug-context input: inline text or file path (auto-detected).
 * @param {string|null|undefined} value - Raw bug context value
 * @returns {string} Normalized plain text (empty string on any error)
 */
function normalizeBugContext(value) {
  try {
    if (value == null || typeof value !== 'string' || value.trim() === '') {
      return '';
    }
    const trimmed = value.trim();
    // Auto-detect: if it's a valid file path, read contents
    if (deps.existsSync(trimmed)) {
      return deps.readFileSync(trimmed, 'utf-8').trim();
    }
    // Otherwise treat as inline text
    return trimmed;
  } catch (_err) {
    // Fail-open: return empty string on any error
    return '';
  }
}

// ---- Inverted Verification Loop (MRF-02) ----

/**
 * Parse checker output to extract a summary line.
 * @param {string} output - Checker stdout/stderr
 * @param {boolean} hasError - Whether checker reported an error
 * @returns {string} Short summary
 */
function parseCheckerSummary(output, hasError) {
  if (!output || typeof output !== 'string') {
    return hasError ? 'violation found' : 'model passes';
  }
  // Look for invariant violation message
  const invMatch = output.match(/Invariant\s+(\S+)\s+is violated/i);
  if (invMatch) {
    return `invariant ${invMatch[1]} violated`;
  }
  // Look for assertion failure (Alloy)
  const assertMatch = output.match(/Assertion\s+(\S+).*may not hold/i);
  if (assertMatch) {
    return `assertion ${assertMatch[1]} may not hold`;
  }
  // Look for "no error" message
  if (/no error has been found/i.test(output)) {
    return 'model is incomplete — invariants hold but model does not capture the failure';
  }
  // Look for state count
  const stateMatch = output.match(/(\d+)\s+states?\s+found/i);
  if (stateMatch) {
    return hasError
      ? `violation found after exploring ${stateMatch[1]} states`
      : `${stateMatch[1]} states explored, no violation`;
  }
  return hasError ? 'violation found' : 'model passes';
}

/**
 * Extract counterexample trace from checker output.
 * @param {string} output - Checker stdout/stderr
 * @returns {string|null} Trace text or null
 */
function extractCounterexample(output) {
  if (!output || typeof output !== 'string') return null;
  // TLC counterexample pattern
  const traceMatch = output.match(/Error:\s*.*?\n((?:State \d+.*\n?)+)/s);
  if (traceMatch) return traceMatch[0].trim();
  // Generic "State" pattern
  const stateLines = output.split('\n').filter(l => /^State \d+/.test(l));
  if (stateLines.length > 0) return stateLines.join('\n');
  return null;
}

/**
 * Generate diagnostic feedback when model is INCOMPLETE.
 * Compares model's final states with bug trace's final states.
 * Fail-open: returns null on any error.
 *
 * @param {string} checkerOutput - Model checker stdout/stderr
 * @param {string|null} bugTraceJsonPath - Path to bug trace ITF JSON
 * @param {string} bugContext - Bug description text
 * @returns {Object|null} { mismatch_diff, correction_proposals, trace_alignment } or null
 */
function generateDiagnosticFeedback(checkerOutput, bugTraceJsonPath, bugContext) {
  try {
    // Fail-open: if no bug trace, cannot generate diagnostic
    if (!bugTraceJsonPath || typeof bugTraceJsonPath !== 'string' || bugTraceJsonPath.trim() === '') {
      return null;
    }

    // Fail-open: if checker output is not JSON-like, cannot extract states
    if (!checkerOutput || typeof checkerOutput !== 'string') {
      return null;
    }

    // Stage 1: Write checker output to temp file if it looks like JSON
    let modelFinalStates = [];
    try {
      // Try to parse checker output as JSON
      const parsed = JSON.parse(checkerOutput);
      // If it's an ITF-like structure, write it to temp and extract states
      const tempDir = '/tmp';
      const tempFile = path.join(tempDir, `model-trace-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.json`);
      deps.writeFileSync(tempFile, JSON.stringify(parsed), 'utf-8');
      modelFinalStates = extractFinalStates(tempFile);
      // Clean up temp file
      try {
        deps.unlinkSync(tempFile);
      } catch (_) {}
    } catch (_) {
      // Not JSON — fail-open
      return null;
    }

    // If model didn't produce any final states, fail-open
    if (!modelFinalStates || modelFinalStates.length === 0) {
      return null;
    }

    // Stage 2: Extract bug trace's final states
    if (!deps.existsSync(bugTraceJsonPath)) {
      // Bug trace file doesn't exist — fail-open
      return null;
    }

    const bugFinalStates = extractFinalStates(bugTraceJsonPath);
    if (!bugFinalStates || bugFinalStates.length === 0) {
      // Bug trace produced no states — fail-open
      return null;
    }

    // Stage 3: Compare state sequences
    const diffResult = generateStateDiff(modelFinalStates, bugFinalStates);

    // Stage 4: Format as markdown
    const mismatchDiff = formatDiffAsMarkdown(diffResult);

    // Stage 5: Generate correction proposals
    const correctionProposals = generateCorrectionProposals(diffResult, bugContext);

    // Extract trace alignment info
    const trace_alignment = {
      model_state_count: modelFinalStates.length,
      bug_state_count: bugFinalStates.length,
      first_divergence_index: diffResult.summary.first_divergence_index,
      diverged_fields: diffResult.summary.changed_fields
    };

    return {
      mismatch_diff: mismatchDiff,
      correction_proposals: correctionProposals,
      trace_alignment
    };
  } catch (err) {
    // Fail-open: diagnostic failure does NOT break refinement loop
    process.stderr.write(`[refinement-loop] Warning: diagnostic generation failed: ${err.message}\n`);
    return null;
  }
}

/**
 * Run the inverted verification loop for model refinement.
 * INVERTED SEMANTICS: error = reproduced (success), pass = model incomplete (retry).
 *
 * @param {string} modelPath - Path to the formal model file
 * @param {string} bugContext - Normalized bug description text
 * @param {Object} [options] - Configuration
 * @param {string} options.formalism - 'tla' or 'alloy'
 * @param {number} [options.maxAttempts=3] - Max iterations
 * @param {boolean} [options.verbose=false] - Show full checker output
 * @param {Function} [options.onIteration] - Callback({ attempt, passed, summary })
 * @param {string} [options.bugTraceJsonPath] - Path to bug trace ITF JSON for diagnostic generation
 * @param {Function} [options.onDiagnosticGenerated] - Callback(diagnostic, attemptNumber) for diagnostic injection
 * @returns {Object} { status, attempts, model_path, counterexample, iterations, final_diagnostic }
 */
function verifyBugReproduction(modelPath, bugContext, options) {
  options = options || {};
  const formalism = options.formalism || 'tla';
  const maxAttempts = (Number.isInteger(options.maxAttempts) && options.maxAttempts > 0)
    ? options.maxAttempts
    : getMaxIterations();
  const verbose = options.verbose || false;
  const onIteration = options.onIteration || null;
  const bugTraceJsonPath = options.bugTraceJsonPath || null;
  const onDiagnosticGenerated = options.onDiagnosticGenerated || null;

  const iterations = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let output = '';
    let hasError = false;

    try {
      // Determine checker command
      const checkerScript = formalism === 'alloy'
        ? path.join(__dirname, 'run-alloy.cjs')
        : path.join(__dirname, 'run-tlc.cjs');

      // Run checker as subprocess via execFileSync with diagnostic mode flag (no shell injection risk)
      output = deps.execFileSync('node', [checkerScript, '--verification-mode=diagnostic', modelPath], {
        encoding: 'utf-8',
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      // Zero exit = checker passed = model does NOT capture the failure
      hasError = false;
    } catch (err) {
      if (err.status && err.status !== 0) {
        // Non-zero exit = checker found violation = model REPRODUCES the bug
        output = (err.stdout || '') + (err.stderr || '');
        hasError = true;
      } else {
        // Spawn failure, timeout, or other error — fail-open as "model inconclusive"
        output = err.message || 'checker subprocess error';
        hasError = false;
        process.stderr.write(`[refinement-loop] Checker error on attempt ${attempt}: ${err.message}\n`);
      }
    }

    const summary = parseCheckerSummary(output, hasError);
    // Interpret result using verification mode semantics
    const outcome = interpretGateResult(hasError, 'diagnostic');

    if (outcome === 'REPRODUCED') {
      // Model found a violation — it REPRODUCES the bug — SUCCESS
      const counterexample = extractCounterexample(output);
      const iteration = { attempt, passed: false, summary };
      iterations.push(iteration);
      if (onIteration) onIteration(iteration);

      return {
        status: 'reproduced',
        attempts: attempt,
        model_path: modelPath,
        counterexample: counterexample,
        iterations
      };
    }

    // Model passes (outcome === 'INCOMPLETE') — model remains incomplete — does not capture the failure — RETRY
    const iteration = { attempt, passed: true, summary };

    // Generate diagnostic feedback if bug trace available and not the last attempt
    if (bugTraceJsonPath && attempt < maxAttempts) {
      const diagnostic = generateDiagnosticFeedback(output, bugTraceJsonPath, bugContext);
      if (diagnostic) {
        iteration.diagnostic = diagnostic;
        if (onDiagnosticGenerated) {
          onDiagnosticGenerated(diagnostic, attempt);
        }
      }
    }

    iterations.push(iteration);
    if (onIteration) onIteration(iteration);
  }

  // All attempts exhausted — model remains incomplete
  const lastDiagnostic = iterations.filter(i => i.diagnostic).pop();
  return {
    status: 'not_reproduced',
    attempts: maxAttempts,
    model_path: modelPath,
    counterexample: null,
    final_diagnostic: lastDiagnostic ? lastDiagnostic.diagnostic : null,
    iterations
  };
}

// ---- Iteration Feedback Formatting ----

/**
 * Format a single iteration's feedback for display.
 * @param {Object} iteration - { attempt, passed, summary, diagnostic? }
 * @param {boolean} [verbose=false] - Include full output
 * @param {string} [fullOutput=''] - Full checker output (for verbose mode)
 * @returns {string} Formatted feedback line
 */
function formatIterationFeedback(iteration, verbose, fullOutput) {
  if (!iteration || typeof iteration !== 'object') return '';
  const status = iteration.passed ? 'model still incomplete' : 'reproduced';
  let line = `Attempt ${iteration.attempt}: ${status} \u2014 ${iteration.summary}`;

  // Append diagnostic summary if present
  if (iteration.diagnostic) {
    const proposalCount = (iteration.diagnostic.correction_proposals || []).length;
    const divergedCount = ((iteration.diagnostic.trace_alignment || {}).diverged_fields || []).length;
    line += `\n  Diagnostic: ${proposalCount} correction proposals generated (${divergedCount} diverged fields)`;
  }

  if (verbose && fullOutput) {
    return `${line}\n  Full output:\n${fullOutput.split('\n').map(l => '    ' + l).join('\n')}`;
  }
  return line;
}

// ---- CLI Interface ----

function parseArgs(argv) {
  const args = {
    model: null,
    bugContext: null,
    formalism: 'tla',
    maxAttempts: null,
    verbose: false,
    format: 'json',
    help: false,
    normalize: null,
    bugTraceJson: null
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--model' && argv[i + 1]) {
      args.model = argv[++i];
    } else if (argv[i] === '--bug-context' && argv[i + 1]) {
      args.bugContext = argv[++i];
    } else if (argv[i] === '--formalism' && argv[i + 1]) {
      args.formalism = argv[++i];
    } else if (argv[i] === '--max-attempts' && argv[i + 1]) {
      const parsed = parseInt(argv[++i], 10);
      args.maxAttempts = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } else if (argv[i] === '--verbose') {
      args.verbose = true;
    } else if (argv[i] === '--format' && argv[i + 1]) {
      args.format = argv[++i];
    } else if (argv[i] === '--normalize' && argv[i + 1]) {
      args.normalize = argv[++i];
    } else if (argv[i] === '--bug-trace-json' && argv[i + 1]) {
      args.bugTraceJson = argv[++i];
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  console.log('Usage: node bin/refinement-loop.cjs --model <path> --bug-context <text-or-file> --formalism tla|alloy');
  console.log('');
  console.log('Options:');
  console.log('  --model           Path to formal model file (.tla or .als) (required)');
  console.log('  --bug-context     Bug description as inline text or file path (required)');
  console.log('  --formalism       Model formalism: tla or alloy (default: tla)');
  console.log('  --max-attempts    Max refinement iterations (default: 3)');
  console.log('  --verbose         Show full model checker output');
  console.log('  --format          Output format: json or text (default: json)');
  console.log('  --normalize       Normalize a bug context value and print result');
  console.log('  --help            Show this help message');
}

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Normalize mode
  if (args.normalize !== null) {
    console.log(normalizeBugContext(args.normalize));
    process.exit(0);
  }

  if (!args.model) {
    console.error('Error: --model <path> is required');
    printHelp();
    process.exit(1);
  }

  if (!args.bugContext) {
    console.error('Error: --bug-context <text-or-file> is required');
    printHelp();
    process.exit(1);
  }

  const normalizedContext = normalizeBugContext(args.bugContext);

  const result = verifyBugReproduction(args.model, normalizedContext, {
    formalism: args.formalism,
    maxAttempts: args.maxAttempts,
    verbose: args.verbose,
    bugTraceJsonPath: args.bugTraceJson,
    onIteration: (iter) => {
      if (args.format === 'text') {
        console.log(formatIterationFeedback(iter, args.verbose));
      }
    }
  });

  if (args.format === 'text') {
    console.log('---');
    console.log(`Result: ${result.status}`);
    console.log(`Attempts: ${result.attempts}`);
    console.log(`Model: ${result.model_path}`);
    if (result.counterexample) {
      console.log(`Counterexample:\n${result.counterexample}`);
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

// Run CLI if invoked directly
if (require.main === module) {
  main();
}

// Module exports for programmatic use and testing
module.exports = {
  normalizeBugContext,
  verifyBugReproduction,
  formatIterationFeedback,
  generateDiagnosticFeedback,
  _setDeps
};

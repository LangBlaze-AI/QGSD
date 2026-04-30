#!/usr/bin/env node
'use strict';
// bin/nf-debug-runner.cjs
// Fix-cycle runner for a single debug benchmark stub.
// Uses shared formal-model-loop (Loop 1) and formal-fix-loop (Loop 2).
//
// Usage:
//   node bin/nf-debug-runner.cjs --stub <path> --test <path> [--tier easy] [--verbose] [--no-formal]

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { refineModel, formalismForTier } = require('./formal-model-loop.cjs');
const { refineFix } = require('./formal-fix-loop.cjs');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const stubIdx = args.indexOf('--stub');
const testIdx = args.indexOf('--test');
const tierIdx = args.indexOf('--tier');
const noFormalIdx = args.indexOf('--no-formal');
const timeoutIdx = args.indexOf('--timeout');

if (stubIdx === -1 || testIdx === -1) {
  process.stderr.write('ERROR: --stub <path> and --test <path> are required\n');
  process.exit(1);
}

const stubPath = path.resolve(args[stubIdx + 1]);
const testPath = path.resolve(args[testIdx + 1]);
const tier = tierIdx !== -1 ? args[tierIdx + 1] : 'easy';
const useFormal = noFormalIdx === -1;
const quorumTimeout = timeoutIdx !== -1 ? parseInt(args[timeoutIdx + 1], 10) : 300000;
const formalism = formalismForTier(tier);

if (dryRun) {
  process.stdout.write(JSON.stringify({ dry_run: true, stub: stubPath, test: testPath, formal: useFormal, tier, formalism }) + '\n');
  process.exit(0);
}

let originalStubSource = null;
const startTime = Date.now();

function log(msg) {
  if (verbose) process.stderr.write('[nf-debug-runner] ' + msg + '\n');
}

function callLlm(prompt) {
  const claudeCli = require('./resolve-cli.cjs').resolveCli('claude') || 'claude';
  return Promise.resolve(spawnSync(claudeCli, [
    '-p', prompt,
    '--dangerously-skip-permissions',
    '--model', 'claude-haiku-4-5-20251001'
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: quorumTimeout
  }));
}

async function main() {
  // ── Step 1: Run test ────────────────────────────────────────────────────────
  let testResult = spawnSync('node', [testPath], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, cwd: process.cwd() });
  if (verbose && testResult.stderr) process.stderr.write(testResult.stderr);
  if (verbose && testResult.stdout) process.stderr.write(testResult.stdout);

  if (testResult.status === 0) {
    log('test already passes');
    process.stdout.write(JSON.stringify({ fixed: false, already_passing: true, elapsed_ms: Date.now() - startTime }) + '\n');
    return;
  }

  const testFailureOutput = (testResult.stderr || '') + (testResult.stdout || '');

  // ── Step 2: Read sources ────────────────────────────────────────────────────
  const stubSource = fs.readFileSync(stubPath, 'utf8');
  originalStubSource = stubSource;
  const testSource = fs.readFileSync(testPath, 'utf8');

  // ── Step 3: Loop 1 — Model refinement ──────────────────────────────────────
  let modelResult = { converged: false, iterations: 0, spec: null, invariant: null, english: null, bugExplanation: null };

  if (useFormal) {
    log('Loop 1: refining formal model...');
    modelResult = await refineModel({
      codeSource: stubSource,
      testSource: testSource,
      testFailureOutput: testFailureOutput,
      formalism,
      maxIterations: 3,
      callLlm,
      onLog: log
    });
  }

  const constraint = modelResult.invariant && modelResult.english
    ? { invariant: modelResult.invariant, english: modelResult.english }
    : null;

  // ── Step 4: Loop 2 — Fix refinement ────────────────────────────────────────
  // Grant extra iterations when L1 converged with high confidence (1 iteration)
  const l2MaxIterations = (modelResult.converged && modelResult.iterations === 1) ? 5 : 3;
  log('Loop 2: refining fix (maxIterations=' + l2MaxIterations + ')...');
  const fixResult = await refineFix({
    buggySource: stubSource,
    testSource: testSource,
    testPath: testPath,
    stubPath: stubPath,
    testFailureOutput: testFailureOutput,
    constraint,
    spec: modelResult.spec,
    bugExplanation: modelResult.bugExplanation,
    maxIterations: l2MaxIterations,
    callLlm,
    onLog: log
  });

  // ── Step 5: Report ──────────────────────────────────────────────────────────
  const output = {
    fixed: fixResult.converged,
    exit_code: fixResult.converged ? 0 : 1,
    elapsed_ms: Date.now() - startTime,
    loop1: { converged: modelResult.converged, iterations: modelResult.iterations },
    loop2: { converged: fixResult.converged, iterations: fixResult.iterations, gates: fixResult.gates },
    formal: useFormal ? {
      formalism,
      constraint: constraint ? constraint.english : null,
      invariant: constraint ? constraint.invariant : null,
      bug_explanation: modelResult.bugExplanation
    } : null
  };

  process.stdout.write(JSON.stringify(output) + '\n');
  process.exit(output.fixed ? 0 : 1);
}

main().catch(function(err) {
  process.stderr.write('[nf-debug-runner] fatal: ' + err.message + '\n');
  process.stdout.write(JSON.stringify({ fixed: false, error: 'fatal', message: err.message, elapsed_ms: Date.now() - startTime }) + '\n');
  process.exit(1);
}).finally(function() {
  if (originalStubSource !== null && fs.existsSync(stubPath)) {
    try {
      const currentSource = fs.readFileSync(stubPath, 'utf8');
      if (currentSource !== originalStubSource) {
        fs.writeFileSync(stubPath, originalStubSource, 'utf8');
        if (verbose) process.stderr.write('[nf-debug-runner] stub restored\n');
      }
    } catch (_) {}
  }
});

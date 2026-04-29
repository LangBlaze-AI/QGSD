#!/usr/bin/env node
'use strict';

/**
 * formal-fix-loop.cjs
 *
 * Loop 2: Iterate fix until all 3 gates pass.
 *   Gate 1: Fix satisfies the formal invariant (LLM validation)
 *   Gate 2: Fix passes the test (test runner)
 *   Gate 3: No regressions (LLM validation)
 *
 * Shared by: nf-debug-runner, nf:quick --full executor, nf:debug
 *
 * Module exports: { refineFix }
 *
 * Usage:
 *   const { refineFix } = require('./formal-fix-loop.cjs');
 *   const result = await refineFix({
 *     buggySource: '...',
 *     testSource: '...',
 *     testPath: '/abs/path/test.cjs',
 *     stubPath: '/abs/path/stub.cjs',
 *     constraint: { invariant: '...', english: '...' },
 *     spec: '...',
 *     bugExplanation: '...',
 *     maxIterations: 3,
 *     callLlm: async (prompt) => spawnSync('claude', ['-p', prompt, ...]),
 *     onLog: (msg) => console.error(msg)
 *   });
 */

const { spawnSync } = require('child_process');
const fs = require('fs');

function buildFixPrompt(buggySource, testFailureOutput, constraint, spec, bugExplanation, rejectionReason) {
  const parts = ['Fix the following buggy JavaScript function.'];

  // Bug explanation front-and-center so the LLM understands the root cause first
  if (bugExplanation) {
    parts.push(
      '',
      '## ROOT CAUSE',
      bugExplanation
    );
  }

  // Formal constraint immediately after root cause — hard requirement
  if (constraint && constraint.english) {
    parts.push(
      '',
      '## FORMAL CONSTRAINT (HARD REQUIREMENT)',
      'Your code MUST satisfy: ' + constraint.english,
      constraint.invariant ? ('Formal expression: ' + constraint.invariant) : '',
      'The buggy code violates this constraint. Any fix that violates it will be REJECTED.'
    );
  }

  // Rejection feedback from previous iteration
  if (rejectionReason) {
    parts.push(
      '',
      '## PREVIOUS FIX REJECTED',
      rejectionReason,
      'Address this rejection in your new fix. Do NOT repeat the same mistake.'
    );
  }

  // Buggy source and test failure
  parts.push(
    '',
    '## BUGGY SOURCE (file: fn.cjs)',
    '```js',
    buggySource,
    '```',
    '',
    '## TEST FAILURE OUTPUT',
    testFailureOutput.slice(0, 500)
  );

  // Spec last — reference material, not the primary signal
  if (spec) {
    parts.push(
      '',
      '## FORMAL SPECIFICATION',
      spec
    );
  }

  parts.push(
    '',
    'Return ONLY the fixed source code in a ```js ... ``` code block. Do not explain.'
  );

  return parts.join('\n');
}

function buildInvariantValidationPrompt(fixedSource, constraint) {
  return [
    'You are verifying a bug fix against a formal specification.',
    '',
    'Proposed fix:',
    '```js',
    fixedSource,
    '```',
    '',
    'Formal invariant that the fix MUST satisfy:',
    constraint.english,
    constraint.invariant ? ('Formal expression: ' + constraint.invariant) : '',
    '',
    'Does the proposed fix satisfy the invariant?',
    'Answer ONLY: VALID or INVALID followed by a one-line reason.',
  ].join('\n');
}

function buildRegressionPrompt(buggySource, fixedSource, testSource) {
  return [
    'You are checking a bug fix for regressions.',
    '',
    'Original buggy code:',
    '```js',
    buggySource,
    '```',
    '',
    'Proposed fix:',
    '```js',
    fixedSource,
    '```',
    '',
    'Full test file:',
    '```js',
    testSource,
    '```',
    '',
    'Does the fix maintain correct behavior for ALL test cases, including edge cases?',
    'Could the fix break any case that the original code handled correctly?',
    '',
    'Answer ONLY: SAFE or REGRESSION followed by a one-line reason.',
  ].join('\n');
}

function extractCodeBlock(response) {
  if (!response) return null;
  const codeMatch = response.match(/```(?:js|javascript)?\n?([\s\S]*?)\n?```/);
  if (codeMatch) return codeMatch[1].trim();
  const stripped = response.replace(/^[^\n]*\n+/, '').trim();
  if (stripped.length > 0 && stripped.includes('function')) return stripped;
  return null;
}

function validateSyntax(source) {
  try { new Function(source); return true; } catch (_) { return false; }
}

async function refineFix(input) {
  const {
    buggySource,
    testSource,
    testPath,
    stubPath,
    testFailureOutput,
    constraint = null,
    spec = null,
    bugExplanation = null,
    maxIterations = 3,
    callLlm,
    onLog = function() {}
  } = input;

  if (!callLlm) throw new Error('callLlm is required');
  if (!buggySource || !testPath || !stubPath) {
    throw new Error('buggySource, testPath, and stubPath are required');
  }

  const originalSource = fs.readFileSync(stubPath, 'utf8');
  let converged = false;
  let iterations = 0;
  let fixedSource = null;
  let rejectionReason = null;
  const rejectionReasons = [];
  const gates = { gate1_invariant: false, gate2_test: false, gate3_regression: false };

  for (let i = 1; i <= maxIterations; i++) {
    iterations = i;
    onLog('[formal-fix-loop] iteration ' + i + '/' + maxIterations);

    const prompt = buildFixPrompt(
      buggySource, testFailureOutput,
      constraint, spec, bugExplanation,
      rejectionReason
    );
    const fixResult = await callLlm(prompt);

    if (!fixResult || fixResult.status !== 0 || !fixResult.stdout) {
      rejectionReason = 'LLM call failed';
      rejectionReasons.push(rejectionReason);
      onLog('[formal-fix-loop] LLM call failed (iteration ' + i + ')');
      continue;
    }

    const proposed = extractCodeBlock(fixResult.stdout);
    if (!proposed) {
      rejectionReason = 'Previous attempt returned no code block. Output exactly the fixed source code in a ```js code block.';
      rejectionReasons.push(rejectionReason);
      onLog('[formal-fix-loop] no code block found');
      continue;
    }

    if (!validateSyntax(proposed)) {
      rejectionReason = 'Previous fix had invalid JavaScript syntax.';
      rejectionReasons.push(rejectionReason);
      onLog('[formal-fix-loop] invalid syntax');
      continue;
    }

    // ── Gate 1: Invariant check ────────────────────────────────────────────
    gates.gate1_invariant = true;
    if (constraint && constraint.english) {
      onLog('[formal-fix-loop] Gate 1: invariant check...');
      const validResult = await callLlm(
        buildInvariantValidationPrompt(proposed, constraint)
      );
      if (validResult && validResult.status === 0 && validResult.stdout) {
        const validText = validResult.stdout.trim().toUpperCase();
        if (validText.includes('INVALID')) {
          gates.gate1_invariant = false;
          rejectionReason = 'Gate 1 FAILED (invariant): ' + validResult.stdout.trim();
          rejectionReasons.push(rejectionReason);
          onLog('[formal-fix-loop] ' + rejectionReason);
          continue;
        }
      }
      onLog('[formal-fix-loop] Gate 1 PASSED');
    }

    // ── Gate 2: Test check ─────────────────────────────────────────────────
    onLog('[formal-fix-loop] Gate 2: running test...');
    fs.writeFileSync(stubPath, proposed, 'utf8');
    const testResult = spawnSync('node', [testPath], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      cwd: process.cwd()
    });
    gates.gate2_test = testResult.status === 0;

    if (!gates.gate2_test) {
      const failOutput = (testResult.stderr || '') + (testResult.stdout || '');
      rejectionReason = 'Gate 2 FAILED (test): ' + failOutput.slice(0, 200);
      rejectionReasons.push(rejectionReason);
      onLog('[formal-fix-loop] ' + rejectionReason);
      fs.writeFileSync(stubPath, originalSource, 'utf8');
      continue;
    }
    onLog('[formal-fix-loop] Gate 2 PASSED');

    // ── Gate 3: Regression check ───────────────────────────────────────────
    gates.gate3_regression = true;
    if (constraint && constraint.english) {
      onLog('[formal-fix-loop] Gate 3: regression check...');
      const regResult = await callLlm(
        buildRegressionPrompt(buggySource, proposed, testSource)
      );
      if (regResult && regResult.status === 0 && regResult.stdout) {
        const regText = regResult.stdout.trim().toUpperCase();
        if (regText.includes('REGRESSION')) {
          gates.gate3_regression = false;
          rejectionReason = 'Gate 3 FAILED (regression): ' + regResult.stdout.trim();
          rejectionReasons.push(rejectionReason);
          onLog('[formal-fix-loop] ' + rejectionReason);
          fs.writeFileSync(stubPath, originalSource, 'utf8');
          continue;
        }
      }
      onLog('[formal-fix-loop] Gate 3 PASSED');
    }

    converged = true;
    fixedSource = proposed;
    onLog('[formal-fix-loop] CONVERGED (' + i + ' iteration(s))');
    break;
  }

  if (!converged) {
    fs.writeFileSync(stubPath, originalSource, 'utf8');
    onLog('[formal-fix-loop] max iterations reached, no fix accepted');
  }

  return {
    converged,
    iterations,
    fixedSource,
    gates,
    rejectionReasons
  };
}

module.exports = { refineFix };

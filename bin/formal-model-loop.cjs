#!/usr/bin/env node
'use strict';

/**
 * formal-model-loop.cjs
 *
 * Loop 1: Iterate formal model until it explains the bug.
 * Generates a formal spec (Alloy/TLA+), validates it against the bug,
 * and refines until the model correctly explains why the test fails.
 *
 * Shared by: nf-debug-runner, nf:debug Step A.7, nf:quick --full
 *
 * Module exports: { refineModel }
 *
 * Usage:
 *   const { refineModel } = require('./formal-model-loop.cjs');
 *   const result = await refineModel({
 *     codeSource: '...',
 *     testSource: '...',
 *     testFailureOutput: 'FAIL t1\n',
 *     formalism: 'alloy',
 *     maxIterations: 3,
 *     callLlm: async (prompt) => spawnSync('claude', ['-p', prompt, ...]),
 *     onLog: (msg) => console.error(msg)
 *   });
 */

const FORMALISM_MAP = {
  easy: 'alloy', medium: 'alloy', hard: 'tla', extreme: 'tla', legendary: 'tla'
};

function formalismForTier(tier) {
  return FORMALISM_MAP[tier] || 'alloy';
}

function buildGeneratePrompt(codeSource, testSource, formalismType) {
  const name = formalismType === 'tla' ? 'TLA+' : 'Alloy';
  const lang = formalismType === 'tla' ? 'tla' : 'alloy';
  return [
    'You are a formal methods expert. Given a JavaScript function and its test cases,',
    'generate a ' + name + ' specification that:',
    '1. Defines the CORRECT behavior as a formal invariant',
    '2. Shows why the BUGGY implementation violates that invariant',
    '',
    'Rules:',
    '- The spec must encode the correct function behavior as a universally quantified assertion',
    '- Derive the correct behavior from the test expectations, NOT from the buggy implementation',
    '- The spec should make it clear WHAT the bug is (which operator/logic is wrong)',
    '- Also extract a plain English constraint describing the correct behavior',
    '',
    'Output format (strict):',
    'SPEC_START',
    '```' + lang,
    '<your ' + name + ' spec here>',
    '```',
    'SPEC_END',
    'INVARIANT: <mathematical expression of the correct behavior>',
    'ENGLISH: <plain English description of what the function must do>',
    'BUG_EXPLANATION: <one sentence explaining what the bug is and why the invariant is violated>',
  ].join('\n');
}

function buildValidatePrompt(spec, invariant, english, bugExplanation, testFailureOutput) {
  return [
    'You are verifying a formal model for a bug diagnosis.',
    '',
    'Formal spec:',
    '```',
    spec,
    '```',
    '',
    'Invariant: ' + invariant,
    'English: ' + english,
    'Bug explanation: ' + bugExplanation,
    '',
    'Test failure output:',
    testFailureOutput.slice(0, 500),
    '',
    'Does this model correctly explain why the test fails?',
    'Answer ONLY: EXPLAINS or INCOMPLETE followed by a one-line reason.',
  ].join('\n');
}

function buildRefinePrompt(codeSource, testSource, prevSpec, prevInvariant, reason, formalismType) {
  const name = formalismType === 'tla' ? 'TLA+' : 'Alloy';
  const lang = formalismType === 'tla' ? 'tla' : 'alloy';
  return [
    'The previous ' + name + ' model was judged INCOMPLETE.',
    'Reason: ' + reason,
    '',
    'Previous spec:',
    '```',
    prevSpec,
    '```',
    '',
    'Previous invariant: ' + prevInvariant,
    '',
    'Improve the model. The spec must:',
    '1. Precisely capture the correct behavior (not just approximate)',
    '2. Identify the EXACT bug in the implementation',
    '',
    'Buggy implementation:',
    '```js',
    codeSource,
    '```',
    '',
    'Test cases:',
    '```js',
    testSource,
    '```',
    '',
    'Output format (same as before):',
    'SPEC_START',
    '```' + lang,
    '<improved spec>',
    '```',
    'SPEC_END',
    'INVARIANT: <refined invariant>',
    'ENGLISH: <refined English description>',
    'BUG_EXPLANATION: <refined bug explanation>',
  ].join('\n');
}

function parseModelResponse(response) {
  if (!response) return { spec: null, invariant: null, english: null, bugExplanation: null };
  const specMatch = response.match(/SPEC_START[\s\S]*?```\w*\n([\s\S]*?)\n```[\s\S]*?SPEC_END/);
  const spec = specMatch ? specMatch[1].trim() : null;
  const invMatch = response.match(/INVARIANT:\s*(.+)/);
  const engMatch = response.match(/ENGLISH:\s*(.+)/);
  const bugMatch = response.match(/BUG_EXPLANATION:\s*(.+)/);
  return {
    spec: spec || response.trim(),
    invariant: invMatch ? invMatch[1].trim() : null,
    english: engMatch ? engMatch[1].trim() : null,
    bugExplanation: bugMatch ? bugMatch[1].trim() : null
  };
}

async function refineModel(input) {
  const {
    codeSource,
    testSource,
    testFailureOutput,
    formalism = 'alloy',
    maxIterations = 3,
    callLlm,
    onLog = function() {}
  } = input;

  if (!callLlm) throw new Error('callLlm is required');
  if (!codeSource || !testSource) throw new Error('codeSource and testSource are required');

  let modelResult = null;
  let converged = false;
  let iterations = 0;

  for (let i = 1; i <= maxIterations; i++) {
    iterations = i;
    onLog('[formal-model-loop] iteration ' + i + '/' + maxIterations);

    let prompt;
    // Regenerate (not refine) when there's no prior result to refine — if iteration 1
    // failed before `modelResult` was set, the refine branch used to deref
    // `null.spec` and crash (dogfood: close-formal-gaps iter-2 after iter-1 fail).
    if (i === 1 || !modelResult) {
      prompt = buildGeneratePrompt(codeSource, testSource, formalism);
    } else {
      prompt = buildRefinePrompt(
        codeSource, testSource,
        modelResult.spec, modelResult.invariant,
        modelResult.validationReason || 'unknown',
        formalism
      );
    }

    const result = await callLlm(prompt);
    if (!result || result.status !== 0 || !result.stdout) {
      onLog('[formal-model-loop] LLM call failed (iteration ' + i + ')');
      continue;
    }

    modelResult = parseModelResponse(result.stdout);
    modelResult.validationReason = null;

    if (!modelResult.invariant || !modelResult.english) {
      onLog('[formal-model-loop] model missing invariant/english');
      modelResult.validationReason = 'Model output missing INVARIANT or ENGLISH fields';
      continue;
    }

    onLog('[formal-model-loop] invariant: ' + modelResult.invariant);

    const validPrompt = buildValidatePrompt(
      modelResult.spec, modelResult.invariant, modelResult.english,
      modelResult.bugExplanation, testFailureOutput
    );
    const validResult = await callLlm(validPrompt);

    if (validResult && validResult.status === 0 && validResult.stdout) {
      const validText = validResult.stdout.trim().toUpperCase();
      if (validText.includes('EXPLAINS')) {
        converged = true;
        onLog('[formal-model-loop] CONVERGED (' + i + ' iteration(s))');
        break;
      } else {
        modelResult.validationReason = validResult.stdout.trim();
        onLog('[formal-model-loop] incomplete: ' + validResult.stdout.trim().slice(0, 100));
      }
    } else {
      onLog('[formal-model-loop] validation call failed, accepting as-is');
      converged = true;
      break;
    }
  }

  if (!converged) {
    onLog('[formal-model-loop] max iterations reached, using best model');
  }

  return {
    converged,
    iterations,
    spec: modelResult ? modelResult.spec : null,
    invariant: modelResult ? modelResult.invariant : null,
    english: modelResult ? modelResult.english : null,
    bugExplanation: modelResult ? modelResult.bugExplanation : null
  };
}

module.exports = { refineModel, formalismForTier };

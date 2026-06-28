#!/usr/bin/env node
'use strict';
// bin/quorum-formal-context.cjs
// PLAN-03: Generates formal_spec_summary and verification_result fields for
// injection into the quorum slot-worker prompt.
//
// Translates PLAN.md truths into plain-English descriptions with INVARIANT/PROPERTY
// classifications, maps TLC results to PASS/FAIL/INCONCLUSIVE, and builds a
// formatted evidence block for prompt injection.
//
// Usage:
//   node bin/quorum-formal-context.cjs <path-to-PLAN.md> [--tlc-result=<json>]
//
// Output: Formatted evidence block to stdout

const fs   = require('fs');
const path = require('path');

const { parsePlanFrontmatter, classifyTruth } = require('./generate-phase-spec.cjs');

/**
 * Sanitize a truth string for safe embedding in quorum prompts.
 * - Replaces newlines with spaces
 * - Replaces angle brackets with square brackets (prevents XML/tag injection)
 * - Preserves backslashes (valid in TLA+ operators)
 * - Wraps in backticks instead of double quotes (avoids nested quote confusion)
 *
 * @param {string} truth
 * @returns {string}
 */
function sanitizeTruth(truth) {
  return truth
    .replace(/\n/g, ' ')
    .replace(/\r/g, '')
    .replace(/</g, '[')
    .replace(/>/g, ']');
}

/**
 * Generate a plain-English formal spec summary from a PLAN.md file.
 *
 * @param {string} planFilePath - Path to the PLAN.md file
 * @returns {{ summary: string, truthCount: number } | null}
 */
function generateFormalSpecSummary(planFilePath) {
  const content = fs.readFileSync(planFilePath, 'utf8');
  const fm = parsePlanFrontmatter(content);
  const truths = fm.truths || [];

  if (truths.length === 0) {
    return null;
  }

  let summary = "Proposed formal properties (from plan's must_haves: truths:):\n";

  truths.forEach((truth, idx) => {
    const kind = classifyTruth(truth);
    const sanitized = sanitizeTruth(truth);
    const kindLabel = kind === 'INVARIANT'
      ? 'This is a safety property (must always hold)'
      : 'This is a liveness property (must eventually hold)';
    summary += (idx + 1) + '. [' + kind + '] `' + sanitized + '` -- ' + kindLabel + '\n';
  });

  return { summary, truthCount: truths.length };
}

/**
 * Generate a verification result string from a TLC result object.
 *
 * @param {{ status?: string, truthCount?: number, runtimeMs?: number, violations?: string[], reason?: string } | null | undefined} tlcResult
 * @returns {string}
 */
function generateVerificationResult(tlcResult) {
  if (tlcResult === null || tlcResult === undefined) {
    return 'INCONCLUSIVE: No verification was run';
  }

  if (tlcResult.status === 'skipped') {
    return 'INCONCLUSIVE: No truths in plan to verify';
  }

  if (tlcResult.status === 'passed') {
    const count = tlcResult.truthCount || 0;
    const ms = tlcResult.runtimeMs || 0;
    return 'PASS: All ' + count + ' properties verified by TLC in ' + ms + 'ms';
  }

  if (tlcResult.status === 'failed') {
    const violations = Array.isArray(tlcResult.violations)
      ? tlcResult.violations.filter((v) => typeof v === 'string')
      : [];
    // Check for Java not found
    if (violations.some(v => v.includes('Java not found'))) {
      return 'INCONCLUSIVE: Java/TLC not available for verification';
    }
    return 'FAIL: ' + violations.length + ' properties violated -- ' + violations.join(', ');
  }

  return 'INCONCLUSIVE: Unknown verification state';
}

/**
 * Build a formatted formal evidence block for quorum prompt injection.
 *
 * @param {string | null} formalSpecSummary - Output of generateFormalSpecSummary().summary
 * @param {string | null} verificationResult - Output of generateVerificationResult()
 * @returns {string | null}
 */
function buildFormalEvidenceBlock(formalSpecSummary, verificationResult) {
  if (!formalSpecSummary && !verificationResult) {
    return null;
  }

  let block = '=== Formal Evidence ===\n';
  if (formalSpecSummary) {
    block += "Proposed TLA+ properties (from plan's must_haves: truths:):\n";
    block += formalSpecSummary + '\n';
  }
  if (verificationResult) {
    block += 'Verification result: ' + verificationResult + '\n';
  }
  block += '======================';

  return block;
}

/**
 * Convenience function: get full formal context for a plan file.
 *
 * @param {string} planFilePath - Path to the PLAN.md file
 * @param {{ status?: string, truthCount?: number, runtimeMs?: number, violations?: string[] } | null} tlcResult
 * @returns {{ formalSpecSummary: string | null, verificationResult: string | null, evidenceBlock: string | null }}
 */
function getFormalContext(planFilePath, tlcResult) {
  const summaryResult = generateFormalSpecSummary(planFilePath);

  if (!summaryResult) {
    return { formalSpecSummary: null, verificationResult: null, evidenceBlock: null };
  }

  const formalSpecSummary = summaryResult.summary;
  const verificationResult = generateVerificationResult(tlcResult);
  const evidenceBlock = buildFormalEvidenceBlock(formalSpecSummary, verificationResult);

  return { formalSpecSummary, verificationResult, evidenceBlock };
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const flags = process.argv.slice(2).filter(a => a.startsWith('--'));

  if (args.length === 0) {
    process.stderr.write('[quorum-formal-context] Usage: node bin/quorum-formal-context.cjs <path-to-PLAN.md> [--tlc-result=<json>]\n');
    process.exit(1);
  }

  const planFilePath = path.resolve(args[0]);
  if (!fs.existsSync(planFilePath)) {
    process.stderr.write('[quorum-formal-context] Error: file not found: ' + planFilePath + '\n');
    process.exit(1);
  }

  // Parse optional --tlc-result flag
  let tlcResult = null;
  const tlcFlag = flags.find(f => f.startsWith('--tlc-result='));
  if (tlcFlag) {
    try {
      tlcResult = JSON.parse(tlcFlag.split('=').slice(1).join('='));
    } catch (e) {
      process.stderr.write('[quorum-formal-context] Warning: could not parse --tlc-result JSON: ' + e.message + '\n');
    }
  }

  const ctx = getFormalContext(planFilePath, tlcResult);

  if (ctx.evidenceBlock) {
    process.stdout.write(ctx.evidenceBlock + '\n');
  } else {
    process.stderr.write('[quorum-formal-context] No formal evidence found in ' + planFilePath + '\n');
  }
}

module.exports = { generateFormalSpecSummary, generateVerificationResult, buildFormalEvidenceBlock, getFormalContext };

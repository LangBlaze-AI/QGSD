#!/usr/bin/env node
'use strict';

/**
 * bin/extract-fv-fails.cjs — turn formal-verification FAIL results into plan-time hypotheses.
 *
 * Part of the planning FV-gate (PLAN-01/02/03): after `run-formal-verify.cjs --only=tla`
 * writes check-results.ndjson, extract every `result: "fail"` entry so the plan-checker
 * and quorum can treat a formal counterexample as a HYPOTHESIS about a plan gap — a
 * formal fail at plan time is strong evidence the plan is missing something.
 *
 * Fail-open (PLAN-03): a missing/empty/corrupt ledger yields [] and exit 0 — never throw,
 * never block planning on formal-tool availability.
 *
 * Path: CHECK_RESULTS_PATH env > .planning/formal/check-results.ndjson.
 * Exports: extractFvFails
 * CLI: CHECK_RESULTS_PATH=<file> node bin/extract-fv-fails.cjs [--json]  (exit 0 always)
 */

const fs = require('fs');
const path = require('path');

/**
 * @param {string} ndjsonText  raw check-results.ndjson content
 * @returns {Array<{check_id,property,surface,summary,tool}>}  one hypothesis per fail
 */
function extractFvFails(ndjsonText) {
  if (typeof ndjsonText !== 'string' || ndjsonText.trim().length === 0) return [];
  const lines = ndjsonText.split('\n').filter((l) => l.trim().length > 0);
  return lines
    .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter((r) => r && r.result === 'fail')
    .map((r) => ({
      check_id: r.check_id || null,
      property: r.property || null,
      surface: r.surface || null,
      tool: r.tool || null,
      summary: r.summary || null,
    }));
}

if (require.main === module) {
  const ndjsonPath = process.env.CHECK_RESULTS_PATH ||
    path.join(process.cwd(), '.planning', 'formal', 'check-results.ndjson');
  let text = '';
  try { text = fs.readFileSync(ndjsonPath, 'utf8'); } catch (_) { text = ''; } // fail-open
  const fails = extractFvFails(text);
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(fails) + '\n');
  } else if (fails.length === 0) {
    process.stdout.write('No formal-verification failures — 0 plan-time hypotheses.\n');
  } else {
    process.stdout.write(fails.length + ' formal fail(s) → plan-time hypotheses:\n');
    for (const f of fails) {
      process.stdout.write('  - [' + (f.surface || '?') + '] ' + (f.check_id || '?') +
        ' — property ' + (f.property || '?') + ': ' + (f.summary || '') + '\n');
    }
  }
  process.exit(0); // fail-open: never non-zero
}

module.exports = { extractFvFails };

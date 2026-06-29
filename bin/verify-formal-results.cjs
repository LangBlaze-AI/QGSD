#!/usr/bin/env node
'use strict';
// bin/verify-formal-results.cjs
// NDJSON parser and Formal Verification section generator.
// Exports: parseNDJSON, groupByFormalism, generateFVSection
// Requirements: VERIFY-01, VERIFY-02

const fs = require('fs');

/**
 * Parse .planning/formal/check-results.ndjson line-by-line.
 * Skips empty lines and malformed JSON (fail-open per PLAN-03 pattern).
 * @param {string} ndjsonPath — absolute or relative path to NDJSON file
 * @returns {object[]} — array of parsed result objects (may be empty)
 */
function parseNDJSON(ndjsonPath) {
  let content;
  try {
    content = fs.readFileSync(ndjsonPath, 'utf8');
  } catch (e) {
    // File missing or unreadable — fail-open, return empty
    return [];
  }
  const lines = content.trim().split('\n');
  const results = [];
  for (const line of lines) {
    if (!line.trim()) continue; // skip empty lines
    try {
      results.push(JSON.parse(line));
    } catch (e) {
      // Skip malformed NDJSON lines — warn but do not throw
      process.stderr.write('[verify-formal-results] warning: skipping malformed NDJSON line: ' + e.message + '\n');
    }
  }
  return results;
}

/**
 * Group result objects by formalism with pass/fail/warn/inconclusive counts.
 * Uses result.formalism as dynamic key — no hardcoded formalism list.
 * @param {object[]} results — parsed NDJSON result objects
 * @returns {Object.<string, {pass: number, fail: number, warn: number, inconclusive: number}>}
 */
function groupByFormalism(results) {
  const grouped = Object.create(null); // null prototype: prevents '__proto__'/'constructor' formalisms being swallowed by the prototype chain
  for (const result of results) {
    if (!result || typeof result !== 'object') continue; // skip null/non-object records (fail-open, matches parseNDJSON policy)
    const formalism = result.formalism || 'unknown';
    if (!grouped[formalism]) {
      grouped[formalism] = { pass: 0, fail: 0, warn: 0, inconclusive: 0 };
    }
    const resultType = result.result;
    if (resultType in grouped[formalism]) {
      grouped[formalism][resultType]++;
    }
  }
  return grouped;
}

/**
 * Generate a ## Formal Verification markdown section from grouped counts.
 * @param {Object} grouped — output of groupByFormalism
 * @param {string} command — the command that was run (e.g. 'run-formal-verify --only=tla')
 * @param {string} timestamp — ISO timestamp of when FV was run
 * @returns {string} — markdown string starting with '## Formal Verification'
 */
function generateFVSection(grouped, command, timestamp) {
  const lines = ['## Formal Verification', ''];
  lines.push(`**Command:** \`${command}\``);
  lines.push(`**Completed:** ${timestamp}`);

  // Determine overall status: fail > inconclusive > pass
  let overallStatus = 'pass';
  for (const counts of Object.values(grouped)) {
    if (counts.fail > 0) { overallStatus = 'fail'; break; }
    if (counts.inconclusive > 0 && overallStatus !== 'fail') overallStatus = 'inconclusive';
  }
  lines.push(`**Overall Status:** ${overallStatus}`);
  lines.push('');

  // Per-formalism tables
  for (const [formalism, counts] of Object.entries(grouped)) {
    const label = formalism.toUpperCase();
    lines.push(`### ${label} Results`);
    lines.push('');
    lines.push('| Result | Count | Notes |');
    lines.push('|--------|-------|-------|');
    lines.push(`| pass | ${counts.pass} | ${counts.pass > 0 ? 'Checks verified' : 'None'} |`);
    lines.push(`| fail | ${counts.fail} | ${counts.fail > 0 ? 'Critical: investigation needed' : 'None'} |`);
    lines.push(`| warn | ${counts.warn} | ${counts.warn > 0 ? 'Advisory: review recommended' : 'None'} |`);
    lines.push(`| inconclusive | ${counts.inconclusive} | ${counts.inconclusive > 0 ? 'Requires fairness assumptions or additional data' : 'None'} |`);
    lines.push('');
  }

  // Summary by result type (totals across all formalisms)
  let totalPass = 0, totalFail = 0, totalWarn = 0, totalInconclusive = 0;
  for (const counts of Object.values(grouped)) {
    totalPass += counts.pass;
    totalFail += counts.fail;
    totalWarn += counts.warn;
    totalInconclusive += counts.inconclusive;
  }
  const totalChecks = totalPass + totalFail + totalWarn + totalInconclusive;

  lines.push('### Summary by Result Type');
  lines.push('');
  lines.push('| Result | Count | Notes |');
  lines.push('|--------|-------|-------|');
  lines.push(`| pass | ${totalPass} | ${totalPass > 0 ? 'All formal properties verified' : 'None'} |`);
  lines.push(`| fail | ${totalFail} | ${totalFail > 0 ? 'Critical: formal properties violated' : 'None'} |`);
  lines.push(`| warn | ${totalWarn} | ${totalWarn > 0 ? 'Advisory items' : 'None'} |`);
  lines.push(`| inconclusive | ${totalInconclusive} | ${totalInconclusive > 0 ? 'Requires additional verification' : 'None'} |`);
  lines.push('');
  lines.push(`**Conclusion:** ${
    overallStatus === 'pass'
      ? `All ${totalChecks} formal properties verified.`
      : overallStatus === 'inconclusive'
      ? `${totalInconclusive} inconclusive result(s); review fairness assumptions.`
      : `${totalFail} formal propert${totalFail === 1 ? 'y' : 'ies'} failed; implementation requires revision.`
  }`);

  return lines.join('\n');
}

module.exports = { parseNDJSON, groupByFormalism, generateFVSection };

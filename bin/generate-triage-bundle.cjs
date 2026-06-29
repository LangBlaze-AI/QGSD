#!/usr/bin/env node
'use strict';
// bin/generate-triage-bundle.cjs
// Reads .planning/formal/check-results.ndjson, writes .planning/formal/diff-report.md and .planning/formal/suspects.md.
// Requirements: TRIAGE-01

const fs   = require('fs');
const path = require('path');
const { parseNDJSON, groupByFormalism } = require('./verify-formal-results.cjs');

/**
 * Parse .planning/formal/check-results.ndjson relative to cwd.
 * Uses parseNDJSON from verify-formal-results.cjs (fail-open, skips malformed lines).
 * @returns {object[]} — parsed result records (may be empty)
 */
function parseCurrentNDJSON() {
  const ndjsonPath = path.join(process.cwd(), '.planning', 'formal', 'check-results.ndjson');
  return parseNDJSON(ndjsonPath).filter(r => r !== null && typeof r === 'object' && !Array.isArray(r));
}

/**
 * Filter and sort suspects from current NDJSON records.
 * Suspects = result=fail OR triage_tags.length > 0.
 * Sort: fail > warn+tags > inconclusive+tags > everything else.
 * @param {object[]} results — parsed NDJSON records
 * @returns {object[]} — suspect records, sorted by priority
 */
function generateSuspects(results) {
  const suspects = results.filter(r =>
    r.result === 'fail' ||
    r.result === 'error' ||
    (Array.isArray(r.triage_tags) && r.triage_tags.length > 0)
  );

  const priority = (r) => {
    if (r.result === 'fail') return 0;
    if (r.result === 'error') return 1;
    if (r.result === 'warn' && r.triage_tags && r.triage_tags.length > 0) return 2;
    return 3;
  };

  suspects.sort((a, b) => priority(a) - priority(b));
  return suspects;
}

/**
 * Load previous run's check_id->result snapshot from embedded JSON block in diff-report.md.
 * Returns {} if no previous report exists or no JSON block found (fail-open).
 * @returns {Object.<string, string>} — map of check_id to result string
 */
function loadPreviousSnapshot() {
  const diffPath = path.join(process.cwd(), '.planning', 'formal', 'diff-report.md');
  let content;
  try {
    content = fs.readFileSync(diffPath, 'utf8');
  } catch (_) {
    return {};  // no previous report — first run
  }
  // Extract JSON block from "## Previous Run (for next comparison)" section
  const match = content.match(/```json\s*\n([\s\S]*?)```/);
  if (!match) return {};
  try {
    const parsed = JSON.parse(match[1]);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_) { /* malformed JSON block — treat as first run */ }
  return {};
}

/**
 * Compute per-check delta between current and previous run.
 * @param {object[]} currentResults — parsed NDJSON records
 * @param {Object.<string, string>} previousSnapshot — check_id->result from last run
 * @returns {{ transitioned: object[], newChecks: object[], removedChecks: string[], unchanged: number }}
 */
function computeDeltas(currentResults, previousSnapshot) {
  const currentMap = {};
  for (const r of currentResults) {
    if (r.check_id) currentMap[r.check_id] = r;
  }

  const transitioned = [];
  const newChecks    = [];
  let unchanged      = 0;

  for (const r of currentResults) {
    if (!r.check_id) continue;
    if (!Object.prototype.hasOwnProperty.call(previousSnapshot, r.check_id)) {
      newChecks.push(r);
    } else if (previousSnapshot[r.check_id] !== r.result) {
      transitioned.push({ ...r, previousResult: previousSnapshot[r.check_id] });
    } else {
      unchanged++;
    }
  }

  const removedChecks = Object.keys(previousSnapshot).filter(id => !Object.prototype.hasOwnProperty.call(currentMap, id));

  return { transitioned, newChecks, removedChecks, unchanged };
}

/**
 * Build check_id->result map from current results (for embedding in diff-report.md).
 * @param {object[]} currentResults
 * @returns {Object.<string, string>}
 */
function buildCurrentSnapshot(currentResults) {
  const snap = {};
  for (const r of currentResults) {
    if (r.check_id) snap[r.check_id] = r.result;
  }
  return snap;
}

/**
 * Generate diff-report.md content.
 * @param {object[]} currentResults
 * @param {Object} deltas — from computeDeltas
 * @param {boolean} isFirstRun
 * @returns {string} — full markdown content
 */
function formatDiffReport(currentResults, deltas, isFirstRun) {
  const timestamp = new Date().toISOString();
  const grouped   = groupByFormalism(currentResults);

  // Overall status: fail > inconclusive > pass
  let overallStatus = 'pass';
  for (const counts of Object.values(grouped)) {
    if (counts.fail > 0) { overallStatus = 'fail'; break; }
    if (counts.inconclusive > 0 && overallStatus !== 'fail') overallStatus = 'inconclusive';
  }

  const pass  = currentResults.filter(r => r.result === 'pass').length;
  const fail  = currentResults.filter(r => r.result === 'fail').length;
  const other = currentResults.length - pass - fail;

  const lines = [
    '# Formal Verification Diff Report',
    '',
    `**Generated:** ${timestamp}`,
    `**Current Run:** ${pass} pass, ${fail} fail` + (other > 0 ? `, ${other} warn/inconclusive` : ''),
    `**Previous Run:** ${isFirstRun ? 'first run — no previous snapshot' : `${deltas.transitioned.length} transitions, ${deltas.newChecks.length} new, ${deltas.removedChecks.length} removed`}`,
    `**Overall Status:** ${overallStatus}`,
    '',
  ];

  if (isFirstRun) {
    lines.push('**Status:** First run — no previous snapshot to compare against.');
    lines.push('');
    lines.push('All checks are new. Run again after a second verification to see deltas.');
    lines.push('');
  } else {
    // Transitioned checks
    if (deltas.transitioned.length > 0) {
      lines.push('## Transitioned Checks');
      lines.push('');
      lines.push('| Check | Previous | Current | Summary |');
      lines.push('|-------|----------|---------|---------|');
      for (const r of deltas.transitioned) {
        const summary = String(r.summary || '').substring(0, 60);
        lines.push(`| ${r.check_id} | ${r.previousResult} | ${r.result} | ${summary} |`);
      }
      lines.push('');
    }

    // New checks
    if (deltas.newChecks.length > 0) {
      lines.push('## New Checks');
      lines.push('');
      lines.push('| Check | Result | Summary |');
      lines.push('|-------|--------|---------|');
      for (const r of deltas.newChecks) {
        const summary = String(r.summary || '').substring(0, 60);
        lines.push(`| ${r.check_id} | ${r.result} | ${summary} |`);
      }
      lines.push('');
    }

    // Removed checks
    if (deltas.removedChecks.length > 0) {
      lines.push('## Removed Checks');
      lines.push('');
      for (const id of deltas.removedChecks) {
        lines.push(`- ${id}: no longer run`);
      }
      lines.push('');
    }

    // Unchanged — summary only
    if (deltas.unchanged > 0) {
      lines.push('## Unchanged Checks');
      lines.push('');
      lines.push(`${deltas.unchanged} check(s) unchanged from previous run — no action needed.`);
      lines.push('');
    }
  }

  // Embedded snapshot — REQUIRED for next run delta computation
  const snapshot = buildCurrentSnapshot(currentResults);
  lines.push('## Previous Run (for next comparison)');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(snapshot));
  lines.push('```');

  return lines.join('\n');
}

/**
 * Generate suspects.md content.
 * @param {object[]} suspects — from generateSuspects (pre-sorted)
 * @returns {string} — full markdown content
 */
function formatSuspectsReport(suspects) {
  const timestamp = new Date().toISOString();
  const lines = [
    '# Formal Verification Suspects',
    '',
    `**Generated:** ${timestamp}`,
    `**Total Suspects:** ${suspects.length}`,
    '',
  ];

  if (suspects.length === 0) {
    lines.push('No suspects found — all checks passed without triage tags.');
    return lines.join('\n');
  }

  const critical     = suspects.filter(r => r.result === 'fail');
  const warnings     = suspects.filter(r => r.result === 'warn' && Array.isArray(r.triage_tags) && r.triage_tags.length > 0);
  const inconclusive = suspects.filter(r => r.result === 'inconclusive' && Array.isArray(r.triage_tags) && r.triage_tags.length > 0);
  const other        = suspects.filter(r =>
    !['fail'].includes(r.result) &&
    !(r.result === 'warn' && Array.isArray(r.triage_tags) && r.triage_tags.length > 0) &&
    !(r.result === 'inconclusive' && Array.isArray(r.triage_tags) && r.triage_tags.length > 0)
  );

  function renderGroup(title, group) {
    if (group.length === 0) return;
    lines.push(`## ${title}`);
    lines.push('');
    for (const r of group) {
      lines.push(`### ${r.check_id}`);
      lines.push(`- **Property:** ${r.property || 'N/A'}`);
      lines.push(`- **Summary:** ${r.summary || 'N/A'}`);
      lines.push(`- **Runtime:** ${r.runtime_ms != null ? r.runtime_ms + 'ms' : 'N/A'}`);
      lines.push(`- **Tags:** ${Array.isArray(r.triage_tags) && r.triage_tags.length > 0 ? r.triage_tags.join(', ') : 'none'}`);
      lines.push('');
    }
  }

  renderGroup('Critical Failures (result=fail)', critical);
  renderGroup('Warnings with Tags (result=warn)', warnings);
  renderGroup('Inconclusive with Tags (result=inconclusive)', inconclusive);
  renderGroup('Other Suspects', other);

  return lines.join('\n');
}

function writeFileSafe(filePath, content) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    process.stderr.write('[generate-triage-bundle] Wrote: ' + filePath + '\n');
  } catch (err) {
    process.stderr.write('[generate-triage-bundle] Warning: could not write ' + filePath + ': ' + err.message + '\n');
  }
}

/**
 * Main CLI entry point.
 * Reads .planning/formal/check-results.ndjson relative to process.cwd().
 * Writes .planning/formal/diff-report.md and .planning/formal/suspects.md.
 */
function main() {
  const currentResults   = parseCurrentNDJSON();
  const previousSnapshot = loadPreviousSnapshot();
  const isFirstRun       = Object.keys(previousSnapshot).length === 0;
  const deltas           = computeDeltas(currentResults, previousSnapshot);
  const suspects         = generateSuspects(currentResults);

  const formalDir = path.join(process.cwd(), '.planning', 'formal');
  writeFileSafe(path.join(formalDir, 'diff-report.md'), formatDiffReport(currentResults, deltas, isFirstRun));
  writeFileSafe(path.join(formalDir, 'suspects.md'),    formatSuspectsReport(suspects));
}

// ── Exports ───────────────────────────────────────────────────────────────────
// Exported for testing without CLI execution side effects.
if (require.main === module) {
  main();
}

module.exports = {
  parseCurrentNDJSON,
  generateSuspects,
  computeDeltas,
  loadPreviousSnapshot,
  buildCurrentSnapshot,
  formatDiffReport,
  formatSuspectsReport,
};

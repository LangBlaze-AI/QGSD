#!/usr/bin/env node
/**
 * Diagnostic diff generator for state sequence comparison.
 * Compares two state sequences and generates human-readable markdown diffs.
 */

const { diff } = require('json-diff-ts');
const { parseITFTrace, extractStateFields } = require('./parse-tlc-counterexample.cjs');

/**
 * Compare two state sequence arrays (as returned by parseITFTrace).
 * Uses json-diff-ts to compare corresponding states index by index.
 *
 * @param {Array<Object>} statesA - First state sequence
 * @param {Array<Object>} statesB - Second state sequence
 * @param {Object} options - Optional configuration
 * @param {string[]} options.fieldFilter - If provided, only compare these fields
 * @returns {{
 *   aligned_length: number,
 *   length_mismatch: boolean,
 *   per_state_diffs: Array<{index: number, changes: Array<{key, oldValue, newValue}>}>,
 *   summary: {total_changes: number, changed_fields: string[], first_divergence_index: number | null}
 * }}
 */
function generateStateDiff(statesA, statesB, options = {}) {
  const { fieldFilter } = options;

  // Apply field filter if provided
  const filteredA = fieldFilter ? extractStateFields(statesA, fieldFilter) : (Array.isArray(statesA) ? statesA : []);
  const filteredB = fieldFilter ? extractStateFields(statesB, fieldFilter) : (Array.isArray(statesB) ? statesB : []);

  const alignedLength = Math.min(filteredA.length, filteredB.length);
  const lengthMismatch = filteredA.length !== filteredB.length;

  const per_state_diffs = [];
  const changedFields = new Set();
  let firstDivergenceIndex = null;

  // Compare corresponding states
  for (let i = 0; i < alignedLength; i++) {
    const stateA = filteredA[i] || {};
    const stateB = filteredB[i] || {};

    // Use json-diff-ts to compute differences
    const differences = diff(stateA, stateB);

    if (differences && differences.length > 0) {
      if (firstDivergenceIndex === null) {
        firstDivergenceIndex = i;
      }

      const changes = [];
      for (const d of differences) {
        changes.push({
          key: d.key,
          oldValue: d.oldValue,
          newValue: d.value  // json-diff-ts uses 'value' not 'newValue'
        });
        changedFields.add(d.key);
      }

      per_state_diffs.push({
        index: i,
        changes
      });
    }
  }

  return {
    aligned_length: alignedLength,
    length_mismatch: lengthMismatch,
    per_state_diffs,
    summary: {
      total_changes: per_state_diffs.reduce((sum, sd) => sum + sd.changes.length, 0),
      changed_fields: Array.from(changedFields).sort(),
      first_divergence_index: firstDivergenceIndex
    }
  };
}

/**
 * Format generateStateDiff output as human-readable markdown.
 * @param {Object} diffResult - Result from generateStateDiff
 * @returns {string} Markdown-formatted diff report
 */
function formatDiffAsMarkdown(diffResult) {
  if (!diffResult || !diffResult.per_state_diffs || diffResult.per_state_diffs.length === 0) {
    return '## State Divergence Report\n\n**Traces are identical** — no state differences detected.\n';
  }

  const { summary, per_state_diffs, aligned_length, length_mismatch } = diffResult;
  const { total_changes = 0, changed_fields = [], first_divergence_index = null } = summary || {};

  let markdown = '## State Divergence Report\n\n';

  // Header
  if (first_divergence_index !== null) {
    markdown += `**Traces diverge at state ${first_divergence_index}** (${total_changes} total changes across ${changed_fields.length} fields)\n\n`;
  }

  // Length mismatch warning
  if (length_mismatch) {
    markdown += `⚠️ **Trace length mismatch**: aligned to ${aligned_length} states\n\n`;
  }

  // Per-state diffs
  for (const stateDiff of per_state_diffs) {
    markdown += `### State ${stateDiff.index}\n\n`;
    markdown += '| Field | Trace A | Trace B |\n';
    markdown += '|-------|---------|----------|\n';

    for (const change of stateDiff.changes) {
      const oldVal = formatValue(change.oldValue);
      const newVal = formatValue(change.newValue);
      markdown += `| ${change.key} | ${oldVal} | ${newVal} |\n`;
    }

    markdown += '\n';
  }

  return markdown;
}

/**
 * Format a value for markdown display (handles objects, arrays, primitives).
 * @param {*} value - Value to format
 * @returns {string} Formatted string suitable for markdown table
 */
function formatValue(value) {
  if (value === null || value === undefined) {
    return `\`${value}\``;
  }
  if (typeof value === 'object') {
    return `\`${JSON.stringify(value)}\``;
  }
  if (typeof value === 'string') {
    return `\`"${value}"\``;
  }
  return `\`${value}\``;
}

module.exports = {
  generateStateDiff,
  formatDiffAsMarkdown
};

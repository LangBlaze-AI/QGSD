'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Default path for the observe targets manifest.
 * Written by observe step 7 "solve N,M,..." and consumed by solve Step 0c.
 * @type {string}
 */
const DEFAULT_TARGETS_PATH = '.planning/observe-targets.json';

/**
 * Parse user input like "solve 1,3,5" or "solve 1-3,7" into zero-based indices.
 * Supports comma-separated numbers, ranges (N-M), and mixed combinations.
 * Tolerates whitespace around numbers and commas.
 * Deduplicates and sorts ascending. Filters out indices >= maxIndex.
 *
 * @param {string} input - User input string (e.g., "solve 1,3,5" or "solve 1-3,7")
 * @param {number} maxIndex - Maximum valid 1-based index (typically allIssues.length)
 * @returns {number[]} Array of zero-based indices, sorted ascending
 */
function parseIssueSelection(input, maxIndex) {
  if (!input || typeof input !== 'string') return [];

  // Strip the "solve" prefix if present
  const stripped = input.replace(/^\s*solve\s*/i, '').trim();
  if (!stripped) return [];

  const indices = new Set();

  // Split on commas, tolerating whitespace
  const parts = stripped.split(',').map(p => p.trim()).filter(Boolean);

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      const lo = Math.max(1, Math.min(start, end));
      const hi = Math.min(Math.max(start, end), maxIndex);
      for (let i = lo; i <= hi; i++) {
        indices.add(i - 1); // Convert to zero-based
      }
    } else {
      const num = parseInt(part, 10);
      if (!isNaN(num) && num >= 1 && num <= maxIndex) {
        indices.add(num - 1); // Convert to zero-based
      }
    }
  }

  return Array.from(indices).sort((a, b) => a - b);
}

/**
 * Build a targets manifest from selected observe issue objects.
 *
 * @param {Array<Object>} selectedIssues - Array of observe issue objects (standard schema)
 * @param {Object} [options] - Optional settings
 * @returns {Object} Targets manifest with version, created_at, source, targets
 */
function buildTargetsManifest(selectedIssues, options = {}) {
  return {
    version: 1,
    created_at: new Date().toISOString(),
    source: 'observe',
    targets: (selectedIssues || []).filter(issue => issue && typeof issue === 'object').map(issue => ({
      id: issue.id,
      title: issue.title,
      severity: issue.severity,
      source_type: issue.source_type,
      issue_type: issue.issue_type,
      _route: issue._route || null,
      formal_ref: issue.formal_parameter_key || issue.formal_ref || null,
      fingerprint: issue.fingerprint || null
    }))
  };
}

/**
 * Write a targets manifest JSON to disk.
 * Default output path: .planning/observe-targets.json
 *
 * @param {Object} manifest - The targets manifest object
 * @param {string} [outputPath] - Path to write to (default: DEFAULT_TARGETS_PATH)
 * @returns {{ path: string, count: number }}
 */
function writeTargetsManifest(manifest, outputPath) {
  const targetPath = outputPath || DEFAULT_TARGETS_PATH;
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(targetPath, JSON.stringify(manifest, null, 2), 'utf8');
  return { path: targetPath, count: (manifest.targets || []).length };
}

/**
 * Read and validate a targets manifest from disk.
 * Returns the manifest object or null if file is missing/invalid.
 * Validates version === 1 and targets is an array.
 *
 * @param {string} [inputPath] - Path to read from (default: DEFAULT_TARGETS_PATH)
 * @returns {Object|null} The parsed manifest or null
 */
function readTargetsManifest(inputPath) {
  const targetPath = inputPath || DEFAULT_TARGETS_PATH;
  try {
    if (!fs.existsSync(targetPath)) return null;
    const raw = fs.readFileSync(targetPath, 'utf8');
    const manifest = JSON.parse(raw);
    // Validate schema: version must be 1, targets must be an array
    if (manifest.version !== 1 || !Array.isArray(manifest.targets)) {
      return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

module.exports = {
  DEFAULT_TARGETS_PATH,
  parseIssueSelection,
  buildTargetsManifest,
  writeTargetsManifest,
  readTargetsManifest
};

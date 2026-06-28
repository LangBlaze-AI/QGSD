/** @requirement DIAG-01 — error clustering for solve diagnostic pipeline */

/**
 * Error clustering engine for observe pipeline Category 16.
 * Groups error entries by type + Levenshtein similarity to reduce
 * per-entry noise into actionable clusters.
 *
 * Pure function module: no file I/O, no side effects.
 */

'use strict';

const { levenshteinSimilarity } = require('./levenshtein.cjs');

// Known JS/Node error type patterns (order matters: first match wins)
const ERROR_TYPE_PATTERNS = [
  { regex: /\\!/, type: 'ShellEscaping' },
  { regex: /SyntaxError/, type: 'SyntaxError' },
  { regex: /TypeError/, type: 'TypeError' },
  { regex: /ReferenceError/, type: 'ReferenceError' },
  { regex: /Error:\s*ENOENT/, type: 'ENOENT' },
  { regex: /Error:\s*Cannot find module/, type: 'CannotFindModule' },
  { regex: /Output too large/i, type: 'ToolError' },
  { regex: /class not found/i, type: 'ToolError' },
  { regex: /exceeds maximum/i, type: 'ToolError' },
  { regex: /Exit code \d/i, type: 'ExitCode' },
  { regex: /Deadlock/i, type: 'RuntimeError' },
  { regex: /throw\s/, type: 'RuntimeError' },
];

// Types where primary grouping IS the cluster — skip Levenshtein sub-clustering.
// These error types share the same root cause regardless of symptom text.
const CONSOLIDATE_TYPES = new Set([
  'ShellEscaping', 'ENOENT', 'CannotFindModule', 'TypeError',
  'ReferenceError', 'ToolError'
]);

/**
 * Extract error type keyword from a symptom string.
 * @param {string} symptom
 * @returns {string} Error type label
 */
function extractErrorType(symptom) {
  if (!symptom) return 'Unknown';
  for (const { regex, type } of ERROR_TYPE_PATTERNS) {
    if (regex.test(symptom)) return type;
  }
  return 'Unknown';
}

/**
 * Cluster error entries by type + Levenshtein similarity.
 *
 * @param {object[]} entries - Array of error entries ({ type, symptom, root_cause, fix, tags, ts, confidence })
 * @param {object} [options] - Options
 * @param {number} [options.threshold=0.7] - Levenshtein similarity threshold for sub-clustering
 * @param {number} [options.staleAfterDays=7] - Days after which a cluster is considered stale
 * @param {Date} [options.now] - Reference date for staleness (default: new Date())
 * @returns {object[]} Array of cluster objects
 */
function clusterErrors(entries, options = {}) {
  if (!entries || entries.length === 0) return [];
  if (!options || typeof options !== 'object') options = {};

  const threshold = options.threshold ?? 0.7;
  const staleAfterDays = options.staleAfterDays ?? 7;
  const now = options.now || new Date();
  const staleCutoff = new Date(now.getTime() - staleAfterDays * 24 * 60 * 60 * 1000);

  // Phase 1: Group by extracted error type
  const typeGroups = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue; // skip null/non-object entries (fail-open)
    const errorType = extractErrorType(entry.symptom);
    if (!typeGroups.has(errorType)) {
      typeGroups.set(errorType, []);
    }
    typeGroups.get(errorType).push(entry);
  }

  // Phase 2: Sub-clustering within each type group
  // For CONSOLIDATE_TYPES, skip Levenshtein and emit one cluster per type.
  // For others, apply Levenshtein sub-clustering.
  const rawClusters = [];

  for (const [errorType, group] of typeGroups) {
    let subClusters; // each: { representative: entry, members: entry[] }

    if (CONSOLIDATE_TYPES.has(errorType)) {
      // Single cluster for the whole type group
      subClusters = [{ representative: group[0], members: [...group] }];
    } else {
      subClusters = [];
      for (const entry of group) {
        const symptom = (typeof entry.symptom === 'string' ? entry.symptom : '').toLowerCase();
        let merged = false;

        for (const sc of subClusters) {
          const repSymptom = (typeof sc.representative.symptom === 'string' ? sc.representative.symptom : '').toLowerCase();
          const sim = levenshteinSimilarity(symptom, repSymptom);
          if (sim >= threshold) {
            sc.members.push(entry);
            merged = true;
            break;
          }
        }

        if (!merged) {
          subClusters.push({ representative: entry, members: [entry] });
        }
      }
    }

    // Build cluster objects from sub-clusters
    for (let i = 0; i < subClusters.length; i++) {
      const sc = subClusters[i];
      const members = sc.members;

      // Representative: entry with highest confidence, or first
      const CONF_ORDER = { high: 3, medium: 2, low: 1 };
      let bestEntry = members[0];
      let bestScore = CONF_ORDER[bestEntry.confidence] || 0;
      for (let j = 1; j < members.length; j++) {
        const score = CONF_ORDER[members[j].confidence] || 0;
        if (score > bestScore) {
          bestEntry = members[j];
          bestScore = score;
        }
      }

      // Staleness: all entries must have ts older than cutoff
      // Entries without ts are treated as not-stale (conservative)
      const stale = members.every(e => {
        if (!e.ts) return false; // no ts = not stale (conservative)
        return new Date(e.ts) < staleCutoff;
      });

      // avgConfidence: 'high' if any high, else 'medium' if any medium, else 'low'
      let avgConfidence = 'low';
      for (const e of members) {
        if (e.confidence === 'high') { avgConfidence = 'high'; break; }
        if (e.confidence === 'medium') avgConfidence = 'medium';
      }

      const label = (typeof bestEntry.symptom === 'string' ? bestEntry.symptom : 'Unknown error').slice(0, 80);

      rawClusters.push({
        errorType,
        subIndex: i,
        label,
        count: members.length,
        entries: members,
        representative: bestEntry,
        stale,
        avgConfidence,
      });
    }
  }

  // Phase 3: Roll up singleton clusters (count === 1) into an "Other" bucket
  // to further reduce noise. Multi-entry clusters pass through.
  const multiClusters = [];
  const singletonEntries = [];

  for (const c of rawClusters) {
    if (c.count === 1) {
      singletonEntries.push(...c.entries);
    } else {
      multiClusters.push(c);
    }
  }

  // Build final clusters with stable IDs
  const allClusters = [];
  for (let i = 0; i < multiClusters.length; i++) {
    const c = multiClusters[i];
    allClusters.push({
      clusterId: `${c.errorType}-${c.subIndex}`,
      label: c.label,
      errorType: c.errorType,
      count: c.count,
      entries: c.entries,
      representative: c.representative,
      stale: c.stale,
      avgConfidence: c.avgConfidence,
    });
  }

  // Add "Other" bucket for singletons (if any)
  if (singletonEntries.length > 0) {
    const CONF_ORDER = { high: 3, medium: 2, low: 1 };
    let bestEntry = singletonEntries[0];
    let bestScore = CONF_ORDER[bestEntry.confidence] || 0;
    for (let j = 1; j < singletonEntries.length; j++) {
      const score = CONF_ORDER[singletonEntries[j].confidence] || 0;
      if (score > bestScore) { bestEntry = singletonEntries[j]; bestScore = score; }
    }

    const stale = singletonEntries.every(e => {
      if (!e.ts) return false;
      return new Date(e.ts) < staleCutoff;
    });

    let avgConfidence = 'low';
    for (const e of singletonEntries) {
      if (e.confidence === 'high') { avgConfidence = 'high'; break; }
      if (e.confidence === 'medium') avgConfidence = 'medium';
    }

    allClusters.push({
      clusterId: 'Other-0',
      label: `${singletonEntries.length} miscellaneous errors`,
      errorType: 'Other',
      count: singletonEntries.length,
      entries: singletonEntries,
      representative: bestEntry,
      stale,
      avgConfidence,
    });
  }

  return allClusters;
}

module.exports = { clusterErrors };

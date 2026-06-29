/**
 * Dedup engine for debt entries
 * Phase 1: Fingerprint exact-match (O(n) via hash map)
 * Phase 2: Levenshtein near-duplicate detection (O(n^2) on remaining unmatched)
 */

const { levenshteinSimilarity } = require('./levenshtein.cjs');

// Status ordering: more advanced state wins during merge
const STATUS_ORDER = { open: 0, acknowledged: 1, resolving: 2, resolved: 3 };

/**
 * Merge two debt entries, preserving the one with higher occurrences as primary.
 * All source_entries are concatenated. Timestamps use min/max. Environments are unioned.
 *
 * @param {object} entryA - First debt entry
 * @param {object} entryB - Second debt entry
 * @returns {object} Merged debt entry
 */
function mergeDebtEntries(entryA, entryB) {
  if (entryA == null || typeof entryA !== 'object') return entryB;
  if (entryB == null || typeof entryB !== 'object') return entryA;

  // Determine primary: entry with higher occurrences (if equal, entryA is primary)
  let primary, secondary;
  if ((entryB.occurrences || 1) > (entryA.occurrences || 1)) {
    primary = entryB;
    secondary = entryA;
  } else {
    primary = entryA;
    secondary = entryB;
  }

  // More advanced status wins
  const statusA = STATUS_ORDER[primary.status] ?? 0;
  const statusB = STATUS_ORDER[secondary.status] ?? 0;
  const mergedStatus = statusA >= statusB ? primary.status : secondary.status;

  return {
    id: primary.id,
    fingerprint: primary.fingerprint,
    title: primary.title,
    occurrences: (primary.occurrences || 1) + (secondary.occurrences || 1),
    first_seen: primary.first_seen < secondary.first_seen ? primary.first_seen : secondary.first_seen,
    last_seen: primary.last_seen > secondary.last_seen ? primary.last_seen : secondary.last_seen,
    environments: [...new Set([...(primary.environments || []), ...(secondary.environments || [])])],
    status: mergedStatus,
    formal_ref: primary.formal_ref != null ? primary.formal_ref : secondary.formal_ref || null,
    formal_ref_source: primary.formal_ref_source != null ? primary.formal_ref_source : secondary.formal_ref_source || null,
    source_entries: [...(primary.source_entries || []), ...(secondary.source_entries || [])],
    ...(primary.resolved_at || secondary.resolved_at
      ? { resolved_at: primary.resolved_at || secondary.resolved_at }
      : {})
  };
}

/**
 * Deduplicate debt entries using two-phase strategy:
 * 1. Fingerprint exact-match (fast, O(n))
 * 2. Levenshtein near-duplicate on remaining (O(n^2) on smaller set)
 *
 * @param {object[]} entries - Array of debt entries
 * @param {object} [options] - Options
 * @param {number} [options.threshold=0.85] - Levenshtein similarity threshold for near-duplicate merge
 * @returns {{ entries: object[], mergeCount: number, mergeLog: object[] }}
 */
function deduplicateEntries(entries, options = {}) {
  const threshold = options.threshold ?? 0.85;
  const mergeLog = [];
  let mergeCount = 0;

  if (entries.length <= 1) {
    return { entries: [...entries], mergeCount: 0, mergeLog: [] };
  }

  // Phase 1: Fingerprint exact-match
  const fpGroups = new Map();
  for (const entry of entries) {
    if (entry == null || typeof entry !== 'object') continue;
    const fp = entry.fingerprint;
    if (!fpGroups.has(fp)) {
      fpGroups.set(fp, []);
    }
    fpGroups.get(fp).push(entry);
  }

  // Merge fingerprint groups
  const afterPhase1 = [];
  for (const [fp, group] of fpGroups) {
    if (group.length === 1) {
      afterPhase1.push(group[0]);
    } else {
      // Merge all entries in the group
      let merged = group[0];
      for (let i = 1; i < group.length; i++) {
        mergeLog.push({
          primary_id: merged.id,
          secondary_id: group[i].id,
          merge_type: 'fingerprint'
        });
        merged = mergeDebtEntries(merged, group[i]);
        mergeCount++;
      }
      afterPhase1.push(merged);
    }
  }

  // Phase 2: Levenshtein near-duplicate on remaining
  if (afterPhase1.length <= 1) {
    return { entries: afterPhase1, mergeCount, mergeLog };
  }

  const merged = new Set(); // indices that have been merged into another
  const result = [];

  for (let i = 0; i < afterPhase1.length; i++) {
    if (merged.has(i)) continue;

    let current = afterPhase1[i];

    for (let j = i + 1; j < afterPhase1.length; j++) {
      if (merged.has(j)) continue;

      const titleA = typeof current.title === 'string' ? current.title.toLowerCase() : '';
      const titleB = typeof afterPhase1[j].title === 'string' ? afterPhase1[j].title.toLowerCase() : '';
      const sim = levenshteinSimilarity(titleA, titleB);

      if (sim >= threshold) {
        mergeLog.push({
          primary_id: current.id,
          secondary_id: afterPhase1[j].id,
          merge_type: 'levenshtein',
          similarity: sim
        });
        current = mergeDebtEntries(current, afterPhase1[j]);
        merged.add(j);
        mergeCount++;
      }
    }

    result.push(current);
  }

  return { entries: result, mergeCount, mergeLog };
}

module.exports = { deduplicateEntries, mergeDebtEntries };

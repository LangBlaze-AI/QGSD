/**
 * Levenshtein distance and similarity functions
 * Used by the dedup engine for near-duplicate detection on debt entry titles
 *
 * Algorithm: Wagner-Fischer with two-row space optimization — O(m*n) time, O(min(m,n)) space
 */

/**
 * Compute Levenshtein edit distance between two strings
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} Integer edit distance
 */
function levenshteinDistance(a, b) {
  if (typeof a !== 'string') a = a == null ? '' : String(a);
  if (typeof b !== 'string') b = b == null ? '' : String(b);
  // Early exits
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure a is the shorter string for O(min(m,n)) space
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const m = a.length;
  const n = b.length;

  // Two-row optimization: only keep previous and current row
  let prev = new Array(m + 1);
  let curr = new Array(m + 1);

  // Initialize first row: distance from empty string to a[0..i]
  for (let i = 0; i <= m; i++) {
    prev[i] = i;
  }

  // Fill matrix row by row
  for (let j = 1; j <= n; j++) {
    curr[0] = j; // distance from b[0..j] to empty string

    for (let i = 1; i <= m; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        prev[i] + 1,      // deletion
        curr[i - 1] + 1,  // insertion
        prev[i - 1] + cost // substitution
      );
    }

    // Swap rows
    [prev, curr] = [curr, prev];
  }

  // Result is in prev (after swap) at position m
  return prev[m];
}

/**
 * Compute normalized Levenshtein similarity between two strings
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} Similarity score between 0.0 (completely different) and 1.0 (identical)
 */
function levenshteinSimilarity(a, b) {
  if (typeof a !== 'string') a = a == null ? '' : String(a);
  if (typeof b !== 'string') b = b == null ? '' : String(b);
  // Both empty = identical
  if (a.length === 0 && b.length === 0) return 1.0;

  const maxLen = Math.max(a.length, b.length);
  const distance = levenshteinDistance(a, b);

  return 1 - (distance / maxLen);
}

module.exports = { levenshteinDistance, levenshteinSimilarity };

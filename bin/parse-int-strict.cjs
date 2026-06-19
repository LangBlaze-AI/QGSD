#!/usr/bin/env node
'use strict';
// bin/parse-int-strict.cjs
// Shared strict integer parser for numeric bin/ CLI arguments.
// Issue #204 / class #183 — guards against fail-open NaN math when an
// orchestrator passes a placeholder or malformed value for a numeric flag.
//
// Unlike parseInt(), this rejects:
//   - non-string / null / undefined input
//   - empty / whitespace-only strings
//   - values with trailing non-digit garbage ("12abc", "2.5", "0x10")
//   - NaN / Infinity
// Returns the parsed integer, or null when the input is not a clean integer.

/**
 * parseIntStrict(value) — parse a string into an integer, strictly.
 *
 * @param {unknown} value - the raw flag value (e.g. from `--flag=VALUE`.split('=')[1])
 * @returns {number|null} the integer, or null if `value` is not a clean integer
 */
function parseIntStrict(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  // Accept an optional leading sign followed by digits only.
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n)) return null;
  return n;
}

module.exports = { parseIntStrict };

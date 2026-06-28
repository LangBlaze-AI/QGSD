#!/usr/bin/env node
/**
 * ITF (Informal Trace Format) JSON parser for TLC counterexample traces.
 * Parses TLC output from `-dumpTrace json` into structured state sequences.
 */

const fs = require('fs');
const path = require('path');

/**
 * Parse ITF JSON trace from TLC -dumpTrace json output.
 * @param {string} traceJsonPath - Path to .itf.json file written by TLC
 * @returns {{
 *   states: Array<Object>,
 *   loopPoint: number | null,
 *   violated_invariant: string | null,
 *   trace_length: number
 * }}
 */
function parseITFTrace(traceJsonPath) {
  // Handle edge cases
  if (!traceJsonPath) {
    throw new Error('traceJsonPath is required');
  }

  let content;
  try {
    content = fs.readFileSync(traceJsonPath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read ITF file: ${err.message}`);
  }

  if (!content || content.trim() === '') {
    throw new Error('ITF file is empty');
  }

  let trace;
  try {
    trace = JSON.parse(content);
  } catch (err) {
    throw new Error(`Malformed JSON in ITF file: ${err.message}`);
  }

  // Normalize special ITF values in states.
  // Guard: a valid-JSON-but-non-object trace (`null`, a number, a string, an
  // array) or a non-array `states` must degrade to an empty trace, not crash.
  const isTraceObject = trace !== null && typeof trace === 'object' && !Array.isArray(trace);
  const rawStates = isTraceObject && Array.isArray(trace.states) ? trace.states : [];
  const states = rawStates.map(state => normalizeITFValue(state));

  return {
    states,
    loopPoint: isTraceObject && trace.loop !== undefined ? trace.loop : null,
    violated_invariant: (isTraceObject && (trace.violated_invariant || trace.violated)) || null,
    trace_length: states.length
  };
}

/**
 * Normalize ITF special value encoding.
 * Handles: bigint, set, map, and nested structures.
 * @param {*} value - ITF-encoded value
 * @returns {*} Normalized value (primitive, array, or object)
 */
function normalizeITFValue(value) {
  // Primitive types
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== 'object') {
    return value;
  }

  // Array: recurse on each element
  if (Array.isArray(value)) {
    return value.map(normalizeITFValue);
  }

  // Special ITF encodings
  // { "#bigint": "123" } -> string "123" (keep JSON-serializable, not actual BigInt)
  if (value['#bigint'] !== undefined) {
    return String(value['#bigint']);
  }

  // { "#set": [1,2,3] } -> [1,2,3] sorted array
  if (value['#set'] !== undefined) {
    const arr = Array.isArray(value['#set']) ? value['#set'] : [];
    return arr.map(normalizeITFValue).sort((a, b) => {
      // Simple numeric/string sort
      if (typeof a === 'number' && typeof b === 'number') return a - b;
      return String(a).localeCompare(String(b));
    });
  }

  // { "#map": [["k1","v1"],["k2","v2"]] } -> { k1: "v1", k2: "v2" }
  if (value['#map'] !== undefined) {
    const pairs = Array.isArray(value['#map']) ? value['#map'] : [];
    const obj = {};
    for (const pair of pairs) {
      if (Array.isArray(pair) && pair.length >= 2) {
        const key = String(normalizeITFValue(pair[0]));
        const val = normalizeITFValue(pair[1]);
        obj[key] = val;
      }
    }
    return obj;
  }

  // Regular object: recurse on values
  const normalized = {};
  for (const [key, val] of Object.entries(value)) {
    normalized[key] = normalizeITFValue(val);
  }
  return normalized;
}

/**
 * Extract and filter state fields from parsed states.
 * @param {Array<Object>} states - Parsed states array from parseITFTrace
 * @param {string[] | null | undefined} fieldNames - Optional field filter; if null/undefined, return all
 * @returns {Array<Object>} Filtered states (subset of fields if filter provided)
 */
function extractStateFields(states, fieldNames) {
  if (!Array.isArray(states)) {
    return [];
  }

  // No filter: return all fields
  if (!fieldNames || fieldNames.length === 0) {
    return states;
  }

  // Filter to named fields only
  return states.map(state => {
    if (typeof state !== 'object' || state === null) {
      return state;
    }
    const filtered = {};
    for (const field of fieldNames) {
      if (field in state) {
        filtered[field] = state[field];
      }
    }
    return filtered;
  });
}

module.exports = {
  parseITFTrace,
  normalizeITFValue,
  extractStateFields
};

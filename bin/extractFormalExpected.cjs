/**
 * Formal expected value extraction for P->F residual layer
 * Parses formal_ref strings and loads parameter values from spec files
 * Fail-open: returns null on any error (missing file, bad parse, etc.)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Parse a formal_ref string into its components
 * Formats:
 *   "spec:{module}/{file}:{param}" -> { type: 'spec', module, file, param }
 *   "requirement:{id}" -> { type: 'requirement', id }
 *   null/invalid -> null
 * @param {string} formalRef
 * @returns {object|null}
 */
function parseFormalRef(formalRef) {
  if (!formalRef || typeof formalRef !== 'string') return null;

  if (formalRef.startsWith('requirement:')) {
    return { type: 'requirement', id: formalRef.slice('requirement:'.length) };
  }

  if (formalRef.startsWith('spec:')) {
    const rest = formalRef.slice('spec:'.length);
    // Format: module/file:param
    const colonIdx = rest.lastIndexOf(':');
    if (colonIdx === -1) {
      // No param key — invariant reference (e.g., "spec:safety/invariant-consistency")
      return { type: 'spec', path: rest, param: null };
    }
    const filePath = rest.slice(0, colonIdx);
    const param = rest.slice(colonIdx + 1);
    return { type: 'spec', path: filePath, param: param || null };
  }

  return null;
}

/**
 * Extract formal expected value from a spec file
 * Supports .cfg files (line-based key=value) and .json files
 * @param {string} formalRef - Formal reference string
 * @param {object} [options]
 * @param {string} [options.specDir] - Override default spec directory (for testing)
 * @returns {*} The parameter value, or null if not found
 */
function extractFormalExpected(formalRef, options = {}) {
  const parsed = parseFormalRef(formalRef);
  if (!parsed) return null;

  // Requirements are text, not numeric — return null
  if (parsed.type === 'requirement') return null;

  // Spec without param key — invariant reference, no extractable value
  if (parsed.type === 'spec' && !parsed.param) return null;

  const specDir = (options && options.specDir) || path.resolve(process.cwd(), '.planning/formal/spec');
  const filePath = path.join(specDir, parsed.path);
  const resolvedDir = path.resolve(specDir);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile !== resolvedDir && !resolvedFile.startsWith(resolvedDir + path.sep)) {
    return null; // refuse paths that escape the spec directory
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');

    // JSON files
    if (filePath.endsWith('.json')) {
      const data = JSON.parse(content);
      if (data === null || typeof data !== 'object') return null;
      if (!Object.prototype.hasOwnProperty.call(data, parsed.param)) return null;
      const val = data[parsed.param];
      return val !== undefined ? val : null;
    }

    // CFG files (TLA+ config format: key = value)
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('\\*') || trimmed.startsWith('SPECIFICATION') ||
          trimmed.startsWith('CONSTANTS') || trimmed.startsWith('SYMMETRY') ||
          trimmed.startsWith('INVARIANT') || trimmed.startsWith('PROPERTY') ||
          trimmed.startsWith('CHECK_DEADLOCK')) {
        continue;
      }
      // Match key = value patterns
      const match = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
      if (match && match[1] === parsed.param) {
        const rawVal = match[2].trim();
        // Try to parse as number
        const num = Number(rawVal);
        if (!isNaN(num) && rawVal !== '') return num;
        // Return as string
        return rawVal;
      }
    }

    return null; // Param not found in file
  } catch {
    // Fail-open: file not found, parse error, etc.
    return null;
  }
}

module.exports = { extractFormalExpected, parseFormalRef };

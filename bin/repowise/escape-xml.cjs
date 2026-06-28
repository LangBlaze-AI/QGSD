#!/usr/bin/env node
'use strict';
// bin/repowise/escape-xml.cjs — XML character escaping for Repowise context packing

/**
 * Escape XML-special characters in a string.
 *
 * Replacement order is critical: `&` must be replaced FIRST
 * to prevent double-encoding (e.g., `&lt;` must not become `&amp;lt;`).
 *
 * @param {string} str - Input string to escape
 * @returns {string} Escaped string safe for XML content, or '' for non-string inputs
 */
function escapeXml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Strip control chars illegal in XML 1.0 (keep \t \n \r)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

module.exports = { escapeXml };

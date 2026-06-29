#!/usr/bin/env node
'use strict';
// bin/repowise/pack-file.cjs — Pack file contents into XML <file> tags for LLM context delivery

const path = require('path');
const { escapeXml } = require('./escape-xml.cjs');

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

/**
 * Map of file extensions to language identifiers.
 * Used by detectLang() to auto-populate the `lang` attribute.
 */
const LANG_MAP = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js',
  '.ts': 'ts', '.tsx': 'tsx', '.jsx': 'jsx',
  '.py': 'py', '.rb': 'rb', '.go': 'go',
  '.rs': 'rs', '.java': 'java', '.kt': 'kotlin',
  '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
  '.cs': 'cs', '.php': 'php', '.swift': 'swift',
  '.sh': 'sh', '.bash': 'sh', '.zsh': 'sh',
  '.yml': 'yaml', '.yaml': 'yaml',
  '.json': 'json', '.xml': 'xml', '.html': 'html', '.css': 'css',
  '.md': 'markdown', '.sql': 'sql',
  '.tla': 'tla', '.als': 'alloy', '.pml': 'prism',
};

/**
 * Detect language from a file path's extension.
 *
 * @param {string} filePath - File path (relative or absolute)
 * @returns {string|null} Language identifier or null if unknown
 */
function detectLang(filePath) {
  if (typeof filePath !== 'string') return null;
  const ext = path.extname(filePath);
  return LANG_MAP[ext] || null;
}

// ---------------------------------------------------------------------------
// Pack file into XML <file> tag
// ---------------------------------------------------------------------------

/**
 * Pack file contents into a well-formed XML <file> tag.
 *
 * Produces: `<file path="..." lang="...">escaped_content</file>`
 * When `lang` resolves to null (unknown extension), the lang attribute is omitted:
 * `<file path="...">escaped_content</file>`
 *
 * @param {Object} opts
 * @param {string} opts.filePath - Relative file path (used in path attribute)
 * @param {string} opts.content - File content to wrap (will be XML-escaped)
 * @param {string} [opts.lang] - Optional language override; auto-detected if omitted
 * @returns {string} Well-formed XML <file> tag string
 */
function packFile({ filePath, content, lang } = {}) {
  const detectedLang = lang !== undefined ? lang : detectLang(filePath);
  const escapedContent = escapeXml(content);
  const escapedPath = escapeXml(filePath);
  if (detectedLang !== null) {
    return `<file path="${escapedPath}" lang="${escapeXml(detectedLang)}">${escapedContent}</file>`;
  }
  return `<file path="${escapedPath}">${escapedContent}</file>`;
}

module.exports = { packFile, detectLang, LANG_MAP };

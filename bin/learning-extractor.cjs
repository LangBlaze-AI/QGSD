#!/usr/bin/env node
'use strict';

const fs = require('fs');

/**
 * Error indicators for detecting errors in transcript content.
 */
const ERROR_INDICATORS = [
  'Error:',
  'ENOENT',
  'EACCES',
  'EPERM',
  'TypeError',
  'ReferenceError',
  'SyntaxError',
];

const STACK_TRACE_PATTERN = /at .+\(/;

/**
 * Correction indicator patterns. A user message must match 2+ of these
 * to be considered a correction (conservative, low false-positive).
 */
const CORRECTION_INDICATORS = [
  /\bdon'?t\b/i,
  /\binstead\b/i,
  /\bwrong\b/i,
  /\bshould\b/i,
  /\bactually\b/i,
  /\bnot\b/i,
  /\bprefer\b/i,
  /\bover\b/i,
  /\bnot like that\b/i,
  /\binstead of\b/i,
  /\bI said\b/i,
  /\bthat's not\b/i,
  /\buse\s+\w+\s+not\b/i,
];

/**
 * Extracts text content from a transcript entry's message.
 * Handles both string and array content formats.
 */
function extractTextFromEntry(entry) {
  if (!entry || !entry.message || !entry.message.content) return '';
  const content = entry.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textBlock = content.find(b => b && b.type === 'text');
    return textBlock ? (textBlock.text || '') : '';
  }
  return '';
}

/**
 * Checks if a tool_result block or its content indicates an error.
 */
function isErrorBlock(block) {
  if (block.is_error === true) return true;
  if (block.type === 'tool_error') return true;
  const contentStr = typeof block.content === 'string'
    ? block.content
    : JSON.stringify(block.content || '');
  for (const indicator of ERROR_INDICATORS) {
    if (contentStr.includes(indicator)) return true;
  }
  if (STACK_TRACE_PATTERN.test(contentStr)) return true;
  return false;
}

/**
 * Extracts the symptom text from an error block (first 200 chars).
 * Returns null if content is too long (>500 chars) or lacks ERROR_INDICATORS or stack trace.
 */
function extractSymptom(block) {
  const content = typeof block.content === 'string'
    ? block.content
    : JSON.stringify(block.content || '');

  // Filter: reject if too long (likely file dump)
  if (content.length > 500) {
    return null;
  }

  // Filter: must contain at least one ERROR_INDICATOR keyword or stack trace pattern
  let hasIndicator = false;
  for (const indicator of ERROR_INDICATORS) {
    if (content.includes(indicator)) {
      hasIndicator = true;
      break;
    }
  }
  if (!hasIndicator && !STACK_TRACE_PATTERN.test(content)) {
    return null;
  }

  return content.slice(0, 200);
}

/**
 * Looks forward from position i to find a resolution within 20 lines.
 * Resolution: a non-error tool_result for the same tool, or an assistant
 * message containing fix-related keywords.
 * Filters out file-read patterns, JSON blobs, and content > 500 chars.
 */
function findResolution(entries, i) {
  const FIX_KEYWORDS = /\b(fixed|resolved|solution|the issue was)\b/i;
  const FILE_READ_PATTERN = /^\s+\d+[→|]/; // line-number prefix pattern
  const limit = Math.min(entries.length, i + 21);

  for (let j = i + 1; j < limit; j++) {
    const entry = entries[j];
    if (!entry) continue;

    // Check for successful tool_result (user entry with non-error tool_result)
    if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        if (block && block.type === 'tool_result' && !block.is_error && block.type !== 'tool_error') {
          const contentStr = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content || '');

          // Filter: reject if too long
          if (contentStr.length > 500) continue;

          // Filter: reject if looks like file-read output
          if (FILE_READ_PATTERN.test(contentStr)) continue;

          // Filter: reject if looks like JSON array
          if (contentStr.trim().startsWith('[{')) continue;

          // Make sure it's not another error
          let isErr = false;
          for (const indicator of ERROR_INDICATORS) {
            if (contentStr.includes(indicator)) { isErr = true; break; }
          }
          if (!isErr) {
            return contentStr.slice(0, 200);
          }
        }
      }
    }

    // Check for assistant explanation containing fix keywords
    if (entry.type === 'assistant') {
      const text = extractTextFromEntry(entry);

      // Filter: reject if text > 500 chars before fix keyword match
      if (text.length > 500) continue;

      if (FIX_KEYWORDS.test(text)) {
        return text.slice(0, 200);
      }
    }
  }
  return null;
}

/**
 * Extracts error-resolution patterns from transcript JSONL lines.
 *
 * @param {string[]} lines - Raw JSONL strings from transcript
 * @param {number} maxPatterns - Maximum patterns to extract (default 10)
 * @returns {Array<{type: string, symptom: string, root_cause: string, fix: string, tags: string[], ts: string}>}
 */
function extractErrorPatterns(lines, maxPatterns = 10) {
  const patterns = [];

  // Parse all lines upfront
  const entries = lines.map(line => {
    try { return JSON.parse(line); } catch { return null; }
  });

  for (let i = 0; i < entries.length && patterns.length < maxPatterns; i++) {
    const entry = entries[i];
    if (!entry || entry.type !== 'user') continue;

    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || block.type !== 'tool_result') continue;
      if (!isErrorBlock(block)) continue;

      const symptom = extractSymptom(block);
      const fix = findResolution(entries, i);

      if (symptom !== null && fix) {
        patterns.push({
          type: 'error_resolution',
          symptom,
          root_cause: '',
          fix,
          tags: [],
          ts: new Date().toISOString(),
        });
        if (patterns.length >= maxPatterns) break;
      }
    }
  }

  return patterns;
}

/**
 * Extracts user corrections from transcript JSONL lines.
 * Only scans last 200 lines. Requires 2+ correction indicators.
 *
 * @param {string[]} lines - Raw JSONL strings from transcript
 * @param {number} maxCorrections - Maximum corrections to extract (default 5)
 * @returns {Array<{type: string, wrong_approach: string, correct_approach: string, context: string, tags: string[], ts: string}>}
 */
function extractCorrections(lines, maxCorrections = 5) {
  const corrections = [];

  // Only scan last 200 lines
  const scanLines = lines.slice(-200);
  const entries = scanLines.map(line => {
    try { return JSON.parse(line); } catch { return null; }
  });

  for (let i = 1; i < entries.length && corrections.length < maxCorrections; i++) {
    const entry = entries[i];
    const prevEntry = entries[i - 1];

    if (!entry || !prevEntry) continue;
    if (entry.type !== 'user' || prevEntry.type !== 'assistant') continue;

    const userText = extractTextFromEntry(entry);
    if (!userText || userText.length <= 20) continue;

    // Count how many correction indicators match
    let matchCount = 0;
    for (const pattern of CORRECTION_INDICATORS) {
      if (pattern.test(userText)) matchCount++;
    }
    if (matchCount < 2) continue;

    const assistantText = extractTextFromEntry(prevEntry);
    const assistantSummary = assistantText.slice(0, 150);
    const userMessage = userText.slice(0, 200);

    corrections.push({
      type: 'correction',
      wrong_approach: assistantSummary,
      correct_approach: userMessage,
      context: '',
      tags: [],
      ts: new Date().toISOString(),
    });
  }

  return corrections;
}

/**
 * Reads last N non-empty lines from a file.
 *
 * @param {string} filePath - Path to the file
 * @param {number} n - Number of lines to read
 * @returns {string[]} Array of line strings
 */
function readLastLines(filePath, n) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

module.exports = {
  extractErrorPatterns,
  extractCorrections,
  readLastLines,
  extractTextFromEntry,
};

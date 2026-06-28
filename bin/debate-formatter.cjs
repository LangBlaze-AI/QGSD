'use strict';

const fs = require('fs');

/**
 * Extract YAML frontmatter from markdown content.
 * Returns parsed object or null if no frontmatter found.
 */
function extractFrontmatter(content) {
  if (typeof content !== 'string') return null;

  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const raw = match[1];
  const result = {};

  for (const line of raw.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    if (!key) continue;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;

    // Handle array values: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      if (inner === '') {
        result[key] = [];
      } else {
        result[key] = inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
      }
      continue;
    }

    // Handle quoted string values
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      result[key] = value.slice(1, -1);
      continue;
    }

    // Handle numeric values
    if (/^\d+$/.test(value)) {
      result[key] = parseInt(value, 10);
      continue;
    }

    // Pass through as string
    result[key] = value;
  }

  return result;
}

/**
 * Validate a debate file's content.
 * Returns { valid: true, frontmatter } or { valid: false, errors: [...] }.
 */
function validateDebate(content) {
  const frontmatter = extractFrontmatter(content);

  if (!frontmatter) {
    return { valid: false, errors: ['No YAML frontmatter found'] };
  }

  const errors = [];

  if (!frontmatter.date) {
    errors.push('Missing required field: date');
  }

  if (!frontmatter.question) {
    errors.push('Missing required field: question');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const warnings = [];
  const optionalFields = ['slot', 'round', 'verdict', 'mode', 'matched_requirement_ids', 'artifact_path'];
  for (const field of optionalFields) {
    if (frontmatter[field] === undefined) {
      warnings.push(`Optional field missing: ${field}`);
    }
  }

  return { valid: true, frontmatter, warnings };
}

// CLI mode
if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    process.stderr.write('Usage: debate-formatter.cjs <file>\n');
    process.exit(1);
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const result = validateDebate(content);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.valid ? 0 : 1);
  } catch (e) {
    process.stderr.write('Error reading file: ' + e.message + '\n');
    process.exit(1);
  }
}

module.exports = { extractFrontmatter, validateDebate };

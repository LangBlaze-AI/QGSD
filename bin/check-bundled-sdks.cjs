#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Forbidden SDK list — LLM SDKs that nForma must not bundle (ARCH-10)
// ---------------------------------------------------------------------------

const FORBIDDEN_SDKS = [
  '@anthropic-ai/sdk',
  'anthropic',
  'openai',
  '@google/generative-ai',
  'google-generativeai',
  'cohere-ai',
  '@azure/openai',
];

// ---------------------------------------------------------------------------
// Import pattern builder
// ---------------------------------------------------------------------------

function buildImportPatterns() {
  return FORBIDDEN_SDKS.map(sdk => {
    // Escape special regex chars in SDK name (@ and /)
    const escaped = sdk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
      sdk,
      patterns: [
        // CommonJS require
        new RegExp(`require\\s*\\(\\s*['"\`]${escaped}['"\`]\\s*\\)`),
        // require.resolve
        new RegExp(`require\\.resolve\\s*\\(\\s*['"\`]${escaped}['"\`]\\s*\\)`),
        // ESM import
        new RegExp(`import\\s+.*\\s+from\\s+['"]${escaped}['"]`),
        // ESM dynamic import()
        new RegExp(`import\\s*\\(\\s*['"]${escaped}['"]\\s*\\)`),
        // ESM side-effect import
        new RegExp(`import\\s+['"]${escaped}['"]`),
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// Scope filtering
// ---------------------------------------------------------------------------

function isInScope(filePath) {
  if (typeof filePath !== 'string') return false;
  const normalized = filePath.replace(/\\/g, '/');

  // Must be under bin/ or hooks/
  const inScope = normalized.startsWith('bin/') || normalized.startsWith('hooks/') ||
    normalized.includes('/bin/') || normalized.includes('/hooks/');
  if (!inScope) return false;

  // Must have .js, .cjs, or .mjs extension
  if (!/\.(js|cjs|mjs)$/.test(normalized)) return false;

  // Exclude test files
  if (/\.test\.(js|cjs|mjs)$/.test(normalized)) return false;

  // Exclude node_modules, docs, examples, .planning/formal
  if (/node_modules|\/docs\/|\/examples\/|\.planning\/formal/.test(normalized)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Line-level scanning
// ---------------------------------------------------------------------------

function scanFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    // Fail-open on read errors
    return [];
  }

  const lines = content.split('\n');
  const importPatterns = buildImportPatterns();
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Skip single-line comments
    if (trimmed.startsWith('//')) continue;

    for (const { sdk, patterns } of importPatterns) {
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          violations.push({
            file: filePath,
            line: i + 1,
            content: line.trim(),
            sdk,
            violation: 'SDK_IMPORT',
          });
        }
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

function getAllSourceFiles(dir) {
  const results = [];
  const skipDirs = new Set(['node_modules', '.git', 'dist', '.formal']);

  function walk(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          walk(path.join(currentDir, entry.name));
        }
      } else if (entry.isFile() && /\.(js|cjs|mjs)$/.test(entry.name)) {
        results.push(path.join(currentDir, entry.name));
      }
    }
  }

  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log('[LINT] Architecture: SDK Bundling Check');

  const allFiles = getAllSourceFiles('.');
  const scopedFiles = allFiles
    .map(f => f.startsWith('./') ? f.slice(2) : f)
    .filter(isInScope);

  console.log(`Scanned ${scopedFiles.length} files`);

  const allViolations = [];
  for (const file of scopedFiles) {
    const violations = scanFile(file);
    allViolations.push(...violations);
  }

  console.log(`Found ${allViolations.length} violations`);

  for (const v of allViolations) {
    console.log(`  ERROR: ${v.file}:${v.line}: ${v.content}`);
  }

  process.exit(allViolations.length > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Exports + CLI entry
// ---------------------------------------------------------------------------

module.exports = { FORBIDDEN_SDKS, buildImportPatterns, isInScope, scanFile, getAllSourceFiles };

if (require.main === module) {
  main();
}

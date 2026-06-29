#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const SPEC_DIR = path.join(ROOT, '.planning', 'formal', 'spec');

function printHelp() {
  console.log(`Usage: node bin/formal-coverage-intersect.cjs --files file1,file2,... [options]

Detects whether changed files overlap with any formal spec module's source_files.

Options:
  --files file1,file2   Comma-separated changed file paths (relative to project root) — required
  --help                Show this help message

Exit codes:
  0  Intersections found (formally-covered code was touched)
  1  Error (bad arguments, etc.)
  2  No intersections found (safe — no formal models affected)

Output: JSON with matched modules and intersection details.

Examples:
  node bin/formal-coverage-intersect.cjs --files "hooks/nf-stop.js,bin/run-quorum.cjs"
  node bin/formal-coverage-intersect.cjs --files "src/app.js"
`);
}

function parseArgs(argv) {
  const args = { files: [], help: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') {
      args.help = true;
    } else if (argv[i] === '--files' && argv[i + 1]) {
      args.files = argv[++i].split(',').map(f => f.trim()).filter(Boolean);
    }
  }
  return args;
}

/**
 * Convert a simple glob pattern to a RegExp.
 * Reuses the same algorithm as formal-scope-scan.cjs Layer 1.
 */
function globToRegex(glob) {
  let regex = '';
  let i = 0;
  while (i < glob.length) {
    if (glob[i] === '*' && glob[i + 1] === '*') {
      regex += '.*';
      i += 2;
      if (glob[i] === '/') i++;
    } else if (glob[i] === '*') {
      regex += '[^/]*';
      i++;
    } else if (glob[i] === '?') {
      regex += '[^/]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(glob[i])) {
      regex += '\\' + glob[i];
      i++;
    } else {
      regex += glob[i];
      i++;
    }
  }
  return new RegExp('^' + regex + '$');
}

/**
 * Check if any provided file matches any of the module's source_files globs.
 * Returns array of matched file paths.
 */
function findMatchingFiles(providedFiles, moduleSourceFiles) {
  const matched = [];
  for (const pf of providedFiles) {
    for (const sf of moduleSourceFiles) {
      try {
        const re = globToRegex(sf);
        if (re.test(pf)) {
          matched.push(pf);
          break; // file matched, no need to check more globs for this file
        }
      } catch {
        // Invalid glob — skip silently (fail-open)
        continue;
      }
    }
  }
  return matched;
}

// Scan all spec module scope.json files and find intersections with changed files.
function findIntersections(changedFiles, specDir) {
  const modules = [];

  if (!fs.existsSync(specDir)) {
    return { intersections_found: false, modules: [], total_modules_affected: 0 };
  }

  let entries;
  try {
    entries = fs.readdirSync(specDir, { withFileTypes: true });
  } catch {
    return { intersections_found: false, modules: [], total_modules_affected: 0 };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const scopePath = path.join(specDir, entry.name, 'scope.json');
    if (!fs.existsSync(scopePath)) continue;

    let scope;
    try {
      scope = JSON.parse(fs.readFileSync(scopePath, 'utf8'));
    } catch {
      // Parse error — skip this module (fail-open)
      continue;
    }

    if (!scope || typeof scope !== 'object' || Array.isArray(scope) ||
        !scope.source_files || !Array.isArray(scope.source_files) || scope.source_files.length === 0) {
      continue;
    }

    const matchedFiles = findMatchingFiles(changedFiles, scope.source_files);
    if (matchedFiles.length > 0) {
      modules.push({
        name: entry.name,
        scope_path: path.relative(ROOT, scopePath),
        matched_files: matchedFiles
      });
    }
  }

  return {
    intersections_found: modules.length > 0,
    modules,
    total_modules_affected: modules.length
  };
}

// --- Main ---

const args = parseArgs(process.argv);

if (args.help) {
  printHelp();
  process.exit(0);
}

if (args.files.length === 0) {
  console.error('Error: --files is required. Provide comma-separated file paths.');
  console.error('Usage: node bin/formal-coverage-intersect.cjs --files file1,file2,...');
  process.exit(1);
}

const result = findIntersections(args.files, SPEC_DIR);
console.log(JSON.stringify(result, null, 2));

if (result.intersections_found) {
  process.exit(0);
} else {
  process.exit(2);
}

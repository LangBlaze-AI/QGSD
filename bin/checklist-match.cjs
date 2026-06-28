#!/usr/bin/env node
'use strict';
// bin/checklist-match.cjs
// Resolves matching checklists from file patterns, keywords, and task types
// using the checklist registry at core/references/checklist-registry.json.

const path = require('path');
const fs = require('fs');

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports: ** (any path segments), * (single segment chars), literal matches.
 * No brace expansion needed for the patterns used in the registry.
 */
function globToRegex(glob) {
  let regex = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      // ** matches any path (including slashes)
      regex += '.*';
      i += 2;
      // Skip trailing slash after **
      if (glob[i] === '/') i++;
    } else if (ch === '*') {
      // * matches anything except /
      regex += '[^/]*';
      i++;
    } else if (ch === '?') {
      regex += '[^/]';
      i++;
    } else if (ch === '.') {
      regex += '\\.';
      i++;
    } else {
      regex += ch;
      i++;
    }
  }
  return new RegExp('^' + regex + '$');
}

/**
 * Check if a file path matches a glob pattern.
 */
function matchGlob(filePath, pattern) {
  const re = globToRegex(pattern);
  return re.test(filePath);
}

/**
 * Load the checklist registry from installed path or CWD fallback.
 */
function loadRegistry(registryPath) {
  if (registryPath) {
    return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  }

  // Try installed path first
  const installedPath = path.join(
    process.env.HOME || '',
    '.claude', 'nf', 'references', 'checklist-registry.json'
  );
  if (fs.existsSync(installedPath)) {
    return JSON.parse(fs.readFileSync(installedPath, 'utf8'));
  }

  // Fallback to repo-relative path
  const repoPath = path.join(__dirname, '..', 'core', 'references', 'checklist-registry.json');
  if (fs.existsSync(repoPath)) {
    return JSON.parse(fs.readFileSync(repoPath, 'utf8'));
  }

  throw new Error('checklist-registry.json not found');
}

/**
 * Match checklists against provided files, description, and task type.
 * @param {Object} opts
 * @param {string[]} [opts.files] - Changed file paths
 * @param {string} [opts.description] - Task description for keyword matching
 * @param {string} [opts.taskType] - Task type for exact matching
 * @param {string} [opts.registryPath] - Override path to registry JSON
 * @returns {Array<{id: string, file: string}>} Matching checklists
 */
function matchChecklists({ files = [], description = '', taskType = '', registryPath } = {}) {
  const registry = loadRegistry(registryPath);
  const descLower = typeof description === 'string' ? description.toLowerCase() : '';
  const matches = [];

  const checklists = Array.isArray(registry && registry.checklists) ? registry.checklists : [];
  for (const checklist of checklists) {
    const triggers = (checklist && checklist.triggers) || {};
    let matched = false;

    // Check file_patterns
    if (!matched && files.length > 0 && triggers.file_patterns && triggers.file_patterns.length > 0) {
      for (const filePath of files) {
        for (const pattern of triggers.file_patterns) {
          if (matchGlob(filePath, pattern)) {
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
    }

    // Check keywords
    if (!matched && descLower && triggers.keywords && triggers.keywords.length > 0) {
      for (const keyword of triggers.keywords) {
        if (descLower.includes(keyword.toLowerCase())) {
          matched = true;
          break;
        }
      }
    }

    // Check task_types
    if (!matched && taskType && triggers.task_types && triggers.task_types.length > 0) {
      if (triggers.task_types.includes(taskType)) {
        matched = true;
      }
    }

    if (matched) {
      matches.push({ id: checklist.id, file: checklist.file });
    }
  }

  return matches;
}

function printHelp() {
  console.log(`Usage: checklist-match.cjs [options]

Resolve matching checklists from file patterns, keywords, and task types.

Options:
  --files "f1,f2,..."     Comma-separated changed file paths
  --description "text"    Task description for keyword matching
  --task-type "type"      Task type (e.g., bug_fix, feature, refactor)
  --help                  Show this help message

Output:
  JSON array of {id, file} for matching checklists.
  Exit 0 if matches found, exit 1 if no matches.

Examples:
  node checklist-match.cjs --files "hooks/nf-stop.js" --description "auth fix"
  node checklist-match.cjs --files "test/foo.test.js" --task-type "bug_fix"
  node checklist-match.cjs --description "optimize cache performance"`);
}

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  let files = [];
  let description = '';
  let taskType = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--files' && args[i + 1]) {
      files = args[i + 1].split(',').map(f => f.trim()).filter(Boolean);
      i++;
    } else if (args[i] === '--description' && args[i + 1]) {
      description = args[i + 1];
      i++;
    } else if (args[i] === '--task-type' && args[i + 1]) {
      taskType = args[i + 1];
      i++;
    }
  }

  const matches = matchChecklists({ files, description, taskType });
  console.log(JSON.stringify(matches));
  process.exit(matches.length > 0 ? 0 : 1);
}

module.exports = { matchChecklists, globToRegex, matchGlob };

#!/usr/bin/env node
// hooks/nf-scope-guard.js
// PreToolUse hook -- warns when Edit, Write, or MultiEdit tool calls target
// files outside the scope declared in .claude/scope-contract.json (per branch).
// Warn-only: never blocks tool calls. Exits 0 always.
//
// Follows fail-open pattern: try/catch wrapping entire main, exit(0) on any error.
// Hook stdout is the decision channel -- debug output goes to stderr only.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig, shouldRunHook, validateHookInput } = require('./config-loader');

// Returns git root directory or null if not a git repo
function getGitRoot(cwd) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0 || result.error) return null;
  return result.stdout.trim() || null;
}

// Returns current branch name or null if not on a branch (e.g., detached HEAD)
function getCurrentBranch(cwd) {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0 || result.error) {
    return null; // Not a git repo or error
  }
  const branch = (result.stdout || '').trim();
  // Return null for detached HEAD state (when result is "HEAD")
  if (!branch || branch === 'HEAD') {
    return null;
  }
  return branch;
}

// Reads scope contract from .claude/scope-contract.json
// Returns null if file missing, unreadable, or malformed JSON (fail-open)
function readScopeContract(gitRoot) {
  const contractPath = path.join(gitRoot, '.claude', 'scope-contract.json');
  if (!fs.existsSync(contractPath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(contractPath, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    // Malformed JSON or read error — fail-open
    return null;
  }
}

// Extracts target file path from tool input
// Handles Edit, Write, and MultiEdit tools
function extractTargetPath(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') {
    return null;
  }

  // Edit and Write both use file_path
  if (toolInput.file_path) {
    return toolInput.file_path;
  }

  // MultiEdit uses files (array of {file_path, action, ...})
  if (toolInput.files && Array.isArray(toolInput.files) && toolInput.files.length > 0) {
    const first = toolInput.files[0];
    if (first && first.file_path) {
      return first.file_path;
    }
  }

  return null;
}

// Checks if a file path is in scope based on branch entry from scope contract
// branchEntry is the contract entry for the current branch
// Returns true if file is in scope or if no branchEntry (no restriction)
function isFileInScope(targetPath, branchEntry) {
  // If no branch entry, all paths are in scope
  if (!branchEntry || typeof branchEntry !== 'object') {
    return true;
  }

  // Extract out_of_scope patterns from branch entry
  const outOfScope = branchEntry.out_of_scope;
  if (!outOfScope || !Array.isArray(outOfScope) || outOfScope.length === 0) {
    // No out_of_scope patterns means all paths are in scope
    return true;
  }

  // Non-string target path cannot be evaluated -- fail-open (treat as in scope)
  if (typeof targetPath !== 'string') {
    return true;
  }

  // Normalize paths: remove trailing slashes for comparison
  const normalized = targetPath.replace(/\/$/, '');

  // Match on a path-segment boundary, not a bare string prefix, so 'bin'
  // does NOT match 'binutils/...'.
  for (const pattern of outOfScope) {
    const normalizedPattern = String(pattern).replace(/\/$/, '');
    if (normalizedPattern === '') continue;
    if (normalized === normalizedPattern || normalized.startsWith(normalizedPattern + '/')) {
      // It's in the out_of_scope list, so it's OUT of scope
      return false;
    }
  }

  // Not in any out_of_scope pattern, so it's in scope
  return true;
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      if (!raw || raw.trim() === '') {
        process.exit(0); // fail-open: empty stdin
      }

      const input = JSON.parse(raw);

      // Validate hook input
      const eventType = input.hook_event_name || input.hookEventName || 'PreToolUse';
      const validation = validateHookInput(eventType, input);
      if (!validation.valid) {
        process.stderr.write('[nf] WARNING: nf-scope-guard: invalid input: ' + JSON.stringify(validation.errors) + '\n');
        process.exit(0); // fail-open
      }

      const cwd = input.cwd || process.cwd();
      const gitRoot = getGitRoot(cwd);
      if (!gitRoot) {
        process.exit(0); // not a git repo
      }

      // Profile guard
      const config = loadConfig(gitRoot);
      const profile = config.hook_profile || 'standard';
      if (!shouldRunHook('nf-scope-guard', profile)) {
        process.exit(0);
      }

      // Only act on Edit, Write, MultiEdit tools
      const toolName = input.tool_name || input.toolName || '';
      if (!['Edit', 'Write', 'MultiEdit'].includes(toolName)) {
        process.exit(0);
      }

      // Extract target file path
      const targetPath = extractTargetPath(input.tool_input);
      if (!targetPath) {
        process.exit(0);
      }

      // Get current branch
      const branch = getCurrentBranch(cwd);
      if (!branch) {
        process.exit(0); // No branch (detached HEAD) = no-op
      }

      // Read scope contract
      const scopeContract = readScopeContract(gitRoot);
      if (!scopeContract) {
        process.exit(0); // No contract = no-op (SCOPE-03)
      }

      // Get entry for this branch
      const branchEntry = scopeContract[branch];
      if (!branchEntry) {
        process.exit(0); // No entry for this branch = no-op
      }

      // Check if target file is in scope
      const inScope = isFileInScope(targetPath, branchEntry);

      if (!inScope) {
        // Build warning text
        const outOfScopeItems = branchEntry.out_of_scope || [];
        const warningText =
          `[nf-scope-guard] WARNING: Editing '${targetPath}' is outside declared scope. ` +
          `Out-of-scope items: ${JSON.stringify(outOfScopeItems)}. ` +
          `Task approach: "${branchEntry.approach || 'unknown'}". ` +
          `Consider: is this edit within the task's intended scope?`;

        // Surface via additionalContext if nForma active (current-activity.json exists)
        const activityFile = path.join(gitRoot, '.planning', 'current-activity.json');
        if (fs.existsSync(activityFile)) {
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              additionalContext: warningText,
            },
          }));
        } else {
          process.stderr.write(warningText + '\n');
        }
      }

      // Always exit 0 (warn-only, never block) — SCOPE-02
      process.exit(0);
    } catch (e) {
      if (e instanceof SyntaxError) {
        process.stderr.write('[nf] WARNING: nf-scope-guard: malformed JSON: ' + e.message + '\n');
      }
      process.exit(0); // fail-open on any error
    }
  });
}

if (require.main === module) main();
module.exports = { getGitRoot, getCurrentBranch, readScopeContract, isFileInScope, extractTargetPath };

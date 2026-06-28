#!/usr/bin/env node
// hooks/nf-destructive-git-guard.js
// PreToolUse hook -- detects destructive git commands and warns via stderr
// when uncommitted changes exist. Warn-only: never blocks tool calls.
//
// Follows fail-open pattern: try/catch wrapping entire main, exit(0) on any error.
// Hook stdout is the decision channel -- debug output goes to stderr only.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig, shouldRunHook, validateHookInput } = require('./config-loader');

// Destructive git command patterns
const DESTRUCTIVE_BLANKET_REGEX = /^\s*git\s+(stash|reset\s+--hard|clean\s+-f)/;
const DESTRUCTIVE_CHECKOUT_DOT_REGEX = /^\s*git\s+checkout\s+--\s+\./;
const DESTRUCTIVE_CHECKOUT_FILE_REGEX = /^\s*git\s+checkout\s+--\s+\S/;

// Detects a destructive git op anywhere in a compound/chained shell command.
function isDestructiveCommand(command) {
  if (typeof command !== 'string') return false;
  const segments = command.split(/(?:&&|\|\||[;|\n])/);
  return segments.some(seg =>
    DESTRUCTIVE_BLANKET_REGEX.test(seg) ||
    DESTRUCTIVE_CHECKOUT_DOT_REGEX.test(seg) ||
    DESTRUCTIVE_CHECKOUT_FILE_REGEX.test(seg)
  );
}

// Returns git root directory or null if not a git repo
function getGitRoot(cwd) {
  if (cwd != null && typeof cwd !== 'string') return null; // invalid cwd -> treat as non-repo
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0 || result.error) return null;
  return result.stdout.trim() || null;
}

// Returns true if there are uncommitted changes (staged or unstaged)
function hasUncommittedChanges(cwd) {
  if (cwd != null && typeof cwd !== 'string') return false; // invalid cwd -> fail-open
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0 || result.error) return false; // fail-open
  return (result.stdout || '').trim().length > 0;
}

// Extracts a human-readable label from the command for the warning message
function getCommandLabel(command) {
  if (DESTRUCTIVE_BLANKET_REGEX.test(command)) {
    const match = command.match(/git\s+(\S+)/);
    return match ? `git ${match[1]}` : 'destructive git operation';
  }
  if (DESTRUCTIVE_CHECKOUT_DOT_REGEX.test(command) || DESTRUCTIVE_CHECKOUT_FILE_REGEX.test(command)) {
    return 'git checkout --';
  }
  return 'destructive git operation';
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
        process.stderr.write('[nf] WARNING: nf-destructive-git-guard: invalid input: ' + JSON.stringify(validation.errors) + '\n');
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
      if (!shouldRunHook('nf-destructive-git-guard', profile)) {
        process.exit(0);
      }

      // Only act on Bash tool calls
      const toolName = input.tool_name || input.toolName || '';
      if (toolName.toLowerCase() !== 'bash') {
        process.exit(0);
      }

      // Extract command
      const command = (input.tool_input && input.tool_input.command) || '';
      if (!command) {
        process.exit(0);
      }

      // Check if the command is a destructive git operation
      const isDestructive = isDestructiveCommand(command);

      if (!isDestructive) {
        process.exit(0);
      }

      // Check for uncommitted changes
      if (!hasUncommittedChanges(cwd)) {
        process.exit(0); // clean tree, operation is safe
      }

      // Emit warning — use additionalContext when nForma is active, stderr-only otherwise
      const label = getCommandLabel(command);
      const warningText =
        `[nf-safety] WARNING: Destructive git operation detected ('${label}') with uncommitted changes. ` +
        `Consider committing first to avoid losing completed work.`;

      const activityFile = path.join(gitRoot, '.planning', 'current-activity.json');
      if (fs.existsSync(activityFile)) {
        // nForma active: surface warning via additionalContext so Claude sees it
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: warningText,
          },
        }));
      } else {
        // Non-nForma context: stderr-only (original behavior)
        process.stderr.write(warningText + '\n');
      }

      // Do NOT block -- always allow the tool call through (warn-only)
      process.exit(0);
    } catch (e) {
      if (e instanceof SyntaxError) {
        process.stderr.write('[nf] WARNING: nf-destructive-git-guard: malformed JSON on stdin: ' + e.message + '\n');
      }
      process.exit(0); // fail-open on any error
    }
  });
}

if (require.main === module) main();

module.exports = { getGitRoot, hasUncommittedChanges, getCommandLabel };

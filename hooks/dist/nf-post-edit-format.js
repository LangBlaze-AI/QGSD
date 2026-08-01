'use strict';
// hooks/nf-post-edit-format.js
// PostToolUse hook: auto-formats JS/TS files after Edit operations.
// Optionally runs a verify command after formatting (when post_edit_verify_enabled).
//
// Detects prettier or biome in node_modules/.bin/ and runs the formatter
// with --write on the edited file. Fails open in all cases.
//
// Input (stdin): Claude Code PostToolUse JSON payload
//   { tool_name, tool_input: { file_path }, tool_response, cwd, context_window }
//
// Output (stdout): JSON { hookSpecificOutput: { hookEventName, additionalContext } }
//   OR: no output (exit 0) when the hook is a no-op.
//
// Fail-open: exits 0 in ALL cases — never blocks the Edit tool.

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { loadConfig, shouldRunHook, validateHookInput } = require('./config-loader');

const JS_TS_RE = /\.(js|ts|cjs|mjs|jsx|tsx)$/;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const _eventType = input.hook_event_name || input.hookEventName || 'PostToolUse';
    const _validation = validateHookInput(_eventType, input);
    if (!_validation.valid) {
      process.stderr.write('[nf] WARNING: nf-post-edit-format: invalid input: ' + JSON.stringify(_validation.errors) + '\n');
      process.exit(0); // Fail-open
    }

    // Profile guard — exit early if this hook is not active for the current profile
    const config = loadConfig(input.cwd || process.cwd());
    const profile = config.hook_profile || 'standard';
    if (!shouldRunHook('nf-post-edit-format', profile)) {
      process.exit(0);
    }

    // Only act on Edit tool calls
    if (input.tool_name !== 'Edit') {
      process.exit(0);
    }

    // Extract file path from tool input
    const filePath = (input.tool_input && input.tool_input.file_path) || '';
    if (!JS_TS_RE.test(filePath)) {
      process.exit(0); // Not a JS/TS file — no-op
    }

    // Collect additionalContext messages to emit at end
    const contextMessages = [];

    // Auto-detect formatter in project's node_modules
    const cwd = input.cwd || process.cwd();
    const prettierBin = path.join(cwd, 'node_modules', '.bin', 'prettier');
    const biomeBin = path.join(cwd, 'node_modules', '.bin', 'biome');

    let formatterFound = true;
    let formatter = null;
    let args = [];

    if (fs.existsSync(prettierBin)) {
      formatter = prettierBin;
      args = ['--write', filePath];
    } else if (fs.existsSync(biomeBin)) {
      formatter = biomeBin;
      args = ['format', '--write', filePath];
    } else {
      formatterFound = false;
    }

    if (formatterFound) {
      const result = spawnSync(formatter, args, {
        encoding: 'utf8',
        cwd: cwd,
        timeout: 10000, // 10s timeout
      });

      const filename = path.basename(filePath);
      const formatterName = formatter.includes('prettier') ? 'prettier' : 'biome';

      if (result.status === 0 && !result.error) {
        contextMessages.push(`[auto-format] Formatted ${filename} with ${formatterName}`);
      } else {
        // Formatter failed — warn on stderr, still exit 0 (fail-open)
        process.stderr.write(`[nf] WARNING: ${formatterName} failed on ${filename}: ${(result.stderr || '').slice(0, 200)}\n`);
      }
    }

    // ─── Optional post-edit verify step ──────────────────────────────────
    const verifyEnabled = config.post_edit_verify_enabled === true;
    const verifyCommand = config.post_edit_verify_command || '';

    if (verifyEnabled && verifyCommand) {
      // Check file pattern filter
      const patterns = Array.isArray(config.post_edit_verify_file_patterns)
        ? config.post_edit_verify_file_patterns
        : [];
      let shouldVerify = true;

      if (patterns.length > 0) {
        shouldVerify = patterns.some(p => {
          try { return new RegExp(p).test(filePath); } catch (_) { return false; }
        });
      }
      // If patterns array is empty, use JS_TS_RE as default filter (already passed above)

      if (shouldVerify) {
        const verifyResult = spawnSync(verifyCommand, [], {
          shell: true,
          encoding: 'utf8',
          cwd,
          timeout: config.post_edit_verify_timeout_ms || 15000,
        });

        if (verifyResult.status === 0 && !verifyResult.error) {
          contextMessages.push('[post-edit-verify] Passed');
        } else {
          const failMode = config.post_edit_verify_fail_mode || 'warn';
          if (failMode === 'warn') {
            const snippet = (verifyResult.stderr || verifyResult.stdout || '').slice(0, 200);
            contextMessages.push(`[post-edit-verify] WARNING: Verify command failed: ${snippet}`);
          }
        }
      }
    }

    // Exit early if no formatter found and verify not enabled/not run
    if (contextMessages.length === 0) {
      process.exit(0);
    }

    // Emit collected additionalContext
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: contextMessages.join(' | '),
      },
    }));

    process.exit(0); // Always exit 0 — fail-open
  } catch (e) {
    if (e instanceof SyntaxError) {
      process.stderr.write('[nf] WARNING: nf-post-edit-format: malformed JSON on stdin: ' + e.message + '\n');
    }
    // Malformed JSON or unexpected error — fail-open, no output
    process.exit(0);
  }
});

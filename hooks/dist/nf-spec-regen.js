'use strict';
// hooks/nf-spec-regen.js
// PostToolUse hook: when Claude writes to a state machine file matching
// configurable patterns, automatically trigger fsm-to-tla.cjs to regenerate specs.
//
// LOOP-02 (v0.21-03): Self-Calibrating Feedback Loops
//
// Input (stdin): Claude Code PostToolUse JSON payload
//   { tool_name, tool_input: { file_path }, tool_response, cwd, context_window }
//
// Output (stdout): JSON { hookSpecificOutput: { hookEventName, additionalContext } }
//   OR: no output (exit 0) when the hook is a no-op.
//
// Fail-open: exits 0 in ALL cases — never blocks the Write tool.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadConfig, shouldRunHook, validateHookInput } = require('./config-loader');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const _eventType = input.hook_event_name || input.hookEventName || 'PostToolUse';
    const _validation = validateHookInput(_eventType, input);
    if (!_validation.valid) {
      process.stderr.write('[nf] WARNING: nf-spec-regen: invalid input: ' + JSON.stringify(_validation.errors) + '\n');
      process.exit(0); // Fail-open
    }

    // Profile guard — exit early if this hook is not active for the current profile
    const config = loadConfig(input.cwd || process.cwd());
    const profile = config.hook_profile || 'standard';
    if (!shouldRunHook('nf-spec-regen', profile)) {
      process.exit(0);
    }

    const cwd = input.cwd || process.cwd();
    const toolName = input.tool_name || '';
    const filePath = (input.tool_input && input.tool_input.file_path) || '';

    // Only act on Write calls
    if (toolName !== 'Write') {
      process.exit(0); // No-op — not a Write tool call
    }

    // Gate 1: check against configurable patterns (default: ['*.machine.ts'] preserves old behavior)
    const patterns = config.spec_regen_patterns || ['*.machine.ts'];
    const basename = path.basename(filePath);
    const matchesPattern = patterns.some(function(pat) {
      // Simple glob: *.ext matches any file ending with .ext
      if (pat.startsWith('*')) return basename.endsWith(pat.slice(1));
      // Exact filename match
      return basename === pat || filePath.includes(pat);
    });

    // Gate 2: if no pattern match, try auto-detection on the file content.
    // This enables all 10 supported FSM frameworks without explicit config.
    let detectedFramework = null;
    if (!matchesPattern) {
      try {
        const detectMod = require(path.join(cwd, 'bin', 'adapters', 'detect.cjs'));
        const fileContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
        if (fileContent) {
          const detection = detectMod.detectFramework(filePath, fileContent);
          if (detection && detection.confidence >= 60) {
            detectedFramework = detection.adapter.id;
          }
        }
      } catch (_) {
        // detect.cjs not available (external project) — fail-open
      }
      if (!detectedFramework) {
        process.exit(0); // No-op — not a recognized state machine file
      }
    }

    let msg = '';

    // For nf-workflow.machine.ts specifically, also run generate-formal-specs.cjs
    // (that script generates TLA+/Alloy/PRISM, not just xstate TLA+)
    if (filePath.includes('nf-workflow.machine.ts')) {
      const genScript = path.join(cwd, 'bin', 'generate-formal-specs.cjs');
      if (fs.existsSync(genScript)) {
        const result = spawnSync(process.execPath, [genScript], {
          encoding: 'utf8',
          cwd: cwd,
          timeout: 60000,
        });

        if (result.status === 0 && !result.error) {
          msg = '[spec-regen] Formal specs regenerated (generate-formal-specs.cjs) from XState machine.';
        } else {
          msg = '[spec-regen] WARNING: generate-formal-specs.cjs failed after machine file write. Run manually to regenerate specs.\n' +
                (result.stderr ? result.stderr.slice(0, 500) : '') +
                (result.error ? String(result.error) : '');
        }
      }
    }

    // Run fsm-to-tla.cjs for the matched file
    const fsmToTla = path.join(cwd, 'bin', 'fsm-to-tla.cjs');
    if (fs.existsSync(fsmToTla)) {
      const fsmArgs = [fsmToTla, filePath];
      // Pass --framework when we already detected, to skip redundant re-detection
      if (detectedFramework) {
        fsmArgs.push('--framework=' + detectedFramework);
      }
      if (filePath.includes('nf-workflow.machine.ts')) {
        const guardsConfig = path.join(cwd, '.planning', 'formal', 'tla', 'guards', 'nf-workflow.json');
        if (fs.existsSync(guardsConfig)) {
          fsmArgs.push('--config=' + guardsConfig);
          fsmArgs.push('--module=NFQuorum');
        }
      }

      const fsmResult = spawnSync(process.execPath, fsmArgs, {
        encoding: 'utf8',
        cwd: cwd,
        timeout: 60000,
      });

      if (fsmResult.status !== 0 || fsmResult.error) {
        msg += '\n[spec-regen] WARNING: fsm-to-tla.cjs failed. Run manually.';
        if (fsmResult.stderr) msg += '\n' + fsmResult.stderr.slice(0, 300);
      } else {
        if (msg) msg += '\n';
        msg += '[spec-regen] TLA+ spec regenerated via fsm-to-tla.cjs for ' + path.basename(filePath) + '.';
      }
    }

    if (msg) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: msg,
        },
      }));
    }
    process.exit(0); // Always exit 0 — fail-open
  } catch (e) {
    if (e instanceof SyntaxError) {
      process.stderr.write('[nf] WARNING: nf-spec-regen: malformed JSON on stdin: ' + e.message + '\n');
    }
    // Malformed JSON or unexpected error — fail-open, no output
    process.exit(0);
  }
});

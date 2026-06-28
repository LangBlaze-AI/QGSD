#!/usr/bin/env node
// hooks/nf-slot-correlator.js
// SubagentStart hook — writes a correlation placeholder file for nf-quorum-slot-worker subagents.
//
// At SubagentStart time, the prompt/slot name is not available in the hook payload.
// This hook writes a stub correlation file { agent_id, ts, slot: null } so the
// token collector (SubagentStop) can locate and clean up the file per agent_id.
// The slot is resolved from last_assistant_message preamble by the token collector.
//
// Guards:
//   - Only processes agent_type === 'nf-quorum-slot-worker' (exits 0 otherwise)
//   - If agent_id is absent: exits 0 gracefully
//   - Fail-open: any unhandled error exits 0

'use strict';

const fs   = require('fs');
const path = require('path');
const { loadConfig, shouldRunHook, validateHookInput } = require('./config-loader');
const resolveBin = require('./nf-resolve-bin');

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw);
      const _eventType = input.hook_event_name || input.hookEventName || 'PostToolUse';
      const _validation = validateHookInput(_eventType, input);
      if (!_validation.valid) {
        process.stderr.write('[nf] WARNING: nf-slot-correlator: invalid input: ' + JSON.stringify(_validation.errors) + '\n');
        process.exit(0); // Fail-open
      }

      // Profile guard — exit early if this hook is not active for the current profile
      const config = loadConfig();
      const profile = config.hook_profile || 'standard';
      if (!shouldRunHook('nf-slot-correlator', profile)) {
        process.exit(0);
      }

      // Guard: only process nf-quorum-slot-worker subagents
      if (input.agent_type !== 'nf-quorum-slot-worker') {
        process.exit(0);
      }

      // Guard: agent_id required to write a meaningful correlation file
      if (!input.agent_id) {
        process.exit(0);
      }

      // Guard: agent_id must be a safe filename component. Reject non-strings
      // and any path separators / traversal / null bytes that would escape the
      // correlations directory (arbitrary file write).
      if (typeof input.agent_id !== 'string' ||
          input.agent_id.includes('/')  ||
          input.agent_id.includes('\\') ||
          input.agent_id.includes('..') ||
          input.agent_id.includes('\0')) {
        process.exit(0); // Fail-open: refuse unsafe correlation id
      }

      const pp = require(resolveBin('planning-paths.cjs'));
      const corrPath = pp.resolve(process.cwd(), 'quorum-correlation', { agentId: input.agent_id });

      try {
        fs.writeFileSync(corrPath, JSON.stringify({
          agent_id: input.agent_id,
          ts:       new Date().toISOString(),
          slot:     null, // SubagentStart does not include prompt — slot resolved at SubagentStop
        }), 'utf8');
      } catch (_) {} // observational — never fails

      process.exit(0);

    } catch (e) {
      if (e instanceof SyntaxError) {
        process.stderr.write('[nf] WARNING: nf-slot-correlator: malformed JSON on stdin: ' + e.message + '\n');
      }
      // Fail-open
      process.exit(0);
    }
  });
}

main();

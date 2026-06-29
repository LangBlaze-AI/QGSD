#!/usr/bin/env node
// hooks/nf-token-collector.js
// SubagentStop hook — reads agent_transcript_path, sums message.usage fields,
// appends a token record to .planning/token-usage.jsonl.
//
// Guards:
//   - Only processes agent_type === 'nf-quorum-slot-worker' (exits 0 otherwise)
//   - If transcript path is absent or missing: writes null-token record and exits 0 (fail-open)
//   - isSidechain is NOT filtered (subagent transcripts mark ALL entries as sidechain)
//   - isApiErrorMessage === true entries are excluded from token sum
//   - Never writes to stdout (stdout is the Claude Code hook decision channel)
//   - Fail-open: any unhandled error exits 0 without crashing the user's session

'use strict';

const fs   = require('fs');
const path = require('path');
const { loadConfig, shouldRunHook, validateHookInput } = require('./config-loader');
const resolveBin = require('./nf-resolve-bin');

// Resolve slot name from correlation file, last_assistant_message, or transcript.
// Order:
//   1. Read correlation file at .planning/quorum-slot-corr-<agent_id>.json
//      - If slot is set → return it (and delete file)
//      - If slot is null → delete file, fall through to next
//   2. Parse "slot: <name>" from first matching line in last_assistant_message
//   3. Parse "slot: <name>" from the first user message in agent_transcript_path
//   4. Fallback: return agent_id or 'unknown'
function resolveSlot(input) {
  if (input.agent_id) {
    const pp = require(resolveBin('planning-paths.cjs'));
    const corrPath = pp.resolveWithFallback(process.cwd(), 'quorum-correlation', { agentId: input.agent_id });
    if (fs.existsSync(corrPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(corrPath, 'utf8'));
        try { fs.unlinkSync(corrPath); } catch (_) {}
        if (data.slot) return data.slot;
        // slot is null → fall through to last_assistant_message
      } catch (_) {
        // Malformed correlation file — fall through
      }
    }
  }

  // Parse from last_assistant_message preamble
  if (typeof input.last_assistant_message === 'string') {
    const m = input.last_assistant_message.match(/^slot:\s*(\S+)/m);
    if (m) return m[1];
  }

  // Parse from transcript user message (slot workers receive "slot: X" as first line of prompt)
  if (input.agent_transcript_path) {
    try {
      const raw = fs.readFileSync(input.agent_transcript_path, 'utf8');
      const firstLine = raw.split('\n').find(l => l.trim());
      if (firstLine) {
        const entry = JSON.parse(firstLine);
        if (entry.type === 'user' && entry.message && entry.message.content) {
          const content = entry.message.content;
          const text = typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content.map(b => (b && typeof b.text === 'string' ? b.text : '')).join('\n')
              : '';
          const um = text.match(/^slot:\s*(\S+)/m);
          if (um) return um[1];
        }
      }
    } catch (_) {
      // Transcript read failed — fall through
    }
  }

  // Final fallback
  return input.agent_id || 'unknown';
}

// Append a token record to .planning/token-usage.jsonl.
// Never throws — any error is silently swallowed (observational).
function appendRecord(input, inputTokens, outputTokens, cacheCreate, cacheRead) {
  try {
    const slot = resolveSlot(input);
    const record = JSON.stringify({
      ts:                            new Date().toISOString(),
      session_id:                    input.session_id   || process.env.NF_SOLVE_SESSION_ID || null,
      agent_id:                      input.agent_id     || null,
      slot,
      input_tokens:                  inputTokens,
      output_tokens:                 outputTokens,
      cache_creation_input_tokens:   cacheCreate,
      cache_read_input_tokens:       cacheRead,
    });
    const pp2 = require(resolveBin('planning-paths.cjs'));
    const logPath = pp2.resolve(process.cwd(), 'token-usage');
    fs.appendFileSync(logPath, record + '\n', 'utf8');
  } catch (_) {} // observational — never fails
}

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
        process.stderr.write('[nf] WARNING: nf-token-collector: invalid input: ' + JSON.stringify(_validation.errors) + '\n');
        process.exit(0); // Fail-open
      }

      // Profile guard — exit early if this hook is not active for the current profile
      const config = loadConfig();
      const profile = config.hook_profile || 'standard';
      if (!shouldRunHook('nf-token-collector', profile)) {
        process.exit(0);
      }

      // Guard: only process nf-quorum-slot-worker subagents
      if (input.agent_type !== 'nf-quorum-slot-worker') {
        process.exit(0);
      }

      // Guard: absent or missing transcript → null sentinel record
      if (!input.agent_transcript_path || !fs.existsSync(input.agent_transcript_path)) {
        appendRecord(input, null, null, null, null);
        process.exit(0);
      }

      // Read and parse transcript JSONL
      const rawTranscript = fs.readFileSync(input.agent_transcript_path, 'utf8');
      const lines = rawTranscript.split('\n').filter(l => l.trim().length > 0);

      let inputSum       = 0;
      let outputSum      = 0;
      let cacheCreateSum = 0;
      let cacheReadSum   = 0;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          // Only sum assistant entries
          if (entry.type !== 'assistant') continue;
          // NOTE: isSidechain is NOT filtered — subagent transcripts mark ALL entries
          // as isSidechain=true, so filtering on it would exclude all usage data.
          // Exclude API error entries
          if (entry.isApiErrorMessage === true) continue;
          // Require usage data
          const usage = entry.message && entry.message.usage;
          if (!usage) continue;

          inputSum       += (usage.input_tokens                 || 0);
          outputSum      += (usage.output_tokens                || 0);
          cacheCreateSum += (usage.cache_creation_input_tokens  || 0);
          cacheReadSum   += (usage.cache_read_input_tokens      || 0);
        } catch (_) {
          // Skip malformed lines
        }
      }

      appendRecord(input, inputSum, outputSum, cacheCreateSum, cacheReadSum);
      process.exit(0);

    } catch (e) {
      if (e instanceof SyntaxError) {
        process.stderr.write('[nf] WARNING: nf-token-collector: malformed JSON on stdin: ' + e.message + '\n');
      }
      // Fail-open: never crash the session on any unexpected error
      process.exit(0);
    }
  });
}

main();

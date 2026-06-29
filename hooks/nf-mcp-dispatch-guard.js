#!/usr/bin/env node
// hooks/nf-mcp-dispatch-guard.js
// PreToolUse hook -- BLOCKS direct mcp__<slot>__<tool> calls for quorum slots.
// R3.2 requires Task(subagent_type="nf-quorum-slot-worker") dispatch instead.
// Allowlisted exceptions: ping, health_check, deep_health_check, identity, help
// (diagnostic/admin tools used by /nf:mcp-status, /nf:mcp-set-model, /nf:mcp-restart).
//
// Follows fail-open pattern: try/catch wrapping entire main, exit(0) on any error.
// Hook stdout is the decision channel -- debug output goes to stderr only.

'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig, shouldRunHook, validateHookInput } = require('./config-loader');
const resolveBin = require('./nf-resolve-bin');

// Dynamically discover quorum slot families from bin/providers.json
// Uses resolveBin for dual-path resolution (installed: ~/.claude/nf-bin/, dev: bin/)
function loadKnownFamilies() {
  try {
    const providersPath = resolveBin('providers.json');
    const providersJson = JSON.parse(fs.readFileSync(providersPath, 'utf8'));

    if (!Array.isArray(providersJson.providers)) {
      process.stderr.write('[nf] WARNING: nf-mcp-dispatch-guard: providers.json missing .providers array at ' + providersPath + ', fail-open\n');
      return new Set();
    }

    const families = new Set();
    for (const provider of providersJson.providers) {
      if (provider && typeof provider.name === 'string') {
        // Strip trailing -N to derive family (e.g. "codex-1" -> "codex")
        const family = provider.name.replace(/-\d+$/, '');
        families.add(family);
      }
    }

    return families;
  } catch (e) {
    const providersPath = resolveBin('providers.json');
    process.stderr.write('[nf] WARNING: nf-mcp-dispatch-guard: failed to load ' + providersPath + ', fail-open\n');
    return new Set();
  }
}

// Build set of known MCP slot family prefixes from bin/providers.json
const KNOWN_FAMILIES = loadKnownFamilies();

// Allowlisted MCP tool suffixes that bypass the guard (diagnostic/admin tools)
const ALLOWLISTED_SUFFIXES = new Set([
  'ping',
  'health_check',
  'deep_health_check',
  'identity',
  'help',
]);

// Regex to parse mcp__<slot>__<suffix> tool names
const MCP_TOOL_RE = /^mcp__([a-z][\w-]*)__(.+)$/;

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
        process.stderr.write('[nf] WARNING: nf-mcp-dispatch-guard: invalid input: ' + JSON.stringify(validation.errors) + '\n');
        process.exit(0); // fail-open
      }

      // Profile guard
      const cwd = input.cwd || process.cwd();
      const config = loadConfig(cwd);
      const profile = config.hook_profile || 'standard';
      if (!shouldRunHook('nf-mcp-dispatch-guard', profile)) {
        process.exit(0);
      }

      // Extract tool name
      const toolName = input.tool_name || input.toolName || '';

      // Only act on mcp__ prefixed tool calls
      const match = MCP_TOOL_RE.exec(toolName);
      if (!match) {
        process.exit(0); // Not an MCP call -- no-op
      }

      const slotName = match[1];   // e.g. "codex-1"
      const suffix = match[2];     // e.g. "review"

      // Allowlisted suffixes pass through silently
      if (ALLOWLISTED_SUFFIXES.has(suffix)) {
        process.exit(0);
      }

      // Derive family name (strip trailing -N for numbered slots)
      const family = slotName.replace(/-\d+$/, '');

      // Only block known quorum slot families
      if (!KNOWN_FAMILIES.has(family)) {
        process.exit(0); // Unknown MCP server -- not a quorum slot
      }

      // Hard-block: R3.2 violation -- direct MCP call to quorum slot
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason:
          'R3.2 VIOLATION: Direct MCP call to ' + toolName + ' is prohibited. ' +
          "Use Task(subagent_type='nf-quorum-slot-worker') for quorum dispatch. " +
          'Direct mcp__ calls bypass YAML protocol, scoreboard tracking, timeout handling, and error classification. ' +
          'Allowlisted admin tools: ping, health_check, deep_health_check, identity, help.',
      }));

      process.exit(0);
    } catch (e) {
      if (e instanceof SyntaxError) {
        process.stderr.write('[nf] WARNING: nf-mcp-dispatch-guard: malformed JSON on stdin: ' + e.message + '\n');
      }
      process.exit(0); // fail-open on any error
    }
  });
}

if (require.main === module) main();

module.exports = { ALLOWLISTED_SUFFIXES, KNOWN_FAMILIES, MCP_TOOL_RE, loadKnownFamilies };

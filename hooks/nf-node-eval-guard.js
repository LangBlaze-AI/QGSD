#!/usr/bin/env node
// hooks/nf-node-eval-guard.js
// PreToolUse hook — rewrites `node -e "..."` Bash commands to heredoc syntax
// to prevent zsh history expansion from mangling `!` characters.
//
// zsh converts `!` to `\!` even inside quotes, and Node.js v25+ (TypeScript
// eval mode) interprets `\!` as a unicode escape prefix, breaking any code
// containing `!==`, `!var`, etc.
//
// The fix: `node << 'NF_EVAL'\n<code>\nNF_EVAL` — quoted heredoc delimiters
// disable ALL shell interpolation in the body, passing code verbatim to Node.
//
// Strategy: deny the original `node -e` call and provide the corrected heredoc
// command in the denial reason. Claude sees the denial and re-issues the command
// using the safe heredoc form. This avoids reliance on `updatedInput` which may
// not be supported in all Claude Code versions.
//
// Fail-open on any error.

'use strict';
/** @requirement DETECT-04 — PreToolUse safety hook rewrites node -e to heredoc syntax */

const { loadConfig, shouldRunHook, validateHookInput } = require('./config-loader');

// Detects `node -e` followed by a quoted argument
const NODE_EVAL_RE = /node\s+-e\s+(['"])/g;

/**
 * Finds the index of the matching closing quote character.
 * For single quotes: no escape handling (bash convention).
 * For double quotes: skips backslash-escaped quotes.
 * Returns null if no match found.
 */
function findClosingQuote(str, startIdx, quoteChar) {
  if (quoteChar === "'") {
    const idx = str.indexOf("'", startIdx);
    return idx === -1 ? null : idx;
  }
  for (let i = startIdx; i < str.length; i++) {
    if (str[i] === '\\') { i++; continue; }
    if (str[i] === '"') return i;
  }
  return null;
}

/**
 * Determines whether the character at `index` sits inside an open shell quote
 * (single or double) when scanning the command from the start.
 *
 * This prevents false positives: a `node -e "..."` substring that appears
 * INSIDE another command's quoted argument (e.g. `grep 'node -e "x"' src` or
 * `echo "node -e 'y'"`) is not a real eval invocation and must not be rewritten.
 *
 * Shell quoting rules honored: single quotes are literal (no escapes); double
 * quotes and unquoted context honor backslash escaping of the next character.
 */
function isInsideQuotes(str, index) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < index && i < str.length; i++) {
    const c = str[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
    } else if (inDouble) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inDouble = false;
    } else {
      if (c === '\\') { i++; continue; }
      if (c === "'") inSingle = true;
      else if (c === '"') inDouble = true;
    }
  }
  return inSingle || inDouble;
}

/**
 * Finds the [start, end) ranges of heredoc BODIES in a command string.
 * A `node -e "..."` appearing inside a heredoc body (e.g. a `git commit -F -`
 * message that merely mentions an inline eval) is not a real invocation and
 * must not be rewritten. Handles `<< DELIM`, `<<-DELIM`, `<< 'DELIM'`,
 * `<< "DELIM"`; the body runs from the next line to the closing delimiter line.
 */
function findHeredocRanges(command) {
  const ranges = [];
  const re = /<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    // A `<<DELIM` sequence that appears inside a quoted string (e.g.
    // `echo "<<'EOF'"`) is not a real heredoc opener — skip it so it cannot
    // open a bogus body range that would swallow a later real `node -e`.
    if (isInsideQuotes(command, m.index)) continue;
    // The `<<-` (dash) form lets the terminator line be indented with leading TABS.
    const allowLeadingTabs = m[1] === '-';
    const delim = m[3];
    const nl = command.indexOf('\n', re.lastIndex);
    if (nl === -1) continue; // no body on a single line
    const bodyStart = nl + 1;
    // Bash requires the terminator line to be EXACTLY the delimiter (only
    // leading tabs are allowed, and only for the `<<-` form) — no trailing
    // whitespace. Matching it exactly avoids treating `DELIM  ` as a close.
    const closeRe = new RegExp(`^${allowLeadingTabs ? '\\t*' : ''}${delim}$`, 'm');
    const rest = command.slice(bodyStart);
    const cm = closeRe.exec(rest);
    const bodyEnd = cm ? bodyStart + cm.index : command.length;
    ranges.push({ start: bodyStart, end: bodyEnd });
    re.lastIndex = bodyEnd;
  }
  return ranges;
}

/**
 * Rewrites all `node -e "..."` / `node -e '...'` occurrences in a command
 * string to heredoc syntax: `node << 'NF_EVAL'\n<code>\nNF_EVAL`
 *
 * Returns null if no rewrite needed, or the rewritten command string.
 */
function rewriteCommand(command) {
  // Skip if already using our heredoc marker (anchor to `node <<` so a real
  // `node -e` that merely mentions NF_EVAL in its JS is not falsely skipped)
  if (/node\s+<<\s*'?NF_EVAL/.test(command)) return null;

  // Collect all matches with their positions and extracted JS code
  const matches = [];
  let m;
  NODE_EVAL_RE.lastIndex = 0;
  const heredocRanges = findHeredocRanges(command);

  while ((m = NODE_EVAL_RE.exec(command)) !== null) {
    // Skip occurrences that are themselves inside another command's quoted
    // argument (e.g. a grep pattern or echo string) — not real eval calls.
    if (isInsideQuotes(command, m.index)) continue;
    // Skip occurrences inside a heredoc body (e.g. a commit message that
    // merely mentions an inline eval) — also not a real invocation.
    if (heredocRanges.some(r => m.index >= r.start && m.index < r.end)) continue;

    const quoteChar = m[1];
    const jsStart = m.index + m[0].length;
    const closeIdx = findClosingQuote(command, jsStart, quoteChar);
    if (closeIdx === null) continue;

    matches.push({
      start: m.index,
      end: closeIdx + 1,
      jsCode: command.substring(jsStart, closeIdx),
    });
  }

  if (matches.length === 0) return null;

  // Rewrite from end to start so earlier indices remain valid
  let result = command;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { start, end, jsCode } = matches[i];
    let delim = matches.length > 1 ? `NF_EVAL_${i}` : 'NF_EVAL';
    // Avoid a delimiter that appears as a standalone body line, which would
    // terminate the heredoc early and leak the remaining JS as shell commands.
    const bodyLines = jsCode.split('\n');
    while (bodyLines.includes(delim)) delim += '_X';
    const heredoc = `node << '${delim}'\n${jsCode}\n${delim}`;
    result = result.substring(0, start) + heredoc + result.substring(end);
  }

  return result;
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      if (!raw || raw.trim() === '') {
        process.exit(0);
      }

      const input = JSON.parse(raw);

      const eventType = input.hook_event_name || input.hookEventName || 'PreToolUse';
      const validation = validateHookInput(eventType, input);
      if (!validation.valid) {
        process.stderr.write('[nf] WARNING: nf-node-eval-guard: invalid input: ' + JSON.stringify(validation.errors) + '\n');
        process.exit(0);
      }

      const cwd = input.cwd || process.cwd();
      const config = loadConfig(cwd);
      const profile = config.hook_profile || 'standard';
      if (!shouldRunHook('nf-node-eval-guard', profile)) {
        process.exit(0);
      }

      const toolName = input.tool_name || input.toolName || '';
      if (toolName.toLowerCase() !== 'bash') {
        process.exit(0);
      }

      const command = (input.tool_input && input.tool_input.command) || '';
      if (!command || !command.includes('node')) {
        process.exit(0);
      }

      const rewritten = rewriteCommand(command);
      if (!rewritten) {
        process.exit(0);
      }

      process.stderr.write('[nf-node-eval-guard] Blocked node -e, providing heredoc rewrite\n');

      // Deny the original command and provide the corrected heredoc version.
      // Claude will see the denial reason and re-issue using the safe form.
      const reason =
        '[nf-node-eval-guard] BLOCKED: `node -e` is unsafe on zsh (history expansion mangles `!` to `\\!`). ' +
        'Re-run using this exact heredoc command instead:\n\n' +
        rewritten;

      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }));

      process.exit(0);
    } catch (e) {
      if (e instanceof SyntaxError) {
        process.stderr.write('[nf] WARNING: nf-node-eval-guard: malformed JSON on stdin: ' + e.message + '\n');
      } else {
        process.stderr.write('[nf] WARNING: nf-node-eval-guard: ' + (e.message || 'unknown error') + '\n');
      }
      process.exit(0);
    }
  });
}

if (require.main === module) main();

module.exports = { rewriteCommand, findClosingQuote, isInsideQuotes, findHeredocRanges };

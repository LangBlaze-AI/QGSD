#!/usr/bin/env node
'use strict';
// bin/quorum-dispatch-argv.cjs
//
// Single source of truth for the parent→child dispatch argv contract between
// quorum-slot-dispatch.cjs (parent, builds spawnArgs) and call-quorum-slot.cjs
// (child, parses argv). Issue #202: the parent was building spawnArgs without
// --round (child roundNum always null → telemetry logged null round, corrupting
// #175 score-delta calibration) while pushing 5 flags the child never parsed.
//
// Both sides import DISPATCH_FLAGS so the contract can never silently drift:
// the parent builds only known flags, and the child warns on any unknown --flag.

// The complete set of value-taking flags the child (call-quorum-slot.cjs) parses.
// Keep this in lockstep with the getArg('--…') calls in call-quorum-slot.cjs.
// Any flag the parent pushes MUST appear here, or the child argv-warning fires.
const DISPATCH_FLAGS = Object.freeze([
  '--slot',            // logical slot name
  '--timeout',         // per-slot timeout in ms
  '--round',           // quorum round number (telemetry — #175 calibration)
  '--cwd',             // working directory for the child
  '--allowed-tools',   // EXEC-01: e.g. "Read,Grep,Glob" for review-only slots
  '--output-file',     // defense-in-depth: child writes result file
  '--dispatch-nonce',  // nonce from parent for result-file authenticity
]);

const DISPATCH_FLAG_SET = Object.freeze(new Set(DISPATCH_FLAGS));

/**
 * Build the argv the parent passes to call-quorum-slot.cjs.
 * Only flags present in DISPATCH_FLAGS may be emitted, so the contract is
 * enforced at construction time. Pass `null`/`undefined` to omit a flag.
 *
 * @param {string} cqsPath        absolute path to call-quorum-slot.cjs
 * @param {object} opts
 * @returns {string[]} spawnArgs
 */
function buildDispatchArgv(cqsPath, {
  slot,
  timeout,
  round,
  cwd,
  allowedTools = null,
  outputFile = null,
  dispatchNonce = null,
} = {}) {
  const args = [cqsPath];
  const push = (flag, value) => {
    if (value === null || value === undefined) return;
    if (!DISPATCH_FLAG_SET.has(flag)) {
      throw new Error(`[quorum-dispatch-argv] unknown dispatch flag: ${flag}`);
    }
    args.push(flag, String(value));
  };

  push('--slot', slot);
  push('--timeout', timeout);
  push('--round', round);
  push('--cwd', cwd);
  push('--allowed-tools', allowedTools);
  if (outputFile) {
    push('--output-file', outputFile);
    push('--dispatch-nonce', dispatchNonce);
  }
  return args;
}

/**
 * Warn (stderr) about any `--flag` token in argv that the child does not parse,
 * so future parent→child contract drift is visible instead of silent.
 *
 * @param {string[]} argv  process.argv.slice(2) from the child
 * @returns {string[]} list of unrecognized flags (also emits a stderr warning)
 */
function warnUnknownDispatchFlags(argv) {
  const unknown = [];
  for (const tok of argv) {
    if (typeof tok === 'string' && tok.startsWith('--') && !DISPATCH_FLAG_SET.has(tok)) {
      unknown.push(tok);
    }
  }
  if (unknown.length > 0) {
    process.stderr.write(
      `[call-quorum-slot] WARN: unrecognized dispatch flag(s) ignored: ${unknown.join(' ')} ` +
      `(known: ${DISPATCH_FLAGS.join(' ')})\n`
    );
  }
  return unknown;
}

module.exports = {
  DISPATCH_FLAGS,
  DISPATCH_FLAG_SET,
  buildDispatchArgv,
  warnUnknownDispatchFlags,
};

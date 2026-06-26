'use strict';

/**
 * provider-arg-templates.cjs — canonical per-family CLI args_template map.
 *
 * Single source of truth for how each quorum CLI family is invoked non-interactively
 * (the `{prompt}` placeholder is substituted with the actual prompt at dispatch time).
 *
 * WHY THIS EXISTS: providers.json entries are supposed to carry an `args_template`
 * field, but the install-time auto-detection path (bin/install.js provider sync)
 * historically wrote entries WITHOUT it. Every consumer then did
 * `provider.args_template.map(...)` unguarded — so a missing field crashed quorum
 * dispatch with an opaque "Cannot read properties of undefined (reading 'map')"
 * for ALL slots (call-quorum-slot.cjs, unified-mcp-server.mjs, probe-quorum-slots,
 * provider-status). This map lets both the generator emit a correct default and the
 * consumers fall back / fail loud instead of crashing.
 *
 * The values below are the canonical templates asserted by the guided-install path
 * and dispatch tests (test/install-guided-providers.test.cjs, test/shell-escape-01.test.cjs)
 * — they are recovered from those invariants, not guessed.
 */

const FAMILY_ARGS_TEMPLATE = {
  // claude CLI: print mode, skip interactive permission prompts
  claude:      ['-p', '{prompt}', '--dangerously-skip-permissions'],
  // codex CLI: non-interactive `exec` subcommand
  codex:       ['exec', '{prompt}'],
  // gemini CLI: print mode (default model)
  gemini:      ['-p', '{prompt}'],
  // opencode CLI: `run` with quiet logs so stdout is just the response
  opencode:    ['run', '--print-logs', '--log-level', 'ERROR', '{prompt}'],
  // copilot CLI: print mode, auto-approve tools, no color, suppress spinner
  copilot:     ['-p', '{prompt}', '--allow-all-tools', '--no-color', '-s'],
  // antigravity (`agy` binary): print mode (verified against agy v1.0.8 `-p`/--print)
  antigravity: ['-p', '{prompt}'],
};

/**
 * Return a fresh copy of the canonical args_template for a family, or null if the
 * family is unknown. Callers should treat null as "cannot dispatch — fail loud".
 * @param {string} mainTool - family name (e.g. 'gemini', 'codex', 'antigravity')
 * @returns {string[]|null}
 */
function argsTemplateFor(mainTool) {
  const t = FAMILY_ARGS_TEMPLATE[mainTool];
  return t ? t.slice() : null;
}

/**
 * Resolve the args_template to use for a provider: its own explicit field wins,
 * otherwise the canonical family default by mainTool. Returns null when neither
 * is available (unknown family + no explicit template) so callers can fail loud
 * with a clear message instead of crashing on `.map` of undefined.
 * @param {object} provider - a providers.json entry
 * @returns {string[]|null}
 */
function resolveArgsTemplate(provider) {
  if (provider && Array.isArray(provider.args_template)) return provider.args_template;
  if (provider && provider.mainTool) return argsTemplateFor(provider.mainTool);
  return null;
}

module.exports = { FAMILY_ARGS_TEMPLATE, argsTemplateFor, resolveArgsTemplate };

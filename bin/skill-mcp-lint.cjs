'use strict';
// bin/skill-mcp-lint.cjs
//
// THE STANDARD (enforced by scripts/lint-isolation.js, the required "Lint" check):
//   References to a CLI quorum slot's MCP tools must use the real, current
//   `<family>-<N>` slot name and a tool the server actually exposes.
//
// Why — the recurring F18/F19/F24 class: skills drifted to CLI-style slot names
// (`mcp__gemini-cli__…`, `mcp__opencode__…`, `mcp__copilot-cli__ask`) and
// non-existent tools (`copilot` has `copilot`/`suggest`/`explain`, never `ask`).
// Every worker then fails to find its tool and the consensus table renders
// all-UNAVAIL — silently. A per-file fix kept leaking (e.g. #232 fixed
// commands/nf/debug.md but core/workflows/debug.md kept the stale names).
//
// Scope: only the four CLI families with a fixed, knowable tool surface. Other
// slots are install-specific (claude-*, ccr-*) or external (context7, sentry,
// plugin_*) and are intentionally NOT validated. Template references that contain
// `<`, `$`, `{` (e.g. `mcp__<slot>__identity`, `mcp__<$AGENT>__identity`) are
// skipped — those are placeholders the skill substitutes at runtime.

const VALID_TOOLS = {
  codex: ['codex', 'review', 'identity', 'health_check', 'deep_health_check', 'help', 'ping'],
  gemini: ['gemini', 'identity', 'health_check', 'deep_health_check', 'help', 'ping'],
  copilot: ['copilot', 'suggest', 'explain', 'identity', 'health_check', 'deep_health_check', 'help', 'ping'],
  opencode: ['opencode', 'opencode_check_update', 'identity', 'health_check', 'deep_health_check', 'help', 'ping'],
};
const FAMILIES = Object.keys(VALID_TOOLS);

// Concrete `mcp__<slot>__<tool>` — slot/tool are [a-z0-9-_], so any `<`/`$`/`{`
// template marker simply won't match (it's skipped, by construction).
const MCP_REF = /mcp__([a-z0-9-]+)__([a-z_]+)/gi;

function familyOf(slot) {
  for (const f of FAMILIES) if (slot === f || slot.startsWith(f)) return f;
  return null;
}

// Returns [{ file, line, rule, ref, hint }] — rule is 'mcp-stale-slot' or 'mcp-bad-tool'.
function findMcpToolViolations(text, file) {
  const out = [];
  let m;
  MCP_REF.lastIndex = 0;
  while ((m = MCP_REF.exec(text)) !== null) {
    const [ref, slot, tool] = m;
    const fam = familyOf(slot.toLowerCase());
    if (!fam) continue; // not a CLI family — install-specific/external, not validated
    const line = text.slice(0, m.index).split('\n').length;
    if (!new RegExp(`^${fam}-\\d+$`).test(slot)) {
      out.push({ file, line, rule: 'mcp-stale-slot', ref, hint: `use ${fam}-<N> (e.g. ${fam}-1)` });
    } else if (!VALID_TOOLS[fam].includes(tool.toLowerCase())) {
      out.push({ file, line, rule: 'mcp-bad-tool', ref, hint: `${fam} exposes: ${VALID_TOOLS[fam].join('/')}` });
    }
  }
  return out;
}

module.exports = { findMcpToolViolations, VALID_TOOLS };

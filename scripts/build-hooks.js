#!/usr/bin/env node
/**
 * Copy GSD hooks to dist for installation.
 */

const fs = require('fs');
const path = require('path');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const DIST_DIR = path.join(HOOKS_DIR, 'dist');

// Hooks to copy (pure Node.js, no bundling needed)
const HOOKS_TO_COPY = [
  'nf-check-update.js',
  'nf-statusline.js',
  'nf-prompt.js',      // nForma: UserPromptSubmit quorum injection hook
  'nf-stop.js',        // nForma: Stop quorum verification gate
  'nf-circuit-breaker.js', // nForma: PreToolUse oscillation detection and state persistence
  'nf-session-start.js',   // nForma: SessionStart hook
  'nf-precompact.js',      // nForma: PreCompact hook
  'nf-spec-regen.js',      // nForma: PostToolUse spec regeneration
  'nf-token-collector.js', // nForma: SubagentStop token collection
  'nf-slot-correlator.js', // nForma: SubagentStart slot correlation
  'nf-slot-health-probe.js', // nForma: SessionStart quorum slot responsiveness probe
  'nf-context-monitor.js', // nForma: PostToolUse context monitoring
  'nf-post-edit-format.js',  // nForma: PostToolUse edit formatting
  'nf-console-guard.js',     // nForma: Stop console guard
  'nf-destructive-git-guard.js', // nForma: PreToolUse destructive git ops warning
  'nf-scope-guard.js',           // nForma: PreToolUse scope contract advisory
  'nf-mcp-dispatch-guard.js',    // nForma: PreToolUse MCP dispatch warning
  'nf-node-eval-guard.js',       // nForma: PreToolUse node -e → heredoc rewriter (zsh safety)
  'nf-session-end.js',       // nForma: SessionEnd learning extraction
  'nf-resolve-bin.js',       // shared nf-bin path resolver (required by multiple hooks)
  'config-loader.js',       // shared config loader (required by multiple hooks)
  'conformance-schema.cjs', // shared conformance schema (required by nf-prompt, nf-stop, nf-circuit-breaker)
];

// Exported so bin/install.js can check dist COMPLETENESS (not just existence)
// without duplicating this list. See buildHooksIfMissing() — a partially
// populated hooks/dist/ (e.g. a fresh clone where only some dist files are
// tracked) must trigger a rebuild, or the installer silently ships fewer hooks
// than the product needs.
module.exports = { HOOKS_TO_COPY };

function build() {
  // Ensure dist directory exists
  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }

  // Copy hooks to dist
  for (const hook of HOOKS_TO_COPY) {
    const src = path.join(HOOKS_DIR, hook);
    const dest = path.join(DIST_DIR, hook);

    if (!fs.existsSync(src)) {
      console.warn(`Warning: ${hook} not found, skipping`);
      continue;
    }

    console.log(`Copying ${hook}...`);
    fs.copyFileSync(src, dest);
    console.log(`  → ${dest}`);
  }

  console.log('\nBuild complete.');
}

// Only build when invoked directly (`node scripts/build-hooks.js`). Requiring
// this module — bin/install.js does, to read HOOKS_TO_COPY — must not have the
// side effect of writing to hooks/dist/.
if (require.main === module) {
  build();
}

#!/usr/bin/env node
/**
 * lint-isolation.js
 *
 * Guards against non-portable paths in nForma skill files. Scans both
 * `commands/nf/` and `core/workflows/`.
 *
 * Rules:
 * 1. NF interference: no /get-shit-done/ directory segments (use ~/.claude/nf/)
 * 2. Portable require: no require('./bin/...') — use $HOME/.claude/nf-bin/ with CWD fallback
 * 3. Portable dispatch: no bare "commands/nf/" in Agent prompts — use $HOME/.claude/commands/nf/
 * 4. Absolute home path: no literal /Users/<name>/.claude or /home/<name>/.config —
 *    use ~/ or $HOME (the installer expands these per-user; literal paths ship verbatim)
 * 5. Inline-eval env/arg placement: nothing may trail an inline `node -e "<js>"`
 *    except a redirect/operator (see bin/skill-eval-lint.cjs for the standard).
 * 6. MCP tool names: CLI-slot tool refs must use the real `<family>-<N>` slot and a
 *    tool the server exposes (see bin/skill-mcp-lint.cjs).
 *
 * These patterns break when nForma is used in repos other than the NF source repo,
 * because ./bin/ and commands/nf/ only exist locally in the source checkout, and a
 * hardcoded home path only exists on the author's machine.
 */

const fs = require('fs');
const path = require('path');
const { findEvalTrailingViolations } = require('../bin/skill-eval-lint.cjs');
const { findMcpToolViolations } = require('../bin/skill-mcp-lint.cjs');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['commands/nf', 'core/workflows'];

// --- Rule definitions ---
const RULES = [
  {
    id: 'nf-interference',
    re: /\/get-shit-done\//g,
    message: 'Must not reference /get-shit-done/ paths — use ~/.claude/nf/',
  },
  {
    id: 'portable-require',
    // require('./bin/...') without a preceding fallback resolution pattern
    // Matches: require('./bin/foo.cjs') but NOT require(stPath) or require(installed)
    re: /require\('\.\/(bin\/[^']+)'\)/g,
    message: "Non-portable require('./bin/...') — use $HOME/.claude/nf-bin/ with CWD fallback",
  },
  {
    id: 'portable-dispatch',
    // "Read and follow commands/nf/" without $HOME or ~ prefix in Agent prompts
    // Matches: Read and follow commands/nf/solve-diagnose.md
    // Does NOT match: $HOME/.claude/commands/nf/ or ~/.claude/commands/nf/
    re: /(?:Read and follow|read and follow)\s+commands\/nf\//g,
    message: 'Non-portable Agent dispatch — use $HOME/.claude/commands/nf/ with CWD fallback',
  },
  {
    id: 'absolute-home-path',
    // Literal /Users/<name>/.claude/... or /home/<name>/.config/... home paths
    // are non-portable: they ship verbatim and break on every other user's
    // machine (install does NOT rewrite them). Use ~/ or $HOME instead, which
    // the installer expands per-user.
    re: /\/(?:Users|home)\/[A-Za-z0-9._-]+\/\.(?:claude|config)\b/g,
    message: 'Non-portable absolute home path (e.g. /Users/<name>/.claude or /home/<name>/.config) — use a ~/ or $HOME-relative path instead',
  },
];

// --- providers.json resolver isolation (issue #197) ---
// Forbids inline providers.json path construction and require('./providers.json')
// in bin/ JS files. All resolution must route through bin/resolve-providers.cjs.
const PROVIDERS_RULES = [
  {
    id: 'providers-inline-path',
    // path.join(... 'providers.json')  — any inline construction of the file path.
    re: /path\.join\([^;\n]*['"]providers\.json['"]\s*\)/,
    message:
      "Inline providers.json path construction — use loadProviders()/resolveProvidersConfig() from bin/resolve-providers.cjs",
  },
  {
    id: 'providers-direct-require',
    // require('./providers.json') or require('./bin/providers.json')
    re: /require\(\s*['"]\.\/(?:bin\/)?providers\.json['"]\s*\)/,
    message:
      "Direct require() of providers.json — use loadProviders() from bin/resolve-providers.cjs",
  },
];

// Files allowed to construct the providers.json path directly. Every entry is a
// WRITER or a path-management tool — read-resolution must go through
// resolve-providers.cjs (the #197/#218 single source of truth).
//   resolve-providers.cjs  — the single source of truth itself
//   unified-mcp-server.mjs — bootstrap last-resort empty-warning fallback
//   install.js             — creates/writes/symlinks the file at install time
//   install-helpers.cjs    — synthesizeMcpEntry builds the canonical install-time
//                            UNIFIED_PROVIDERS_CONFIG write-path (moved out of install.js, #200)
//   manage-agents-core.cjs — read/write path must stay coupled (writes the file)
//   nForma.cjs             — the TUI/CLI that adds & edits slots (writes the file)
//   migrate-plaintext-tokens.cjs — one-off migration tool that intentionally
//                            scans LEGACY locations (nf/bin) to rewrite plaintext
//                            tokens in place; not a dispatch-pipeline read.
const PROVIDERS_ALLOWLIST = new Set([
  'bin/resolve-providers.cjs',
  'bin/unified-mcp-server.mjs',
  'bin/install.js',
  'bin/install-helpers.cjs',
  'bin/manage-agents-core.cjs',
  'bin/nForma.cjs',
  'bin/migrate-plaintext-tokens.cjs',
]);

const violations = [];

function scanProvidersIsolation() {
  const binDir = path.join(ROOT, 'bin');
  const entries = fs.readdirSync(binDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!/\.(cjs|mjs|js)$/.test(name)) continue;
    if (name.endsWith('.test.cjs') || name.endsWith('.test.js') || name.endsWith('.test.mjs')) continue;
    const rel = path.posix.join('bin', name);
    if (PROVIDERS_ALLOWLIST.has(rel)) continue;
    const lines = fs.readFileSync(path.join(binDir, name), 'utf8').split('\n');
    lines.forEach((line, i) => {
      // Ignore comment lines so doc references to the canonical path don't trip the rule.
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      for (const rule of PROVIDERS_RULES) {
        if (rule.re.test(line)) {
          violations.push({
            rule: rule.id,
            message: rule.message,
            file: rel,
            line: i + 1,
            text: trimmed,
          });
        }
      }
    });
  }
}

function scan(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scan(full);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const content = fs.readFileSync(full, 'utf8');
      const rel = path.relative(ROOT, full);
      content.split('\n').forEach((line, i) => {
        for (const rule of RULES) {
          rule.re.lastIndex = 0;
          if (rule.re.test(line)) {
            violations.push({
              rule: rule.id,
              message: rule.message,
              file: rel,
              line: i + 1,
              text: line.trim(),
            });
          }
        }
      });
      // Rule 5 — inline-eval env/arg placement (multi-line; see skill-eval-lint.cjs)
      for (const v of findEvalTrailingViolations(content, rel)) {
        violations.push({
          rule: v.rule,
          message: v.rule === 'eval-env-after'
            ? 'env assignment AFTER `node -e` is argv, not env (process.env undefined) — move it BEFORE node'
            : 'argument AFTER `node -e` breaks the eval-guard heredoc rewrite — pass it via an env var read with process.env',
          file: v.file,
          line: v.line,
          text: v.text,
        });
      }
      // Rule 6 — MCP tool references for CLI slots (see skill-mcp-lint.cjs)
      for (const v of findMcpToolViolations(content, rel)) {
        violations.push({
          rule: v.rule,
          message: v.rule === 'mcp-stale-slot'
            ? 'stale MCP slot name — use the real `<family>-<N>` slot (e.g. codex-1, gemini-1, copilot-1, opencode-1)'
            : 'unknown MCP tool for this slot family — use a tool the server actually exposes',
          file: v.file,
          line: v.line,
          text: `${v.ref}  (${v.hint})`,
        });
      }
    }
  }
}

for (const dir of SCAN_DIRS) {
  scan(path.join(ROOT, dir));
}

scanProvidersIsolation();

if (violations.length === 0) {
  console.log('✓ lint-isolation: all portable-path checks passed');
  process.exit(0);
} else {
  console.error(`✗ lint-isolation: ${violations.length} violation(s) found\n`);
  // Group by rule
  const byRule = {};
  for (const v of violations) {
    (byRule[v.rule] ||= []).push(v);
  }
  for (const [rule, items] of Object.entries(byRule)) {
    console.error(`  [${rule}] ${items[0].message}`);
    for (const v of items) {
      console.error(`    ${v.file}:${v.line}`);
      console.error(`      ${v.text}`);
    }
    console.error('');
  }
  process.exit(1);
}

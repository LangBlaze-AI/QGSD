'use strict';

/**
 * resolve-cli.cjs — CLI path resolution utility
 *
 * Resolves a bare CLI name to its full executable path using a priority-ordered search:
 *   1. which <name>       — system PATH lookup
 *   2. Homebrew prefixes  — /opt/homebrew/bin, /usr/local/bin
 *   3. npm global bin     — derived from `npm root -g`
 *   4. Common system paths — /usr/bin, /usr/local/bin
 *   5. Bare fallback      — return name unchanged (let OS resolve at spawn time)
 *
 * Never throws. Always returns a non-empty string.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Resolve a CLI name to its full executable path.
 * @param {string} name - bare name like "codex", "gemini", "opencode"
 * @returns {string} full path like "/opt/homebrew/bin/codex" or bare name if not found
 */
function resolveCli(name) {
  if (typeof name !== 'string' || !name) return '';

  // 1. which <name>
  try {
    const result = spawnSync('which', [name], { encoding: 'utf8', timeout: 3000 });
    if (result.status === 0 && result.stdout) {
      const found = result.stdout.trim();
      if (found && found.length > 0) {
        return found;
      }
    }
  } catch (_) {
    // which failed — continue to next strategy
  }

  // 2. Known Homebrew prefixes
  const homebrewPrefixes = ['/opt/homebrew/bin', '/usr/local/bin'];
  for (const prefix of homebrewPrefixes) {
    const candidate = path.join(prefix, name);
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch (_) {
      // fs error — continue
    }
  }

  // 3. npm global bin: npm root -g -> ../bin/<name>
  try {
    const npmResult = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000 });
    if (npmResult.status === 0 && npmResult.stdout) {
      const npmRoot = npmResult.stdout.trim();
      if (npmRoot) {
        const candidate = path.join(npmRoot, '..', 'bin', name);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  } catch (_) {
    // npm failed — continue
  }

  // 4. Common system paths (deduplicated — /usr/local/bin was checked in step 2)
  const systemPaths = ['/usr/bin'];
  for (const dir of systemPaths) {
    const candidate = path.join(dir, name);
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch (_) {
      // continue
    }
  }

  // 5. Fallback: return bare name (let OS resolve at spawn time)
  return name;
}

/**
 * Resolve the spawn target (executable) for a provider entry.
 *
 * Single source of truth for the chain that ~5 call sites re-implemented with
 * divergent semantics — the null-CLI bug class (#161 #164 #180 #193). Some sites
 * used raw `provider.cli` (which is null when only `mainTool` is present, handing
 * null to child_process.spawn → ENOENT, false-dead at ~1ms). Others used
 * `resolvedCli || cli || mainTool` inconsistently.
 *
 * Order:
 *   1. provider.resolvedCli — absolute path resolved earlier (preferred)
 *   2. resolveCli(provider.cli || provider.mainTool) — resolve the bare name to
 *      an absolute path; `cli` is optional in providers.json, fall back to mainTool
 *
 * Returns an empty string only when the provider has no cli, mainTool, AND
 * resolvedCli — the caller must treat '' as "no resolvable CLI".
 *
 * @param {object} provider - a providers.json entry
 * @returns {string} absolute path or bare name; '' when nothing is resolvable.
 */
function resolveSpawnTarget(provider) {
  if (!provider || typeof provider !== 'object') return '';
  if (typeof provider.resolvedCli === 'string' && provider.resolvedCli) return provider.resolvedCli;
  const bare = provider.cli || provider.mainTool;
  if (!bare) return '';
  return resolveCli(bare);
}

module.exports = { resolveCli, resolveSpawnTarget };

// ---------------------------------------------------------------------------
// Standalone CLI interface
// ---------------------------------------------------------------------------

if (require.main === module) {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: node bin/resolve-cli.cjs <name>');
    process.exit(1);
  }
  const resolved = resolveCli(name);
  console.log(resolved);
}

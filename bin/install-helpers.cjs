'use strict';

/**
 * install-helpers.cjs — pure helpers extracted from install.js for unit testability.
 *
 * The main install.js is a long imperative CLI; functions in here are isolated so they
 * can be exercised by node --test without spawning a real install.
 */

const fs = require('fs');

/**
 * Merge the repo's providers.json into the user's installed copy, preserving user-added
 * entries. The repo source (`bin/providers.json`) ships the canonical default fleet; users
 * extend it via /nf:link-canopy fan-out (Daintree presets), /nf:mcp-setup (manual ccr-* etc.),
 * or hand-editing.
 *
 * Merge rules:
 *   - Provider entries present in the repo source: REPLACED with the repo version (so metadata
 *     bumps in description/mainTool/model defaults propagate on update).
 *   - Provider entries present ONLY in the user's copy (no name match in repo): PRESERVED
 *     verbatim, appended after the repo entries. This covers fan-out preset slots
 *     (those carrying `daintree_preset_id`), user-added ccr-* slots (Together.xyz routing
 *     was retired from the default fleet), and any hand-rolled custom slots.
 *   - Top-level providers.json fields other than `providers` are merged shallowly with repo
 *     winning. Today the file is `{providers: [...]}` only, so this is effectively a no-op.
 *
 * Fail-open: any read/parse error on either side falls back to the original copy semantics
 * (overwrite the user's file with the repo version) so installs never wedge on a corrupt file.
 *
 * @param {string} repoPath - absolute path to bin/providers.json in the repo source
 * @param {string} userPath - absolute path to the user's installed copy
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log] - optional log sink (defaults to no-op)
 * @returns {{ status: 'merged' | 'fresh-copy' | 'fallback-copy' | 'error', preservedCount: number, preservedNames: string[] }}
 */
function mergeProvidersJson(repoPath, userPath, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  let repoData;
  try {
    repoData = JSON.parse(fs.readFileSync(repoPath, 'utf8'));
  } catch (e) {
    log(`providers.json: could not read repo source (${e.message}); skipping copy`);
    return { status: 'error', preservedCount: 0, preservedNames: [] };
  }

  // First-time install or user file missing → straight copy
  if (!fs.existsSync(userPath)) {
    fs.copyFileSync(repoPath, userPath);
    return { status: 'fresh-copy', preservedCount: 0, preservedNames: [] };
  }

  let userData;
  try {
    userData = JSON.parse(fs.readFileSync(userPath, 'utf8'));
  } catch (e) {
    log(`providers.json: user copy unreadable (${e.message}); replacing with repo source`);
    fs.copyFileSync(repoPath, userPath);
    return { status: 'fallback-copy', preservedCount: 0, preservedNames: [] };
  }

  const repoProviders = Array.isArray(repoData.providers) ? repoData.providers : [];
  const userProviders = Array.isArray(userData.providers) ? userData.providers : [];
  const repoNames = new Set(repoProviders.map(p => p && p.name).filter(Boolean));

  // Preserved: user entries whose name doesn't appear in the repo source.
  const userExtras = userProviders.filter(p => p && p.name && !repoNames.has(p.name));

  const merged = {
    ...userData,    // start with user's top-level fields
    ...repoData,    // repo wins on top-level (e.g. schema_version) — same shape today
    providers: [...repoProviders, ...userExtras],
  };

  // Atomic write (avoid leaving a half-written file if power-cuts mid-merge)
  const tmpPath = userPath + '.merge.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, userPath);

  const preservedNames = userExtras.map(p => p.name);
  if (preservedNames.length > 0) {
    log(`providers.json: merged repo defaults; preserved ${preservedNames.length} user-added slot(s): ${preservedNames.join(', ')}`);
  }
  return { status: 'merged', preservedCount: preservedNames.length, preservedNames };
}

module.exports = { mergeProvidersJson };

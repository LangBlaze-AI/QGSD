'use strict';

/**
 * install-helpers.cjs — pure helpers extracted from install.js for unit testability.
 *
 * The main install.js is a long imperative CLI; functions in here are isolated so they
 * can be exercised by node --test without spawning a real install.
 */

const fs = require('fs');
const path = require('path');

// ── Issue #200: install unified-mcp-server.mjs into ~/.claude/nf-bin/ and point
// every mcpServers slot at that INSTALLED copy, never the repo working tree. ──

// Runtime .mjs files that must be copied into nf-bin/ (the copy loop's primary
// filter is the generic `*.cjs` match; these are the non-.cjs runtime files).
const NF_BIN_RUNTIME_MJS = new Set(['unified-mcp-server.mjs', 'proximity-embed.mjs']);

// Bundled non-code DATA files a runtime script loads by path relative to itself
// (e.g. sast-sweep.cjs resolves sast-rules.yaml via __dirname). Without this they
// never land in nf-bin/ and the installed sweep silently fails to find its ruleset.
const NF_BIN_RUNTIME_DATA = new Set(['sast-rules.yaml']);

// True for a plain object (excludes null, arrays, and primitives). Shared guard so the
// "deref a non-object" crash class (providers entries, preset entries, preset.env) is
// closed in ONE place rather than pasted per call-site.
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Decide whether a top-level bin/ entry should be copied into nf-bin/.
// providers.json is handled separately (merge semantics) and is NOT returned here.
function shouldCopyToNfBin(entry) {
  if (typeof entry !== 'string') return false;
  if (entry === 'providers.json') return false;
  if (entry.endsWith('.cjs')) return true;
  if (NF_BIN_RUNTIME_MJS.has(entry)) return true;
  if (NF_BIN_RUNTIME_DATA.has(entry)) return true;
  return false;
}

// Absolute path to the installed unified-mcp-server under a given nf-bin dir.
function installedUnifiedMcpPath(claudeHomeDir) {
  return path.join(claudeHomeDir, 'nf-bin', 'unified-mcp-server.mjs');
}

// True when `argPath` resolves to a file inside `installDir` (the nf-bin dir).
// Uses path.relative so `..` segments / sibling dirs are rejected.
function isUnderInstallDir(argPath, installDir) {
  if (!argPath || !installDir) return false;
  const rel = path.relative(path.resolve(installDir), path.resolve(argPath));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Build the mcpServers entry for a provider, with args pointing at the INSTALLED
// unified-mcp-server copy under nf-bin (never the repo working tree).
function synthesizeMcpEntry(providerName, claudeHomeDir) {
  const nfBinDir = path.join(claudeHomeDir, 'nf-bin');
  return {
    type: 'stdio',
    command: 'node',
    args: [installedUnifiedMcpPath(claudeHomeDir)],
    env: {
      PROVIDER_SLOT: providerName,
      UNIFIED_PROVIDERS_CONFIG: path.join(nfBinDir, 'providers.json'),
    },
  };
}

// True when an mcpServers entry's args[0] points at unified-mcp-server.mjs but is
// NOT under the installed nf-bin dir — i.e. it's still bound to the repo working
// tree or an npx cache and must be repointed at the installed copy (issue #200).
function mcpArgsNeedMigration(args0, nfBinDir) {
  return typeof args0 === 'string'
    && args0.endsWith('unified-mcp-server.mjs')
    && !isUnderInstallDir(args0, nfBinDir);
}

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

  // First-time install or user file missing → straight copy.
  // Fail open if the copy can't land (e.g. missing parent dir) — never wedge the install.
  if (!fs.existsSync(userPath)) {
    try {
      fs.copyFileSync(repoPath, userPath);
      return { status: 'fresh-copy', preservedCount: 0, preservedNames: [] };
    } catch (e) {
      log(`providers.json: could not write user copy (${e.message}); skipping`);
      return { status: 'error', preservedCount: 0, preservedNames: [] };
    }
  }

  let userData;
  try {
    userData = JSON.parse(fs.readFileSync(userPath, 'utf8'));
  } catch (e) {
    log(`providers.json: user copy unreadable (${e.message}); replacing with repo source`);
    try {
      fs.copyFileSync(repoPath, userPath);
      return { status: 'fallback-copy', preservedCount: 0, preservedNames: [] };
    } catch (e2) {
      // The recovery copy itself can throw (e.g. userPath is a directory → EISDIR).
      // Fail open rather than wedge the installer from the corruption-recovery path.
      log(`providers.json: could not overwrite user copy (${e2.message}); skipping`);
      return { status: 'error', preservedCount: 0, preservedNames: [] };
    }
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

  const preservedNames = userExtras.map(p => p.name);

  // Atomic write with cleanup-on-failure: never leave a half-written .merge.tmp behind,
  // and never let a rename failure (EXDEV cross-device, EACCES) wedge the install.
  const tmpPath = userPath + '.merge.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, userPath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* tmp may not have been created */ }
    log(`providers.json: could not persist merged file (${e.message}); skipping`);
    return { status: 'error', preservedCount: preservedNames.length, preservedNames };
  }

  if (preservedNames.length > 0) {
    log(`providers.json: merged repo defaults; preserved ${preservedNames.length} user-added slot(s): ${preservedNames.join(', ')}`);
  }
  return { status: 'merged', preservedCount: preservedNames.length, preservedNames };
}

/**
 * Restore daintree preset entries from the install-immune store (~/.claude/daintree-presets.json).
 *
 * During install, ensureMcpSlotsFromProviders reconstructs providers.json from ~/.claude.json
 * mcpServers — but that source lacks daintree-specific metadata (daintree_preset_id, env overrides,
 * model overrides, display_provider). This function overlays the preset metadata from the durable
 * store onto the reconstructed providers array.
 *
 * Two restoration modes:
 *   1. Slot exists but is stripped (missing daintree_preset_id) → overlay metadata
 *   2. Slot is entirely missing → reconstruct from vanilla + preset store
 *
 * @param {Array} providers - the reconstructed providers array (mutated in place)
 * @param {string} presetsStorePath - path to ~/.claude/daintree-presets.json
 * @returns {{ restoredCount: number, restoredNames: string[] }}
 */
function restoreDaintreePresets(providers, presetsStorePath) {
  if (!Array.isArray(providers)) return { restoredCount: 0, restoredNames: [] };

  let presetsStore;
  try {
    presetsStore = JSON.parse(fs.readFileSync(presetsStorePath, 'utf8'));
  } catch (_) {
    return { restoredCount: 0, restoredNames: [] };
  }
  if (!presetsStore || !presetsStore.presets) return { restoredCount: 0, restoredNames: [] };

  const byName = new Map(
    providers.filter(isPlainObject).map(p => [p.name, p])
  );
  const restoredNames = [];

  for (const [slotName, preset] of Object.entries(presetsStore.presets)) {
    if (!isPlainObject(preset)) continue; // skip null/non-object preset entries
    const existing = byName.get(slotName);
    if (existing) {
      if (!existing.daintree_preset_id && preset.daintree_preset_id) {
        existing.daintree_preset_id = preset.daintree_preset_id;
        if (preset.daintree_preset_name) existing.daintree_preset_name = preset.daintree_preset_name;
        if (preset.daintree_preset_family) existing.daintree_preset_family = preset.daintree_preset_family;
        if (isPlainObject(preset.env)) {
          existing.env = { ...(existing.env || {}), ...preset.env };
        }
        if (preset.model) existing.model = preset.model;
        if (preset.display_provider) existing.display_provider = preset.display_provider;
        restoredNames.push(slotName);
      }
    } else if (preset.daintree_preset_id) {
      // Mirror the overlay branch's truthiness guard: a preset with no real id can't be
      // tracked idempotently, so don't reconstruct a half-baked slot for it.
      const vanilla = preset.vanilla_slot_name ? byName.get(preset.vanilla_slot_name) : null;
      if (vanilla) {
        const reconstructed = JSON.parse(JSON.stringify(vanilla));
        reconstructed.name = slotName;
        reconstructed.mainTool = preset.agent_name || reconstructed.mainTool;
        reconstructed.daintree_preset_id = preset.daintree_preset_id;
        reconstructed.daintree_preset_name = preset.daintree_preset_name;
        if (preset.daintree_preset_family) reconstructed.daintree_preset_family = preset.daintree_preset_family;
        const presetEnv = isPlainObject(preset.env) ? preset.env : {};
        reconstructed.env = { ...(vanilla.env || {}), ...presetEnv };
        if (preset.model) reconstructed.model = preset.model;
        if (preset.display_provider) reconstructed.display_provider = preset.display_provider;
        const descBase = vanilla.description || '';
        reconstructed.description = preset.daintree_preset_name
          ? `${descBase} — Daintree preset: ${preset.daintree_preset_name}`
          : descBase;
        providers.push(reconstructed);
        byName.set(slotName, reconstructed);
        restoredNames.push(slotName);
      }
    }
  }

  return { restoredCount: restoredNames.length, restoredNames };
}

module.exports = {
  mergeProvidersJson,
  restoreDaintreePresets,
  NF_BIN_RUNTIME_MJS,
  shouldCopyToNfBin,
  installedUnifiedMcpPath,
  isUnderInstallDir,
  mcpArgsNeedMigration,
  synthesizeMcpEntry,
  isPlainObject,
};

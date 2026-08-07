#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// SLOT_MIGRATION_MAP: old model-based names → new slot names
const SLOT_MIGRATION_MAP = {
  'codex-cli':         'codex-cli-1',
  'gemini-cli':        'gemini-cli-1',
  'opencode':          'opencode-1',
  'copilot-cli':       'copilot-1',
  'claude-deepseek':   'claude-1',
  'claude-minimax':    'claude-2',
  'claude-qwen-coder': 'claude-3',
  'claude-kimi':       'claude-4',
  'claude-llama4':     'claude-5',
  'claude-glm':        'claude-6',
};

// MIGRATE-GUARD-01: `claude-minimax` / `claude-kimi` / `claude-glm` are legacy
// MODEL-based names above — but they are also exactly the shape `/nf:link-daintree`
// produces today (`{agentName}-{slug(preset.name)}`), so a live preset-cloned slot can
// carry a name this map wants to rename. Renaming one silently breaks it: the mcpServers
// key moves to `claude-2` while providers.json still lists `claude-minimax`, leaving an
// orphaned provider entry and an MCP tool (`mcp__claude-minimax__…`) that no longer
// exists. Preset clones are identifiable — link-daintree stamps `daintree_preset_id` —
// so they are never renamed. See commands/nf/link-daintree.md.
function loadProviderIndex(providersPath) {
  // Resolution goes through resolve-providers.cjs (issue #197) so this agrees with the
  // file the dispatcher actually reads; an explicit path is honored for tests.
  try {
    let p = providersPath;
    let data;
    if (p) {
      data = JSON.parse(fs.readFileSync(p, 'utf8'));
    } else {
      const { resolveProvidersConfig } = require('./resolve-providers.cjs');
      const resolved = resolveProvidersConfig({ baseDir: __dirname, quiet: true });
      if (!resolved) return { path: null, byName: new Map() };
      p = resolved.path;
      data = resolved.data;
    }
    const list = Array.isArray(data && data.providers) ? data.providers : [];
    return { path: p, byName: new Map(list.map(e => [e && e.name, e])) };
  } catch (_) {
    // Fail-open: no providers.json (fresh/legacy install) means nothing to protect
    // and nothing to keep in sync — the pre-slot world this migration was written for.
    return { path: providersPath || null, byName: new Map() };
  }
}

/**
 * Migrate ~/.claude.json mcpServers keys from model-based names to slot names.
 * @param {string} claudeJsonPath - Absolute path to ~/.claude.json
 * @param {boolean} dryRun - If true, do not write changes
 * @param {object} [opts]
 * @param {string} [opts.providersPath] - providers.json to consult/keep in sync
 *        (defaults to the canonical ~/.claude/nf-bin/providers.json)
 * @returns {{changed: number, renamed: Array<{from: string, to: string}>,
 *            skipped: Array<{name: string, reason: string}>}}
 */
function migrateClaudeJson(claudeJsonPath, dryRun = false, opts = {}) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { changed: 0, renamed: [], skipped: [] };
    }
    throw new Error(`Failed to read ${claudeJsonPath}: ${e.message}`);
  }

  const servers = (raw && typeof raw === 'object' && raw.mcpServers) || {};
  const providers = loadProviderIndex(opts.providersPath);
  let changed = 0;
  const renamed = [];
  const skipped = [];
  let providersDirty = false;

  for (const [oldName, newName] of Object.entries(SLOT_MIGRATION_MAP)) {
    if (servers[oldName] !== undefined && servers[newName] === undefined) {
      const entry = providers.byName.get(oldName);
      if (entry && entry.daintree_preset_id) {
        // A live preset clone that happens to collide with a legacy model name.
        skipped.push({ name: oldName, reason: 'daintree preset slot — renaming would orphan it' });
        continue;
      }
      // Rename: assign to new key, delete old key
      servers[newName] = servers[oldName];
      delete servers[oldName];
      changed++;
      renamed.push({ from: oldName, to: newName });
      // Keep providers.json in lockstep. Renaming only the mcpServers key leaves the
      // provider entry pointing at a slot name that no longer resolves.
      if (entry) { entry.name = newName; providersDirty = true; }
    }
    // oldName absent + newName present → already migrated (skip, idempotent)
    // both present → skip (safety — don't overwrite)
  }

  if (changed > 0) {
    raw.mcpServers = servers;
    if (!dryRun) {
      const tmpPath = claudeJsonPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
      fs.renameSync(tmpPath, claudeJsonPath);
      if (providersDirty) {
        try {
          const data = JSON.parse(fs.readFileSync(providers.path, 'utf8'));
          for (const e of data.providers || []) {
            const r = renamed.find(x => x.from === e.name);
            if (r) e.name = r.to;
          }
          const tmp = providers.path + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
          fs.renameSync(tmp, providers.path);
        } catch (e) {
          // Non-fatal: the mcpServers rename already landed. Surface it so the user can
          // fix the pairing by hand rather than discovering a dead slot mid-quorum.
          process.stderr.write(`[migrate-to-slots] WARN: renamed mcpServers keys but could not update ${providers.path}: ${e.message}\n`);
        }
      }
    }
  }

  return { changed, renamed, skipped };
}

// tool_prefix migration map for nf.json
const NF_PREFIX_MAP = {
  'mcp__codex-cli__':   'mcp__codex-cli-1__',
  'mcp__gemini-cli__':  'mcp__gemini-cli-1__',
  'mcp__opencode__':    'mcp__opencode-1__',
  'mcp__copilot-cli__': 'mcp__copilot-1__',
};

/**
 * Migrate ~/.claude/nf.json required_models tool_prefix values to slot-based prefixes.
 * @param {string} nfJsonPath - Absolute path to ~/.claude/nf.json
 * @param {boolean} dryRun - If true, do not write changes
 * @returns {{ changed: number, patched: Array<{key: string, from: string, to: string}> }}
 */
function migrateNfJson(nfJsonPath, dryRun = false) {
  if (!fs.existsSync(nfJsonPath)) {
    return { changed: 0, patched: [] };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(nfJsonPath, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to read ${nfJsonPath}: ${e.message}`);
  }

  const requiredModels = raw.required_models;
  if (!requiredModels || typeof requiredModels !== 'object') {
    return { changed: 0, patched: [] };
  }

  let changed = 0;
  const patched = [];

  for (const [modelKey, modelDef] of Object.entries(requiredModels)) {
    if (modelDef && typeof modelDef.tool_prefix === 'string') {
      const newPrefix = NF_PREFIX_MAP[modelDef.tool_prefix];
      if (newPrefix) {
        patched.push({ key: modelKey, from: modelDef.tool_prefix, to: newPrefix });
        modelDef.tool_prefix = newPrefix;
        changed++;
      }
    }
  }

  if (changed > 0 && !dryRun) {
    fs.writeFileSync(nfJsonPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  }

  return { changed, patched };
}

/**
 * Populate quorum_active in ~/.claude/nf.json from current mcpServers in ~/.claude.json.
 * Idempotent: skips if quorum_active already present and non-empty.
 * @param {string} nfJsonPath - Absolute path to ~/.claude/nf.json
 * @param {string} claudeJsonPath - Absolute path to ~/.claude.json
 * @param {boolean} dryRun - If true, do not write changes
 * @returns {{ skipped: boolean, slots: string[] }}
 */
function populateActiveSlots(nfJsonPath, claudeJsonPath, dryRun = false) {
  // Read current slot names from ~/.claude.json
  let slotNames = [];
  try {
    const raw = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    slotNames = Object.keys(raw.mcpServers || {});
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Failed to read ${claudeJsonPath}: ${e.message}`);
    // ~/.claude.json absent — nothing to populate
    return { skipped: true, slots: [] };
  }

  // Read or create nf.json
  let nfConfig = {};
  try {
    nfConfig = JSON.parse(fs.readFileSync(nfJsonPath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Failed to read ${nfJsonPath}: ${e.message}`);
    // nf.json absent — create minimal object
  }

  if (!nfConfig || typeof nfConfig !== 'object' || Array.isArray(nfConfig)) {
    nfConfig = {};
  }
  // Idempotent: skip if already set and non-empty
  if (Array.isArray(nfConfig.quorum_active) && nfConfig.quorum_active.length > 0) {
    return { skipped: true, slots: nfConfig.quorum_active };
  }

  // Populate and write
  nfConfig.quorum_active = slotNames;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(nfJsonPath), { recursive: true });
    fs.writeFileSync(nfJsonPath, JSON.stringify(nfConfig, null, 2) + '\n', 'utf8');
  }
  return { skipped: false, slots: slotNames };
}

// CLI entrypoint
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  const nfJsonPath = path.join(os.homedir(), '.claude', 'nf.json');

  let r1, r2;
  try {
    r1 = migrateClaudeJson(claudeJsonPath, dryRun);
  } catch (e) {
    console.error(`Error migrating ~/.claude.json: ${e.message}`);
    process.exit(1);
  }

  try {
    r2 = migrateNfJson(nfJsonPath, dryRun);
  } catch (e) {
    console.error(`Error migrating ~/.claude/nf.json: ${e.message}`);
    process.exit(1);
  }

  let r3;
  try {
    r3 = populateActiveSlots(nfJsonPath, claudeJsonPath, dryRun);
    if (!r3.skipped) {
      console.log(`[migrate-to-slots] quorum_active populated: ${r3.slots.join(', ')}`);
    } else {
      console.log(`[migrate-to-slots] quorum_active already set (${r3.slots.length} slots) — skipped`);
    }
  } catch (e) {
    console.error(`Error populating quorum_active: ${e.message}`);
    process.exit(1);
  }

  if (r1.changed === 0 && r2.changed === 0) {
    console.log('Already migrated — no changes needed');
  } else if (dryRun) {
    const totalRenames = r1.renamed.length + r2.patched.length;
    console.log(`[DRY RUN] Would rename ${totalRenames} entries:`);
    for (const { from, to } of r1.renamed) {
      console.log(`  mcpServers: ${from} → ${to}`);
    }
    for (const { key, from, to } of r2.patched) {
      console.log(`  nf.json required_models.${key}.tool_prefix: ${from} → ${to}`);
    }
  } else {
    if (r1.changed > 0) {
      console.log(`Migrated ${r1.changed} mcpServers entries:`);
      for (const { from, to } of r1.renamed) {
        console.log(`  ${from} → ${to}`);
      }
    }
    if (r2.changed > 0) {
      console.log(`Patched ${r2.changed} nf.json tool_prefix values`);
      for (const { key, from, to } of r2.patched) {
        console.log(`  required_models.${key}.tool_prefix: ${from} → ${to}`);
      }
    }
  }

  process.exit(0);
}

/**
 * Append a single slot name to quorum_active in nf.json if not already present.
 * Idempotent: no-op if slot is already in the array.
 * @param {string} slotName - e.g. "copilot-2"
 * @param {string} nfJsonPath - path to ~/.claude/nf.json
 * @param {boolean} dryRun - if true, report but do not write
 * @returns {{ added: boolean, slot: string, skipped: boolean }}
 */
function addSlotToQuorumActive(slotName, nfJsonPath, dryRun = false) {
  let nfConfig = {};
  try {
    if (fs.existsSync(nfJsonPath)) {
      nfConfig = JSON.parse(fs.readFileSync(nfJsonPath, 'utf8'));
    }
  } catch (e) {
    return { added: false, slot: slotName, skipped: true, error: e.message };
  }

  if (!nfConfig || typeof nfConfig !== 'object' || Array.isArray(nfConfig)) {
    nfConfig = {};
  }
  const active = Array.isArray(nfConfig.quorum_active) ? nfConfig.quorum_active : [];
  if (active.includes(slotName)) {
    return { added: false, slot: slotName, skipped: true, reason: 'already present' };
  }

  if (dryRun) {
    return { added: true, slot: slotName, skipped: false, dryRun: true };
  }

  nfConfig.quorum_active = [...active, slotName];
  fs.writeFileSync(nfJsonPath, JSON.stringify(nfConfig, null, 2) + '\n');
  return { added: true, slot: slotName, skipped: false };
}

module.exports = { migrateClaudeJson, migrateNfJson, populateActiveSlots, addSlotToQuorumActive, SLOT_MIGRATION_MAP };

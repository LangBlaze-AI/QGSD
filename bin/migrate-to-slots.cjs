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

/**
 * Migrate ~/.claude.json mcpServers keys from model-based names to slot names.
 * @param {string} claudeJsonPath - Absolute path to ~/.claude.json
 * @param {boolean} dryRun - If true, do not write changes
 * @returns {{ changed: number, renamed: Array<{from: string, to: string}> }}
 */
function migrateClaudeJson(claudeJsonPath, dryRun = false) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { changed: 0, renamed: [] };
    }
    throw new Error(`Failed to read ${claudeJsonPath}: ${e.message}`);
  }

  const servers = (raw && typeof raw === 'object' && raw.mcpServers) || {};
  let changed = 0;
  const renamed = [];

  for (const [oldName, newName] of Object.entries(SLOT_MIGRATION_MAP)) {
    if (servers[oldName] !== undefined && servers[newName] === undefined) {
      // Rename: assign to new key, delete old key
      servers[newName] = servers[oldName];
      delete servers[oldName];
      changed++;
      renamed.push({ from: oldName, to: newName });
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
    }
  }

  return { changed, renamed };
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

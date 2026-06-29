#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const TAG = '[nf-polyrepo]';
const POLYREPOS_DIR = path.join(os.homedir(), '.claude', 'polyrepos');
const MARKER_FILE = 'polyrepo.json';

/**
 * Ensure ~/.claude/polyrepos/ directory exists
 */
function ensurePolyreposDir() {
  try {
    fs.mkdirSync(POLYREPOS_DIR, { recursive: true });
  } catch (err) {
    console.error(`${TAG} Failed to create polyrepos directory:`, err.message);
    throw err;
  }
}

/**
 * Load a group config from ~/.claude/polyrepos/<name>.json
 * Returns parsed object or null if not found.
 * Fail-open: if malformed JSON, log warning and return null.
 */
function loadGroup(name) {
  const filePath = path.join(POLYREPOS_DIR, `${name}.json`);
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    // A partially-written / wrong-shape group file must not crash every caller's
    // `group.repos.length/.some/.filter/for-of` (dogfood F48). A non-object (e.g. a
    // bare array/string) is not a group → null; an object with a missing/non-array
    // `repos` is normalized to an empty array.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`${TAG} Warning: ${filePath} is not a group object, returning null`);
      return null;
    }
    if (!Array.isArray(parsed.repos)) parsed.repos = [];
    else parsed.repos = parsed.repos.filter(r => r && typeof r === 'object' && !Array.isArray(r));
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error(`${TAG} Warning: malformed JSON in ${filePath}, returning null`);
      return null;
    }
    throw err;
  }
}

/**
 * Save a group config to ~/.claude/polyrepos/<group.name>.json
 */
function saveGroup(group) {
  ensurePolyreposDir();
  const filePath = path.join(POLYREPOS_DIR, `${group.name}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(group, null, 2), 'utf8');
  } catch (err) {
    console.error(`${TAG} Failed to save group:`, err.message);
    throw err;
  }
}

/**
 * Write per-repo marker at <repoPath>/.planning/polyrepo.json
 * Optional docs: { user?, developer?, examples? } — relative paths within the repo
 */
function writeMarker(repoPath, name, role, docs) {
  try {
    const markerDir = path.join(repoPath, '.planning');
    fs.mkdirSync(markerDir, { recursive: true });
    const markerPath = path.join(markerDir, MARKER_FILE);
    const marker = { name, role };
    if (docs && Object.keys(docs).length > 0) {
      marker.docs = docs;
    }
    fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8');
  } catch (err) {
    console.error(`${TAG} Failed to write marker:`, err.message);
    throw err;
  }
}

/**
 * Read per-repo marker from <repoPath>/.planning/polyrepo.json
 * Returns parsed object or null if not found/malformed.
 */
function readMarker(repoPath) {
  try {
    const markerPath = path.join(repoPath, '.planning', MARKER_FILE);
    if (!fs.existsSync(markerPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`${TAG} Warning: marker at ${repoPath} is not an object, returning null`);
      return null;
    }
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error(`${TAG} Warning: malformed marker at ${repoPath}`);
      return null;
    }
    throw err;
  }
}

/**
 * Set docs paths on an existing per-repo marker.
 * docs: { user?, developer?, examples? } — relative paths within the repo.
 * Merges with existing docs (pass null value to remove a key).
 */
function setDocs(repoPath, docs) {
  const marker = readMarker(repoPath);
  if (!marker) {
    return { ok: false, error: `No polyrepo marker found at ${repoPath}/.planning/polyrepo.json` };
  }
  const merged = { ...(marker.docs || {}) };
  for (const [key, val] of Object.entries(docs)) {
    if (val === null) {
      delete merged[key];
    } else {
      merged[key] = val;
    }
  }
  marker.docs = Object.keys(merged).length > 0 ? merged : undefined;
  try {
    const markerPath = path.join(repoPath, '.planning', MARKER_FILE);
    fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8');
    return { ok: true, docs: merged };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Remove per-repo marker at <repoPath>/.planning/polyrepo.json
 * Fail-open: no error if file doesn't exist
 */
function removeMarker(repoPath) {
  try {
    const markerPath = path.join(repoPath, '.planning', MARKER_FILE);
    if (fs.existsSync(markerPath)) {
      fs.unlinkSync(markerPath);
    }
  } catch (err) {
    console.error(`${TAG} Warning: failed to remove marker:`, err.message);
    // Fail-open: don't throw
  }
}

/**
 * Validate group name: alphanumeric + hyphens, 1-50 chars, lowercase, start with alphanumeric
 */
function validateGroupName(name) {
  const nameRegex = /^[a-z0-9][a-z0-9-]*$/;
  if (!name || typeof name !== 'string') {
    return { ok: false, error: 'Name must be a non-empty string' };
  }
  if (name.length > 50) {
    return { ok: false, error: 'Name must be 1-50 characters' };
  }
  if (!nameRegex.test(name)) {
    return { ok: false, error: 'Name must start with alphanumeric and contain only lowercase alphanumeric and hyphens' };
  }
  return { ok: true };
}

/**
 * Create a new polyrepo group with optional initial repos
 * repos: array of { role, path, planning? }
 * Empty repos array is valid (used by interactive create flow).
 */
function createGroup(name, repos = []) {
  // Validate name
  const nameVal = validateGroupName(name);
  if (!nameVal.ok) {
    return nameVal;
  }

  // Check if group already exists
  if (loadGroup(name) !== null) {
    return { ok: false, error: `Group '${name}' already exists` };
  }

  // Validate repos
  if (!Array.isArray(repos)) {
    return { ok: false, error: 'Repos must be an array' };
  }

  const seenPaths = new Set();
  for (const repo of repos) {
    if (!repo || typeof repo !== 'object' || Array.isArray(repo)) {
      return { ok: false, error: 'Each repo must be an object with role and path' };
    }
    if (typeof repo.role !== 'string' || repo.role.length === 0) {
      return { ok: false, error: 'Each repo must have a non-empty role string' };
    }
    if (typeof repo.path !== 'string' || !path.isAbsolute(repo.path)) {
      return { ok: false, error: `Repo path must be absolute: ${repo.path}` };
    }
    if (!fs.existsSync(repo.path)) {
      return { ok: false, error: `Repo path does not exist: ${repo.path}` };
    }
    if (!fs.statSync(repo.path).isDirectory()) {
      return { ok: false, error: `Repo path is not a directory: ${repo.path}` };
    }
    if (seenPaths.has(repo.path)) {
      return { ok: false, error: `Duplicate path in group: ${repo.path}` };
    }
    seenPaths.add(repo.path);
  }

  // Create group
  const group = {
    name,
    repos: repos.map(r => ({
      role: r.role,
      path: r.path,
      planning: r.planning !== false ? true : false
    }))
  };

  try {
    saveGroup(group);
    // Write markers for repos with planning: true
    for (const repo of group.repos) {
      if (repo.planning) {
        writeMarker(repo.path, name, repo.role);
      }
    }
    return { ok: true, group };
  } catch (err) {
    return { ok: false, error: `Failed to create group: ${err.message}` };
  }
}

/**
 * Add a repo to an existing group
 */
function addRepo(groupName, repoPath, role, planning = true) {
  // Load group
  const group = loadGroup(groupName);
  if (!group) {
    return { ok: false, error: `Group '${groupName}' does not exist` };
  }

  // Validate repo path
  if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) {
    return { ok: false, error: `Repo path must be absolute: ${repoPath}` };
  }
  if (!fs.existsSync(repoPath)) {
    return { ok: false, error: `Repo path does not exist: ${repoPath}` };
  }
  if (!fs.statSync(repoPath).isDirectory()) {
    return { ok: false, error: `Repo path is not a directory: ${repoPath}` };
  }

  // Check for duplicates
  if (group.repos.some(r => r.path === repoPath)) {
    return { ok: false, error: `Repo path already in group: ${repoPath}` };
  }

  // Validate role
  if (typeof role !== 'string' || role.length === 0) {
    return { ok: false, error: 'Role must be a non-empty string' };
  }

  // Add repo
  try {
    group.repos.push({
      role,
      path: repoPath,
      planning: planning !== false ? true : false
    });
    saveGroup(group);
    if (planning !== false) {
      writeMarker(repoPath, groupName, role);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Failed to add repo: ${err.message}` };
  }
}

/**
 * Remove a repo from a group
 * If group becomes empty, delete the group config file entirely.
 */
function removeRepo(groupName, repoPath) {
  // Load group
  const group = loadGroup(groupName);
  if (!group) {
    return { ok: false, error: `Group '${groupName}' does not exist` };
  }

  // Find and remove repo
  const initialLength = group.repos.length;
  group.repos = group.repos.filter(r => r.path !== repoPath);

  if (group.repos.length === initialLength) {
    return { ok: false, error: `Repo not found in group: ${repoPath}` };
  }

  try {
    removeMarker(repoPath);

    // If group is now empty, delete the group config file
    if (group.repos.length === 0) {
      const filePath = path.join(POLYREPOS_DIR, `${groupName}.json`);
      fs.unlinkSync(filePath);
      return { ok: true, deleted_group: true };
    } else {
      saveGroup(group);
      return { ok: true };
    }
  } catch (err) {
    return { ok: false, error: `Failed to remove repo: ${err.message}` };
  }
}

/**
 * List all polyrepo groups
 */
function listGroups() {
  try {
    ensurePolyreposDir();
    if (!fs.existsSync(POLYREPOS_DIR)) {
      return [];
    }
    const files = fs.readdirSync(POLYREPOS_DIR);
    const groups = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const group = loadGroup(file.replace(/\.json$/, ''));
      if (group) {
        groups.push(group);
      }
    }
    return groups;
  } catch (err) {
    console.error(`${TAG} Failed to list groups:`, err.message);
    return [];
  }
}

/**
 * Load a single group by name
 */
function listGroup(name) {
  return loadGroup(name);
}

/**
 * CLI Subcommand Handler
 */
function handleCLI() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(`${TAG} Polyrepo Config Management

Usage:
  node polyrepo.cjs create <name>
  node polyrepo.cjs add <group> <path> [role] [--no-planning]
  node polyrepo.cjs remove <group> <path>
  node polyrepo.cjs list [group]
  node polyrepo.cjs info
  node polyrepo.cjs docs [show|set|remove]
  node polyrepo.cjs --help

Commands:
  create <name>           Create an empty polyrepo group
  add <group> <path> [role] [--no-planning]
                          Add a repo to a group (role defaults to basename)
  remove <group> <path>   Remove a repo from a group
  list [group]            List all groups or repos in a specific group
  info                    Show this repo's polyrepo group membership
  docs show               Show doc paths for current repo
  docs set <key> <path>   Set a doc path (user, developer, examples, or custom)
  docs remove <key>       Remove a doc path
  --help                  Show this help message
`);
    return;
  }

  if (cmd === 'create') {
    const name = args[1];
    if (!name) {
      console.error(`${TAG} create: missing name argument`);
      process.exit(1);
    }
    const result = createGroup(name, []);
    if (result.ok) {
      process.stdout.write(`${TAG} Created group '${name}' at ${POLYREPOS_DIR}/${name}.json\n`);
    } else {
      console.error(`${TAG} Error: ${result.error}`);
      process.exit(1);
    }
  } else if (cmd === 'add') {
    const group = args[1];
    const repoPath = args[2];
    let role = args[3];
    const noPlanning = args.includes('--no-planning');

    if (!group || !repoPath) {
      console.error(`${TAG} add: missing group or path argument`);
      process.exit(1);
    }

    // Default role to basename if not provided
    if (!role || role.startsWith('--')) {
      role = path.basename(repoPath);
    }

    const result = addRepo(group, repoPath, role, !noPlanning);
    if (result.ok) {
      process.stdout.write(`${TAG} Added '${role}' (${repoPath}) to group '${group}'\n`);
    } else {
      console.error(`${TAG} Error: ${result.error}`);
      process.exit(1);
    }
  } else if (cmd === 'remove') {
    const group = args[1];
    const repoPath = args[2];
    if (!group || !repoPath) {
      console.error(`${TAG} remove: missing group or path argument`);
      process.exit(1);
    }
    const result = removeRepo(group, repoPath);
    if (result.ok) {
      if (result.deleted_group) {
        process.stdout.write(`${TAG} Removed repo from group '${group}'. Group was empty, so config deleted.\n`);
      } else {
        process.stdout.write(`${TAG} Removed repo from group '${group}'\n`);
      }
    } else {
      console.error(`${TAG} Error: ${result.error}`);
      process.exit(1);
    }
  } else if (cmd === 'list') {
    const groupName = args[1];
    if (groupName) {
      const group = listGroup(groupName);
      if (!group) {
        console.error(`${TAG} Group '${groupName}' not found`);
        process.exit(1);
      }
      process.stdout.write(`\nPolyrepo Group: ${group.name}\n`);
      for (const repo of group.repos) {
        const planning = repo.planning ? '[planning]' : '[no planning]';
        process.stdout.write(`  ${repo.role.padEnd(15)} ${repo.path.padEnd(30)} ${planning}\n`);
      }
      process.stdout.write('\n');
    } else {
      const groups = listGroups();
      if (groups.length === 0) {
        process.stdout.write(`${TAG} No polyrepo groups defined\n`);
      } else {
        process.stdout.write('\nPolyrepo Groups:\n');
        for (const group of groups) {
          process.stdout.write(`  ${group.name} (${group.repos.length} repos)\n`);
          for (const repo of group.repos) {
            const planning = repo.planning ? '[planning]' : '[no planning]';
            process.stdout.write(`    ${repo.role.padEnd(15)} ${repo.path.padEnd(30)} ${planning}\n`);
          }
        }
        process.stdout.write('\n');
      }
    }
  } else if (cmd === 'info') {
    const cwd = process.cwd();
    const marker = readMarker(cwd);
    if (!marker) {
      process.stdout.write(`${TAG} This repo is not part of any polyrepo group\n`);
      process.exit(1);
    }
    process.stdout.write(`\nThis repo belongs to polyrepo group: ${marker.name}\n`);
    process.stdout.write(`Role: ${marker.role}\n`);
    const group = listGroup(marker.name);
    if (group) {
      const repo = group.repos.find(r => r.path === cwd);
      process.stdout.write(`Planning: ${(repo ? repo.planning : true) ? 'yes' : 'no'}\n`);
    } else {
      process.stdout.write(`Planning: yes\n`);
    }
    if (marker.docs) {
      process.stdout.write(`Docs:\n`);
      for (const [key, val] of Object.entries(marker.docs)) {
        process.stdout.write(`  ${key.padEnd(12)} ${val}\n`);
      }
    }
    process.stdout.write('\n');
  } else if (cmd === 'docs') {
    const subcmd = args[1];
    const cwd = process.cwd();
    if (!subcmd || subcmd === 'show') {
      const marker = readMarker(cwd);
      if (!marker) {
        console.error(`${TAG} No polyrepo marker found in current directory`);
        process.exit(1);
      }
      if (!marker.docs || Object.keys(marker.docs).length === 0) {
        process.stdout.write(`${TAG} No docs paths configured for this repo\n`);
      } else {
        process.stdout.write(`\nDocs paths for ${marker.name} (${marker.role}):\n`);
        for (const [key, val] of Object.entries(marker.docs)) {
          process.stdout.write(`  ${key.padEnd(12)} ${val}\n`);
        }
        process.stdout.write('\n');
      }
    } else if (subcmd === 'set') {
      // docs set <key> <path>
      const key = args[2];
      const docPath = args[3];
      if (!key || !docPath) {
        console.error(`${TAG} docs set: usage: docs set <key> <path>`);
        console.error(`  Keys: user, developer, examples (or any custom key)`);
        process.exit(1);
      }
      const result = setDocs(cwd, { [key]: docPath });
      if (result.ok) {
        process.stdout.write(`${TAG} Set docs.${key} = ${docPath}\n`);
      } else {
        console.error(`${TAG} Error: ${result.error}`);
        process.exit(1);
      }
    } else if (subcmd === 'remove') {
      const key = args[2];
      if (!key) {
        console.error(`${TAG} docs remove: usage: docs remove <key>`);
        process.exit(1);
      }
      const result = setDocs(cwd, { [key]: null });
      if (result.ok) {
        process.stdout.write(`${TAG} Removed docs.${key}\n`);
      } else {
        console.error(`${TAG} Error: ${result.error}`);
        process.exit(1);
      }
    } else {
      console.error(`${TAG} docs: unknown subcommand '${subcmd}'. Use: show, set, remove`);
      process.exit(1);
    }
  } else {
    console.error(`${TAG} Unknown command: ${cmd}`);
    process.exit(1);
  }
}

// Export for testability
module.exports = {
  createGroup,
  addRepo,
  removeRepo,
  listGroups,
  listGroup,
  loadGroup,
  saveGroup,
  writeMarker,
  readMarker,
  removeMarker,
  setDocs,
  ensurePolyreposDir,
  POLYREPOS_DIR,
  MARKER_FILE
};

// Run CLI if executed directly
if (require.main === module) {
  handleCLI();
}

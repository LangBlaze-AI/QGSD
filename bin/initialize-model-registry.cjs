#!/usr/bin/env node
'use strict';
// bin/initialize-model-registry.cjs
// One-time idempotent initialization of .planning/formal/model-registry.json.
//
// Scans .planning/formal/tla/, .planning/formal/alloy/, and .planning/formal/prism/ for canonical model files
// and creates model-registry.json with provenance metadata for each.
//
// Usage:
//   node bin/initialize-model-registry.cjs
//
// Idempotent: if .planning/formal/model-registry.json already exists, exits 0 silently.
// Run this once after cloning the repo, before any generate/promote/debug operations.

const fs   = require('fs');
const path = require('path');

let ROOT = path.join(__dirname, '..');

// Parse --project-root (overrides __dirname-based ROOT for testing)
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--project-root=')) {
    ROOT = path.resolve(arg.slice('--project-root='.length));
  }
}

const REGISTRY_PATH = path.join(ROOT, '.planning', 'formal', 'model-registry.json');

// ── Idempotent guard ──────────────────────────────────────────────────────────
if (fs.existsSync(REGISTRY_PATH)) {
  process.exit(0);
}

// ── Scan .planning/formal/ subdirectories ───────────────────────────────────────────────
const SCAN_DIRS = [
  { dir: path.join(ROOT, '.planning', 'formal', 'tla'),    exts: ['.tla'] },
  { dir: path.join(ROOT, '.planning', 'formal', 'alloy'),  exts: ['.als'] },
  { dir: path.join(ROOT, '.planning', 'formal', 'prism'),  exts: ['.pm']  },
  { dir: path.join(ROOT, '.planning', 'formal', 'petri'),  exts: ['.dot'] },
];

// Files to skip — not canonical specs
const SKIP_PATTERNS = [
  /_TTrace_/,  // TLC error trace artifacts
];

const models = {};

for (const { dir, exts } of SCAN_DIRS) {
  if (!fs.existsSync(dir)) continue;

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    process.stderr.write('[initialize-model-registry] Cannot read dir ' + dir + ': ' + err.message + '\n');
    continue;
  }

  for (const filename of entries) {
    const ext = path.extname(filename);
    if (!exts.includes(ext)) continue;

    // Skip non-canonical files
    const skip = SKIP_PATTERNS.some(pattern => pattern.test(filename));
    if (skip) continue;

    const absPath = path.join(dir, filename);

    // Compute registry key — relative from ROOT, no leading './' or '/'
    let key = path.relative(ROOT, absPath).replace(/\\/g, '/');
    if (key.startsWith('./')) key = key.slice(2);
    if (key.startsWith('/')) key = key.slice(1);

    // Validate key format
    if (key.startsWith('/') || key.startsWith('./')) {
      process.stderr.write('[initialize-model-registry] WARNING: key has invalid prefix: ' + key + '\n');
      continue;
    }

    let st;
    try {
      st = fs.statSync(absPath);
    } catch (err) {
      process.stderr.write('[initialize-model-registry] WARNING: cannot stat ' + absPath + ': ' + err.message + '\n');
      continue;
    }
    if (!st.isFile()) continue;
    const mtime = st.mtime.toISOString();

    // Detect generated files (xstate-derived)
    const isGenerated = filename.includes('xstate');

    models[key] = {
      version: 1,
      last_updated: mtime,
      update_source: isGenerated ? 'generate' : 'manual',
      source_id: isGenerated ? 'generate:tla-from-xstate' : null,
      session_id: null,
      description: ''
    };
  }
}

// ── Build registry with sorted keys ──────────────────────────────────────────
const sortedModels = {};
for (const key of Object.keys(models).sort()) {
  sortedModels[key] = models[key];
}

const registry = {
  version: '1.0',
  last_sync: new Date().toISOString(),
  models: sortedModels
};

// ── Write registry ─────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf8');

const count = Object.keys(sortedModels).length;
process.stdout.write('[initialize-model-registry] Created .planning/formal/model-registry.json with ' + count + ' entries\n');

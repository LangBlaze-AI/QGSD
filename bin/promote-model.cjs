#!/usr/bin/env node
'use strict';
// bin/promote-model.cjs
// Atomic promotion: merges PROPERTY definitions from proposed-changes.tla into
// a canonical target spec. Both the spec and model-registry.json are written
// atomically using tmp+rename to prevent partial writes.
//
// Usage:
//   node bin/promote-model.cjs <proposed-changes.tla> <target-spec.tla> [--source-id <id>]
//
// Exit codes:
//   0 — success (merged N properties, registry updated)
//   1 — error (file not found, duplicate property names, etc.)

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── Find .planning/formal/ root from target path ───────────────────────────────────────
// Walks up from a given path until finding .planning/formal/, then
// returns the grandparent of that directory as the project root.
// Falls back to ROOT (the nForma project root) if no .planning/formal/ ancestor is found.
function findProjectRoot(startPath) {
  let current = path.dirname(startPath);
  while (true) {
    if (path.basename(current) === 'formal' && path.basename(path.dirname(current)) === '.planning') {
      return path.dirname(path.dirname(current));
    }
    const parent = path.dirname(current);
    if (parent === current) break; // filesystem root
    current = parent;
  }
  return ROOT; // fallback
}

// ── Parse CLI arguments ───────────────────────────────────────────────────────
const args = process.argv.slice(2);

let proposedPath = null;
let targetPath   = null;
let sourceId     = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--source-id' && i + 1 < args.length) {
    sourceId = args[++i];
  } else if (!proposedPath) {
    proposedPath = args[i];
  } else if (!targetPath) {
    targetPath = args[i];
  }
}

if (!proposedPath || !targetPath) {
  process.stderr.write('Usage: node bin/promote-model.cjs <proposed-changes.tla> <target-spec.tla> [--source-id <id>]\n');
  process.exit(1);
}

// Resolve paths relative to cwd (or absolute)
const resolvedProposed = path.resolve(proposedPath);
const resolvedTarget   = path.resolve(targetPath);

// ── Read proposed file ─────────────────────────────────────────────────────
if (!fs.existsSync(resolvedProposed)) {
  process.stderr.write('Error: proposed file not found: ' + resolvedProposed + '\n');
  process.exit(1);
}
const proposedContent = fs.readFileSync(resolvedProposed, 'utf8');

// ── Read target file ───────────────────────────────────────────────────────
if (!fs.existsSync(resolvedTarget)) {
  process.stderr.write('Error: target file not found: ' + resolvedTarget + '\n');
  process.exit(1);
}
const targetContent = fs.readFileSync(resolvedTarget, 'utf8');

// ── Extract PROPERTY names using canonical regex ───────────────────────────
// Pattern: /^PROPERTY\s+(\w+)/gm — sufficient for all TLA+ PROPERTY declarations.
// Each PROPERTY keyword appears at line start with its name on the same line.
const PROPERTY_RE = /^PROPERTY\s+(\w+)/gm;

function extractPropertyNames(content) {
  return [...content.matchAll(PROPERTY_RE)].map(m => m[1]);
}

const proposedNames = extractPropertyNames(proposedContent);
const targetNames   = extractPropertyNames(targetContent);

if (proposedNames.length === 0) {
  process.stderr.write('Warning: no PROPERTY definitions found in proposed file: ' + resolvedProposed + '\n');
  // Not an error — allow no-op promotions
}

// ── Duplicate detection ────────────────────────────────────────────────────
const targetNameSet = new Set(targetNames);
const duplicates = proposedNames.filter(name => targetNameSet.has(name));

if (duplicates.length > 0) {
  process.stderr.write('Error: duplicate PROPERTY names: ' + duplicates.join(', ') + '\n');
  process.stderr.write('These names already exist in target spec: ' + resolvedTarget + '\n');
  process.exit(1);
}

// ── Extract PROPERTY blocks from proposed content ─────────────────────────
// We extract all lines that are part of PROPERTY blocks.
// A PROPERTY block starts at a line matching /^PROPERTY\s+\w+/ and continues
// until the next PROPERTY, INVARIANT, ===, or EOF.
function extractPropertyBlocks(content) {
  const lines = content.split('\n');
  const blocks = [];
  let inBlock = false;
  let currentBlock = [];

  for (const line of lines) {
    if (/^PROPERTY\s+\w+/.test(line)) {
      if (inBlock && currentBlock.length > 0) {
        // Trim trailing empty lines from previous block
        while (currentBlock.length > 0 && currentBlock[currentBlock.length - 1].trim() === '') {
          currentBlock.pop();
        }
        blocks.push(currentBlock.join('\n'));
        currentBlock = [];
      }
      inBlock = true;
      currentBlock.push(line);
    } else if (inBlock) {
      // Stop at module-level delimiters
      if (/^====/.test(line) || /^INVARIANT\s+/.test(line)) {
        if (currentBlock.length > 0) {
          while (currentBlock.length > 0 && currentBlock[currentBlock.length - 1].trim() === '') {
            currentBlock.pop();
          }
          blocks.push(currentBlock.join('\n'));
          currentBlock = [];
        }
        inBlock = false;
      } else {
        currentBlock.push(line);
      }
    }
  }

  // Flush last block
  if (inBlock && currentBlock.length > 0) {
    while (currentBlock.length > 0 && currentBlock[currentBlock.length - 1].trim() === '') {
      currentBlock.pop();
    }
    if (currentBlock.length > 0) {
      blocks.push(currentBlock.join('\n'));
    }
  }

  return blocks;
}

const propertyBlocks = extractPropertyBlocks(proposedContent);

// ── Merge into target ──────────────────────────────────────────────────────
// Insert before the closing ==== if present, otherwise append.
let mergedContent;
const endMarkerIndex = targetContent.lastIndexOf('\n====');

if (endMarkerIndex !== -1) {
  // Insert before the ==== end marker
  const before = targetContent.slice(0, endMarkerIndex);
  const after  = targetContent.slice(endMarkerIndex);
  mergedContent = before + '\n\n' + propertyBlocks.join('\n\n') + '\n' + after;
} else {
  // Append at end
  mergedContent = targetContent.trimEnd() + '\n\n' + propertyBlocks.join('\n\n') + '\n';
}

// ── Atomic write of target spec ────────────────────────────────────────────
const tmpSpec = resolvedTarget + '.tmp.' + Date.now() + '.' + Math.random().toString(36).slice(2);
fs.writeFileSync(tmpSpec, mergedContent, 'utf8');
fs.renameSync(tmpSpec, resolvedTarget);

// ── Update model-registry.json ─────────────────────────────────────────────
// Find registry relative to the target file's .planning/formal/ ancestor
const projectRoot  = findProjectRoot(resolvedTarget);
const registryPath = path.join(projectRoot, '.planning', 'formal', 'model-registry.json');
let newVersion = null;

if (!fs.existsSync(registryPath)) {
  process.stderr.write('[promote-model] Warning: .planning/formal/model-registry.json not found — skipping registry update\n');
} else {
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (err) {
    process.stderr.write('[promote-model] Warning: cannot parse registry — skipping update: ' + err.message + '\n');
    registry = null;
  }

  if (registry && (typeof registry !== 'object' || Array.isArray(registry))) {
    process.stderr.write('[promote-model] Warning: registry is not an object — skipping update\n');
    registry = null;
  }

  if (registry) {
    if (!registry.models || typeof registry.models !== 'object' || Array.isArray(registry.models)) registry.models = {};
    const key = path.relative(projectRoot, resolvedTarget).replace(/\\/g, '/');
    const now = new Date().toISOString();
    const existing = registry.models[key] || {};
    newVersion = (Number(existing.version) || 0) + 1;

    registry.models[key] = {
      version: newVersion,
      last_updated: now,
      update_source: 'plan-promote',
      source_id: sourceId || null,
      session_id: null,
      description: existing.description || ''
    };
    registry.last_sync = now;

    // Atomic write of registry
    const tmpReg = registryPath + '.tmp.' + Date.now() + '.' + Math.random().toString(36).slice(2);
    fs.writeFileSync(tmpReg, JSON.stringify(registry, null, 2), 'utf8');
    fs.renameSync(tmpReg, registryPath);
  }
}

// ── Report success ─────────────────────────────────────────────────────────
const versionStr = newVersion !== null ? '. Registry version: ' + newVersion : '';
process.stdout.write(
  '[promote-model] Merged ' + proposedNames.length + ' propert' +
  (proposedNames.length === 1 ? 'y' : 'ies') +
  ' into ' + path.relative(process.cwd(), resolvedTarget) + versionStr + '\n'
);

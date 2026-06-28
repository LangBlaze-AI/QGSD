#!/usr/bin/env node
'use strict';
// bin/accept-debug-invariant.cjs
// Debug invariant write path (ARCH-03): writes a PROPERTY definition directly
// to a canonical .planning/formal/tla/ spec with full provenance tracking.
//
// When /nf:debug accepts a new invariant candidate, this script writes it to
// the canonical spec and records update_source=debug + session_id in model-registry.json.
//
// Usage:
//   node bin/accept-debug-invariant.cjs <target-spec.tla> --property-name <name> --property-body <body> --session-id <id>
//
// Exit codes:
//   0 — success (PROPERTY written, registry updated)
//   1 — error (missing args, malformed session-id, spec not found, duplicate name, etc.)
//
// Session ID generation for callers:
// `debug-sess-${Math.floor(Date.now()/1000)}-${Math.random().toString(16).slice(2,10)}`

const fs   = require('fs');
const path = require('path');

// ── Find project root from target path (walk up to .planning/formal/ ancestor) ─────────
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
  return path.join(__dirname, '..'); // fallback to nForma project root
}

// ── Parse CLI arguments ───────────────────────────────────────────────────────
const args = process.argv.slice(2);

let targetPath    = null;
let propertyName  = null;
let propertyBody  = null;
let sessionId     = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--property-name' && i + 1 < args.length) {
    propertyName = args[++i];
  } else if (args[i] === '--property-body' && i + 1 < args.length) {
    propertyBody = args[++i];
  } else if (args[i] === '--session-id' && i + 1 < args.length) {
    sessionId = args[++i];
  } else if (!targetPath) {
    targetPath = args[i];
  }
}

// ── Validate required arguments — before any file I/O ─────────────────────
if (!targetPath || !propertyName || !propertyBody) {
  process.stderr.write('Usage: node bin/accept-debug-invariant.cjs <target-spec.tla> --property-name <name> --property-body <body> --session-id <id>\n');
  process.exit(1);
}

// --session-id is required (FV traceability contract)
if (!sessionId) {
  process.stderr.write('Error: --session-id is required for debug invariant writes\n');
  process.exit(1);
}

// Validate property name is a plain TLA identifier (no regex metacharacters)
const PROPERTY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
if (!PROPERTY_NAME_RE.test(propertyName)) {
  process.stderr.write(
    'Error: --property-name must be a TLA identifier (letters, digits, underscore; ' +
    'starting with a letter or underscore)\n'
  );
  process.exit(1);
}

// Validate session-id format: debug-sess-<unix-timestamp-seconds>-<8-char-hex>
const SESSION_ID_RE = /^debug-sess-\d+-[0-9a-f]{8}$/;
if (!SESSION_ID_RE.test(sessionId)) {
  process.stderr.write(
    'Error: --session-id must match format debug-sess-<unix-timestamp-seconds>-<8-char-hex> ' +
    '(e.g., debug-sess-1740835200-a3f9c012)\n'
  );
  process.exit(1);
}

// ── Resolve target path ────────────────────────────────────────────────────
const resolvedTarget = path.resolve(targetPath);

// ── Read target spec ───────────────────────────────────────────────────────
if (!fs.existsSync(resolvedTarget)) {
  process.stderr.write('Error: spec not found: ' + resolvedTarget + '\n');
  process.exit(1);
}
const specContent = fs.readFileSync(resolvedTarget, 'utf8');

// ── Check for duplicate property name ─────────────────────────────────────
const escapedName = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const duplicateRe = new RegExp('^PROPERTY\\s+' + escapedName + '\\b', 'm');
if (duplicateRe.test(specContent)) {
  process.stderr.write('Error: PROPERTY ' + propertyName + ' already exists in spec\n');
  process.exit(1);
}

// ── Build invariant block ──────────────────────────────────────────────────
const invariantBlock =
  '\n(* DEBUG SESSION: ' + sessionId + ' *)\n' +
  'PROPERTY ' + propertyName + ' == ' + propertyBody + '\n';

// ── Merge into spec ────────────────────────────────────────────────────────
// Insert before the closing ==== if present, otherwise append.
let mergedContent;
const endMarkerIndex = specContent.lastIndexOf('\n====');

if (endMarkerIndex !== -1) {
  const before = specContent.slice(0, endMarkerIndex);
  const after  = specContent.slice(endMarkerIndex);
  mergedContent = before + invariantBlock + after;
} else {
  mergedContent = specContent.trimEnd() + invariantBlock;
}

// ── Atomic write of spec ───────────────────────────────────────────────────
const tmpSpec = resolvedTarget + '.tmp.' + Date.now() + '.' + Math.random().toString(36).slice(2);
fs.writeFileSync(tmpSpec, mergedContent, 'utf8');
fs.renameSync(tmpSpec, resolvedTarget);

// ── Update model-registry.json ─────────────────────────────────────────────
const projectRoot  = findProjectRoot(resolvedTarget);
const registryPath = path.join(projectRoot, '.planning', 'formal', 'model-registry.json');
let newVersion = null;

if (!fs.existsSync(registryPath)) {
  process.stderr.write('[accept-debug-invariant] Warning: .planning/formal/model-registry.json not found — skipping registry update\n');
} else {
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (err) {
    process.stderr.write('[accept-debug-invariant] Warning: cannot parse registry — skipping update: ' + err.message + '\n');
    registry = null;
  }

  if (registry !== null && (typeof registry !== 'object' || Array.isArray(registry))) {
    process.stderr.write('[accept-debug-invariant] Warning: registry is not a JSON object — skipping registry update\n');
    registry = null;
  }

  if (registry) {
    if (!registry.models) registry.models = {};
    const key = path.relative(projectRoot, resolvedTarget).replace(/\\/g, '/');
    const now = new Date().toISOString();
    const existing = registry.models[key] || {};
    newVersion = (existing.version || 0) + 1;

    registry.models[key] = {
      version: newVersion,
      last_updated: now,
      update_source: 'debug',
      source_id: null,
      session_id: sessionId,
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
  '[accept-debug-invariant] Wrote PROPERTY ' + propertyName +
  ' to ' + path.relative(process.cwd(), resolvedTarget) +
  '. session_id: ' + sessionId + versionStr + '\n'
);

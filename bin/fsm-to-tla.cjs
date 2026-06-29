#!/usr/bin/env node
'use strict';
// bin/fsm-to-tla.cjs
// Unified CLI entry point for multi-adapter FSM-to-TLA+ transpiler.
//
// Usage:
//   node bin/fsm-to-tla.cjs <source-file>
//   node bin/fsm-to-tla.cjs <source-file> --framework=xstate-v5
//   node bin/fsm-to-tla.cjs <source-file> --detect
//   node bin/fsm-to-tla.cjs <source-file> --scaffold-config
//   node bin/fsm-to-tla.cjs <source-file> --module=NFQuorum --config=guards.json --dry

const fs   = require('fs');
const path = require('path');

const TAG = '[fsm-to-tla]';

// ── CLI arg parsing ─────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const inputFile    = argv.find(a => !a.startsWith('-'));
const frameworkArg = (argv.find(a => a.startsWith('--framework=')) || '').slice('--framework='.length);
const moduleArg    = (argv.find(a => a.startsWith('--module=')) || '').slice('--module='.length);
const configArg    = (argv.find(a => a.startsWith('--config=')) || '').slice('--config='.length);
const outDirArg    = (argv.find(a => a.startsWith('--out-dir=')) || '').slice('--out-dir='.length);
const dry          = argv.includes('--dry');
const detectMode   = argv.includes('--detect');
const scaffoldMode = argv.includes('--scaffold-config');

if (!inputFile) {
  process.stderr.write(
    'Usage: node bin/fsm-to-tla.cjs <source-file>\n' +
    '         [--framework=<id>]        Auto-detect if omitted\n' +
    '         [--module=ModuleName]     Derived from machineId if omitted\n' +
    '         [--config=guards.json]    Guards and vars config\n' +
    '         [--out-dir=path]          Default: .planning/formal/tla\n' +
    '         [--scaffold-config]       Print starter config JSON and exit\n' +
    '         [--detect]                Print detected framework and exit\n' +
    '         [--dry]                   Print output without writing files\n'
  );
  process.exit(1);
}

const absInput = path.resolve(inputFile);
if (!fs.existsSync(absInput)) {
  process.stderr.write(TAG + ' File not found: ' + absInput + '\n');
  process.exit(1);
}

// ── Read source file ────────────────────────────────────────────────────────
const content = fs.readFileSync(absInput, 'utf8');

// ── Resolve adapter ─────────────────────────────────────────────────────────
const { detectFramework, getAdapter } = require('./adapters/detect.cjs');
let adapter;

if (frameworkArg) {
  try {
    adapter = getAdapter(frameworkArg);
  } catch (e) {
    process.stderr.write(TAG + ' ' + e.message + '\n');
    process.exit(1);
  }
} else {
  const result = detectFramework(inputFile, content);
  if (!result) {
    process.stderr.write(TAG + ' Could not detect framework for: ' + inputFile + '\n');
    process.exit(1);
  }
  adapter = result.adapter;
  if (!detectMode) {
    process.stderr.write(TAG + ' Auto-detected: ' + adapter.name + ' (confidence: ' + result.confidence + ')\n');
  }
}

// ── Detect mode ─────────────────────────────────────────────────────────────
if (detectMode) {
  const result = frameworkArg
    ? { adapter, confidence: 100 }
    : detectFramework(inputFile, content);
  if (result) {
    process.stdout.write(JSON.stringify({ framework: result.adapter.id, confidence: result.confidence }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({ framework: null, confidence: 0 }) + '\n');
  }
  process.exit(0);
}

// ── Load user config ────────────────────────────────────────────────────────
let userGuards = {};
let userVars   = {};

if (configArg) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.resolve(configArg), 'utf8'));
    userGuards = raw.guards || {};
    userVars   = raw.vars   || {};
    process.stderr.write(TAG + ' Config: ' + configArg + '\n');
  } catch (e) {
    process.stderr.write(TAG + ' Failed to load config: ' + e.message + '\n');
    process.exit(1);
  }
}

// ── Extract MachineIR ───────────────────────────────────────────────────────
let ir;
try {
  ir = adapter.extract(absInput, { userVars, configPath: configArg });
} catch (e) {
  process.stderr.write(TAG + ' Extraction failed: ' + e.message + '\n');
  process.exit(1);
}

// ── Scaffold config mode ────────────────────────────────────────────────────
if (scaffoldMode) {
  const { scaffoldConfig } = require('./adapters/scaffold-config.cjs');
  const config = scaffoldConfig(ir);
  process.stdout.write(JSON.stringify(config, null, 2) + '\n');
  process.exit(0);
}

// ── Emit TLA+ ───────────────────────────────────────────────────────────────
const { emitTLA } = require('./adapters/emitter-tla.cjs');

const moduleName = moduleArg || ir.machineId
  .split(/[-_\s]+/)
  .map(w => w.charAt(0).toUpperCase() + w.slice(1))
  .join('');

const result = emitTLA(ir, {
  moduleName,
  configPath: configArg,
  userGuards,
  userVars,
  outDir: outDirArg || undefined,
  dry,
  sourceFile: path.relative(process.cwd(), absInput),
});

if (dry) {
  process.stdout.write('\n--- ' + path.relative(process.cwd(), result.tlaOutPath) + ' ---\n');
  process.stdout.write(result.tlaContent);
  process.stdout.write('\n--- ' + path.relative(process.cwd(), result.cfgOutPath) + ' ---\n');
  process.stdout.write(result.cfgContent + '\n');
} else {
  process.stdout.write(TAG + ' TLA+: ' + path.relative(process.cwd(), result.tlaOutPath) + '\n');
  process.stdout.write(TAG + ' CFG:  ' + path.relative(process.cwd(), result.cfgOutPath) + '\n');
  process.stdout.write(TAG + ' Framework: ' + ir.framework + '\n');
  process.stdout.write(TAG + ' States:  ' + ir.stateNames.join(', ') + '\n');
  process.stdout.write(TAG + ' Actions: ' + (result.actionNames || []).join(', ') + '\n');

  // Report unresolved guards
  const allGuardNames = [...new Set(ir.transitions.filter(t => t.guard).map(t => t.guard))];
  const unresolved = allGuardNames.filter(g => !userGuards[g]);
  if (unresolved.length > 0) {
    process.stdout.write(TAG + ' WARN: guards without TLA+ mapping:\n');
    for (const g of unresolved) {
      process.stdout.write(TAG + '   ' + g + '\n');
    }
  }
}

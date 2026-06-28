#!/usr/bin/env node
'use strict';
// bin/run-oscillation-tlc.cjs
// Invokes TLC model checker for nForma oscillation and convergence TLA+ specifications.
// Requirements: GAP-1, GAP-5
//
// Usage:
//   node bin/run-oscillation-tlc.cjs MCoscillation   # oscillation detection (liveness, -workers 1)
//   node bin/run-oscillation-tlc.cjs MCconvergence   # state persistence (liveness, -workers 1)
//   node bin/run-oscillation-tlc.cjs --config=MCoscillation
//
// Prerequisites:
//   - Java >=17 (https://adoptium.net/)
//   - .planning/formal/tla/tla2tools.jar (see .planning/formal/tla/README.md for download command)

const { spawnSync } = require('child_process');
const JAVA_HEAP_MAX = process.env.NF_JAVA_HEAP_MAX || '512m';
const fs   = require('fs');
const path = require('path');
const { writeCheckResult } = require('./write-check-result.cjs');
const { detectLivenessProperties } = require('./run-tlc.cjs');
const { getRequirementIds } = require('./requirement-map.cjs');
const { resolveTlaJar } = require('./resolve-formal-tools.cjs');

// ── Resolve project root (--project-root= overrides __dirname-relative) ─────
let ROOT = path.join(__dirname, '..');
for (const arg of process.argv) {
  if (arg.startsWith('--project-root=')) ROOT = path.resolve(arg.slice('--project-root='.length));
}

const CHECK_ID_MAP = {
  'MCoscillation': 'tla:oscillation',
  'MCconvergence': 'tla:convergence',
  'MCsolve-convergence': 'tla:solve-convergence',
};

const PROPERTY_MAP = {
  'MCoscillation': 'Run-collapse oscillation detection algorithm correctness',
  'MCconvergence': 'Haiku convergence — OscillationConvergence liveness property',
  'MCsolve-convergence': 'Outer solve loop convergence under Option C',
};

// ── Parse --config argument ──────────────────────────────────────────────────
const args       = process.argv.slice(2);
const configArg  = args.find(a => a.startsWith('--config=')) || null;
const configName = configArg
  ? configArg.split('=')[1]
  : (args.find(a => !a.startsWith('-')) || 'MCoscillation');

const VALID_CONFIGS = ['MCoscillation', 'MCconvergence', 'MCsolve-convergence'];
if (!VALID_CONFIGS.includes(configName)) {
  process.stderr.write(
    '[run-oscillation-tlc] Unknown config: ' + configName +
    '. Valid: ' + VALID_CONFIGS.join(', ') + '\n'
  );
  const _startMs = Date.now();
  const _runtimeMs = 0;
  // configName is a genuinely-unknown key here (failed VALID_CONFIGS); never index the
  // maps with it — a prototype-chain key (__proto__/constructor/prototype) would resolve
  // to an inherited member and poison check_id/property, silently dropping the error record.
  const _unknownCheckId = 'tla:' + (configName.toLowerCase() || 'unknown');
  try { writeCheckResult({ tool: 'run-oscillation-tlc', formalism: 'tla', result: 'error', check_id: _unknownCheckId, surface: 'tla', property: configName || 'unknown config', runtime_ms: _runtimeMs, summary: 'error: unknown config in ' + _runtimeMs + 'ms', requirement_ids: getRequirementIds(_unknownCheckId), metadata: { config: configName } }); } catch (e) { process.stderr.write('[run-oscillation-tlc] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

// ── 1. Locate Java ───────────────────────────────────────────────────────────
const JAVA_HOME = process.env.JAVA_HOME;
let javaExe;

if (JAVA_HOME) {
  javaExe = path.join(JAVA_HOME, 'bin', 'java');
  if (!fs.existsSync(javaExe)) {
    process.stderr.write(
      '[run-oscillation-tlc] JAVA_HOME is set but java binary not found at: ' + javaExe + '\n' +
      '[run-oscillation-tlc] Unset JAVA_HOME or fix the path.\n'
    );
    const _startMs = Date.now();
    const _runtimeMs = 0;
    try { writeCheckResult({ tool: 'run-oscillation-tlc', formalism: 'tla', result: 'error', check_id: CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase()), surface: 'tla', property: PROPERTY_MAP[configName] || configName, runtime_ms: _runtimeMs, summary: 'error: Java not found in ' + _runtimeMs + 'ms', requirement_ids: getRequirementIds(CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase())), metadata: { config: configName } }); } catch (e) { process.stderr.write('[run-oscillation-tlc] Warning: failed to write check result: ' + e.message + '\n'); }
    process.exit(1);
  }
} else {
  // Fall back to PATH lookup
  const probe = spawnSync('java', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    process.stderr.write(
      '[run-oscillation-tlc] Java not found. Install Java >=17 and set JAVA_HOME.\n' +
      '[run-oscillation-tlc] Download: https://adoptium.net/\n'
    );
    const _startMs = Date.now();
    const _runtimeMs = 0;
    try { writeCheckResult({ tool: 'run-oscillation-tlc', formalism: 'tla', result: 'error', check_id: CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase()), surface: 'tla', property: PROPERTY_MAP[configName] || configName, runtime_ms: _runtimeMs, summary: 'error: Java not found in ' + _runtimeMs + 'ms', requirement_ids: getRequirementIds(CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase())), metadata: { config: configName } }); } catch (e) { process.stderr.write('[run-oscillation-tlc] Warning: failed to write check result: ' + e.message + '\n'); }
    process.exit(1);
  }
  javaExe = 'java';
}

// ── 2. Check Java version >=17 ───────────────────────────────────────────────
const versionResult = spawnSync(javaExe, ['--version'], { encoding: 'utf8' });
if (versionResult.error || versionResult.status !== 0) {
  process.stderr.write('[run-oscillation-tlc] Failed to run: ' + javaExe + ' --version\n');
  const _startMs = Date.now();
  const _runtimeMs = 0;
  try { writeCheckResult({ tool: 'run-oscillation-tlc', formalism: 'tla', result: 'error', check_id: CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase()), surface: 'tla', property: PROPERTY_MAP[configName] || configName, runtime_ms: _runtimeMs, summary: 'error: Java version check failed in ' + _runtimeMs + 'ms', requirement_ids: getRequirementIds(CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase())), metadata: { config: configName } }); } catch (e) { process.stderr.write('[run-oscillation-tlc] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}
const versionOutput = versionResult.stdout + versionResult.stderr;
// Java version string varies: "openjdk 17.0.1 ..." or "java version \"17.0.1\""
const versionMatch = versionOutput.match(/(?:openjdk\s+|java version\s+[""]?)(\d+)/i);
const javaMajor    = versionMatch ? parseInt(versionMatch[1], 10) : 0;
if (javaMajor < 17) {
  process.stderr.write(
    '[run-oscillation-tlc] Java >=17 required. Found: ' + versionOutput.split('\n')[0] + '\n' +
    '[run-oscillation-tlc] Download Java 17+: https://adoptium.net/\n'
  );
  const _startMs = Date.now();
  const _runtimeMs = 0;
  try { writeCheckResult({ tool: 'run-oscillation-tlc', formalism: 'tla', result: 'error', check_id: CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase()), surface: 'tla', property: PROPERTY_MAP[configName] || configName, runtime_ms: _runtimeMs, summary: 'error: Java ' + javaMajor + ' < 17 in ' + _runtimeMs + 'ms', requirement_ids: getRequirementIds(CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase())), metadata: { config: configName } }); } catch (e) { process.stderr.write('[run-oscillation-tlc] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

// ── 3. Locate tla2tools.jar ──────────────────────────────────────────────────
const jarPath = resolveTlaJar(ROOT);
if (!jarPath) {
  process.stderr.write(
    '[run-oscillation-tlc] tla2tools.jar not found.\n' +
    '[run-oscillation-tlc] Install: node bin/install-formal-tools.cjs\n'
  );
  const _startMs = Date.now();
  const _runtimeMs = 0;
  try { writeCheckResult({ tool: 'run-oscillation-tlc', formalism: 'tla', result: 'error', check_id: CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase()), surface: 'tla', property: PROPERTY_MAP[configName] || configName, runtime_ms: _runtimeMs, summary: 'error: tla2tools.jar not found in ' + _runtimeMs + 'ms', requirement_ids: getRequirementIds(CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase())), metadata: { config: configName } }); } catch (e) { process.stderr.write('[run-oscillation-tlc] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

// ── 4. Resolve spec and config paths ─────────────────────────────────────────
const SPEC_FILE_MAP = {
  'MCoscillation': 'NFOscillation.tla',
  'MCconvergence': 'NFConvergence.tla',
  'MCsolve-convergence': 'NFSolveConvergence.tla',
};
const specFileName = SPEC_FILE_MAP[configName];
const specPath = path.join(ROOT, '.planning', 'formal', 'tla', specFileName);
const cfgPath  = path.join(ROOT, '.planning', 'formal', 'tla', configName + '.cfg');

// Both MCoscillation and MCconvergence declare PROPERTY (liveness) clauses in their .cfg files.
// TLC has a known multi-worker liveness checking bug (v1.8.0) — always use -workers 1.
// MCconvergence.cfg declares PROPERTY ConvergenceEventuallyResolves; 'auto' workers is NOT safe.
const workers = '1';

// ── 5. Invoke TLC ────────────────────────────────────────────────────────────
process.stdout.write('[run-oscillation-tlc] Config: ' + configName + '  Workers: ' + workers + '\n');
process.stdout.write('[run-oscillation-tlc] Spec:   ' + specPath + '\n');
process.stdout.write('[run-oscillation-tlc] Cfg:    ' + cfgPath + '\n');

const _startMs = Date.now();
// Use a fixed metadir so TLC overwrites state files instead of creating timestamped dirs
const metaDir = path.join(ROOT, '.planning', 'formal', 'tla', 'states', 'current');
fs.rmSync(metaDir, { recursive: true, force: true });
fs.mkdirSync(metaDir, { recursive: true });

process.stderr.write('[heap] Xms=64m Xmx=' + JAVA_HEAP_MAX + '\n');
const tlcResult = spawnSync(javaExe, [
  '-Xms64m', '-Xmx' + JAVA_HEAP_MAX,
  '-jar', jarPath,
  '-metadir', metaDir,
  '-config', cfgPath,
  '-workers', workers,
  specPath,
], { encoding: 'utf8', stdio: 'inherit' });
const _runtimeMs = Date.now() - _startMs;

if (tlcResult.error) {
  process.stderr.write('[run-oscillation-tlc] TLC invocation failed: ' + tlcResult.error.message + '\n');
  const check_id = CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase());
  const property = PROPERTY_MAP[configName] || configName;
  try { writeCheckResult({ tool: 'run-oscillation-tlc', formalism: 'tla', result: 'error', check_id: check_id, surface: 'tla', property: property, runtime_ms: _runtimeMs, summary: 'error: TLC invocation failed in ' + _runtimeMs + 'ms', requirement_ids: getRequirementIds(check_id), metadata: { config: configName } }); } catch (e) { process.stderr.write('[run-oscillation-tlc] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

const passed = (tlcResult.status || 0) === 0;
const check_id = CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase());
const property = PROPERTY_MAP[configName] || configName;
const triage_tags = _runtimeMs > 120000 ? ['timeout-risk'] : [];

if (passed) {
  const missingDeclarations = detectLivenessProperties(configName, cfgPath);
  if (missingDeclarations.length > 0) {
    try {
      writeCheckResult({
        tool: 'run-oscillation-tlc',
        formalism: 'tla',
        result: 'inconclusive',
        check_id: check_id,
        surface: 'tla',
        property: property,
        runtime_ms: _runtimeMs,
        summary: 'inconclusive: fairness missing in ' + _runtimeMs + 'ms',
        triage_tags: ['needs-fairness'],
        requirement_ids: getRequirementIds(check_id),
        metadata: {
          config: configName,
          reason: 'Fairness declaration missing for: ' + missingDeclarations.join(', '),
        }
      });
    } catch (e) {
      process.stderr.write('[run-oscillation-tlc] Warning: failed to write inconclusive result: ' + e.message + '\n');
    }
    process.stdout.write('[run-oscillation-tlc] Result: inconclusive — fairness declaration missing for: ' + missingDeclarations.join(', ') + '\n');
    process.exit(0);
  }
  try { writeCheckResult({ tool: 'run-oscillation-tlc', formalism: 'tla', result: 'pass', check_id: check_id, surface: 'tla', property: property, runtime_ms: _runtimeMs, summary: 'pass: ' + configName + ' in ' + _runtimeMs + 'ms', triage_tags: triage_tags, requirement_ids: getRequirementIds(check_id), metadata: { config: configName } }); } catch (e) { process.stderr.write('[run-oscillation-tlc] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(0);
} else {
  try { writeCheckResult({ tool: 'run-oscillation-tlc', formalism: 'tla', result: 'fail', check_id: check_id, surface: 'tla', property: property, runtime_ms: _runtimeMs, summary: 'fail: ' + configName + ' in ' + _runtimeMs + 'ms', triage_tags: triage_tags, requirement_ids: getRequirementIds(check_id), metadata: { config: configName } }); } catch (e) { process.stderr.write('[run-oscillation-tlc] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(tlcResult.status || 0);
}

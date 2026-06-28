#!/usr/bin/env node
'use strict';
// bin/run-alloy.cjs
// Generic Alloy 6 runner — invokes any .als spec headless.
// Requirements: ALY-02
//
// Usage:
//   node bin/run-alloy.cjs                        # default: quorum-votes
//   node bin/run-alloy.cjs --spec=AccessControl   # run AccessControl.als
//
// Prerequisites:
//   - Java >=17 (https://adoptium.net/)
//   - .planning/formal/alloy/org.alloytools.alloy.dist.jar (see VERIFICATION_TOOLS.md for download)

const { spawnSync } = require('child_process');
const JAVA_HEAP_MAX = process.env.NF_JAVA_HEAP_MAX || '512m';
const _rawAlloyTimeout = parseInt(process.env.NF_ALLOY_TIMEOUT_MS || '600000', 10); // 10min default
const ALLOY_TIMEOUT_MS = (Number.isInteger(_rawAlloyTimeout) && _rawAlloyTimeout >= 0)
  ? _rawAlloyTimeout
  : 600000;
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { writeCheckResult } = require('./write-check-result.cjs');
const { getRequirementIds } = require('./requirement-map.cjs');

// ── Resolve project root (--project-root= overrides __dirname-relative) ─────
let ROOT = path.join(__dirname, '..');
let specName = 'quorum-votes'; // default for backward compat
let verificationMode = 'validation'; // default verification mode
for (const arg of process.argv) {
  if (arg.startsWith('--project-root=')) ROOT = path.resolve(arg.slice('--project-root='.length));
  if (arg.startsWith('--spec=')) specName = arg.slice('--spec='.length);
  if (arg.startsWith('--verification-mode=')) verificationMode = arg.slice('--verification-mode='.length);
}

const checkId = 'alloy:' + specName;
const alsFile = specName + '.als';

// Helper: write a check result with the current spec's context
function emitResult(result, runtimeMs, extraSummary, extraTags) {
  const reqIds = getRequirementIds(checkId);
  try {
    writeCheckResult({
      tool: 'run-alloy', formalism: 'alloy', result,
      check_id: checkId, surface: 'alloy',
      property: 'Alloy assertions for ' + specName,
      runtime_ms: runtimeMs,
      summary: result + ': ' + checkId + (extraSummary ? ' (' + extraSummary + ')' : '') + (runtimeMs ? ' in ' + runtimeMs + 'ms' : ''),
      triage_tags: (extraTags || []).concat(runtimeMs > 60000 ? ['timeout-risk'] : []),
      requirement_ids: reqIds,
      metadata: { verification_mode: verificationMode },
    });
  } catch (e) {
    process.stderr.write('[run-alloy] Warning: failed to write check result: ' + e.message + '\n');
  }
}

// ── 1. Locate Java ───────────────────────────────────────────────────────────
const JAVA_HOME = process.env.JAVA_HOME;
let javaExe;

if (JAVA_HOME) {
  javaExe = path.join(JAVA_HOME, 'bin', 'java');
  if (!fs.existsSync(javaExe)) {
    process.stderr.write(
      '[run-alloy] JAVA_HOME is set but java binary not found at: ' + javaExe + '\n' +
      '[run-alloy] Unset JAVA_HOME or fix the path.\n'
    );
    emitResult('error', 0, 'Java not found');
    process.exit(1);
  }
} else {
  // Fall back to PATH lookup
  const probe = spawnSync('java', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    process.stderr.write(
      '[run-alloy] Java not found. Install Java >=17 and set JAVA_HOME.\n' +
      '[run-alloy] Download: https://adoptium.net/\n'
    );
    emitResult('error', 0, 'Java not found');
    process.exit(1);
  }
  javaExe = 'java';
}

// ── 2. Check Java version >=17 ───────────────────────────────────────────────
const versionResult = spawnSync(javaExe, ['--version'], { encoding: 'utf8' });
if (versionResult.error || versionResult.status !== 0) {
  process.stderr.write('[run-alloy] Failed to run: ' + javaExe + ' --version\n');
  emitResult('error', 0, 'version check failed');
  process.exit(1);
}
const versionOutput = versionResult.stdout + versionResult.stderr;
const versionMatch = versionOutput.match(/(?:openjdk\s+|java version\s+[""]?)(\d+)/i);
const javaMajor    = versionMatch ? parseInt(versionMatch[1], 10) : 0;
if (javaMajor < 17) {
  process.stderr.write(
    '[run-alloy] Java >=17 required. Found: ' + versionOutput.split('\n')[0] + '\n' +
    '[run-alloy] Download Java 17+: https://adoptium.net/\n'
  );
  emitResult('error', 0, 'Java < 17');
  process.exit(1);
}

// ── 3. Locate org.alloytools.alloy.dist.jar ──────────────────────────────────
const { resolveAlloyJar } = require('./resolve-formal-tools.cjs');
const jarPath = resolveAlloyJar(ROOT);
if (!jarPath) {
  const { NF_FORMAL_HOME } = require('./resolve-formal-tools.cjs');
  const searchedPaths = [
    path.join(NF_FORMAL_HOME, 'alloy', 'org.alloytools.alloy.dist.jar'),
    path.join(ROOT, '.planning', 'formal', 'alloy', 'org.alloytools.alloy.dist.jar'),
    path.join(os.homedir(), '.claude', '.planning', 'formal', 'alloy', 'org.alloytools.alloy.dist.jar'),
  ];
  process.stderr.write(
    '[run-alloy] org.alloytools.alloy.dist.jar not found.\n' +
    '[run-alloy] Searched:\n' +
    searchedPaths.map(p => '  - ' + p).join('\n') + '\n' +
    '[run-alloy] Download Alloy 6.2.0:\n' +
    '  curl -L https://github.com/AlloyTools/org.alloytools.alloy/releases/download/v6.2.0/org.alloytools.alloy.dist.jar \\\n' +
    '       -o .planning/formal/alloy/org.alloytools.alloy.dist.jar\n'
  );
  emitResult('error', 0, 'JAR not found');
  process.exit(1);
}

// ── 4. Locate the .als spec file ─────────────────────────────────────────────
const alsPath = path.join(ROOT, '.planning', 'formal', 'alloy', alsFile);
if (!fs.existsSync(alsPath)) {
  process.stderr.write(
    '[run-alloy] ' + alsFile + ' not found at: ' + alsPath + '\n' +
    '[run-alloy] Check that the Alloy spec exists in .planning/formal/alloy/\n'
  );
  emitResult('error', 0, 'ALS not found');
  process.exit(1);
}

// ── 5. Invoke Alloy 6 ────────────────────────────────────────────────────────
process.stdout.write('[run-alloy] ALS: ' + alsPath + '\n');
process.stdout.write('[run-alloy] JAR: ' + jarPath + '\n');

const _startMs = Date.now();

// Use stdio: 'pipe' so we can scan stdout for counterexamples (Alloy exits 0 even on CEX)
process.stderr.write('[heap] Xms=64m Xmx=' + JAVA_HEAP_MAX + '\n');
const alloyResult = spawnSync(javaExe, [
  '-Djava.awt.headless=true',
  '-Xms64m', '-Xmx' + JAVA_HEAP_MAX,
  '-jar', jarPath,
  'exec',
  '--output', '-',
  '--type', 'text',
  '--quiet',
  alsPath,
], { encoding: 'utf8', stdio: 'pipe', timeout: ALLOY_TIMEOUT_MS });

if (alloyResult.signal === 'SIGTERM') {
  process.stderr.write('[run-alloy] Alloy killed after ' + ALLOY_TIMEOUT_MS + 'ms timeout\n');
  try {
    writeCheckResult({
      tool: 'run-alloy', formalism: 'alloy', result: 'error',
      check_id: checkId, surface: 'alloy', property: 'Alloy assertions for ' + specName,
      runtime_ms: Date.now() - _startMs,
      summary: 'timeout: Alloy killed after ' + (ALLOY_TIMEOUT_MS/1000) + 's',
      requirement_ids: getRequirementIds(checkId),
      triage_tags: ['timeout-killed'],
      metadata: { verification_mode: verificationMode, timeout_ms: ALLOY_TIMEOUT_MS }
    });
  } catch (e) {
    process.stderr.write('[run-alloy] Warning: failed to write check result: ' + e.message + '\n');
  }
  process.exit(1);
}

if (alloyResult.error) {
  process.stderr.write('[run-alloy] Alloy invocation failed: ' + alloyResult.error.message + '\n');
  emitResult('error', Date.now() - _startMs, 'invocation failed');
  process.exit(1);
}

// ── 6. Scan stdout for counterexamples ───────────────────────────────────────
// Alloy 6 exits 0 even when counterexamples are found. Scan stdout to detect them.
const stdout = alloyResult.stdout || '';
const stderr = alloyResult.stderr || '';

// Write stdout to process.stdout (mirrors stdio: 'inherit' output)
if (stdout) { process.stdout.write(stdout); }
if (stderr) { process.stderr.write(stderr); }

if (/Counterexample/i.test(stdout)) {
  process.stderr.write(
    '[run-alloy] WARNING: Counterexample found in ' + alsFile + ' assertions.\n' +
    '[run-alloy] This indicates a spec violation — review ' + alsFile + '.\n'
  );
  emitResult('fail', Date.now() - _startMs);
  process.exit(1);
}

if (alloyResult.status !== 0) {
  emitResult('fail', Date.now() - _startMs);
  process.exit(alloyResult.status || 1);
}

emitResult('pass', Date.now() - _startMs);
process.exit(0);

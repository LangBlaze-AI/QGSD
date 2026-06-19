#!/usr/bin/env node
'use strict';
// bin/run-account-pool-alloy.cjs
// Invokes Alloy 6 JAR headless for the nForma account pool structure spec.
// Requirements: ALY-AM-01
//
// Usage:
//   node bin/run-account-pool-alloy.cjs
//
// Checks (defined in .planning/formal/alloy/account-pool-structure.als):
//   AddPreservesValidity    — adding to a valid state yields a valid state
//   SwitchPreservesValidity — switching in a valid state yields a valid state
//   RemovePreservesValidity — removing from a valid state yields a valid state
//   SwitchPreservesPool     — switch never modifies pool membership
//   RemoveShrinksPool       — remove reduces pool size by exactly one
//
// Prerequisites:
//   - Java >=17 (https://adoptium.net/)
//   - .planning/formal/alloy/org.alloytools.alloy.dist.jar (see VERIFICATION_TOOLS.md for download)

const { spawnSync } = require('child_process');
const JAVA_HEAP_MAX = process.env.NF_JAVA_HEAP_MAX || '512m';
const fs   = require('fs');
const path = require('path');
const { writeCheckResult } = require('./write-check-result.cjs');
const { resolveAlloyJar } = require('./resolve-formal-tools.cjs');
const { getRequirementIds } = require('./requirement-map.cjs');
const { runAlloy } = require('./alloy-exec.cjs');

// ── Resolve project root (--project-root= overrides __dirname-relative) ─────
let ROOT = path.join(__dirname, '..');
for (const arg of process.argv) {
  if (arg.startsWith('--project-root=')) ROOT = path.resolve(arg.slice('--project-root='.length));
}

// ── 1. Locate Java ───────────────────────────────────────────────────────────
const JAVA_HOME = process.env.JAVA_HOME;
let javaExe;

if (JAVA_HOME) {
  javaExe = path.join(JAVA_HOME, 'bin', 'java');
  if (!fs.existsSync(javaExe)) {
    process.stderr.write(
      '[run-account-pool-alloy] JAVA_HOME is set but java binary not found at: ' + javaExe + '\n' +
      '[run-account-pool-alloy] Unset JAVA_HOME or fix the path.\n'
    );
    try { writeCheckResult({ tool: 'run-account-pool-alloy', formalism: 'alloy', result: 'error', check_id: 'alloy:account-pool', surface: 'alloy', property: 'Account pool state machine — slot assignment and release invariants', runtime_ms: 0, summary: 'error: alloy:account-pool (Java not found)', triage_tags: [], requirement_ids: getRequirementIds('alloy:account-pool'), metadata: {} }); } catch (e) { process.stderr.write('[run-account-pool-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
    process.exit(1);
  }
} else {
  const probe = spawnSync('java', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    process.stderr.write(
      '[run-account-pool-alloy] Java not found. Install Java >=17 and set JAVA_HOME.\n' +
      '[run-account-pool-alloy] Download: https://adoptium.net/\n'
    );
    try { writeCheckResult({ tool: 'run-account-pool-alloy', formalism: 'alloy', result: 'error', check_id: 'alloy:account-pool', surface: 'alloy', property: 'Account pool state machine — slot assignment and release invariants', runtime_ms: 0, summary: 'error: alloy:account-pool (Java not found)', triage_tags: [], requirement_ids: getRequirementIds('alloy:account-pool'), metadata: {} }); } catch (e) { process.stderr.write('[run-account-pool-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
    process.exit(1);
  }
  javaExe = 'java';
}

// ── 2. Check Java version >=17 ───────────────────────────────────────────────
const versionResult = spawnSync(javaExe, ['--version'], { encoding: 'utf8' });
if (versionResult.error || versionResult.status !== 0) {
  process.stderr.write('[run-account-pool-alloy] Failed to run: ' + javaExe + ' --version\n');
  try { writeCheckResult({ tool: 'run-account-pool-alloy', formalism: 'alloy', result: 'error', check_id: 'alloy:account-pool', surface: 'alloy', property: 'Account pool state machine — slot assignment and release invariants', runtime_ms: 0, summary: 'error: alloy:account-pool (version check failed)', triage_tags: [], requirement_ids: getRequirementIds('alloy:account-pool'), metadata: {} }); } catch (e) { process.stderr.write('[run-account-pool-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}
const versionOutput = versionResult.stdout + versionResult.stderr;
const versionMatch  = versionOutput.match(/(?:openjdk\s+|java version\s+[""]?)(\d+)/i);
const javaMajor     = versionMatch ? parseInt(versionMatch[1], 10) : 0;
if (javaMajor < 17) {
  process.stderr.write(
    '[run-account-pool-alloy] Java >=17 required. Found: ' + versionOutput.split('\n')[0] + '\n' +
    '[run-account-pool-alloy] Download Java 17+: https://adoptium.net/\n'
  );
  try { writeCheckResult({ tool: 'run-account-pool-alloy', formalism: 'alloy', result: 'error', check_id: 'alloy:account-pool', surface: 'alloy', property: 'Account pool state machine — slot assignment and release invariants', runtime_ms: 0, summary: 'error: alloy:account-pool (Java < 17)', triage_tags: [], requirement_ids: getRequirementIds('alloy:account-pool'), metadata: {} }); } catch (e) { process.stderr.write('[run-account-pool-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

// ── 3. Locate org.alloytools.alloy.dist.jar ──────────────────────────────────
const jarPath = resolveAlloyJar(ROOT);
if (!jarPath) {
  process.stderr.write(
    '[run-account-pool-alloy] org.alloytools.alloy.dist.jar not found.\n' +
    '[run-account-pool-alloy] Install: node bin/install-formal-tools.cjs\n'
  );
  try { writeCheckResult({ tool: 'run-account-pool-alloy', formalism: 'alloy', result: 'error', check_id: 'alloy:account-pool', surface: 'alloy', property: 'Account pool state machine — slot assignment and release invariants', runtime_ms: 0, summary: 'error: alloy:account-pool (JAR not found)', triage_tags: [], requirement_ids: getRequirementIds('alloy:account-pool'), metadata: {} }); } catch (e) { process.stderr.write('[run-account-pool-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

// ── 4. Locate .planning/formal/alloy/account-pool-structure.als ────────────────────────
const alsPath = path.join(ROOT, '.planning', 'formal', 'alloy', 'account-pool-structure.als');
if (!fs.existsSync(alsPath)) {
  process.stderr.write(
    '[run-account-pool-alloy] account-pool-structure.als not found at: ' + alsPath + '\n' +
    '[run-account-pool-alloy] This file should exist in the repository. Check your git status.\n'
  );
  try { writeCheckResult({ tool: 'run-account-pool-alloy', formalism: 'alloy', result: 'error', check_id: 'alloy:account-pool', surface: 'alloy', property: 'Account pool state machine — slot assignment and release invariants', runtime_ms: 0, summary: 'error: alloy:account-pool (ALS not found)', triage_tags: [], requirement_ids: getRequirementIds('alloy:account-pool'), metadata: {} }); } catch (e) { process.stderr.write('[run-account-pool-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

// ── 5. Invoke Alloy 6 ────────────────────────────────────────────────────────
process.stdout.write('[run-account-pool-alloy] ALS: ' + alsPath + '\n');
process.stdout.write('[run-account-pool-alloy] JAR: ' + jarPath + '\n');

const _startMs = Date.now();

// ── 6. Invoke Alloy via shared executor and parse the structured receipt ──────
// Alloy 6 exits 0 even when counterexamples are found, and never prints the word
// "Counterexample" (issue #199). alloy-exec.cjs parses receipt.json: a `check`
// that yields an instance is a counterexample => fail; a `run{}` with no instance
// trips the vacuity guard => fail.
process.stderr.write('[heap] Xms=64m Xmx=' + JAVA_HEAP_MAX + '\n');
const alloyRun = runAlloy({ javaExe, jarPath, alsPath, heapMax: JAVA_HEAP_MAX });

if (alloyRun.stdout) { process.stdout.write(alloyRun.stdout); }
if (alloyRun.stderr) { process.stderr.write(alloyRun.stderr); }

if (alloyRun.status === 'timeout') {
  process.stderr.write('[run-account-pool-alloy] Alloy timed out: ' + alloyRun.error + '\n');
  const _runtimeMs = Date.now() - _startMs;
  try { writeCheckResult({ tool: 'run-account-pool-alloy', formalism: 'alloy', result: 'fail', check_id: 'alloy:account-pool', surface: 'alloy', property: 'Account pool state machine — slot assignment and release invariants', runtime_ms: _runtimeMs, summary: 'timeout: alloy:account-pool after ' + _runtimeMs + 'ms', triage_tags: ['timeout-killed'], requirement_ids: getRequirementIds('alloy:account-pool'), metadata: {} }); } catch (e) { process.stderr.write('[run-account-pool-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

if (alloyRun.status === 'error') {
  process.stderr.write('[run-account-pool-alloy] Alloy invocation failed: ' + alloyRun.error + '\n');
  const _runtimeMs = Date.now() - _startMs;
  try { writeCheckResult({ tool: 'run-account-pool-alloy', formalism: 'alloy', result: 'error', check_id: 'alloy:account-pool', surface: 'alloy', property: 'Account pool state machine — slot assignment and release invariants', runtime_ms: _runtimeMs, summary: 'error: alloy:account-pool (' + alloyRun.error + ')', triage_tags: [], requirement_ids: getRequirementIds('alloy:account-pool'), metadata: {} }); } catch (e) { process.stderr.write('[run-account-pool-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

const outcome = alloyRun.outcome;
if (!outcome.ok) {
  process.stderr.write(
    '[run-account-pool-alloy] WARNING: Alloy verification FAILED for account-pool-structure.als\n' +
    '[run-account-pool-alloy] ' + outcome.summary + '\n' +
    '[run-account-pool-alloy] This indicates a structural invariant violation — review .planning/formal/alloy/account-pool-structure.als.\n'
  );
  const _runtimeMs = Date.now() - _startMs;
  try { writeCheckResult({ tool: 'run-account-pool-alloy', formalism: 'alloy', result: 'fail', check_id: 'alloy:account-pool', surface: 'alloy', property: 'Account pool state machine — slot assignment and release invariants', runtime_ms: _runtimeMs, summary: 'fail: alloy:account-pool in ' + _runtimeMs + 'ms', triage_tags: _runtimeMs > 60000 ? ['timeout-risk'] : [], requirement_ids: getRequirementIds('alloy:account-pool'), metadata: { failures: outcome.failures } }); } catch (e) { process.stderr.write('[run-account-pool-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

const _runtimeMs = Date.now() - _startMs;
try { writeCheckResult({ tool: 'run-account-pool-alloy', formalism: 'alloy', result: 'pass', check_id: 'alloy:account-pool', surface: 'alloy', property: 'Account pool state machine — slot assignment and release invariants', runtime_ms: _runtimeMs, summary: 'pass: alloy:account-pool in ' + _runtimeMs + 'ms', triage_tags: _runtimeMs > 60000 ? ['timeout-risk'] : [], requirement_ids: getRequirementIds('alloy:account-pool'), metadata: {} }); } catch (e) { process.stderr.write('[run-account-pool-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
process.exit(0);

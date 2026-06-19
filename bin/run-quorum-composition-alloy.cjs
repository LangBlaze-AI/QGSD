#!/usr/bin/env node
'use strict';
// bin/run-quorum-composition-alloy.cjs
// Invokes Alloy 6 JAR headless for the nForma quorum composition model.
// Requirements: SPEC-03
//
// Usage:
//   node bin/run-quorum-composition-alloy.cjs
//
// Prerequisites:
//   - Java >=17 (https://adoptium.net/)
//   - .planning/formal/alloy/org.alloytools.alloy.dist.jar (see VERIFICATION_TOOLS.md for download)

const { spawnSync } = require('child_process');
const JAVA_HEAP_MAX = process.env.NF_JAVA_HEAP_MAX || '512m';
const fs   = require('fs');
const path = require('path');
const { writeCheckResult } = require('./write-check-result.cjs');
const { getRequirementIds } = require('./requirement-map.cjs');
const { resolveAlloyJar } = require('./resolve-formal-tools.cjs');
const { runAlloy } = require('./alloy-exec.cjs');

// ── Resolve project root (--project-root= overrides __dirname-relative) ─────
let ROOT = path.join(__dirname, '..');
for (const arg of process.argv) {
  if (arg.startsWith('--project-root=')) ROOT = path.resolve(arg.slice('--project-root='.length));
}

const CHECK_ID = 'alloy:quorum-composition';
const PROPERTY = 'Quorum composition rules — no empty selection, high-risk full fan-out, solo mode single slot';

// ── 1. Locate Java ───────────────────────────────────────────────────────────
const JAVA_HOME = process.env.JAVA_HOME;
let javaExe;

if (JAVA_HOME) {
  javaExe = path.join(JAVA_HOME, 'bin', 'java');
  if (!fs.existsSync(javaExe)) {
    process.stderr.write(
      '[run-quorum-composition-alloy] JAVA_HOME is set but java binary not found at: ' + javaExe + '\n' +
      '[run-quorum-composition-alloy] Unset JAVA_HOME or fix the path.\n'
    );
    try { writeCheckResult({ tool: 'run-quorum-composition-alloy', formalism: 'alloy', result: 'error', check_id: CHECK_ID, surface: 'alloy', property: PROPERTY, runtime_ms: 0, summary: 'error: ' + CHECK_ID + ' (Java not found)', triage_tags: [], requirement_ids: getRequirementIds(CHECK_ID), metadata: {} }); } catch (e) { process.stderr.write('[run-quorum-composition-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
    process.exit(1);
  }
} else {
  // Fall back to PATH lookup
  const probe = spawnSync('java', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    process.stderr.write(
      '[run-quorum-composition-alloy] Java not found. Install Java >=17 and set JAVA_HOME.\n' +
      '[run-quorum-composition-alloy] Download: https://adoptium.net/\n'
    );
    try { writeCheckResult({ tool: 'run-quorum-composition-alloy', formalism: 'alloy', result: 'error', check_id: CHECK_ID, surface: 'alloy', property: PROPERTY, runtime_ms: 0, summary: 'error: ' + CHECK_ID + ' (Java not found)', triage_tags: [], requirement_ids: getRequirementIds(CHECK_ID), metadata: {} }); } catch (e) { process.stderr.write('[run-quorum-composition-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
    process.exit(1);
  }
  javaExe = 'java';
}

// ── 2. Check Java version >=17 ───────────────────────────────────────────────
const versionResult = spawnSync(javaExe, ['--version'], { encoding: 'utf8' });
if (versionResult.error || versionResult.status !== 0) {
  process.stderr.write('[run-quorum-composition-alloy] Failed to run: ' + javaExe + ' --version\n');
  try { writeCheckResult({ tool: 'run-quorum-composition-alloy', formalism: 'alloy', result: 'error', check_id: CHECK_ID, surface: 'alloy', property: PROPERTY, runtime_ms: 0, summary: 'error: ' + CHECK_ID + ' (version check failed)', triage_tags: [], requirement_ids: getRequirementIds(CHECK_ID), metadata: {} }); } catch (e) { process.stderr.write('[run-quorum-composition-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}
const versionOutput = versionResult.stdout + versionResult.stderr;
const versionMatch = versionOutput.match(/(?:openjdk\s+|java version\s+[""]?)(\d+)/i);
const javaMajor    = versionMatch ? parseInt(versionMatch[1], 10) : 0;
if (javaMajor < 17) {
  process.stderr.write(
    '[run-quorum-composition-alloy] Java >=17 required. Found: ' + versionOutput.split('\n')[0] + '\n' +
    '[run-quorum-composition-alloy] Download Java 17+: https://adoptium.net/\n'
  );
  try { writeCheckResult({ tool: 'run-quorum-composition-alloy', formalism: 'alloy', result: 'error', check_id: CHECK_ID, surface: 'alloy', property: PROPERTY, runtime_ms: 0, summary: 'error: ' + CHECK_ID + ' (Java < 17)', triage_tags: [], requirement_ids: getRequirementIds(CHECK_ID), metadata: {} }); } catch (e) { process.stderr.write('[run-quorum-composition-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

// ── 3. Locate org.alloytools.alloy.dist.jar ──────────────────────────────────
const jarPath = resolveAlloyJar(ROOT);
if (!jarPath) {
  process.stderr.write(
    '[run-quorum-composition-alloy] org.alloytools.alloy.dist.jar not found.\n' +
    '[run-quorum-composition-alloy] Install: node bin/install-formal-tools.cjs\n'
  );
  try { writeCheckResult({ tool: 'run-quorum-composition-alloy', formalism: 'alloy', result: 'error', check_id: CHECK_ID, surface: 'alloy', property: PROPERTY, runtime_ms: 0, summary: 'error: ' + CHECK_ID + ' (JAR not found)', triage_tags: [], requirement_ids: getRequirementIds(CHECK_ID), metadata: {} }); } catch (e) { process.stderr.write('[run-quorum-composition-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

// ── 4. Locate .planning/formal/alloy/quorum-composition.als ────────────────────────────
const alsPath = path.join(ROOT, '.planning', 'formal', 'alloy', 'quorum-composition.als');
if (!fs.existsSync(alsPath)) {
  process.stderr.write(
    '[run-quorum-composition-alloy] quorum-composition.als not found at: ' + alsPath + '\n' +
    '[run-quorum-composition-alloy] This file should exist in the repository. Check your git status.\n'
  );
  try { writeCheckResult({ tool: 'run-quorum-composition-alloy', formalism: 'alloy', result: 'error', check_id: CHECK_ID, surface: 'alloy', property: PROPERTY, runtime_ms: 0, summary: 'error: ' + CHECK_ID + ' (ALS not found)', triage_tags: [], requirement_ids: getRequirementIds(CHECK_ID), metadata: {} }); } catch (e) { process.stderr.write('[run-quorum-composition-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

// ── 5. Invoke Alloy 6 ────────────────────────────────────────────────────────
process.stdout.write('[run-quorum-composition-alloy] ALS: ' + alsPath + '\n');
process.stdout.write('[run-quorum-composition-alloy] JAR: ' + jarPath + '\n');

const _startMs = Date.now();

// ── 6. Invoke Alloy via shared executor and parse the structured receipt ──────
// Alloy 6 exits 0 even when counterexamples are found. The legacy
// `/Counterexample/i.test(stdout)` regex was dead — Alloy never prints that word
// (issue #199). alloy-exec.cjs parses receipt.json, the unambiguous per-command
// outcome carrier (a `check` that yields an instance is a counterexample => fail;
// a `run{}` that yields no instance trips the vacuity guard => fail).
process.stderr.write('[heap] Xms=64m Xmx=' + JAVA_HEAP_MAX + '\n');
const alloyRun = runAlloy({ javaExe, jarPath, alsPath, heapMax: JAVA_HEAP_MAX });

if (alloyRun.stdout) { process.stdout.write(alloyRun.stdout); }
if (alloyRun.stderr) { process.stderr.write(alloyRun.stderr); }

if (alloyRun.status === 'timeout') {
  process.stderr.write('[run-quorum-composition-alloy] Alloy timed out: ' + alloyRun.error + '\n');
  const _runtimeMs = Date.now() - _startMs;
  try { writeCheckResult({ tool: 'run-quorum-composition-alloy', formalism: 'alloy', result: 'fail', check_id: CHECK_ID, surface: 'alloy', property: PROPERTY, runtime_ms: _runtimeMs, summary: 'timeout: ' + CHECK_ID + ' after ' + _runtimeMs + 'ms', triage_tags: ['timeout-killed'], requirement_ids: getRequirementIds(CHECK_ID), metadata: {} }); } catch (e) { process.stderr.write('[run-quorum-composition-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

if (alloyRun.status === 'error') {
  process.stderr.write('[run-quorum-composition-alloy] Alloy invocation failed: ' + alloyRun.error + '\n');
  const _runtimeMs = Date.now() - _startMs;
  try { writeCheckResult({ tool: 'run-quorum-composition-alloy', formalism: 'alloy', result: 'error', check_id: CHECK_ID, surface: 'alloy', property: PROPERTY, runtime_ms: _runtimeMs, summary: 'error: ' + CHECK_ID + ' (' + alloyRun.error + ')', triage_tags: [], requirement_ids: getRequirementIds(CHECK_ID), metadata: {} }); } catch (e) { process.stderr.write('[run-quorum-composition-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

const outcome = alloyRun.outcome;
if (!outcome.ok) {
  process.stderr.write(
    '[run-quorum-composition-alloy] WARNING: Alloy verification FAILED for quorum-composition.als\n' +
    '[run-quorum-composition-alloy] ' + outcome.summary + '\n' +
    '[run-quorum-composition-alloy] This indicates a spec violation — review quorum-composition.als.\n'
  );
  const _runtimeMs = Date.now() - _startMs;
  try { writeCheckResult({ tool: 'run-quorum-composition-alloy', formalism: 'alloy', result: 'fail', check_id: CHECK_ID, surface: 'alloy', property: PROPERTY, runtime_ms: _runtimeMs, summary: 'fail: ' + CHECK_ID + ' in ' + _runtimeMs + 'ms', triage_tags: _runtimeMs > 60000 ? ['timeout-risk'] : [], requirement_ids: getRequirementIds(CHECK_ID), metadata: { failures: outcome.failures } }); } catch (e) { process.stderr.write('[run-quorum-composition-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

const _runtimeMs = Date.now() - _startMs;
try { writeCheckResult({ tool: 'run-quorum-composition-alloy', formalism: 'alloy', result: 'pass', check_id: CHECK_ID, surface: 'alloy', property: PROPERTY, runtime_ms: _runtimeMs, summary: 'pass: ' + CHECK_ID + ' in ' + _runtimeMs + 'ms', triage_tags: _runtimeMs > 60000 ? ['timeout-risk'] : [], requirement_ids: getRequirementIds(CHECK_ID), metadata: {} }); } catch (e) { process.stderr.write('[run-quorum-composition-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
process.exit(0);

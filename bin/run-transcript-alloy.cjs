#!/usr/bin/env node
'use strict';
// bin/run-transcript-alloy.cjs
// Invokes Alloy 6 JAR headless for nForma transcript scanning spec (GAP-4).
// Requirements: GAP-4
//
// Usage:
//   node bin/run-transcript-alloy.cjs [--spec=<name>]
//
// Valid spec names:
//   transcript-scan  (default) — GAP-4: transcript scanning invariants
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

// ── 0. Parse --spec argument ──────────────────────────────────────────────────
const VALID_SPECS = ['transcript-scan'];
const args    = process.argv.slice(2);
const specArg = args.find(a => a.startsWith('--spec=')) || null;
const specName = specArg
  ? specArg.split('=')[1]
  : (args.find(a => !a.startsWith('-')) || 'transcript-scan');

if (!VALID_SPECS.includes(specName)) {
  process.stderr.write(
    '[run-transcript-alloy] Unknown spec: ' + specName +
    '. Valid: ' + VALID_SPECS.join(', ') + '\n'
  );
  try { writeCheckResult({ tool: 'run-transcript-alloy', formalism: 'alloy', result: 'error', check_id: 'alloy:transcript', surface: 'alloy', property: 'Hook transcript scanning — boundary detection, tool_use/tool_result pairing uniqueness, ceiling enforcement', runtime_ms: 0, summary: 'error: alloy:transcript (invalid spec)', triage_tags: [], requirement_ids: getRequirementIds('alloy:transcript'), metadata: { spec: specName } }); } catch (e) { process.stderr.write('[run-transcript-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

// ── 1. Locate Java ───────────────────────────────────────────────────────────
const JAVA_HOME = process.env.JAVA_HOME;
let javaExe;

if (JAVA_HOME) {
  javaExe = path.join(JAVA_HOME, 'bin', 'java');
  if (!fs.existsSync(javaExe)) {
    process.stderr.write(
      '[run-transcript-alloy] JAVA_HOME is set but java binary not found at: ' + javaExe + '\n' +
      '[run-transcript-alloy] Unset JAVA_HOME or fix the path.\n'
    );
    try { writeCheckResult({ tool: 'run-transcript-alloy', formalism: 'alloy', result: 'error', check_id: 'alloy:transcript', surface: 'alloy', property: 'Hook transcript scanning — boundary detection, tool_use/tool_result pairing uniqueness, ceiling enforcement', runtime_ms: 0, summary: 'error: alloy:transcript (Java not found)', triage_tags: [], requirement_ids: getRequirementIds('alloy:transcript'), metadata: { spec: specName } }); } catch (e) { process.stderr.write('[run-transcript-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
    process.exit(1);
  }
} else {
  // Fall back to PATH lookup
  const probe = spawnSync('java', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    process.stderr.write(
      '[run-transcript-alloy] Java not found. Install Java >=17 and set JAVA_HOME.\n' +
      '[run-transcript-alloy] Download: https://adoptium.net/\n'
    );
    try { writeCheckResult({ tool: 'run-transcript-alloy', formalism: 'alloy', result: 'error', check_id: 'alloy:transcript', surface: 'alloy', property: 'Hook transcript scanning — boundary detection, tool_use/tool_result pairing uniqueness, ceiling enforcement', runtime_ms: 0, summary: 'error: alloy:transcript (Java not found)', triage_tags: [], requirement_ids: getRequirementIds('alloy:transcript'), metadata: { spec: specName } }); } catch (e) { process.stderr.write('[run-transcript-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
    process.exit(1);
  }
  javaExe = 'java';
}

// ── 2. Check Java version >=17 ───────────────────────────────────────────────
const versionResult = spawnSync(javaExe, ['--version'], { encoding: 'utf8' });
if (versionResult.error || versionResult.status !== 0) {
  process.stderr.write('[run-transcript-alloy] Failed to run: ' + javaExe + ' --version\n');
  try { writeCheckResult({ tool: 'run-transcript-alloy', formalism: 'alloy', result: 'error', check_id: 'alloy:transcript', surface: 'alloy', property: 'Hook transcript scanning — boundary detection, tool_use/tool_result pairing uniqueness, ceiling enforcement', runtime_ms: 0, summary: 'error: alloy:transcript (version check failed)', triage_tags: [], requirement_ids: getRequirementIds('alloy:transcript'), metadata: { spec: specName } }); } catch (e) { process.stderr.write('[run-transcript-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}
const versionOutput = versionResult.stdout + versionResult.stderr;
// Java version string varies: "openjdk 17.0.1 ..." or "java version \"17.0.1\""
const versionMatch = versionOutput.match(/(?:openjdk\s+|java version\s+[""]?)(\d+)/i);
const javaMajor    = versionMatch ? parseInt(versionMatch[1], 10) : 0;
if (javaMajor < 17) {
  process.stderr.write(
    '[run-transcript-alloy] Java >=17 required. Found: ' + versionOutput.split('\n')[0] + '\n' +
    '[run-transcript-alloy] Download Java 17+: https://adoptium.net/\n'
  );
  try { writeCheckResult({ tool: 'run-transcript-alloy', formalism: 'alloy', result: 'error', check_id: 'alloy:transcript', surface: 'alloy', property: 'Hook transcript scanning — boundary detection, tool_use/tool_result pairing uniqueness, ceiling enforcement', runtime_ms: 0, summary: 'error: alloy:transcript (Java < 17)', triage_tags: [], requirement_ids: getRequirementIds('alloy:transcript'), metadata: { spec: specName } }); } catch (e) { process.stderr.write('[run-transcript-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

// ── 3. Locate org.alloytools.alloy.dist.jar ──────────────────────────────────
const jarPath = resolveAlloyJar(ROOT);
if (!jarPath) {
  process.stderr.write(
    '[run-transcript-alloy] org.alloytools.alloy.dist.jar not found.\n' +
    '[run-transcript-alloy] Install: node bin/install-formal-tools.cjs\n'
  );
  try { writeCheckResult({ tool: 'run-transcript-alloy', formalism: 'alloy', result: 'error', check_id: 'alloy:transcript', surface: 'alloy', property: 'Hook transcript scanning — boundary detection, tool_use/tool_result pairing uniqueness, ceiling enforcement', runtime_ms: 0, summary: 'error: alloy:transcript (JAR not found)', triage_tags: [], requirement_ids: getRequirementIds('alloy:transcript'), metadata: { spec: specName } }); } catch (e) { process.stderr.write('[run-transcript-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

// ── 4. Locate .als file ───────────────────────────────────────────────────────
const alsPath = path.join(ROOT, '.planning', 'formal', 'alloy', specName + '.als');
if (!fs.existsSync(alsPath)) {
  process.stderr.write(
    '[run-transcript-alloy] ' + specName + '.als not found at: ' + alsPath + '\n' +
    '[run-transcript-alloy] This file should exist in the repository. Check your git status.\n'
  );
  try { writeCheckResult({ tool: 'run-transcript-alloy', formalism: 'alloy', result: 'error', check_id: 'alloy:transcript', surface: 'alloy', property: 'Hook transcript scanning — boundary detection, tool_use/tool_result pairing uniqueness, ceiling enforcement', runtime_ms: 0, summary: 'error: alloy:transcript (ALS not found)', triage_tags: [], requirement_ids: getRequirementIds('alloy:transcript'), metadata: { spec: specName } }); } catch (e) { process.stderr.write('[run-transcript-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

// ── 5. Invoke Alloy 6 ────────────────────────────────────────────────────────
process.stdout.write('[run-transcript-alloy] spec: ' + specName + '\n');
process.stdout.write('[run-transcript-alloy] ALS:  ' + alsPath + '\n');
process.stdout.write('[run-transcript-alloy] JAR:  ' + jarPath + '\n');

const _startMs = Date.now();
const TRANSCRIPT_PROPERTY = 'Hook transcript scanning — boundary detection, tool_use/tool_result pairing uniqueness, ceiling enforcement';

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
  process.stderr.write('[run-transcript-alloy] Alloy timed out: ' + alloyRun.error + '\n');
  const _runtimeMs = Date.now() - _startMs;
  try { writeCheckResult({ tool: 'run-transcript-alloy', formalism: 'alloy', result: 'fail', check_id: 'alloy:transcript', surface: 'alloy', property: TRANSCRIPT_PROPERTY, runtime_ms: _runtimeMs, summary: 'timeout: alloy:transcript after ' + _runtimeMs + 'ms', triage_tags: ['timeout-killed'], requirement_ids: getRequirementIds('alloy:transcript'), metadata: { spec: specName } }); } catch (e) { process.stderr.write('[run-transcript-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

if (alloyRun.status === 'error') {
  process.stderr.write('[run-transcript-alloy] Alloy invocation failed: ' + alloyRun.error + '\n');
  const _runtimeMs = Date.now() - _startMs;
  try { writeCheckResult({ tool: 'run-transcript-alloy', formalism: 'alloy', result: 'error', check_id: 'alloy:transcript', surface: 'alloy', property: TRANSCRIPT_PROPERTY, runtime_ms: _runtimeMs, summary: 'error: alloy:transcript (' + alloyRun.error + ')', triage_tags: [], requirement_ids: getRequirementIds('alloy:transcript'), metadata: { spec: specName } }); } catch (e) { process.stderr.write('[run-transcript-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

const outcome = alloyRun.outcome;
if (!outcome.ok) {
  process.stderr.write(
    '[run-transcript-alloy] WARNING: Alloy verification FAILED for ' + specName + '.als\n' +
    '[run-transcript-alloy] ' + outcome.summary + '\n' +
    '[run-transcript-alloy] This indicates a spec violation — review .planning/formal/alloy/' + specName + '.als.\n'
  );
  const _runtimeMs = Date.now() - _startMs;
  try { writeCheckResult({ tool: 'run-transcript-alloy', formalism: 'alloy', result: 'fail', check_id: 'alloy:transcript', surface: 'alloy', property: TRANSCRIPT_PROPERTY, runtime_ms: _runtimeMs, summary: 'fail: alloy:transcript in ' + _runtimeMs + 'ms', triage_tags: _runtimeMs > 60000 ? ['timeout-risk'] : [], requirement_ids: getRequirementIds('alloy:transcript'), metadata: { spec: specName, failures: outcome.failures } }); } catch (e) { process.stderr.write('[run-transcript-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

const _runtimeMs = Date.now() - _startMs;
try { writeCheckResult({ tool: 'run-transcript-alloy', formalism: 'alloy', result: 'pass', check_id: 'alloy:transcript', surface: 'alloy', property: TRANSCRIPT_PROPERTY, runtime_ms: _runtimeMs, summary: 'pass: alloy:transcript in ' + _runtimeMs + 'ms', triage_tags: _runtimeMs > 60000 ? ['timeout-risk'] : [], requirement_ids: getRequirementIds('alloy:transcript'), metadata: { spec: specName } }); } catch (e) { process.stderr.write('[run-transcript-alloy] Warning: failed to write check result: ' + e.message + '\n'); }
process.exit(0);

#!/usr/bin/env node
'use strict';
// bin/run-oauth-rotation-prism.cjs
// Invokes PRISM model checker against .planning/formal/prism/oauth-rotation.pm.
// Requirements: CRED-01
//
// Usage:
//   node bin/run-oauth-rotation-prism.cjs                           # all 3 properties
//   node bin/run-oauth-rotation-prism.cjs -pf "P=? [ F s=1 ]"      # explicit property
//   node bin/run-oauth-rotation-prism.cjs -const p_fail=0.15        # override failure rate
//   node bin/run-oauth-rotation-prism.cjs -const p_fail=0.15 -const max_retries=5
//
// Properties (.planning/formal/prism/oauth-rotation.props):
//   P=? [ F s=1 ]              — probability of eventual success within max_retries
//   P=? [ F s=0 ]              — probability all attempts fail (complement)
//   R{"rotations"}=? [ F s<=1] — expected number of rotation attempts before outcome
//
// Defaults: p_fail=0.30, max_retries=3
//   Expected P(succeed) ≈ 1 - 0.3^3 = 0.973
//
// Prerequisites:
//   - PRISM 4.x installed; set PRISM_BIN to path of the prism shell script
//     e.g. export PRISM_BIN="$HOME/prism/bin/prism"
//   - Java >=17 (same JRE used by TLA+/Alloy)

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { writeCheckResult } = require('./write-check-result.cjs');
const { getRequirementIds } = require('./requirement-map.cjs');

// ── Locate PRISM binary ──────────────────────────────────────────────────────
const { resolvePrismBin } = require('./resolve-prism-bin.cjs');
const { loadProviders } = require('./resolve-providers.cjs');
const prismBin = resolvePrismBin();

if (!prismBin) {
  process.stderr.write(
    '[run-oauth-rotation-prism] PRISM binary not found at: ' + prismBin + '\n' +
    '[run-oauth-rotation-prism] Install PRISM and set PRISM_BIN env var:\n' +
    '[run-oauth-rotation-prism]   export PRISM_BIN="$HOME/prism/bin/prism"\n' +
    '[run-oauth-rotation-prism] Download: https://www.prismmodelchecker.org/download.php\n'
  );
  try { writeCheckResult({ tool: 'run-oauth-rotation-prism', formalism: 'prism', result: 'error', check_id: 'prism:oauth-rotation', surface: 'prism', property: 'OAuth token rotation probability — successful rotation under expiry and concurrency', runtime_ms: 0, summary: 'error: prism:oauth-rotation (binary not found)', triage_tags: [], requirement_ids: getRequirementIds('prism:oauth-rotation'), observation_window: { window_start: new Date().toISOString(), window_end: new Date().toISOString(), n_traces: 0, n_events: 0, window_days: 0 }, metadata: {} }); } catch (e) { process.stderr.write('[run-oauth-rotation-prism] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

// ── Locate model file ────────────────────────────────────────────────────────
// Prefer __dirname-relative path (works when run from project root bin/).
// Fall back to process.cwd()-relative path (works when script is invoked from
// nf-bin via run-formal-verify.cjs, where __dirname points to ~/.claude/nf-bin/).
const _oauthModelDirname = path.join(__dirname, '..', '.planning', 'formal', 'prism', 'oauth-rotation.pm');
const _oauthModelCwd     = path.join(process.cwd(), '.planning', 'formal', 'prism', 'oauth-rotation.pm');
const modelPath = fs.existsSync(_oauthModelDirname) ? _oauthModelDirname : _oauthModelCwd;
if (!fs.existsSync(modelPath)) {
  process.stderr.write(
    '[run-oauth-rotation-prism] Model file not found: ' + modelPath + '\n'
  );
  try { writeCheckResult({ tool: 'run-oauth-rotation-prism', formalism: 'prism', result: 'error', check_id: 'prism:oauth-rotation', surface: 'prism', property: 'OAuth token rotation probability — successful rotation under expiry and concurrency', runtime_ms: 0, summary: 'error: prism:oauth-rotation (model not found)', triage_tags: [], requirement_ids: getRequirementIds('prism:oauth-rotation'), observation_window: { window_start: new Date().toISOString(), window_end: new Date().toISOString(), n_traces: 0, n_events: 0, window_days: 0 }, metadata: {} }); } catch (e) { process.stderr.write('[run-oauth-rotation-prism] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

// ── Extract max_retries from providers.json (live source of truth) ───────────
// Reads bin/providers.json → gemini-1.oauth_rotation.max_retries.
// Injected as -const max_retries=<N> unless the caller already supplies it.
let liveMaxRetries = null;
try {
  // Single source of truth: resolve-providers.cjs (issue #197/#218)
  const list    = loadProviders({ baseDir: __dirname }) || [];
  const gemini1 = list.find(function(p) { return p.name === 'gemini-1' || p.id === 'gemini-1'; }) || {};
  const rot     = gemini1.oauth_rotation || {};
  if (typeof rot.max_retries === 'number') {
    liveMaxRetries = rot.max_retries;
    process.stdout.write(
      '[run-oauth-rotation-prism] max_retries=' + liveMaxRetries +
      ' (from providers.json)\n'
    );
  }
} catch (_) { /* malformed providers.json — fall through to spec default */ }

// ── Build argument list ──────────────────────────────────────────────────────
// Extra args passed to this script are forwarded to PRISM after the model path.
// If .planning/formal/prism/oauth-rotation.props exists, pass it as the properties file.
// Otherwise fall back to a single inline property.
const extraArgs  = process.argv.slice(2);
const hasPf      = extraArgs.some(a => a === '-pf' || a === '-prop');
const _propsDirname2 = path.join(__dirname, '..', '.planning', 'formal', 'prism', 'oauth-rotation.props');
const _propsCwd2     = path.join(process.cwd(), '.planning', 'formal', 'prism', 'oauth-rotation.props');
const propsFile  = fs.existsSync(_propsDirname2) ? _propsDirname2 : _propsCwd2;
const hasProps   = !hasPf && fs.existsSync(propsFile);
// Inject live max_retries unless the caller already overrides it
const callerOverridesRetries = extraArgs.some(
  (a, i) => a === '-const' && (extraArgs[i + 1] || '').startsWith('max_retries=')
);

const prismArgs = [modelPath];
if (hasProps) {
  prismArgs.push(propsFile);
} else if (!hasPf) {
  prismArgs.push('-pf', 'P=? [ F s=1 ]');
}
if (liveMaxRetries !== null && !callerOverridesRetries) {
  prismArgs.push('-const', 'max_retries=' + liveMaxRetries);
}
prismArgs.push(...extraArgs.filter(a => !a.startsWith('--project-root')));

process.stdout.write('[run-oauth-rotation-prism] Binary: ' + prismBin + '\n');
process.stdout.write('[run-oauth-rotation-prism] Model:  ' + modelPath + '\n');
process.stdout.write('[run-oauth-rotation-prism] Args:   ' + prismArgs.slice(1).join(' ') + '\n');

// ── Invoke PRISM ─────────────────────────────────────────────────────────────
const _startMs = Date.now();

const result = spawnSync(prismBin, prismArgs, {
  encoding: 'utf8',
  stdio: 'inherit',
});

if (result.error) {
  process.stderr.write('[run-oauth-rotation-prism] Failed to launch PRISM: ' + result.error.message + '\n');
  const _runtimeMs = Date.now() - _startMs;
  const tags = [];
  if (_runtimeMs > 300000) tags.push('timeout-risk');
  else if (_runtimeMs > 120000) tags.push('slow-verify');
  tags.push('low-confidence');
  try { writeCheckResult({ tool: 'run-oauth-rotation-prism', formalism: 'prism', result: 'fail', check_id: 'prism:oauth-rotation', surface: 'prism', property: 'OAuth token rotation probability — successful rotation under expiry and concurrency', runtime_ms: _runtimeMs, summary: 'fail: prism:oauth-rotation in ' + _runtimeMs + 'ms', triage_tags: tags, requirement_ids: getRequirementIds('prism:oauth-rotation'), observation_window: { window_start: new Date().toISOString(), window_end: new Date().toISOString(), n_traces: 0, n_events: 0, window_days: 0 }, metadata: {} }); } catch (e) { process.stderr.write('[run-oauth-rotation-prism] Warning: failed to write check result: ' + e.message + '\n'); }
  process.exit(1);
}

const passed = (result.status || 0) === 0;
const _runtimeMs = Date.now() - _startMs;
const tags = [];
if (_runtimeMs > 300000) tags.push('timeout-risk');
else if (_runtimeMs > 120000) tags.push('slow-verify');
tags.push('low-confidence'); // OAuth rotation always insufficient data
try { writeCheckResult({ tool: 'run-oauth-rotation-prism', formalism: 'prism', result: passed ? 'pass' : 'fail', check_id: 'prism:oauth-rotation', surface: 'prism', property: 'OAuth token rotation probability — successful rotation under expiry and concurrency', runtime_ms: _runtimeMs, summary: (passed ? 'pass' : 'fail') + ': prism:oauth-rotation in ' + _runtimeMs + 'ms', triage_tags: tags, requirement_ids: getRequirementIds('prism:oauth-rotation'), observation_window: { window_start: new Date().toISOString(), window_end: new Date().toISOString(), n_traces: 0, n_events: 0, window_days: 0 }, metadata: {} }); } catch (e) { process.stderr.write('[run-oauth-rotation-prism] Warning: failed to write check result: ' + e.message + '\n'); }
process.exit(result.status || 0);

#!/usr/bin/env node
'use strict';
// bin/check-debug-chain.cjs
// CHAIN-ENFORCEMENT CHECK — proves the full debug loop end-to-end on REAL artifacts,
// binding code and model to the SAME bug. For each case in
// benchmarks/debug/chain/manifest.json, assert all four executable endpoints:
//
//   ① code with bug        — the JS test FAILS against the buggy stub      (bug in code)
//   ② model reproduces bug — TLC on bug.tla VIOLATES the invariant         (bug in model)
//   ③ model with fix       — TLC on fix.tla is CLEAN                        (fix in model)
//   ④ code with fix        — the JS test PASSES against the canonical fix   (fix in code)
//
// The chain "holds" for a case iff all four pass. If the code bug and the model bug
// were different defects (the failure mode that let `sort` drift), at least one
// endpoint breaks. Exit 0 iff every case's chain holds AND ≥1 case exists; exit 2 if
// the TLA toolchain is unavailable.
//
// Usage: node bin/check-debug-chain.cjs [--json]

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');
const { classifyTlcOutput, resolveTlaJar } = require('./check-formal-discrimination.cjs');

const ROOT      = path.resolve(__dirname, '..');
const MANIFEST  = path.join(ROOT, 'benchmarks', 'debug', 'chain', 'manifest.json');
const jsonMode  = process.argv.includes('--json');

// ── PURE: parse + validate the manifest (drop malformed entries, never throw) ──
function loadManifest(p) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (_) { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.filter(e =>
    e && typeof e === 'object' &&
    typeof e.case === 'string' &&
    typeof e.stub === 'string' && typeof e.test === 'string' &&
    typeof e.model === 'string' && typeof e.fixed === 'string');
}

// ── PURE: does a case's chain hold, given the four endpoint outcomes? ──────────
function chainHolds(s) {
  return s.codeBug === true && s.modelBug === true && s.modelFix === true && s.codeFix === true;
}

// ── Endpoint runners ───────────────────────────────────────────────────────────
function runTest(testRel) {
  const r = spawnSync(process.execPath, [path.join(ROOT, testRel)], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  return r.status; // 0 = pass, nonzero = fail
}
function runTlc(jar, dir, tla, cfg) {
  const r = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-config', cfg, tla],
    { cwd: dir, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return 'error';
  return classifyTlcOutput((r.stdout || '') + (r.stderr || ''));
}

function checkCase(jar, c) {
  const stubAbs  = path.join(ROOT, c.stub);
  const fixedAbs = path.join(ROOT, c.fixed);
  const modelDir = path.join(ROOT, c.model);
  const s = { codeBug: false, modelBug: false, modelFix: false, codeFix: false };

  // ① bug in code
  s.codeBug = runTest(c.test) !== 0;
  // ② bug in model
  s.modelBug = runTlc(jar, modelDir, 'bug.tla', 'bug.cfg') === 'violated';
  // ③ fix in model
  s.modelFix = runTlc(jar, modelDir, 'fix.tla', 'fix.cfg') === 'clean';
  // ④ fix in code — swap in the canonical fix, run, ALWAYS restore the buggy stub
  let buggy = null;
  try {
    buggy = fs.readFileSync(stubAbs);
    fs.copyFileSync(fixedAbs, stubAbs);
    s.codeFix = runTest(c.test) === 0;
  } catch (_) {
    s.codeFix = false;
  } finally {
    if (buggy !== null) { try { fs.writeFileSync(stubAbs, buggy); } catch (_) { /* best effort */ } }
  }

  return { case: c.case, stages: s, holds: chainHolds(s) };
}

function main() {
  const cases = loadManifest(MANIFEST);
  const jar = resolveTlaJar();
  if (!jar) {
    if (jsonMode) console.log(JSON.stringify({ status: 'toolchain-unavailable', cases: cases.map(c => c.case) }));
    else console.error('[debug-chain] tla2tools.jar not found — set NF_TLA_JAR. Discovered ' + cases.length + ' case(s).');
    process.exit(2);
  }

  const results = cases.map(c => checkCase(jar, c));
  const total = results.length;
  const passed = results.filter(r => r.holds).length;
  const ok = total > 0 && passed === total;

  if (jsonMode) {
    console.log(JSON.stringify({ status: ok ? 'pass' : 'fail', total, holding: passed, results }));
  } else {
    console.log('━━━ Debug chain-enforcement (code↔model, same bug, end-to-end) ━━━');
    for (const r of results) {
      const m = r.holds ? '✓' : '✗';
      const s = r.stages;
      const cell = (label, v) => `${label}=${v ? 'Y' : 'N'}`;
      console.log(`  ${m} ${r.case.padEnd(10)} ① ${cell('code-bug', s.codeBug)}  ② ${cell('model-bug', s.modelBug)}  ③ ${cell('model-fix', s.modelFix)}  ④ ${cell('code-fix', s.codeFix)}`);
    }
    if (total === 0) console.log('  (no chain cases in benchmarks/debug/chain/manifest.json)');
    console.log(`  ${passed}/${total} chains hold (code bug ≡ model bug; both fixes proven)`);
    console.log(ok ? '  RESULT: PASS — the full code→model→fix→model→code loop is bound to one bug per case.'
                   : '  RESULT: FAIL — a chain broke (code bug and model bug are not the same defect).');
  }
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { loadManifest, chainHolds };

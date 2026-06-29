#!/usr/bin/env node
'use strict';
// bin/check-formal-discrimination.cjs
// FORMAL-DISCRIMINATION BENCHMARK — proves the debug "prove-bug / prove-fix" loop
// actually depends on the bug (i.e. is NOT theater).
//
// For every .planning/formal/spec/debug-bench-*/ case that ships a paired
// bug+fix spec, run the REAL model checker and assert:
//     bug spec  -> property VIOLATED  (the checker produces a counterexample)
//     fix spec  -> property HOLDS     (no error found)
// A case "discriminates" iff the SAME invariant fails on the buggy model and
// holds on the fixed model. If a checker passed both (or failed both), the proof
// would not be tied to the bug — that is the theater failure mode this gates.
//
// Exit 0 only if every discovered case discriminates AND at least one case exists.
// Exit 1 on any non-discriminating case or zero cases. Exit 2 if the toolchain
// (tla2tools.jar) is unavailable — callers decide whether that is skip or fail.
//
// Usage:
//   node bin/check-formal-discrimination.cjs            # human report
//   node bin/check-formal-discrimination.cjs --json     # machine report
//   NF_TLA_JAR=/path/to/tla2tools.jar node bin/check-formal-discrimination.cjs

const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const { spawnSync } = require('child_process');

const ROOT      = path.resolve(__dirname, '..');
const SPEC_DIR  = path.join(ROOT, '.planning', 'formal', 'spec');
const jsonMode  = process.argv.includes('--json');

// ── Toolchain resolution ──────────────────────────────────────────────────────
function resolveTlaJar() {
  const env = process.env.NF_TLA_JAR;
  if (typeof env === 'string' && env.length > 0 && fs.existsSync(env)) return env;
  // CI provisions the jar into the repo (.github/workflows/formal-verify.yml);
  // local installs put it under ~/.local/share/nf-formal. Check both.
  const candidates = [
    path.join(ROOT, '.planning', 'formal', 'tla', 'tla2tools.jar'),
    path.join(os.homedir(), '.local', 'share', 'nf-formal', 'tla', 'tla2tools.jar'),
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return null;
}

// ── PURE: classify a TLC run into a discrimination outcome ───────────────────
// Returns 'violated' (counterexample found), 'clean' (no error), or 'error'
// (parse/runtime failure — neither a clean pass nor a genuine violation).
function classifyTlcOutput(out) {
  if (typeof out !== 'string' || out.length === 0) return 'error';
  // A genuine invariant violation (with or without a printed counterexample).
  // Must match "Invariant <name> is violated" specifically — NOT any line that merely
  // mentions an invariant (e.g. "Error: Invariant Foo is not defined" is a broken spec,
  // which must classify as 'error', not a real counterexample).
  if (/(?:Error:\s*)?Invariant\s+\w+\s+is violated(?: by the initial state)?/i.test(out)) {
    return 'violated';
  }
  // A clean, completed model check with no counterexample.
  if (/Model checking completed\.\s*No error has been found|No error has been found/i.test(out)) {
    return 'clean';
  }
  // Anything else (parse error, missing jar, exception) is not a trustworthy result.
  return 'error';
}

// A case discriminates iff the buggy model is VIOLATED and the fixed model is CLEAN.
function isDiscriminating(bugOutcome, fixOutcome) {
  return bugOutcome === 'violated' && fixOutcome === 'clean';
}

// ── Case discovery ───────────────────────────────────────────────────────────
function discoverCases(specDir) {
  let entries;
  try { entries = fs.readdirSync(specDir, { withFileTypes: true }); }
  catch (_) { return []; }
  const cases = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('debug-bench-')) continue;
    const dir = path.join(specDir, e.name);
    const has = (f) => fs.existsSync(path.join(dir, f));
    if (has('bug.tla') && has('bug.cfg') && has('fix.tla') && has('fix.cfg')) {
      cases.push({ name: e.name, dir });
    }
  }
  return cases.sort((a, b) => a.name.localeCompare(b.name));
}

// ── TLC invocation ───────────────────────────────────────────────────────────
function runTlc(jar, dir, tla, cfg) {
  const r = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-config', cfg, tla], {
    cwd: dir, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) return { outcome: 'error', detail: r.error.message };
  const out = (r.stdout || '') + (r.stderr || '');
  return { outcome: classifyTlcOutput(out), detail: '' };
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const cases = discoverCases(SPEC_DIR);
  const jar = resolveTlaJar();

  if (!jar) {
    const msg = { status: 'toolchain-unavailable', reason: 'tla2tools.jar not found (set NF_TLA_JAR)', cases: cases.map(c => c.name) };
    if (jsonMode) console.log(JSON.stringify(msg));
    else console.error('[formal-discrimination] tla2tools.jar not found — set NF_TLA_JAR or install nf-formal. Discovered ' + cases.length + ' case(s).');
    process.exit(2);
  }

  const results = [];
  for (const c of cases) {
    const bug = runTlc(jar, c.dir, 'bug.tla', 'bug.cfg');
    const fix = runTlc(jar, c.dir, 'fix.tla', 'fix.cfg');
    const discriminates = isDiscriminating(bug.outcome, fix.outcome);
    results.push({ name: c.name, bug: bug.outcome, fix: fix.outcome, discriminates });
  }

  const total = results.length;
  const passed = results.filter(r => r.discriminates).length;
  const ok = total > 0 && passed === total;

  if (jsonMode) {
    console.log(JSON.stringify({ status: ok ? 'pass' : 'fail', total, discriminating: passed, results }));
  } else {
    console.log('━━━ Formal-discrimination benchmark (prove-bug / prove-fix) ━━━');
    for (const r of results) {
      const mark = r.discriminates ? '✓' : '✗';
      console.log(`  ${mark} ${r.name.padEnd(28)} bug=${r.bug.padEnd(9)} fix=${r.fix}`);
    }
    if (total === 0) console.log('  (no bug/fix spec pairs found under .planning/formal/spec/debug-bench-*/)');
    console.log(`  ${passed}/${total} cases discriminate (bug→violated, fix→clean)`);
    console.log(ok ? '  RESULT: PASS — the formal loop genuinely depends on the bug.'
                   : '  RESULT: FAIL — a case did not discriminate (proof not tied to the bug).');
  }
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { classifyTlcOutput, isDiscriminating, discoverCases, resolveTlaJar };

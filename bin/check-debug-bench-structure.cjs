#!/usr/bin/env node
'use strict';
// bin/check-debug-bench-structure.cjs
// Structural integrity check for the debug benchmark — no LLM, no API key.
//
// Validates:
//   1. Every test in benchmarks/debug/tests/ exits code 1 on its paired stub
//      (bug is still present — not accidentally fixed)
//   2. Every test passes node --check (syntactically valid)
//   3. No hint comments remain in any stub (// BUG, // Fix:, should be)
//   4. Every test assert helper uses the counter form (_i++) so no label
//      information leaks through FAIL output
//
// Usage:
//   node bin/check-debug-bench-structure.cjs
//   node bin/check-debug-bench-structure.cjs --json

const fs           = require('fs');
const path         = require('path');
const { spawnSync } = require('child_process');

const ROOT      = path.resolve(__dirname, '..');
const STUBS_DIR = path.join(ROOT, 'bin');
const TESTS_DIR = path.join(ROOT, 'benchmarks', 'debug', 'tests');
const jsonMode  = process.argv.includes('--json');

const failures = [];
let   checks   = 0;

function fail(msg) { failures.push(msg); }

// ── 1. Collect stub→test pairs ─────────────────────────────────────────────

const stubs = fs.readdirSync(STUBS_DIR)
  .filter(function(f) { return /^bench-buggy-.+\.cjs$/.test(f); })
  .sort();

const tests = fs.readdirSync(TESTS_DIR)
  .filter(function(f) { return f.endsWith('.test.cjs'); })
  .sort();

// ── 2. Syntax-check every test file ───────────────────────────────────────

tests.forEach(function(f) {
  checks++;
  var fp     = path.join(TESTS_DIR, f);
  var result = spawnSync(process.execPath, ['--check', fp], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail('SYNTAX ERROR in test ' + f + ': ' + (result.stderr || '').slice(0, 200));
  }
});

// ── 2b. Syntax-check every stub ───────────────────────────────────────────
// A buggy stub must be a genuine LOGIC bug, not a SyntaxError. Without this,
// a stub that fails to parse still makes its test exit 1 (require throws) and
// would be mistaken for "bug present" — exactly how bench-buggy-sort drifted
// into an uncatchable, model-incoherent state.

stubs.forEach(function(f) {
  checks++;
  var fp     = path.join(STUBS_DIR, f);
  var result = spawnSync(process.execPath, ['--check', fp], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail('SYNTAX ERROR in stub ' + f + ': ' + (result.stderr || '').slice(0, 160) +
         ' — a buggy stub must be a real logic bug, not a parse error');
  }
});

// ── 3. Verify each test exits code 1 on its stub (bug is real) ────────────

tests.forEach(function(f) {
  checks++;
  var fp     = path.join(TESTS_DIR, f);
  var result = spawnSync(process.execPath, [fp], { encoding: 'utf8', cwd: ROOT });
  if (result.status === 0) {
    fail('BUG MISSING: test ' + f + ' exits 0 — stub was accidentally fixed or test is wrong');
  }
  if (result.error) {
    fail('RUN ERROR in test ' + f + ': ' + result.error.message);
  }
});

// ── 4. Verify no hint comments remain in stubs ────────────────────────────

var HINT_RE = /\/\/\s*(BUG|Fix:|should be|hint)/i;
stubs.forEach(function(f) {
  checks++;
  var src = fs.readFileSync(path.join(STUBS_DIR, f), 'utf8');
  if (HINT_RE.test(src)) {
    fail('HINT COMMENT found in stub ' + f + ' — run node bin/strip-bench-hints.cjs to remove');
  }
});

// ── 5. Verify assert helpers use counter form in tests ────────────────────

tests.forEach(function(f) {
  checks++;
  var src = fs.readFileSync(path.join(TESTS_DIR, f), 'utf8');
  // Must have the counter variable declaration
  if (!src.includes('var _i = 0;')) {
    fail('COUNTER MISSING in test ' + f + ' — assert helper must use _i counter (run obfuscate-bench.cjs)');
  }
  // Must NOT print the label directly
  if (src.includes("'FAIL ' + label")) {
    fail('LABEL LEAK in test ' + f + ' — assert helper still uses label arg; run obfuscate-bench.cjs');
  }
});

// ── Report ─────────────────────────────────────────────────────────────────

const passed = checks - failures.length;
const ok     = failures.length === 0;

if (jsonMode) {
  process.stdout.write(JSON.stringify({
    ok,
    checks,
    passed,
    failed: failures.length,
    failures
  }, null, 2) + '\n');
} else {
  process.stdout.write('Debug benchmark structure check\n');
  process.stdout.write('Stubs checked : ' + stubs.length + '\n');
  process.stdout.write('Tests checked : ' + tests.length + '\n');
  process.stdout.write('Total checks  : ' + checks + '\n');
  if (ok) {
    process.stdout.write('\nPASS — all ' + checks + ' structural checks passed.\n');
  } else {
    process.stdout.write('\nFAIL — ' + failures.length + ' issue(s) found:\n');
    failures.forEach(function(m) { process.stdout.write('  • ' + m + '\n'); });
  }
}

process.exit(ok ? 0 : 1);

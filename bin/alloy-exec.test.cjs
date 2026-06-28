#!/usr/bin/env node
'use strict';
// bin/alloy-exec.test.cjs
// Unit tests for the PURE parser parseAlloyOutcome() in bin/alloy-exec.cjs.
// Requirements: SPEC-03 (issue #199 — Alloy counterexample detection)
//
// These tests are jar-independent: they feed CAPTURED Alloy 6.2.0 receipt.json
// fixture strings to the parser. The fixtures below were captured live from
// `java -jar org.alloytools.alloy.dist.jar exec --type text --quiet --force`
// against models whose checks are known to pass / fail. This is the regression
// gate that proves a violated `check` is reported as `fail` rather than `pass`
// (the original bug: the dead `/Counterexample/i` regex recorded violations as
// pass because Alloy 6 never prints that word).

const { test } = require('node:test');
const assert   = require('node:assert');
const { parseAlloyOutcome, hasInstance, runAlloy } = require('./alloy-exec.cjs');

// ── Captured fixture: a REAL Alloy-6 counterexample. ──────────────────────────
// Source model: `run Sat {} for 3` (satisfiable) + a FALSE assertion
//   `assert Bad { all a : A | a not in A }` / `check Bad for 3`.
// The check yields an instance (the counterexample) carrying `skolems.$Bad_a`.
// MUST parse as fail.
const FIXTURE_FAIL = '{"commands":{"Sat":{"bitwidth":4,"name":"Sat","overall":3,"solution":[{"duration":36,"incremental":true,"instances":[{"values":{"0":{},"1":{},"2":{}}}]}],"source":"run Sat {} for 3","type":"run"},"Bad":{"bitwidth":4,"name":"Bad","overall":3,"solution":[{"duration":5,"incremental":true,"instances":[{"skolems":{"$Bad_a":{"arity":1,"data":[["A$0"]]}},"values":{"0":{},"1":{},"2":{},"A$2":{}}}]}],"source":"check Bad for 3","type":"check"}},"solver":"sat4j"}';

// ── Captured fixture: an all-pass run. ────────────────────────────────────────
// Source model: `run Sat {} for 3` (satisfiable, instance found) + a TRUE
//   assertion `assert Trivial { all a : A | a = a }` / `check Trivial for 3`.
// A passing check has NO `solution` key at all (Alloy found no counterexample).
// MUST parse as pass.
const FIXTURE_PASS = '{"commands":{"Sat":{"bitwidth":4,"name":"Sat","overall":3,"solution":[{"duration":69,"incremental":true,"instances":[{"values":{"0":{},"1":{},"2":{}}}]}],"source":"run Sat {} for 3","type":"run"},"Trivial":{"bitwidth":4,"name":"Trivial","overall":3,"source":"check Trivial for 3","type":"check"}},"solver":"sat4j"}';

// ── Captured fixture: a vacuous (unsatisfiable) run. ──────────────────────────
// Source model: `fact { #A > 0 and #A < 0 }` makes `run Sat {} for 3` unsat —
// no `solution` key. The vacuity guard MUST flag this as fail.
const FIXTURE_VACUOUS = '{"commands":{"Sat":{"bitwidth":4,"name":"Sat","overall":3,"source":"run Sat {} for 3","type":"run"}},"solver":"sat4j"}';

test('parseAlloyOutcome: a real Alloy-6 counterexample (check yields instance) => fail', () => {
  const r = parseAlloyOutcome(FIXTURE_FAIL);
  assert.strictEqual(r.ok, false, 'overall must be fail');
  assert.strictEqual(r.parseError, null);

  const bad = r.commands.find(c => c.name === 'Bad');
  assert.ok(bad, 'Bad check must appear in parsed commands');
  assert.strictEqual(bad.type, 'check');
  assert.strictEqual(bad.instancesFound, true, 'counterexample instance must be detected');
  assert.strictEqual(bad.outcome, 'fail');

  // The satisfiability run is still healthy.
  const sat = r.commands.find(c => c.name === 'Sat');
  assert.strictEqual(sat.outcome, 'pass');

  assert.ok(r.failures.some(f => f.name === 'Bad'), 'failures must list the violated assertion');
  assert.match(r.summary, /fail/);
});

test('parseAlloyOutcome: an all-pass output (no counterexample) => pass', () => {
  const r = parseAlloyOutcome(FIXTURE_PASS);
  assert.strictEqual(r.ok, true, 'overall must be pass');
  assert.strictEqual(r.parseError, null);
  assert.deepStrictEqual(r.failures, []);

  const trivial = r.commands.find(c => c.name === 'Trivial');
  assert.strictEqual(trivial.type, 'check');
  assert.strictEqual(trivial.instancesFound, false, 'a passing check has no instance');
  assert.strictEqual(trivial.outcome, 'pass');

  const sat = r.commands.find(c => c.name === 'Sat');
  assert.strictEqual(sat.outcome, 'pass', 'satisfiable run passes');
  assert.match(r.summary, /pass/);
});

test('parseAlloyOutcome: vacuity guard flags an unsatisfiable run{} as fail', () => {
  const r = parseAlloyOutcome(FIXTURE_VACUOUS);
  assert.strictEqual(r.ok, false, 'a vacuous run must fail the vacuity guard');
  const sat = r.commands.find(c => c.name === 'Sat');
  assert.strictEqual(sat.type, 'run');
  assert.strictEqual(sat.instancesFound, false);
  assert.strictEqual(sat.outcome, 'fail');
  assert.match(sat.reason, /vacu|unsat/i);
});

test('parseAlloyOutcome: accepts an already-parsed receipt object', () => {
  const r = parseAlloyOutcome(JSON.parse(FIXTURE_FAIL));
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures.some(f => f.name === 'Bad'));
});

test('parseAlloyOutcome: invalid JSON => parseError, fail (no throw)', () => {
  const r = parseAlloyOutcome('{not valid json');
  assert.strictEqual(r.ok, false);
  assert.ok(r.parseError, 'parseError must be populated');
  assert.match(r.summary, /receipt/i);
});

test('parseAlloyOutcome: receipt with no commands => fail', () => {
  const r = parseAlloyOutcome('{"solver":"sat4j"}');
  assert.strictEqual(r.ok, false);
  assert.match(r.summary, /no commands/i);
});

test('hasInstance: true only when a solution carries a non-empty instances array', () => {
  assert.strictEqual(hasInstance({ solution: [{ instances: [{ values: {} }] }] }), true);
  assert.strictEqual(hasInstance({ solution: [{ instances: [] }] }), false);
  assert.strictEqual(hasInstance({ solution: [] }), false);
  assert.strictEqual(hasInstance({}), false);
  assert.strictEqual(hasInstance(null), false);
});

test('hasInstance: a null (or non-object) entry inside the solution array must not throw', () => {
  assert.strictEqual(hasInstance({ solution: [null] }), false);
  assert.strictEqual(hasInstance({ solution: [null, { instances: [{ values: {} }] }] }), true);
});

test('parseAlloyOutcome: a corrupt receipt with a null solution entry fails gracefully (no throw)', () => {
  const r = parseAlloyOutcome('{"commands":{"Bad":{"type":"check","solution":[null]}}}');
  const bad = r.commands.find(c => c.name === 'Bad');
  assert.ok(bad, 'Bad must still be parsed');
  assert.strictEqual(bad.instancesFound, false, 'a null solution entry carries no instance');
  assert.strictEqual(bad.outcome, 'pass', 'check with no instance holds');
});

test('runAlloy: undefined/null opts returns a structured error, never throws (fail-open)', () => {
  let r;
  assert.doesNotThrow(() => { r = runAlloy(); });
  assert.strictEqual(r.status, 'error');
  assert.strictEqual(r.outcome, null);
  assert.match(r.error, /jar|als|opts/i);

  let r2;
  assert.doesNotThrow(() => { r2 = runAlloy(null); });
  assert.strictEqual(r2.status, 'error');
});

test('runAlloy: missing/non-string jarPath or alsPath returns error before spawning java', () => {
  const r = runAlloy({ jarPath: '/some/alloy.jar' }); // alsPath missing
  assert.strictEqual(r.status, 'error');
  const r2 = runAlloy({ jarPath: 123, alsPath: '/x.als' }); // non-string jarPath
  assert.strictEqual(r2.status, 'error');
});

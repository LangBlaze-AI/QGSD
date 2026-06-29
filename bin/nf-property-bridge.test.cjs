'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findCounterexample, shrinkArgs, genIntArray, mulberry32, isAscending, sameMultiset } = require('./nf-property-bridge.cjs');

const ascendingProp = (args, out) => Array.isArray(out) && isAscending(out) && sameMultiset(args[0], out);
const produce = (rng) => [genIntArray(rng, 6, 5)];

test('findCounterexample: finds a counterexample for a buggy (descending) sort', () => {
  const buggy = (arr) => [...arr].sort((a, b) => b - a); // wrong direction
  const ce = findCounterexample((args) => buggy(args[0]), produce, ascendingProp, { seed: 1 });
  assert.ok(ce, 'should find a counterexample');
  assert.ok(Array.isArray(ce.args[0]));
  // shrunk to the minimal failing length (2 distinct elements)
  assert.equal(ce.args[0].length, 2, 'minimal counterexample is a 2-element array');
  assert.ok(ce.args[0][0] !== ce.args[0][1], 'the two elements differ (needed to expose order)');
});

test('findCounterexample: holds (null) for a correct ascending sort', () => {
  const correct = (arr) => [...arr].sort((a, b) => a - b);
  const ce = findCounterexample((args) => correct(args[0]), produce, ascendingProp, { seed: 1, runs: 500 });
  assert.equal(ce, null, 'a correct implementation yields no counterexample');
});

test('findCounterexample: a throwing implementation is treated as a failure', () => {
  const throwy = () => { throw new Error('boom'); };
  const ce = findCounterexample((args) => throwy(args[0]), produce, ascendingProp, { seed: 2 });
  assert.ok(ce, 'a thrown error counts as a property failure');
});

test('shrinkArgs: minimizes a large failing input', () => {
  const buggy = (arr) => [...arr].sort((a, b) => b - a);
  const big = [[5, 4, 3, 2, 1, 0]];
  const min = shrinkArgs(big, (args) => buggy(args[0]), ascendingProp);
  assert.equal(min[0].length, 2, 'shrinks a 6-element failure down to 2 elements');
});

test('mulberry32: deterministic for a given seed', () => {
  const a = mulberry32(42), b = mulberry32(42);
  assert.equal(a(), b());
  assert.equal(a(), b());
});

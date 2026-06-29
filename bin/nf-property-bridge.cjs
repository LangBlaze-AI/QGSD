#!/usr/bin/env node
'use strict';
// bin/nf-property-bridge.cjs
// PROPERTY-BASED BRIDGE — the "reproduced (property)" tier of the debug loop.
//
// Where the formal (TLA) route needs a hand-authored model, this route runs an
// EXECUTABLE property (the spec) directly against the REAL code:
//   - against buggy code  -> finds a MINIMAL counterexample (proves the bug on the
//                            actual JS, not an abstraction)  ── arrow: code → model
//   - against fixed code  -> no counterexample in N trials (confirms the fix)
//                                                            ── arrow: model → code
//
// Dependency-free: a small seeded PRNG + generators + greedy shrinker (no fast-check),
// so it adds no npm dependency and needs no lockfile churn.
//
// Usage:
//   node bin/nf-property-bridge.cjs --case sort            # run vs the buggy stub
//   node bin/nf-property-bridge.cjs --case sort --fixed    # run vs the canonical fix
//   node bin/nf-property-bridge.cjs --case sort --json

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── Seeded PRNG (deterministic, reproducible counterexamples) ─────────────────
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Generators ────────────────────────────────────────────────────────────────
function genInt(rng, maxVal) { return Math.floor(rng() * (maxVal + 1)); }
function genIntArray(rng, maxLen, maxVal) {
  const n = Math.floor(rng() * (maxLen + 1));
  const a = [];
  for (let i = 0; i < n; i++) a.push(genInt(rng, maxVal));
  return a;
}

// ── Greedy shrinker for the array arg (args[0]); scalar args are held fixed ────
// Returns the smallest args (shorter array, smaller values) that still FAILS prop.
function shrinkArgs(args, runFn, prop) {
  let best = args;
  let improved = true;
  const fails = (cand) => {
    let out;
    try { out = runFn(cand); } catch (_) { return true; } // a throw is also a failure
    return !prop(cand, out);
  };
  while (improved) {
    improved = false;
    const arr = best[0];
    const rest = best.slice(1);
    // 1. try removing each element
    for (let i = 0; i < arr.length; i++) {
      const cand = [arr.slice(0, i).concat(arr.slice(i + 1)), ...rest];
      if (fails(cand)) { best = cand; improved = true; break; }
    }
    if (improved) continue;
    // 2. try shrinking each element toward 0
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] === 0) continue;
      const smaller = arr[i] > 0 ? Math.floor(arr[i] / 2) : 0;
      if (smaller === arr[i]) continue;
      const next = arr.slice(); next[i] = smaller;
      const cand = [next, ...rest];
      if (fails(cand)) { best = cand; improved = true; break; }
    }
  }
  return best;
}

// ── Core: find a minimal counterexample, or null if the property holds ─────────
function findCounterexample(runFn, produceArgs, prop, opts) {
  const o = opts || {};
  const runs = typeof o.runs === 'number' ? o.runs : 300;
  const rng = mulberry32(typeof o.seed === 'number' ? o.seed : 0x5eed);
  for (let k = 0; k < runs; k++) {
    const args = produceArgs(rng);
    let out, threw = false;
    try { out = runFn(args); } catch (_) { threw = true; }
    if (threw || !prop(args, out)) {
      return { args: shrinkArgs(args, runFn, prop) };
    }
  }
  return null;
}

// ── Executable properties (the spec lives in code, not a hand-authored model) ──
function isAscending(a) { for (let i = 1; i < a.length; i++) if (a[i - 1] > a[i]) return false; return true; }
function sameMultiset(a, b) {
  if (!Array.isArray(b) || a.length !== b.length) return false;
  return [...a].sort((x, y) => x - y).join(',') === [...b].sort((x, y) => x - y).join(',');
}
function deepEqArr(a, b) { return Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]); }

const CASES = {
  sort: {
    stub: 'bin/bench-buggy-sort.cjs',
    fixed: 'benchmarks/debug/chain/fixed/sort.cjs',
    produceArgs: (rng) => [genIntArray(rng, 6, 5)],
    prop: (args, out) => Array.isArray(out) && isAscending(out) && sameMultiset(args[0], out),
    spec: 'f(arr) returns arr sorted ascending (a permutation of arr)',
  },
  filter: {
    stub: 'bin/bench-buggy-filter.cjs',
    fixed: 'benchmarks/debug/chain/fixed/filter.cjs',
    produceArgs: (rng) => [genIntArray(rng, 6, 5), genInt(rng, 5)],
    prop: (args, out) => deepEqArr(args[0].filter(x => x >= args[1]), out),
    spec: 'f(arr, b) returns elements >= b (inclusive threshold)',
  },
  counter: {
    stub: 'bin/bench-buggy-counter.cjs',
    fixed: 'benchmarks/debug/chain/fixed/counter.cjs',
    produceArgs: (rng) => { const b = genInt(rng, 4); return [genIntArray(rng, 6, 6), b, b + genInt(rng, 3)]; },
    prop: (args, out) => out === args[0].filter(x => x >= args[1] && x <= args[2]).length,
    spec: 'f(arr, b, c) counts elements in [b, c] inclusive',
  },
};

// ── Runner ─────────────────────────────────────────────────────────────────────
function loadFn(rel) {
  const abs = path.join(ROOT, rel);
  delete require.cache[require.resolve(abs)];
  const mod = require(abs);
  return mod.f;
}

function runCase(name, useFixed, opts) {
  const c = CASES[name];
  if (!c) return { status: 'unknown-case', case: name };
  const fn = loadFn(useFixed ? c.fixed : c.stub);
  const ce = findCounterexample((args) => fn(...args), c.produceArgs, c.prop, opts);
  if (ce) return { status: 'bug', case: name, target: useFixed ? 'fixed' : 'buggy', counterexample: ce.args, spec: c.spec };
  return { status: 'holds', case: name, target: useFixed ? 'fixed' : 'buggy', spec: c.spec };
}

function main() {
  const argv = process.argv.slice(2);
  const jsonMode = argv.includes('--json');
  const useFixed = argv.includes('--fixed');
  const ci = argv.indexOf('--case');
  const name = ci >= 0 ? argv[ci + 1] : null;
  const names = name ? [name] : Object.keys(CASES);

  const results = names.map(n => runCase(n, useFixed, {}));
  if (jsonMode) { console.log(JSON.stringify({ results })); process.exit(0); }

  console.log('━━━ Property-based bridge (' + (useFixed ? 'fixed code' : 'buggy code') + ') ━━━');
  for (const r of results) {
    if (r.status === 'bug') {
      console.log(`  ✗ ${r.case.padEnd(8)} BUG — minimal counterexample: f(${JSON.stringify(r.counterexample).slice(1, -1)})`);
      console.log(`      spec: ${r.spec}`);
    } else if (r.status === 'holds') {
      console.log(`  ✓ ${r.case.padEnd(8)} property holds (no counterexample) — ${r.spec}`);
    } else {
      console.log(`  ? ${r.case}: ${r.status}`);
    }
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { mulberry32, genIntArray, shrinkArgs, findCounterexample, runCase, CASES, isAscending, sameMultiset };

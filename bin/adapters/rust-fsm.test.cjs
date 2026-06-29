#!/usr/bin/env node
'use strict';
// bin/adapters/rust-fsm.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { id, detect, extract } = require('./rust-fsm.cjs');

const fixture = `
use rust_fsm::*;

state_machine! {
    derive(Debug, Clone)
    CircuitBreaker(Closed)
    Trip {
        Closed => Open
    }
    Reset {
        Open => HalfOpen
    }
    Test [CheckHealth] {
        HalfOpen => Closed,
        HalfOpen => Open
    }
}
`;

test('adapter id is rust-fsm', () => {
  assert.strictEqual(id, 'rust-fsm');
});

test('detect returns high confidence for rust-fsm code', () => {
  assert.ok(detect('circuit.rs', fixture) >= 90);
});

test('detect returns 0 for unrelated Rust code', () => {
  assert.strictEqual(detect('main.rs', 'fn main() { println!("hello"); }'), 0);
});

test('extract parses rust-fsm fixture with correct counts', () => {
  const tmpFile = path.join(os.tmpdir(), 'rust-fsm-test-' + Date.now() + '.rs');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.framework, 'rust-fsm');
    assert.strictEqual(ir.initial, 'Closed');
    assert.strictEqual(ir.stateNames.length, 3); // Closed, Open, HalfOpen
    assert.strictEqual(ir.transitions.length, 4); // Trip, Reset, Test x2
    // Verify guard was captured
    const guarded = ir.transitions.filter(t => t.guard === 'CheckHealth');
    assert.strictEqual(guarded.length, 2, 'should have 2 guarded transitions');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract ignores a single-element derive when finding machine name/initial', () => {
  const single = `
use rust_fsm::*;

state_machine! {
    derive(Clone)
    CircuitBreaker(Closed)
    Trip {
        Closed => Open
    }
}
`;
  const tmpFile = path.join(os.tmpdir(), 'rust-fsm-derive-' + Date.now() + '.rs');
  fs.writeFileSync(tmpFile, single, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.initial, 'Closed', 'initial must be the machine initial state, not a derive trait');
    assert.ok(!ir.stateNames.includes('Clone'), 'derive trait name must not leak into stateNames');
    assert.deepStrictEqual([...ir.stateNames].sort(), ['Closed', 'Open']);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract throws a clear error for a directory path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-fsm-dir-'));
  try {
    assert.throws(() => extract(dir), /Not a file/);
  } finally {
    fs.rmdirSync(dir);
  }
});

#!/usr/bin/env node
'use strict';
// bin/adapters/swift-state.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { id, detect, extract } = require('./swift-state.cjs');

const fixture = `
import SwiftState

enum MyState: StateType {
    case idle
    case loading
    case success
    case error
}

let machine = StateMachine<MyState, NoEvent>(state: .idle)

machine.addRoute(.idle => .loading)
machine.addRoute(.loading => .success)
machine.addRoute(.loading => .error)
machine.addRoute(.error => .idle)
`;

test('adapter id is swift-state', () => {
  assert.strictEqual(id, 'swift-state');
});

test('detect returns high confidence for SwiftState code', () => {
  assert.ok(detect('ViewModel.swift', fixture) >= 90);
});

test('detect returns 0 for unrelated Swift code', () => {
  assert.strictEqual(detect('app.swift', 'import UIKit\nclass ViewController: UIViewController {}'), 0);
});

test('extract parses SwiftState fixture', () => {
  const tmpFile = path.join(os.tmpdir(), 'swift-state-test-' + Date.now() + '.swift');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.framework, 'swift-state');
    assert.strictEqual(ir.initial, 'idle');
    assert.strictEqual(ir.stateNames.length, 4);
    assert.strictEqual(ir.transitions.length, 4);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract parses type-prefixed initial state (state: MyState.idle)', () => {
  const src = `
import SwiftState
enum MyState: StateType { case idle; case running; case done }
let machine = StateMachine<MyState, NoEvent>(state: MyState.idle)
machine.addRoute(.idle => .running)
machine.addRoute(.running => .done)
`;
  const tmpFile = path.join(os.tmpdir(), 'swift-state-typed-' + Date.now() + '.swift');
  fs.writeFileSync(tmpFile, src, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.initial, 'idle');
    assert.ok(ir.stateNames.includes('idle'));
    assert.strictEqual(ir.transitions.length, 2);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract throws a clear error for non-string filePath', () => {
  assert.throws(() => extract(null), /filePath must be a non-empty string/);
  assert.throws(() => extract(undefined), /filePath must be a non-empty string/);
  assert.throws(() => extract(42), /filePath must be a non-empty string/);
});

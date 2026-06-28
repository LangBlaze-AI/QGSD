#!/usr/bin/env node
'use strict';
// bin/adapters/qmuntal-stateless.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { id, detect, extract } = require('./qmuntal-stateless.cjs');

const fixture = `
package main
import "github.com/qmuntal/stateless"
const (
    stateIdle    = "idle"
    stateRunning = "running"
    stateDone    = "done"
    triggerStart = "start"
    triggerStop  = "stop"
    triggerDone  = "done"
)
func main() {
    sm := stateless.NewStateMachine(stateIdle)
    sm.Configure(stateIdle).Permit(triggerStart, stateRunning)
    sm.Configure(stateRunning).Permit(triggerStop, stateIdle).Permit(triggerDone, stateDone)
}
`;

test('adapter id is stateless', () => {
  assert.strictEqual(id, 'stateless');
});

test('detect returns high confidence for qmuntal/stateless Go code', () => {
  assert.ok(detect('main.go', fixture) >= 85);
});

test('detect returns 0 for Python code', () => {
  assert.strictEqual(detect('app.py', 'import sys'), 0);
});

test('extract parses qmuntal/stateless fixture', () => {
  const tmpFile = path.join(os.tmpdir(), 'stateless-test-' + Date.now() + '.go');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.framework, 'stateless');
    assert.strictEqual(ir.initial, 'idle');
    assert.strictEqual(ir.stateNames.length, 3);
    assert.strictEqual(ir.transitions.length, 3);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract treats prototype-named identifiers (constructor/toString) as literal state names', () => {
  const fixture = `
package main
import "github.com/qmuntal/stateless"
const (
    triggerNext = "next"
)
func main() {
    sm := stateless.NewStateMachine(constructor)
    sm.Configure(constructor).Permit(triggerNext, toString)
}
`;
  const tmpFile = path.join(os.tmpdir(), 'stateless-proto-' + Date.now() + '.go');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    let ir;
    assert.doesNotThrow(() => { ir = extract(tmpFile); });
    assert.strictEqual(ir.initial, 'constructor');
    assert.ok(ir.stateNames.includes('constructor'));
    assert.ok(ir.stateNames.includes('toString'));
    assert.strictEqual(ir.transitions.length, 1);
    assert.strictEqual(ir.transitions[0].fromState, 'constructor');
    assert.strictEqual(ir.transitions[0].event, 'next');
    assert.strictEqual(ir.transitions[0].target, 'toString');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

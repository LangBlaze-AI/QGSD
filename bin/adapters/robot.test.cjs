#!/usr/bin/env node
'use strict';
// bin/adapters/robot.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { id, detect, extract } = require('./robot.cjs');

test('adapter id is robot', () => {
  assert.strictEqual(id, 'robot');
});

test('detect returns high confidence for Robot content', () => {
  const content = `
import { createMachine, state, transition } from 'robot3';
const machine = createMachine({ idle: state(transition('start', 'running')) });`;
  assert.ok(detect('machine.js', content) >= 80);
});

test('detect returns 0 for unrelated content', () => {
  assert.strictEqual(detect('app.py', 'import sys'), 0);
});

test('extract parses Robot fixture', () => {
  const fixture = `
import { createMachine, state, transition } from 'robot3';
const machine = createMachine({
  idle: state(transition('start', 'running')),
  running: state(transition('stop', 'idle'), transition('finish', 'done')),
  done: state()
});`;
  const tmpFile = path.join(os.tmpdir(), 'robot-test-' + Date.now() + '.js');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.framework, 'robot');
    assert.strictEqual(ir.initial, 'idle');
    assert.strictEqual(ir.stateNames.length, 3);
    assert.strictEqual(ir.transitions.length, 3);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract rejects a directory path with a clear error (not raw EISDIR)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-dir-'));
  try {
    assert.throws(() => extract(dir), (err) => {
      assert.ok(!/EISDIR/.test(err.message), 'should not surface raw EISDIR');
      return /not found|not a (regular )?file/i.test(err.message);
    });
  } finally {
    fs.rmdirSync(dir);
  }
});

test('extract rejects non-string filePath with a clear error', () => {
  assert.throws(() => extract(null), /filePath must be a (non-empty )?string/i);
  assert.throws(() => extract(undefined), /filePath must be a (non-empty )?string/i);
  assert.throws(() => extract(42), /filePath must be a (non-empty )?string/i);
});

test('extract captures transitions with hyphenated event names', () => {
  const fixture = `
import { createMachine, state, transition } from 'robot3';
const machine = createMachine({
  idle: state(transition('power-on', 'running')),
  running: state(transition('stop', 'idle'))
});`;
  const tmpFile = path.join(os.tmpdir(), 'robot-hyphen-' + Date.now() + '.js');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    const events = ir.transitions.map(t => t.event);
    assert.ok(events.includes('power-on'), 'hyphenated event must not be dropped');
    assert.strictEqual(ir.transitions.length, 2);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

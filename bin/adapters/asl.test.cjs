#!/usr/bin/env node
'use strict';
// bin/adapters/asl.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { id, detect, extract } = require('./asl.cjs');

const fixture = JSON.stringify({
  StartAt: 'ProcessOrder',
  States: {
    ProcessOrder: { Type: 'Task', Next: 'CheckStatus' },
    CheckStatus: {
      Type: 'Choice',
      Choices: [{ Variable: '$.status', StringEquals: 'approved', Next: 'Complete' }],
      Default: 'Failed',
    },
    Complete: { Type: 'Succeed' },
    Failed: { Type: 'Fail' },
  },
});

test('adapter id is asl', () => {
  assert.strictEqual(id, 'asl');
});

test('detect returns high confidence for ASL JSON', () => {
  assert.ok(detect('workflow.json', fixture) >= 90);
});

test('detect returns 0 for non-ASL content', () => {
  assert.strictEqual(detect('data.json', '{"key": "value"}'), 0);
});

test('extract parses ASL fixture', () => {
  const tmpFile = path.join(os.tmpdir(), 'asl-test-' + Date.now() + '.json');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.framework, 'asl');
    assert.strictEqual(ir.initial, 'ProcessOrder');
    assert.strictEqual(ir.stateNames.length, 4);
    assert.strictEqual(ir.finalStates.length, 2);
    assert.strictEqual(ir.transitions.length, 3); // Next + Choice(guarded) + Choice(default)
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract throws a descriptive error for JSON missing States', () => {
  const tmpFile = path.join(os.tmpdir(), 'asl-no-states-' + Date.now() + '.json');
  fs.writeFileSync(tmpFile, JSON.stringify({ StartAt: 'X', foo: 'bar' }), 'utf8');
  try {
    assert.throws(() => extract(tmpFile), /States/);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract throws a descriptive error for top-level null JSON', () => {
  const tmpFile = path.join(os.tmpdir(), 'asl-null-' + Date.now() + '.json');
  fs.writeFileSync(tmpFile, 'null', 'utf8');
  try {
    assert.throws(() => extract(tmpFile), /ASL|States/);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract tolerates a null state definition and still builds an IR', () => {
  const tmpFile = path.join(os.tmpdir(), 'asl-null-state-' + Date.now() + '.json');
  fs.writeFileSync(tmpFile, JSON.stringify({
    StartAt: 'Good',
    States: {
      Good: { Type: 'Task', Next: 'Done' },
      Bad: null,
      Done: { Type: 'Succeed' },
    },
  }), 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.initial, 'Good');
    assert.strictEqual(ir.stateNames.length, 3);
    assert.ok(ir.transitions.some(t => t.fromState === 'Good' && t.target === 'Done'));
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

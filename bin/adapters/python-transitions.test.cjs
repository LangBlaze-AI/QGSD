#!/usr/bin/env node
'use strict';
// bin/adapters/python-transitions.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { id, detect, extract } = require('./python-transitions.cjs');

const fixture = `
from transitions import Machine
states = ['idle', 'processing', 'done']
transitions = [
    { 'trigger': 'start', 'source': 'idle', 'dest': 'processing' },
    { 'trigger': 'finish', 'source': 'processing', 'dest': 'done' },
    { 'trigger': 'reset', 'source': 'done', 'dest': 'idle' }
]
machine = Machine(model, states=states, transitions=transitions, initial='idle')
`;

test('adapter id is py-transitions', () => {
  assert.strictEqual(id, 'py-transitions');
});

test('detect returns high confidence for Python transitions', () => {
  assert.ok(detect('app.py', fixture) >= 85);
});

test('detect returns 0 for JS content', () => {
  assert.strictEqual(detect('app.js', 'const x = 1;'), 0);
});

test('extract parses Python transitions fixture', () => {
  const tmpFile = path.join(os.tmpdir(), 'py-transitions-test-' + Date.now() + '.py');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.framework, 'py-transitions');
    assert.strictEqual(ir.initial, 'idle');
    assert.strictEqual(ir.stateNames.length, 3);
    assert.strictEqual(ir.transitions.length, 3);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract throws clean error for non-string filePath', () => {
  assert.throws(() => extract(null), /filePath must be a non-empty string/);
  assert.throws(() => extract(undefined), /filePath must be a non-empty string/);
  assert.throws(() => extract(42), /filePath must be a non-empty string/);
});

test('extract does not match prefixed *states variables', () => {
  const content = `
from transitions import Machine
ui_states = ['hidden']
states = ['idle', 'processing', 'done', 'archived']
transitions = [
    { 'trigger': 'start', 'source': 'idle', 'dest': 'processing' }
]
machine = Machine(model, states=states, transitions=transitions, initial='idle')
`;
  const tmpFile = path.join(os.tmpdir(), 'py-transitions-prefix-' + Date.now() + '.py');
  fs.writeFileSync(tmpFile, content, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.ok(ir.stateNames.includes('archived'), 'should capture archived from the real states list');
    assert.ok(ir.stateNames.includes('done'), 'should capture done from the real states list');
    assert.ok(!ir.stateNames.includes('hidden'), 'should not capture hidden from ui_states');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract parses list/tuple-format transitions', () => {
  const content = `
from transitions import Machine
states = ['idle', 'processing', 'done']
transitions = [
    ['start', 'idle', 'processing'],
    ['finish', 'processing', 'done']
]
machine = Machine(model, states=states, transitions=transitions, initial='idle')
`;
  const tmpFile = path.join(os.tmpdir(), 'py-transitions-list-' + Date.now() + '.py');
  fs.writeFileSync(tmpFile, content, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.transitions.length, 2);
    assert.strictEqual(ir.transitions[0].event, 'start');
    assert.strictEqual(ir.transitions[0].fromState, 'idle');
    assert.strictEqual(ir.transitions[0].target, 'processing');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

#!/usr/bin/env node
'use strict';
// bin/adapters/stately.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { id, detect, extract } = require('./stately.cjs');

const fixture = JSON.stringify({
  id: 'traffic-light',
  initial: 'green',
  states: {
    green:  { on: { TIMER: { target: 'yellow' } } },
    yellow: { on: { TIMER: { target: 'red' } } },
    red:    { on: { TIMER: { target: 'green' } } },
  },
});

test('adapter id is stately', () => {
  assert.strictEqual(id, 'stately');
});

test('detect returns high confidence for Stately JSON', () => {
  assert.ok(detect('machine.json', fixture) >= 85);
});

test('detect returns 0 for ASL content', () => {
  const asl = JSON.stringify({ StartAt: 'A', States: { A: { Type: 'Task', Next: 'B' } } });
  assert.strictEqual(detect('workflow.json', asl), 0);
});

test('extract parses Stately fixture', () => {
  const tmpFile = path.join(os.tmpdir(), 'stately-test-' + Date.now() + '.json');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.framework, 'stately');
    assert.strictEqual(ir.machineId, 'traffic-light');
    assert.strictEqual(ir.initial, 'green');
    assert.strictEqual(ir.stateNames.length, 3);
    assert.strictEqual(ir.transitions.length, 3);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract throws a clear error when "states" is missing', () => {
  const tmpFile = path.join(os.tmpdir(), 'stately-nostates-' + Date.now() + '.json');
  fs.writeFileSync(tmpFile, JSON.stringify({ id: 'm', initial: 'a' }), 'utf8');
  try {
    assert.throws(() => extract(tmpFile), /states/i);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract skips null state definitions instead of crashing', () => {
  const tmpFile = path.join(os.tmpdir(), 'stately-nullstate-' + Date.now() + '.json');
  fs.writeFileSync(tmpFile, JSON.stringify({
    id: 'm', initial: 'green',
    states: { green: { on: { TIMER: { target: 'yellow' } } }, yellow: {}, broken: null },
  }), 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.transitions.length, 1);
    assert.ok(ir.stateNames.includes('broken'));
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract throws a clear error for non-object top-level JSON', () => {
  const tmpFile = path.join(os.tmpdir(), 'stately-toplevel-' + Date.now() + '.json');
  fs.writeFileSync(tmpFile, JSON.stringify(['not', 'a', 'machine']), 'utf8');
  try {
    assert.throws(() => extract(tmpFile), /invalid machine|states/i);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

#!/usr/bin/env node
'use strict';
// bin/adapters/ir.test.cjs
// Tests for MachineIR schema validation.

const { test } = require('node:test');
const assert = require('node:assert');
const { validateIR } = require('./ir.cjs');

function validIR() {
  return {
    machineId: 'test-machine',
    initial: 'idle',
    stateNames: ['idle', 'running', 'done'],
    finalStates: ['done'],
    transitions: [
      { fromState: 'idle', event: 'START', guard: null, target: 'running', assignedKeys: [] },
      { fromState: 'running', event: 'FINISH', guard: 'isReady', target: 'done', assignedKeys: ['count'] },
    ],
    ctxVars: ['count'],
    ctxDefaults: { count: 0 },
    sourceFile: 'test.ts',
    framework: 'xstate-v5',
  };
}

test('valid IR passes validation', () => {
  const result = validateIR(validIR());
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.errors.length, 0);
});

test('missing required fields fail validation', () => {
  const ir = validIR();
  delete ir.machineId;
  const result = validateIR(ir);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('machineId')));
});

test('empty framework fails validation', () => {
  const ir = validIR();
  ir.framework = '';
  const result = validateIR(ir);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('framework')));
});

test('initial not in stateNames fails', () => {
  const ir = validIR();
  ir.initial = 'nonexistent';
  const result = validateIR(ir);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('initial')));
});

test('finalState not in stateNames fails', () => {
  const ir = validIR();
  ir.finalStates = ['nonexistent'];
  const result = validateIR(ir);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('finalState')));
});

test('transition fromState not in stateNames fails', () => {
  const ir = validIR();
  ir.transitions[0].fromState = 'nonexistent';
  const result = validateIR(ir);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('fromState')));
});

test('transition target not in stateNames fails', () => {
  const ir = validIR();
  ir.transitions[0].target = 'nonexistent';
  const result = validateIR(ir);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('target')));
});

test('null IR fails', () => {
  const result = validateIR(null);
  assert.strictEqual(result.valid, false);
});

test('IR with empty finalStates is valid', () => {
  const ir = validIR();
  ir.finalStates = [];
  const result = validateIR(ir);
  assert.strictEqual(result.valid, true);
});

test('transition with non-string guard fails validation', () => {
  const ir = validIR();
  ir.transitions[0].guard = { type: 'BinaryExpression' };
  const result = validateIR(ir);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('guard')));
});

test('transition with null guard is valid', () => {
  const ir = validIR();
  ir.transitions[0].guard = null;
  const result = validateIR(ir);
  assert.strictEqual(result.valid, true);
});

test('transition with non-string assignedKeys element fails validation', () => {
  const ir = validIR();
  ir.transitions[1].assignedKeys = ['count', 42];
  const result = validateIR(ir);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('assignedKeys')));
});

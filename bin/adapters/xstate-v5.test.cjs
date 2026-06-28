#!/usr/bin/env node
'use strict';
// bin/adapters/xstate-v5.test.cjs
// Tests for XState v5 adapter.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { id, detect, extract } = require('./xstate-v5.cjs');

test('adapter id is xstate-v5', () => {
  assert.strictEqual(id, 'xstate-v5');
});

test('detect returns high confidence for XState v5 content', () => {
  const content = `
    import { createMachine } from 'xstate';
    export const machine = createMachine({ ... });
    machine.config.states;
  `;
  const confidence = detect('machine.ts', content);
  assert.ok(confidence >= 70, 'Expected >= 70, got ' + confidence);
});

test('detect returns 0 for Python content', () => {
  const content = `
    from transitions import Machine
    states = ['idle', 'running']
  `;
  const confidence = detect('app.py', content);
  assert.strictEqual(confidence, 0);
});

test('extract parses XState v5 fixture with correct counts', () => {
  const fixture = `
exports.machine = {
  config: {
    id: 'traffic',
    initial: 'green',
    states: {
      green: { on: { TIMER: { target: 'yellow' } } },
      yellow: { on: { TIMER: { target: 'red' } } },
      red: { on: { TIMER: { target: 'green' } } }
    }
  }
};
`;
  const tmpFile = path.join(os.tmpdir(), 'xstate-v5-test-' + Date.now() + '.js');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.framework, 'xstate-v5');
    assert.strictEqual(ir.initial, 'green');
    assert.strictEqual(ir.stateNames.length, 3);
    assert.strictEqual(ir.transitions.length, 3);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract on real nf-workflow.machine.ts produces valid IR', () => {
  const machineFile = path.join(__dirname, '..', '..', 'src', 'machines', 'nf-workflow.machine.ts');
  const ir = extract(machineFile, {
    userVars: {
      currentPhase: 'skip',
      maxDeliberation: 'const',
      successCount: 'event',
      slotsAvailable: 'event',
      deliberationRounds: 'deliberationRounds + 1',
    },
  });

  assert.strictEqual(ir.framework, 'xstate-v5');
  assert.strictEqual(ir.machineId, 'nf-workflow');
  assert.ok(ir.stateNames.length > 0, 'Should have states');
  assert.ok(ir.transitions.length > 0, 'Should have transitions');
  assert.ok(ir.stateNames.includes(ir.initial), 'initial should be in stateNames');
});

test('extract treats a null state value as a leaf instead of crashing', () => {
  const fixture = `
exports.machine = {
  config: {
    id: 'm',
    initial: 'green',
    states: {
      green: { on: { TIMER: { target: 'done' } } },
      done: null
    }
  }
};
`;
  const tmpFile = path.join(os.tmpdir(), 'xstate-v5-nullstate-' + Date.now() + '.js');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    let ir;
    assert.doesNotThrow(() => { ir = extract(tmpFile); });
    assert.strictEqual(ir.framework, 'xstate-v5');
    assert.ok(ir.stateNames.includes('done'), 'null state should still be listed');
    assert.strictEqual(ir.finalStates.length, 0, 'null state is not final');
    assert.strictEqual(ir.transitions.length, 1, 'only green has a transition');
    assert.strictEqual(ir.transitions[0].target, 'done');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

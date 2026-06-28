#!/usr/bin/env node
'use strict';
// bin/adapters/stateless4j.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { id, detect, extract } = require('./stateless4j.cjs');

const fixture = `
import com.github.oxo42.stateless4j.StateMachineConfig;
import com.github.oxo42.stateless4j.StateMachine;

public class PhoneCall {
    enum State { OffHook, Ringing, Connected, OnHold }
    enum Trigger { CallDialed, CallConnected, PlaceOnHold, TakeOffHold, HangUp }

    public static void main(String[] args) {
        StateMachineConfig<State, Trigger> config = new StateMachineConfig<>();

        config.configure(State.OffHook)
            .permit(Trigger.CallDialed, State.Ringing);

        config.configure(State.Ringing)
            .permit(Trigger.CallConnected, State.Connected)
            .permit(Trigger.HangUp, State.OffHook);

        config.configure(State.Connected)
            .permit(Trigger.PlaceOnHold, State.OnHold)
            .permit(Trigger.HangUp, State.OffHook);

        config.configure(State.OnHold)
            .permit(Trigger.TakeOffHold, State.Connected)
            .permit(Trigger.HangUp, State.OffHook);

        StateMachine<State, Trigger> sm = new StateMachine<>(State.OffHook, config);
    }
}
`;

test('adapter id is stateless4j', () => {
  assert.strictEqual(id, 'stateless4j');
});

test('detect returns high confidence for stateless4j code', () => {
  assert.ok(detect('PhoneCall.java', fixture) >= 90);
});

test('detect returns 0 for unrelated Java code', () => {
  assert.strictEqual(detect('App.java', 'import java.io.File;'), 0);
});

test('extract parses stateless4j fixture', () => {
  const tmpFile = path.join(os.tmpdir(), 'stateless4j-test-' + Date.now() + '.java');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.framework, 'stateless4j');
    assert.strictEqual(ir.initial, 'OffHook');
    assert.strictEqual(ir.stateNames.length, 4);
    assert.strictEqual(ir.transitions.length, 7);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract resolves identifiers that collide with Object.prototype members', () => {
  const protoFixture = `
import com.github.oxo42.stateless4j.StateMachineConfig;
import com.github.oxo42.stateless4j.StateMachine;

public class Proto {
    StateMachineConfig<State, Trigger> config = new StateMachineConfig<>();
    config.configure(State.constructor)
        .permit(Trigger.toString, State.Done);
    StateMachine<State, Trigger> sm = new StateMachine<>(State.constructor, config);
}
`;
  const tmpFile = path.join(os.tmpdir(), 'stateless4j-proto-' + Date.now() + '.java');
  fs.writeFileSync(tmpFile, protoFixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.initial, 'constructor');
    assert.ok(ir.stateNames.includes('constructor'));
    assert.ok(ir.stateNames.includes('Done'));
    assert.strictEqual(ir.transitions.length, 1);
    assert.strictEqual(ir.transitions[0].fromState, 'constructor');
    assert.strictEqual(ir.transitions[0].event, 'toString');
    assert.strictEqual(ir.transitions[0].target, 'Done');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

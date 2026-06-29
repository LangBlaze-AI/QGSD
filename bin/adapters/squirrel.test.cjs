#!/usr/bin/env node
'use strict';
// bin/adapters/squirrel.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { id, detect, extract } = require('./squirrel.cjs');

const fixture = `
import org.squirrelframework.foundation.fsm.StateMachineBuilder;
import org.squirrelframework.foundation.fsm.StateMachineBuilderFactory;
import org.squirrelframework.foundation.fsm.annotation.Transit;
import org.squirrelframework.foundation.fsm.annotation.Transitions;

@Transitions({
    @Transit(from="Idle", to="Running", on="Start"),
    @Transit(from="Running", to="Paused", on="Pause"),
    @Transit(from="Paused", to="Running", on="Resume"),
    @Transit(from="Running", to="Stopped", on="Stop")
})
public class TaskStateMachine extends AbstractStateMachine<TaskStateMachine, String, String, Void> {
}

public class Main {
    public static void main(String[] args) {
        StateMachineBuilder builder = StateMachineBuilderFactory.create(TaskStateMachine.class);
        TaskStateMachine sm = builder.newStateMachine(Idle);
    }
}
`;

test('adapter id is squirrel', () => {
  assert.strictEqual(id, 'squirrel');
});

test('detect returns high confidence for Squirrel Foundation code', () => {
  assert.ok(detect('TaskStateMachine.java', fixture) >= 90);
});

test('detect returns 0 for unrelated Java code', () => {
  assert.strictEqual(detect('App.java', 'import java.util.HashMap;'), 0);
});

test('extract parses Squirrel Foundation fixture', () => {
  const tmpFile = path.join(os.tmpdir(), 'squirrel-test-' + Date.now() + '.java');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.framework, 'squirrel');
    assert.strictEqual(ir.initial, 'Idle');
    assert.strictEqual(ir.stateNames.length, 4);
    assert.strictEqual(ir.transitions.length, 4);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract preserves whenMvel guard containing parentheses', () => {
  const src = `
import org.squirrelframework.foundation.fsm.annotation.Transit;
@Transit(from="A", to="B", on="E", whenMvel="count > 0 && (a || b)")
public class M {}
`;
  const tmpFile = path.join(os.tmpdir(), 'squirrel-guard-' + Date.now() + '.java');
  fs.writeFileSync(tmpFile, src, 'utf8');
  try {
    const ir = extract(tmpFile);
    const t = ir.transitions.find(x => x.fromState === 'A' && x.target === 'B');
    assert.ok(t, 'transition A->B should be extracted');
    assert.strictEqual(t.guard, 'count > 0 && (a || b)');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract preserves builder whenMvel guard', () => {
  const src = `
import org.squirrelframework.foundation.fsm.StateMachineBuilder;
builder.externalTransition().from(A).to(B).on(E).whenMvel("ready == true");
TaskStateMachine sm = builder.newStateMachine(A);
`;
  const tmpFile = path.join(os.tmpdir(), 'squirrel-builder-guard-' + Date.now() + '.java');
  fs.writeFileSync(tmpFile, src, 'utf8');
  try {
    const ir = extract(tmpFile);
    const t = ir.transitions.find(x => x.fromState === 'A' && x.target === 'B');
    assert.ok(t, 'builder transition A->B should be extracted');
    assert.strictEqual(t.guard, 'ready == true');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

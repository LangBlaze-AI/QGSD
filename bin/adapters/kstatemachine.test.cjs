#!/usr/bin/env node
'use strict';
// bin/adapters/kstatemachine.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { id, detect, extract } = require('./kstatemachine.cjs');

const fixture = `
import ru.nsk.kstatemachine.createStateMachine
import ru.nsk.kstatemachine.state.*
import ru.nsk.kstatemachine.transition.*

sealed class Events {
    object Start : Event
    object Pause : Event
    object Complete : Event
}

fun createWorkflowMachine() = createStateMachine("workflow") {
    addInitialState(Idle) {
        transition<Start> { targetState = Running }
    }
    addState(Running) {
        transition<Pause> { targetState = Paused }
        transition<Complete> { targetState = Done }
    }
    addState(Paused) {
        transition<Resume> { targetState = Running }
    }
    addFinalState(Done)
}
`;

test('adapter id is kstatemachine', () => {
  assert.strictEqual(id, 'kstatemachine');
});

test('detect returns high confidence for kstatemachine code', () => {
  assert.ok(detect('Workflow.kt', fixture) >= 90);
});

test('detect returns 0 for unrelated Kotlin code', () => {
  assert.strictEqual(detect('App.kt', 'fun main() { println("Hello") }'), 0);
});

test('extract parses kstatemachine fixture', () => {
  const tmpFile = path.join(os.tmpdir(), 'kstatemachine-test-' + Date.now() + '.kt');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.framework, 'kstatemachine');
    assert.strictEqual(ir.initial, 'Idle');
    assert.strictEqual(ir.stateNames.length, 4);
    assert.strictEqual(ir.transitions.length, 4);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract throws a clean error for a directory path (not raw EISDIR)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kstatemachine-dir-'));
  try {
    assert.throws(() => extract(dir), (err) => {
      assert.notStrictEqual(err.code, 'EISDIR');
      return /File not found|must be a non-empty string/.test(err.message);
    });
  } finally {
    fs.rmdirSync(dir);
  }
});

test('extract throws a clear error for non-string filePath', () => {
  for (const bad of [undefined, null, 42]) {
    assert.throws(() => extract(bad), (err) => {
      assert.notStrictEqual(err.code, 'ERR_INVALID_ARG_TYPE');
      return /non-empty string|filePath/.test(err.message);
    });
  }
});

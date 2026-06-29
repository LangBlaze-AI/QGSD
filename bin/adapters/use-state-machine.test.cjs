#!/usr/bin/env node
'use strict';
// bin/adapters/use-state-machine.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { id, detect, extract } = require('./use-state-machine.cjs');

const fixture = `
import useStateMachine from '@cassiozen/usestatemachine';

function App() {
  const [state, send] = useStateMachine({
    initial: "idle",
    states: {
      idle: {
        on: { START: "loading", RESET: "idle" }
      },
      loading: {
        on: { SUCCESS: "success", FAILURE: "error" }
      },
      success: {
        on: { RESET: "idle" }
      },
      error: {
        on: { RETRY: "loading" }
      }
    }
  });
}
`;

test('adapter id is use-state-machine', () => {
  assert.strictEqual(id, 'use-state-machine');
});

test('detect returns high confidence for useStateMachine code', () => {
  assert.ok(detect('App.tsx', fixture) >= 90);
});

test('detect returns 0 for unrelated content', () => {
  assert.strictEqual(detect('app.py', 'import flask'), 0);
});

test('extract parses useStateMachine fixture', () => {
  const tmpFile = path.join(os.tmpdir(), 'use-state-machine-test-' + Date.now() + '.tsx');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.framework, 'use-state-machine');
    assert.strictEqual(ir.initial, 'idle');
    assert.strictEqual(ir.stateNames.length, 4);
    assert.strictEqual(ir.transitions.length, 6);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract throws a clean error (not ERR_INVALID_ARG_TYPE) on null filePath', () => {
  assert.throws(
    () => extract(null),
    (err) => {
      assert.notStrictEqual(err.code, 'ERR_INVALID_ARG_TYPE');
      assert.ok(!/must be of type string/i.test(err.message), 'should not leak a raw path TypeError');
      assert.match(err.message, /File not found/);
      return true;
    }
  );
});

test('extract throws a clean error on undefined filePath (no args)', () => {
  assert.throws(
    () => extract(),
    (err) => {
      assert.notStrictEqual(err.code, 'ERR_INVALID_ARG_TYPE');
      assert.match(err.message, /File not found/);
      return true;
    }
  );
});

test('extract throws a clean error (not EISDIR) on a directory path', () => {
  assert.throws(
    () => extract(os.tmpdir()),
    (err) => {
      assert.notStrictEqual(err.code, 'EISDIR');
      assert.match(err.message, /File not found/);
      return true;
    }
  );
});

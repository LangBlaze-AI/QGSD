#!/usr/bin/env node
'use strict';
// bin/adapters/detect.test.cjs
// Tests for auto-detection registry.

const { test } = require('node:test');
const assert = require('node:assert');
const { detectFramework, getAdapter } = require('./detect.cjs');

test('detectFramework returns xstate-v5 for XState content', () => {
  const content = `
    import { createMachine } from 'xstate';
    export const machine = createMachine({ ... });
    machine.config.states;
  `;
  const result = detectFramework('machine.ts', content);
  assert.ok(result, 'Should detect a framework');
  assert.strictEqual(result.adapter.id, 'xstate-v5');
  assert.ok(result.confidence >= 70);
});

test('detectFramework returns null for unknown content', () => {
  const result = detectFramework('unknown.txt', 'hello world nothing here');
  assert.strictEqual(result, null);
});

test('getAdapter returns correct adapter for xstate-v5', () => {
  const adapter = getAdapter('xstate-v5');
  assert.strictEqual(adapter.id, 'xstate-v5');
  assert.ok(typeof adapter.detect === 'function');
  assert.ok(typeof adapter.extract === 'function');
});

test('getAdapter throws for unknown framework', () => {
  assert.throws(() => getAdapter('nonexistent'), /Unknown framework/);
});

test('getAdapter throws Unknown framework for inherited-property keys (no ERR_INVALID_ARG_TYPE)', () => {
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.throws(
      () => getAdapter(key),
      (err) => {
        assert.strictEqual(err.code, undefined, `expected plain Error for "${key}", got code ${err.code}`);
        assert.match(err.message, /Unknown framework/);
        return true;
      },
      `getAdapter(${JSON.stringify(key)}) should throw a descriptive Unknown framework error`
    );
  }
});

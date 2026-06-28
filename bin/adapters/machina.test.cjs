#!/usr/bin/env node
'use strict';
// bin/adapters/machina.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { id, detect, extract } = require('./machina.cjs');

const fixture = `
const machina = require('machina');

const trafficLight = new machina.Fsm({
  initialState: "green",
  states: {
    green: {
      _onEnter: function() {},
      warn: function() {
        this.transition("yellow");
      }
    },
    yellow: {
      _onEnter: function() {},
      stop: function() {
        this.transition("red");
      }
    },
    red: {
      _onEnter: function() {},
      go: function() {
        this.transition("green");
      }
    }
  }
});
`;

test('adapter id is machina', () => {
  assert.strictEqual(id, 'machina');
});

test('detect returns high confidence for Machina.js code', () => {
  assert.ok(detect('traffic.js', fixture) >= 90);
});

test('detect returns 0 for unrelated JS content', () => {
  assert.strictEqual(detect('app.js', 'const x = require("express");'), 0);
});

test('extract parses Machina.js fixture', () => {
  const tmpFile = path.join(os.tmpdir(), 'machina-test-' + Date.now() + '.js');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.framework, 'machina');
    assert.strictEqual(ir.initial, 'green');
    assert.strictEqual(ir.stateNames.length, 3);
    assert.strictEqual(ir.transitions.length, 3);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract throws a clear error for non-string filePath instead of raw TypeError', () => {
  for (const bad of [null, undefined, 123, {}, []]) {
    assert.throws(
      () => extract(bad),
      (err) => err instanceof Error && err.code !== 'ERR_INVALID_ARG_TYPE' && /filePath|string|File not found/i.test(err.message),
      `expected clean adapter error for input ${String(bad)}`
    );
  }
});

test('extract falls back to first discovered state when initialState is omitted', () => {
  const noInitial = `
const machina = require('machina');
const m = new machina.Fsm({
  states: {
    idle: { start: function() { this.transition('running'); } },
    running: { stop: function() { this.transition('idle'); } }
  }
});
`;
  const tmpFile = path.join(os.tmpdir(), 'machina-noinit-' + Date.now() + '.js');
  fs.writeFileSync(tmpFile, noInitial, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.ok(ir.stateNames.length >= 2);
    assert.ok(ir.initial.length > 0, 'initial should not be empty');
    assert.ok(ir.stateNames.includes(ir.initial), 'initial must be a real state');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

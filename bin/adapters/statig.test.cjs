#!/usr/bin/env node
'use strict';
// bin/adapters/statig.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { id, detect, extract } = require('./statig.cjs');

const fixture = `
use statig::prelude::*;

enum State {
    Idle,
    Running,
    Paused,
    Done
}

#[state_machine(initial = "State::Idle")]
impl Machine {
    #[transition(from = "Idle", to = "Running", event = "start")]
    fn on_start(&self) {}

    #[transition(from = "Running", to = "Paused", event = "pause")]
    fn on_pause(&self) {}

    #[transition(from = "Paused", to = "Running", event = "resume")]
    fn on_resume(&self) {}

    #[transition(from = "Running", to = "Done", event = "finish")]
    fn on_finish(&self) {}
}
`;

test('adapter id is statig', () => {
  assert.strictEqual(id, 'statig');
});

test('detect returns high confidence for statig code', () => {
  assert.ok(detect('machine.rs', fixture) >= 90);
});

test('detect returns 0 for unrelated Rust code', () => {
  assert.strictEqual(detect('main.rs', 'use std::io;\nfn main() {}'), 0);
});

test('extract parses statig fixture', () => {
  const tmpFile = path.join(os.tmpdir(), 'statig-test-' + Date.now() + '.rs');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.framework, 'statig');
    assert.strictEqual(ir.initial, 'Idle');
    assert.strictEqual(ir.stateNames.length, 4);
    assert.strictEqual(ir.transitions.length, 4);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract ignores enum variant payload types and discriminants', () => {
  const dataEnumFixture = `
use statig::prelude::*;

enum State {
    Idle,
    Running,
    Failed(ErrorCode)
}

#[state_machine(initial = "State::Idle")]
impl Machine {
    #[transition(from = "Idle", to = "Running", event = "start")]
    fn on_start(&self) {}
}
`;
  const tmpFile = path.join(os.tmpdir(), 'statig-enumdata-' + Date.now() + '.rs');
  fs.writeFileSync(tmpFile, dataEnumFixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.ok(!ir.stateNames.includes('ErrorCode'), 'payload type ErrorCode must not be a state');
    assert.ok(ir.stateNames.includes('Failed'), 'variant name Failed must be a state');
    assert.deepStrictEqual([...ir.stateNames].sort(), ['Failed', 'Idle', 'Running']);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract handles statig function-form state refs State::name()', () => {
  const fnFixture = `
use statig::prelude::*;

#[state_machine(initial = "State::idle()")]
impl Machine {
    #[transition(from = "State::idle()", to = "State::running()", event = "go")]
    fn on_go(&self) {}
}
`;
  const tmpFile = path.join(os.tmpdir(), 'statig-fnstate-' + Date.now() + '.rs');
  fs.writeFileSync(tmpFile, fnFixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.initial, 'idle');
    assert.ok(ir.stateNames.includes('running'));
    assert.strictEqual(ir.transitions.length, 1);
    assert.strictEqual(ir.transitions[0].fromState, 'idle');
    assert.strictEqual(ir.transitions[0].target, 'running');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract rejects non-string filePath with a clear error', () => {
  assert.throws(() => extract(null), /statig adapter: filePath/);
  assert.throws(() => extract(undefined), /statig adapter: filePath/);
  assert.throws(() => extract(123), /statig adapter: filePath/);
});

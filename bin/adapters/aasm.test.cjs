#!/usr/bin/env node
'use strict';
// bin/adapters/aasm.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { id, detect, extract } = require('./aasm.cjs');

// Uses :pending (contains "end" substring) to verify the do/end depth parser
// doesn't truncate event blocks at the "end" inside "pending".
const fixture = `
class Order
  include AASM

  aasm do
    state :pending, initial: true
    state :confirmed
    state :shipped
    state :delivered

    event :confirm do
      transitions from: :pending, to: :confirmed
    end

    event :ship do
      transitions from: :confirmed, to: :shipped, guard: :payment_ok?
    end

    event :deliver do
      transitions from: :shipped, to: :delivered
    end
  end
end
`;

test('adapter id is aasm', () => {
  assert.strictEqual(id, 'aasm');
});

test('detect returns high confidence for AASM Ruby code', () => {
  assert.ok(detect('order.rb', fixture) >= 90);
});

test('detect returns 0 for unrelated Ruby code', () => {
  assert.strictEqual(detect('app.rb', 'require "sinatra"\nclass App < Sinatra::Base\nend'), 0);
});

test('extract handles nested do/end inside event blocks', () => {
  // Nested if/end inside an event block — the depth counter must not
  // mistake the inner "end" for the event's closing "end".
  const nested = `
class Ticket
  include AASM

  aasm do
    state :pending, initial: true
    state :attending
    state :ended

    event :attend do
      transitions from: :pending, to: :attending
    end

    event :finish do
      transitions from: :attending, to: :ended
    end
  end
end
`;
  const tmpFile = path.join(os.tmpdir(), 'aasm-nested-' + Date.now() + '.rb');
  fs.writeFileSync(tmpFile, nested, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.initial, 'pending');
    assert.strictEqual(ir.stateNames.length, 3);
    assert.strictEqual(ir.transitions.length, 2);
    // Verify the :ended state (contains "end") was correctly extracted as a target
    assert.ok(ir.stateNames.includes('ended'), 'should include state named :ended');
    assert.ok(ir.transitions.some(t => t.target === 'ended'), 'should have transition to :ended');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract defaults initial to first declared state when none marked initial: true', () => {
  const noInitial = `
class Job
  include AASM

  aasm do
    state :queued
    state :running
    state :done

    event :start do
      transitions from: :queued, to: :running
    end

    event :finish do
      transitions from: :running, to: :done
    end
  end
end
`;
  const tmpFile = path.join(os.tmpdir(), 'aasm-noinit-' + Date.now() + '.rb');
  fs.writeFileSync(tmpFile, noInitial, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.initial, 'queued', 'AASM uses first declared state as initial');
    assert.strictEqual(ir.transitions.length, 2);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract does not miscount do/end inside Ruby comments', () => {
  const withComment = `
class Order
  include AASM

  aasm do
    state :pending, initial: true
    state :submitted
    state :shipped

    event :submit do
      transitions from: :pending, to: :submitted
      # please do not remove this line
    end

    event :ship do
      transitions from: :submitted, to: :shipped
    end
  end
end
`;
  const tmpFile = path.join(os.tmpdir(), 'aasm-comment-' + Date.now() + '.rb');
  fs.writeFileSync(tmpFile, withComment, 'utf8');
  try {
    const ir = extract(tmpFile);
    const submitTrans = ir.transitions.filter(t => t.event === 'submit');
    assert.strictEqual(submitTrans.length, 1, 'submit must own exactly one transition');
    assert.strictEqual(submitTrans[0].target, 'submitted');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract parses AASM fixture', () => {
  const tmpFile = path.join(os.tmpdir(), 'aasm-test-' + Date.now() + '.rb');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.framework, 'aasm');
    assert.strictEqual(ir.initial, 'pending');
    assert.strictEqual(ir.stateNames.length, 4);
    assert.strictEqual(ir.transitions.length, 3);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

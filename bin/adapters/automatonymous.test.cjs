#!/usr/bin/env node
'use strict';
// bin/adapters/automatonymous.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { id, detect, extract } = require('./automatonymous.cjs');

const fixture = `
using MassTransit;

public class OrderStateMachine : MassTransitStateMachine<OrderState>
{
    public State Submitted { get; private set; }
    public State Accepted { get; private set; }
    public State Completed { get; private set; }

    public Event<OrderSubmitted> OrderSubmittedEvent { get; private set; }
    public Event<OrderAccepted> OrderAcceptedEvent { get; private set; }
    public Event<OrderCompleted> OrderCompletedEvent { get; private set; }

    public OrderStateMachine()
    {
        Event(() => OrderSubmittedEvent);
        Event(() => OrderAcceptedEvent);
        Event(() => OrderCompletedEvent);

        State(() => Submitted);
        State(() => Accepted);
        State(() => Completed);

        Initially(
            When(OrderSubmittedEvent)
                .TransitionTo(Submitted)
        );

        During(Submitted,
            When(OrderAcceptedEvent)
                .TransitionTo(Accepted)
        );

        During(Accepted,
            When(OrderCompletedEvent)
                .TransitionTo(Completed)
        );

        During(Completed,
            When(OrderCompletedEvent)
                .Finalize()
        );
    }
}
`;

test('adapter id is automatonymous', () => {
  assert.strictEqual(id, 'automatonymous');
});

test('detect returns high confidence for Automatonymous/MassTransit code', () => {
  assert.ok(detect('OrderStateMachine.cs', fixture) >= 90);
});

test('detect returns 0 for unrelated C# code', () => {
  assert.strictEqual(detect('Program.cs', 'using System.Linq;\nvar list = new List<int>();'), 0);
});

test('extract parses Automatonymous fixture', () => {
  const tmpFile = path.join(os.tmpdir(), 'automatonymous-test-' + Date.now() + '.cs');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.framework, 'automatonymous');
    assert.strictEqual(ir.initial, 'Initial');
    assert.strictEqual(ir.stateNames.length, 5);
    assert.strictEqual(ir.transitions.length, 4);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract throws a clean error for a non-string filePath', () => {
  const re = /filePath must be a non-empty string/i;
  assert.throws(() => extract(null), re);
  assert.throws(() => extract(undefined), re);
  assert.throws(() => extract(123), re);
});

test('extract throws a clean error for a directory path (not raw EISDIR)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automatonymous-dir-'));
  try {
    assert.throws(() => extract(dir), (err) => {
      return err instanceof Error
        && err.code !== 'EISDIR'
        && /not a file|File not found/i.test(err.message);
    });
  } finally {
    fs.rmdirSync(dir);
  }
});

test('extract does not cross-pair an action-only When() with a later TransitionTo', () => {
  const src = `
using MassTransit;

public class CrossMachine : MassTransitStateMachine<S>
{
    public CrossMachine()
    {
        Initially(
            When(StartEvent).TransitionTo(Open)
        );
        During(Open,
            When(IgnoredEvent).Then(ctx => {}),
            When(RealEvent).TransitionTo(Closed)
        );
    }
}`;
  const tmpFile = path.join(os.tmpdir(), 'automatonymous-cross-' + Date.now() + '.cs');
  fs.writeFileSync(tmpFile, src, 'utf8');
  try {
    const ir = extract(tmpFile);
    const open = ir.transitions.filter(t => t.fromState === 'Open');
    assert.ok(
      open.some(t => t.event === 'RealEvent' && t.target === 'Closed'),
      'RealEvent should transition Open -> Closed'
    );
    assert.ok(
      !open.some(t => t.event === 'IgnoredEvent' && t.target === 'Closed'),
      'IgnoredEvent (no TransitionTo) must not be cross-paired to Closed'
    );
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

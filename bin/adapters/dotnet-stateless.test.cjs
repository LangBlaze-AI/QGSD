#!/usr/bin/env node
'use strict';
// bin/adapters/dotnet-stateless.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { id, detect, extract } = require('./dotnet-stateless.cjs');

const fixture = `
using Stateless;

public class BugTracker
{
    enum State { Open, Assigned, InProgress, Resolved, Closed }
    enum Trigger { Assign, StartWork, Resolve, Close, Reopen }

    private readonly StateMachine<State, Trigger> _machine;

    public BugTracker()
    {
        _machine = new StateMachine<State, Trigger>(State.Open);

        _machine.Configure(State.Open)
            .Permit(Trigger.Assign, State.Assigned);

        _machine.Configure(State.Assigned)
            .Permit(Trigger.StartWork, State.InProgress)
            .Permit(Trigger.Close, State.Closed);

        _machine.Configure(State.InProgress)
            .Permit(Trigger.Resolve, State.Resolved);

        _machine.Configure(State.Resolved)
            .Permit(Trigger.Close, State.Closed)
            .Permit(Trigger.Reopen, State.Open);
    }
}
`;

test('adapter id is dotnet-stateless', () => {
  assert.strictEqual(id, 'dotnet-stateless');
});

test('detect returns high confidence for .NET Stateless code', () => {
  assert.ok(detect('BugTracker.cs', fixture) >= 90);
});

test('detect returns 0 for unrelated C# code', () => {
  assert.strictEqual(detect('Program.cs', 'using System;\nConsole.WriteLine("Hi");'), 0);
});

test('extract parses .NET Stateless fixture', () => {
  const tmpFile = path.join(os.tmpdir(), 'dotnet-stateless-test-' + Date.now() + '.cs');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.framework, 'dotnet-stateless');
    assert.strictEqual(ir.initial, 'Open');
    assert.strictEqual(ir.stateNames.length, 5);
    assert.strictEqual(ir.transitions.length, 6);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract captures Permit after an OnEntry lambda (chain not truncated by inner parens)', () => {
  const src = `
using Stateless;
public class Door
{
    enum State { Closed, Opened }
    enum Trigger { Open }
    private readonly StateMachine<State, Trigger> _machine;
    public Door()
    {
        _machine = new StateMachine<State, Trigger>(State.Closed);
        _machine.Configure(State.Closed)
            .OnEntry(() => Log())
            .Permit(Trigger.Open, State.Opened);
    }
}
`;
  const tmpFile = path.join(os.tmpdir(), 'dotnet-stateless-onentry-' + Date.now() + '.cs');
  fs.writeFileSync(tmpFile, src, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.transitions.length, 1, 'OnEntry lambda must not drop the following Permit');
    assert.strictEqual(ir.transitions[0].target, 'Opened');
    assert.ok(ir.stateNames.includes('Opened'), "'Opened' must be in stateNames");
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

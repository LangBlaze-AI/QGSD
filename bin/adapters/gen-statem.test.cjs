#!/usr/bin/env node
'use strict';
// bin/adapters/gen-statem.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { id, detect, extract } = require('./gen-statem.cjs');

const fixtureElixir = `
defmodule Door do
  use GenStateMachine

  def init(_) do
    {:ok, :locked, %{}}
  end

  def handle_event(:cast, :unlock, :locked, data) do
    {:next_state, :unlocked, data}
  end

  def handle_event(:cast, :lock, :unlocked, data) do
    {:next_state, :locked, data}
  end

  def handle_event(:cast, :open, :unlocked, data) do
    {:next_state, :opened, data}
  end
end
`;

const fixtureErlang = `
-module(turnstile).
-behaviour(gen_statem).

init([]) ->
    {ok, locked, #{}}.

handle_event(cast, coin, locked, Data) ->
    {next_state, unlocked, Data};

handle_event(cast, push, unlocked, Data) ->
    {next_state, locked, Data}.
`;

test('adapter id is gen-statem', () => {
  assert.strictEqual(id, 'gen-statem');
});

test('detect returns high confidence for gen_statem content', () => {
  assert.ok(detect('door.ex', fixtureElixir) >= 90);
  assert.ok(detect('turnstile.erl', fixtureErlang) >= 90);
});

test('detect returns 0 for unrelated content', () => {
  assert.strictEqual(detect('app.js', 'const x = 1;'), 0);
});

test('extract parses gen_statem fixture with correct counts', () => {
  const tmpFileEx = path.join(os.tmpdir(), 'gen-statem-ex-test-' + Date.now() + '.ex');
  fs.writeFileSync(tmpFileEx, fixtureElixir, 'utf8');
  try {
    const ir = extract(tmpFileEx);
    assert.strictEqual(ir.framework, 'gen-statem');
    assert.strictEqual(ir.initial, 'locked');
    assert.strictEqual(ir.stateNames.length, 3);
    assert.strictEqual(ir.transitions.length, 3);
  } finally {
    fs.unlinkSync(tmpFileEx);
  }
});

test('extract does not fabricate transitions across non-transitioning Elixir clauses', () => {
  const src = `
defmodule Counter do
  use GenStateMachine

  def init(_) do
    {:ok, :idle, %{}}
  end

  def handle_event(:cast, :ping, :idle, data) do
    {:keep_state, data}
  end

  def handle_event(:cast, :start, :idle, data) do
    {:next_state, :running, data}
  end
end
`;
  const tmpFile = path.join(os.tmpdir(), 'gen-statem-ex-lazy-' + Date.now() + '.ex');
  fs.writeFileSync(tmpFile, src, 'utf8');
  try {
    const ir = extract(tmpFile);
    const ping = ir.transitions.find(t => t.event === 'ping');
    assert.strictEqual(ping, undefined, 'ping keeps state and must not be a transition');
    const start = ir.transitions.find(t => t.event === 'start');
    assert.ok(start, 'real start->running transition must be captured');
    assert.strictEqual(start.fromState, 'idle');
    assert.strictEqual(start.target, 'running');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract does not fabricate transitions across non-transitioning Erlang clauses', () => {
  const src = `
-module(gate).
-behaviour(gen_statem).

init([]) ->
    {ok, idle, #{}}.

handle_event(cast, tick, idle, Data) ->
    {keep_state, Data};

handle_event(cast, go, idle, Data) ->
    {next_state, running, Data}.
`;
  const tmpFile = path.join(os.tmpdir(), 'gen-statem-erl-lazy-' + Date.now() + '.erl');
  fs.writeFileSync(tmpFile, src, 'utf8');
  try {
    const ir = extract(tmpFile);
    const tick = ir.transitions.find(t => t.event === 'tick');
    assert.strictEqual(tick, undefined, 'tick keeps state and must not be a transition');
    const go = ir.transitions.find(t => t.event === 'go');
    assert.ok(go, 'real go->running transition must be captured');
    assert.strictEqual(go.fromState, 'idle');
    assert.strictEqual(go.target, 'running');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract rejects a non-string path with a clean error, not ERR_INVALID_ARG_TYPE', () => {
  assert.throws(
    () => extract(null),
    (err) => {
      assert.notStrictEqual(err.code, 'ERR_INVALID_ARG_TYPE', 'should not leak raw path.resolve TypeError');
      assert.match(String(err.message), /path/i);
      return true;
    }
  );
});

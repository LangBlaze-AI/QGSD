#!/usr/bin/env node
'use strict';
// bin/adapters/spring-statemachine.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { id, detect, extract } = require('./spring-statemachine.cjs');

const fixture = `
import org.springframework.statemachine.config.EnableStateMachine;
import org.springframework.statemachine.config.StateMachineConfigurerAdapter;

@Configuration
@EnableStateMachine
public class OrderStateMachineConfig extends StateMachineConfigurerAdapter<States, Events> {

    @Override
    public void configure(StateMachineStateConfigurer<States, Events> states) throws Exception {
        states
            .withStates()
            .initial(States.PENDING)
            .state(States.CONFIRMED)
            .state(States.SHIPPED)
            .end(States.DELIVERED);
    }

    @Override
    public void configure(StateMachineTransitionConfigurer<States, Events> transitions) throws Exception {
        transitions
            .withExternal()
            .source(States.PENDING).target(States.CONFIRMED).event(Events.CONFIRM)
            .and()
            .withExternal()
            .source(States.CONFIRMED).target(States.SHIPPED).event(Events.SHIP)
            .and()
            .withExternal()
            .source(States.SHIPPED).target(States.DELIVERED).event(Events.DELIVER);
    }
}
`;

test('adapter id is spring-statemachine', () => {
  assert.strictEqual(id, 'spring-statemachine');
});

test('detect returns high confidence for Spring Statemachine code', () => {
  assert.ok(detect('OrderStateMachineConfig.java', fixture) >= 90);
});

test('detect returns 0 for unrelated Java code', () => {
  assert.strictEqual(detect('App.java', 'import java.util.List;'), 0);
});

test('extract parses Spring Statemachine fixture', () => {
  const tmpFile = path.join(os.tmpdir(), 'spring-sm-test-' + Date.now() + '.java');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.framework, 'spring-statemachine');
    assert.strictEqual(ir.initial, 'PENDING');
    assert.strictEqual(ir.stateNames.length, 4);
    assert.strictEqual(ir.transitions.length, 3);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract throws a clean error for a directory path (not raw EISDIR)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spring-sm-dir-'));
  try {
    assert.throws(
      () => extract(dir),
      (err) => {
        assert.notStrictEqual(err.code, 'EISDIR', 'should not leak raw EISDIR');
        assert.ok(/not a file|file not found/i.test(err.message));
        return true;
      }
    );
  } finally {
    fs.rmdirSync(dir);
  }
});

test('extract throws a clean error for a non-string filePath', () => {
  for (const bad of [undefined, null, 123]) {
    assert.throws(
      () => extract(bad),
      (err) => {
        assert.notStrictEqual(err.code, 'ERR_INVALID_ARG_TYPE', 'should not leak raw ERR_INVALID_ARG_TYPE');
        assert.ok(/filePath|file path|expected.*string/i.test(err.message));
        return true;
      }
    );
  }
});

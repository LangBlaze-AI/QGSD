#!/usr/bin/env node
'use strict';
// bin/adapters/sismic.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { id, detect, extract } = require('./sismic.cjs');

const fixture = `
statechart:
  name: traffic
  root:
    name: root
    initial: green
    states:
      - name: green
        transitions:
          - event: timer
            target: yellow
      - name: yellow
        transitions:
          - event: timer
            target: red
      - name: red
        transitions:
          - event: timer
            target: green
`;

test('adapter id is sismic', () => {
  assert.strictEqual(id, 'sismic');
});

test('detect returns high confidence for sismic YAML', () => {
  assert.ok(detect('traffic.yaml', fixture) >= 85);
});

test('detect returns 0 for plain text', () => {
  assert.strictEqual(detect('readme.txt', 'hello world'), 0);
});

test('extract parses sismic YAML fixture', () => {
  const tmpFile = path.join(os.tmpdir(), 'sismic-test-' + Date.now() + '.yaml');
  fs.writeFileSync(tmpFile, fixture, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.framework, 'sismic');
    assert.strictEqual(ir.initial, 'green');
    assert.strictEqual(ir.stateNames.length, 3);
    assert.strictEqual(ir.transitions.length, 3);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract skips a null transition list entry instead of crashing', () => {
  const malformed = `
statechart:
  name: t
  root:
    name: root
    initial: green
    states:
      - name: green
        transitions:
          -
          - event: timer
            target: yellow
      - name: yellow
`;
  const tmpFile = path.join(os.tmpdir(), 'sismic-null-tx-' + Date.now() + '.yaml');
  fs.writeFileSync(tmpFile, malformed, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.transitions.length, 1);
    assert.strictEqual(ir.transitions[0].target, 'yellow');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract ignores a non-object (string) transition entry', () => {
  const malformed = `
statechart:
  name: t
  root:
    name: root
    initial: green
    states:
      - name: green
        transitions:
          - justastring
`;
  const tmpFile = path.join(os.tmpdir(), 'sismic-str-tx-' + Date.now() + '.yaml');
  fs.writeFileSync(tmpFile, malformed, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.strictEqual(ir.transitions.length, 0);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('extract does not infinite-recurse on cyclic YAML anchors', () => {
  const cyclic = `
statechart:
  name: t
  root:
    name: root
    initial: a
    states: &s
      - name: a
        states: *s
`;
  const tmpFile = path.join(os.tmpdir(), 'sismic-cyclic-' + Date.now() + '.yaml');
  fs.writeFileSync(tmpFile, cyclic, 'utf8');
  try {
    const ir = extract(tmpFile);
    assert.ok(ir.stateNames.includes('a'));
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

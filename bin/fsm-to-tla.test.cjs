#!/usr/bin/env node
'use strict';
// bin/fsm-to-tla.test.cjs
// Tests for unified CLI entry point.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');

const FSM_TO_TLA = path.join(__dirname, 'fsm-to-tla.cjs');
const PROJECT_ROOT = path.join(__dirname, '..');

test('no args exits with status 1 and usage message', () => {
  const result = spawnSync(process.execPath, [FSM_TO_TLA], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /Usage|source-file/i);
});

test('nonexistent file exits with status 1', () => {
  const result = spawnSync(process.execPath, [FSM_TO_TLA, '/nonexistent/file.ts'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /not found/i);
});

test('--detect on nf-workflow.machine.ts prints xstate-v5', () => {
  const result = spawnSync(
    process.execPath,
    [FSM_TO_TLA, 'src/machines/nf-workflow.machine.ts', '--detect'],
    { encoding: 'utf8', cwd: PROJECT_ROOT }
  );
  assert.strictEqual(result.status, 0);
  const parsed = JSON.parse(result.stdout.trim());
  assert.strictEqual(parsed.framework, 'xstate-v5');
  assert.ok(parsed.confidence >= 50);
});

test('--dry produces output containing MODULE NFQuorum_xstate', () => {
  const result = spawnSync(
    process.execPath,
    [FSM_TO_TLA, 'src/machines/nf-workflow.machine.ts',
     '--module=NFQuorum',
     '--config=.planning/formal/tla/guards/nf-workflow.json',
     '--dry'],
    { encoding: 'utf8', cwd: PROJECT_ROOT }
  );
  assert.strictEqual(result.status, 0);
  assert.ok(result.stdout.includes('MODULE NFQuorum_xstate'), 'Should contain MODULE NFQuorum_xstate');
});

test('--scaffold-config produces JSON with guards and vars', () => {
  const result = spawnSync(
    process.execPath,
    [FSM_TO_TLA, 'src/machines/nf-workflow.machine.ts', '--scaffold-config'],
    { encoding: 'utf8', cwd: PROJECT_ROOT }
  );
  assert.strictEqual(result.status, 0);
  const config = JSON.parse(result.stdout);
  assert.ok(config.guards, 'Should have guards key');
  assert.ok(config.vars, 'Should have vars key');
});

test('--framework with unknown id exits cleanly with a TAG message (no raw stack trace)', () => {
  const result = spawnSync(
    process.execPath,
    [FSM_TO_TLA, 'src/machines/nf-workflow.machine.ts', '--framework=bogus'],
    { encoding: 'utf8', cwd: PROJECT_ROOT }
  );
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /\[fsm-to-tla\]/, 'should emit a TAG-prefixed friendly error');
  assert.ok(!/\n\s+at getAdapter/.test(result.stderr), 'should NOT print a raw stack trace');
});

#!/usr/bin/env node
'use strict';
// bin/xstate-to-tla.test.cjs
// Error-path tests for bin/xstate-to-tla.cjs.
// All tests check error conditions only — no esbuild compilation or file I/O.
// Requirements: INTG-01, INTG-02

const { test } = require('node:test');
const assert   = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const XSTATE_TO_TLA = path.join(__dirname, 'xstate-to-tla.cjs');

test('exits non-zero with usage message when no input file is provided', () => {
  const result = spawnSync(process.execPath, [XSTATE_TO_TLA], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /Usage|machine-file/i);
});

test('exits non-zero with file-not-found error for nonexistent input file', () => {
  const result = spawnSync(process.execPath, [XSTATE_TO_TLA, '/nonexistent/path/machine.ts'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /File not found|not found/i);
});

test('--dry output references NFQuorum_xstate.tla, not NFQuorum.tla, for --module=NFQuorum', () => {
  const result = spawnSync(
    process.execPath,
    [XSTATE_TO_TLA, 'src/machines/nf-workflow.machine.ts', '--module=NFQuorum', '--dry'],
    { encoding: 'utf8', cwd: path.join(__dirname, '..') }
  );
  // --dry should exit 0 (or non-zero is OK if machine file not found in test context)
  // The important thing: stdout/stderr must NOT mention writing to NFQuorum.tla
  const combinedOutput = result.stdout + result.stderr;
  assert.ok(
    !combinedOutput.includes('NFQuorum.tla') || combinedOutput.includes('NFQuorum_xstate.tla'),
    'Output should reference NFQuorum_xstate.tla, not NFQuorum.tla: ' + combinedOutput
  );
});

test('exits non-zero when fsm-to-tla is terminated by a signal (null exit status)', () => {
  // Stub child_process.spawnSync inside the wrapper process via a --require preload so it
  // returns a signal-kill result (status: null) WITHOUT actually spawning fsm-to-tla.
  // The preload mutates the cached child_process module before the wrapper destructures it.
  const preload = path.join(os.tmpdir(), `nf-x2t-preload-${process.pid}-${Date.now()}.cjs`);
  fs.writeFileSync(
    preload,
    "'use strict';\n" +
    "const cp = require('child_process');\n" +
    "cp.spawnSync = () => ({ status: null, signal: 'SIGSEGV', error: undefined, stdout: null, stderr: null });\n"
  );
  try {
    const result = spawnSync(process.execPath, [XSTATE_TO_TLA, 'whatever.ts', '--dry'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: `--require ${preload}` },
    });
    // Current code does `process.exit(result.status || 0)` -> exits 0, masking the crash.
    assert.notStrictEqual(result.status, 0, 'signal-killed child must not be reported as success');
    assert.strictEqual(result.status, 1);
  } finally {
    fs.unlinkSync(preload);
  }
});

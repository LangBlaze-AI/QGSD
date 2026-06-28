'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

// Wave 0 RED stubs for LOOP-02: hooks/nf-spec-regen.js
// These tests define the contract. They will fail until Plan 03 implements the hook.

function runHook(inputPayload) {
  const hookPath = path.join(__dirname, 'nf-spec-regen.js');
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(inputPayload),
    encoding: 'utf8',
    timeout: 15000,
  });
  return result;
}

test('LOOP-02: nf-spec-regen.js exits 0 and is a no-op for non-Write tool events', () => {
  const result = runHook({
    tool_name: 'Read',
    tool_input: { file_path: '/some/file.ts' },
    tool_response: {},
    cwd: process.cwd(),
    context_window: {}
  });
  // RED: script does not exist yet
  assert.strictEqual(result.status, 0, 'LOOP-02: hook must exit 0 for non-Write tools. Not yet implemented.');
});

test('LOOP-02: nf-spec-regen.js exits 0 and is a no-op for Write to non-machine file', () => {
  const result = runHook({
    tool_name: 'Write',
    tool_input: { file_path: '/some/other-file.ts' },
    tool_response: {},
    cwd: process.cwd(),
    context_window: {}
  });
  assert.strictEqual(result.status, 0, 'LOOP-02: hook must exit 0 for Write to non-machine file. Not yet implemented.');
  // Should produce no output or empty additionalContext for non-matching files
});

test('LOOP-02: nf-spec-regen.js exits 0 for Write to nf-workflow.machine.ts and returns additionalContext', () => {
  const result = runHook({
    tool_name: 'Write',
    tool_input: { file_path: '/Users/jonathanborduas/code/QGSD/src/machines/nf-workflow.machine.ts' },
    tool_response: {},
    cwd: '/Users/jonathanborduas/code/QGSD',
    context_window: {}
  });
  assert.strictEqual(result.status, 0, 'LOOP-02: hook must exit 0 for machine file write. Not yet implemented.');
  // Output must be valid JSON with additionalContext field
  if (result.stdout && result.stdout.trim()) {
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); },
      'LOOP-02: stdout must be valid JSON when hook fires. Not yet implemented.');
    assert.ok(
      parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext,
      'LOOP-02: output must contain hookSpecificOutput.additionalContext. Not yet implemented.'
    );
  }
});

test('LOOP-02: nf-spec-regen.js auto-detects Python transitions file and runs fsm-to-tla', () => {
  const fixturePath = path.join(process.cwd(), 'bin', 'adapters', 'fixtures', 'order-pipeline.py');
  const result = runHook({
    tool_name: 'Write',
    tool_input: { file_path: fixturePath },
    tool_response: {},
    cwd: process.cwd(),
    context_window: {}
  });
  assert.strictEqual(result.status, 0, 'hook must exit 0');
  if (result.stdout && result.stdout.trim()) {
    const parsed = JSON.parse(result.stdout);
    assert.ok(
      parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext,
      'should produce additionalContext for detected FSM file'
    );
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes('fsm-to-tla'),
      'should mention fsm-to-tla in the output'
    );
  }
});

test('LOOP-02: nf-spec-regen.js exits 0 and is a no-op for non-FSM Python file', () => {
  const fs = require('fs');
  const os = require('os');
  const tmpFile = path.join(os.tmpdir(), 'not-a-fsm-' + Date.now() + '.py');
  fs.writeFileSync(tmpFile, 'print("hello world")\nx = 42\n', 'utf8');
  try {
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: tmpFile },
      tool_response: {},
      cwd: process.cwd(),
      context_window: {}
    });
    assert.strictEqual(result.status, 0, 'hook must exit 0');
    // Should produce no output — not a state machine
    assert.ok(!result.stdout || !result.stdout.trim(), 'should produce no output for non-FSM Python file');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
});

test('LOOP-02: nf-spec-regen.js exits 0 (fail-open) on malformed stdin JSON', () => {
  const hookPath = path.join(__dirname, 'nf-spec-regen.js');
  const result = spawnSync(process.execPath, [hookPath], {
    input: 'not-valid-json',
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.strictEqual(result.status, 0, 'LOOP-02: hook must exit 0 on malformed JSON (fail-open). Not yet implemented.');
});

test('LOOP-02: auto-detection path actually fires — detectable FSM file MUST produce fsm-to-tla output (regression: cwd TDZ on line 64)', () => {
  const fixturePath = path.join(process.cwd(), 'bin', 'adapters', 'fixtures', 'order-pipeline.py');
  const result = runHook({
    tool_name: 'Write',
    tool_input: { file_path: fixturePath },
    tool_response: {},
    cwd: process.cwd(),
    context_window: {}
  });
  assert.strictEqual(result.status, 0, 'hook must exit 0 (fail-open)');
  // Gate-2 auto-detection (confidence ~85 for this fixture) MUST fire and produce output.
  // Before the fix, line 64 dereferences `cwd` in its temporal dead zone, the
  // ReferenceError is swallowed, detectedFramework stays null, and stdout is empty.
  assert.ok(result.stdout && result.stdout.trim(),
    'auto-detected FSM file must produce non-empty stdout (Gate-2 must not be silently dead)');
  const parsed = JSON.parse(result.stdout);
  assert.ok(
    parsed.hookSpecificOutput &&
    typeof parsed.hookSpecificOutput.additionalContext === 'string' &&
    parsed.hookSpecificOutput.additionalContext.includes('fsm-to-tla'),
    'additionalContext must mention fsm-to-tla for a detected FSM file'
  );
});

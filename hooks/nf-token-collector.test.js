#!/usr/bin/env node
// Test suite for hooks/nf-token-collector.js
// Uses Node.js built-in test runner: node --test hooks/nf-token-collector.test.js
//
// Each test spawns the hook as a child process with a mock stdin JSON payload,
// writes fixture JSONL transcript to an isolated tmpdir, asserts stdout/exitCode/file output.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK_PATH = path.join(__dirname, 'nf-token-collector.js');

// Helper: create isolated tmpdir per test
function makeTmpDir() {
  return path.join(os.tmpdir(), 'nf-tc-' + Date.now() + '-' + Math.random().toString(36).slice(2));
}

// Helper: run the hook with a given stdin JSON payload, using tmpDir as cwd
function runHook(stdinPayload, tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const result = spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify(stdinPayload),
    cwd: tmpDir,
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
  };
}

// Helper: read token-usage.jsonl from tmpDir
function readTokenLog(tmpDir) {
  const logPath = path.join(tmpDir, '.planning', 'telemetry', 'token-usage.jsonl');
  if (!fs.existsSync(logPath)) return null;
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim());
  return lines.map(l => JSON.parse(l));
}

// Helper: write a fixture transcript to tmpDir
function writeTranscript(tmpDir, entries) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(transcriptPath, content, 'utf8');
  return transcriptPath;
}

test('normal case: appends correct record to token-usage.jsonl', () => {
  const tmpDir = makeTmpDir();
  const transcriptPath = writeTranscript(tmpDir, [
    {
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 200,
        },
      },
      isSidechain: true,
      isApiErrorMessage: false,
    },
  ]);

  const payload = {
    hook_event_name: 'SubagentStop',
    agent_type: 'nf-quorum-slot-worker',
    session_id: 'sess1',
    agent_id: 'agent1',
    agent_transcript_path: transcriptPath,
    last_assistant_message: 'slot: claude-1\nvote: APPROVE\nrationale: looks good',
  };

  const { exitCode } = runHook(payload, tmpDir);
  assert.equal(exitCode, 0);

  const records = readTokenLog(tmpDir);
  assert.ok(records && records.length === 1, 'Expected exactly 1 record');
  assert.equal(records[0].slot, 'claude-1');
  assert.equal(records[0].input_tokens, 100);
  assert.equal(records[0].output_tokens, 25);
  assert.equal(records[0].cache_creation_input_tokens, 5000);
  assert.equal(records[0].cache_read_input_tokens, 200);
  assert.equal(records[0].session_id, 'sess1');
  assert.equal(records[0].agent_id, 'agent1');
});

test('isSidechain entries are included (subagent transcripts are all sidechain)', () => {
  const tmpDir = makeTmpDir();
  const transcriptPath = writeTranscript(tmpDir, [
    {
      type: 'assistant',
      message: { usage: { input_tokens: 999, output_tokens: 999 } },
      isSidechain: true,
      isApiErrorMessage: false,
    },
    {
      type: 'assistant',
      message: { usage: { input_tokens: 50, output_tokens: 10 } },
      isSidechain: true,
      isApiErrorMessage: false,
    },
  ]);

  const payload = {
    hook_event_name: 'SubagentStop',
    agent_type: 'nf-quorum-slot-worker',
    session_id: 's1',
    agent_id: 'a1',
    agent_transcript_path: transcriptPath,
    last_assistant_message: 'slot: claude-1\nvote: APPROVE',
  };

  const { exitCode } = runHook(payload, tmpDir);
  assert.equal(exitCode, 0);

  const records = readTokenLog(tmpDir);
  assert.ok(records && records.length === 1);
  // Both sidechain entries count: 999+50=1049 input, 999+10=1009 output
  assert.equal(records[0].input_tokens, 1049);
  assert.equal(records[0].output_tokens, 1009);
});

test('isApiErrorMessage entries are excluded', () => {
  const tmpDir = makeTmpDir();
  const transcriptPath = writeTranscript(tmpDir, [
    {
      type: 'assistant',
      message: { usage: { input_tokens: 500, output_tokens: 100 } },
      isSidechain: true,
      isApiErrorMessage: true,
    },
  ]);

  const payload = {
    hook_event_name: 'SubagentStop',
    agent_type: 'nf-quorum-slot-worker',
    session_id: 's1',
    agent_id: 'a1',
    agent_transcript_path: transcriptPath,
    last_assistant_message: 'slot: claude-2\nvote: APPROVE',
  };

  const { exitCode } = runHook(payload, tmpDir);
  assert.equal(exitCode, 0);

  const records = readTokenLog(tmpDir);
  assert.ok(records && records.length === 1);
  // Error entries excluded → 0 tokens summed
  assert.equal(records[0].input_tokens, 0);
  assert.equal(records[0].output_tokens, 0);
});

test('null transcript path: exits 0 and writes null record', () => {
  const tmpDir = makeTmpDir();

  const payload = {
    hook_event_name: 'SubagentStop',
    agent_type: 'nf-quorum-slot-worker',
    session_id: 's1',
    agent_id: 'a1',
    agent_transcript_path: null,
    last_assistant_message: 'slot: claude-1\nvote: APPROVE',
  };

  const { exitCode } = runHook(payload, tmpDir);
  assert.equal(exitCode, 0);

  const records = readTokenLog(tmpDir);
  assert.ok(records && records.length === 1, 'Expected 1 null record');
  assert.equal(records[0].input_tokens, null);
  assert.equal(records[0].output_tokens, null);
});

test('non-nf agent type: exits 0, no file written', () => {
  const tmpDir = makeTmpDir();

  const payload = {
    hook_event_name: 'SubagentStop',
    agent_type: 'other',
    session_id: 's1',
    agent_id: 'a1',
    agent_transcript_path: null,
    last_assistant_message: 'hello',
  };

  const { exitCode } = runHook(payload, tmpDir);
  assert.equal(exitCode, 0);

  const records = readTokenLog(tmpDir);
  assert.equal(records, null, 'No file should be written for non-nf agents');
});

test('slot resolution: fallback to last_assistant_message when no correlation file', () => {
  const tmpDir = makeTmpDir();
  const transcriptPath = writeTranscript(tmpDir, [
    {
      type: 'assistant',
      message: { usage: { input_tokens: 75, output_tokens: 15 } },
      isSidechain: true,
      isApiErrorMessage: false,
    },
  ]);

  const payload = {
    hook_event_name: 'SubagentStop',
    agent_type: 'nf-quorum-slot-worker',
    session_id: 's1',
    agent_id: 'a2',
    agent_transcript_path: transcriptPath,
    last_assistant_message: 'slot: gemini-1\nvote: APPROVE\nrationale: good',
  };

  const { exitCode } = runHook(payload, tmpDir);
  assert.equal(exitCode, 0);

  const records = readTokenLog(tmpDir);
  assert.ok(records && records.length === 1);
  assert.equal(records[0].slot, 'gemini-1');
});

test('slot resolution: correlation file exists with slot: null, falls back to last_assistant_message', () => {
  const tmpDir = makeTmpDir();
  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });

  // Write a correlation file with slot: null
  const corrFile = path.join(planningDir, 'quorum-slot-corr-a1.json');
  fs.writeFileSync(corrFile, JSON.stringify({ agent_id: 'a1', slot: null, ts: new Date().toISOString() }), 'utf8');

  const transcriptPath = writeTranscript(tmpDir, [
    {
      type: 'assistant',
      message: { usage: { input_tokens: 200, output_tokens: 40 } },
      isSidechain: true,
      isApiErrorMessage: false,
    },
  ]);

  const payload = {
    hook_event_name: 'SubagentStop',
    agent_type: 'nf-quorum-slot-worker',
    session_id: 's1',
    agent_id: 'a1',
    agent_transcript_path: transcriptPath,
    last_assistant_message: 'slot: claude-2\nvote: APPROVE',
  };

  const { exitCode } = runHook(payload, tmpDir);
  assert.equal(exitCode, 0);

  // Correlation file should be deleted after reading
  assert.equal(fs.existsSync(corrFile), false, 'Correlation file should be deleted after reading');

  const records = readTokenLog(tmpDir);
  assert.ok(records && records.length === 1);
  // slot: null in corr file → fallback to last_assistant_message → claude-2
  assert.equal(records[0].slot, 'claude-2');
});

test('slot resolution: falls back to transcript user message when last_assistant_message has no slot prefix', () => {
  const tmpDir = makeTmpDir();
  const transcriptPath = writeTranscript(tmpDir, [
    {
      type: 'user',
      message: { role: 'user', content: 'slot: opencode-1\nquestion: What is 2+2?' },
      isSidechain: true,
    },
    {
      type: 'assistant',
      message: { usage: { input_tokens: 50, output_tokens: 10 } },
      isSidechain: true,
      isApiErrorMessage: false,
    },
  ]);

  const payload = {
    hook_event_name: 'SubagentStop',
    agent_type: 'nf-quorum-slot-worker',
    session_id: 's1',
    agent_id: 'a3',
    agent_transcript_path: transcriptPath,
    last_assistant_message: 'Four',
  };

  const { exitCode } = runHook(payload, tmpDir);
  assert.equal(exitCode, 0);

  const records = readTokenLog(tmpDir);
  assert.ok(records && records.length === 1);
  // last_assistant_message has no slot prefix → falls back to transcript user message
  assert.equal(records[0].slot, 'opencode-1');
  assert.equal(records[0].input_tokens, 50);
});

test('non-string last_assistant_message: still writes record with valid token sums', () => {
  const tmpDir = makeTmpDir();
  const transcriptPath = writeTranscript(tmpDir, [
    {
      type: 'assistant',
      message: { usage: { input_tokens: 50, output_tokens: 10 } },
      isSidechain: true,
      isApiErrorMessage: false,
    },
  ]);

  const payload = {
    hook_event_name: 'SubagentStop',
    agent_type: 'nf-quorum-slot-worker',
    session_id: 's1',
    agent_id: 'a1',
    agent_transcript_path: transcriptPath,
    last_assistant_message: 42, // non-string: resolveSlot must not throw and drop the record
  };

  const { exitCode } = runHook(payload, tmpDir);
  assert.equal(exitCode, 0);

  const records = readTokenLog(tmpDir);
  assert.ok(records && records.length === 1, 'Record must still be written despite non-string last_assistant_message');
  assert.equal(records[0].input_tokens, 50);
  assert.equal(records[0].output_tokens, 10);
  assert.equal(records[0].slot, 'a1'); // falls back to agent_id
});

test('slot resolution: transcript user content as array (real Claude format) is parsed', () => {
  const tmpDir = makeTmpDir();
  const transcriptPath = writeTranscript(tmpDir, [
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'slot: codex-1\nquestion: hi' }] },
      isSidechain: true,
    },
    {
      type: 'assistant',
      message: { usage: { input_tokens: 50, output_tokens: 10 } },
      isSidechain: true,
      isApiErrorMessage: false,
    },
  ]);

  const payload = {
    hook_event_name: 'SubagentStop',
    agent_type: 'nf-quorum-slot-worker',
    session_id: 's1',
    agent_id: 'a-xyz',
    agent_transcript_path: transcriptPath,
    last_assistant_message: 'Four', // no slot prefix -> forces transcript fallback
  };

  const { exitCode } = runHook(payload, tmpDir);
  assert.equal(exitCode, 0);

  const records = readTokenLog(tmpDir);
  assert.ok(records && records.length === 1);
  assert.equal(records[0].slot, 'codex-1'); // currently 'a-xyz' (array .match throws -> agent_id fallback)
});

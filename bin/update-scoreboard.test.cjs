#!/usr/bin/env node
'use strict';
// Test suite for bin/update-scoreboard.cjs
// Uses Node.js built-in test runner: node --test bin/update-scoreboard.test.cjs
//
// Tests spawn the CLI as a subprocess to avoid process.exit() contaminating the runner.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCOREBOARD_PATH = path.join(__dirname, '..', 'bin', 'update-scoreboard.cjs');

// Helper: spawn the update-scoreboard CLI with given args
function runCLI(args, extraEnv) {
  const result = spawnSync('node', [SCOREBOARD_PATH, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
  };
}

// Helper: generate a unique temp scoreboard path
function tmpScoreboard() {
  return path.join(os.tmpdir(), 'nf-sb-test-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
}

// Helper: safe cleanup — wraps unlinkSync in try/catch
function cleanup(filePath) {
  try { fs.unlinkSync(filePath); } catch (_) {}
}

// SC-TC1: missing required args → exits 1 and writes USAGE to stderr
test('SC-TC1: missing required args exits 1 with --model is required in stderr', () => {
  const { stderr, exitCode } = runCLI([]);
  assert.strictEqual(exitCode, 1, 'exit code must be 1 for missing args');
  assert.ok(stderr.includes('--model is required'), 'stderr must include "--model is required"');
});

// SC-TC2: valid round vote creates scoreboard file and prints confirmation
test('SC-TC2: valid round vote creates scoreboard file and prints confirmation', () => {
  const sb = tmpScoreboard();
  try {
    const { stdout, exitCode } = runCLI([
      '--model', 'claude',
      '--result', 'TP',
      '--task', 'quick-53',
      '--round', '1',
      '--verdict', 'APPROVE',
      '--scoreboard', sb,
    ]);
    assert.strictEqual(exitCode, 0, 'exit code must be 0 for valid vote');
    assert.ok(fs.existsSync(sb), 'scoreboard file must be created');
    assert.ok(stdout.includes('[update-scoreboard]'), 'stdout must contain [update-scoreboard] prefix');
    assert.ok(stdout.includes('claude'), 'stdout must mention the model name');
    assert.ok(stdout.includes('TP'), 'stdout must mention the result code');
  } finally {
    cleanup(sb);
  }
});

// SC-TC3: TP result increments score by +1
test('SC-TC3: TP result increments score by +1', () => {
  const sb = tmpScoreboard();
  try {
    const { stdout, exitCode } = runCLI([
      '--model', 'claude',
      '--result', 'TP',
      '--task', 'quick-53',
      '--round', '1',
      '--verdict', 'APPROVE',
      '--scoreboard', sb,
    ]);
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.includes('score: 1'), 'stdout must show score: 1 after TP (+1)');
  } finally {
    cleanup(sb);
  }
});

// SC-TC4: TN result increments score by +5
test('SC-TC4: TN result increments score by +5', () => {
  const sb = tmpScoreboard();
  try {
    const { stdout, exitCode } = runCLI([
      '--model', 'gemini',
      '--result', 'TN',
      '--task', 'quick-53',
      '--round', '1',
      '--verdict', 'APPROVE',
      '--scoreboard', sb,
    ]);
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.includes('score: 5'), 'stdout must show score: 5 after TN (+5)');
  } finally {
    cleanup(sb);
  }
});

// SC-TC5: FP result decrements score by -3
test('SC-TC5: FP result decrements score by -3', () => {
  const sb = tmpScoreboard();
  try {
    const { stdout, exitCode } = runCLI([
      '--model', 'claude',
      '--result', 'FP',
      '--task', 'quick-53',
      '--round', '1',
      '--verdict', 'BLOCK',
      '--scoreboard', sb,
    ]);
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.includes('score: -3'), 'stdout must show score: -3 after FP (-3)');
  } finally {
    cleanup(sb);
  }
});

// SC-TC6: FN result decrements score by -1
test('SC-TC6: FN result decrements score by -1', () => {
  const sb = tmpScoreboard();
  try {
    const { stdout, exitCode } = runCLI([
      '--model', 'claude',
      '--result', 'FN',
      '--task', 'quick-53',
      '--round', '1',
      '--verdict', 'BLOCK',
      '--scoreboard', sb,
    ]);
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.includes('score: -1'), 'stdout must show score: -1 after FN (-1)');
  } finally {
    cleanup(sb);
  }
});

// SC-TC7: TP+ result increments score by +3
test('SC-TC7: TP+ result increments score by +3', () => {
  const sb = tmpScoreboard();
  try {
    const { stdout, exitCode } = runCLI([
      '--model', 'claude',
      '--result', 'TP+',
      '--task', 'quick-53',
      '--round', '1',
      '--verdict', 'APPROVE',
      '--scoreboard', sb,
    ]);
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    assert.ok(stdout.includes('score: 3'), 'stdout must show score: 3 after TP+ (+3)');
  } finally {
    cleanup(sb);
  }
});

// SC-TC8: second vote on same task+round updates existing entry (no duplicate round)
test('SC-TC8: second vote on same task+round updates existing entry (data.rounds.length === 1)', () => {
  const sb = tmpScoreboard();
  try {
    // First vote: claude on round 1
    runCLI(['--model', 'claude', '--result', 'TP', '--task', 'quick-53', '--round', '1', '--verdict', 'APPROVE', '--scoreboard', sb]);
    // Second vote: gemini on same task+round
    runCLI(['--model', 'gemini', '--result', 'TN', '--task', 'quick-53', '--round', '1', '--verdict', 'APPROVE', '--scoreboard', sb]);

    const data = JSON.parse(fs.readFileSync(sb, 'utf8'));
    assert.strictEqual(data.rounds.length, 1, 'rounds must have exactly 1 entry (no duplicate for same round)');
    // Both models should appear in the single round's votes
    assert.ok(data.rounds[0].votes.claude, 'claude vote must be in the round');
    assert.ok(data.rounds[0].votes.gemini, 'gemini vote must be in the round');
  } finally {
    cleanup(sb);
  }
});

// SC-TC9: second vote on different round appends new entry
test('SC-TC9: second vote on different round appends new entry (data.rounds.length === 2)', () => {
  const sb = tmpScoreboard();
  try {
    // Round 1 vote
    runCLI(['--model', 'claude', '--result', 'TP', '--task', 'quick-53', '--round', '1', '--verdict', 'APPROVE', '--scoreboard', sb]);
    // Round 2 vote (different round number)
    runCLI(['--model', 'claude', '--result', 'TN', '--task', 'quick-53', '--round', '2', '--verdict', 'APPROVE', '--scoreboard', sb]);

    const data = JSON.parse(fs.readFileSync(sb, 'utf8'));
    assert.strictEqual(data.rounds.length, 2, 'rounds must have 2 entries for 2 different rounds');
  } finally {
    cleanup(sb);
  }
});

// SC-TC10: recompute stats from scratch — cumulative score reflects all rounds
test('SC-TC10: cumulative score reflects all rounds after recompute (two TP = score 2)', () => {
  const sb = tmpScoreboard();
  try {
    // First TP vote for claude on round 1
    runCLI(['--model', 'claude', '--result', 'TP', '--task', 'quick-53', '--round', '1', '--verdict', 'APPROVE', '--scoreboard', sb]);
    // Second TP vote for claude on round 2
    runCLI(['--model', 'claude', '--result', 'TP', '--task', 'quick-53', '--round', '2', '--verdict', 'APPROVE', '--scoreboard', sb]);

    const data = JSON.parse(fs.readFileSync(sb, 'utf8'));
    assert.strictEqual(data.models.claude.score, 2, 'claude score must be 2 after two TP votes (+1 each)');
  } finally {
    cleanup(sb);
  }
});

// SC-TC11: invalid --model value → exits 1, stderr contains valid options list
test('SC-TC11: invalid --model value exits 1', () => {
  const { stderr, exitCode } = runCLI([
    '--model', 'notamodel',
    '--result', 'TP',
    '--task', 'quick-53',
    '--round', '1',
    '--verdict', 'APPROVE',
  ]);
  assert.strictEqual(exitCode, 1, 'exit code must be 1 for invalid model');
  assert.ok(
    stderr.includes('--model must be one of') || stderr.includes('notamodel'),
    'stderr must mention the invalid model constraint'
  );
});

// SC-TC12: invalid --result value → exits 1
test('SC-TC12: invalid --result value exits 1', () => {
  const { stderr, exitCode } = runCLI([
    '--model', 'claude',
    '--result', 'BADCODE',
    '--task', 'quick-53',
    '--round', '1',
    '--verdict', 'APPROVE',
  ]);
  assert.strictEqual(exitCode, 1, 'exit code must be 1 for invalid result code');
  assert.ok(
    stderr.includes('--result must be one of') || stderr.includes('BADCODE'),
    'stderr must mention the invalid result constraint'
  );
});

// SC-TC13: UNAVAIL result → score stays at 0 (score delta is 0), prints "UNAVAIL (0)"
test('SC-TC13: UNAVAIL result keeps score at 0 and prints UNAVAIL (0)', () => {
  const sb = tmpScoreboard();
  try {
    const { stdout, exitCode } = runCLI([
      '--model', 'codex',
      '--result', 'UNAVAIL',
      '--task', 'quick-53',
      '--round', '1',
      '--verdict', 'APPROVE',
      '--scoreboard', sb,
    ]);
    assert.strictEqual(exitCode, 0, 'exit code must be 0 for UNAVAIL result');
    // UNAVAIL delta is 0 — output format is "UNAVAIL (+0)" (sign is always shown)
    assert.ok(stdout.includes('UNAVAIL (+0)'), 'stdout must include "UNAVAIL (+0)"');
    assert.ok(stdout.includes('score: 0'), 'stdout must show score: 0 after UNAVAIL');
  } finally {
    cleanup(sb);
  }
});

// SC-TC14: init-team subcommand writes team fingerprint to scoreboard
test('SC-TC14: init-team writes fingerprint to scoreboard (16-char hex string)', () => {
  const sb = tmpScoreboard();
  // Point to a temp ~/.claude.json substitute to avoid reading production mcpServers
  const claudeJsonTmp = path.join(os.tmpdir(), 'nf-test-claude-' + Date.now() + '.json');
  fs.writeFileSync(claudeJsonTmp, JSON.stringify({ mcpServers: {} }), 'utf8');
  try {
    const { exitCode } = runCLI(
      [
        'init-team',
        '--claude-model', 'claude-opus-4-6',
        '--team', JSON.stringify({ gemini: 'gemini-2.0' }),
        '--scoreboard', sb,
      ],
      { NF_CLAUDE_JSON: claudeJsonTmp }
    );
    assert.strictEqual(exitCode, 0, 'exit code must be 0 for init-team');
    assert.ok(fs.existsSync(sb), 'scoreboard file must be created by init-team');
    const data = JSON.parse(fs.readFileSync(sb, 'utf8'));
    assert.ok(data.team, 'scoreboard must have a team field');
    assert.ok(data.team.fingerprint, 'team must have a fingerprint field');
    assert.match(data.team.fingerprint, /^[0-9a-f]{16}$/, 'fingerprint must be a 16-char hex string');
  } finally {
    cleanup(sb);
    cleanup(claudeJsonTmp);
  }
});

// SC-TC15: init-team idempotent — second call with same composition writes "no change"
test('SC-TC15: init-team is idempotent — second identical call outputs "no change"', () => {
  const sb = tmpScoreboard();
  const claudeJsonTmp = path.join(os.tmpdir(), 'nf-test-claude-' + Date.now() + '.json');
  fs.writeFileSync(claudeJsonTmp, JSON.stringify({ mcpServers: {} }), 'utf8');
  const args = [
    'init-team',
    '--claude-model', 'claude-opus-4-6',
    '--team', JSON.stringify({ gemini: 'gemini-2.0' }),
    '--scoreboard', sb,
  ];
  const env = { NF_CLAUDE_JSON: claudeJsonTmp };
  try {
    // First call: writes the fingerprint
    const first = runCLI(args, env);
    assert.strictEqual(first.exitCode, 0, 'first init-team must exit 0');

    // Second call with identical args: fingerprint unchanged → "no change"
    const second = runCLI(args, env);
    assert.strictEqual(second.exitCode, 0, 'second init-team must exit 0');
    assert.ok(second.stdout.includes('no change'), 'second call stdout must include "no change"');
  } finally {
    cleanup(sb);
    cleanup(claudeJsonTmp);
  }
});

// SC-TC-SLOT-1: --slot creates slots{} entry with composite key and model field (SCBD-01 + SCBD-02)
test('SC-TC-SLOT-1: --slot creates slots entry with composite key and model field', () => {
  const sb = tmpScoreboard();
  try {
    const { exitCode, stdout, stderr } = runCLI([
      '--slot', 'claude-1',
      '--model-id', 'deepseek-ai/DeepSeek-V3',
      '--result', 'TP',
      '--task', 'plan-ph40',
      '--round', '1',
      '--verdict', 'APPROVE',
      '--scoreboard', sb,
    ]);
    assert.strictEqual(exitCode, 0, 'exit code must be 0');
    const data = JSON.parse(fs.readFileSync(sb, 'utf8'));
    const key = 'claude-1:deepseek-ai/DeepSeek-V3';
    assert.ok(data.slots, 'slots map must exist');
    assert.ok(data.slots[key], 'composite key must exist in slots');
    assert.strictEqual(data.slots[key].slot, 'claude-1', 'slot field must match');
    assert.strictEqual(data.slots[key].model, 'deepseek-ai/DeepSeek-V3', 'model field must match (SCBD-02)');
    assert.strictEqual(data.slots[key].score, 1, 'TP adds 1 to score');
  } finally { cleanup(sb); }
});

// SC-TC-SLOT-2: second model on same slot creates new row, first preserved (SCBD-03)
test('SC-TC-SLOT-2: different model on same slot creates new row, first preserved (SCBD-03)', () => {
  const sb = tmpScoreboard();
  try {
    runCLI(['--slot', 'claude-1', '--model-id', 'deepseek-ai/DeepSeek-V3',
            '--result', 'TP', '--task', 'plan-ph40', '--round', '1',
            '--verdict', 'APPROVE', '--scoreboard', sb]);
    runCLI(['--slot', 'claude-1', '--model-id', 'Qwen/Qwen2.5-72B',
            '--result', 'TN', '--task', 'plan-ph40', '--round', '2',
            '--verdict', 'APPROVE', '--scoreboard', sb]);
    const data = JSON.parse(fs.readFileSync(sb, 'utf8'));
    assert.ok(data.slots['claude-1:deepseek-ai/DeepSeek-V3'], 'first model entry preserved');
    assert.ok(data.slots['claude-1:Qwen/Qwen2.5-72B'], 'second model entry created');
    assert.strictEqual(data.slots['claude-1:deepseek-ai/DeepSeek-V3'].score, 1, 'first entry score intact');
    assert.strictEqual(data.slots['claude-1:Qwen/Qwen2.5-72B'].score, 5, 'TN adds 5 to score');
  } finally { cleanup(sb); }
});

// SC-TC-SLOT-3: --slot and --model are mutually exclusive
test('SC-TC-SLOT-3: --slot and --model together exits 1 with mutual-exclusion error', () => {
  const sb = tmpScoreboard();
  try {
    const { exitCode, stderr } = runCLI([
      '--slot', 'claude-1', '--model', 'claude',
      '--model-id', 'deepseek-ai/DeepSeek-V3',
      '--result', 'TP', '--task', 'x', '--round', '1',
      '--verdict', 'APPROVE', '--scoreboard', sb,
    ]);
    assert.strictEqual(exitCode, 1, 'exit code must be 1');
    assert.ok(stderr.includes('mutually exclusive'), 'stderr must say mutually exclusive');
  } finally { cleanup(sb); }
});

// SC-TC-SLOT-4: --slot without --model-id exits 1
test('SC-TC-SLOT-4: --slot without --model-id exits 1', () => {
  const sb = tmpScoreboard();
  try {
    const { exitCode, stderr } = runCLI([
      '--slot', 'claude-1',
      '--result', 'TP', '--task', 'x', '--round', '1',
      '--verdict', 'APPROVE', '--scoreboard', sb,
    ]);
    assert.strictEqual(exitCode, 1, 'exit code must be 1');
    assert.ok(stderr.includes('--model-id is required'), 'stderr must mention --model-id');
  } finally { cleanup(sb); }
});

// SC-TC-ATOMIC-1: no .tmp file remains after a successful write
test('SC-TC-ATOMIC-1: no .tmp file remains on disk after successful write', () => {
  const sb = tmpScoreboard();
  try {
    const { exitCode } = runCLI([
      '--model', 'claude',
      '--result', 'TP',
      '--task', 'atomic-test',
      '--round', '1',
      '--verdict', 'APPROVE',
      '--scoreboard', sb,
    ]);
    assert.strictEqual(exitCode, 0);
    assert.ok(fs.existsSync(sb), 'scoreboard file must exist');
    // No .tmp file should remain
    const dir = path.dirname(sb);
    const base = path.basename(sb);
    const tmpFiles = fs.readdirSync(dir).filter(f => f.startsWith(base) && f.endsWith('.tmp'));
    assert.strictEqual(tmpFiles.length, 0, 'no .tmp files should remain after write');
  } finally {
    cleanup(sb);
  }
});

// SC-TC-ATOMIC-2: scoreboard is valid JSON immediately after write
test('SC-TC-ATOMIC-2: scoreboard is valid JSON after atomic write', () => {
  const sb = tmpScoreboard();
  try {
    const { exitCode } = runCLI([
      '--model', 'gemini',
      '--result', 'TN',
      '--task', 'atomic-json-test',
      '--round', '1',
      '--verdict', 'CONSENSUS',
      '--scoreboard', sb,
    ]);
    assert.strictEqual(exitCode, 0);
    const content = fs.readFileSync(sb, 'utf8');
    // Must parse without throwing
    const parsed = JSON.parse(content);
    assert.ok(parsed.rounds, 'scoreboard must have rounds array');
    assert.ok(Array.isArray(parsed.rounds), 'rounds must be an array');
  } finally {
    cleanup(sb);
  }
});

// SC-TC-MERGE-1: merge-wave with no matching files is a graceful no-op
test('SC-TC-MERGE-1: merge-wave with empty dir is a graceful no-op', () => {
  const sb = tmpScoreboard();
  const tmpDir = path.join(os.tmpdir(), 'nf-mw-test-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const { stdout, exitCode } = runCLI([
      'merge-wave',
      '--dir', tmpDir,
      '--task', 'mw-test',
      '--round', '1',
      '--scoreboard', sb,
    ]);
    assert.strictEqual(exitCode, 0, 'merge-wave with no files must exit 0');
    assert.ok(
      stdout.includes('no vote files found') || stdout.includes('does not exist'),
      'stdout must indicate no votes found'
    );
  } finally {
    cleanup(sb);
    fs.rmdirSync(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Invocations tracking (SC-TC-INV-*)
// ---------------------------------------------------------------------------

// SC-TC-INV-1: single TP vote → invocations = 1
test('SC-TC-INV-1: single TP vote sets invocations to 1', () => {
  const sb = tmpScoreboard();
  try {
    runCLI(['--model', 'claude', '--result', 'TP', '--task', 'inv-1', '--round', '1', '--verdict', 'APPROVE', '--scoreboard', sb]);
    const data = JSON.parse(fs.readFileSync(sb, 'utf8'));
    assert.strictEqual(data.models.claude.invocations, 1, 'invocations must be 1 after one TP vote');
  } finally { cleanup(sb); }
});

// SC-TC-INV-2: UNAVAIL vote → invocations stays 0
test('SC-TC-INV-2: UNAVAIL vote does not increment invocations', () => {
  const sb = tmpScoreboard();
  try {
    runCLI(['--model', 'codex', '--result', 'UNAVAIL', '--task', 'inv-2', '--round', '1', '--verdict', 'APPROVE', '--scoreboard', sb]);
    const data = JSON.parse(fs.readFileSync(sb, 'utf8'));
    assert.strictEqual(data.models.codex.invocations, 0, 'invocations must be 0 after UNAVAIL vote');
  } finally { cleanup(sb); }
});

// SC-TC-INV-3: two TP votes across rounds → invocations = 2
test('SC-TC-INV-3: invocations accumulates across rounds', () => {
  const sb = tmpScoreboard();
  try {
    runCLI(['--model', 'gemini', '--result', 'TP', '--task', 'inv-3', '--round', '1', '--verdict', 'APPROVE', '--scoreboard', sb]);
    runCLI(['--model', 'gemini', '--result', 'FP', '--task', 'inv-3', '--round', '2', '--verdict', 'BLOCK', '--scoreboard', sb]);
    const data = JSON.parse(fs.readFileSync(sb, 'utf8'));
    assert.strictEqual(data.models.gemini.invocations, 2, 'invocations must be 2 after two scored votes');
  } finally { cleanup(sb); }
});

// SC-TC-INV-4: slot mode TP vote → slot invocations = 1
test('SC-TC-INV-4: slot mode TP vote sets slot invocations to 1', () => {
  const sb = tmpScoreboard();
  try {
    runCLI(['--slot', 'claude-1', '--model-id', 'deepseek-ai/DeepSeek-V3', '--result', 'TP', '--task', 'inv-4', '--round', '1', '--verdict', 'APPROVE', '--scoreboard', sb]);
    const data = JSON.parse(fs.readFileSync(sb, 'utf8'));
    const key = 'claude-1:deepseek-ai/DeepSeek-V3';
    assert.strictEqual(data.slots[key].invocations, 1, 'slot invocations must be 1 after one TP vote');
  } finally { cleanup(sb); }
});

// SC-TC-INV-5: merge-wave computes invocations for merged votes
test('SC-TC-INV-5: merge-wave sets invocations on merged slot votes', () => {
  const sb = tmpScoreboard();
  const tmpDir = path.join(os.tmpdir(), 'nf-inv5-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const vote1 = { slot: 'claude-1', modelId: 'deepseek-ai/DeepSeek-V3', result: 'TP', verdict: 'APPROVE' };
    const vote2 = { slot: 'claude-2', modelId: 'qwen/Qwen2.5-72B', result: 'TN', verdict: 'APPROVE' };
    fs.writeFileSync(path.join(tmpDir, 'vote-claude-1-inv5-1-a.json'), JSON.stringify(vote1));
    fs.writeFileSync(path.join(tmpDir, 'vote-claude-2-inv5-1-b.json'), JSON.stringify(vote2));
    runCLI(['merge-wave', '--dir', tmpDir, '--task', 'inv5', '--round', '1', '--scoreboard', sb]);
    const data = JSON.parse(fs.readFileSync(sb, 'utf8'));
    assert.strictEqual(data.slots['claude-1:deepseek-ai/DeepSeek-V3'].invocations, 1, 'slot 1 invocations must be 1');
    assert.strictEqual(data.slots['claude-2:qwen/Qwen2.5-72B'].invocations, 1, 'slot 2 invocations must be 1');
  } finally {
    cleanup(sb);
    try { fs.readdirSync(tmpDir).forEach(f => fs.unlinkSync(path.join(tmpDir, f))); fs.rmdirSync(tmpDir); } catch (_) {}
  }
});

// SC-TC-MERGE-2: merge-wave applies N vote files in one transaction
test('SC-TC-MERGE-2: merge-wave applies multiple slot vote files in one transaction', () => {
  const sb = tmpScoreboard();
  const tmpDir = path.join(os.tmpdir(), 'nf-mw-votes-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    // Write two vote files simulating two worker outputs
    const vote1 = { slot: 'claude-1', modelId: 'deepseek-ai/DeepSeek-V3', result: 'TP', verdict: 'APPROVE' };
    const vote2 = { slot: 'claude-2', modelId: 'qwen/Qwen2.5-72B', result: 'TP', verdict: 'APPROVE' };
    fs.writeFileSync(path.join(tmpDir, `vote-claude-1-mw-task2-1-1001.json`), JSON.stringify(vote1));
    fs.writeFileSync(path.join(tmpDir, `vote-claude-2-mw-task2-1-1002.json`), JSON.stringify(vote2));

    const { stdout, exitCode } = runCLI([
      'merge-wave',
      '--dir', tmpDir,
      '--task', 'mw-task2',
      '--round', '1',
      '--scoreboard', sb,
    ]);
    assert.strictEqual(exitCode, 0, 'merge-wave must exit 0');
    assert.ok(stdout.includes('merged'), 'stdout must indicate votes were merged');

    // Scoreboard must be valid JSON with both votes
    const content = fs.readFileSync(sb, 'utf8');
    const parsed = JSON.parse(content);
    assert.ok(parsed.rounds.length >= 1, 'scoreboard must have at least one round');
    const round = parsed.rounds.find(r => r.task === 'mw-task2' && r.round === 1);
    assert.ok(round, 'round entry for mw-task2 R1 must exist');
    const voteKeys = Object.keys(round.votes);
    assert.ok(voteKeys.length >= 1, 'round must have at least one vote recorded');
  } finally {
    cleanup(sb);
    try {
      fs.readdirSync(tmpDir).forEach(f => fs.unlinkSync(path.join(tmpDir, f)));
      fs.rmdirSync(tmpDir);
    } catch (_) {}
  }
});

// Dogfood Batch 8: VALID_VERDICTS was declared but never enforced; the discuss/
// execute-phase call-sites passed a slot via --model (rejected) and a verdict via
// --result. These guard the validation contract.
test('SC-Batch8: an invalid --verdict is rejected (VALID_VERDICTS now enforced)', () => {
  const sb = tmpScoreboard();
  const { exitCode, stderr } = runCLI([
    '--model', 'gemini', '--result', '', '--task', 't', '--round', '1',
    '--verdict', 'TOTALLY_BOGUS', '--scoreboard', sb,
  ]);
  cleanup(sb);
  assert.strictEqual(exitCode, 1, 'a bogus verdict must be rejected, not silently accepted');
  assert.match(stderr, /--verdict must be one of/);
});

test('SC-Batch8: an MCP slot is recorded via --slot/--model-id (not --model)', () => {
  const sb = tmpScoreboard();
  const ok = runCLI([
    '--slot', 'gemini-1', '--model-id', 'google/gemini-3', '--result', '', '--task', 't',
    '--round', '1', '--verdict', 'APPROVE', '--scoreboard', sb,
  ]);
  // a slot passed via --model must be rejected (it is not a native family)
  const bad = runCLI([
    '--model', 'gemini-1', '--result', '', '--task', 't', '--round', '1',
    '--verdict', 'APPROVE', '--scoreboard', sb,
  ]);
  cleanup(sb);
  assert.strictEqual(ok.exitCode, 0, '--slot gemini-1 --model-id … must be accepted');
  assert.strictEqual(bad.exitCode, 1, 'a slot passed via --model must be rejected');
});

// Scan-guard: the discuss/execute-phase scoreboard snippets must not tell the agent
// to pass a slot via --model or a verdict via --result.
test('SC-Batch8: discuss/execute-phase snippets use --result "" and document --slot', () => {
  for (const rel of ['../core/workflows/discuss-phase.md', '../core/workflows/execute-phase.md']) {
    const md = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(!/--result <vote_code>/.test(md), `${rel}: must not pass a verdict as --result`);
    assert.ok(/--result ""/.test(md), `${rel}: gray-area vote should pass --result ""`);
    assert.ok(/--slot <slot> --model-id/.test(md), `${rel}: must document the --slot/--model-id form for MCP slots`);
  }
});

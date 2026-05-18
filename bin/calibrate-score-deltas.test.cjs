#!/usr/bin/env node
'use strict';
// Test suite for bin/calibrate-score-deltas.cjs
// Uses Node.js built-in test runner: node --test bin/calibrate-score-deltas.test.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CAL_SCRIPT = path.join(__dirname, 'calibrate-score-deltas.cjs');
const SB_SCRIPT = path.join(__dirname, 'update-scoreboard.cjs');

const { _pure, DEFAULT_SCORE_DELTAS } = require('./calibrate-score-deltas.cjs');
const { classifyRoundOutcome, tallyVoteTypeOutcomes, computeSignal, deriveCalibratedDeltas } = _pure;

function tmpPath() {
  return path.join(os.tmpdir(), 'nf-cal-test-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
}

function cleanup(filePath) {
  try { fs.unlinkSync(filePath); } catch (_) {}
}

function runCLI(args) {
  const result = spawnSync('node', [CAL_SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
  };
}

function runSB(args) {
  const result = spawnSync('node', [SB_SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
  };
}

// Helper: create a scoreboard with N rounds of known distribution
function makeScoreboard(n, config) {
  const rounds = [];
  for (let i = 0; i < n; i++) {
    const vote = config.vote || 'TP';
    const verdict = config.verdict || 'APPROVE';
    rounds.push({
      date: '01-01',
      task: `cal-test-${i}`,
      round: i + 1,
      votes: { 'claude-1:claude-model': vote },
      verdict,
    });
  }
  return { models: {}, slots: {}, rounds, categories: {} };
}

// ---------------------------------------------------------------------------
// classifyRoundOutcome tests
// ---------------------------------------------------------------------------

test('CAL-TC1: classifyRoundOutcome returns positive for APPROVE', () => {
  assert.strictEqual(classifyRoundOutcome({ verdict: 'APPROVE' }), 'positive');
});

test('CAL-TC2: classifyRoundOutcome returns positive for CONSENSUS', () => {
  assert.strictEqual(classifyRoundOutcome({ verdict: 'CONSENSUS' }), 'positive');
});

test('CAL-TC3: classifyRoundOutcome returns negative for BLOCK', () => {
  assert.strictEqual(classifyRoundOutcome({ verdict: 'BLOCK' }), 'negative');
});

test('CAL-TC4: classifyRoundOutcome returns negative for GAPS_FOUND', () => {
  assert.strictEqual(classifyRoundOutcome({ verdict: 'GAPS_FOUND' }), 'negative');
});

test('CAL-TC5: classifyRoundOutcome returns null for DELIBERATE', () => {
  assert.strictEqual(classifyRoundOutcome({ verdict: 'DELIBERATE' }), null);
});

test('CAL-TC5b: classifyRoundOutcome returns null for missing verdict', () => {
  assert.strictEqual(classifyRoundOutcome({}), null);
});

// ---------------------------------------------------------------------------
// tallyVoteTypeOutcomes tests
// ---------------------------------------------------------------------------

test('CAL-TC6: tallyVoteTypeOutcomes counts TP votes in positive rounds', () => {
  const rounds = [
    { verdict: 'APPROVE', votes: { a: 'TP', b: 'TP' } },
    { verdict: 'BLOCK', votes: { a: 'FP' } },
  ];
  const tallies = tallyVoteTypeOutcomes(rounds);
  assert.strictEqual(tallies.TP.positive, 2);
  assert.strictEqual(tallies.TP.negative, 0);
  assert.strictEqual(tallies.TP.total, 2);
  assert.strictEqual(tallies.FP.positive, 0);
  assert.strictEqual(tallies.FP.negative, 1);
  assert.strictEqual(tallies.FP.total, 1);
});

test('CAL-TC6b: tallyVoteTypeOutcomes skips UNAVAIL and empty votes', () => {
  const rounds = [
    { verdict: 'APPROVE', votes: { a: 'TP', b: 'UNAVAIL', c: '' } },
  ];
  const tallies = tallyVoteTypeOutcomes(rounds);
  assert.strictEqual(tallies.TP.total, 1);
  assert.strictEqual(tallies.TN.total, 0);
});

test('CAL-TC6c: tallyVoteTypeOutcomes maps TP+ to TP base type', () => {
  const rounds = [
    { verdict: 'APPROVE', votes: { a: 'TP+' } },
  ];
  const tallies = tallyVoteTypeOutcomes(rounds);
  assert.strictEqual(tallies.TP.positive, 1);
  assert.strictEqual(tallies.TP.total, 1);
});

test('CAL-TC6d: tallyVoteTypeOutcomes skips rounds with unclassifiable verdict', () => {
  const rounds = [
    { verdict: 'DELIBERATE', votes: { a: 'TP' } },
    { verdict: 'APPROVE', votes: { b: 'TN' } },
  ];
  const tallies = tallyVoteTypeOutcomes(rounds);
  assert.strictEqual(tallies.TP.total, 0); // DELIBERATE round excluded
  assert.strictEqual(tallies.TN.positive, 1);
});

// ---------------------------------------------------------------------------
// computeSignal tests
// ---------------------------------------------------------------------------

test('CAL-TC7: computeSignal returns positive signal for vote types correlating with positive outcomes', () => {
  const tallies = { TP: { positive: 40, negative: 5, total: 45 } };
  const signal = computeSignal(tallies, 0.5, 'TP', 5);
  assert.ok(signal > 0, `expected positive signal, got ${signal}`);
  // P(positive|TP) = 40/45 ≈ 0.889, overall = 0.5, signal ≈ 0.389
  assert.ok(Math.abs(signal - 0.3889) < 0.01, `signal ≈ 0.389, got ${signal}`);
});

test('CAL-TC8: computeSignal returns negative signal for vote types correlating with negative outcomes', () => {
  const tallies = { FP: { positive: 5, negative: 20, total: 25 } };
  const signal = computeSignal(tallies, 0.7, 'FP', 5);
  assert.ok(signal < 0, `expected negative signal, got ${signal}`);
});

test('CAL-TC9: computeSignal returns null when vote count < minVotes', () => {
  const tallies = { TN: { positive: 2, negative: 1, total: 3 } };
  const signal = computeSignal(tallies, 0.5, 'TN', 5);
  assert.strictEqual(signal, null);
});

// ---------------------------------------------------------------------------
// deriveCalibratedDeltas tests
// ---------------------------------------------------------------------------

test('CAL-TC10: deriveCalibratedDeltas falls back to defaults when rounds < minRounds', () => {
  const rounds = [
    { verdict: 'APPROVE', votes: { a: 'TP' } },
  ];
  const { deltas, metadata } = deriveCalibratedDeltas(rounds, DEFAULT_SCORE_DELTAS, { minRounds: 30 });
  assert.strictEqual(metadata.usedFallback, true);
  assert.deepStrictEqual(deltas.TP, DEFAULT_SCORE_DELTAS.TP);
  assert.deepStrictEqual(deltas.TN, DEFAULT_SCORE_DELTAS.TN);
});

test('CAL-TC11: deriveCalibratedDeltas produces valid deltas for synthetic 35-round dataset', () => {
  const rounds = [];
  // 25 APPROVE rounds with TP votes (TP correlates strongly with positive)
  for (let i = 0; i < 25; i++) {
    rounds.push({ verdict: 'APPROVE', votes: { a: 'TP' } });
  }
  // 5 BLOCK rounds with FP votes (FP correlates with negative)
  for (let i = 0; i < 5; i++) {
    rounds.push({ verdict: 'BLOCK', votes: { a: 'FP' } });
  }
  // 5 APPROVE rounds with TN votes (TN also positive but less common)
  for (let i = 0; i < 5; i++) {
    rounds.push({ verdict: 'APPROVE', votes: { b: 'TN' } });
  }

  const { deltas, metadata } = deriveCalibratedDeltas(rounds, DEFAULT_SCORE_DELTAS, { minRounds: 30, minVotes: 3 });
  assert.strictEqual(metadata.usedFallback, false);
  assert.ok(typeof deltas.TP === 'number');
  assert.ok(typeof deltas.TN === 'number');
  assert.ok(typeof deltas.FP === 'number');
  assert.ok(typeof deltas.FN === 'number');
  // TP should be positive (strongly correlates with positive outcomes)
  assert.ok(deltas.TP > 0, `TP delta should be positive, got ${deltas.TP}`);
  // FP should be negative (correlates with negative outcomes)
  assert.ok(deltas.FP < 0, `FP delta should be negative, got ${deltas.FP}`);
});

test('CAL-TC12: deriveCalibratedDeltas preserves UNAVAIL=0 and empty=0', () => {
  const rounds = [];
  for (let i = 0; i < 35; i++) {
    rounds.push({ verdict: 'APPROVE', votes: { a: 'TP' } });
  }
  const { deltas } = deriveCalibratedDeltas(rounds, DEFAULT_SCORE_DELTAS, { minRounds: 30 });
  assert.strictEqual(deltas.UNAVAIL, 0);
  assert.strictEqual(deltas[''], 0);
});

test('CAL-TC13: deriveCalibratedDeltas derives TP+ and TN+ from base deltas', () => {
  const rounds = [];
  for (let i = 0; i < 35; i++) {
    rounds.push({ verdict: 'APPROVE', votes: { a: 'TP' } });
  }
  const { deltas } = deriveCalibratedDeltas(rounds, DEFAULT_SCORE_DELTAS, { minRounds: 30 });
  assert.strictEqual(deltas['TP+'], deltas.TP + 2, 'TP+ should be TP delta + improvement bonus');
  assert.strictEqual(deltas['TN+'], deltas.TN + 2, 'TN+ should be TN delta + improvement bonus');
});

test('CAL-TC14: deriveCalibratedDeltas clamps extreme values to [-10, +10]', () => {
  // Create extreme data: all BLOCK rounds with TP votes (TP always in negative outcome)
  const rounds = [];
  for (let i = 0; i < 100; i++) {
    rounds.push({ verdict: 'BLOCK', votes: { a: 'TP' } });
  }
  const { deltas } = deriveCalibratedDeltas(rounds, DEFAULT_SCORE_DELTAS, { minRounds: 30, scaleFactor: 100 });
  assert.ok(deltas.TP >= -10, `TP delta must be >= -10, got ${deltas.TP}`);
  assert.ok(deltas.TP <= 10, `TP delta must be <= 10, got ${deltas.TP}`);
});

// ---------------------------------------------------------------------------
// Integration tests (CLI subprocess)
// ---------------------------------------------------------------------------

test('CAL-TC15: CLI exits 1 when no scoreboard file found', () => {
  const { exitCode, stderr } = runCLI(['--scoreboard', '/tmp/nonexistent-scoreboard-test-' + Date.now() + '.json']);
  assert.strictEqual(exitCode, 1);
  assert.ok(stderr.includes('no scoreboard'));
});

test('CAL-TC16: CLI writes calibrated-deltas.json with sufficient data', () => {
  const sbPath = tmpPath();
  const outPath = tmpPath();
  try {
    // Write scoreboard with 35 rounds
    const sb = makeScoreboard(35, { vote: 'TP', verdict: 'APPROVE' });
    fs.writeFileSync(sbPath, JSON.stringify(sb, null, 2));

    const { exitCode, stdout } = runCLI(['--scoreboard', sbPath, '--output', outPath]);
    assert.strictEqual(exitCode, 0);
    assert.ok(fs.existsSync(outPath), 'output file must exist');

    const output = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.strictEqual(output.version, 1);
    assert.ok(output.deltas, 'output must have deltas');
    assert.ok(output.metadata, 'output must have metadata');
    assert.strictEqual(typeof output.deltas.TP, 'number');
    assert.strictEqual(output.deltas.UNAVAIL, 0);
    assert.strictEqual(output.deltas[''], 0);
  } finally {
    cleanup(sbPath);
    cleanup(outPath);
  }
});

test('CAL-TC17: CLI writes default deltas when scoreboard has < 30 rounds', () => {
  const sbPath = tmpPath();
  const outPath = tmpPath();
  try {
    const sb = makeScoreboard(10, { vote: 'TP', verdict: 'APPROVE' });
    fs.writeFileSync(sbPath, JSON.stringify(sb, null, 2));

    const { exitCode, stdout } = runCLI(['--scoreboard', sbPath, '--output', outPath]);
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('DEFAULT'), 'stdout must indicate fallback');

    const output = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.strictEqual(output.metadata.usedFallback, true);
  } finally {
    cleanup(sbPath);
    cleanup(outPath);
  }
});

test('CAL-TC18: output file contains all required keys', () => {
  const sbPath = tmpPath();
  const outPath = tmpPath();
  try {
    const sb = makeScoreboard(35, { vote: 'TP', verdict: 'APPROVE' });
    fs.writeFileSync(sbPath, JSON.stringify(sb, null, 2));

    runCLI(['--scoreboard', sbPath, '--output', outPath]);

    const output = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    const required = ['TP', 'TN', 'FP', 'FN', 'TP+', 'TN+', 'UNAVAIL', ''];
    for (const key of required) {
      assert.strictEqual(typeof output.deltas[key], 'number', `deltas.${key} must be a number`);
    }
  } finally {
    cleanup(sbPath);
    cleanup(outPath);
  }
});

// ---------------------------------------------------------------------------
// Integration: update-scoreboard uses calibrated deltas
// ---------------------------------------------------------------------------

test('CAL-TC19: update-scoreboard exports loadScoreDeltas and DEFAULT_SCORE_DELTAS', () => {
  const mod = require('./update-scoreboard.cjs');
  assert.strictEqual(typeof mod.loadScoreDeltas, 'function');
  assert.ok(mod.DEFAULT_SCORE_DELTAS);
  assert.strictEqual(mod.DEFAULT_SCORE_DELTAS.TP, 1);
});

test('CAL-TC20: update-scoreboard uses calibrated deltas when config file exists', () => {
  // Set up a temp project root with .planning/quorum/ structure
  // loadScoreDeltas() resolves relative to CWD, so we spawn with cwd=calDir
  const calOutput = {
    version: 1,
    deltas: { TP: 3, TN: 5, FP: -3, FN: -1, 'TP+': 5, 'TN+': 7, UNAVAIL: 0, '': 0 },
    metadata: {},
  };

  const calDir = path.join(os.tmpdir(), 'nf-cal-int-' + Date.now());
  const planningDir = path.join(calDir, '.planning', 'quorum');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'calibrated-deltas.json'), JSON.stringify(calOutput, null, 2));

  const sbFile = path.join(planningDir, 'scoreboard.json');
  fs.writeFileSync(sbFile, JSON.stringify({ models: {}, slots: {}, rounds: [], categories: {} }));

  try {
    // Spawn with CWD = calDir so loadScoreDeltas() finds the config
    const result = spawnSync('node', [
      SB_SCRIPT,
      '--model', 'claude',
      '--result', 'TP',
      '--task', 'cal-int-test',
      '--round', '1',
      '--verdict', 'APPROVE',
      '--scoreboard', sbFile,
    ], {
      encoding: 'utf8',
      timeout: 5000,
      cwd: calDir,
    });

    assert.strictEqual(result.status, 0, `exit code 0, stderr: ${result.stderr}`);
    // With calibrated TP=3, score should be 3 not 1
    assert.ok(result.stdout.includes('score: 3'), `stdout should show score: 3, got: ${result.stdout}`);
  } finally {
    try { fs.rmSync(calDir, { recursive: true }); } catch (_) {}
  }
});

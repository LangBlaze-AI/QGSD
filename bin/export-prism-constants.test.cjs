#!/usr/bin/env node
'use strict';
// bin/export-prism-constants.test.cjs
// Wave 0 RED stubs for bin/export-prism-constants.cjs
// Tests cover: no scoreboard file, < 30 rounds warning, conservative priors.
// Requirements: PRM-02, PRM-03

const { test } = require('node:test');
const assert   = require('node:assert');
const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const EXPORT_PRISM = path.join(__dirname, 'export-prism-constants.cjs');

test('exits non-zero when no scoreboard file found', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-test-'));
  try {
    const result = spawnSync(process.execPath, [EXPORT_PRISM], {
      encoding: 'utf8',
      cwd: tmpDir,
    });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /scoreboard|no.*scoreboard/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('exits 0 and writes rates.const when scoreboard has >= 30 rounds per slot', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-test-'));
  try {
    // Create a temp .planning/ with scoreboard having 35 rounds per slot
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    const rounds = [];
    for (let i = 0; i < 35; i++) {
      rounds.push({
        date: '02-25',
        task: `test-round-${i}`,
        round: 1,
        votes: {
          claude: 'TP',
          gemini: 'TP',
          opencode: 'TP',
          copilot: 'TP',
          codex: 'TP',
        },
      });
    }
    const scoreboard = {
      models: {
        claude: { score: 35, tp: 35, tn: 0, fp: 0, fn: 0, impr: 0 },
        gemini: { score: 35, tp: 35, tn: 0, fp: 0, fn: 0, impr: 0 },
        opencode: { score: 35, tp: 35, tn: 0, fp: 0, fn: 0, impr: 0 },
        copilot: { score: 35, tp: 35, tn: 0, fp: 0, fn: 0, impr: 0 },
        codex: { score: 35, tp: 35, tn: 0, fp: 0, fn: 0, impr: 0 },
      },
      rounds,
    };
    fs.writeFileSync(
      path.join(planningDir, 'quorum-scoreboard.json'),
      JSON.stringify(scoreboard, null, 2)
    );
    // Create .planning/formal/prism/ output dir
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal', 'prism'), { recursive: true });
    const result = spawnSync(process.execPath, [EXPORT_PRISM], {
      encoding: 'utf8',
      cwd: tmpDir,
    });
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /written|rates\.const/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('emits WARNING to stderr when any slot has < 30 rounds', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-test-'));
  try {
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    // Only 5 rounds for gemini
    const rounds = [];
    for (let i = 0; i < 5; i++) {
      rounds.push({
        date: '02-25',
        task: `test-round-${i}`,
        round: 1,
        votes: {
          claude: 'TP',
          gemini: 'TP',
          opencode: 'TP',
          copilot: 'TP',
          codex: 'TP',
        },
      });
    }
    const scoreboard = {
      models: {
        claude: { score: 5, tp: 5, tn: 0, fp: 0, fn: 0, impr: 0 },
        gemini: { score: 5, tp: 5, tn: 0, fp: 0, fn: 0, impr: 0 },
        opencode: { score: 5, tp: 5, tn: 0, fp: 0, fn: 0, impr: 0 },
        copilot: { score: 5, tp: 5, tn: 0, fp: 0, fn: 0, impr: 0 },
        codex: { score: 5, tp: 5, tn: 0, fp: 0, fn: 0, impr: 0 },
      },
      rounds,
    };
    fs.writeFileSync(
      path.join(planningDir, 'quorum-scoreboard.json'),
      JSON.stringify(scoreboard, null, 2)
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal', 'prism'), { recursive: true });
    const result = spawnSync(process.execPath, [EXPORT_PRISM], {
      encoding: 'utf8',
      cwd: tmpDir,
    });
    assert.match(result.stderr, /WARNING.*gemini|WARNING.*fewer|WARNING.*30|WARNING.*conservative|fewer.*30|conservative/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('uses conservative priors (0.85) for slots with < 30 rounds', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-test-'));
  try {
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    const rounds = [];
    for (let i = 0; i < 5; i++) {
      rounds.push({
        date: '02-25',
        task: `test-round-${i}`,
        round: 1,
        votes: { claude: 'TP', gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' },
      });
    }
    const scoreboard = {
      models: {
        claude: { score: 5, tp: 5, tn: 0, fp: 0, fn: 0, impr: 0 },
        gemini: { score: 5, tp: 5, tn: 0, fp: 0, fn: 0, impr: 0 },
        opencode: { score: 5, tp: 5, tn: 0, fp: 0, fn: 0, impr: 0 },
        copilot: { score: 5, tp: 5, tn: 0, fp: 0, fn: 0, impr: 0 },
        codex: { score: 5, tp: 5, tn: 0, fp: 0, fn: 0, impr: 0 },
      },
      rounds,
    };
    fs.writeFileSync(
      path.join(planningDir, 'quorum-scoreboard.json'),
      JSON.stringify(scoreboard, null, 2)
    );
    const prismDir = path.join(tmpDir, '.planning', 'formal', 'prism');
    fs.mkdirSync(prismDir, { recursive: true });
    const result = spawnSync(process.execPath, [EXPORT_PRISM], {
      encoding: 'utf8',
      cwd: tmpDir,
    });
    // Should exit 0 (warning, not error) and write rates.const
    assert.strictEqual(result.status, 0);
    const ratesPath = path.join(prismDir, 'rates.const');
    assert.ok(fs.existsSync(ratesPath), 'rates.const should be written');
    const content = fs.readFileSync(ratesPath, 'utf8');
    // conservative prior for low-round slots
    assert.match(content, /0\.85/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('handles non-array rounds (object map) without crashing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-test-'));
  try {
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    // Corrupt: rounds serialized as an object map, not an array
    const scoreboard = { models: {}, rounds: { r1: {} } };
    fs.writeFileSync(
      path.join(planningDir, 'quorum-scoreboard.json'),
      JSON.stringify(scoreboard, null, 2)
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal', 'prism'), { recursive: true });
    const result = spawnSync(process.execPath, [EXPORT_PRISM], {
      encoding: 'utf8',
      cwd: tmpDir,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /TypeError|is not a function/);
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'formal', 'prism', 'rates.const')),
      'rates.const should still be written'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('skips null round entries without crashing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-test-'));
  try {
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    const rounds = [];
    for (let i = 0; i < 35; i++) {
      rounds.push({
        date: '02-25',
        task: `r-${i}`,
        round: 1,
        votes: { claude: 'TP', gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' },
      });
    }
    rounds.push(null);          // corrupt entry — currently crashes the filter
    rounds.push({ round: 2 });  // entry with no votes key (must be tolerated)
    const scoreboard = { models: {}, rounds };
    fs.writeFileSync(
      path.join(planningDir, 'quorum-scoreboard.json'),
      JSON.stringify(scoreboard, null, 2)
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal', 'prism'), { recursive: true });
    const result = spawnSync(process.execPath, [EXPORT_PRISM], {
      encoding: 'utf8',
      cwd: tmpDir,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Cannot read propert|TypeError/);
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'formal', 'prism', 'rates.const'))
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

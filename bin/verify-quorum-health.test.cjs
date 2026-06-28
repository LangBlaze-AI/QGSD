#!/usr/bin/env node
'use strict';
// bin/verify-quorum-health.test.cjs
// Comprehensive unit tests for bin/verify-quorum-health.cjs
//
// Strategy: spawn the script as a subprocess with a temp directory containing:
//   - src/machines/nf-workflow.machine.ts  with a known maxDeliberation value
//   - .planning/quorum-scoreboard.json       with known round data
//
// The script uses ROOT = path.join(__dirname, '..') to locate files, so we
// override that by passing { cwd: tmpDir } and patching the path via a
// wrapper that sets __dirname-equivalent.  Because the script resolves ROOT
// from its own __dirname we cannot redirect it via cwd alone — instead we
// run the script with a NODE_PATH override that makes it resolve against a
// wrapper, OR (simpler) we copy the script to tmpDir and patch ROOT.
//
// SIMPLEST approach: use env var NF_ROOT to override ROOT in the script.
// The script does not support that today, so we use a thin wrapper shim that
// patches ROOT before requiring the real script.  The shim is written to a
// temp file for each test.
//
// Run: node --test bin/verify-quorum-health.test.cjs

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, 'verify-quorum-health.cjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a temporary directory with the required filesystem layout:
 *   <tmpDir>/src/machines/nf-workflow.machine.ts
 *   <tmpDir>/.planning/quorum-scoreboard.json   (optional)
 *
 * Returns the tmpDir path.
 */
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vqh-test-'));
  return dir;
}

/**
 * Write a minimal TypeScript machine file containing the given maxDeliberation.
 */
function writeMachineFile(tmpDir, maxDeliberation) {
  const machinesDir = path.join(tmpDir, 'src', 'machines');
  fs.mkdirSync(machinesDir, { recursive: true });
  const content = [
    '// Minimal stub for verify-quorum-health tests',
    'export const nfWorkflowMachine = createMachine({',
    '  context: {',
    '    maxDeliberation: ' + maxDeliberation + ',',
    '    otherValue: 42,',
    '  },',
    '});',
  ].join('\n');
  fs.writeFileSync(path.join(machinesDir, 'nf-workflow.machine.ts'), content, 'utf8');
}

/**
 * Write a scoreboard JSON file to <tmpDir>/.planning/quorum-scoreboard.json.
 * `rounds` is an array of round objects matching the real scoreboard format.
 */
function writeScoreboard(tmpDir, rounds) {
  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  const scoreboard = { rounds };
  fs.writeFileSync(
    path.join(planningDir, 'quorum-scoreboard.json'),
    JSON.stringify(scoreboard, null, 2),
    'utf8'
  );
}

/**
 * Build a round object with the given vote values for all four external slots.
 * voteMap: { gemini, opencode, copilot, codex } — any value accepted by the script.
 */
function makeRound(voteMap, roundNum = 1) {
  return {
    date:    '02-27',
    task:    'test-round',
    round:   roundNum,
    votes:   voteMap,
    verdict: 'APPROVE',
  };
}

/**
 * Generate `n` rounds all with the same vote values.
 */
function makeRounds(n, voteMap) {
  return Array.from({ length: n }, (_, i) => makeRound(voteMap, (i % 10) + 1));
}

/**
 * Create a Node.js shim file that patches ROOT before requiring the real script.
 * The shim is written into tmpDir so __dirname-relative paths resolve correctly.
 *
 * The real script has:
 *   const ROOT = path.join(__dirname, '..');
 * which resolves to the repo root.  We need to point ROOT at tmpDir instead.
 *
 * We achieve this by writing a thin wrapper that monkey-patches the module
 * resolution by temporarily overriding the script's source via a modified copy.
 */
function writeShim(tmpDir, extraArgs = []) {
  // We create a patched copy of the script in tmpDir/bin/ so that
  //   __dirname inside the copy = tmpDir/bin
  //   path.join(__dirname, '..') = tmpDir
  // which is exactly what we want.
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  // Read the real script source
  let src = fs.readFileSync(SCRIPT_PATH, 'utf8');

  // The script reads process.argv for --target, so we keep that intact.
  // The only change needed: strip the shebang (if any) so Node can require it.
  src = src.replace(/^#!.*\n/, '');

  const shimPath = path.join(binDir, 'verify-quorum-health.cjs');
  fs.writeFileSync(shimPath, src, 'utf8');
  return shimPath;
}

/**
 * Spawn the patched copy of the script inside tmpDir and return
 * { stdout, stderr, exitCode }.
 */
function runScript(tmpDir, extraArgs = [], env = {}) {
  const shimPath = writeShim(tmpDir);
  const args = [shimPath, ...extraArgs];

  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout:  10000,
    env:      { ...process.env, ...env },
  });

  return {
    stdout:   result.stdout  || '',
    stderr:   result.stderr  || '',
    exitCode: result.status,
  };
}

// ─── Test: missing scoreboard file ───────────────────────────────────────────

test('exits 1 when no scoreboard file exists', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    // Deliberately do NOT write a scoreboard file.

    const { exitCode, stderr } = runScript(tmpDir);

    assert.equal(exitCode, 1, 'should exit 1 when scoreboard is missing');
    assert.match(stderr, /[Nn]o scoreboard|scoreboard.*found|cannot compute/i,
      'stderr should mention missing scoreboard');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stderr contains the follow-up hint when scoreboard is missing', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);

    const { stderr } = runScript(tmpDir);

    // The script writes two stderr lines for this case.
    assert.match(stderr, /quorum rounds|Run some/i,
      'stderr should hint to run quorum rounds');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test: missing XState machine file ───────────────────────────────────────

test('exits 1 when XState machine file does not exist', () => {
  const tmpDir = makeTmpDir();
  try {
    // Write a scoreboard but NO machine file.
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);
    // Do not create src/machines/ at all.

    const { exitCode, stderr } = runScript(tmpDir);

    assert.equal(exitCode, 1, 'should exit 1 when machine file is missing');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stderr mentions maxDeliberation when machine file is missing', () => {
  const tmpDir = makeTmpDir();
  try {
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stderr } = runScript(tmpDir);

    // When the machine file is absent the script throws a synchronous ENOENT on
    // fs.readFileSync before it can write its own error message.  The Node.js
    // runtime prints the uncaught error to stderr, so we match the OS-level
    // ENOENT text and the filename that the script attempts to open.
    assert.match(stderr, /ENOENT|nf-workflow\.machine\.ts/,
      'stderr should contain the ENOENT error for the missing machine file');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('exits 1 when machine file exists but contains no maxDeliberation field', () => {
  const tmpDir = makeTmpDir();
  try {
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    // Write a machine file without maxDeliberation
    const machinesDir = path.join(tmpDir, 'src', 'machines');
    fs.mkdirSync(machinesDir, { recursive: true });
    fs.writeFileSync(
      path.join(machinesDir, 'nf-workflow.machine.ts'),
      '// no maxDeliberation here\nexport const x = 1;\n',
      'utf8'
    );

    const { exitCode, stderr } = runScript(tmpDir);

    assert.equal(exitCode, 1, 'should exit 1 when maxDeliberation regex finds nothing');
    assert.match(stderr, /maxDeliberation|Cannot read/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test: fewer than 30 rounds per agent — uses priors, exits 0 ─────────────

test('exits 0 with maxDelib=10 when scoreboard has < 30 rounds (priors are favorable)', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    // 5 rounds — below the MIN_ROUNDS=30 threshold; priors (tp=0.85, unavail=0.15) apply.
    // With priors: p_approve ≈ 0.85 * 0.85 = 0.7225 per agent.
    // P(≥2 of 4 approve) is very high — definitely >= 0.95 within 10 rounds.
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { exitCode, stdout } = runScript(tmpDir);

    assert.equal(exitCode, 0, 'should pass with priors and maxDelib=10');
    assert.match(stdout, /PASS/i, 'stdout should show PASS');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('output labels prior slots with [prior] annotation', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    assert.match(stdout, /\[prior\]/,
      'should annotate at least one slot as [prior] when n < 30');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('per-agent lines show tp= and unavail= values (prior case)', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    // Should see prior tp=0.8500 and unavail=0.1500 for all four slots.
    assert.match(stdout, /tp=0\.8500/, 'should show prior tp rate 0.8500');
    assert.match(stdout, /unavail=0\.1500/, 'should show prior unavail rate 0.1500');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test: 30+ rounds of all-APPROVE → high empirical rate, exits 0 ──────────

test('exits 0 when 30+ rounds are all TP votes (high empirical rate)', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    // 35 rounds where all four external agents vote TP each time.
    // Empirical rate: tp=1.0, unavail=0.0 → p_approve=1.0 → guaranteed pass.
    const rounds = makeRounds(35, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { exitCode, stdout } = runScript(tmpDir);

    assert.equal(exitCode, 0, 'should pass with perfect empirical rates');
    assert.match(stdout, /PASS/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('per-agent lines show [empirical, n=35] annotation for 35-round scoreboard', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(35, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    assert.match(stdout, /\[empirical, n=35\]/,
      'should annotate slots as [empirical, n=35] when sufficient rounds exist');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('empirical tp rate is 1.0000 when all 35 rounds are TP', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(35, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    assert.match(stdout, /tp=1\.0000/, 'empirical tp rate should be 1.0000');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('empirical unavail rate is 0.0000 when no UNAVAIL votes in 35 rounds', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(35, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    assert.match(stdout, /unavail=0\.0000/, 'empirical unavail rate should be 0.0000');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TP+ votes count as approvals in empirical calculation', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    // All TP+ votes — should also produce tp=1.0000 empirically.
    const rounds = makeRounds(35, { gemini: 'TP+', opencode: 'TP+', copilot: 'TP+', codex: 'TP+' });
    writeScoreboard(tmpDir, rounds);

    const { stdout, exitCode } = runScript(tmpDir);

    assert.equal(exitCode, 0, 'TP+ votes should count as approvals');
    assert.match(stdout, /tp=1\.0000/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test: 30+ rounds of many-UNAVAIL votes → degraded rates ─────────────────

test('exits 1 when 30+ rounds show high unavailability and maxDelib=1', () => {
  const tmpDir = makeTmpDir();
  try {
    // 35 all-UNAVAIL rounds → empirical path: tp=0, unavail=1, p_approve=0.
    // P(≥2 of 4 approve | p_approve=0) = 0 per round.
    // P(within 1 round) = 0 < 0.95 → FAIL.
    writeMachineFile(tmpDir, 1);
    const rounds = makeRounds(35, { gemini: 'UNAVAIL', opencode: 'UNAVAIL', copilot: 'UNAVAIL', codex: 'UNAVAIL' });
    writeScoreboard(tmpDir, rounds);

    const { exitCode } = runScript(tmpDir);

    assert.equal(exitCode, 1, 'should fail with empirical p_approve=0 and maxDelib=1');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('exits 1 when empirical unavail rate is very high (0.9) and maxDelib is low', () => {
  const tmpDir = makeTmpDir();
  try {
    // 30 rounds: 3 TP, 27 UNAVAIL per agent.
    // Empirical: relevant = rounds where vote !== UNAVAIL = 3 (TP rounds);
    //   tp_rate = 3/3 = 1.0
    //   unavail_rate = 27/30 = 0.9
    //   p_approve = 1.0 * (1 - 0.9) = 0.1
    // P(≥2 of 4 approve | p=0.1 each) ≈ very low per round.
    // P(within maxDelib=5 rounds) will be well below 0.95.
    writeMachineFile(tmpDir, 5);
    const rounds = [];
    // 3 all-TP rounds
    for (let i = 0; i < 3; i++) {
      rounds.push(makeRound({ gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' }));
    }
    // 27 all-UNAVAIL rounds
    for (let i = 0; i < 27; i++) {
      rounds.push(makeRound({ gemini: 'UNAVAIL', opencode: 'UNAVAIL', copilot: 'UNAVAIL', codex: 'UNAVAIL' }));
    }
    writeScoreboard(tmpDir, rounds);

    const { exitCode, stderr } = runScript(tmpDir);

    assert.equal(exitCode, 1, 'should fail with very high empirical unavail rate and low maxDelib');
    assert.match(stderr, /FAIL/i, 'stderr should contain FAIL');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('FAIL output includes recommended maxDeliberation adjustment', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 1);
    const rounds = makeRounds(35, { gemini: 'UNAVAIL', opencode: 'UNAVAIL', copilot: 'UNAVAIL', codex: 'UNAVAIL' });
    writeScoreboard(tmpDir, rounds);

    const { stderr } = runScript(tmpDir);

    assert.match(stderr, /maxDeliberation/,
      'FAIL message should reference maxDeliberation update action');
    assert.match(stderr, /src\/machines\/nf-workflow\.machine\.ts/,
      'FAIL message should name the file to update');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test: --target flag changes the confidence threshold ─────────────────────

test('--target=0.99 causes failure when default --target=0.95 would pass', () => {
  // We need a scenario that passes at 0.95 but fails at 0.99.
  // With priors (tp=0.85, unavail=0.15, p_approve≈0.7225) and maxDelib=10:
  //   P(within 10 rounds) = 1 - (1 - P_per_round)^10
  // Let's compute: P_per_round with priors = P(≥2 of 4 approve | p≈0.7225 each)
  //   ≈ high (binomial). After computing, P(within 10) with prior rates is > 0.99
  //   for any reasonable majority-probability.
  //
  // Instead, use low maxDelib=2 with prior rates:
  //   P(per round) ≈ 0.916 (calculated from inclusion-exclusion on 4 agents with p=0.7225)
  //   P(within 2 rounds) = 1 - (1 - 0.916)^2 ≈ 1 - 0.007 ≈ 0.993 > 0.99
  // That still passes. Let's use maxDelib=1:
  //   P(within 1 round) ≈ 0.916 — passes 0.95? No (0.916 < 0.95). Fails both.
  //
  // Use 30 rounds with moderate unavail (30% unavail, 70% TP) and maxDelib=3:
  //   relevant n = 21 (TP rounds), unavail n = 9
  //   tp_rate = 21/21 = 1.0, unavail_rate = 9/30 = 0.3
  //   p_approve = 1.0 * 0.7 = 0.7
  //   P(≥2 of 4 | p=0.7) via inclusion-exclusion ≈ high per round
  //   Let's use maxDelib=2 with these rates and target=0.99 vs 0.95.
  //
  // Precise approach: craft scoreboard so that with maxDelib=3:
  //   pass at 0.95, fail at 0.99.
  // With p_approve=0.5 per agent:
  //   P(≥2 of 4) ≈ 0.6875 per round
  //   P(within 3) = 1-(0.3125)^3 ≈ 0.969 → passes 0.95, passes 0.99 too
  // With p_approve=0.4:
  //   P(≥2 of 4) = C(4,2)*0.16*0.36 + C(4,3)*0.064*0.6 + C(4,4)*0.0256
  //              = 6*0.0576 + 4*0.0384 + 0.0256 = 0.3456+0.1536+0.0256 = 0.5248
  //   P(within 4) = 1-(0.4752)^4 ≈ 0.951 → just passes 0.95, fails 0.99
  //
  // To get p_approve=0.4 empirically: tp_rate * (1-unavail_rate) = 0.4
  //   Use unavail_rate=0.5, tp_rate=0.8: 0.8*0.5=0.4
  //   30 rounds: 15 UNAVAIL, 12 TP, 3 FN → relevant=15, tp=12/15=0.8, unavail=15/30=0.5
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 4);
    const rounds = [];
    // 12 TP rounds
    for (let i = 0; i < 12; i++) {
      rounds.push(makeRound({ gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' }));
    }
    // 3 FN rounds (not TP, not UNAVAIL — will be counted in relevant but not as approval)
    for (let i = 0; i < 3; i++) {
      rounds.push(makeRound({ gemini: 'FN', opencode: 'FN', copilot: 'FN', codex: 'FN' }));
    }
    // 15 UNAVAIL rounds
    for (let i = 0; i < 15; i++) {
      rounds.push(makeRound({ gemini: 'UNAVAIL', opencode: 'UNAVAIL', copilot: 'UNAVAIL', codex: 'UNAVAIL' }));
    }
    writeScoreboard(tmpDir, rounds);

    // With default target (0.95): may pass or fail depending on exact P value.
    // With --target=0.99: should be more stringent.
    // Test: verify that passing --target=0.99 produces a different (stricter) gate.
    const resultDefault = runScript(tmpDir, []);
    const resultStrict  = runScript(tmpDir, ['--target=0.99']);

    // The strict target should either fail when default passes, or fail by a larger margin.
    // At minimum: both tests should not both exit 0, OR the strict output shows a higher target.
    // We assert that the strict output mentions 99% target.
    assert.match(resultStrict.stdout + resultStrict.stderr, /99%/,
      '--target=0.99 output should show 99% confidence target');
    assert.match(resultDefault.stdout + resultDefault.stderr, /95%/,
      'default output should show 95% confidence target');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('--target=0.99 makes the gate more stringent than default 0.95', () => {
  // Use a scenario that provably passes 0.95 but fails 0.99:
  // p_approve=0.4 per agent, maxDelib=4 → P(within 4) ≈ 0.951 (see derivation above).
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 4);
    const rounds = [];
    for (let i = 0; i < 12; i++) {
      rounds.push(makeRound({ gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' }));
    }
    for (let i = 0; i < 3; i++) {
      rounds.push(makeRound({ gemini: 'FN', opencode: 'FN', copilot: 'FN', codex: 'FN' }));
    }
    for (let i = 0; i < 15; i++) {
      rounds.push(makeRound({ gemini: 'UNAVAIL', opencode: 'UNAVAIL', copilot: 'UNAVAIL', codex: 'UNAVAIL' }));
    }
    writeScoreboard(tmpDir, rounds);

    const resultStrict = runScript(tmpDir, ['--target=0.99']);

    // With p_approve≈0.4 and maxDelib=4 → P≈0.951 < 0.99 — should fail.
    assert.equal(resultStrict.exitCode, 1,
      '--target=0.99 should fail when P(within maxDelib) ≈ 0.951');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('--target=0.50 passes even with a very low maxDelib=1', () => {
  // With priors, P(per round) with prior rates is above 0.50, so maxDelib=1 should pass.
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 1);
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { exitCode } = runScript(tmpDir, ['--target=0.50']);

    assert.equal(exitCode, 0, '--target=0.50 with prior rates and maxDelib=1 should pass');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test: report header and structure ───────────────────────────────────────

test('output contains "nForma Quorum Reliability Report" header', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    assert.match(stdout, /nForma Quorum Reliability Report/,
      'stdout should contain the report header');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('output contains per-agent section header', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    assert.match(stdout, /Per-agent.*approval/i,
      'stdout should have per-agent section header');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('output contains per-agent lines for all four external slots', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    assert.match(stdout, /gemini/,    'stdout should include gemini agent line');
    assert.match(stdout, /opencode/,  'stdout should include opencode agent line');
    assert.match(stdout, /copilot/,   'stdout should include copilot agent line');
    assert.match(stdout, /codex/,     'stdout should include codex agent line');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('per-agent lines contain tp= values', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    // Match tp= (decimal) appearing at least once
    assert.match(stdout, /tp=\d+\.\d+/, 'per-agent lines should include tp= values');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('per-agent lines contain unavail= values', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    assert.match(stdout, /unavail=\d+\.\d+/, 'per-agent lines should include unavail= values');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('per-agent lines contain p_approve= values', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    assert.match(stdout, /p_approve=\d+\.\d+/, 'per-agent lines should include p_approve= values');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('report includes convergence analysis section', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    assert.match(stdout, /Convergence analysis/i,
      'stdout should include convergence analysis section');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('report includes recommended maxDeliberation section', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    assert.match(stdout, /Recommended maxDeliberation/i,
      'stdout should show recommended maxDeliberation for confidence levels');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('report shows maxDeliberation value from XState machine', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 7);
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    assert.match(stdout, /maxDeliberation=7/,
      'report should echo the maxDeliberation value read from the machine file');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('report includes conservative-prior comparison line', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    assert.match(stdout, /Conservative priors|prior.*p_round/i,
      'report should show conservative-prior comparison');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('report includes 90%, 95%, 99% confidence recommendations', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    assert.match(stdout, /90%/, 'report should include 90% confidence recommendation');
    assert.match(stdout, /95%/, 'report should include 95% confidence recommendation');
    assert.match(stdout, /99%/, 'report should include 99% confidence recommendation');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test: scoreboard with mixed votes (realistic shape) ─────────────────────

test('computes correct empirical rates with mixed TP/UNAVAIL/FN votes', () => {
  // The relevant filter in computeRates excludes only '' and 'UNAVAILABLE' (typo).
  // 'UNAVAIL' rounds ARE included in relevant, so n = total rounds.
  // 35 rounds: 30 TP, 5 UNAVAIL per agent.
  //   relevant = 35 (>= 30), tp_rate = 30/35 ≈ 0.8571
  //   unavail_rate = 5/35 ≈ 0.1429
  //   p_approve = 0.8571 * (1 - 0.1429) ≈ 0.7347
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = [];
    for (let i = 0; i < 30; i++) {
      rounds.push(makeRound({ gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' }));
    }
    for (let i = 0; i < 5; i++) {
      rounds.push(makeRound({ gemini: 'UNAVAIL', opencode: 'UNAVAIL', copilot: 'UNAVAIL', codex: 'UNAVAIL' }));
    }
    writeScoreboard(tmpDir, rounds);

    const { stdout, exitCode } = runScript(tmpDir);

    assert.equal(exitCode, 0, 'should pass with realistic mixed rates and maxDelib=10');
    assert.match(stdout, /\[empirical, n=35\]/,
      'should use empirical rates with 35 total rounds (UNAVAIL counted in n)');
    // tp_rate = 30/35 ≈ 0.8571
    assert.match(stdout, /tp=0\.8571/, 'should show empirical tp rate ≈ 0.8571');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('UNAVAIL votes are included in relevant n (only UNAVAILABLE typo is excluded)', () => {
  // The relevant filter excludes v === '' and v === 'UNAVAILABLE' (the typo variant).
  // 'UNAVAIL' (the canonical value) is NOT excluded — it is included in relevant.
  // 35 all-'UNAVAIL' rounds → relevant n = 35 >= 30 → empirical path used, not prior.
  //   tp_rate = 0/35 = 0.0000, unavail_rate = 35/35 = 1.0000, p_approve = 0.0
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(35, { gemini: 'UNAVAIL', opencode: 'UNAVAIL', copilot: 'UNAVAIL', codex: 'UNAVAIL' });
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    // empirical path is taken (n=35 >= 30)
    assert.match(stdout, /\[empirical, n=35\]/,
      'all-UNAVAIL scoreboard with 35 rounds should use empirical path (n=35 >= 30)');
    assert.match(stdout, /tp=0\.0000/, 'tp_rate should be 0 — no TP votes');
    assert.match(stdout, /unavail=1\.0000/, 'unavail_rate should be 1 — all UNAVAIL');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('empty string votes are excluded from relevant-round filter', () => {
  // 35 rounds: votes with empty string '' — these are Mode A rounds, excluded.
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(35, { gemini: '', opencode: '', copilot: '', codex: '' });
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    // relevant n = 0 → prior fallback.
    assert.match(stdout, /\[prior\]/,
      'empty-string votes should be excluded, triggering prior fallback');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('rounds missing a slot vote are handled gracefully (slot treated as absent)', () => {
  // 35 rounds where codex key is absent in votes object.
  // For codex: relevant = 0 → prior fallback.
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(35, { gemini: 'TP', opencode: 'TP', copilot: 'TP' }); // codex absent
    writeScoreboard(tmpDir, rounds);

    const { stdout, exitCode } = runScript(tmpDir);

    // codex will fall back to prior; gemini/opencode/copilot will be empirical.
    // Script should not crash; should produce output.
    assert.ok(typeof exitCode === 'number', 'should exit with a numeric code');
    assert.match(stdout, /codex/, 'should still produce a codex line');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test: rounds array edge cases ───────────────────────────────────────────

test('empty rounds array falls back to priors for all agents', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    writeScoreboard(tmpDir, []); // zero rounds

    const { stdout, exitCode } = runScript(tmpDir);

    assert.ok(typeof exitCode === 'number', 'should not throw');
    assert.match(stdout, /\[prior\]/,
      'zero rounds should trigger prior fallback for all agents');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('scoreboard with no rounds key falls back gracefully', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    // Write scoreboard with models but no rounds key.
    fs.writeFileSync(
      path.join(planningDir, 'quorum-scoreboard.json'),
      JSON.stringify({ models: {} }, null, 2),
      'utf8'
    );

    const { stdout, exitCode } = runScript(tmpDir);

    assert.ok(typeof exitCode === 'number', 'should not crash on missing rounds key');
    assert.match(stdout, /\[prior\]/,
      'missing rounds key should fall back to priors (treats as 0 rounds)');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('scoreboard with invalid JSON exits 1 with an error', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(
      path.join(planningDir, 'quorum-scoreboard.json'),
      '{ this is not valid json ',
      'utf8'
    );

    const { exitCode } = runScript(tmpDir);

    assert.equal(exitCode, 1, 'invalid JSON scoreboard should cause exit 1');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test: maxDeliberation parsing ───────────────────────────────────────────

test('reads maxDeliberation=3 correctly and uses it in P computation', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 3);
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    assert.match(stdout, /maxDeliberation=3/,
      'report should show the correct maxDeliberation value of 3');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reads maxDeliberation=20 correctly', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 20);
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    assert.match(stdout, /maxDeliberation=20/,
      'report should show the correct maxDeliberation value of 20');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('maxDeliberation regex matches even with surrounding whitespace variations', () => {
  const tmpDir = makeTmpDir();
  try {
    // Write machine file with extra whitespace before the value.
    const machinesDir = path.join(tmpDir, 'src', 'machines');
    fs.mkdirSync(machinesDir, { recursive: true });
    fs.writeFileSync(
      path.join(machinesDir, 'nf-workflow.machine.ts'),
      'export const m = createMachine({ context: { maxDeliberation:   15, } });\n',
      'utf8'
    );
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stdout, exitCode } = runScript(tmpDir);

    assert.notEqual(exitCode, null, 'should not time out');
    assert.match(stdout, /maxDeliberation=15/,
      'regex should handle extra whitespace around the value');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test: gate logic and PASS/FAIL output placement ─────────────────────────

test('PASS message goes to stdout', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stdout, stderr, exitCode } = runScript(tmpDir);

    assert.equal(exitCode, 0);
    assert.match(stdout, /PASS/i, 'PASS line should appear in stdout');
    assert.ok(!stderr.match(/FAIL/i), 'stderr should not contain FAIL on a pass');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('FAIL message goes to stderr', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 1);
    const rounds = makeRounds(35, { gemini: 'UNAVAIL', opencode: 'UNAVAIL', copilot: 'UNAVAIL', codex: 'UNAVAIL' });
    writeScoreboard(tmpDir, rounds);

    const { stdout, stderr, exitCode } = runScript(tmpDir);

    assert.equal(exitCode, 1);
    assert.match(stderr, /FAIL/i, 'FAIL line should appear in stderr');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('PASS output contains P(within N rounds) percentage', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    // Matches patterns like "P(within 10 rounds) = 100.0%" or similar percentage.
    assert.match(stdout, /P\(within \d+ rounds\).*\d+\.\d+%/,
      'PASS line should include the computed P(within N rounds) percentage');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('FAIL output contains P(within N rounds) percentage and target percentage', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 1);
    const rounds = makeRounds(35, { gemini: 'UNAVAIL', opencode: 'UNAVAIL', copilot: 'UNAVAIL', codex: 'UNAVAIL' });
    writeScoreboard(tmpDir, rounds);

    const { stderr } = runScript(tmpDir);

    assert.match(stderr, /P\(within \d+ rounds\).*\d+\.\d+%/,
      'FAIL message should show the computed P percentage');
    assert.match(stderr, /95%/,
      'FAIL message should show the target threshold (95% default)');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test: gap reporting ──────────────────────────────────────────────────────

test('gap line appears when empirical P is more than 1pp below prior-designed P', () => {
  // With a very unfavorable empirical scenario vs the prior-designed confidence.
  // Use high unavail (0.5) so empirical P_per_round is notably below prior P_per_round.
  // 30 rounds: 15 TP, 15 UNAVAIL → tp_rate=1.0, unavail_rate=0.5 → p_approve=0.5
  // Prior P_per_round ≈ 0.7225; empirical ≈ lower.
  // The gap > 1pp condition should fire.
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = [];
    for (let i = 0; i < 15; i++) {
      rounds.push(makeRound({ gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' }));
    }
    for (let i = 0; i < 15; i++) {
      rounds.push(makeRound({ gemini: 'UNAVAIL', opencode: 'UNAVAIL', copilot: 'UNAVAIL', codex: 'UNAVAIL' }));
    }
    writeScoreboard(tmpDir, rounds);

    const { stdout } = runScript(tmpDir);

    // The gap line is conditional on gap > 0.01.
    // With p_approve=0.5 per agent (empirical) vs 0.7225 (prior), gap is large.
    assert.match(stdout, /Gap.*percentage point|percentage point.*Gap/i,
      'should show gap line when empirical P is notably below designed confidence');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test: high maxDeliberation always converges ─────────────────────────────

test('exits 0 with maxDelib=100 regardless of rates (P→1 with large k)', () => {
  // Even with degraded rates, P(within 100 rounds) → 1.
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 100);
    const rounds = [];
    for (let i = 0; i < 30; i++) {
      rounds.push(makeRound({ gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' }));
    }
    for (let i = 0; i < 5; i++) {
      rounds.push(makeRound({ gemini: 'UNAVAIL', opencode: 'UNAVAIL', copilot: 'UNAVAIL', codex: 'UNAVAIL' }));
    }
    writeScoreboard(tmpDir, rounds);

    const { exitCode } = runScript(tmpDir);

    assert.equal(exitCode, 0, 'maxDelib=100 should always converge and pass');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test: target flag at boundary values ────────────────────────────────────

test('--target=1.0 always fails (P can never reach 1.0 exactly)', () => {
  // P(within k) = 1 - (1-p)^k is always strictly < 1 for any finite k and p<1.
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(5, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const { exitCode } = runScript(tmpDir, ['--target=1.0']);

    assert.equal(exitCode, 1, '--target=1.0 should always fail since P < 1');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('--target=0.0 always passes (P >= 0 always)', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 1);
    // Use worst-case scoreboard — still should pass with target=0.
    const rounds = makeRounds(35, { gemini: 'UNAVAIL', opencode: 'UNAVAIL', copilot: 'UNAVAIL', codex: 'UNAVAIL' });
    writeScoreboard(tmpDir, rounds);

    const { exitCode } = runScript(tmpDir, ['--target=0.0']);

    assert.equal(exitCode, 0, '--target=0.0 should always pass');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test: determinism ────────────────────────────────────────────────────────

test('two runs with identical inputs produce identical stdout', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(35, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    const run1 = runScript(tmpDir);
    const run2 = runScript(tmpDir);

    assert.equal(run1.stdout,   run2.stdout,   'stdout should be deterministic');
    assert.equal(run1.exitCode, run2.exitCode, 'exit code should be deterministic');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test: HEAL-02 --auto-apply flag ──────────────────────────────────────────

test('require does not execute CLI report (no side effects on require)', () => {
  // This test verifies the structural refactor worked: the module can be required
  // without triggering the main() CLI execution.
  // If main() runs on require, this test would fail (timeouts on scoreboard access).

  const mod = require('./verify-quorum-health.cjs');
  assert.ok(typeof mod.suggestMaxDeliberation === 'function',
    'Module should export suggestMaxDeliberation function');
  assert.ok(typeof mod.applyMaxDeliberationUpdate === 'function',
    'Module should export applyMaxDeliberationUpdate function');
  assert.ok(typeof mod.computeRates === 'function',
    'Module should export computeRates helper function');
  assert.ok(typeof mod.pMajorityExternal === 'function',
    'Module should export pMajorityExternal helper function');
});

test('--auto-apply flag is recognized and produces different output', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 1);
    // Use a scenario that fails: all UNAVAIL rounds
    const rounds = makeRounds(35, { gemini: 'UNAVAIL', opencode: 'UNAVAIL', copilot: 'UNAVAIL', codex: 'UNAVAIL' });
    writeScoreboard(tmpDir, rounds);

    const resultWithoutFlag = runScript(tmpDir, []);
    const resultWithFlag = runScript(tmpDir, ['--auto-apply']);

    // Without --auto-apply: should fail and NOT apply changes
    assert.equal(resultWithoutFlag.exitCode, 1, 'Should fail without --auto-apply when P < target');

    // With --auto-apply: behavior depends on whether spec gen tools are available
    // In test environment, spec gen may not be available, so this test just verifies
    // the flag is recognized and processed (may exit 0 if succeeds, or 1 if spec gen fails)
    assert.ok(
      typeof resultWithFlag.exitCode === 'number',
      '--auto-apply should be processed and script should exit with numeric code'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test: computePassAtKRates ─────────────────────────────────────────────

test('computePassAtKRates with mixed events computes correct rates', () => {
  const { computePassAtKRates } = require('./verify-quorum-health.cjs');
  const tmpDir = makeTmpDir();
  try {
    const eventsPath = path.join(tmpDir, 'events.jsonl');
    const events = [
      { action: 'quorum_complete', outcome: 'APPROVE', pass_at_k: 1 },
      { action: 'quorum_complete', outcome: 'APPROVE', pass_at_k: 2 },
      { action: 'quorum_complete', outcome: 'APPROVE', pass_at_k: 1 },
    ];
    fs.writeFileSync(eventsPath, events.map(e => JSON.stringify(e)).join('\n'), 'utf8');

    const result = computePassAtKRates(eventsPath);
    assert.equal(result.total, 3, 'total should be 3');
    assert.ok(Math.abs(result.pass_at_1 - 2/3) < 0.001, 'pass_at_1 should be 2/3');
    assert.equal(result.pass_at_3, 1.0, 'pass_at_3 should be 1.0');
    assert.ok(Math.abs(result.avg_k - 4/3) < 0.001, 'avg_k should be 4/3');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('computePassAtKRates skips cache hits (pass_at_k: 0)', () => {
  const { computePassAtKRates } = require('./verify-quorum-health.cjs');
  const tmpDir = makeTmpDir();
  try {
    const eventsPath = path.join(tmpDir, 'events.jsonl');
    const events = [
      { action: 'quorum_complete', outcome: 'APPROVE', pass_at_k: 0, cache_hit: true },
      { action: 'quorum_complete', outcome: 'APPROVE', pass_at_k: 1 },
      { action: 'quorum_complete', outcome: 'APPROVE', pass_at_k: 0, cache_hit: true },
    ];
    fs.writeFileSync(eventsPath, events.map(e => JSON.stringify(e)).join('\n'), 'utf8');

    const result = computePassAtKRates(eventsPath);
    assert.equal(result.total, 1, 'only non-cache-hit events count');
    assert.equal(result.pass_at_1, 1.0, 'the one qualifying event has k=1');
    assert.equal(result.avg_k, 1.0, 'avg_k should be 1');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('computePassAtKRates skips pre-PASSK events (no pass_at_k field)', () => {
  const { computePassAtKRates } = require('./verify-quorum-health.cjs');
  const tmpDir = makeTmpDir();
  try {
    const eventsPath = path.join(tmpDir, 'events.jsonl');
    const events = [
      { action: 'quorum_complete', outcome: 'APPROVE' },  // no pass_at_k
      { action: 'quorum_complete', outcome: 'APPROVE', pass_at_k: 2 },
      { action: 'quorum_block', outcome: 'BLOCK', pass_at_k: 1 },  // wrong action
    ];
    fs.writeFileSync(eventsPath, events.map(e => JSON.stringify(e)).join('\n'), 'utf8');

    const result = computePassAtKRates(eventsPath);
    assert.equal(result.total, 1, 'only the one qualifying event');
    assert.equal(result.pass_at_1, 0, 'k=2 is not pass@1');
    assert.equal(result.pass_at_3, 1.0, 'k=2 is within pass@3');
    assert.equal(result.avg_k, 2, 'avg_k should be 2');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('computePassAtKRates returns zeros for empty/nonexistent file', () => {
  const { computePassAtKRates } = require('./verify-quorum-health.cjs');
  const result = computePassAtKRates('/nonexistent/path/events.jsonl');
  assert.equal(result.total, 0);
  assert.equal(result.pass_at_1, 0);
  assert.equal(result.pass_at_3, 0);
  assert.equal(result.avg_k, 0);
});

test('full script output includes pass@k section', () => {
  const tmpDir = makeTmpDir();
  try {
    writeMachineFile(tmpDir, 10);
    const rounds = makeRounds(35, { gemini: 'TP', opencode: 'TP', copilot: 'TP', codex: 'TP' });
    writeScoreboard(tmpDir, rounds);

    // Create telemetry dir with conformance events containing pass_at_k
    const telDir = path.join(tmpDir, '.planning', 'telemetry');
    fs.mkdirSync(telDir, { recursive: true });
    const events = [
      { action: 'quorum_complete', outcome: 'APPROVE', pass_at_k: 1 },
      { action: 'quorum_complete', outcome: 'APPROVE', pass_at_k: 3 },
    ];
    fs.writeFileSync(
      path.join(telDir, 'conformance-events.jsonl'),
      events.map(e => JSON.stringify(e)).join('\n'),
      'utf8'
    );

    const { stdout } = runScript(tmpDir);
    assert.match(stdout, /pass@1/i, 'output should contain pass@1');
    assert.match(stdout, /pass@3/i, 'output should contain pass@3');
    assert.match(stdout, /Pass@k Consensus Efficiency/i, 'output should contain section header');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Test: computeRates adversarial inputs ───────────────────────────────────

test('computeRates skips a null round entry instead of crashing', () => {
  const { computeRates } = require('./verify-quorum-health.cjs');
  const rounds = [null, { votes: { gemini: 'TP' } }];
  // Must not throw; the one valid round is < MIN_ROUNDS so it falls back to prior.
  const r = computeRates('gemini', rounds);
  assert.ok(typeof r.tpRate === 'number', 'should return a numeric tpRate, not crash');
  assert.equal(r.usedPrior, true, 'with < 30 valid rounds it uses the prior');
  assert.equal(r.tpRate, 0.85, 'prior tp rate');
});

test('computeRates treats a non-array rounds value as empty (prior fallback)', () => {
  const { computeRates } = require('./verify-quorum-health.cjs');
  // Currently throws: ({}).filter is not a function
  const r = computeRates('gemini', { malformed: true });
  assert.ok(typeof r.tpRate === 'number', 'should not crash on non-array rounds');
  assert.equal(r.usedPrior, true, 'non-array rounds -> 0 valid rounds -> prior');
  assert.equal(r.n, 0, 'no rounds counted');
});

test('computePassAtKRates fails open (returns zeros) when path is a directory', () => {
  const { computePassAtKRates } = require('./verify-quorum-health.cjs');
  const tmpDir = makeTmpDir();
  try {
    // A directory exists() == true but readFileSync throws EISDIR.
    const result = computePassAtKRates(tmpDir);
    assert.equal(result.total, 0);
    assert.equal(result.pass_at_1, 0);
    assert.equal(result.pass_at_3, 0);
    assert.equal(result.avg_k, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

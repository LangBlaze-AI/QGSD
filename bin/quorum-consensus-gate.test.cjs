#!/usr/bin/env node
'use strict';
// bin/quorum-consensus-gate.test.cjs
// Unit tests for SIG-04: PRISM consensus probability gate.
// Requirements: SIG-04

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { execFileSync } = require('node:child_process');

const { checkConsensusGate, computeConsensusProbability, poissonBinomialCDF } = require('./quorum-consensus-gate.cjs');
const { parseIntStrict } = require('./parse-int-strict.cjs');

const GATE_CLI = path.join(__dirname, 'quorum-consensus-gate.cjs');

// Run the gate CLI in a clean cwd (so it falls back to prior rates) and capture
// exit code + stdout + stderr.
function runGate(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [GATE_CLI, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    };
  }
}

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consensus-gate-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: create a scoreboard JSON with given rates
function createScoreboard(tmpDir, rates) {
  const sbDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(sbDir, { recursive: true });
  const sbPath = path.join(sbDir, 'quorum-scoreboard.json');

  // Build rounds from rates
  const rounds = [];
  const slots = Object.keys(rates);
  // Create 20 rounds to give stable rates
  for (let i = 0; i < 20; i++) {
    const votes = {};
    for (const slot of slots) {
      // Simulate availability based on target rate
      votes[slot] = Math.random() < rates[slot] ? 'APPROVE' : 'UNAVAIL';
    }
    rounds.push({ date: '2026-03-01T00:00:00Z', votes });
  }

  fs.writeFileSync(sbPath, JSON.stringify({ rounds }));
  return sbPath;
}

// Helper: create a config JSON with given threshold
function createConfig(tmpDir, threshold) {
  const confDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(confDir, { recursive: true });
  const confPath = path.join(confDir, 'config.json');
  fs.writeFileSync(confPath, JSON.stringify({
    workflow: { consensus_probability_threshold: threshold },
  }));
  return confPath;
}

// ── poissonBinomialCDF tests ─────────────────────────────────────────────────

describe('poissonBinomialCDF', () => {
  test('returns 1.0 for k=0 (always at least 0 successes)', () => {
    const result = poissonBinomialCDF([0.5, 0.5, 0.5], 0);
    assert.ok(Math.abs(result - 1.0) < 1e-10, 'P(X >= 0) should be 1.0, got: ' + result);
  });

  test('returns correct probability for homogeneous case', () => {
    // 4 slots at p=0.85 each, k=2 (need at least 2 available)
    // P(X >= 2) = 1 - P(X=0) - P(X=1)
    // P(X=0) = (0.15)^4 = 0.00050625
    // P(X=1) = C(4,1) * (0.85)^1 * (0.15)^3 = 4 * 0.85 * 0.003375 = 0.01147500
    // P(X >= 2) = 1 - 0.00050625 - 0.01147500 = 0.98801875
    const expected = 1 - Math.pow(0.15, 4) - 4 * 0.85 * Math.pow(0.15, 3);
    const result = poissonBinomialCDF([0.85, 0.85, 0.85, 0.85], 2);
    assert.ok(Math.abs(result - expected) < 1e-6, 'Expected ~' + expected.toFixed(6) + ', got: ' + result.toFixed(6));
  });

  test('handles heterogeneous probabilities', () => {
    const result = poissonBinomialCDF([0.9, 0.8, 0.7, 0.6], 2);
    assert.ok(result > 0 && result < 1, 'Result should be between 0 and 1');
    // Should be greater than result for all slots at 0.6 (the lowest rate)
    const worstCase = poissonBinomialCDF([0.6, 0.6, 0.6, 0.6], 2);
    assert.ok(result > worstCase, 'Heterogeneous result should be > all-at-lowest-rate');
  });

  test('returns 0 when k > n (need more than available)', () => {
    const result = poissonBinomialCDF([0.5, 0.5], 3);
    assert.strictEqual(result, 0, 'P(X >= 3) with 2 trials should be 0');
  });
});

// ── computeConsensusProbability tests ────────────────────────────────────────

describe('computeConsensusProbability', () => {
  test('returns correct structure', () => {
    const result = computeConsensusProbability({ codex: 0.9, gemini: 0.8 }, 1);
    assert.ok(typeof result.probability === 'number', 'Should have probability');
    assert.strictEqual(result.slotCount, 2, 'Should have slotCount');
    assert.strictEqual(result.minQuorum, 1, 'Should have minQuorum');
    assert.ok(result.rates, 'Should have rates');
  });
});

// ── checkConsensusGate tests ─────────────────────────────────────────────────

describe('checkConsensusGate', () => {
  test('returns proceed when probability >= threshold', () => {
    // Use high availability rates with a low threshold
    const confPath = createConfig(tmpDir, 0.70);

    // Use nonexistent scoreboard so it falls back to priors (0.85)
    // Priors: 4 slots at 0.85, minQuorum=2 -> P ~ 0.988
    const result = checkConsensusGate({
      scoreboardPath: path.join(tmpDir, '.planning', 'nonexistent-scoreboard.json'),
      configPath: confPath,
      minQuorum: 2,
    });
    assert.strictEqual(result.action, 'proceed');
    assert.ok(result.probability >= 0.70, 'Probability should be >= 0.70');
  });

  test('returns defer when probability < threshold', () => {
    // Create config with very high threshold
    const confPath = createConfig(tmpDir, 0.9999);

    // Use priors (0.85) with minQuorum=4 (need ALL slots)
    // P(all 4 available at 0.85 each) = 0.85^4 = 0.522
    const result = checkConsensusGate({
      scoreboardPath: path.join(tmpDir, '.planning', 'nonexistent-scoreboard.json'),
      configPath: confPath,
      minQuorum: 4,
    });
    assert.strictEqual(result.action, 'defer');
    assert.ok(result.message.includes('WARNING'), 'Message should contain WARNING');
  });

  test('uses prior rates when scoreboard is missing', () => {
    const confPath = createConfig(tmpDir, 0.70);

    const result = checkConsensusGate({
      scoreboardPath: '/nonexistent/scoreboard.json',
      configPath: confPath,
      minQuorum: 2,
    });
    // Priors of 0.85 with minQuorum=2 should give P > 0.70
    assert.strictEqual(result.action, 'proceed');
  });

  test('reads threshold from config', () => {
    // Set a very high threshold (0.99) and use priors with moderate minQuorum
    const confPath = createConfig(tmpDir, 0.99);

    // Priors: 4 slots at 0.85, minQuorum=3
    // P(X >= 3) = P(3) + P(4) = C(4,3)*0.85^3*0.15 + 0.85^4
    //           = 4*0.614125*0.15 + 0.52200625 = 0.368475 + 0.522006 = 0.890481
    // 0.89 < 0.99, so should defer
    const result = checkConsensusGate({
      scoreboardPath: '/nonexistent/scoreboard.json',
      configPath: confPath,
      minQuorum: 3,
    });
    assert.strictEqual(result.action, 'defer', 'Should defer when P < 0.99 threshold');
  });

  test('runs in under 10ms', () => {
    const confPath = createConfig(tmpDir, 0.70);

    const start = performance.now();
    checkConsensusGate({
      scoreboardPath: '/nonexistent/scoreboard.json',
      configPath: confPath,
      minQuorum: 2,
    });
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 10, 'Should complete in under 10ms, took: ' + elapsed.toFixed(2) + 'ms');
  });
});

// ── parseIntStrict tests (Issue #204) ────────────────────────────────────────

describe('parseIntStrict', () => {
  test('parses clean non-negative integers', () => {
    assert.strictEqual(parseIntStrict('0'), 0);
    assert.strictEqual(parseIntStrict('3'), 3);
    assert.strictEqual(parseIntStrict('42'), 42);
    assert.strictEqual(parseIntStrict('  7 '), 7);
  });

  test('parses signed integers', () => {
    assert.strictEqual(parseIntStrict('-1'), -1);
    assert.strictEqual(parseIntStrict('+5'), 5);
  });

  test('returns null for non-integer / malformed input (no fail-open NaN)', () => {
    for (const bad of ['', '  ', 'abc', '2.5', '12abc', '0x10', 'NaN', 'Infinity', undefined, null, 3]) {
      assert.strictEqual(parseIntStrict(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

// ── CLI early-escalation: fail CLOSED on malformed --remaining-rounds (#204) ──

describe('early-escalation CLI --remaining-rounds validation', () => {
  test('non-numeric --remaining-rounds exits 2 and does NOT emit shouldEscalate:false / probability:null', () => {
    const res = runGate(['--remaining-rounds=foo'], tmpDir);
    assert.strictEqual(res.code, 2, 'should exit 2 on malformed input, got ' + res.code);
    assert.ok(!/shouldEscalate/.test(res.stdout), 'must not emit a result object on stdout');
    assert.ok(!/probability/.test(res.stdout), 'must not emit probability on stdout');
    assert.match(res.stderr, /Usage:/, 'should print a usage message to stderr');
    assert.match(res.stderr, /remaining-rounds/, 'usage should reference the flag');
  });

  test('empty --remaining-rounds value exits 2', () => {
    const res = runGate(['--remaining-rounds='], tmpDir);
    assert.strictEqual(res.code, 2);
    assert.ok(!/shouldEscalate/.test(res.stdout));
  });

  test('negative --remaining-rounds exits 2', () => {
    const res = runGate(['--remaining-rounds=-1'], tmpDir);
    assert.strictEqual(res.code, 2);
  });

  test('valid --remaining-rounds still works and emits a result', () => {
    // Priors (0.85 x4, minQuorum 2) over several rounds -> high P -> continue (exit 0).
    const res = runGate(['--remaining-rounds=3'], tmpDir);
    assert.ok(res.code === 0 || res.code === 1, 'valid input should exit 0 or 1, got ' + res.code);
    // stdout may be prefixed by run-prism diagnostic lines; the result JSON is the
    // trailing {...} object. Extract from the first '{' to the last '}'.
    const start = res.stdout.indexOf('{');
    const end = res.stdout.lastIndexOf('}');
    assert.ok(start !== -1 && end !== -1, 'expected a JSON result object on stdout');
    const parsed = JSON.parse(res.stdout.slice(start, end + 1));
    assert.strictEqual(typeof parsed.probability, 'number', 'probability must be a number, not null');
    assert.ok(!Number.isNaN(parsed.probability), 'probability must not be NaN');
    assert.strictEqual(parsed.remainingRounds, 3);
    assert.strictEqual(typeof parsed.shouldEscalate, 'boolean');
  });

  test('malformed --min-quorum exits 2', () => {
    const res = runGate(['--remaining-rounds=3', '--min-quorum=foo'], tmpDir);
    assert.strictEqual(res.code, 2);
    assert.match(res.stderr, /min-quorum/);
  });
});

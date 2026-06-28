#!/usr/bin/env node
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const {
  mannKendall,
  countOscillations,
  readTrendWindow,
  readLastSessionActions,
  updateVerdicts,
  WINDOW_SIZE,
  MIN_POINTS,
  Z_THRESHOLD,
  LAYER_DEPS,
  LAYER_KEYS,
} = require('./oscillation-detector.cjs');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = path.join(os.tmpdir(), 'osc-test-' + crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/** Build a minimal trend entry with per_layer values. */
function makeTrendEntry(perLayer, extra) {
  return {
    timestamp: new Date().toISOString(),
    run_id: crypto.randomUUID(),
    total_residual: 0,
    layer_total: 0,
    scope_change: null,
    fast_mode: false,
    per_layer: perLayer,
    gates: { a: null, b: null, c: null },
    ...extra,
  };
}

/** Write JSONL entries to a file. */
function writeJSONL(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

/** Build per_layer object with a specific layer set to a value, all others 0. */
function makePerLayer(overrides) {
  const pl = {};
  for (const key of LAYER_KEYS) {
    pl[key] = overrides[key] !== undefined ? overrides[key] : 0;
  }
  return pl;
}

// ── Mann-Kendall Tests ───────────────────────────────────────────────────────

describe('mannKendall', () => {
  it('detects decreasing trend', () => {
    const result = mannKendall([10, 9, 8, 7, 6, 5]);
    assert.equal(result.trend, 'DECREASING');
    assert.ok(result.Z < -Z_THRESHOLD, `Z=${result.Z} should be < -${Z_THRESHOLD}`);
    assert.ok(result.S < 0, 'S should be negative');
  });

  it('detects increasing trend', () => {
    const result = mannKendall([1, 2, 3, 4, 5, 6]);
    assert.equal(result.trend, 'INCREASING');
    assert.ok(result.Z > Z_THRESHOLD, `Z=${result.Z} should be > ${Z_THRESHOLD}`);
    assert.ok(result.S > 0, 'S should be positive');
  });

  it('detects stable trend (constant values)', () => {
    const result = mannKendall([5, 5, 5, 5, 5]);
    assert.equal(result.trend, 'STABLE');
    assert.equal(result.Z, 0);
    assert.equal(result.S, 0);
  });

  it('returns INSUFFICIENT_DATA for single value', () => {
    const result = mannKendall([1]);
    assert.equal(result.trend, 'INSUFFICIENT_DATA');
    assert.equal(result.Z, 0);
    assert.equal(result.S, 0);
  });

  it('returns INSUFFICIENT_DATA for empty array', () => {
    const result = mannKendall([]);
    assert.equal(result.trend, 'INSUFFICIENT_DATA');
  });

  it('returns STABLE for oscillating series (no net trend)', () => {
    const result = mannKendall([1, 3, 1, 3, 1, 3]);
    assert.equal(result.trend, 'STABLE');
  });
});

// ── countOscillations Tests ──────────────────────────────────────────────────

describe('countOscillations', () => {
  it('returns 0 for monotonic series', () => {
    assert.equal(countOscillations([1, 2, 3, 4]), 0);
  });

  it('counts sign changes in zigzag series', () => {
    // deltas: +2, -2, +2, -2 → 3 sign changes
    assert.equal(countOscillations([1, 3, 1, 3, 1]), 3);
  });

  it('ignores flat sections (zero deltas)', () => {
    // deltas: 0, +1, 0, -1 → only non-zero pairs are (+1, -1) → 1 sign change
    // But the zeros break the chain so: pairs checked are (0,+1) skip, (+1,0) skip, (0,-1) skip
    assert.equal(countOscillations([1, 1, 2, 2, 1]), 0);
  });

  it('returns 0 for fewer than 3 values', () => {
    assert.equal(countOscillations([1, 2]), 0);
    assert.equal(countOscillations([1]), 0);
    assert.equal(countOscillations([]), 0);
  });

  it('counts correctly with mixed flat and non-flat', () => {
    // deltas: +2, -1, +2, -1 → 3 sign changes
    assert.equal(countOscillations([1, 3, 2, 4, 3]), 3);
  });
});

// ── readTrendWindow Tests ────────────────────────────────────────────────────

describe('readTrendWindow', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmDir(tmpDir); });

  it('reads last N entries from JSONL', () => {
    const filePath = path.join(tmpDir, 'trend.jsonl');
    const entries = [];
    for (let i = 0; i < 25; i++) {
      entries.push({ index: i, per_layer: {} });
    }
    writeJSONL(filePath, entries);

    const result = readTrendWindow(filePath, 20);
    assert.equal(result.length, 20);
    assert.equal(result[0].index, 5);
    assert.equal(result[19].index, 24);
  });

  it('returns empty array for missing file', () => {
    const result = readTrendWindow(path.join(tmpDir, 'nonexistent.jsonl'), 20);
    assert.deepEqual(result, []);
  });

  it('returns empty array for empty file', () => {
    const filePath = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(filePath, '');
    assert.deepEqual(readTrendWindow(filePath, 20), []);
  });

  it('skips malformed lines', () => {
    const filePath = path.join(tmpDir, 'mixed.jsonl');
    fs.writeFileSync(filePath, [
      '{"valid":1}',
      'not json',
      '{"valid":2}',
      '{broken',
      '{"valid":3}',
    ].join('\n') + '\n');

    const result = readTrendWindow(filePath, 20);
    assert.equal(result.length, 3);
    assert.equal(result[0].valid, 1);
    assert.equal(result[2].valid, 3);
  });
});

// ── updateVerdicts Tests ─────────────────────────────────────────────────────

describe('updateVerdicts', () => {
  let tmpDir;
  let trendPath;
  let verdictsPath;
  let sessionsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    trendPath = path.join(tmpDir, 'solve-trend.jsonl');
    verdictsPath = path.join(tmpDir, 'oscillation-verdicts.json');
    sessionsDir = path.join(tmpDir, 'solve-sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => { rmDir(tmpDir); });

  it('marks all layers INSUFFICIENT_DATA with fewer than 5 entries', () => {
    const entries = [];
    for (let i = 0; i < 3; i++) {
      entries.push(makeTrendEntry(makePerLayer({})));
    }
    writeJSONL(trendPath, entries);

    const result = updateVerdicts({ root: tmpDir, trendPath, verdictsPath, sessionsDir });
    assert.equal(result.entry_count, 3);
    for (const key of LAYER_KEYS) {
      assert.equal(result.layers[key].trend, 'INSUFFICIENT_DATA');
      assert.equal(result.layers[key].blocked, false);
      assert.equal(result.layers[key].credits_remaining, 1);
    }
  });

  it('detects decreasing trend for a layer', () => {
    const entries = [];
    for (let i = 0; i < 6; i++) {
      entries.push(makeTrendEntry(makePerLayer({ r_to_f: 10 - i })));
    }
    writeJSONL(trendPath, entries);

    const result = updateVerdicts({ root: tmpDir, trendPath, verdictsPath, sessionsDir });
    assert.equal(result.layers.r_to_f.trend, 'DECREASING');
    assert.ok(result.layers.r_to_f.z_score < -Z_THRESHOLD);
  });

  it('consumes oscillation credit on direction change', () => {
    // First run: establish "down" direction
    const entries1 = [];
    for (let i = 0; i < 6; i++) {
      entries1.push(makeTrendEntry(makePerLayer({ r_to_f: 10 - i })));
    }
    writeJSONL(trendPath, entries1);
    const v1 = updateVerdicts({ root: tmpDir, trendPath, verdictsPath, sessionsDir });
    assert.equal(v1.layers.r_to_f.last_direction, 'down');
    assert.equal(v1.layers.r_to_f.credits_remaining, 1);

    // Second run: direction changes to "up"
    const entries2 = [];
    for (let i = 0; i < 6; i++) {
      entries2.push(makeTrendEntry(makePerLayer({ r_to_f: 4 + i })));
    }
    writeJSONL(trendPath, entries2);
    const v2 = updateVerdicts({ root: tmpDir, trendPath, verdictsPath, sessionsDir });
    assert.equal(v2.layers.r_to_f.last_direction, 'up');
    assert.equal(v2.layers.r_to_f.credits_remaining, 0);
  });

  it('blocks layer when credits exhausted after direction change', () => {
    // Run 1: establish "down"
    const entries1 = [];
    for (let i = 0; i < 6; i++) {
      entries1.push(makeTrendEntry(makePerLayer({ r_to_f: 10 - i })));
    }
    writeJSONL(trendPath, entries1);
    updateVerdicts({ root: tmpDir, trendPath, verdictsPath, sessionsDir });

    // Run 2: direction to "up" → credit consumed (0 remaining)
    const entries2 = [];
    for (let i = 0; i < 6; i++) {
      entries2.push(makeTrendEntry(makePerLayer({ r_to_f: 4 + i })));
    }
    writeJSONL(trendPath, entries2);
    const v2 = updateVerdicts({ root: tmpDir, trendPath, verdictsPath, sessionsDir });
    assert.equal(v2.layers.r_to_f.credits_remaining, 0);
    assert.equal(v2.layers.r_to_f.blocked, true);
  });

  it('cascade grace period prevents credit consumption', () => {
    // f_to_t depends on r_to_f and p_to_f
    // Run 1: establish "down" for f_to_t
    const entries1 = [];
    for (let i = 0; i < 6; i++) {
      entries1.push(makeTrendEntry(makePerLayer({ f_to_t: 10 - i })));
    }
    writeJSONL(trendPath, entries1);
    updateVerdicts({ root: tmpDir, trendPath, verdictsPath, sessionsDir });

    // Create a session file that mentions r_to_f remediation
    fs.writeFileSync(
      path.join(sessionsDir, 'solve-session-2026-03-10T12-00-00.md'),
      '# Session\n\nRemediated r_to_f layer with test stubs.\n'
    );

    // Run 2: direction to "up" for f_to_t — should NOT consume credit due to grace
    const entries2 = [];
    for (let i = 0; i < 6; i++) {
      entries2.push(makeTrendEntry(makePerLayer({ f_to_t: 4 + i })));
    }
    writeJSONL(trendPath, entries2);
    const v2 = updateVerdicts({ root: tmpDir, trendPath, verdictsPath, sessionsDir });
    assert.equal(v2.layers.f_to_t.grace_period, true);
    assert.equal(v2.layers.f_to_t.credits_remaining, 1, 'Credits should NOT be consumed during grace period');
    assert.equal(v2.layers.f_to_t.blocked, false);
  });

  it('filters out fast-mode entries (-1 values)', () => {
    const entries = [];
    for (let i = 0; i < 8; i++) {
      const val = i % 2 === 0 ? -1 : (10 - i); // alternating -1 and decreasing
      entries.push(makeTrendEntry(makePerLayer({ r_to_f: val })));
    }
    writeJSONL(trendPath, entries);

    const result = updateVerdicts({ root: tmpDir, trendPath, verdictsPath, sessionsDir });
    // Only 4 valid points (indices 1,3,5,7 → values 9,7,5,3), which is < MIN_POINTS=5
    assert.equal(result.layers.r_to_f.trend, 'INSUFFICIENT_DATA');
  });

  it('creates verdicts file on first run', () => {
    const entries = [];
    for (let i = 0; i < 6; i++) {
      entries.push(makeTrendEntry(makePerLayer({})));
    }
    writeJSONL(trendPath, entries);

    assert.ok(!fs.existsSync(verdictsPath), 'Verdicts file should not exist before first run');
    updateVerdicts({ root: tmpDir, trendPath, verdictsPath, sessionsDir });
    assert.ok(fs.existsSync(verdictsPath), 'Verdicts file should be created');

    const written = JSON.parse(fs.readFileSync(verdictsPath, 'utf8'));
    assert.ok(written.generated);
    assert.equal(written.window_size, WINDOW_SIZE);
    assert.ok(written.layers);
  });

  it('classifies OSCILLATING when oscCount >= 2 and Mann-Kendall STABLE', () => {
    // Series that oscillates but has no net trend
    const entries = [];
    const oscValues = [1, 5, 1, 5, 1, 5, 1, 5];
    for (let i = 0; i < oscValues.length; i++) {
      entries.push(makeTrendEntry(makePerLayer({ r_to_f: oscValues[i] })));
    }
    writeJSONL(trendPath, entries);

    const result = updateVerdicts({ root: tmpDir, trendPath, verdictsPath, sessionsDir });
    assert.equal(result.layers.r_to_f.trend, 'OSCILLATING');
    assert.ok(result.layers.r_to_f.oscillation_count >= 2);
  });

  it('has all 20 LAYER_KEYS in verdict output', () => {
    const entries = [];
    for (let i = 0; i < 6; i++) {
      entries.push(makeTrendEntry(makePerLayer({})));
    }
    writeJSONL(trendPath, entries);

    const result = updateVerdicts({ root: tmpDir, trendPath, verdictsPath, sessionsDir });
    assert.equal(Object.keys(result.layers).length, 20);
    for (const key of LAYER_KEYS) {
      assert.ok(result.layers[key], `Missing layer: ${key}`);
    }
  });

  it('does not crash on a JSON null entry in the trend file', () => {
    const lines = [];
    for (let i = 0; i < 5; i++) {
      lines.push(JSON.stringify(makeTrendEntry(makePerLayer({ r_to_f: 10 - i }))));
    }
    lines.splice(2, 0, 'null'); // valid JSON that parses to null, not a malformed line
    fs.mkdirSync(path.dirname(trendPath), { recursive: true });
    fs.writeFileSync(trendPath, lines.join('\n') + '\n');

    let result;
    assert.doesNotThrow(() => {
      result = updateVerdicts({ root: tmpDir, trendPath, verdictsPath, sessionsDir });
    });
    assert.ok(result.layers.r_to_f, 'should still produce a verdict for r_to_f');
  });

  it('does not crash when called with null options', () => {
    const cwd = process.cwd();
    try {
      process.chdir(tmpDir); // ensure default root resolves into the disposable tmp dir
      assert.doesNotThrow(() => updateVerdicts(null));
    } finally {
      process.chdir(cwd);
    }
  });
});

// ── readLastSessionActions Tests ─────────────────────────────────────────────

describe('readLastSessionActions', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmDir(tmpDir); });

  it('returns empty set for missing directory', () => {
    const result = readLastSessionActions(path.join(tmpDir, 'nonexistent'));
    assert.equal(result.size, 0);
  });

  it('returns empty set for empty directory', () => {
    const dir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const result = readLastSessionActions(dir);
    assert.equal(result.size, 0);
  });

  it('detects layer names in session file', () => {
    const dir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'solve-session-2026-03-10T10-00-00.md'),
      '# Session\n\nRemediated r_to_f and fixed f_to_t with test stubs.\n'
    );

    const result = readLastSessionActions(dir);
    assert.ok(result.has('r_to_f'));
    assert.ok(result.has('f_to_t'));
  });
});

// ── Constants Tests ──────────────────────────────────────────────────────────

describe('constants', () => {
  it('exports expected constants', () => {
    assert.equal(WINDOW_SIZE, 20);
    assert.equal(MIN_POINTS, 5);
    assert.equal(Z_THRESHOLD, 1.96);
  });

  it('LAYER_KEYS has 20 entries', () => {
    assert.equal(LAYER_KEYS.length, 20);
  });

  it('LAYER_DEPS has valid upstream references', () => {
    for (const [downstream, upstreams] of Object.entries(LAYER_DEPS)) {
      assert.ok(LAYER_KEYS.includes(downstream), `${downstream} not in LAYER_KEYS`);
      for (const u of upstreams) {
        assert.ok(LAYER_KEYS.includes(u), `Upstream ${u} of ${downstream} not in LAYER_KEYS`);
      }
    }
  });
});

// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
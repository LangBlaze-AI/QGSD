'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

// Wave 0 RED stubs for LOOP-03: sensitivity-sweep-feedback.cjs
// These tests define the contract. They will fail until Plan 03 implements the script.

test('LOOP-03: sensitivity-sweep-feedback.cjs exits 0 when all sweep records are inconclusive', () => {
  // Set up tmpDir with a sensitivity-report.ndjson containing only inconclusive records
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-feedback-test-'));
  try {
    const formalDir = path.join(tmpDir, '.planning', 'formal');
    fs.mkdirSync(formalDir, { recursive: true });
    const record = JSON.stringify({
      tool: 'run-sensitivity-sweep',
      formalism: 'prism',
      result: 'inconclusive',
      check_id: 'sens:prism-tp-rate',
      metadata: { parameter: 'tp_rate', value: 0.5, baseline: 0.85, baseline_result: 'pass', delta: 'stable' }
    });
    fs.writeFileSync(path.join(formalDir, 'sensitivity-report.ndjson'), record + '\n', 'utf8');

    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'sensitivity-sweep-feedback.cjs')
    ], { encoding: 'utf8', cwd: tmpDir, timeout: 10000 });

    // RED: script does not exist yet — will fail with ENOENT or non-zero
    assert.strictEqual(result.status, 0, 'LOOP-03: sensitivity-sweep-feedback.cjs must exit 0 when all records are inconclusive. Script not yet implemented.');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('LOOP-03: sensitivity-sweep-feedback.cjs exits 0 when empirical rate is within sweep range', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-feedback-test2-'));
  try {
    const formalDir = path.join(tmpDir, '.planning', 'formal');
    const prismDir = path.join(formalDir, 'prism');
    fs.mkdirSync(prismDir, { recursive: true });

    // Write a pass record for tp_rate=0.75 — within sweep range, no deviation
    const record = JSON.stringify({
      tool: 'run-sensitivity-sweep', formalism: 'prism', result: 'pass',
      check_id: 'sens:prism-tp-rate',
      metadata: { parameter: 'tp_rate', value: 0.75, baseline: 0.85, baseline_result: 'pass', delta: 'stable' }
    });
    fs.writeFileSync(path.join(formalDir, 'sensitivity-report.ndjson'), record + '\n', 'utf8');

    // Write a scoreboard stub so empirical rate is 0.80 — close to 0.75 (within threshold)
    fs.writeFileSync(path.join(tmpDir, 'quorum-scoreboard.md'),
      '## Scoreboard\n| Slot | Wins | Losses |\n|------|------|--------|\n| claude-1 | 8 | 2 |\n', 'utf8');

    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'sensitivity-sweep-feedback.cjs')
    ], { encoding: 'utf8', cwd: tmpDir, timeout: 10000 });

    assert.strictEqual(result.status, 0,
      'LOOP-03: script must exit 0 when empirical rate is within sweep range. Not yet implemented.');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('LOOP-03: sensitivity-sweep-feedback.cjs exits non-zero when new threshold violation detected', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-feedback-test3-'));
  try {
    const formalDir = path.join(tmpDir, '.planning', 'formal');
    const prismDir = path.join(formalDir, 'prism');
    fs.mkdirSync(prismDir, { recursive: true });

    // Write a fail record at tp_rate=0.50 with delta=flip-to-fail
    const record = JSON.stringify({
      tool: 'run-sensitivity-sweep', formalism: 'prism', result: 'fail',
      check_id: 'sens:prism-tp-rate',
      metadata: { parameter: 'tp_rate', value: 0.5, baseline: 0.85, baseline_result: 'pass', delta: 'flip-to-fail' }
    });
    fs.writeFileSync(path.join(formalDir, 'sensitivity-report.ndjson'), record + '\n', 'utf8');

    // Write scoreboard with empirical rate of 0.40 — below minimum tested (0.5) = deviation > threshold
    fs.writeFileSync(path.join(tmpDir, 'quorum-scoreboard.md'),
      '## Scoreboard\n| Slot | Wins | Losses |\n|------|------|--------|\n| claude-1 | 4 | 6 |\n', 'utf8');

    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'sensitivity-sweep-feedback.cjs')
    ], { encoding: 'utf8', cwd: tmpDir, timeout: 15000 });

    assert.notStrictEqual(result.status, 0,
      'LOOP-03: script must exit non-zero when threshold violation detected. Not yet implemented.');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('LOOP-03: exits 0 (fail-open) when a sweep record line parses to JSON null', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-feedback-null-'));
  try {
    const formalDir = path.join(tmpDir, '.planning', 'formal');
    fs.mkdirSync(formalDir, { recursive: true });
    // Corrupt NDJSON: a literal JSON null record line
    fs.writeFileSync(path.join(formalDir, 'sensitivity-report.ndjson'), 'null\n', 'utf8');

    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'sensitivity-sweep-feedback.cjs')
    ], { encoding: 'utf8', cwd: tmpDir, timeout: 10000 });

    assert.strictEqual(result.status, 0,
      'must fail-open (exit 0) on a null NDJSON record, not crash with an uncaught TypeError');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('LOOP-03: a tp_rate record missing metadata.value does not fabricate a deviation', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-feedback-noval-'));
  try {
    const formalDir = path.join(tmpDir, '.planning', 'formal');
    fs.mkdirSync(formalDir, { recursive: true });
    // Actionable PRISM tp_rate record but metadata.value is absent
    const record = JSON.stringify({
      tool: 'run-sensitivity-sweep', formalism: 'prism', result: 'pass',
      check_id: 'sens:prism-tp-rate',
      metadata: { parameter: 'tp_rate', baseline: 0.85, baseline_result: 'pass', delta: 'stable' }
    });
    fs.writeFileSync(path.join(formalDir, 'sensitivity-report.ndjson'), record + '\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'quorum-scoreboard.md'),
      '## Scoreboard\n| Slot | Wins | Losses |\n|------|------|--------|\n| claude-1 | 8 | 2 |\n', 'utf8');

    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'sensitivity-sweep-feedback.cjs')
    ], { encoding: 'utf8', cwd: tmpDir, timeout: 15000 });

    assert.strictEqual(result.status, 0, 'must exit 0 — a value-less record is not actionable data');
    assert.ok(!/Deviation detected/.test(result.stdout || ''),
      'must not report a spurious deviation (and must not re-run PRISM) from a value-less record');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

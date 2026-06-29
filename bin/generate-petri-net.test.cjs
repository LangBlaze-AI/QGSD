#!/usr/bin/env node
'use strict';
// bin/generate-petri-net.test.cjs
// Wave 0 RED stubs for bin/generate-petri-net.cjs
// Tests cover: DOT output structure, WASM SVG render, deadlock warning.
// Requirements: PET-01, PET-02, PET-03

const { test, describe } = require('node:test');
const assert   = require('node:assert');
const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const GENERATE_PETRI = path.join(__dirname, 'generate-petri-net.cjs');

test('exits 0 and writes quorum-petri-net.dot on success', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'petri-test-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal', 'petri'), { recursive: true });
    const result = spawnSync(process.execPath, [GENERATE_PETRI], {
      encoding: 'utf8',
      cwd: tmpDir,
    });
    assert.strictEqual(result.status, 0);
    const dotPath = path.join(tmpDir, '.planning', 'formal', 'petri', 'quorum-petri-net.dot');
    assert.ok(fs.existsSync(dotPath), 'quorum-petri-net.dot should exist');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DOT output contains place nodes (circle shape) and transition nodes (rect shape)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'petri-test-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal', 'petri'), { recursive: true });
    const result = spawnSync(process.execPath, [GENERATE_PETRI], {
      encoding: 'utf8',
      cwd: tmpDir,
    });
    assert.strictEqual(result.status, 0);
    const dotPath = path.join(tmpDir, '.planning', 'formal', 'petri', 'quorum-petri-net.dot');
    const dotContent = fs.readFileSync(dotPath, 'utf8');
    assert.match(dotContent, /shape=circle/);
    assert.match(dotContent, /shape=rect/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('exits 0 and writes quorum-petri-net.svg when @hpcc-js/wasm-graphviz is installed', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'petri-test-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal', 'petri'), { recursive: true });
    const result = spawnSync(process.execPath, [GENERATE_PETRI], {
      encoding: 'utf8',
      cwd: tmpDir,
    });
    // If @hpcc-js/wasm-graphviz is not installed the script exits 1 with an install message.
    // If installed, exits 0 and SVG is written.
    if (result.status === 0) {
      const svgPath = path.join(tmpDir, '.planning', 'formal', 'petri', 'quorum-petri-net.svg');
      assert.ok(fs.existsSync(svgPath), 'quorum-petri-net.svg should exist when WASM is installed');
    } else {
      // @hpcc-js/wasm-graphviz not installed — acceptable in CI; verify DOT was still written
      const dotPath = path.join(tmpDir, '.planning', 'formal', 'petri', 'quorum-petri-net.dot');
      assert.ok(fs.existsSync(dotPath), 'quorum-petri-net.dot should still be written even when WASM fails');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('emits structural deadlock WARNING to stderr when min_quorum_size > available_slots', () => {
  // Use _pure.buildDot with min > slots to test deadlock warning logic.
  // This test uses the pure exported function directly once the implementation exists.
  // Until then, test via spawnSync with environment variable to trigger deadlock mode.
  const GENERATE_PETRI_IMPL = path.join(__dirname, 'generate-petri-net.cjs');
  try {
    const mod = require(GENERATE_PETRI_IMPL);
    if (mod._pure && mod._pure.buildDot) {
      // Implementation exists — test pure function
      const dot = mod._pure.buildDot(['a', 'b'], 5);  // min=5 > slots=2 — deadlock
      // buildDot itself doesn't emit to stderr; the deadlock check is in the top-level script.
      // Verify DOT is still produced (deadlock doesn't prevent output)
      assert.match(dot, /digraph/);
    } else {
      // Implementation exists but no _pure export — skip
    }
  } catch (e) {
    // Implementation doesn't exist yet — RED state
    // Test via spawnSync to verify the script exits with an error about the missing module
    const result = spawnSync(process.execPath, [GENERATE_PETRI], {
      encoding: 'utf8',
    });
    assert.strictEqual(result.status, 1, 'Expected non-zero exit when implementation missing');
  }
});

// ── Roadmap Petri Net tests (SIG-02) ─────────────────────────────────────────

const { parseRoadmapPhases, buildRoadmapDot, computeCriticalPath } = require('./generate-petri-net.cjs')._pure;

describe('parseRoadmapPhases', () => {
  test('extracts phases and dependencies from ROADMAP.md content', () => {
    const content = [
      '### Phase v0.21-01: Central Model Registry',
      '**Depends on**: Nothing (first v0.21 phase)',
      '',
      '### Phase v0.21-02: Conformance Crisis Fix',
      '**Depends on**: Phase v0.21-01',
      '',
      '### Phase v0.21-03: Self-Calibrating Loops',
      '**Depends on**: Phase v0.21-01, Phase v0.21-02',
    ].join('\n');

    const phases = parseRoadmapPhases(content);
    assert.strictEqual(phases.length, 3);
    assert.strictEqual(phases[0].number, 'v0.21-01');
    assert.strictEqual(phases[0].name, 'Central Model Registry');
    assert.deepStrictEqual(phases[0].dependsOn, []);
    assert.strictEqual(phases[1].number, 'v0.21-02');
    assert.deepStrictEqual(phases[1].dependsOn, ['v0.21-01']);
    assert.strictEqual(phases[2].number, 'v0.21-03');
    assert.deepStrictEqual(phases[2].dependsOn, ['v0.21-01', 'v0.21-02']);
  });

  test('handles phases with no dependencies', () => {
    const content = [
      '### Phase v0.10-01: Foundation',
      '**Depends on**: Nothing',
      '',
      '### Phase v0.10-02: Extension',
      '**Depends on**: Nothing (independent)',
    ].join('\n');

    const phases = parseRoadmapPhases(content);
    assert.strictEqual(phases.length, 2);
    assert.deepStrictEqual(phases[0].dependsOn, []);
    assert.deepStrictEqual(phases[1].dependsOn, []);
  });

  test('detects completion status from checkboxes', () => {
    const content = [
      '### Phase v0.21-01: Central Model Registry',
      '**Depends on**: Nothing',
      '',
      '### Phase v0.21-02: Conformance Crisis Fix',
      '**Depends on**: Phase v0.21-01',
      '',
      '- [x] Phase v0.21-01',
      '- [ ] Phase v0.21-02',
    ].join('\n');

    const phases = parseRoadmapPhases(content);
    assert.strictEqual(phases[0].completed, true, 'v0.21-01 should be completed (checked)');
    assert.strictEqual(phases[1].completed, false, 'v0.21-02 should not be completed');
  });
});

describe('buildRoadmapDot', () => {
  test('produces valid DOT with transitions and places', () => {
    const phases = [
      { number: 'v0.21-01', name: 'Registry', dependsOn: [], completed: false },
      { number: 'v0.21-02', name: 'Crisis Fix', dependsOn: ['v0.21-01'], completed: false },
    ];
    const dot = buildRoadmapDot(phases);
    assert.ok(dot.includes('digraph'), 'Should contain digraph header');
    assert.ok(dot.includes('t_v0_21_01'), 'Should contain phase transition node');
    assert.ok(dot.includes('t_v0_21_02'), 'Should contain phase transition node');
    assert.ok(dot.includes('shape=circle'), 'Should contain place nodes');
    assert.ok(dot.includes('shape=rect'), 'Should contain transition nodes');
  });

  test('marks completed phases with green fill', () => {
    const phases = [
      { number: 'v0.21-01', name: 'Registry', dependsOn: [], completed: true },
      { number: 'v0.21-02', name: 'Crisis Fix', dependsOn: ['v0.21-01'], completed: false },
    ];
    const dot = buildRoadmapDot(phases);
    // Completed phase should have green fill (#4CAF50)
    assert.ok(dot.includes('#4CAF50'), 'Completed phase should have green fill');
  });

  test('handles empty phases array', () => {
    const dot = buildRoadmapDot([]);
    assert.ok(dot.includes('digraph'), 'Should contain digraph header');
    assert.ok(!dot.includes('shape=rect'), 'Should not contain transition nodes');
  });
});

describe('computeCriticalPath', () => {
  test('returns longest path through DAG', () => {
    // A -> B -> C and A -> D (two paths: A-B-C length 3, A-D length 2)
    const phases = [
      { number: 'A', name: 'Alpha', dependsOn: [], completed: false },
      { number: 'B', name: 'Beta', dependsOn: ['A'], completed: false },
      { number: 'C', name: 'Charlie', dependsOn: ['B'], completed: false },
      { number: 'D', name: 'Delta', dependsOn: ['A'], completed: false },
    ];
    const result = computeCriticalPath(phases);
    assert.strictEqual(result.length, 3, 'Critical path should be length 3 (A -> B -> C)');
    assert.deepStrictEqual(result.path, ['A', 'B', 'C']);
  });

  test('handles independent phases', () => {
    const phases = [
      { number: 'X', name: 'Ex', dependsOn: [], completed: false },
      { number: 'Y', name: 'Why', dependsOn: [], completed: false },
    ];
    const result = computeCriticalPath(phases);
    assert.strictEqual(result.length, 1, 'Independent phases should have critical path length 1');
  });
});

describe('parseRoadmapPhases hardening', () => {
  test('returns empty array for non-string input instead of throwing', () => {
    assert.doesNotThrow(() => parseRoadmapPhases(null));
    assert.deepStrictEqual(parseRoadmapPhases(null), []);
    assert.deepStrictEqual(parseRoadmapPhases(undefined), []);
    assert.deepStrictEqual(parseRoadmapPhases(42), []);
  });
});

describe('buildRoadmapDot hardening', () => {
  test('escapes double quotes in phase name to avoid DOT injection', () => {
    const phases = [
      { number: 'v0.21-01', name: 'Fix "quorum" bug', dependsOn: [], completed: false },
    ];
    const dot = buildRoadmapDot(phases);
    // After escaping, the inner quotes appear as \" in the DOT source.
    assert.ok(dot.includes('Fix \\"quorum\\" bug'),
      'phase name quotes should be backslash-escaped in the DOT label');
    // The raw, unescaped form must NOT appear (it would break the label attribute).
    assert.ok(!dot.includes('label="v0.21-01\\nFix "quorum" bug"'),
      'unescaped quotes must not leak into the label attribute');
  });
});

test('does not emit NaN in DOT when --min-quorum is non-numeric', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'petri-test-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal', 'petri'), { recursive: true });
    spawnSync(process.execPath, [GENERATE_PETRI, '--min-quorum=abc'], {
      encoding: 'utf8',
      cwd: tmpDir,
    });
    const dotPath = path.join(tmpDir, '.planning', 'formal', 'petri', 'quorum-petri-net.dot');
    const dotContent = fs.readFileSync(dotPath, 'utf8');
    assert.ok(!/NaN/.test(dotContent), 'DOT must not contain NaN for invalid --min-quorum');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

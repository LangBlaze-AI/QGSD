'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

// Wave 0 RED stubs for LOOP-04: propose-debug-invariants.cjs
// These tests define the contract. They will fail until Plan 04 implements the script.

test('LOOP-04: propose-debug-invariants.cjs --non-interactive exits 0 with proposals printed', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propose-invariants-test-'));
  try {
    // Create a minimal debug artifact at the expected location
    const planningDir = path.join(tmpDir, '.planning', 'quick');
    fs.mkdirSync(planningDir, { recursive: true });
    const debugArtifact = [
      '# Debug Session',
      '## bundle',
      'Phase: DECIDING',
      'State transition: IDLE -> DECIDING -> COMPLETE',
      '## worker responses',
      'root_cause: quorum_block fired while phase=DECIDING',
      'Invariant candidate: phase=IDLE => quorum_block not yet fired',
    ].join('\n');
    fs.writeFileSync(path.join(planningDir, 'quorum-debug-latest.md'), debugArtifact, 'utf8');

    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'propose-debug-invariants.cjs'),
      '--non-interactive'
    ], { encoding: 'utf8', cwd: tmpDir, timeout: 10000 });

    // RED: script does not exist yet
    assert.strictEqual(result.status, 0,
      'LOOP-04: propose-debug-invariants.cjs --non-interactive must exit 0. Not yet implemented.');
    assert.ok(result.stdout.length > 0,
      'LOOP-04: must print at least one proposed invariant candidate to stdout. Not yet implemented.');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('LOOP-04: propose-debug-invariants.cjs --non-interactive prints valid TLA+ PROPERTY format', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propose-invariants-test2-'));
  try {
    const planningDir = path.join(tmpDir, '.planning', 'quick');
    fs.mkdirSync(planningDir, { recursive: true });
    const debugArtifact = '# Debug\n## bundle\nIDLE -> DECIDING\n## worker responses\nroot_cause: guard failed\n';
    fs.writeFileSync(path.join(planningDir, 'quorum-debug-latest.md'), debugArtifact, 'utf8');

    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'propose-debug-invariants.cjs'),
      '--non-interactive'
    ], { encoding: 'utf8', cwd: tmpDir, timeout: 10000 });

    assert.strictEqual(result.status, 0, 'LOOP-04: must exit 0. Not yet implemented.');
    // Proposed properties should contain TLA+ keywords
    assert.ok(
      result.stdout.includes('PROPERTY') || result.stdout.includes('INVARIANT'),
      'LOOP-04: output must contain TLA+ PROPERTY or INVARIANT keyword. Not yet implemented.'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('LOOP-04: propose-debug-invariants.cjs exits 0 when debug artifact does not exist', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propose-invariants-test3-'));
  try {
    // No debug artifact — script must handle gracefully (fail-open)
    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'propose-debug-invariants.cjs'),
      '--non-interactive'
    ], { encoding: 'utf8', cwd: tmpDir, timeout: 10000 });

    assert.strictEqual(result.status, 0,
      'LOOP-04: must exit 0 (fail-open) when debug artifact is absent. Not yet implemented.');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('LOOP-04: mineTransitions captures chained transitions (A -> B -> C yields the B->C hint)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propose-invariants-chain-'));
  try {
    const planningDir = path.join(tmpDir, '.planning', 'quick');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(
      path.join(planningDir, 'quorum-debug-latest.md'),
      'State transition: IDLE -> DECIDING -> COMPLETE\n',
      'utf8'
    );

    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'propose-debug-invariants.cjs'),
      '--non-interactive'
    ], { encoding: 'utf8', cwd: tmpDir, timeout: 10000 });

    assert.strictEqual(result.status, 0, 'must exit 0 (fail-open)');
    assert.ok(result.stdout.includes('TransitionHint_IDLE_to_DECIDING'),
      'must propose the first transition IDLE->DECIDING');
    assert.ok(result.stdout.includes('TransitionHint_DECIDING_to_COMPLETE'),
      'must ALSO propose the chained transition DECIDING->COMPLETE (currently dropped)');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

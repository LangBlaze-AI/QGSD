#!/usr/bin/env node
// bin/task-envelope.test.cjs
// TDD test suite for bin/task-envelope.cjs
// Uses node:test + node:assert/strict
// Tests envelope validation, CLI commands, and atomic writes

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// Import the module under test
const { validateEnvelope, ENVELOPE_SCHEMA } = require('./task-envelope.cjs');

// Helper: create isolated tmpDir with .planning/phases structure
function setupTempPhase(phaseId) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `nf-envelope-`));
  const phaseDir = path.join(tmpDir, '.planning', 'phases', phaseId);
  fs.mkdirSync(phaseDir, { recursive: true });
  return { tmpDir, phaseDir };
}

// ENB-TC1: validateEnvelope — valid envelope passes
test('ENB-TC1: validateEnvelope accepts valid envelope with required fields', async (t) => {
  const envelope = {
    schema_version: '1',
    phase: 'v0.18-03',
    created_at: '2026-02-27T12:00:00Z',
    risk_level: 'medium',
    research: {
      objective: 'test objective',
      constraints: 'test constraints',
      target_files: []
    }
  };
  const result = validateEnvelope(envelope);
  assert.strictEqual(result.valid, true);
  assert.deepEqual(result.errors, []);
});

// ENB-TC2: validateEnvelope — invalid schema_version fails
test('ENB-TC2: validateEnvelope rejects invalid schema_version', async (t) => {
  const envelope = {
    schema_version: '2',
    phase: 'v0.18-03',
    risk_level: 'medium'
  };
  const result = validateEnvelope(envelope);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('schema_version')));
});

// ENB-TC3: validateEnvelope — invalid risk_level fails
test('ENB-TC3: validateEnvelope rejects invalid risk_level', async (t) => {
  const envelope = {
    schema_version: '1',
    phase: 'v0.18-03',
    risk_level: 'CRITICAL'
  };
  const result = validateEnvelope(envelope);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('risk_level')));
});

// ENB-TC4: validateEnvelope — invalid phase regex fails
test('ENB-TC4: validateEnvelope rejects invalid phase format', async (t) => {
  const envelope = {
    schema_version: '1',
    phase: 'invalid-phase',
    risk_level: 'medium'
  };
  const result = validateEnvelope(envelope);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('phase')));
});

// ENB-TC5: init command creates envelope file with correct fields
test('ENB-TC5: init command creates envelope file with correct fields', async (t) => {
  const { tmpDir, phaseDir } = setupTempPhase('v0.18-03-test');
  try {
    const result = spawnSync('node', [
      path.join(process.cwd(), 'bin', 'task-envelope.cjs'),
      'init',
      '--phase', 'v0.18-03-test',
      '--objective', 'Test objective',
      '--constraints', 'Test constraints',
      '--risk-level', 'low'
    ], {
      cwd: tmpDir,
      encoding: 'utf8'
    });

    assert.strictEqual(result.status, 0, `Should exit with 0. stderr: ${result.stderr}`);

    const envelopePath = path.join(phaseDir, 'task-envelope.json');
    assert.ok(fs.existsSync(envelopePath), 'Envelope file should exist');

    const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
    assert.strictEqual(envelope.schema_version, '1');
    assert.strictEqual(envelope.phase, 'v0.18-03-test');
    assert.strictEqual(envelope.risk_level, 'low');
    assert.strictEqual(envelope.research.objective, 'Test objective');
    assert.strictEqual(envelope.research.constraints, 'Test constraints');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ENB-TC6: init command with invalid risk-level writes "medium" + stderr warning
test('ENB-TC6: init command with invalid risk-level writes medium + stderr warning', async (t) => {
  const { tmpDir, phaseDir } = setupTempPhase('v0.18-03-test-2');
  try {
    const result = spawnSync('node', [
      path.join(process.cwd(), 'bin', 'task-envelope.cjs'),
      'init',
      '--phase', 'v0.18-03-test-2',
      '--objective', 'Test',
      '--risk-level', 'CRITICAL'
    ], {
      cwd: tmpDir,
      encoding: 'utf8'
    });

    // Should succeed but with warning
    assert.strictEqual(result.status, 0, `Should exit with 0. stderr: ${result.stderr}`);
    assert.ok(result.stderr.includes('WARNING') || result.stderr.includes('invalid'), 'Should warn about invalid risk_level');

    const envelopePath = path.join(phaseDir, 'task-envelope.json');
    const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
    assert.strictEqual(envelope.risk_level, 'medium', 'Should fallback to medium');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ENB-TC7: update --section plan preserves research section
test('ENB-TC7: update --section plan preserves research section', async (t) => {
  const { tmpDir, phaseDir } = setupTempPhase('v0.18-03-test-3');
  try {
    // First, init with research section
    spawnSync('node', [
      path.join(process.cwd(), 'bin', 'task-envelope.cjs'),
      'init',
      '--phase', 'v0.18-03-test-3',
      '--objective', 'Original objective',
      '--constraints', 'Original constraints',
      '--risk-level', 'medium'
    ], {
      cwd: tmpDir,
      encoding: 'utf8'
    });

    // Now update with plan section
    const result = spawnSync('node', [
      path.join(process.cwd(), 'bin', 'task-envelope.cjs'),
      'update',
      '--section', 'plan',
      '--phase', 'v0.18-03-test-3',
      '--plan-path', 'v0.18-03-test-3-PLAN.md',
      '--key-decisions', 'decision1,decision2',
      '--wave-count', '2'
    ], {
      cwd: tmpDir,
      encoding: 'utf8'
    });

    assert.strictEqual(result.status, 0, `Should exit with 0. stderr: ${result.stderr}`);

    const envelopePath = path.join(phaseDir, 'task-envelope.json');
    const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));

    // Verify research section is preserved
    assert.strictEqual(envelope.research.objective, 'Original objective');
    assert.strictEqual(envelope.research.constraints, 'Original constraints');

    // Verify plan section is added
    assert.ok(envelope.plan);
    assert.strictEqual(envelope.plan.plan_path, 'v0.18-03-test-3-PLAN.md');
    assert.deepEqual(envelope.plan.key_decisions, ['decision1', 'decision2']);
    assert.strictEqual(envelope.plan.wave_count, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ENB-TC8: update --section plan on missing envelope creates envelope with plan section
test('ENB-TC8: update --section plan on missing envelope creates envelope with plan section', async (t) => {
  const { tmpDir, phaseDir } = setupTempPhase('v0.18-03-test-4');
  try {
    // Call update without prior init
    const result = spawnSync('node', [
      path.join(process.cwd(), 'bin', 'task-envelope.cjs'),
      'update',
      '--section', 'plan',
      '--phase', 'v0.18-03-test-4',
      '--plan-path', 'v0.18-03-test-4-PLAN.md',
      '--key-decisions', 'decision1'
    ], {
      cwd: tmpDir,
      encoding: 'utf8'
    });

    assert.strictEqual(result.status, 0, `Should exit with 0. stderr: ${result.stderr}`);

    const envelopePath = path.join(phaseDir, 'task-envelope.json');
    const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));

    // Verify envelope was created with basic structure
    assert.strictEqual(envelope.schema_version, '1');
    assert.strictEqual(envelope.phase, 'v0.18-03-test-4');

    // Verify plan section exists
    assert.ok(envelope.plan);
    assert.strictEqual(envelope.plan.plan_path, 'v0.18-03-test-4-PLAN.md');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Additional test: ENVELOPE_SCHEMA exported
test('ENB-TC9: ENVELOPE_SCHEMA is exported', async (t) => {
  assert.ok(ENVELOPE_SCHEMA, 'ENVELOPE_SCHEMA must be exported');
  assert.ok(typeof ENVELOPE_SCHEMA === 'object', 'ENVELOPE_SCHEMA must be an object');
});

// Additional test: read command
test('ENB-TC10: read command outputs envelope as JSON', async (t) => {
  const { tmpDir, phaseDir } = setupTempPhase('v0.18-03-test-5');
  try {
    // Init first
    spawnSync('node', [
      path.join(process.cwd(), 'bin', 'task-envelope.cjs'),
      'init',
      '--phase', 'v0.18-03-test-5',
      '--objective', 'Test read',
      '--risk-level', 'high'
    ], {
      cwd: tmpDir,
      encoding: 'utf8'
    });

    // Read envelope
    const result = spawnSync('node', [
      path.join(process.cwd(), 'bin', 'task-envelope.cjs'),
      'read',
      '--phase', 'v0.18-03-test-5'
    ], {
      cwd: tmpDir,
      encoding: 'utf8'
    });

    assert.strictEqual(result.status, 0);
    const envelope = JSON.parse(result.stdout);
    assert.strictEqual(envelope.risk_level, 'high');
    assert.strictEqual(envelope.research.objective, 'Test read');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Additional test: validate command
test('ENB-TC11: validate command returns JSON with valid/errors fields', async (t) => {
  const { tmpDir, phaseDir } = setupTempPhase('v0.18-03-test-6');
  try {
    // Init first with valid envelope
    spawnSync('node', [
      path.join(process.cwd(), 'bin', 'task-envelope.cjs'),
      'init',
      '--phase', 'v0.18-03-test-6',
      '--objective', 'Test validate',
      '--risk-level', 'medium'
    ], {
      cwd: tmpDir,
      encoding: 'utf8'
    });

    // Validate envelope
    const result = spawnSync('node', [
      path.join(process.cwd(), 'bin', 'task-envelope.cjs'),
      'validate',
      '--phase', 'v0.18-03-test-6'
    ], {
      cwd: tmpDir,
      encoding: 'utf8'
    });

    assert.strictEqual(result.status, 0);
    const validation = JSON.parse(result.stdout);
    assert.strictEqual(validation.valid, true);
    assert.ok(Array.isArray(validation.errors));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ENB-TC12: update recovers from wrong-shape (null) existing envelope instead of crashing
test('ENB-TC12: update recovers from wrong-shape (null) existing envelope', async (t) => {
  const { tmpDir, phaseDir } = setupTempPhase('v0.18-03-shape');
  try {
    const envelopePath = path.join(phaseDir, 'task-envelope.json');
    fs.writeFileSync(envelopePath, 'null', 'utf8');
    const result = spawnSync('node', [
      path.join(process.cwd(), 'bin', 'task-envelope.cjs'),
      'update',
      '--section', 'plan',
      '--phase', 'v0.18-03-shape',
      '--plan-path', 'PLAN.md'
    ], { cwd: tmpDir, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, `Should recover, not crash. stderr: ${result.stderr}`);
    const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
    assert.strictEqual(envelope.schema_version, '1');
    assert.ok(envelope.plan, 'plan section should be written');
    assert.strictEqual(envelope.plan.plan_path, 'PLAN.md');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ENB-TC13: update recovers from corrupt-JSON existing envelope instead of aborting
test('ENB-TC13: update recovers from corrupt-JSON existing envelope', async (t) => {
  const { tmpDir, phaseDir } = setupTempPhase('v0.18-03-corrupt');
  try {
    const envelopePath = path.join(phaseDir, 'task-envelope.json');
    fs.writeFileSync(envelopePath, '{not valid json', 'utf8');
    const result = spawnSync('node', [
      path.join(process.cwd(), 'bin', 'task-envelope.cjs'),
      'update',
      '--section', 'plan',
      '--phase', 'v0.18-03-corrupt',
      '--plan-path', 'PLAN.md'
    ], { cwd: tmpDir, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, `Should recover from corrupt file. stderr: ${result.stderr}`);
    const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
    assert.strictEqual(envelope.schema_version, '1');
    assert.ok(envelope.plan, 'plan section should be written');
    assert.strictEqual(envelope.plan.plan_path, 'PLAN.md');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

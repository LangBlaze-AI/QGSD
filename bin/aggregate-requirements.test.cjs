#!/usr/bin/env node
// bin/aggregate-requirements.test.cjs
// TDD test suite for ENV-01: requirements aggregation

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  parseRequirements,
  parseTraceability,
  validateEnvelope,
  aggregateRequirements,
  discoverArchiveFiles
} = require('./aggregate-requirements.cjs');

// Helper: create temp directory for test files
function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nf-test-'));
}

// Helper: clean up temp directory
function cleanupTempDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Test 1: parseRequirements extracts REQ-ID, text, and category from markdown bullets
test('parseRequirements extracts REQ-ID, text, and category from markdown bullets', function() {
  const markdown = `# Requirements: nForma v0.22

### Requirements Envelope — ENV

- [ ] **ENV-01**: First requirement text here
- [ ] **ENV-02**: Second requirement text here
`;

  const result = parseRequirements(markdown);

  assert.strictEqual(result.length, 2, 'Should extract 2 requirements');
  assert.strictEqual(result[0].id, 'ENV-01', 'First requirement ID should be ENV-01');
  assert.strictEqual(result[0].text, 'First requirement text here', 'First requirement text should match');
  assert.strictEqual(result[0].category, 'Requirements Envelope', 'Category should be extracted from header');
  assert.strictEqual(result[1].id, 'ENV-02', 'Second requirement ID should be ENV-02');
});

// Test 2: parseRequirements handles backticks and formatting in requirement text
test('parseRequirements handles backticks and formatting in requirement text', function() {
  const markdown = `### Requirements Envelope — ENV

- [ ] **ENV-01**: Requirements are aggregated into \`.planning/formal/requirements.json\` with \`claude-haiku-4-5\` validation
`;

  const result = parseRequirements(markdown);

  assert.strictEqual(result.length, 1, 'Should extract 1 requirement');
  assert.ok(result[0].text.includes('.planning/formal/requirements.json'), 'Should preserve backticks in text');
  assert.ok(result[0].text.includes('claude-haiku-4-5'), 'Should preserve formatting in text');
});

// Test 3: parseRequirements sorts results by id
test('parseRequirements sorts results by id', function() {
  const markdown = `### Requirements Envelope — ENV

- [ ] **ENV-03**: Third requirement
- [ ] **ENV-01**: First requirement
- [ ] **ENV-02**: Second requirement
`;

  const result = parseRequirements(markdown);

  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0].id, 'ENV-01', 'Should be sorted: ENV-01 first');
  assert.strictEqual(result[1].id, 'ENV-02', 'Should be sorted: ENV-02 second');
  assert.strictEqual(result[2].id, 'ENV-03', 'Should be sorted: ENV-03 third');
});

// Test 4: parseRequirements detects completed requirements
test('parseRequirements detects completed requirements', function() {
  const markdown = `### Requirements Envelope — ENV

- [x] **ENV-01**: Completed requirement
- [ ] **ENV-02**: Pending requirement
`;

  const result = parseRequirements(markdown);

  assert.strictEqual(result[0].completed, true, 'ENV-01 should be marked completed');
  assert.strictEqual(result[1].completed, false, 'ENV-02 should be marked pending');
});

// Test 5: parseTraceability extracts phase assignments from table
test('parseTraceability extracts phase assignments from table', function() {
  const markdown = `
| Requirement | Phase | Status |
|-------------|-------|--------|
| ENV-01 | v0.22-01 | Pending |
| ENV-02 | v0.22-01 | Complete |
| ENV-03 | v0.22-02 | Pending |
`;

  const result = parseTraceability(markdown);

  assert.strictEqual(result['ENV-01'].phase, 'v0.22-01', 'ENV-01 should be in v0.22-01');
  assert.strictEqual(result['ENV-01'].status, 'Pending', 'ENV-01 status should be Pending');
  assert.strictEqual(result['ENV-02'].status, 'Complete', 'ENV-02 status should be Complete');
  assert.strictEqual(result['ENV-03'].phase, 'v0.22-02', 'ENV-03 should be in v0.22-02');
});

// Test 6: validateEnvelope rejects missing required fields
test('validateEnvelope rejects missing required fields', function() {
  const result = validateEnvelope({});

  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.length > 0, 'Should have errors');
  assert.ok(
    result.errors.some(e => e.includes('schema_version')),
    'Should mention missing schema_version'
  );
});

// Test 7: validateEnvelope accepts valid envelope
test('validateEnvelope accepts valid envelope', function() {
  const envelope = {
    schema_version: '1',
    source: '.planning/REQUIREMENTS.md',
    aggregated_at: '2026-03-01T20:32:24.000Z',
    frozen_at: null,
    content_hash: 'sha256:' + 'a'.repeat(64),
    requirements: [
      {
        id: 'ENV-01',
        text: 'Test requirement',
        category: 'Test',
        phase: 'v0.22-01',
        status: 'Pending',
        provenance: {
          source_file: '.planning/REQUIREMENTS.md',
          milestone: 'v0.22'
        }
      }
    ]
  };

  const result = validateEnvelope(envelope);

  assert.strictEqual(result.valid, true, 'Should be valid');
  assert.strictEqual(result.errors.length, 0, 'Should have no errors');
});

// Test 8: validateEnvelope rejects invalid REQ-ID format
test('validateEnvelope rejects invalid REQ-ID format', function() {
  const envelope = {
    schema_version: '1',
    source: '.planning/REQUIREMENTS.md',
    aggregated_at: '2026-03-01T20:32:24.000Z',
    frozen_at: null,
    content_hash: 'sha256:' + 'a'.repeat(64),
    requirements: [
      {
        id: 'invalid',
        text: 'Test',
        category: 'Test',
        phase: 'v0.22-01',
        status: 'Pending',
        provenance: {
          source_file: '.planning/REQUIREMENTS.md',
          milestone: 'v0.22'
        }
      }
    ]
  };

  const result = validateEnvelope(envelope);

  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(
    result.errors.some(e => e.includes('id')),
    'Should mention invalid id format'
  );
});

// Test 9: aggregateRequirements produces valid JSON from temp REQUIREMENTS.md
test('aggregateRequirements produces valid JSON from temp REQUIREMENTS.md', function() {
  const tempDir = createTempDir();

  try {
    const tempReqPath = path.join(tempDir, 'REQUIREMENTS.md');
    const tempOutputPath = path.join(tempDir, 'requirements.json');

    const tempMarkdown = `# Requirements: nForma v0.22

### Requirements Envelope — ENV

- [ ] **ENV-01**: First test requirement
- [ ] **ENV-02**: Second test requirement
- [ ] **ENV-03**: Third test requirement

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ENV-01 | v0.22-01 | Pending |
| ENV-02 | v0.22-01 | Pending |
| ENV-03 | v0.22-02 | Pending |
`;

    fs.writeFileSync(tempReqPath, tempMarkdown, 'utf8');

    const result = aggregateRequirements({
      requirementsPath: tempReqPath,
      outputPath: tempOutputPath,
      deterministic: true,
      skipArchive: true
    });

    assert.strictEqual(result.requirementCount, 3, 'Should have 3 requirements');
    assert.ok(fs.existsSync(tempOutputPath), 'Output file should exist');

    const envelope = JSON.parse(fs.readFileSync(tempOutputPath, 'utf8'));
    assert.strictEqual(envelope.requirements.length, 3, 'Envelope should have 3 requirements');
    assert.strictEqual(envelope.schema_version, '1', 'Schema version should be 1');
  } finally {
    cleanupTempDir(tempDir);
  }
});

// Test 10: aggregateRequirements is deterministic -- same input produces identical output
test('aggregateRequirements is deterministic -- same input produces identical output', function() {
  const tempDir = createTempDir();

  try {
    const tempReqPath = path.join(tempDir, 'REQUIREMENTS.md');
    const tempOutputPath1 = path.join(tempDir, 'requirements1.json');
    const tempOutputPath2 = path.join(tempDir, 'requirements2.json');

    const tempMarkdown = `# Requirements: nForma v0.22

### Requirements Envelope — ENV

- [ ] **ENV-01**: First test requirement
- [ ] **ENV-02**: Second test requirement

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ENV-01 | v0.22-01 | Pending |
| ENV-02 | v0.22-01 | Pending |
`;

    fs.writeFileSync(tempReqPath, tempMarkdown, 'utf8');

    // Run aggregation twice with deterministic flag
    aggregateRequirements({
      requirementsPath: tempReqPath,
      outputPath: tempOutputPath1,
      deterministic: true,
      skipArchive: true
    });

    aggregateRequirements({
      requirementsPath: tempReqPath,
      outputPath: tempOutputPath2,
      deterministic: true,
      skipArchive: true
    });

    const file1 = fs.readFileSync(tempOutputPath1, 'utf8');
    const file2 = fs.readFileSync(tempOutputPath2, 'utf8');

    assert.strictEqual(file1, file2, 'Outputs should be byte-identical');
  } finally {
    cleanupTempDir(tempDir);
  }
});

// Test 11: aggregateRequirements refuses to overwrite frozen envelope
test('aggregateRequirements refuses to overwrite frozen envelope', function() {
  const tempDir = createTempDir();

  try {
    const tempReqPath = path.join(tempDir, 'REQUIREMENTS.md');
    const tempOutputPath = path.join(tempDir, 'requirements.json');

    const tempMarkdown = `# Requirements: nForma v0.22

### Requirements Envelope — ENV

- [ ] **ENV-01**: Test requirement

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ENV-01 | v0.22-01 | Pending |
`;

    fs.writeFileSync(tempReqPath, tempMarkdown, 'utf8');

    // Create a frozen envelope
    const frozenEnvelope = {
      schema_version: '1',
      source: tempReqPath,
      aggregated_at: '2026-03-01T20:32:24.000Z',
      frozen_at: '2026-03-01T21:32:24.000Z',
      content_hash: 'sha256:' + 'a'.repeat(64),
      requirements: []
    };

    fs.writeFileSync(tempOutputPath, JSON.stringify(frozenEnvelope), 'utf8');

    // Try to aggregate over it
    assert.throws(
      function() {
        aggregateRequirements({
          requirementsPath: tempReqPath,
          outputPath: tempOutputPath,
          deterministic: true
        });
      },
      /frozen/i,
      'Should throw error mentioning "frozen"'
    );
  } finally {
    cleanupTempDir(tempDir);
  }
});

// Test 12: content_hash is consistent across runs
test('content_hash is consistent across runs', function() {
  const tempDir = createTempDir();

  try {
    const tempReqPath = path.join(tempDir, 'REQUIREMENTS.md');
    const tempOutputPath1 = path.join(tempDir, 'requirements1.json');
    const tempOutputPath2 = path.join(tempDir, 'requirements2.json');

    const tempMarkdown = `# Requirements: nForma v0.22

### Requirements Envelope — ENV

- [ ] **ENV-01**: First test requirement
- [ ] **ENV-02**: Second test requirement

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ENV-01 | v0.22-01 | Pending |
| ENV-02 | v0.22-01 | Pending |
`;

    fs.writeFileSync(tempReqPath, tempMarkdown, 'utf8');

    aggregateRequirements({
      requirementsPath: tempReqPath,
      outputPath: tempOutputPath1,
      deterministic: true,
      skipArchive: true
    });

    aggregateRequirements({
      requirementsPath: tempReqPath,
      outputPath: tempOutputPath2,
      deterministic: true,
      skipArchive: true
    });

    const envelope1 = JSON.parse(fs.readFileSync(tempOutputPath1, 'utf8'));
    const envelope2 = JSON.parse(fs.readFileSync(tempOutputPath2, 'utf8'));

    assert.strictEqual(
      envelope1.content_hash,
      envelope2.content_hash,
      'Content hash should be identical across runs'
    );
  } finally {
    cleanupTempDir(tempDir);
  }
});

// --- Archive merge tests ---

// Test 13: archive requirements are included in envelope
test('archive requirements are included in envelope', function() {
  const tempDir = createTempDir();

  try {
    // Create milestones archive dir with one archive file
    const milestonesDir = path.join(tempDir, 'milestones');
    fs.mkdirSync(milestonesDir, { recursive: true });

    fs.writeFileSync(path.join(milestonesDir, 'v0.20-REQUIREMENTS.md'), `# Requirements: nForma v0.20

### Schema — SCHEMA

- [x] **SCHEMA-01**: Schema extended with enrichment fields

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SCHEMA-01 | v0.20-01 | Complete |
`, 'utf8');

    // Create current REQUIREMENTS.md
    const currentPath = path.join(tempDir, 'REQUIREMENTS.md');
    fs.writeFileSync(currentPath, `# Requirements: nForma v0.24

### Requirements Envelope — ENV

- [ ] **ENV-01**: First current requirement

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ENV-01 | v0.24-01 | Pending |
`, 'utf8');

    const outputPath = path.join(tempDir, 'requirements.json');
    aggregateRequirements({
      requirementsPath: currentPath,
      outputPath: outputPath,
      archiveDir: milestonesDir,
      deterministic: true
    });

    const envelope = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    const ids = envelope.requirements.map(function(r) { return r.id; });

    assert.ok(ids.includes('SCHEMA-01'), 'Should include archived SCHEMA-01');
    assert.ok(ids.includes('ENV-01'), 'Should include current ENV-01');
    assert.strictEqual(envelope.requirements.length, 2, 'Should have 2 total requirements');

    // Verify provenance tracks correct source files
    var schema01 = envelope.requirements.find(function(r) { return r.id === 'SCHEMA-01'; });
    assert.ok(schema01.provenance.source_file.includes('v0.20-REQUIREMENTS.md'),
      'SCHEMA-01 provenance should point to archive file');

    var env01 = envelope.requirements.find(function(r) { return r.id === 'ENV-01'; });
    assert.ok(env01.provenance.source_file.includes('REQUIREMENTS.md'),
      'ENV-01 provenance should point to current file');
  } finally {
    cleanupTempDir(tempDir);
  }
});

// Test 14: current requirement wins on ID conflict
test('current requirement wins on ID conflict', function() {
  const tempDir = createTempDir();

  try {
    const milestonesDir = path.join(tempDir, 'milestones');
    fs.mkdirSync(milestonesDir, { recursive: true });

    fs.writeFileSync(path.join(milestonesDir, 'v0.20-REQUIREMENTS.md'), `# Requirements: nForma v0.20

### Test — SAME

- [x] **SAME-01**: Archive version of this requirement

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SAME-01 | v0.20-01 | Complete |
`, 'utf8');

    const currentPath = path.join(tempDir, 'REQUIREMENTS.md');
    fs.writeFileSync(currentPath, `# Requirements: nForma v0.24

### Test — SAME

- [ ] **SAME-01**: Current version of this requirement

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SAME-01 | v0.24-01 | Pending |
`, 'utf8');

    const outputPath = path.join(tempDir, 'requirements.json');
    aggregateRequirements({
      requirementsPath: currentPath,
      outputPath: outputPath,
      archiveDir: milestonesDir,
      deterministic: true
    });

    const envelope = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.strictEqual(envelope.requirements.length, 1, 'Should have 1 requirement (deduped)');

    var same01 = envelope.requirements[0];
    assert.strictEqual(same01.text, 'Current version of this requirement',
      'Current version text should win');
    assert.ok(same01.provenance.source_file.includes('REQUIREMENTS.md'),
      'Provenance should point to current file');
    assert.ok(!same01.provenance.source_file.includes('v0.20'),
      'Provenance should NOT point to archive file');
  } finally {
    cleanupTempDir(tempDir);
  }
});

// Test 15: --skip-archive excludes archive requirements
test('skipArchive excludes archive requirements', function() {
  const tempDir = createTempDir();

  try {
    const milestonesDir = path.join(tempDir, 'milestones');
    fs.mkdirSync(milestonesDir, { recursive: true });

    fs.writeFileSync(path.join(milestonesDir, 'v0.20-REQUIREMENTS.md'), `# Requirements: nForma v0.20

### Schema — SCHEMA

- [x] **SCHEMA-01**: Archived requirement

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SCHEMA-01 | v0.20-01 | Complete |
`, 'utf8');

    const currentPath = path.join(tempDir, 'REQUIREMENTS.md');
    fs.writeFileSync(currentPath, `# Requirements: nForma v0.24

### Requirements Envelope — ENV

- [ ] **ENV-01**: Current requirement

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ENV-01 | v0.24-01 | Pending |
`, 'utf8');

    const outputPath = path.join(tempDir, 'requirements.json');
    aggregateRequirements({
      requirementsPath: currentPath,
      outputPath: outputPath,
      archiveDir: milestonesDir,
      skipArchive: true,
      deterministic: true
    });

    const envelope = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    const ids = envelope.requirements.map(function(r) { return r.id; });

    assert.ok(!ids.includes('SCHEMA-01'), 'Should NOT include archived SCHEMA-01');
    assert.ok(ids.includes('ENV-01'), 'Should include current ENV-01');
    assert.strictEqual(envelope.requirements.length, 1, 'Should have only 1 requirement');
  } finally {
    cleanupTempDir(tempDir);
  }
});

// Test 16: multiple archive milestones merge in version order (newer wins)
test('multiple archive milestones merge in version order', function() {
  const tempDir = createTempDir();

  try {
    const milestonesDir = path.join(tempDir, 'milestones');
    fs.mkdirSync(milestonesDir, { recursive: true });

    fs.writeFileSync(path.join(milestonesDir, 'v0.20-REQUIREMENTS.md'), `# Requirements: nForma v0.20

### Test — FOO

- [x] **FOO-01**: v0.20 version of FOO

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| FOO-01 | v0.20-01 | Complete |
`, 'utf8');

    fs.writeFileSync(path.join(milestonesDir, 'v0.21-REQUIREMENTS.md'), `# Requirements: nForma v0.21

### Test — FOO

- [x] **FOO-01**: v0.21 version of FOO

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| FOO-01 | v0.21-01 | Complete |
`, 'utf8');

    // Current file does NOT define FOO-01
    const currentPath = path.join(tempDir, 'REQUIREMENTS.md');
    fs.writeFileSync(currentPath, `# Requirements: nForma v0.24

### Requirements Envelope — ENV

- [ ] **ENV-01**: Current only requirement

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ENV-01 | v0.24-01 | Pending |
`, 'utf8');

    const outputPath = path.join(tempDir, 'requirements.json');
    aggregateRequirements({
      requirementsPath: currentPath,
      outputPath: outputPath,
      archiveDir: milestonesDir,
      deterministic: true
    });

    const envelope = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    var foo01 = envelope.requirements.find(function(r) { return r.id === 'FOO-01'; });

    assert.ok(foo01, 'FOO-01 should be present from archives');
    assert.strictEqual(foo01.text, 'v0.21 version of FOO',
      'v0.21 (newer archive) should win over v0.20');
    assert.ok(foo01.provenance.source_file.includes('v0.21'),
      'Provenance should point to v0.21 archive');
    assert.strictEqual(foo01.provenance.milestone, 'v0.21',
      'Milestone should be v0.21');
  } finally {
    cleanupTempDir(tempDir);
  }
});

// Test: parseRequirements defaults tier to 'user' for requirements without (technical) suffix
test('parseRequirements defaults tier to "user" for requirements without (technical) suffix', function() {
  const markdown = `### Requirements Envelope — ENV

- [ ] **ENV-01**: First requirement without technical marker
- [ ] **ENV-02**: Second requirement also without marker
`;

  const result = parseRequirements(markdown);

  assert.strictEqual(result.length, 2, 'Should extract 2 requirements');
  assert.strictEqual(result[0].tier, 'user', 'ENV-01 should have tier: user');
  assert.strictEqual(result[1].tier, 'user', 'ENV-02 should have tier: user');
  assert.strictEqual(result[0].text, 'First requirement without technical marker', 'Text should not include suffix');
});

// Test: parseRequirements detects (technical) suffix and sets tier accordingly
test('parseRequirements detects (technical) suffix and sets tier accordingly', function() {
  const markdown = `### Requirements Envelope — ENV

- [ ] **ENV-01**: Build system requirement (technical)
- [ ] **ENV-02**: User-facing feature
- [ ] **ENV-03**: Infrastructure module (technical)
`;

  const result = parseRequirements(markdown);

  assert.strictEqual(result.length, 3, 'Should extract 3 requirements');
  assert.strictEqual(result[0].tier, 'technical', 'ENV-01 should have tier: technical');
  assert.strictEqual(result[0].text, 'Build system requirement', 'Text should be stripped of (technical) suffix');
  assert.strictEqual(result[1].tier, 'user', 'ENV-02 should have tier: user');
  assert.strictEqual(result[2].tier, 'technical', 'ENV-03 should have tier: technical');
  assert.strictEqual(result[2].text, 'Infrastructure module', 'Text should be stripped of suffix');
});

// Test: aggregateRequirements defaults tier field for all merged requirements
test('aggregateRequirements defaults tier field for all merged requirements', function() {
  const tempDir = createTempDir();

  try {
    const tempReqPath = path.join(tempDir, 'REQUIREMENTS.md');
    const tempOutputPath = path.join(tempDir, 'requirements.json');

    const tempMarkdown = `# Requirements: nForma v0.22

### Requirements Envelope — ENV

- [ ] **ENV-01**: Regular user requirement
- [ ] **ENV-02**: Build infrastructure (technical)
- [ ] **ENV-03**: Another user feature

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ENV-01 | v0.22-01 | Pending |
| ENV-02 | v0.22-01 | Pending |
| ENV-03 | v0.22-02 | Pending |
`;

    fs.writeFileSync(tempReqPath, tempMarkdown, 'utf8');

    const result = aggregateRequirements({
      requirementsPath: tempReqPath,
      outputPath: tempOutputPath,
      deterministic: true,
      skipArchive: true
    });

    assert.strictEqual(result.requirementCount, 3, 'Should have 3 requirements');

    const envelope = JSON.parse(fs.readFileSync(tempOutputPath, 'utf8'));
    assert.strictEqual(envelope.requirements.length, 3, 'Envelope should have 3 requirements');

    // Check each requirement has a tier field
    const env01 = envelope.requirements.find(r => r.id === 'ENV-01');
    const env02 = envelope.requirements.find(r => r.id === 'ENV-02');
    const env03 = envelope.requirements.find(r => r.id === 'ENV-03');

    assert.strictEqual(env01.tier, 'user', 'ENV-01 should have tier: user');
    assert.strictEqual(env02.tier, 'technical', 'ENV-02 should have tier: technical');
    assert.strictEqual(env03.tier, 'user', 'ENV-03 should have tier: user');

    // Verify text does not contain (technical) suffix
    assert.ok(!env02.text.includes('(technical)'), 'Text should not contain (technical) suffix');
  } finally {
    cleanupTempDir(tempDir);
  }
});

// Dogfood regression: the freeze guard used `existing.frozen_at !== null`, which is
// TRUE when the key is absent/undefined — so a fresh (unfrozen) envelope falsely
// tripped "Envelope is frozen". Only a real timestamp should freeze.
// (fs, os, path, aggregateRequirements are already imported at the top of this file)
test('frozen guard: absent frozen_at does NOT trip the freeze error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-agg-'));
  try {
    fs.mkdirSync(path.join(dir, '.planning', 'formal'), { recursive: true });
    const outputPath = path.join(dir, '.planning', 'formal', 'requirements.json');
    fs.writeFileSync(outputPath, JSON.stringify({ requirements: [] })); // no frozen_at key
    const reqPath = path.join(dir, 'REQUIREMENTS.md');
    fs.writeFileSync(reqPath, '# Requirements\n\n- The system MUST work.\n');
    assert.doesNotThrow(
      () => aggregateRequirements({ outputPath, requirementsPath: reqPath, skipArchive: true, deterministic: true }),
      /frozen/i
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('frozen guard: a real frozen_at timestamp still freezes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-agg-'));
  try {
    fs.mkdirSync(path.join(dir, '.planning', 'formal'), { recursive: true });
    const outputPath = path.join(dir, '.planning', 'formal', 'requirements.json');
    fs.writeFileSync(outputPath, JSON.stringify({ requirements: [], frozen_at: '2026-01-01T00:00:00Z' }));
    const reqPath = path.join(dir, 'REQUIREMENTS.md');
    fs.writeFileSync(reqPath, '# Requirements\n\n- The system MUST work.\n');
    assert.throws(
      () => aggregateRequirements({ outputPath, requirementsPath: reqPath, skipArchive: true, deterministic: true }),
      /frozen/i
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// AGG-01: validateEnvelope must not crash on a null/non-object requirements element
test('validateEnvelope: null element in requirements array reports an error, does not throw', function() {
  const envelope = {
    schema_version: '1',
    source: '.planning/REQUIREMENTS.md',
    aggregated_at: '2026-03-01T20:32:24.000Z',
    frozen_at: null,
    content_hash: 'sha256:' + 'a'.repeat(64),
    requirements: [null]
  };
  let result;
  assert.doesNotThrow(function() { result = validateEnvelope(envelope); }, 'Should not throw on null element');
  assert.strictEqual(result.valid, false, 'Should be invalid');
  assert.ok(result.errors.some(function(e) { return e.indexOf('requirements[0]') === 0; }), 'Should report requirements[0] error');
});

// AGG-02: A corrupt existing requirements.json must not abort aggregation
test('aggregateRequirements: corrupt existing output file fails open (does not throw SyntaxError)', function() {
  const tempDir = createTempDir();
  try {
    const tempReqPath = path.join(tempDir, 'REQUIREMENTS.md');
    const tempOutputPath = path.join(tempDir, 'requirements.json');
    fs.writeFileSync(tempReqPath, '# Requirements: nForma v0.22\n\n### Requirements Envelope — ENV\n\n- [ ] **ENV-01**: A requirement\n', 'utf8');
    fs.writeFileSync(tempOutputPath, '{not valid json', 'utf8');
    let result;
    assert.doesNotThrow(function() {
      result = aggregateRequirements({ requirementsPath: tempReqPath, outputPath: tempOutputPath, deterministic: true, skipArchive: true });
    }, 'Corrupt existing output should not throw');
    assert.strictEqual(result.requirementCount, 1, 'Should regenerate with 1 requirement');
  } finally {
    cleanupTempDir(tempDir);
  }
});

// AGG-03: existing requirements.json that is JSON null must not crash the frozen guard
test('aggregateRequirements: existing output of JSON null does not crash frozen guard', function() {
  const tempDir = createTempDir();
  try {
    const tempReqPath = path.join(tempDir, 'REQUIREMENTS.md');
    const tempOutputPath = path.join(tempDir, 'requirements.json');
    fs.writeFileSync(tempReqPath, '# Requirements: nForma v0.22\n\n### Requirements Envelope — ENV\n\n- [ ] **ENV-01**: A requirement\n', 'utf8');
    fs.writeFileSync(tempOutputPath, 'null', 'utf8');
    let result;
    assert.doesNotThrow(function() {
      result = aggregateRequirements({ requirementsPath: tempReqPath, outputPath: tempOutputPath, deterministic: true, skipArchive: true });
    }, 'JSON null existing output should not throw');
    assert.strictEqual(result.requirementCount, 1, 'Should regenerate with 1 requirement');
  } finally {
    cleanupTempDir(tempDir);
  }
});

#!/usr/bin/env node
'use strict';
// bin/generate-phase-spec.test.cjs
// Tests for bin/generate-phase-spec.cjs — SPEC-04
//
// Validates: classifyTruth, parsePlanFrontmatter, generatePhaseSpec, CLI behavior

const { test, describe } = require('node:test');
const assert             = require('node:assert');
const { spawnSync }      = require('child_process');
const fs                 = require('fs');
const path               = require('path');

const ROOT   = path.join(__dirname, '..');
const SCRIPT = path.join(__dirname, 'generate-phase-spec.cjs');

const { classifyTruth, parsePlanFrontmatter, generatePhaseSpec } = require('./generate-phase-spec.cjs');

// ── Test 1: classifyTruth — liveness keywords produce PROPERTY ───────────────

test('classifyTruth — liveness keywords produce PROPERTY', () => {
  assert.strictEqual(classifyTruth('eventually decision is PASS'), 'PROPERTY');
  assert.strictEqual(classifyTruth('progress guaranteed after quorum'), 'PROPERTY');
  assert.strictEqual(classifyTruth('system terminates after deadline'), 'PROPERTY');
  assert.strictEqual(classifyTruth('leads-to final state'), 'PROPERTY');
  assert.strictEqual(classifyTruth('until quorum is satisfied'), 'PROPERTY');
  assert.strictEqual(classifyTruth('runs async with other tasks'), 'PROPERTY');
});

// ── Test 2: classifyTruth — safety keywords produce INVARIANT ────────────────

test('classifyTruth — safety keywords produce INVARIANT', () => {
  assert.strictEqual(classifyTruth('threshold must be 3 or greater'), 'INVARIANT');
  assert.strictEqual(classifyTruth('count never exceeds maxSize'), 'INVARIANT');
  assert.strictEqual(classifyTruth('depth is always positive'), 'INVARIANT');
  assert.strictEqual(classifyTruth('blocked when no evidence'), 'INVARIANT');
  assert.strictEqual(classifyTruth('only one slot per solo mode session'), 'INVARIANT');
  assert.strictEqual(classifyTruth('max fan-out is 5'), 'INVARIANT');
});

// ── Test 3: parsePlanFrontmatter — extracts must_haves.truths ────────────────

test('parsePlanFrontmatter — extracts must_haves.truths from PLAN.md content', () => {
  const syntheticContent = `---
phase: test-phase-99
plan: "01"
type: execute
wave: 1
must_haves:
  truths:
    - "threshold must be at least 3"
    - "eventually quorum is satisfied"
    - "count never exceeds depth"
  artifacts:
    - path: "bin/foo.cjs"
---

<objective>Test objective</objective>
`;

  const fm = parsePlanFrontmatter(syntheticContent);

  assert.strictEqual(fm.phase, 'test-phase-99', 'phase must be extracted from frontmatter');
  assert.ok(Array.isArray(fm.truths), 'truths must be an array');
  assert.strictEqual(fm.truths.length, 3, 'must extract exactly 3 truths');
  assert.ok(fm.truths[0].includes('threshold must be at least 3'), 'first truth must match');
  assert.ok(fm.truths[1].includes('eventually quorum is satisfied'), 'second truth must match');
  assert.ok(fm.truths[2].includes('count never exceeds depth'), 'third truth must match');
});

// ── Test 4: generatePhaseSpec — produces valid TLA+ MODULE header ─────────────

test('generatePhaseSpec — produces valid TLA+ MODULE header', () => {
  const { moduleName, spec, truthCount } = generatePhaseSpec({
    phase: 'test-42',
    truths: ['threshold > 0', 'eventually done'],
  });

  assert.ok(spec.includes('---- MODULE'), 'spec must have MODULE header');
  assert.ok(spec.includes('Phasetest_42Spec'), 'module name must be sanitized phase');
  assert.ok(spec.includes('EXTENDS Naturals'), 'spec must include EXTENDS Naturals');
  assert.ok(spec.endsWith('===='), 'spec must end with ====');
  assert.strictEqual(truthCount, 2, 'truthCount must match input');
  assert.strictEqual(moduleName, 'Phasetest_42Spec', 'moduleName must match expected');
});

// ── Test 5: generatePhaseSpec — each truth becomes correct stub type ──────────

test('generatePhaseSpec — each truth becomes INVARIANT or PROPERTY stub', () => {
  const { spec } = generatePhaseSpec({
    phase: 'x',
    truths: ['threshold > 0', 'eventually done'],
  });

  assert.ok(spec.includes('INVARIANT Req01'), 'first truth (safety) must be INVARIANT Req01');
  assert.ok(spec.includes('PROPERTY Req02'), 'second truth (liveness) must be PROPERTY Req02');
  // Both must have PLACEHOLDER comment
  const placeholderCount = (spec.match(/TRUE\s*\\\* PLACEHOLDER/g) || []).length;
  assert.strictEqual(placeholderCount, 2, 'both stubs must have PLACEHOLDER comment');
});

// ── Test 6: generatePhaseSpec — empty truths produces correct output ──────────

test('generatePhaseSpec — empty truths produces spec with no INVARIANT/PROPERTY', () => {
  const { spec, truthCount } = generatePhaseSpec({ phase: 'empty', truths: [] });

  assert.ok(spec.includes('No must_haves: truths: found'), 'empty spec must have comment about no truths');
  assert.ok(!spec.match(/INVARIANT Req/), 'empty spec must not have INVARIANT Req stubs');
  assert.ok(!spec.match(/PROPERTY Req/), 'empty spec must not have PROPERTY Req stubs');
  assert.strictEqual(truthCount, 0, 'truthCount must be 0');
});

// ── Test 7: generatePhaseSpec — current phase *-PLAN.md frontmatter ──────────

test('generatePhaseSpec — current phase *-PLAN.md frontmatter produces parseable output', () => {
  const planFile = path.join(ROOT, '.planning', 'phases', 'v0.21-04-spec-completeness', 'v0.21-04-01-PLAN.md');

  if (!fs.existsSync(planFile)) {
    // If plan file doesn't exist, skip gracefully
    return;
  }

  const content = fs.readFileSync(planFile, 'utf8');
  const fm = parsePlanFrontmatter(content);

  // The real plan frontmatter must have truths (unlike task-envelope.json which has empty truths)
  assert.ok(fm.truths.length > 0, 'plan frontmatter must have truths (unlike task-envelope.json)');
  assert.ok(fm.phase && fm.phase.length > 0, 'phase must be extracted from frontmatter');

  const { spec, truthCount } = generatePhaseSpec({ phase: fm.phase, truths: fm.truths });

  assert.ok(spec.includes('---- MODULE'), 'spec must have MODULE header');
  assert.ok(spec.endsWith('===='), 'spec must end with ====');
  assert.strictEqual(truthCount, fm.truths.length, 'truthCount must match extracted truths');
});

// ── Test 8: CLI on phase directory creates .planning/formal/tla/scratch/ ────────────────

test('.planning/formal/tla/scratch/ directory exists after running CLI on phase directory', () => {
  const phaseDir = path.join(ROOT, '.planning', 'phases', 'v0.21-04-spec-completeness');

  if (!fs.existsSync(phaseDir)) {
    return; // Skip if phase dir doesn't exist
  }

  const result = spawnSync(process.execPath, [SCRIPT, phaseDir], {
    encoding: 'utf8',
    cwd: ROOT,
  });

  assert.strictEqual(
    result.status,
    0,
    'CLI must exit 0. stderr: ' + (result.stderr || '') + ' stdout: ' + (result.stdout || '')
  );
  assert.ok(
    fs.existsSync(path.join(ROOT, '.planning', 'formal', 'tla', 'scratch')),
    '.planning/formal/tla/scratch/ directory must exist after CLI run'
  );
});

// ── Test 9: parsePlanFrontmatter — non-string input fails open ────────────────

test('parsePlanFrontmatter — non-string input fails open to empty truths', () => {
  for (const bad of [undefined, null, 42, {}, Buffer.from('---')]) {
    const fm = parsePlanFrontmatter(bad);
    assert.ok(Array.isArray(fm.truths), 'truths must be an array for input ' + String(bad));
    assert.strictEqual(fm.truths.length, 0, 'truths must be empty for non-string input ' + String(bad));
  }
});

// ── Test 10: generatePhaseSpec — non-string truth elements / non-array truths ──

test('generatePhaseSpec — non-string truth elements and non-array truths do not crash', () => {
  const r1 = generatePhaseSpec({ phase: 'x', truths: ['ok', null, 42, undefined] });
  assert.ok(r1.spec.includes('---- MODULE'), 'must still produce a module header');
  assert.ok(r1.spec.includes('INVARIANT Req01'), 'the valid string truth must still be emitted');
  assert.strictEqual(r1.truthCount, 1, 'only the string truth should be counted');

  const r2 = generatePhaseSpec({ phase: 'x', truths: 'oneTruth' });
  assert.ok(r2.spec.includes('---- MODULE'), 'non-array truths must not crash');
  assert.strictEqual(r2.truthCount, 0, 'non-array truths must be treated as empty');
});

// ── Test 11: generatePhaseSpec — non-string phase falls back to unknown ───────

test('generatePhaseSpec — non-string phase falls back to unknown', () => {
  const { moduleName, spec } = generatePhaseSpec({ phase: 42, truths: [] });
  assert.ok(typeof moduleName === 'string' && moduleName.startsWith('Phase'), 'moduleName must be a Phase* string');
  assert.ok(spec.includes('---- MODULE'), 'must still produce a module header');
  assert.ok(spec.endsWith('===='), 'spec must end with ====');
});

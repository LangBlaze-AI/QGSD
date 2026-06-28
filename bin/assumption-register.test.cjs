#!/usr/bin/env node
'use strict';
// bin/assumption-register.test.cjs
// Tests for assumption register: markdown parsing, validation status, L2 linking

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseMarkdownTable } = require('./assumption-register.cjs');

// ── Unit tests: markdown table parsing ───────────────────────────────────────

describe('parseMarkdownTable', () => {
  it('parses a small inline markdown table correctly', () => {
    const input = `
| # | Source | Name | Type | Coverage | Proposed Metric | Metric Type |
|---|--------|------|------|----------|-----------------|-------------|
| 1 | tla | TypeOK | invariant | uncovered | \`nf_typeok\` | counter |
| 2 | alloy | MaxPool | constant | covered | \`pool_max\` | gauge |
| 3 | tla | Safety | assert | partial | \`safety_check\` | counter |
`;
    const result = parseMarkdownTable(input);
    assert.equal(result.length, 3, 'Should parse 3 rows');
    assert.equal(result[0].id, 1);
    assert.equal(result[0].source, 'tla');
    assert.equal(result[0].name, 'TypeOK');
    assert.equal(result[0].type, 'invariant');
    assert.equal(result[0].coverage, 'uncovered');
    assert.equal(result[1].coverage, 'covered');
    assert.equal(result[2].coverage, 'partial');
  });

  it('skips lines with wrong column count', () => {
    const input = `
| # | Source | Name | Type | Coverage | Proposed Metric | Metric Type |
|---|--------|------|------|----------|-----------------|-------------|
| 1 | tla | TypeOK | invariant | uncovered | \`nf_typeok\` | counter |
| bad line with only two | columns |
| 2 | tla | Safety | assert | partial | \`safety_check\` | counter |
`;
    const result = parseMarkdownTable(input);
    assert.equal(result.length, 2, 'Should skip malformed line');
  });

  it('preserves rows that contain an empty interior cell', () => {
    const input = `
| # | Source | Name | Type | Coverage | Proposed Metric | Metric Type |
|---|--------|------|------|----------|-----------------|-------------|
| 1 |  | TypeOK | invariant | uncovered | \`nf_typeok\` | counter |
`;
    const result = parseMarkdownTable(input);
    assert.equal(result.length, 1, 'row with empty source cell should still parse');
    assert.equal(result[0].id, 1);
    assert.equal(result[0].source, '');
    assert.equal(result[0].name, 'TypeOK');
    assert.equal(result[0].type, 'invariant');
  });

  it('strips backticks from proposed_metric', () => {
    const input = `
| # | Source | Name | Type | Coverage | Proposed Metric | Metric Type |
|---|--------|------|------|----------|-----------------|-------------|
| 1 | tla | TypeOK | invariant | uncovered | \`nf_typeok__tla\` | counter |
`;
    const result = parseMarkdownTable(input);
    assert.equal(result[0].proposed_metric, 'nf_typeok__tla', 'Should strip backticks');
    assert.ok(!result[0].proposed_metric.includes('`'), 'Should not contain backticks');
  });

  it('sets validation_status to "untested" for all entries', () => {
    const input = `
| # | Source | Name | Type | Coverage | Proposed Metric | Metric Type |
|---|--------|------|------|----------|-----------------|-------------|
| 1 | tla | TypeOK | invariant | uncovered | \`nf_typeok\` | counter |
| 2 | alloy | Safety | assert | covered | \`safety\` | gauge |
`;
    const result = parseMarkdownTable(input);
    for (const entry of result) {
      assert.equal(entry.validation_status, 'untested');
    }
  });

  it('sets linked_l2_states to empty array for all entries', () => {
    const input = `
| # | Source | Name | Type | Coverage | Proposed Metric | Metric Type |
|---|--------|------|------|----------|-----------------|-------------|
| 1 | tla | TypeOK | invariant | uncovered | \`nf_typeok\` | counter |
`;
    const result = parseMarkdownTable(input);
    assert.deepEqual(result[0].linked_l2_states, []);
  });
});

describe('parseMarkdownTable hardening', () => {
  it('returns [] for non-string input instead of throwing', () => {
    assert.deepEqual(parseMarkdownTable(null), []);
    assert.deepEqual(parseMarkdownTable(undefined), []);
    assert.deepEqual(parseMarkdownTable(42), []);
    assert.deepEqual(parseMarkdownTable({}), []);
  });
});

// ── Integration test ─────────────────────────────────────────────────────────

describe('integration', () => {
  it('reads real assumption-gaps.md, count between 500-600', () => {
    const gapsPath = path.join(__dirname, '..', '.planning', 'formal', 'assumption-gaps.md');
    assert.ok(fs.existsSync(gapsPath), 'assumption-gaps.md should exist');
    const content = fs.readFileSync(gapsPath, 'utf8');
    const result = parseMarkdownTable(content);
    assert.ok(result.length >= 500, `Expected >= 500, got ${result.length}`);
    assert.ok(result.length <= 600, `Expected <= 600, got ${result.length}`);
  });

  it('all validation_status values are "untested"', () => {
    const regPath = path.join(__dirname, '..', '.planning', 'formal', 'semantics', 'assumption-register.json');
    assert.ok(fs.existsSync(regPath), 'assumption-register.json should exist');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    for (const a of reg.assumptions) {
      assert.equal(a.validation_status, 'untested', `Entry ${a.id} should be untested`);
    }
  });

  it('all linked_l2_states arrays are empty', () => {
    const regPath = path.join(__dirname, '..', '.planning', 'formal', 'semantics', 'assumption-register.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    for (const a of reg.assumptions) {
      assert.deepEqual(a.linked_l2_states, [], `Entry ${a.id} should have empty linked_l2_states`);
    }
  });

  it('generated register JSON has expected structure', () => {
    const regPath = path.join(__dirname, '..', '.planning', 'formal', 'semantics', 'assumption-register.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    assert.equal(reg.schema_version, '1');
    assert.ok(reg.generated);
    assert.ok(Array.isArray(reg.assumptions));
    assert.ok(reg.summary.total_parsed >= 500);
    assert.ok(reg.summary.by_type);
    assert.ok(reg.summary.by_coverage);
    assert.ok(reg.summary.by_validation_status);
    assert.equal(reg.summary.by_validation_status.validated, 0);
    assert.equal(reg.summary.by_validation_status.invalidated, 0);
  });
});

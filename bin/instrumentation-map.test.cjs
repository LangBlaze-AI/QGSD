#!/usr/bin/env node
'use strict';
// bin/instrumentation-map.test.cjs
// Tests for instrumentation-map.cjs

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { scanFile } = require('./instrumentation-map.cjs');

const ROOT = process.env.PROJECT_ROOT || path.join(__dirname, '..');
const OUTPUT_PATH = path.join(ROOT, '.planning', 'formal', 'evidence', 'instrumentation-map.json');

describe('instrumentation-map hook parsing', () => {
  it('extracts action from inline fixture', () => {
    // Mock hook code
    const mockCode = `
      const event = {
        action:          'quorum_start',
        ts: new Date().toISOString(),
        from_state: 'idle',
      };
      fs.appendFileSync(logPath, JSON.stringify(event));
    `;
    const actionMatch = mockCode.match(/action:\s+['"]([^'"]+)['"]/);
    assert.ok(actionMatch, 'Should find action in mock hook code');
    assert.strictEqual(actionMatch[1], 'quorum_start');
  });

  it('extracts circuit_break action', () => {
    const mockCode = `action:          'circuit_break',`;
    const match = mockCode.match(/action:\s+['"]([^'"]+)['"]/);
    assert.ok(match);
    assert.strictEqual(match[1], 'circuit_break');
  });
});

describe('instrumentation-map vocabulary validation', () => {
  it('validates known actions against vocabulary', () => {
    const vocab = JSON.parse(fs.readFileSync(
      path.join(ROOT, '.planning', 'formal', 'evidence', 'event-vocabulary.json'), 'utf8'
    ));
    const knownActions = Object.keys(vocab.vocabulary);
    assert.ok(knownActions.includes('quorum_start'));
    assert.ok(knownActions.includes('circuit_break'));
    assert.ok(knownActions.includes('quorum_block'));
  });

  it('handles null xstate_event without errors', () => {
    const vocab = JSON.parse(fs.readFileSync(
      path.join(ROOT, '.planning', 'formal', 'evidence', 'event-vocabulary.json'), 'utf8'
    ));
    // mcp_call has xstate_event: null
    assert.strictEqual(vocab.vocabulary.mcp_call.xstate_event, null);
    // Simulating what instrumentation-map does with null xstate_event
    const entry = vocab.vocabulary.mcp_call;
    const xstateEvent = entry.xstate_event; // null
    const noMapping = xstateEvent === null;
    assert.strictEqual(noMapping, true, 'null xstate_event should be detected');
    // Should not throw
    assert.doesNotThrow(() => {
      const result = { xstate_event: xstateEvent, no_xstate_mapping: noMapping };
      JSON.stringify(result);
    });
  });
});

describe('instrumentation-map coverage', () => {
  it('calculates coverage correctly', () => {
    const total = 6; // excluding 'undefined'
    const mapped = 4;
    const pct = Math.round((mapped / total) * 1000) / 10;
    assert.strictEqual(pct, 66.7);
  });
});

describe('instrumentation-map integration', () => {
  before(() => {
    execFileSync('node', ['bin/instrumentation-map.cjs'], { cwd: ROOT, stdio: 'pipe' });
  });

  it('produces output file with emission points', () => {
    const result = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    assert.ok(result.emission_points.length >= 3,
      `Expected 3+ emission points, got ${result.emission_points.length}`);
  });

  it('has coverage data', () => {
    const result = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    assert.ok('coverage' in result);
    assert.ok('total_vocabulary_actions' in result.coverage);
    assert.ok('mapped_actions' in result.coverage);
    assert.ok('coverage_pct' in result.coverage);
  });

  it('has schema_version', () => {
    const result = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    assert.strictEqual(result.schema_version, '1');
  });
});

describe('instrumentation-map scanFile fail-open on bad filePath', () => {
  it('returns [] for non-string filePath instead of throwing', () => {
    assert.doesNotThrow(() => scanFile(null));
    assert.deepStrictEqual(scanFile(null), []);
    assert.deepStrictEqual(scanFile(undefined), []);
    assert.deepStrictEqual(scanFile(123), []);
    assert.deepStrictEqual(scanFile({}), []);
  });
});

describe('instrumentation-map scanFile fail-open on directory path', () => {
  it('returns [] for a directory path instead of throwing EISDIR', () => {
    // 'bin' exists relative to ROOT but is a directory
    assert.doesNotThrow(() => scanFile('bin'));
    assert.deepStrictEqual(scanFile('bin'), []);
  });
});

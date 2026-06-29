#!/usr/bin/env node
'use strict';
// bin/model-complexity-profile.test.cjs
// Tests for model-complexity-profile.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { classifyRuntime, parseNDJSON, findStateSpaceMatch, normalizeFilename, normalizeSlug } = require('./model-complexity-profile.cjs');

/**
 * Helper: run the profiler CLI with --json and --project-root, return parsed JSON.
 */
function runProfiler(projectRoot) {
  const result = execFileSync(process.execPath, [
    path.join(__dirname, 'model-complexity-profile.cjs'),
    '--json',
    '--project-root=' + projectRoot,
  ], { encoding: 'utf8' });
  return JSON.parse(result);
}

// ── classifyRuntime thresholds ──────────────────────────────────────────────

test('classifyRuntime: boundary values', () => {
  assert.equal(classifyRuntime(0), 'FAST');
  assert.equal(classifyRuntime(999), 'FAST');
  assert.equal(classifyRuntime(1000), 'FAST');
  assert.equal(classifyRuntime(1001), 'MODERATE');
  assert.equal(classifyRuntime(10000), 'MODERATE');
  assert.equal(classifyRuntime(10001), 'SLOW');
  assert.equal(classifyRuntime(30000), 'SLOW');
  assert.equal(classifyRuntime(30001), 'HEAVY');
  assert.equal(classifyRuntime(100000), 'HEAVY');
});

test('classifyRuntime: null input returns FAST', () => {
  assert.equal(classifyRuntime(null), 'FAST');
  assert.equal(classifyRuntime(undefined), 'FAST');
});

// ── normalizeFilename ───────────────────────────────────────────────────────

test('normalizeFilename: strips MC and NF prefixes', () => {
  assert.equal(normalizeFilename('MCAccountManager.tla'), 'accountmanager');
  assert.equal(normalizeFilename('NFQuorum.tla'), 'quorum');
  assert.equal(normalizeFilename('MCNFQuorum.tla'), 'quorum');
});

test('normalizeSlug: removes hyphens and underscores', () => {
  assert.equal(normalizeSlug('account-manager'), 'accountmanager');
  assert.equal(normalizeSlug('quorum_votes'), 'quorumvotes');
});

// ── findStateSpaceMatch ─────────────────────────────────────────────────────

test('findStateSpaceMatch: tla:account-manager matches MCAccountManager.tla', () => {
  const models = {
    '.planning/formal/tla/MCAccountManager.tla': {
      estimated_states: 5000,
      risk_level: 'LOW',
      variables: ['a', 'b', 'c'],
    },
  };
  const result = findStateSpaceMatch('tla:account-manager', models);
  assert.ok(result, 'should find a match');
  assert.equal(result.estimated_states, 5000);
  assert.equal(result.risk_level, 'LOW');
});



test('findStateSpaceMatch: petri:account-manager matches account-manager-petri-net.dot', () => {
  const models = {
    '.planning/formal/petri/account-manager-petri-net.dot': {
      estimated_states: 50,
      risk_level: 'MINIMAL',
      variables: ['a'],
    },
  };
  const result = findStateSpaceMatch('petri:account-manager', models);
  assert.ok(result, 'should find a match');
  assert.equal(result.estimated_states, 50);
  assert.equal(result.risk_level, 'MINIMAL');
});

test('findStateSpaceMatch: alloy:quorum-votes with no matching entry returns null', () => {
  const models = {
    '.planning/formal/tla/NFQuorum.tla': {
      estimated_states: 10000,
      risk_level: 'MODERATE',
      variables: ['x', 'y'],
    },
  };
  const result = findStateSpaceMatch('alloy:quorum-votes', models);
  assert.equal(result, null, 'no alloy model in state-space');
});

test('findStateSpaceMatch: null stateSpaceModels returns null', () => {
  const result = findStateSpaceMatch('tla:whatever', null);
  assert.equal(result, null);
});

test('findStateSpaceMatch: unknown formalism returns null', () => {
  const models = {
    '.planning/formal/tla/NFQuorum.tla': { estimated_states: 100 },
  };
  const result = findStateSpaceMatch('trace:something', models);
  assert.equal(result, null);
});

// ── parseNDJSON ─────────────────────────────────────────────────────────────

test('parseNDJSON: deduplication keeps max runtime', () => {
  const tmpFile = path.join(require('os').tmpdir(), 'test-ndjson-' + Date.now() + '.ndjson');
  const lines = [
    JSON.stringify({ check_id: 'tla:foo', runtime_ms: 100, formalism: 'tla' }),
    JSON.stringify({ check_id: 'tla:foo', runtime_ms: 500, formalism: 'tla' }),
    JSON.stringify({ check_id: 'tla:foo', runtime_ms: 200, formalism: 'tla' }),
  ];
  fs.writeFileSync(tmpFile, lines.join('\n') + '\n', 'utf8');

  const map = parseNDJSON(tmpFile);
  assert.equal(map.get('tla:foo').runtime_ms, 500, 'max runtime should win');

  fs.unlinkSync(tmpFile);
});

test('parseNDJSON: handles missing file gracefully', () => {
  const map = parseNDJSON('/nonexistent/path/check-results.ndjson');
  assert.equal(map.size, 0);
});

test('parseNDJSON: skips malformed lines', () => {
  const tmpFile = path.join(require('os').tmpdir(), 'test-malformed-' + Date.now() + '.ndjson');
  const lines = [
    JSON.stringify({ check_id: 'tla:good', runtime_ms: 42, formalism: 'tla' }),
    'not valid json {{{',
    JSON.stringify({ check_id: 'alloy:also-good', runtime_ms: 100, formalism: 'alloy' }),
  ];
  fs.writeFileSync(tmpFile, lines.join('\n') + '\n', 'utf8');

  const map = parseNDJSON(tmpFile);
  assert.equal(map.size, 2);
  assert.equal(map.get('tla:good').runtime_ms, 42);
  assert.equal(map.get('alloy:also-good').runtime_ms, 100);

  fs.unlinkSync(tmpFile);
});

// ── Split candidate detection ───────────────────────────────────────────────

test('split candidates: HEAVY runtime without state-space data', () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mcp-test-'));
  const formalDir = path.join(tmpDir, '.planning', 'formal');
  fs.mkdirSync(formalDir, { recursive: true });

  const ndjsonLines = [
    JSON.stringify({ check_id: 'alloy:heavy-model', runtime_ms: 35000, formalism: 'alloy' }),
    JSON.stringify({ check_id: 'tla:fast-model', runtime_ms: 200, formalism: 'tla' }),
  ];
  fs.writeFileSync(path.join(formalDir, 'check-results.ndjson'), ndjsonLines.join('\n') + '\n', 'utf8');

  const profile = runProfiler(tmpDir);

  assert.equal(profile.summary.total_profiled, 2);
  assert.equal(profile.profiles['alloy:heavy-model'].runtime_class, 'HEAVY');
  assert.equal(profile.profiles['tla:fast-model'].runtime_class, 'FAST');
  assert.ok(profile.recommendations.split_candidates.length >= 1, 'should have split candidate');
  assert.ok(profile.recommendations.split_candidates.some(s => s.check_id === 'alloy:heavy-model'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('split candidates: SLOW runtime flagged with softer recommendation', () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mcp-test-'));
  const formalDir = path.join(tmpDir, '.planning', 'formal');
  fs.mkdirSync(formalDir, { recursive: true });

  const ndjsonLines = [
    JSON.stringify({ check_id: 'tla:slow-model', runtime_ms: 15000, formalism: 'tla' }),
  ];
  fs.writeFileSync(path.join(formalDir, 'check-results.ndjson'), ndjsonLines.join('\n') + '\n', 'utf8');

  const profile = runProfiler(tmpDir);

  assert.ok(profile.recommendations.split_candidates.length >= 1);
  const slow = profile.recommendations.split_candidates.find(s => s.check_id === 'tla:slow-model');
  assert.ok(slow, 'slow model should be a split candidate');
  assert.ok(slow.reason.includes('consider splitting'), 'should have softer recommendation');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Merge candidate filtering ───────────────────────────────────────────────

test('merge candidates: both must be FAST/MODERATE', () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mcp-test-'));
  const formalDir = path.join(tmpDir, '.planning', 'formal');
  fs.mkdirSync(formalDir, { recursive: true });

  const stateSpace = {
    models: {
      '.planning/formal/tla/NFBreaker.tla': { module_name: 'NFCircuitBreaker', estimated_states: 100, risk_level: 'MINIMAL', variables: ['a'] },
      '.planning/formal/tla/NFOscillation.tla': { module_name: 'NFOscillation', estimated_states: 200, risk_level: 'MINIMAL', variables: ['b'] },
    },
    cross_model: {
      pairs: [{
        model_a: '.planning/formal/tla/NFBreaker.tla',
        model_b: '.planning/formal/tla/NFOscillation.tla',
        recommendation: 'merge',
        shared_requirements: ['DETECT-01'],
      }],
    },
  };
  fs.writeFileSync(path.join(formalDir, 'state-space-report.json'), JSON.stringify(stateSpace), 'utf8');

  const ndjsonLines = [
    JSON.stringify({ check_id: 'tla:breaker', runtime_ms: 500, formalism: 'tla' }),
    JSON.stringify({ check_id: 'tla:oscillation', runtime_ms: 800, formalism: 'tla' }),
  ];
  fs.writeFileSync(path.join(formalDir, 'check-results.ndjson'), ndjsonLines.join('\n') + '\n', 'utf8');

  const profile = runProfiler(tmpDir);

  assert.ok(profile.recommendations.merge_candidates.length >= 1, 'should have merge candidate');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Graceful handling: missing state-space-report.json (DEFAULT path) ───────

test('runtime-only profile: complete profile when state-space-report.json missing', () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mcp-test-'));
  const formalDir = path.join(tmpDir, '.planning', 'formal');
  fs.mkdirSync(formalDir, { recursive: true });

  const ndjsonLines = [
    JSON.stringify({ check_id: 'tla:model-a', runtime_ms: 5000, formalism: 'tla' }),
    JSON.stringify({ check_id: 'alloy:model-b', runtime_ms: 200, formalism: 'alloy' }),
    JSON.stringify({ check_id: 'prism:model-c', runtime_ms: 35000, formalism: 'prism' }),
  ];
  fs.writeFileSync(path.join(formalDir, 'check-results.ndjson'), ndjsonLines.join('\n') + '\n', 'utf8');

  const profile = runProfiler(tmpDir);

  assert.equal(profile.summary.total_profiled, 3);
  assert.equal(profile.summary.by_runtime_class.MODERATE, 1);
  assert.equal(profile.summary.by_runtime_class.FAST, 1);
  assert.equal(profile.summary.by_runtime_class.HEAVY, 1);

  assert.equal(profile.profiles['tla:model-a'].estimated_states, null);
  assert.equal(profile.profiles['tla:model-a'].risk_level, null);
  assert.equal(profile.profiles['tla:model-a'].variable_count, null);

  assert.equal(profile.profiles['tla:model-a'].runtime_class, 'MODERATE');
  assert.equal(profile.profiles['prism:model-c'].runtime_class, 'HEAVY');

  assert.ok(profile.recommendations.split_candidates.some(s => s.check_id === 'prism:model-c'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Graceful handling: missing check-results.ndjson ─────────────────────────

test('static-only profile: when check-results.ndjson missing', () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mcp-test-'));
  const formalDir = path.join(tmpDir, '.planning', 'formal');
  fs.mkdirSync(formalDir, { recursive: true });

  const stateSpace = {
    models: {
      '.planning/formal/tla/NFQuorum.tla': { module_name: 'NFQuorum', estimated_states: 5000, risk_level: 'LOW', variables: ['a', 'b'] },
    },
    cross_model: { pairs: [] },
  };
  fs.writeFileSync(path.join(formalDir, 'state-space-report.json'), JSON.stringify(stateSpace), 'utf8');

  const profile = runProfiler(tmpDir);

  assert.equal(profile.summary.total_profiled, 1);
  assert.ok(profile.profiles['static:NFQuorum']);
  assert.equal(profile.profiles['static:NFQuorum'].estimated_states, 5000);
  assert.equal(profile.profiles['static:NFQuorum'].runtime_ms, null);
  assert.equal(profile.profiles['static:NFQuorum'].runtime_class, 'FAST');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Formalism-prefix-to-path join ───────────────────────────────────────────

test('join: tla:account-manager matches .planning/formal/tla/MCAccountManager.tla in profile', () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mcp-test-'));
  const formalDir = path.join(tmpDir, '.planning', 'formal');
  fs.mkdirSync(formalDir, { recursive: true });

  const stateSpace = {
    models: {
      '.planning/formal/tla/MCAccountManager.tla': {
        module_name: 'NFAccountManager',
        estimated_states: 12000,
        risk_level: 'LOW',
        variables: ['v1', 'v2', 'v3'],
      },
    },
    cross_model: { pairs: [] },
  };
  fs.writeFileSync(path.join(formalDir, 'state-space-report.json'), JSON.stringify(stateSpace), 'utf8');

  const ndjsonLines = [
    JSON.stringify({ check_id: 'tla:account-manager', runtime_ms: 2500, formalism: 'tla' }),
  ];
  fs.writeFileSync(path.join(formalDir, 'check-results.ndjson'), ndjsonLines.join('\n') + '\n', 'utf8');

  const profile = runProfiler(tmpDir);

  const entry = profile.profiles['tla:account-manager'];
  assert.ok(entry, 'profile entry should exist');
  assert.equal(entry.estimated_states, 12000, 'should have joined state-space data');
  assert.equal(entry.risk_level, 'LOW');
  assert.equal(entry.variable_count, 3);
  assert.equal(entry.runtime_ms, 2500);
  assert.equal(entry.runtime_class, 'MODERATE');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('join miss: alloy:quorum-votes with no matching state-space entry', () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mcp-test-'));
  const formalDir = path.join(tmpDir, '.planning', 'formal');
  fs.mkdirSync(formalDir, { recursive: true });

  const stateSpace = {
    models: {
      '.planning/formal/tla/NFQuorum.tla': {
        module_name: 'NFQuorum',
        estimated_states: 1000,
        risk_level: 'MINIMAL',
        variables: ['x'],
      },
    },
    cross_model: { pairs: [] },
  };
  fs.writeFileSync(path.join(formalDir, 'state-space-report.json'), JSON.stringify(stateSpace), 'utf8');

  const ndjsonLines = [
    JSON.stringify({ check_id: 'alloy:quorum-votes', runtime_ms: 22000, formalism: 'alloy' }),
  ];
  fs.writeFileSync(path.join(formalDir, 'check-results.ndjson'), ndjsonLines.join('\n') + '\n', 'utf8');

  const profile = runProfiler(tmpDir);

  const entry = profile.profiles['alloy:quorum-votes'];
  assert.ok(entry, 'should appear in profile');
  assert.equal(entry.estimated_states, null, 'no state-space match');
  assert.equal(entry.risk_level, null, 'no state-space match');
  assert.equal(entry.variable_count, null, 'no state-space match');
  assert.equal(entry.runtime_ms, 22000);
  assert.equal(entry.runtime_class, 'SLOW');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Adversarial: malformed external inputs (skip-malformed / fail-open) ──────

test('non-string check_id in NDJSON is skipped, profiler does not crash', () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mcp-test-'));
  const formalDir = path.join(tmpDir, '.planning', 'formal');
  fs.mkdirSync(formalDir, { recursive: true });

  const ndjsonLines = [
    JSON.stringify({ check_id: 123, runtime_ms: 5000, formalism: 'tla' }),
    JSON.stringify({ check_id: { foo: 1 }, runtime_ms: 9000, formalism: 'tla' }),
    JSON.stringify({ check_id: 'tla:valid', runtime_ms: 200, formalism: 'tla' }),
  ];
  fs.writeFileSync(path.join(formalDir, 'check-results.ndjson'), ndjsonLines.join('\n') + '\n', 'utf8');

  // Currently throws: execFileSync surfaces main()'s TypeError as a non-zero exit.
  const profile = runProfiler(tmpDir);

  assert.equal(profile.summary.total_profiled, 1, 'only the valid string check_id is profiled');
  assert.ok(profile.profiles['tla:valid']);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('null model entry in state-space-report does not crash profiler', () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mcp-test-'));
  const formalDir = path.join(tmpDir, '.planning', 'formal');
  fs.mkdirSync(formalDir, { recursive: true });

  const stateSpace = {
    models: {
      '.planning/formal/tla/Foo.tla': null,
      '.planning/formal/tla/NFQuorum.tla': { module_name: 'NFQuorum', estimated_states: 5000, risk_level: 'LOW', variables: ['a', 'b'] },
    },
    cross_model: { pairs: [] },
  };
  fs.writeFileSync(path.join(formalDir, 'state-space-report.json'), JSON.stringify(stateSpace), 'utf8');
  // no check-results.ndjson -> static-only branch (step 2) runs

  // Currently throws: main() dereferences modelData.module_name on the null entry.
  const profile = runProfiler(tmpDir);

  assert.ok(profile.profiles['static:NFQuorum'], 'valid model still profiled');
  assert.equal(profile.summary.total_profiled, 1, 'null entry skipped, not counted');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('check_id "__proto__" is not silently dropped from profiles', () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mcp-test-'));
  const formalDir = path.join(tmpDir, '.planning', 'formal');
  fs.mkdirSync(formalDir, { recursive: true });

  const ndjsonLines = [
    JSON.stringify({ check_id: '__proto__', runtime_ms: 35000, formalism: 'tla' }),
  ];
  fs.writeFileSync(path.join(formalDir, 'check-results.ndjson'), ndjsonLines.join('\n') + '\n', 'utf8');

  const profile = runProfiler(tmpDir);

  // Currently 0: the entry vanished because it reassigned the prototype of `profiles`.
  assert.equal(profile.summary.total_profiled, 1, '__proto__ check_id must be counted');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

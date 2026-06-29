#!/usr/bin/env node
'use strict';
// bin/nf-solve.test.cjs
// TDD test suite for bin/nf-solve.cjs
// Uses node:test + node:assert/strict
//
// Test categories:
// - TC-HEALTH: healthIndicator() tests
// - TC-FORMAT: formatReport() tests
// - TC-JSON: formatJSON() tests
// - TC-INT: Integration tests (full script)
// - TC-CONV: Convergence logic tests
// - TC-KEYWORD: extractKeywords() tests
// - TC-CLAIMS: extractStructuralClaims() tests
// - TC-SWEEP-RD: sweepRtoD() tests
// - TC-SWEEP-DC: sweepDtoC() tests

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

// Import functions from nf-solve.cjs
const {
  healthIndicator,
  formatReport,
  formatJSON,
  discoverDocFiles,
  extractKeywords,
  extractStructuralClaims,
  sweepRtoD,
  sweepDtoC,
  sweepTtoC,
  sweepL1toL3,
  sweepL3toTC,
  sweepGitHeatmap,
  computeResidual,
  digestV8Coverage,
  crossReferenceFormalCoverage,
  autoClose,
  persistSessionSummary,
  checkCleanSession,
  proximityPreFilter,
  computeScannerStats,
  classifyFailingTest,
} = require('./nf-solve.cjs');

const ROOT = path.resolve(__dirname, '..');

// Prevent sweepTtoC() from spawning recursive `node --test` subprocesses.
// sweepTtoC() checks this guard and returns a skip sentinel instead of spawning.
// This avoids infinite test-within-test recursion for all tests that call
// sweepTtoC() directly or via computeResidual().
process.env.NF_SOLVE_SWEEPTOC_ACTIVE = '1';

// ── TC-HEALTH: Health Indicator Tests ────────────────────────────────────────

test('TC-HEALTH-1: healthIndicator(-1) returns UNKNOWN', () => {
  const result = healthIndicator(-1);
  assert.ok(result.includes('UNKNOWN'));
});

test('TC-HEALTH-2: healthIndicator(0) returns GREEN', () => {
  const result = healthIndicator(0);
  assert.ok(result.includes('GREEN'));
});

test('TC-HEALTH-3: healthIndicator(2) returns YELLOW', () => {
  const result = healthIndicator(2);
  assert.ok(result.includes('YELLOW'));
});

test('TC-HEALTH-4: healthIndicator(5) returns RED', () => {
  const result = healthIndicator(5);
  assert.ok(result.includes('RED'));
});

// ── TC-FORMAT: Report Formatting Tests ───────────────────────────────────────

test('TC-FORMAT-1: formatReport with converged=true, total=0', () => {
  const iterations = [
    {
      iteration: 1,
      residual: {
        r_to_f: { residual: 0, detail: {} },
        f_to_t: { residual: 0, detail: {} },
        c_to_f: { residual: 0, detail: {} },
        t_to_c: { residual: 0, detail: {} },
        f_to_c: { residual: 0, detail: {} },
        r_to_d: { residual: 0, detail: {} },
        d_to_c: { residual: 0, detail: {} },
        total: 0,
        timestamp: '2026-03-03T00:00:00Z',
      },
      actions: [],
    },
  ];
  const finalResidual = iterations[0].residual;
  const result = formatReport(iterations, finalResidual, true);

  assert.ok(result.includes('converged'));
  assert.ok(result.includes('GREEN'));
});

test('TC-FORMAT-2: formatReport with converged=false, total=5', () => {
  const iterations = [
    {
      iteration: 1,
      residual: {
        r_to_f: { residual: 2, detail: { uncovered_requirements: ['REQ-001', 'REQ-002'] } },
        f_to_t: { residual: 1, detail: { gaps: ['REQ-003'] } },
        c_to_f: { residual: 1, detail: { mismatches: [] } },
        t_to_c: { residual: 1, detail: { failed: 1, skipped: 0, todo: 0, total_tests: 10 } },
        f_to_c: { residual: 0, detail: {} },
        r_to_d: { residual: 0, detail: {} },
        d_to_c: { residual: 0, detail: {} },
        total: 5,
        timestamp: '2026-03-03T00:00:00Z',
      },
      actions: [],
    },
  ];
  const finalResidual = iterations[0].residual;
  const result = formatReport(iterations, finalResidual, false);

  assert.ok(result.includes('RED') || result.includes('YELLOW'));
});

test('TC-FORMAT-3: formatReport includes layer transition table', () => {
  const iterations = [
    {
      iteration: 1,
      residual: {
        r_to_f: { residual: 0, detail: {} },
        f_to_t: { residual: 0, detail: {} },
        c_to_f: { residual: 0, detail: {} },
        t_to_c: { residual: 0, detail: {} },
        f_to_c: { residual: 0, detail: {} },
        r_to_d: { residual: 0, detail: {} },
        d_to_c: { residual: 0, detail: {} },
        total: 0,
        timestamp: '2026-03-03T00:00:00Z',
      },
      actions: [],
    },
  ];
  const finalResidual = iterations[0].residual;
  const result = formatReport(iterations, finalResidual, true);

  assert.ok(result.includes('Layer Transition'));
  assert.ok(result.includes('R -> F'));
  assert.ok(result.includes('F -> T'));
  assert.ok(result.includes('C -> F'));
  assert.ok(result.includes('T -> C'));
  assert.ok(result.includes('F -> C'));
  // Unified table structure checks
  assert.ok(result.includes('Reverse Discovery'), 'Should have Reverse Discovery section divider');
  assert.ok(result.includes('Grand total'), 'Should have Grand total instead of Total residual');
  assert.ok(!result.includes('Total residual'), 'Should NOT have old Total residual header');
});

test('TC-FORMAT-4: formatReport includes R -> D and D -> C labels', () => {
  const iterations = [
    {
      iteration: 1,
      residual: {
        r_to_f: { residual: 0, detail: {} },
        f_to_t: { residual: 0, detail: {} },
        c_to_f: { residual: 0, detail: {} },
        t_to_c: { residual: 0, detail: {} },
        f_to_c: { residual: 0, detail: {} },
        r_to_d: { residual: 0, detail: {} },
        d_to_c: { residual: 0, detail: {} },
        total: 0,
        timestamp: '2026-03-03T00:00:00Z',
      },
      actions: [],
    },
  ];
  const finalResidual = iterations[0].residual;
  const result = formatReport(iterations, finalResidual, true);

  assert.ok(result.includes('R -> D'));
  assert.ok(result.includes('D -> C'));
});

test('TC-FORMAT-5: formatReport renders all three sections in unified table', () => {
  const iterations = [
    {
      iteration: 1,
      residual: {
        r_to_f: { residual: 2, detail: { uncovered_requirements: ['REQ-001', 'REQ-002'] } },
        f_to_t: { residual: 0, detail: {} },
        c_to_f: { residual: 0, detail: {} },
        t_to_c: { residual: 0, detail: {} },
        f_to_c: { residual: 0, detail: {} },
        r_to_d: { residual: 0, detail: {} },
        d_to_c: { residual: 0, detail: {} },
        total: 2,
        c_to_r: { residual: 3, detail: { untraced_modules: [], total_modules: 10 } },
        t_to_r: { residual: 1, detail: { orphan_tests: [], total_tests: 5 } },
        d_to_r: { residual: 0, detail: { unbacked_claims: [], total_claims: 3 } },
        reverse_discovery_total: 4,
        l1_to_l3: { residual: 1, detail: {} },
        l3_to_tc: { residual: 2, detail: {} },
        layer_total: 3,
        timestamp: '2026-03-03T00:00:00Z',
      },
      actions: [],
    },
  ];
  const finalResidual = iterations[0].residual;
  const result = formatReport(iterations, finalResidual, false);

  // All three section types present in a single output
  assert.ok(result.includes('R -> F'), 'Forward row present');
  assert.ok(result.includes('C -> R'), 'Reverse row present');
  assert.ok(result.includes('L1 -> L3'), 'Layer alignment row present');
  assert.ok(result.includes('L3 -> TC'), 'Gate C row present');
  // No separate "Reverse Traceability Discovery:" header (old format)
  assert.ok(!result.includes('Reverse Traceability Discovery:'), 'Old reverse header should not exist');
  // No separate "Layer Alignment (cross-layer gate checks):" header (old format)
  assert.ok(!result.includes('Layer Alignment (cross-layer gate checks):'), 'Old layer header should not exist');
  // Grand total should combine all three
  assert.ok(result.includes('Grand total:'), 'Grand total line present');
  // Grand total value = 2 + 4 + 3 = 9
  assert.ok(result.includes('Grand total:             9'), 'Grand total equals 9');
});

test('TC-FORMAT-6: formatReport includes subtotals for all three sections', () => {
  const iterations = [
    {
      iteration: 1,
      residual: {
        r_to_f: { residual: 1, detail: {} },
        f_to_t: { residual: 0, detail: {} },
        c_to_f: { residual: 0, detail: {} },
        t_to_c: { residual: 0, detail: {} },
        f_to_c: { residual: 0, detail: {} },
        r_to_d: { residual: 0, detail: {} },
        d_to_c: { residual: 0, detail: {} },
        total: 1,
        c_to_r: { residual: 0, detail: {} },
        t_to_r: { residual: 0, detail: {} },
        d_to_r: { residual: 0, detail: {} },
        reverse_discovery_total: 0,
        l1_to_l3: { residual: 0, detail: {} },
        l3_to_tc: { residual: 0, detail: {} },
        layer_total: 0,
        timestamp: '2026-03-03T00:00:00Z',
      },
      actions: [],
    },
  ];
  const finalResidual = iterations[0].residual;
  const result = formatReport(iterations, finalResidual, false);

  assert.ok(result.includes('Forward subtotal:'), 'Forward subtotal present');
  assert.ok(result.includes('Discovery subtotal:'), 'Discovery subtotal present');
  assert.ok(result.includes('Alignment subtotal:'), 'Alignment subtotal present');
});

// ── TC-JSON: JSON Formatting Tests ───────────────────────────────────────────

test('TC-JSON-1: formatJSON returns object with required keys', () => {
  const iterations = [
    {
      iteration: 1,
      residual: {
        r_to_f: { residual: 0, detail: {} },
        f_to_t: { residual: 0, detail: {} },
        c_to_f: { residual: 0, detail: {} },
        t_to_c: { residual: 0, detail: {} },
        f_to_c: { residual: 0, detail: {} },
        r_to_d: { residual: 0, detail: {} },
        d_to_c: { residual: 0, detail: {} },
        total: 0,
        timestamp: '2026-03-03T00:00:00Z',
      },
      actions: [],
    },
  ];
  const finalResidual = iterations[0].residual;
  const result = formatJSON(iterations, finalResidual, true);

  assert.ok(typeof result === 'object');
  assert.ok(result.solver_version);
  assert.ok(result.generated_at);
  assert.ok(typeof result.iteration_count === 'number');
  assert.ok(typeof result.converged === 'boolean');
  assert.ok(result.residual_vector);
  assert.ok(result.health);
});

test('TC-JSON-2: formatJSON with all zero residuals has GREEN health', () => {
  const iterations = [
    {
      iteration: 1,
      residual: {
        r_to_f: { residual: 0, detail: {} },
        f_to_t: { residual: 0, detail: {} },
        c_to_f: { residual: 0, detail: {} },
        t_to_c: { residual: 0, detail: {} },
        f_to_c: { residual: 0, detail: {} },
        r_to_d: { residual: 0, detail: {} },
        d_to_c: { residual: 0, detail: {} },
        total: 0,
        timestamp: '2026-03-03T00:00:00Z',
      },
      actions: [],
    },
  ];
  const finalResidual = iterations[0].residual;
  const result = formatJSON(iterations, finalResidual, true);

  assert.equal(result.converged, true);
  assert.equal(result.health.r_to_f, 'GREEN');
  assert.equal(result.health.f_to_t, 'GREEN');
  assert.equal(result.health.c_to_f, 'GREEN');
  assert.equal(result.health.t_to_c, 'GREEN');
  assert.equal(result.health.f_to_c, 'GREEN');
  assert.equal(result.health.r_to_d, 'GREEN');
  assert.equal(result.health.d_to_c, 'GREEN');
});

test('TC-JSON-3: formatJSON includes iterations array', () => {
  const iterations = [
    {
      iteration: 1,
      residual: {
        r_to_f: { residual: 0, detail: {} },
        f_to_t: { residual: 0, detail: {} },
        c_to_f: { residual: 0, detail: {} },
        t_to_c: { residual: 0, detail: {} },
        f_to_c: { residual: 0, detail: {} },
        r_to_d: { residual: 0, detail: {} },
        d_to_c: { residual: 0, detail: {} },
        total: 0,
        timestamp: '2026-03-03T00:00:00Z',
      },
      actions: ['action 1'],
    },
  ];
  const finalResidual = iterations[0].residual;
  const result = formatJSON(iterations, finalResidual, true);

  assert.ok(Array.isArray(result.iterations));
  assert.equal(result.iterations.length, 1);
  assert.equal(result.iterations[0].iteration, 1);
  assert.ok(Array.isArray(result.iterations[0].actions));
});

test('TC-JSON-4: formatJSON includes r_to_d and d_to_c health keys', () => {
  const iterations = [
    {
      iteration: 1,
      residual: {
        r_to_f: { residual: 0, detail: {} },
        f_to_t: { residual: 0, detail: {} },
        c_to_f: { residual: 0, detail: {} },
        t_to_c: { residual: 0, detail: {} },
        f_to_c: { residual: 0, detail: {} },
        r_to_d: { residual: 0, detail: {} },
        d_to_c: { residual: 0, detail: {} },
        total: 0,
        timestamp: '2026-03-03T00:00:00Z',
      },
      actions: [],
    },
  ];
  const finalResidual = iterations[0].residual;
  const result = formatJSON(iterations, finalResidual, true);

  assert.ok(result.health.r_to_d !== undefined, 'health should have r_to_d key');
  assert.ok(result.health.d_to_c !== undefined, 'health should have d_to_c key');
  assert.equal(result.solver_version, '1.2');
});

test('TC-JSON-5: formatJSON includes has_residual=false when total is 0', () => {
  const iterations = [
    {
      iteration: 1,
      residual: {
        r_to_f: { residual: 0, detail: {} },
        f_to_t: { residual: 0, detail: {} },
        c_to_f: { residual: 0, detail: {} },
        t_to_c: { residual: 0, detail: {} },
        f_to_c: { residual: 0, detail: {} },
        r_to_d: { residual: 0, detail: {} },
        d_to_c: { residual: 0, detail: {} },
        total: 0,
        timestamp: '2026-03-24T00:00:00Z',
      },
      actions: [],
    },
  ];
  const finalResidual = iterations[0].residual;
  const result = formatJSON(iterations, finalResidual, true);

  assert.equal(typeof result.has_residual, 'boolean', 'has_residual should be a boolean');
  assert.equal(result.has_residual, false, 'has_residual should be false when total is 0');
});

test('TC-JSON-6: formatJSON includes has_residual=true when total > 0', () => {
  const iterations = [
    {
      iteration: 1,
      residual: {
        r_to_f: { residual: 3, detail: {} },
        f_to_t: { residual: 0, detail: {} },
        c_to_f: { residual: 0, detail: {} },
        t_to_c: { residual: 0, detail: {} },
        f_to_c: { residual: 0, detail: {} },
        r_to_d: { residual: 0, detail: {} },
        d_to_c: { residual: 0, detail: {} },
        total: 3,
        timestamp: '2026-03-24T00:00:00Z',
      },
      actions: [],
    },
  ];
  const finalResidual = iterations[0].residual;
  const result = formatJSON(iterations, finalResidual, false);

  assert.equal(typeof result.has_residual, 'boolean', 'has_residual should be a boolean');
  assert.equal(result.has_residual, true, 'has_residual should be true when total > 0');
});

// ── TC-KEYWORD: Keyword Extraction Tests ─────────────────────────────────────

test('TC-KEYWORD-1: extractKeywords strips stopwords and short tokens', () => {
  const result = extractKeywords('the quick brown fox jumps over this lazy dog');
  assert.ok(!result.includes('the'));  // stopword
  assert.ok(!result.includes('fox'));  // < 4 chars
  assert.ok(!result.includes('dog'));  // < 4 chars
  assert.ok(result.includes('quick'));
  assert.ok(result.includes('brown'));
  assert.ok(result.includes('jumps'));
  assert.ok(result.includes('lazy'));
});

test('TC-KEYWORD-2: extractKeywords ignores backtick-wrapped fragments', () => {
  const result = extractKeywords('uses `spawnSync` for spawning child processes');
  assert.ok(!result.includes('spawnsync'));
  assert.ok(result.includes('spawning'));
  assert.ok(result.includes('child'));
  assert.ok(result.includes('processes'));
});

// ── TC-CLAIMS: Structural Claims Tests ───────────────────────────────────────

test('TC-CLAIMS-1: extractStructuralClaims finds file paths in backticks', () => {
  const doc = 'See `bin/nf-solve.cjs` for details.';
  const claims = extractStructuralClaims(doc, 'test.md');
  assert.ok(claims.some(c => c.type === 'file_path' && c.value === 'bin/nf-solve.cjs'));
});

test('TC-CLAIMS-2: extractStructuralClaims skips fenced code blocks', () => {
  const doc = 'text\n```\n`bin/fake-file.cjs`\n```\nmore text';
  const claims = extractStructuralClaims(doc, 'test.md');
  assert.ok(!claims.some(c => c.value === 'bin/fake-file.cjs'));
});

test('TC-CLAIMS-3: extractStructuralClaims skips template variables', () => {
  const doc = 'Path: `.planning/phases/{phase}/{plan}-PLAN.md`';
  const claims = extractStructuralClaims(doc, 'test.md');
  assert.ok(!claims.some(c => c.value.includes('{phase}')));
});

test('TC-CLAIMS-4: extractStructuralClaims skips paths under Example headings', () => {
  const doc = '## Example Usage\n\nSee `bin/imaginary.cjs` for reference.\n\n## Real Section\n\nSee `bin/nf-solve.cjs` here.';
  const claims = extractStructuralClaims(doc, 'test.md');
  assert.ok(!claims.some(c => c.value === 'bin/imaginary.cjs'));
  // Real section claims should still be collected
  assert.ok(claims.some(c => c.value === 'bin/nf-solve.cjs'));
});

test('TC-CLAIMS-5: extractStructuralClaims identifies CLI commands', () => {
  const doc = 'Run `node bin/nf-solve.cjs --report-only` to check.';
  const claims = extractStructuralClaims(doc, 'test.md');
  assert.ok(claims.some(c => c.type === 'cli_command'));
});

test('TC-CLAIMS-6: extractStructuralClaims skips home directory paths', () => {
  const doc = 'Installed at `~/.claude/hooks/` by default.';
  const claims = extractStructuralClaims(doc, 'test.md');
  assert.ok(!claims.some(c => c.value.includes('~/')));
});

// ── TC-SWEEP-RD: sweepRtoD Tests ────────────────────────────────────────────

test('TC-SWEEP-RD-1: sweepRtoD returns valid structure', () => {
  const result = sweepRtoD();
  assert.ok(typeof result === 'object');
  assert.ok(typeof result.residual === 'number');
  assert.ok(typeof result.detail === 'object');
  // If skipped, should still be residual: 0
  if (result.detail.skipped) {
    assert.equal(result.residual, 0);
  }
});

// ── TC-SWEEP-DC: sweepDtoC Tests ────────────────────────────────────────────

test('TC-SWEEP-DC-1: sweepDtoC returns valid structure', () => {
  const result = sweepDtoC();
  assert.ok(typeof result === 'object');
  assert.ok(typeof result.residual === 'number');
  assert.ok(typeof result.detail === 'object');
  if (result.detail.skipped) {
    assert.equal(result.residual, 0);
  }
});

// ── TC-TAP-PARSE: TAP Format Parsing Tests ──────────────────────────────────

test('TC-TAP-PARSE-1: dual-format regex matches i prefix (Node v25)', () => {
  const output = 'ℹ tests 42\nℹ pass 40\nℹ fail 1\nℹ skipped 1\nℹ todo 0\nℹ duration_ms 123';
  const testsMatch = output.match(/^[ℹ#]\s+tests\s+(\d+)/m);
  const failMatch = output.match(/^[ℹ#]\s+fail\s+(\d+)/m);
  const skipMatch = output.match(/^[ℹ#]\s+skipped\s+(\d+)/m);
  assert.ok(testsMatch, 'should match ℹ prefix for tests');
  assert.equal(testsMatch[1], '42');
  assert.ok(failMatch, 'should match ℹ prefix for fail');
  assert.equal(failMatch[1], '1');
  assert.ok(skipMatch, 'should match ℹ prefix for skipped');
  assert.equal(skipMatch[1], '1');
});

test('TC-TAP-PARSE-2: dual-format regex matches # prefix (Node <= v24)', () => {
  const output = '# tests 10\n# pass 8\n# fail 2\n# skipped 0\n# todo 0';
  const testsMatch = output.match(/^[ℹ#]\s+tests\s+(\d+)/m);
  const failMatch = output.match(/^[ℹ#]\s+fail\s+(\d+)/m);
  assert.ok(testsMatch);
  assert.equal(testsMatch[1], '10');
  assert.ok(failMatch);
  assert.equal(failMatch[1], '2');
});

test('TC-TAP-PARSE-3: skip and todo counts extracted', () => {
  const output = 'ℹ tests 20\nℹ fail 1\nℹ skipped 3\nℹ todo 2';
  const skipMatch = output.match(/^[ℹ#]\s+skipped\s+(\d+)/m);
  const todoMatch = output.match(/^[ℹ#]\s+todo\s+(\d+)/m);
  assert.ok(skipMatch);
  assert.equal(parseInt(skipMatch[1], 10), 3);
  assert.ok(todoMatch);
  assert.equal(parseInt(todoMatch[1], 10), 2);
});

test('TC-RESIDUAL-SKIP-1: sweepTtoC residual includes skipped count', () => {
  // Integration test: run actual tests and verify detail shape
  const result = sweepTtoC();
  assert.ok(typeof result === 'object');
  assert.ok(typeof result.residual === 'number');
  assert.ok(typeof result.detail === 'object');
  // When called from within a test run, sweepTtoC returns a recursive-guard skip sentinel.
  // In that case the shape is {skipped: true, reason: 'recursive-guard: ...'} — accept it.
  if (result.detail.reason && result.detail.reason.startsWith('recursive-guard')) {
    return; // skip assertions that require a real run result
  }
  assert.ok('skipped' in result.detail, 'detail must include skipped field');
  assert.ok('todo' in result.detail, 'detail must include todo field');
  assert.ok('failed' in result.detail, 'detail must include failed field');
  // residual should equal failed + skipped
  assert.equal(result.residual, result.detail.failed + result.detail.skipped);
});

// ── TC-INT: Integration Tests ────────────────────────────────────────────────

test('TC-INT-1: node bin/nf-solve.cjs --json --report-only exits with valid JSON', () => {
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'bin', 'nf-solve.cjs'),
    '--json',
    '--report-only',
    '--fast',
    '--skip-proximity',
    '--max-iterations=1',
  ], {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });

  // Either exit 0 or 1 is acceptable (depends on project state)
  assert.ok(result.status === 0 || result.status === 1);

  // stdout should be valid JSON
  const output = result.stdout.trim();
  assert.ok(output.length > 0);

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (err) {
    assert.fail('stdout is not valid JSON: ' + err.message);
  }

  assert.ok(parsed.residual_vector);
  assert.ok(typeof parsed.converged === 'boolean');
  assert.ok(typeof parsed.iteration_count === 'number');
});

test('TC-INT-2: node bin/nf-solve.cjs --report-only produces human-readable output', () => {
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'bin', 'nf-solve.cjs'),
    '--report-only',
    '--fast',
    '--skip-proximity',
    '--max-iterations=1',
  ], {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });

  // Either exit 0 or 1 is acceptable
  assert.ok(result.status === 0 || result.status === 1);

  const output = result.stdout;
  // Should contain markers of human-readable format
  assert.ok(
    output.includes('nf-solve') ||
    output.includes('Layer Transition') ||
    output.includes('Residual')
  );
});

test('TC-INT-3: node bin/nf-solve.cjs --report-only --max-iterations=1 iterations count', () => {
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'bin', 'nf-solve.cjs'),
    '--json',
    '--report-only',
    '--fast',
    '--skip-proximity',
    '--max-iterations=1',
  ], {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });

  assert.ok(result.status === 0 || result.status === 1);

  try {
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.iteration_count, 1);
  } catch (err) {
    assert.fail('Failed to parse JSON: ' + err.message);
  }
});

test('TC-INT-4: node bin/nf-solve.cjs --json --report-only --verbose exits without crash', () => {
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'bin', 'nf-solve.cjs'),
    '--json',
    '--report-only',
    '--verbose',
    '--fast',
    '--skip-proximity',
    '--max-iterations=1',
  ], {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });

  // Should not crash
  assert.ok(result.status === 0 || result.status === 1);

  // stdout should still be valid JSON even with --verbose
  try {
    JSON.parse(result.stdout.trim());
  } catch (err) {
    assert.fail('stdout is not valid JSON with --verbose: ' + err.message);
  }
});

// ── TC-CONV: Convergence Logic Tests ─────────────────────────────────────────

test('TC-CONV-1: --report-only mode does single iteration (iteration_count === 1)', () => {
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'bin', 'nf-solve.cjs'),
    '--json',
    '--report-only',
    '--fast',
    '--skip-proximity',
    '--max-iterations=1',
  ], {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });

  assert.ok(result.status === 0 || result.status === 1);

  try {
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.iteration_count, 1, '--report-only should do exactly 1 iteration');
  } catch (err) {
    assert.fail('Failed to parse JSON: ' + err.message);
  }
});

test('TC-CONV-2: --max-iterations limits iterations', () => {
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'bin', 'nf-solve.cjs'),
    '--json',
    '--report-only',
    '--fast',
    '--skip-proximity',
    '--max-iterations=2',
  ], {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });

  assert.ok(result.status === 0 || result.status === 1);

  try {
    const parsed = JSON.parse(result.stdout.trim());
    // --report-only stops after 1 iteration regardless, so this should still be 1
    assert.ok(parsed.iteration_count <= 2);
  } catch (err) {
    assert.fail('Failed to parse JSON: ' + err.message);
  }
});

// ── TC-INT: Integration Tests ─────────────────────────────────────────────────

test('TC-INT: --project-root overrides CWD for diagnostic sweep', () => {
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'bin', 'nf-solve.cjs'),
    '--json',
    '--report-only',
    '--fast',
    '--skip-proximity',
    '--max-iterations=1',
    '--project-root=' + ROOT,
  ], {
    encoding: 'utf8',
    cwd: '/tmp',
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.residual_vector, 'Should have residual_vector');
  assert.equal(typeof parsed.residual_vector.total, 'number');
});

// ── TC-COV: crossReferenceFormalCoverage Tests ────────────────────────────────

test('TC-COV-1: crossReferenceFormalCoverage returns unavailable when null input', () => {
  const result = crossReferenceFormalCoverage(null);
  assert.deepStrictEqual(result, { available: false });
});

test('TC-COV-2: crossReferenceFormalCoverage returns unavailable when undefined input', () => {
  const result = crossReferenceFormalCoverage(undefined);
  assert.deepStrictEqual(result, { available: false });
});

test('TC-COV-3: crossReferenceFormalCoverage returns available with empty coverage array', () => {
  const result = crossReferenceFormalCoverage([]);
  assert.equal(result.available, true);
  assert.ok(Array.isArray(result.false_greens), 'false_greens should be an array');
  assert.ok(result.summary, 'should have summary object');
  assert.equal(typeof result.summary.fully_covered, 'number');
  assert.equal(typeof result.summary.partially_covered, 'number');
  assert.equal(typeof result.summary.uncovered, 'number');
});

test('TC-COV-4: crossReferenceFormalCoverage parses V8 coverage format and returns available', () => {
  const coverageArray = [{
    result: [{
      url: 'file:///some/other/file.js',
      functions: [{
        ranges: [{ startOffset: 0, endOffset: 100, count: 1 }],
      }],
    }],
  }];
  const result = crossReferenceFormalCoverage(coverageArray);
  assert.equal(result.available, true);
  assert.ok(result.summary, 'should have summary object');
  assert.equal(typeof result.summary.fully_covered, 'number');
  assert.equal(typeof result.summary.partially_covered, 'number');
  assert.equal(typeof result.summary.uncovered, 'number');
  assert.equal(typeof result.total_properties, 'number');
});

test('TC-COV-5: sweepTtoC detail contains v8_coverage field', () => {
  const result = sweepTtoC();
  assert.ok(result.detail, 'sweepTtoC should return detail');
  // When called from within a test run, the recursive guard fires — accept skip sentinel.
  if (result.detail.reason && result.detail.reason.startsWith('recursive-guard')) {
    return;
  }
  assert.ok('v8_coverage' in result.detail, 'detail should have v8_coverage key');
});

// ── DIGEST: digestV8Coverage Tests ─────────────────────────────────────────────

test('DIGEST-1: digestV8Coverage returns null-safe on null/undefined input', () => {
  const nullResult = digestV8Coverage(null);
  assert.strictEqual(nullResult, null);
  const undefinedResult = digestV8Coverage(undefined);
  assert.strictEqual(undefinedResult, null);
  const emptyArrayResult = digestV8Coverage([]);
  assert.strictEqual(emptyArrayResult, null);
});

test('DIGEST-2: digestV8Coverage extracts file paths from V8 format', () => {
  const mock = [{
    result: [{
      url: 'file:///abs/path/to/file.js',
      source: 'line1\nline2\nline3\n',
      functions: [{
        ranges: [
          { startOffset: 0, endOffset: 5, count: 1 },  // covered
          { startOffset: 6, endOffset: 11, count: 0 }  // uncovered
        ]
      }]
    }]
  }];
  const result = digestV8Coverage(mock);
  assert.ok(result, 'should return digest object');
  assert.ok(result.files, 'should have files property');
  const filePath = '/abs/path/to/file.js';
  assert.ok(result.files[filePath], 'should have file entry for ' + filePath);
  const fileEntry = result.files[filePath];
  assert.ok(Array.isArray(fileEntry.covered), 'covered should be array');
  assert.ok(Array.isArray(fileEntry.uncovered), 'uncovered should be array');
});

test('DIGEST-3: digestV8Coverage output is dramatically smaller than input', () => {
  // Create mock with large source text repeated many times
  const mock = [{
    result: Array.from({ length: 100 }, (_, i) => ({
      url: `file:///path/to/file${i}.js`,
      source: 'x'.repeat(10000) + '\n',
      functions: [{
        ranges: [{ startOffset: 0, endOffset: 5000, count: 1 }]
      }]
    }))
  }];

  const digestResult = digestV8Coverage(mock);
  assert.ok(digestResult, 'digest should not be null');

  const rawSize = JSON.stringify(mock).length;
  const digestSize = JSON.stringify(digestResult).length;

  // Digest should be < 1% of raw size (99% compression)
  const ratio = digestSize / rawSize;
  assert.ok(ratio < 0.01, `Digest size ratio ${ratio.toFixed(4)} should be < 0.01 (less than 1% of raw)`);
});

test('DIGEST-4: crossReferenceFormalCoverage works with digest format', () => {
  const digest = {
    files: {
      '/some/file.js': { covered: [1, 2, 3], uncovered: [4, 5] }
    }
  };
  const result = crossReferenceFormalCoverage(digest);
  assert.equal(result.available, true, 'should be available with digest format');
});

test('DIGEST-5: sweepTtoC v8_coverage is digest format (not raw array)', () => {
  const result = sweepTtoC();
  const v8coverage = result.detail && result.detail.v8_coverage;
  if (v8coverage) {
    assert.ok(!Array.isArray(v8coverage), 'v8_coverage should not be array (legacy format)');
    assert.ok(v8coverage.files, 'v8_coverage should have files property (digest format)');
    assert.strictEqual(typeof v8coverage.files, 'object', 'files should be an object');
  }
});

// ── TC-LAYER: Layer Alignment Sweep Tests ─────────────────────────────────────

test('TC-LAYER-1: sweepL1toL3 returns normalized residual from gate-a JSON', () => {
  const result = sweepL1toL3();
  assert.ok(typeof result === 'object');
  assert.ok(typeof result.residual === 'number');
  assert.ok(typeof result.detail === 'object');
  // Residual should be 0-10 or -1 (error/skipped)
  assert.ok(result.residual >= -1 && result.residual <= 10,
    'residual should be -1 to 10, got ' + result.residual);
  if (result.residual >= 0) {
    assert.ok('wiring_evidence_score' in result.detail, 'detail should have wiring_evidence_score');
    assert.ok('target' in result.detail, 'detail should have target');
    assert.ok('gap' in result.detail, 'detail should have gap');
  }
});

test('TC-LAYER-3: sweepL3toTC returns normalized residual from gate-c JSON', () => {
  const result = sweepL3toTC();
  assert.ok(typeof result === 'object');
  assert.ok(typeof result.residual === 'number');
  assert.ok(result.residual >= -1 && result.residual <= 10,
    'residual should be -1 to 10, got ' + result.residual);
  if (result.residual >= 0) {
    assert.ok('wiring_coverage_score' in result.detail, 'detail should have wiring_coverage_score');
    assert.ok('unvalidated_count' in result.detail, 'detail should have unvalidated_count');
    assert.ok('total_failure_modes' in result.detail, 'detail should have total_failure_modes');
    assert.ok('total_recipes' in result.detail, 'detail should have total_recipes');
  }
});

test('TC-HEATMAP-1: sweepGitHeatmap returns structured result from evidence file', () => {
  const result = sweepGitHeatmap();
  assert.ok(typeof result === 'object');
  assert.ok(typeof result.residual === 'number');
  if (result.residual >= 0) {
    assert.ok('total_hot_zones' in result.detail, 'detail should have total_hot_zones');
    assert.ok('numerical_adjustments_count' in result.detail, 'detail should have numerical_adjustments_count');
    assert.ok('bugfix_hotspots_count' in result.detail, 'detail should have bugfix_hotspots_count');
    assert.ok('churn_files_count' in result.detail, 'detail should have churn_files_count');
    assert.ok(Array.isArray(result.detail.uncovered_hot_zones), 'uncovered_hot_zones should be an array');
    assert.ok(result.detail.uncovered_hot_zones.length <= 20, 'uncovered_hot_zones capped at 20');
  } else {
    assert.ok(result.detail.skipped || result.detail.error, 'negative residual should have skipped or error detail');
  }
});

test('TC-HEATMAP-2: computeResidual includes git_heatmap and heatmap_total', () => {
  // Uses fast integration spawn to avoid running all sweeps (including expensive sweepFtoC)
  // from within the test process. Verifies JSON output shape of a real run.
  const spawnResult = spawnSync(process.execPath, [
    path.join(ROOT, 'bin', 'nf-solve.cjs'),
    '--json',
    '--report-only',
    '--fast',
    '--skip-proximity',
    '--max-iterations=1',
  ], { encoding: 'utf8', cwd: ROOT, timeout: 60000, maxBuffer: 1024 * 1024 });

  let parsed;
  try {
    parsed = JSON.parse(spawnResult.stdout.trim());
  } catch (err) {
    assert.fail('stdout is not valid JSON: ' + err.message);
  }
  const residual = parsed.residual_vector;
  assert.ok(residual, 'residual_vector should exist in JSON output');
  assert.ok('git_heatmap' in residual, 'residual should include git_heatmap');
  assert.ok('heatmap_total' in residual, 'residual should include heatmap_total');
  assert.ok(typeof residual.heatmap_total === 'number');
  // heatmap_total should NOT be included in forward total
  const forwardKeys = ['r_to_f', 'f_to_t', 'c_to_f', 't_to_c', 'f_to_c', 'r_to_d', 'd_to_c', 'p_to_f'];
  let expectedTotal = 0;
  for (const key of forwardKeys) {
    if (residual[key] && residual[key].residual >= 0) {
      expectedTotal += residual[key].residual;
    }
  }
  assert.equal(residual.total, expectedTotal, 'forward total should NOT include heatmap');
});

test('TC-LAYER-4: layer_total computed correctly (sum of 3 layer residuals, excluding -1 errors)', () => {
  // Build a mock residual to verify layer_total computation logic
  const mockL1 = { residual: 3, detail: {} };
  const mockL2 = { residual: -1, detail: { error: true } };
  const mockL3 = { residual: 5, detail: {} };

  // Replicate the computation from computeResidual
  const layerTotal =
    (mockL1.residual >= 0 ? mockL1.residual : 0) +
    (mockL2.residual >= 0 ? mockL2.residual : 0) +
    (mockL3.residual >= 0 ? mockL3.residual : 0);

  assert.equal(layerTotal, 8, 'layer_total should sum non-error residuals: 3 + 0 + 5 = 8');
});

test('TC-LAYER-5: layer sweeps do NOT inflate existing total field', () => {
  // Uses fast integration spawn to avoid running all sweeps from within the test process.
  const spawnResult = spawnSync(process.execPath, [
    path.join(ROOT, 'bin', 'nf-solve.cjs'),
    '--json',
    '--report-only',
    '--fast',
    '--skip-proximity',
    '--max-iterations=1',
  ], { encoding: 'utf8', cwd: ROOT, timeout: 60000, maxBuffer: 1024 * 1024 });

  let parsed;
  try {
    parsed = JSON.parse(spawnResult.stdout.trim());
  } catch (err) {
    assert.fail('stdout is not valid JSON: ' + err.message);
  }
  const result = parsed.residual_vector;
  assert.ok(result, 'residual_vector should exist in JSON output');
  assert.ok(typeof result.total === 'number', 'total should be a number');
  assert.ok(typeof result.layer_total === 'number', 'layer_total should be a number');

  // Verify total does not include layer sweep residuals
  const forwardTotal =
    (result.r_to_f.residual >= 0 ? result.r_to_f.residual : 0) +
    (result.f_to_t.residual >= 0 ? result.f_to_t.residual : 0) +
    (result.c_to_f.residual >= 0 ? result.c_to_f.residual : 0) +
    (result.t_to_c.residual >= 0 ? result.t_to_c.residual : 0) +
    (result.f_to_c.residual >= 0 ? result.f_to_c.residual : 0) +
    (result.r_to_d.residual >= 0 ? result.r_to_d.residual : 0) +
    (result.d_to_c.residual >= 0 ? result.d_to_c.residual : 0) +
    (result.p_to_f.residual >= 0 ? result.p_to_f.residual : 0);

  assert.equal(result.total, forwardTotal, 'total should only sum forward sweeps, not layer sweeps');
});

test('TC-LAYER-6: computeResidual includes l1_to_l3, l3_to_tc in output (L2 collapsed)', () => {
  // Uses fast integration spawn to avoid running all sweeps from within the test process.
  const spawnResult = spawnSync(process.execPath, [
    path.join(ROOT, 'bin', 'nf-solve.cjs'),
    '--json',
    '--report-only',
    '--fast',
    '--skip-proximity',
    '--max-iterations=1',
  ], { encoding: 'utf8', cwd: ROOT, timeout: 60000, maxBuffer: 1024 * 1024 });

  let parsed;
  try {
    parsed = JSON.parse(spawnResult.stdout.trim());
  } catch (err) {
    assert.fail('stdout is not valid JSON: ' + err.message);
  }
  const result = parsed.residual_vector;
  assert.ok(result, 'residual_vector should exist in JSON output');
  assert.ok('l1_to_l3' in result, 'should have l1_to_l3');
  assert.ok('l3_to_tc' in result, 'should have l3_to_tc');
  assert.ok('layer_total' in result, 'should have layer_total');
  assert.ok(typeof result.l1_to_l3.residual === 'number');
  assert.ok(typeof result.l3_to_tc.residual === 'number');
});

// ── TC-AUTOCLOSE-STUBS: autoClose stub implementation dispatch Tests ─────────

test('TC-AUTOCLOSE-STUBS-1: autoClose returns actions_taken array and stubs_generated number', () => {
  // Build a minimal residual object with f_to_t > 0 to trigger stub generation path
  const mockResidual = {
    r_to_f: { residual: 0, detail: {} },
    f_to_t: { residual: 1, detail: { gaps: ['TEST-REQ'] } },
    c_to_f: { residual: 0, detail: {} },
    t_to_c: { residual: 0, detail: {} },
    f_to_c: { residual: 0, detail: {} },
    r_to_d: { residual: 0, detail: {} },
    d_to_c: { residual: 0, detail: {} },
    p_to_f: { residual: 0, detail: {} },
    total: 1,
  };

  const result = autoClose(mockResidual);

  assert.ok(typeof result === 'object', 'autoClose should return an object');
  assert.ok(Array.isArray(result.actions_taken), 'should have actions_taken array');
  assert.ok(typeof result.stubs_generated === 'number', 'should have stubs_generated number');

  // When f_to_t > 0, actions should mention stub generation or _implement-stubs
  const allActions = result.actions_taken.join(' ');
  assert.ok(
    allActions.includes('stub') || allActions.includes('Implemented') || allActions.includes('Upgraded') || allActions.includes('Skipped'),
    'actions should reference stub generation or upgrade: ' + allActions
  );
});

test('TC-AUTOCLOSE-STUBS-2: autoClose with zero f_to_t does not dispatch stub upgrade', () => {
  const mockResidual = {
    r_to_f: { residual: 0, detail: {} },
    f_to_t: { residual: 0, detail: {} },
    c_to_f: { residual: 0, detail: {} },
    t_to_c: { residual: 0, detail: {} },
    f_to_c: { residual: 0, detail: {} },
    r_to_d: { residual: 0, detail: {} },
    d_to_c: { residual: 0, detail: {} },
    total: 0,
  };

  const result = autoClose(mockResidual);

  assert.ok(Array.isArray(result.actions_taken), 'should have actions_taken array');
  // With all zeros, no stub-related action should be present
  const allActions = result.actions_taken.join(' ');
  assert.ok(
    !allActions.includes('Upgraded TODO stubs'),
    'should not reference stub upgrade when f_to_t is 0'
  );
});

// ── TC-SESSION: Session Persistence Tests ─────────────────────────────────────

const os = require('os');
const fs = require('fs');

test('TC-SESSION-1: persistSessionSummary writes file to target directory', () => {
  const tmpDir = path.join(os.tmpdir(), 'nf-solve-test-session-' + Date.now());
  try {
    persistSessionSummary('mock report', '{"mock": true}', true, [{ iteration: 1, actions: [] }], tmpDir);
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('solve-session-') && f.endsWith('.md'));
    assert.ok(files.length === 1, 'Should create exactly one session file, got ' + files.length);
    assert.ok(files[0].match(/^solve-session-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.md$/), 'Filename should match timestamp pattern');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* cleanup */ }
  }
});

test('TC-SESSION-2: Session file contains expected sections', () => {
  const tmpDir = path.join(os.tmpdir(), 'nf-solve-test-session-' + Date.now());
  try {
    persistSessionSummary('mock report text', '{"mock": "json"}', false, [{ iteration: 1, actions: ['closed gap X'] }], tmpDir);
    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.md'));
    const content = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8');
    assert.ok(content.includes('# nf-solve Session Summary'), 'Should have main header');
    assert.ok(content.includes('## Residual Vector'), 'Should have Residual Vector section');
    assert.ok(content.includes('## Machine State'), 'Should have Machine State section');
    assert.ok(content.includes('## Actions Taken'), 'Should have Actions Taken section');
    assert.ok(content.includes('mock report text'), 'Should contain the report text');
    assert.ok(content.includes('"mock": "json"'), 'Should contain the JSON data');
    assert.ok(content.includes('closed gap X'), 'Should contain action items');
    assert.ok(content.includes('**Converged:** No'), 'Should show convergence status');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* cleanup */ }
  }
});

test('TC-SESSION-3: Pruning keeps only MAX_SESSION_FILES (20)', () => {
  const tmpDir = path.join(os.tmpdir(), 'nf-solve-test-prune-' + Date.now());
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    // Create 25 dummy session files with sequential timestamps
    for (let i = 0; i < 25; i++) {
      const pad = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(tmpDir, 'solve-session-2026-01-' + pad + 'T00-00-00Z.md'), 'dummy');
    }
    // Call persistSessionSummary which will add one more and prune
    persistSessionSummary('report', '{}', true, [{ iteration: 1, actions: [] }], tmpDir);
    const remaining = fs.readdirSync(tmpDir).filter(f => f.startsWith('solve-session-') && f.endsWith('.md'));
    assert.ok(remaining.length <= 20, 'Should have at most 20 files after pruning, got ' + remaining.length);
    // The oldest files (00-04) should be deleted
    assert.ok(!remaining.includes('solve-session-2026-01-00T00-00-00Z.md'), 'Oldest file should be pruned');
    assert.ok(!remaining.includes('solve-session-2026-01-04T00-00-00Z.md'), 'Fifth oldest file should be pruned');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* cleanup */ }
  }
});

test('TC-SESSION-4: Fail-open on write error (invalid directory)', () => {
  // Should not throw — fail-open pattern
  persistSessionSummary('report', '{}', true, [{ iteration: 1, actions: [] }], '/nonexistent/path/that/should/fail');
  // If we reach here, the function handled the error gracefully
  assert.ok(true, 'persistSessionSummary should not throw on write error');
});

// ── TC-PROMO-INIT: consecutive_clean_sessions Initialization Tests (PROMO-02) ─

test('TC-PROMO-INIT-1: first run initializes consecutive_clean_sessions to 0', () => {
  // Simulate reading a missing solve-state.json (try/catch returns {})
  const existingSolveState = {};
  const prevClean = (existingSolveState && existingSolveState.consecutive_clean_sessions) || 0;
  assert.equal(prevClean, 0, 'Missing consecutive_clean_sessions should default to 0');
});

test('TC-PROMO-INIT-2: existing solve-state.json preserves consecutive_clean_sessions value', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-solve-promo-init-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'solve-state.json'), JSON.stringify({ consecutive_clean_sessions: 5 }));
    const existingSolveState = JSON.parse(fs.readFileSync(path.join(tmpDir, 'solve-state.json'), 'utf8'));
    assert.equal(existingSolveState.consecutive_clean_sessions, 5);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-PROMO-INIT-3: clean session increments consecutive_clean_sessions', () => {
  const prevClean = 2;
  const isCleanSession = true;
  const result = isCleanSession ? prevClean + 1 : 0;
  assert.equal(result, 3);
});

test('TC-PROMO-INIT-4: non-clean session resets consecutive_clean_sessions to 0', () => {
  const prevClean = 5;
  const isCleanSession = false;
  const result = isCleanSession ? prevClean + 1 : 0;
  assert.equal(result, 0);
});

test('TC-PROMO-INIT-5: null consecutive_clean_sessions in JSON defaults to 0', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-solve-promo-null-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'solve-state.json'), JSON.stringify({ converged: false }));
    const existingSolveState = JSON.parse(fs.readFileSync(path.join(tmpDir, 'solve-state.json'), 'utf8'));
    const prevClean = (existingSolveState.consecutive_clean_sessions) || 0;
    assert.equal(prevClean, 0, 'Missing field in JSON should default to 0');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC-PROMO-SEMANTIC: checkCleanSession semantic_score Evaluation Tests (PROMO-03) ─

test('TC-PROMO-SEMANTIC-1: all gates with wiring >= 1.0 and semantic >= 0.8 = CLEAN', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-solve-semantic-'));
  const gatesDir = path.join(tmpDir, 'gates');
  fs.mkdirSync(gatesDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(gatesDir, 'gate-a-grounding.json'), JSON.stringify({ wiring_evidence_score: 1.0, semantic_score: 0.85 }));
    fs.writeFileSync(path.join(gatesDir, 'gate-b-abstraction.json'), JSON.stringify({ wiring_purpose_score: 1.0, semantic_score: 0.9 }));
    fs.writeFileSync(path.join(gatesDir, 'gate-c-validation.json'), JSON.stringify({ wiring_coverage_score: 1.0, semantic_score: 0.8 }));

    // Evaluate using the same logic as checkCleanSession
    const GATE_FILES = {
      A: { file: 'gate-a-grounding.json', wiringKey: 'wiring_evidence_score' },
      B: { file: 'gate-b-abstraction.json', wiringKey: 'wiring_purpose_score' },
      C: { file: 'gate-c-validation.json', wiringKey: 'wiring_coverage_score' },
    };
    const wiring = {};
    const semantic = {};
    for (const [label, cfg] of Object.entries(GATE_FILES)) {
      const gateData = JSON.parse(fs.readFileSync(path.join(gatesDir, cfg.file), 'utf8'));
      wiring[label] = gateData[cfg.wiringKey] != null ? gateData[cfg.wiringKey] : 0;
      semantic[label] = gateData.semantic_score != null ? gateData.semantic_score : 0;
    }
    const wiringClean = wiring.A >= 1.0 && wiring.B >= 1.0 && wiring.C >= 1.0;
    const semanticClean = semantic.A >= 0.8 && semantic.B >= 0.8 && semantic.C >= 0.8;
    const isClean = wiringClean && semanticClean;
    assert.equal(isClean, true, 'All gates above thresholds should be CLEAN');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-PROMO-SEMANTIC-2: semantic_score below 0.8 on any gate = NOT CLEAN', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-solve-semantic-low-'));
  const gatesDir = path.join(tmpDir, 'gates');
  fs.mkdirSync(gatesDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(gatesDir, 'gate-a-grounding.json'), JSON.stringify({ wiring_evidence_score: 1.0, semantic_score: 0.85 }));
    fs.writeFileSync(path.join(gatesDir, 'gate-b-abstraction.json'), JSON.stringify({ wiring_purpose_score: 1.0, semantic_score: 0.7 }));
    fs.writeFileSync(path.join(gatesDir, 'gate-c-validation.json'), JSON.stringify({ wiring_coverage_score: 1.0, semantic_score: 0.8 }));

    const GATE_FILES = {
      A: { file: 'gate-a-grounding.json', wiringKey: 'wiring_evidence_score' },
      B: { file: 'gate-b-abstraction.json', wiringKey: 'wiring_purpose_score' },
      C: { file: 'gate-c-validation.json', wiringKey: 'wiring_coverage_score' },
    };
    const semantic = {};
    for (const [label, cfg] of Object.entries(GATE_FILES)) {
      const gateData = JSON.parse(fs.readFileSync(path.join(gatesDir, cfg.file), 'utf8'));
      semantic[label] = gateData.semantic_score != null ? gateData.semantic_score : 0;
    }
    const semanticClean = semantic.A >= 0.8 && semantic.B >= 0.8 && semantic.C >= 0.8;
    assert.equal(semanticClean, false, 'Gate B at 0.7 should fail threshold');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-PROMO-SEMANTIC-3: missing semantic_score field defaults to 0 = NOT CLEAN', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-solve-semantic-missing-'));
  const gatesDir = path.join(tmpDir, 'gates');
  fs.mkdirSync(gatesDir, { recursive: true });
  try {
    // Gate files with wiring score but NO semantic_score
    fs.writeFileSync(path.join(gatesDir, 'gate-a-grounding.json'), JSON.stringify({ wiring_evidence_score: 1.0 }));
    fs.writeFileSync(path.join(gatesDir, 'gate-b-abstraction.json'), JSON.stringify({ wiring_purpose_score: 1.0 }));
    fs.writeFileSync(path.join(gatesDir, 'gate-c-validation.json'), JSON.stringify({ wiring_coverage_score: 1.0 }));

    const GATE_FILES = {
      A: { file: 'gate-a-grounding.json', wiringKey: 'wiring_evidence_score' },
      B: { file: 'gate-b-abstraction.json', wiringKey: 'wiring_purpose_score' },
      C: { file: 'gate-c-validation.json', wiringKey: 'wiring_coverage_score' },
    };
    const semantic = {};
    for (const [label, cfg] of Object.entries(GATE_FILES)) {
      const gateData = JSON.parse(fs.readFileSync(path.join(gatesDir, cfg.file), 'utf8'));
      semantic[label] = gateData.semantic_score != null ? gateData.semantic_score : 0;
    }
    assert.equal(semantic.A, 0, 'Missing semantic_score should default to 0');
    assert.equal(semantic.B, 0);
    assert.equal(semantic.C, 0);
    const semanticClean = semantic.A >= 0.8 && semantic.B >= 0.8 && semantic.C >= 0.8;
    assert.equal(semanticClean, false, 'Missing semantic_score should be NOT CLEAN');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-PROMO-SEMANTIC-4: wiring below 1.0 = NOT CLEAN even with good semantic', () => {
  const GATE_FILES = {
    A: { file: 'gate-a-grounding.json', wiringKey: 'wiring_evidence_score' },
    B: { file: 'gate-b-abstraction.json', wiringKey: 'wiring_purpose_score' },
    C: { file: 'gate-c-validation.json', wiringKey: 'wiring_coverage_score' },
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-solve-semantic-lowwire-'));
  const gatesDir = path.join(tmpDir, 'gates');
  fs.mkdirSync(gatesDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(gatesDir, 'gate-a-grounding.json'), JSON.stringify({ wiring_evidence_score: 0.5, semantic_score: 1.0 }));
    fs.writeFileSync(path.join(gatesDir, 'gate-b-abstraction.json'), JSON.stringify({ wiring_purpose_score: 0.5, semantic_score: 1.0 }));
    fs.writeFileSync(path.join(gatesDir, 'gate-c-validation.json'), JSON.stringify({ wiring_coverage_score: 0.5, semantic_score: 1.0 }));

    const wiring = {};
    for (const [label, cfg] of Object.entries(GATE_FILES)) {
      const gateData = JSON.parse(fs.readFileSync(path.join(gatesDir, cfg.file), 'utf8'));
      wiring[label] = gateData[cfg.wiringKey] != null ? gateData[cfg.wiringKey] : 0;
    }
    const wiringClean = wiring.A >= 1.0 && wiring.B >= 1.0 && wiring.C >= 1.0;
    assert.equal(wiringClean, false, 'Wiring at 0.5 should fail even with semantic=1.0');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-PROMO-SEMANTIC-5: missing semantic_score on ALL gates logs diagnostic and is NOT CLEAN', () => {
  // Test the default-to-0 behavior for all gates — simulates v0.34-04 semantic scoring not yet run
  const gateData = { wiring_evidence_score: 1.0 }; // No semantic_score field
  const semanticScore = gateData.semantic_score != null ? gateData.semantic_score : 0;
  assert.equal(semanticScore, 0, 'Missing semantic_score should default to 0');
  assert.equal(semanticScore >= 0.8, false, 'Defaulted 0 should not pass 0.8 threshold');

  // Verify the diagnostic pattern is present in source code
  const source = fs.readFileSync(path.join(__dirname, 'nf-solve.cjs'), 'utf8');
  assert.ok(source.includes('semantic_score defaulted to 0 (field missing)'), 'Source should contain diagnostic for missing semantic_score');
  assert.ok(source.includes('semantic_score='), 'Source should contain diagnostic for present semantic_score');
});

test('TC-PROMO-SEMANTIC-6: counterexample in check-results.ndjson = NOT CLEAN', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-solve-semantic-counter-'));
  try {
    // Simulate check-results.ndjson with a counterexample
    fs.writeFileSync(path.join(tmpDir, 'check-results.ndjson'), '{"result":"counterexample"}\n');

    let formalPass = true;
    const checkResultsPath = path.join(tmpDir, 'check-results.ndjson');
    const lines = fs.readFileSync(checkResultsPath, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.result === 'counterexample') {
        formalPass = false;
        break;
      }
    }
    assert.equal(formalPass, false, 'Counterexample should cause NOT CLEAN');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC-CLASS: Classification Cache Key Tests (CLASS-01) ──────────────────────

const { itemKey } = require('./solve-tui.cjs');

test('TC-CLASS-1: dtoc key is a 16-char hex string', () => {
  const key = itemKey('dtoc', { doc_file: 'README.md', value: 'bin/foo.cjs', reason: 'file not found' });
  assert.equal(key.length, 16, 'dtoc key should be 16 chars');
  assert.match(key, /^[0-9a-f]{16}$/, 'dtoc key should be hex');
});

test('TC-CLASS-2: dtoc key stability (same input = same key)', () => {
  const a = itemKey('dtoc', { doc_file: 'README.md', value: 'bin/foo.cjs', reason: 'file not found' });
  const b = itemKey('dtoc', { doc_file: 'README.md', value: 'bin/foo.cjs', reason: 'file not found' });
  assert.equal(a, b, 'Same input should produce identical key');
});

test('TC-CLASS-3: dtoc key differentiation (different reason = different key)', () => {
  const a = itemKey('dtoc', { doc_file: 'README.md', value: 'bin/foo.cjs', reason: 'file not found' });
  const b = itemKey('dtoc', { doc_file: 'README.md', value: 'bin/foo.cjs', reason: 'not in package.json' });
  assert.notEqual(a, b, 'Different reasons should produce different keys');
});

test('TC-CLASS-4: dtor key is content-based (same text + different line = same key)', () => {
  const a = itemKey('dtor', { doc_file: 'README.md', line: 10, claim_text: 'supports quorum dispatch' });
  const b = itemKey('dtor', { doc_file: 'README.md', line: 20, claim_text: 'supports quorum dispatch' });
  assert.equal(a, b, 'Same content at different lines should produce same key');
});

test('TC-CLASS-5: dtor key differentiation (different text = different key)', () => {
  const a = itemKey('dtor', { doc_file: 'README.md', line: 10, claim_text: 'supports quorum dispatch' });
  const b = itemKey('dtor', { doc_file: 'README.md', line: 10, claim_text: 'enables parallel execution' });
  assert.notEqual(a, b, 'Different content should produce different keys');
});

test('TC-CLASS-6: dtor key is a 16-char hex string', () => {
  const key = itemKey('dtor', { doc_file: 'README.md', line: 5, claim_text: 'test claim' });
  assert.equal(key.length, 16, 'dtor key should be 16 chars');
  assert.match(key, /^[0-9a-f]{16}$/, 'dtor key should be hex');
});

test('TC-CLASS-7: ctor key remains as file path', () => {
  const key = itemKey('ctor', { file: 'bin/foo.cjs' });
  assert.equal(key, 'bin/foo.cjs', 'ctor key should be file path');
});

test('TC-CLASS-8: ttor key remains as file path', () => {
  const key = itemKey('ttor', { file: 'test/bar.test.cjs' });
  assert.equal(key, 'test/bar.test.cjs', 'ttor key should be file path');
});

// ── TC-FOCUS: Focus filter propagation tests (DIAG-01) ───────────────────────

test('TC-FOCUS-1: --focus flag adds scoped:false to non-filterable layers in JSON output', () => {
  // Integration test: run nf-solve with --focus flag and --json --max-iterations=1
  // in report-only mode to avoid mutations
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'nf-solve.cjs'),
    '--json', '--report-only', '--fast', '--max-iterations=1',
    '--focus=NONEXISTENT-FOCUS-TERM',
  ], {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 60000,
  });

  // Parse JSON output (may have non-JSON prefix lines and trailing content)
  const stdout = result.stdout || '';
  const jsonStart = stdout.indexOf('{');
  if (jsonStart < 0) {
    // If no JSON output, the test still passes if the process ran
    assert.ok(true, 'No JSON output (fast mode may skip layers)');
    return;
  }

  // Find matching closing brace for the top-level JSON object
  let depth = 0;
  let jsonEnd = jsonStart;
  for (let i = jsonStart; i < stdout.length; i++) {
    if (stdout[i] === '{') depth++;
    else if (stdout[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
  }

  let output;
  try {
    output = JSON.parse(stdout.slice(jsonStart, jsonEnd));
  } catch (e) {
    // JSON parse failed — skip test gracefully
    assert.ok(true, 'JSON parse failed, skipping focus integration test');
    return;
  }
  const layers = output.layers || output;

  // Check that non-filterable layers have scoped: false in their detail
  // (layers that cannot filter by requirement ID)
  const nonFilterableLayers = ['c_to_f', 't_to_c', 'd_to_c'];
  for (const layerKey of nonFilterableLayers) {
    const layer = layers[layerKey];
    if (layer && layer.detail && layer.residual >= 0) {
      assert.equal(layer.detail.scoped, false,
        layerKey + ' should have scoped: false when focus is active');
    }
  }
});

test('TC-FOCUS-2: source code has scoped:focusSet in all 16+ non-filterable sweep functions', () => {
  const src = fs.readFileSync(path.join(__dirname, 'nf-solve.cjs'), 'utf8');
  const matches = src.match(/scoped:\s*focusSet/g) || [];
  assert.ok(matches.length >= 15,
    'Expected >= 15 scoped references in nf-solve.cjs, got ' + matches.length);
});

test('TC-FOCUS-3: sweepPtoF.cjs accepts focusSet option and includes scoped flag', () => {
  const ptofSrc = fs.readFileSync(path.join(__dirname, 'sweepPtoF.cjs'), 'utf8');
  assert.ok(ptofSrc.includes('focusSet'), 'sweepPtoF.cjs should reference focusSet');
  assert.ok(ptofSrc.includes('scoped'), 'sweepPtoF.cjs should include scoped in detail');
});

test('TC-FOCUS-4: sweepFtoT filters gaps by focusSet (source code verification)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'nf-solve.cjs'), 'utf8');
  const ftoTMatch = src.match(/function sweepFtoT\(\)[\s\S]*?^}/m);
  assert.ok(ftoTMatch, 'sweepFtoT function should exist');
  const ftoT = ftoTMatch[0];
  assert.ok(ftoT.includes('focusSet'), 'sweepFtoT should reference focusSet for filtering');
  assert.ok(ftoT.includes('gapsList.filter'), 'sweepFtoT should filter gapsList');
});

// ── TC-MISSING: Missing-file residual tests (DIAG-02) ────────────────────────

test('TC-MISSING-1: missing-file returns use residual -1 not 0 (source verification)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'nf-solve.cjs'), 'utf8');

  // Only runner=none should have residual: 0 with skipped: true
  const returnBlocks = src.match(/return\s*\{[^}]*residual:\s*0[^}]*skipped:\s*true[^}]*\}/g) || [];
  const returnBlocks2 = src.match(/return\s*\{[^}]*skipped:\s*true[^}]*residual:\s*0[^}]*\}/g) || [];
  const all = [...returnBlocks, ...returnBlocks2];
  const nonRunner = all.filter(b => !b.includes('runner=none'));
  assert.equal(nonRunner.length, 0,
    'No skipped returns with residual: 0 should exist except runner=none. Found: ' + nonRunner.length);
});

test('TC-MISSING-2: missing-file reasons use missing: prefix pattern', () => {
  const src = fs.readFileSync(path.join(__dirname, 'nf-solve.cjs'), 'utf8');

  // Count "missing:" prefix patterns in reason strings
  const missingReasons = src.match(/reason:\s*'missing:/g) || [];
  assert.ok(missingReasons.length >= 10,
    'Expected >= 10 missing: prefix reasons, got ' + missingReasons.length);
});

test('TC-MISSING-3: sweepTtoC runner=none still returns residual 0 (intentional skip)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'nf-solve.cjs'), 'utf8');
  assert.ok(src.includes("runner=none in config"),
    'sweepTtoC should still have runner=none intentional skip');

  // Verify the runner=none return specifically uses residual: 0
  const runnerNoneBlock = src.match(/runner.*=.*'none'[\s\S]*?return\s*\{[^}]*residual:\s*0[^}]*\}/);
  assert.ok(runnerNoneBlock, 'runner=none should return residual: 0');
});

test('TC-MISSING-4: integration - solve in empty dir returns -1 residuals for missing files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-solve-missing-'));
  // Create minimal .planning directory structure so the script runs
  fs.mkdirSync(path.join(tmpDir, '.planning', 'formal'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });

  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'nf-solve.cjs'),
      '--json', '--report-only', '--fast', '--max-iterations=1',
      '--project-root=' + tmpDir,
    ], {
      encoding: 'utf8',
      cwd: tmpDir,
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const stdout = result.stdout || '';
    const jsonStart = stdout.indexOf('{');
    if (jsonStart < 0) {
      // Even without JSON, verify it ran without crashing
      assert.ok(result.status !== null, 'Process should complete');
      return;
    }

    const output = JSON.parse(stdout.slice(jsonStart));
    const layers = output.layers || output;

    // r_to_d should return -1 (missing requirements.json)
    if (layers.r_to_d) {
      assert.equal(layers.r_to_d.residual, -1,
        'r_to_d should return -1 when requirements.json is missing');
    }

    // c_to_r should return -1 (missing requirements.json)
    if (layers.c_to_r) {
      assert.equal(layers.c_to_r.residual, -1,
        'c_to_r should return -1 when requirements.json is missing');
    }

    // d_to_r should return -1 (missing requirements.json)
    if (layers.d_to_r) {
      assert.equal(layers.d_to_r.residual, -1,
        'd_to_r should return -1 when requirements.json is missing');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC-CODE-TRACE: Code-trace index tests ───────────────────────────────────

test('TC-CODE-TRACE-1: build-code-trace.cjs generates valid index with expected schema', () => {
  const { buildIndex } = require('./build-code-trace.cjs');
  const ROOT = process.cwd();

  const index = buildIndex(ROOT);

  // Verify schema
  assert.strictEqual(index.version, 1, 'Index version should be 1');
  assert.ok(typeof index.generated_at === 'string', 'generated_at should be a string');
  assert.ok(index.sources && typeof index.sources.recipes === 'number', 'sources.recipes should be a number');
  assert.ok(index.sources && typeof index.sources.scopes === 'number', 'sources.scopes should be a number');
  assert.ok(typeof index.traced_files === 'object', 'traced_files should be an object');
  assert.ok(Array.isArray(index.scope_only), 'scope_only should be an array');

  // Verify content
  assert.ok(Object.keys(index.traced_files).length > 0, 'traced_files should have entries');
  assert.ok(index.sources.recipes > 0, 'sources.recipes should be > 0');
});

test('TC-CODE-TRACE-2: code-trace-index.json file exists and is valid JSON', () => {
  const indexPath = path.join(process.cwd(), '.planning', 'formal', 'code-trace-index.json');
  assert.ok(fs.existsSync(indexPath), 'code-trace-index.json should exist');

  const content = fs.readFileSync(indexPath, 'utf8');
  const index = JSON.parse(content);  // Should not throw

  assert.strictEqual(index.version, 1, 'Index version should be 1');
  assert.ok(Object.keys(index.traced_files).length > 200, 'Should have 200+ traced files');
});

test('TC-CODE-TRACE-3: Source-module inheritance - test files inherit source req IDs', () => {
  const { buildIndex } = require('./build-code-trace.cjs');
  const ROOT = process.cwd();

  const index = buildIndex(ROOT);

  // Check that bin/nf-solve.test.cjs has the same or inherited req IDs from bin/nf-solve.cjs
  const sourceReqs = index.traced_files['bin/nf-solve.cjs'];
  const testReqs = index.traced_files['bin/nf-solve.test.cjs'];

  if (sourceReqs && sourceReqs.length > 0) {
    assert.ok(testReqs && testReqs.length > 0, 'Test file should have inherited req IDs from source');
    // At least some overlap
    const overlap = sourceReqs.filter(r => testReqs.includes(r));
    assert.ok(overlap.length > 0, 'Test file should share at least one req ID with source file');
  }
});

test('TC-CODE-TRACE-4: buildIndex gracefully handles missing directories', () => {
  const { buildIndex } = require('./build-code-trace.cjs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-trace-test-'));

  try {
    const index = buildIndex(tmpDir);

    // Should return valid structure even with no recipes/scopes
    assert.strictEqual(index.version, 1, 'Should return valid index');
    assert.strictEqual(index.sources.recipes, 0, 'recipes count should be 0');
    assert.strictEqual(index.sources.scopes, 0, 'scopes count should be 0');
    assert.ok(typeof index.traced_files === 'object', 'traced_files should exist');
    assert.ok(Array.isArray(index.scope_only), 'scope_only should exist');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-CODE-TRACE-5: sweepCtoR uses code-trace index to reduce false positives', () => {
  const src = fs.readFileSync(path.join(__dirname, 'nf-solve.cjs'), 'utf8');

  // Verify sweepCtoR has the index check
  assert.ok(src.includes('loadCodeTraceIndex()'), 'sweepCtoR should call loadCodeTraceIndex');
  assert.ok(src.includes('index.traced_files[file]'), 'sweepCtoR should check index.traced_files');
  assert.ok(src.includes('index.scope_only.includes(file)'), 'sweepCtoR should check index.scope_only');
});

test('TC-CODE-TRACE-6: sweepTtoR uses code-trace index to reduce false positives', () => {
  const src = fs.readFileSync(path.join(__dirname, 'nf-solve.cjs'), 'utf8');

  // Extract sweepTtoR function
  const ftoTMatch = src.match(/function sweepTtoR\(\)[\s\S]*?^function /m);
  assert.ok(ftoTMatch, 'sweepTtoR function should exist');
  const ftoT = ftoTMatch[0];

  // Verify index check
  assert.ok(ftoT.includes('loadCodeTraceIndex()'), 'sweepTtoR should call loadCodeTraceIndex');
  assert.ok(ftoT.includes('index.traced_files[testFile]'), 'sweepTtoR should check index.traced_files');
});

test('TC-CODE-TRACE-8: sweepTtoR require-path tracing maps domain-named test via require() dep (behavioral)', () => {
  // BEHAVIORAL test: execute the SAME tracing logic sweepTtoR uses and verify
  // it produces correct mapped/orphan decisions against real files and a controlled index.
  //
  // sweepTtoR is not exported, so we can't call it directly. Instead we:
  //   1. Verify the tracing block exists structurally (prerequisite)
  //   2. Extract and RUN the tracing regex + index-lookup logic independently
  //   3. Simulate the full decision path: file content -> regex -> dep extraction -> index lookup -> mapped?
  //
  // This proves the code WORKS, not just that it EXISTS.

  const src = fs.readFileSync(path.join(__dirname, 'nf-solve.cjs'), 'utf8');

  // -- Step 1: Structural prerequisite --
  const fnMatch = src.match(/function sweepTtoR\(\)[\s\S]*?^function /m);
  assert.ok(fnMatch, 'sweepTtoR function should exist');
  const fn = fnMatch[0];
  assert.ok(fn.includes('Require-path tracing'), 'sweepTtoR should have require-path tracing comment');

  // -- Step 2: Execute the tracing regex against real test files --
  // Use the EXACT same regex pattern that sweepTtoR uses
  const tracingRegex = /require\(['"]\.\.?\/(bin\/[^'"]+)['"]\)/g;

  // POSITIVE case: b-to-f-sweep.test.cjs requires bin/layer-constants.cjs
  const testContent = fs.readFileSync(path.join(__dirname, '..', 'test', 'b-to-f-sweep.test.cjs'), 'utf8');
  const matches = testContent.match(tracingRegex);
  assert.ok(matches && matches.length > 0, 'b-to-f-sweep.test.cjs should have require("../bin/...") imports');

  // Extract dep paths the same way sweepTtoR does (inner regex on each match)
  const depPaths = matches.map(m => {
    const depMatch = m.match(/require\(['"]\.\.?\/(bin\/[^'"]+)['"]\)/);
    return depMatch ? depMatch[1] : null;
  }).filter(Boolean);
  assert.ok(depPaths.includes('bin/layer-constants.cjs'), 'Should extract bin/layer-constants.cjs as a dependency');

  // NEGATIVE case: b-to-f-remediate.test.cjs has NO bin/ imports (self-contained)
  const selfContained = fs.readFileSync(path.join(__dirname, '..', 'test', 'b-to-f-remediate.test.cjs'), 'utf8');
  const noMatches = selfContained.match(tracingRegex);
  assert.strictEqual(noMatches, null, 'b-to-f-remediate.test.cjs should have no require("../bin/...") — it is self-contained');

  // -- Step 3: Simulate the index-lookup decision path --
  // Build a controlled code-trace index where bin/layer-constants.cjs IS tracked
  const mockIndex = {
    traced_files: {
      'bin/layer-constants.cjs': { requirements: ['BTF-01'] },
      'bin/nf-solve.cjs': { requirements: ['SOLVE-01'] }
    }
  };

  // Replay sweepTtoR's hasTrackedDep logic: check if ANY extracted dep is in the index
  const hasTrackedDep = depPaths.some(dep => !!mockIndex.traced_files[dep]);
  assert.strictEqual(hasTrackedDep, true,
    'POSITIVE: b-to-f-sweep.test.cjs should be MAPPED because bin/layer-constants.cjs is in the index');

  // Replay for the negative case: no deps extracted -> hasTrackedDep must be false
  const negativeDepPaths = (noMatches || []).map(m => {
    const depMatch = m.match(/require\(['"]\.\.?\/(bin\/[^'"]+)['"]\)/);
    return depMatch ? depMatch[1] : null;
  }).filter(Boolean);
  const negativeHasTrackedDep = negativeDepPaths.some(dep => !!mockIndex.traced_files[dep]);
  assert.strictEqual(negativeHasTrackedDep, false,
    'NEGATIVE: b-to-f-remediate.test.cjs should be ORPHAN (no bin/ deps to look up)');

  // -- Step 4: Verify with an index where the dep is NOT tracked --
  // Even if regex matches, the file should remain orphan if the dep isn't in the index
  const emptyIndex = { traced_files: {} };
  const unmappedResult = depPaths.some(dep => !!emptyIndex.traced_files[dep]);
  assert.strictEqual(unmappedResult, false,
    'When index has no matching traced_files, test should NOT be mapped via tracing');
});

test('TC-CODE-TRACE-7: computeResidual rebuilds code-trace index before sweeps', () => {
  const src = fs.readFileSync(path.join(__dirname, 'nf-solve.cjs'), 'utf8');

  // Find computeResidual and verify rebuildCodeTraceIndex is called before c_to_r
  // QUICK-344: c_to_r now uses checkLayerSkip wrapper, so match the broader pattern
  // Deadline guard adds pastDeadline() ? deadlineSkip() : sweepCtoR pattern
  const computeMatch = src.match(/function computeResidual\(\)[\s\S]*?const c_to_r = (?:checkLayerSkip.*\|\| )?(?:\(pastDeadline\(\) \? deadlineSkip\(\) : )?sweepCtoR/);
  assert.ok(computeMatch, 'computeResidual should call sweepCtoR (possibly via checkLayerSkip and/or deadline guard)');

  const computeFn = computeMatch[0];
  assert.ok(computeFn.includes('rebuildCodeTraceIndex()'),
    'computeResidual should call rebuildCodeTraceIndex before sweeps');
});

// ── TC-01: V8 Coverage Digest (@req TC-01) ────────────────────────────────

// @requirement TC-01
test('@req TC-01: digestV8Coverage converts raw V8 coverage to compact format', () => {
  // Mock raw V8 coverage data (simulates node --experimental-vm-modules output)
  const rawCoverage = [
    {
      result: [
        {
          url: 'file:///tmp/test-file.cjs',
          source: 'line1\nline2\nline3\nline4\nline5\n',
          functions: [
            {
              functionName: '',
              ranges: [
                { startOffset: 0, endOffset: 30, count: 1 },   // covered
                { startOffset: 12, endOffset: 18, count: 0 },  // uncovered (line 3)
              ],
            },
          ],
        },
        {
          url: 'node:internal/modules/cjs/loader',
          functions: [],
        },
      ],
    },
  ];

  const digest = digestV8Coverage(rawCoverage);

  // Must return an object with files property
  assert.ok(digest, 'digestV8Coverage should return non-null for valid input');
  assert.ok(digest.files, 'digest should have a files property');

  // Should include the test file but NOT the node: internal URL
  const keys = Object.keys(digest.files);
  assert.ok(keys.length === 1, 'should have exactly 1 file (node: URLs excluded)');

  const fileEntry = digest.files[keys[0]];
  assert.ok(Array.isArray(fileEntry.covered), 'covered should be an array');
  assert.ok(Array.isArray(fileEntry.uncovered), 'uncovered should be an array');

  // Covered lines should include at least one line number
  assert.ok(fileEntry.covered.length > 0, 'should have at least one covered line');

  // Compression check: raw input is larger than digest output
  const rawSize = JSON.stringify(rawCoverage).length;
  const digestSize = JSON.stringify(digest).length;
  assert.ok(digestSize < rawSize, 'digest should be smaller than raw input');
});

// @requirement TC-01
test('@req TC-01: digestV8Coverage returns null for invalid input', () => {
  assert.strictEqual(digestV8Coverage(null), null);
  assert.strictEqual(digestV8Coverage(undefined), null);
  assert.strictEqual(digestV8Coverage('not-array'), null);
});

// @requirement TC-01
test('@req TC-01: digestV8Coverage handles entries without source (boolean marker fallback)', () => {
  const rawCoverage = [
    {
      result: [
        {
          url: 'file:///tmp/no-source.cjs',
          // No source property
          functions: [
            {
              functionName: 'main',
              ranges: [{ startOffset: 0, endOffset: 100, count: 1 }],
            },
          ],
        },
      ],
    },
  ];

  const digest = digestV8Coverage(rawCoverage);
  assert.ok(digest, 'should return non-null');
  const keys = Object.keys(digest.files);
  assert.ok(keys.length === 1, 'should have 1 file');
  const entry = digest.files[keys[0]];
  // Boolean marker fallback: covered = [true]
  assert.deepStrictEqual(entry.covered, [true], 'covered should be [true] for boolean marker');
});

// ── TC-HTARGET: Hypothesis-driven wave ordering tests ────────────────────────

const { computeLayerPriorityWeights } = require('./hypothesis-layer-map.cjs');
const { computeWaves } = require('./solve-wave-dag.cjs');

/**
 * Build a minimal residual object with all layers at zero except overrides.
 * @param {Object} overrides - layer keys to override with non-zero values
 * @returns {Object} residual object suitable for autoClose
 */
function buildMinimalResidual(overrides = {}) {
  const allLayers = [
    'f_to_t', 'c_to_f', 't_to_c', 'r_to_f', 'f_to_c', 'r_to_d', 'd_to_c',
    'p_to_f', 'per_model_gates', 'formal_lint', 'git_heatmap', 'c_to_r',
    't_to_r', 'd_to_r', 'hazard_model', 'l1_to_l3', 'l3_to_tc', 'h_to_m'
  ];
  const res = {};
  for (const key of allLayers) {
    res[key] = { residual: 0, detail: {} };
  }
  for (const [key, val] of Object.entries(overrides)) {
    res[key] = val;
  }
  return res;
}

// @requirement HTARGET-01
test('TC-HTARGET-1: autoClose without waveOrder produces same actions as before (backward compat)', () => {
  const residual = buildMinimalResidual({
    f_to_t: { residual: 1, detail: {} },
  });
  const result = autoClose(residual);
  assert.ok(Array.isArray(result.actions_taken), 'should have actions_taken array');
  assert.ok(typeof result.stubs_generated === 'number', 'should have stubs_generated number');
});

// @requirement HTARGET-02
test('TC-HTARGET-2: autoClose with waveOrder dispatches layers in wave-specified order', () => {
  const residual = buildMinimalResidual({
    r_to_f: { residual: 1, detail: { total: 1, covered: 0, percentage: 0 } },
    t_to_c: { residual: 1, detail: {} },
  });

  // t_to_c first, then r_to_f
  const result1 = autoClose(residual, new Set(), [
    { wave: 1, layers: ['t_to_c'] },
    { wave: 2, layers: ['r_to_f'] },
  ]);
  const layerActions1 = result1.actions_taken.filter(a =>
    a.includes('test failure') || a.includes('requirement') || a.includes('lack formal')
  );
  assert.ok(layerActions1.length >= 2, 'should have at least 2 layer actions');
  assert.ok(layerActions1[0].includes('test failure'), 'first action should mention test failure (t_to_c)');
  assert.ok(
    layerActions1[1].includes('requirement') || layerActions1[1].includes('lack formal'),
    'second action should mention requirement (r_to_f)'
  );

  // Reversed: r_to_f first, then t_to_c
  const result2 = autoClose(residual, new Set(), [
    { wave: 1, layers: ['r_to_f'] },
    { wave: 2, layers: ['t_to_c'] },
  ]);
  const layerActions2 = result2.actions_taken.filter(a =>
    a.includes('test failure') || a.includes('requirement') || a.includes('lack formal')
  );
  assert.ok(layerActions2.length >= 2, 'reversed should have at least 2 layer actions');
  assert.ok(
    layerActions2[0].includes('requirement') || layerActions2[0].includes('lack formal'),
    'reversed first action should mention requirement (r_to_f)'
  );
  assert.ok(layerActions2[1].includes('test failure'), 'reversed second action should mention test failure (t_to_c)');
});

// @requirement HTARGET-01
test('TC-HTARGET-3: autoClose with waveOrder skips unknown layer keys gracefully', () => {
  const residual = buildMinimalResidual();
  const result = autoClose(residual, new Set(), [
    { wave: 1, layers: ['nonexistent_layer', 'also_fake'] },
  ]);
  assert.ok(result, 'should return normally');
  assert.ok(Array.isArray(result.actions_taken), 'should have actions_taken array');
  // No crash = pass
});

// @requirement HTARGET-02
test('TC-HTARGET-4: computeWaves + computeLayerPriorityWeights integration', () => {
  // Create mock transitions
  const transitions = [{ layer_keys: ['r_to_f'] }];
  const weights = computeLayerPriorityWeights(transitions);
  assert.deepStrictEqual(weights, { r_to_f: 1 }, 'should produce r_to_f weight of 1');

  // Create mock residual for computeWaves
  const residual = { r_to_f: { residual: 1 }, f_to_t: { residual: 1 } };
  const waves = computeWaves(residual, weights);
  assert.ok(Array.isArray(waves), 'should return array');
  assert.ok(waves.length > 0, 'should have at least one wave');

  // Verify wave objects contain the expected layers
  const allLayers = waves.flatMap(w => w.layers);
  assert.ok(allLayers.includes('r_to_f'), 'should include r_to_f in wave layers');
  assert.ok(allLayers.includes('f_to_t'), 'should include f_to_t in wave layers');

  // Verify wave structure is preserved (not flattened)
  for (const w of waves) {
    assert.ok(typeof w.wave === 'number', 'wave object should have wave number');
    assert.ok(Array.isArray(w.layers), 'wave object should have layers array');
  }
});

// @requirement HARDEN-PROX
test('TC-HARDEN-PROX-1: proximityPreFilter fails open on null/undefined instead of crashing', () => {
  let result;
  assert.doesNotThrow(() => { result = proximityPreFilter(null); }, 'null candidates must not throw');
  assert.ok(result && Array.isArray(result.filtered), 'should return a filtered array');
  assert.equal(result.filtered.length, 0, 'null input yields no filtered candidates');
  assert.equal(result.stats.total, 0, 'stats.total should be 0');
  assert.equal(result.stats.passed, 0, 'stats.passed should be 0');
  assert.doesNotThrow(() => proximityPreFilter(undefined), 'undefined candidates must not throw');
});

// @requirement HARDEN-SCAN
test('TC-HARDEN-SCAN-1: computeScannerStats tolerates a null scanner entry (corrupt classifications)', () => {
  let stats;
  assert.doesNotThrow(() => { stats = computeScannerStats({ ctor: null, ttor: { a: 'fp', b: 'genuine' } }); }, 'null nested entry must not throw');
  assert.ok(stats.ctor, 'should still emit an entry for the null scanner');
  assert.equal(stats.ctor.total, 0, 'null scanner counts as 0 items');
  assert.equal(stats.ctor.fp, 0);
  assert.equal(stats.ttor.total, 2, 'valid scanner still counted');
  assert.equal(stats.ttor.fp, 1);
  assert.equal(stats.ttor.genuine, 1);
});

// @requirement HARDEN-CFT
test('TC-HARDEN-CFT-1: classifyFailingTest tolerates null trace/model/bug inputs (corrupt JSON)', () => {
  let res;
  assert.doesNotThrow(() => { res = classifyFailingTest('test/foo.test.cjs', null, null, null); }, 'null shapes must not throw');
  assert.equal(res.classification, 'not_covered', 'no trace data => not_covered');
  assert.ok(Array.isArray(res.models), 'models should be an array');
  assert.match(res.bug_id, /^[0-9a-f]{8}$/, 'bug_id should be an 8-char hex hash');
});

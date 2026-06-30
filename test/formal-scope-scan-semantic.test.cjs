'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'bin', 'formal-scope-scan.cjs');
const SPEC_DIR = path.join(ROOT, '.planning', 'formal', 'spec');

const { cosineSim, runAgenticLayer, runSemanticLayer } = require('../bin/formal-scope-scan.cjs');

// ── cosineSim unit tests ───────────────────────────────────────────────────────

describe('cosineSim', () => {
  it('cosineSim of identical unit vectors is 1', () => {
    assert.strictEqual(cosineSim([1, 0, 0], [1, 0, 0]), 1);
  });

  it('cosineSim of orthogonal vectors is 0', () => {
    assert.strictEqual(cosineSim([1, 0], [0, 1]), 0);
  });

  it('cosineSim general case [0.6, 0.8] . [0.8, 0.6] = 0.96', () => {
    const result = cosineSim([0.6, 0.8], [0.8, 0.6]);
    assert.ok(Math.abs(result - 0.96) < 1e-9, 'expected ~0.96, got ' + result);
  });
});

// ── --no-l3 flag test ─────────────────────────────────────────────────────────

describe('--no-l3 flag', () => {
  it('returns [] when no match and --no-l3 is set (no transformer import attempted)', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--description', 'zzz-xyzzy-nomatch-999', '--no-l3', '--format', 'json'], {
      encoding: 'utf8', timeout: 15000, cwd: ROOT
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout.trim()), []);
  });
});

// ── runAgenticLayer fallback tests ────────────────────────────────────────────

describe('runAgenticLayer', () => {
  it('returns [] when claude binary is missing (claudeBin injection)', () => {
    const result = runAgenticLayer('circuit breaker', SPEC_DIR, '/nonexistent/claude-bin-xyz');
    assert.deepStrictEqual(result, []);
  });

  it('returns [] when specDir does not exist', () => {
    const result = runAgenticLayer('circuit breaker', '/tmp/nonexistent-spec-dir-99999');
    assert.deepStrictEqual(result, []);
  });

  it('Layer 4 falls back gracefully when claude binary is missing (injection)', () => {
    const result = runAgenticLayer('zzz-xyzzy-nomatch-query', SPEC_DIR, '/nonexistent/claude-bin-xyz');
    assert.deepStrictEqual(result, []);
  });
});

// ── Layer 3 success-path integration test ────────────────────────────────────

describe('runSemanticLayer', () => {
  it('returns semantic match above threshold (integration — skipped if package/model unavailable)', async (t) => {
    // Skip (with a visible reason) when the optional embeddings package isn't installed.
    try { await import('@huggingface/transformers'); } catch { t.skip('@huggingface/transformers not installed'); return; }
    // The actual CI flake was the model LOAD throwing — `pipeline(...)` downloads
    // 'Xenova/all-MiniLM-L6-v2', which fails on a cold cache / offline runner and varies
    // across Node versions. Treat ONLY that (a thrown error) as a skip; a successful run
    // that returns no match is a real regression and must still fail. (runSemanticLayer
    // returns [] only when the package is missing, which the import guard above already
    // covers — so reaching here means the package is present.)
    let result;
    try {
      result = await runSemanticLayer('circuit breaker', [{ name: 'breaker', concepts: ['circuit breaker timeout'] }], 0.1);
    } catch { t.skip('embedding model failed to load/run in this environment'); return; }
    assert.ok(result.length > 0, 'expected at least one semantic match');
    assert.strictEqual(result[0].matched_by, 'semantic');
  });
});

// ── Regression test: layers 1+2 still work after async main() ────────────────

describe('regression: layers 1+2', () => {
  it('layers 1+2 still return exact/proximity match after async main() change', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--description', 'circuit breaker', '--format', 'json'], {
      encoding: 'utf8', timeout: 15000, cwd: ROOT
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.ok(output.length > 0, 'expected at least one match');
    assert.ok(output.some(m => m.matched_by !== undefined), 'expected at least one item with a matched_by field');
    const VALID_L1_L2 = ['source_file', 'concept', 'module_name', 'proximity_graph'];
    assert.ok(
      output.some(m => VALID_L1_L2.includes(m.matched_by)),
      'expected at least one Layer 1/2 result with valid matched_by'
    );
  });
});

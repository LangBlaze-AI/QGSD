#!/usr/bin/env node
'use strict';
// bin/cli-robustness.test.cjs
// Regression tests for CLI-robustness fixes found by dogfooding nForma skills:
//   - nf-solve.cjs / detect-coverage-gaps.cjs: `--help` must short-circuit
//     before any work (no full-pipeline hang, no destructive writes).
//   - check-provider-health.cjs: `--json` must emit VALID JSON even when no
//     HTTP-backed slots exist — callers (e.g. quorum.md) JSON.parse() it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = __dirname;

function run(script, args, opts = {}) {
  return spawnSync(process.execPath, [path.join(BIN, script), ...args], {
    encoding: 'utf8', timeout: 20000, ...opts,
  });
}

describe('nf-solve.cjs --help', () => {
  it('exits 0 with usage instead of hanging into the diagnostic sweep', () => {
    const r = run('nf-solve.cjs', ['--help']);
    assert.equal(r.status, 0, `expected exit 0, got status=${r.status} signal=${r.signal} (hang?)`);
    assert.match(r.stdout, /Usage: nf-solve/);
  });
});

describe('detect-coverage-gaps.cjs --help', () => {
  it('exits 0 with usage and writes no .planning artifacts', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcg-'));
    try {
      const r = run('detect-coverage-gaps.cjs', ['--help'], { cwd: tmp });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /Usage: detect-coverage-gaps/);
      assert.equal(fs.existsSync(path.join(tmp, '.planning')), false, 'must not write on --help');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('check-provider-health.cjs --json (no HTTP slots)', () => {
  it('emits valid JSON, not a human-readable string', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cph-'));
    const cfg = path.join(tmp, 'claude.json');
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: {} }));
    const env = { ...process.env, NF_CLAUDE_JSON: cfg };
    delete env.PROVIDER_SLOT;
    try {
      const r = run('check-provider-health.cjs', ['--json'], { env });
      assert.equal(r.status, 0);
      // JSON.parse throws on the old plain-string output → test fails (the bug).
      const parsed = JSON.parse(r.stdout.trim());
      assert.ok(Array.isArray(parsed), 'empty-slots --json output should be an array');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

#!/usr/bin/env node
'use strict';

/**
 * Hermetic resolution-order test for bin/resolve-providers.cjs (issue #197).
 *
 * Verifies the single source of truth resolves providers.json with ONE
 * deterministic order, and that every dispatch-pipeline entry point that
 * delegates to it resolves the SAME physical file.
 *
 * Isolation: a temp HOME directory and a fake ~/.claude.json via the
 * NF_CLAUDE_JSON env override. No real ~/.claude.json or ~/.claude/nf-bin is
 * touched, so the test is reproducible on any machine and in CI.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RESOLVER = path.join(__dirname, '..', 'bin', 'resolve-providers.cjs');

// Fresh module instance with a controlled environment.
function freshResolver() {
  delete require.cache[require.resolve(RESOLVER)];
  return require(RESOLVER);
}

const POPULATED = { providers: [{ name: 'codex-1', cli: 'codex', type: 'subprocess' }] };
const EMPTY = { providers: [] };

let tmp, savedEnv;

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data), 'utf8');
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-resolve-providers-'));
  savedEnv = {
    HOME: process.env.HOME,
    UNIFIED_PROVIDERS_CONFIG: process.env.UNIFIED_PROVIDERS_CONFIG,
    NF_CLAUDE_JSON: process.env.NF_CLAUDE_JSON,
  };
  // Point HOME at the temp dir so ~/.claude/nf-bin resolves under the sandbox.
  process.env.HOME = tmp;
  delete process.env.UNIFIED_PROVIDERS_CONFIG;
  delete process.env.NF_CLAUDE_JSON;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});

describe('resolve-providers.cjs resolution order (issue #197)', () => {
  it('1. UNIFIED_PROVIDERS_CONFIG env wins over everything', () => {
    const envPath = path.join(tmp, 'env-providers.json');
    writeJson(envPath, POPULATED);
    // Decoys at lower-priority locations.
    writeJson(path.join(tmp, '.claude', 'nf-bin', 'providers.json'), POPULATED);
    process.env.UNIFIED_PROVIDERS_CONFIG = envPath;

    const { resolveProvidersConfig } = freshResolver();
    const r = resolveProvidersConfig({ baseDir: tmp, quiet: true });
    assert.equal(r.path, envPath);
  });

  it('2. ~/.claude.json unified-mcp-server pointer wins over nf-bin', () => {
    const pointerDir = path.join(tmp, 'pointer-bin');
    const pointerProviders = path.join(pointerDir, 'providers.json');
    writeJson(pointerProviders, POPULATED);
    const claudeJson = path.join(tmp, 'claude.json');
    writeJson(claudeJson, {
      mcpServers: {
        'unified-1': { args: ['node', path.join(pointerDir, 'unified-mcp-server.mjs')] },
      },
    });
    writeJson(path.join(tmp, '.claude', 'nf-bin', 'providers.json'), POPULATED);
    process.env.NF_CLAUDE_JSON = claudeJson;

    const { resolveProvidersConfig } = freshResolver();
    const r = resolveProvidersConfig({ baseDir: tmp, quiet: true });
    assert.equal(r.path, pointerProviders);
  });

  it('3. __dirname is used only when non-empty', () => {
    const baseDir = path.join(tmp, 'samedir');
    writeJson(path.join(baseDir, 'providers.json'), POPULATED);
    const nfBin = path.join(tmp, '.claude', 'nf-bin', 'providers.json');
    writeJson(nfBin, POPULATED);

    const { resolveProvidersConfig } = freshResolver();
    const r = resolveProvidersConfig({ baseDir, quiet: true });
    assert.equal(r.path, path.join(baseDir, 'providers.json'));
  });

  it('3b. empty __dirname providers.json is skipped → falls through to nf-bin', () => {
    const baseDir = path.join(tmp, 'samedir-empty');
    writeJson(path.join(baseDir, 'providers.json'), EMPTY); // shipped repo source is empty by design
    const nfBin = path.join(tmp, '.claude', 'nf-bin', 'providers.json');
    writeJson(nfBin, POPULATED);

    const { resolveProvidersConfig } = freshResolver();
    const r = resolveProvidersConfig({ baseDir, quiet: true });
    assert.equal(r.path, nfBin);
  });

  it('4. ~/.claude/nf-bin/providers.json is the canonical installed fallback', () => {
    const nfBin = path.join(tmp, '.claude', 'nf-bin', 'providers.json');
    writeJson(nfBin, POPULATED);

    const { resolveProvidersConfig } = freshResolver();
    const r = resolveProvidersConfig({ baseDir: path.join(tmp, 'nonexistent'), quiet: true });
    assert.equal(r.path, nfBin);
  });

  it('5. legacy nf/bin path is used only when non-empty and nothing else matches', () => {
    const legacy = path.join(tmp, '.claude', 'nf', 'bin', 'providers.json');
    writeJson(legacy, POPULATED);

    const { resolveProvidersConfig } = freshResolver();
    const r = resolveProvidersConfig({ baseDir: path.join(tmp, 'nonexistent'), quiet: true });
    assert.equal(r.path, legacy);
  });

  it('5b. empty legacy nf/bin file is skipped → resolves to null', () => {
    writeJson(path.join(tmp, '.claude', 'nf', 'bin', 'providers.json'), EMPTY);

    const { resolveProvidersConfig } = freshResolver();
    const r = resolveProvidersConfig({ baseDir: path.join(tmp, 'nonexistent'), quiet: true });
    assert.equal(r, null);
  });

  it('returns null when no populated providers.json exists anywhere', () => {
    const { resolveProvidersConfig } = freshResolver();
    const r = resolveProvidersConfig({ baseDir: path.join(tmp, 'nope'), quiet: true });
    assert.equal(r, null);
  });

  it('logs the chosen path to stderr by default', () => {
    const nfBin = path.join(tmp, '.claude', 'nf-bin', 'providers.json');
    writeJson(nfBin, POPULATED);
    const writes = [];
    const orig = process.stderr.write;
    process.stderr.write = (s) => { writes.push(String(s)); return true; };
    try {
      const { resolveProvidersConfig } = freshResolver();
      resolveProvidersConfig({ baseDir: path.join(tmp, 'nonexistent') });
    } finally {
      process.stderr.write = orig;
    }
    assert.ok(writes.some((w) => w.includes('[resolve-providers]') && w.includes(nfBin)));
  });
});

describe('every entry point resolves the SAME file (issue #197)', () => {
  it('all dispatch-pipeline modules delegate to resolve-providers and agree', () => {
    // Single canonical installed copy; every entry point must select it.
    const nfBin = path.join(tmp, '.claude', 'nf-bin', 'providers.json');
    writeJson(nfBin, POPULATED);

    const baseDir = path.join(tmp, 'nf-bin-script'); // empty/nonexistent same-dir → falls through

    const { resolveProvidersConfig, loadProviders } = freshResolver();
    const expected = resolveProvidersConfig({ baseDir, quiet: true }).path;
    assert.equal(expected, nfBin);

    // loadProviders (the convenience wrapper used by all wired call sites) must
    // return the providers array from that same file.
    const providers = loadProviders({ baseDir, quiet: true });
    assert.deepEqual(providers, POPULATED.providers);

    // Static guarantee: every wired dispatch-pipeline module requires the shared
    // resolver rather than re-implementing the search. This is what makes them
    // resolve the SAME file at runtime.
    const wired = [
      'call-quorum-slot.cjs',
      'probe-quorum-slots.cjs',
      'quorum-preflight.cjs',
      'provider-status.cjs',
      'quorum-consensus-gate.cjs',
      'quorum-slot-dispatch.cjs',
      'check-provider-health.cjs',
      'update-agents.cjs',
      'unified-mcp-server.mjs',
    ];
    for (const f of wired) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'bin', f), 'utf8');
      assert.ok(
        /require\(\s*['"]\.\/resolve-providers\.cjs['"]\s*\)/.test(src),
        `${f} must require ./resolve-providers.cjs (single source of truth)`
      );
    }
  });
});

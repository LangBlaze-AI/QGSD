#!/usr/bin/env node
'use strict';

/**
 * Regression test for issue #196: preflight reported the entire healthy fleet as
 * dead because probeHealth spawned the raw `cli` field, which is null on
 * mainTool-only fleets (every live install). spawn(null) threw → every slot
 * "spawn failed ...Received null" → nf-prompt's NF_ALL_SLOTS_DOWN branch → every
 * quorum silently ran solo, defeating the min_live_voters floor (#192).
 *
 * Run: node --test test/quorum-preflight-maintool-healthy.test.cjs
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SCRIPT = path.join(__dirname, '..', 'bin', 'quorum-preflight.cjs');
const { probeHealth, findProviders } = require(SCRIPT);

describe('quorum-preflight spawn-target fallback (issue #196)', () => {
  it('a mainTool-only provider (cli:null) probes HEALTHY, not spawn-failed', async () => {
    // `node` is guaranteed present; cli is null exactly like a real install.
    const health = await probeHealth([{ name: 't-codex', cli: null, mainTool: 'node' }]);
    assert.equal(health['t-codex'].healthy, true,
      `mainTool-only slot must be healthy, got: ${JSON.stringify(health['t-codex'])}`);
    assert.ok(
      !/Received null|spawn failed/i.test(health['t-codex'].layer1.reason || ''),
      'layer1 must not be a spawn(null) failure',
    );
  });

  it('resolvedCli takes precedence when present', async () => {
    const health = await probeHealth([{ name: 't-pre', cli: null, mainTool: 'definitely-not-a-real-binary-xyz', resolvedCli: process.execPath }]);
    assert.equal(health['t-pre'].healthy, true, 'resolvedCli should win over a bogus mainTool');
  });

  it('a provider with no cli/resolvedCli/mainTool is unhealthy with an explicit reason (no spawn crash)', async () => {
    const health = await probeHealth([{ name: 't-none', cli: null, mainTool: null }]);
    assert.equal(health['t-none'].healthy, false);
    assert.match(health['t-none'].layer1.reason || '', /no CLI configured/i);
  });
});

describe('quorum-preflight findProviders empty-file skip (issue #196)', () => {
  it('skips the empty repo stub and returns the installed fleet (true regression)', () => {
    // The repo stub bin/providers.json (first in the search path) is
    // {"providers":[]}. Pre-fix, findProviders returned that empty array as the
    // fleet; post-fix it must skip it and fall through to the installed copy at
    // $HOME/.claude/nf-bin/providers.json. Force a non-empty installed fleet in a
    // temp HOME so the buggy path (→ []) and the fixed path (→ fleet) DIVERGE.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-preflight-'));
    const nfBin = path.join(tmpHome, '.claude', 'nf-bin');
    fs.mkdirSync(nfBin, { recursive: true });
    const installed = [{ name: 'codex-1', mainTool: 'codex', display_type: 'codex-cli' }];
    fs.writeFileSync(path.join(nfBin, 'providers.json'), JSON.stringify({ providers: installed }));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome; // findProviders resolves via os.homedir() → $HOME on POSIX
    try {
      const result = findProviders();
      assert.ok(Array.isArray(result), 'returns an array');
      assert.equal(result.length, 1, 'must skip the empty stub and return the installed fleet, not []');
      assert.equal(result[0].name, 'codex-1', 'returns the installed providers, not the repo stub');
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe('quorum-preflight numeric stdout is not ANSI-colorized (issue #196)', () => {
  it('--max-quorum-size emits a bare integer parseable by shell', () => {
    const out = execFileSync('node', [SCRIPT, '--max-quorum-size'], {
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '3' },
    });
    assert.doesNotMatch(out, /\x1b\[/, 'output must contain no ANSI escape codes');
    assert.match(out.trim(), /^\d+$/, 'output must be a bare integer');
  });
});

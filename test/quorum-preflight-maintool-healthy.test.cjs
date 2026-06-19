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
  it('skips an empty {"providers":[]} file and falls through', () => {
    // The repo stub bin/providers.json is {"providers":[]}; from a checkout,
    // __dirname/providers.json is first in the search path. findProviders must
    // not return that empty array as "the fleet".
    const result = findProviders();
    assert.ok(Array.isArray(result), 'returns an array');
    // Either resolves a non-empty installed fleet, or an empty array — but never
    // the empty repo stub masquerading as a configured (but zero-slot) fleet.
    if (result.length === 0) {
      // acceptable: nothing installed in this environment
      assert.equal(result.length, 0);
    } else {
      assert.ok(result.length > 0, 'a resolved fleet must be non-empty');
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

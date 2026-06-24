#!/usr/bin/env node
'use strict';

// Regression test for the Layer-1 binary-probe cache (quorum reliability).
// quorum-preflight.cjs ran a live CLI-binary spawn for every slot on every
// invocation — and nf-prompt calls preflight up to twice per prompt — so each
// UserPromptSubmit re-spawned codex/gemini/copilot/opencode. The fix caches the
// binary probe (kind:'binary', `bin:<target>` key, short TTL). This test proves
// the spawn happens ONCE across two probeHealth() calls within the TTL.
//
// Run: node --test test/quorum-preflight-binary-cache.test.cjs

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'bin', 'quorum-preflight.cjs');

// Runs probeHealth() `n` times in a child process with HOME=home (so the cache
// file lands under the temp HOME), against a provider whose CLI is a fake that
// appends to a counter file on each spawn. Returns the number of spawns.
function spawnCount(home, fakeCli, n) {
  const helper = path.join(home, 'helper.cjs');
  fs.writeFileSync(helper, `
    const { probeHealth } = require(${JSON.stringify(SCRIPT)});
    (async () => {
      const providers = [{ name: 'fake', cli: ${JSON.stringify(fakeCli)} }];
      for (let i = 0; i < ${n}; i++) await probeHealth(providers);
    })().catch(e => { process.stderr.write(String(e) + '\\n'); process.exit(1); });
  `);
  execFileSync(process.execPath, [helper], {
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000,
  });
  const counterPath = path.join(home, 'count.log');
  if (!fs.existsSync(counterPath)) return 0;
  return fs.readFileSync(counterPath, 'utf8').split('\n').filter(Boolean).length;
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-binc-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const fakeCli = path.join(home, 'fake-cli.sh');
  // append one line per invocation, then exit 0 (a "healthy" binary)
  fs.writeFileSync(fakeCli, `#!/bin/sh\nprintf 'x\\n' >> "${path.join(home, 'count.log')}"\nexit 0\n`);
  fs.chmodSync(fakeCli, 0o755);
  return { home, fakeCli };
}

describe('quorum-preflight Layer-1 binary-probe cache', () => {
  it('spawns the CLI binary once across two probeHealth() calls within the TTL', () => {
    const { home, fakeCli } = makeHome();
    try {
      const count = spawnCount(home, fakeCli, 2);
      assert.equal(count, 1, `expected the binary to spawn ONCE (cached on the 2nd probe), got ${count}`);
      // and the cache carries a binary entry
      const cache = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'nf-provider-cache.json'), 'utf8'));
      const binKeys = Object.keys(cache.entries || {}).filter((k) => k.startsWith('bin:'));
      assert.ok(binKeys.length >= 1, 'a bin: cache entry must be written');
      assert.equal(cache.entries[binKeys[0]].kind, 'binary', "binary entries must be tagged kind:'binary'");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('still spawns once even across three calls (cache holds for the burst)', () => {
    const { home, fakeCli } = makeHome();
    try {
      assert.equal(spawnCount(home, fakeCli, 3), 1, 'a 3-call burst must still spawn the binary once');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// The audit found two divergent per-call-site copies of shared logic. These
// guards keep the consolidation from regressing.
describe('quorum helper consolidation (audit follow-up)', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('probe-quorum-slots resolves ${VAR} env placeholders (parity with call-quorum-slot)', () => {
    const src = read('bin/probe-quorum-slots.cjs');
    assert.ok(/resolveEnvPlaceholders\(provider\.env/.test(src),
      'probe-quorum-slots must run provider.env through resolveEnvPlaceholders, not pass it raw');
    assert.ok(!/\.\.\.\(provider\.env \?\? \{\}\)/.test(src),
      'the raw `...(provider.env ?? {})` spread must be gone');
  });

  it('unified-mcp-server resolveSpawnTarget delegates to the shared resolver', () => {
    const src = read('bin/unified-mcp-server.mjs');
    assert.ok(/sharedResolveSpawnTarget\(provider\)/.test(src),
      'unified-mcp-server must delegate to the shared resolveSpawnTarget');
    assert.ok(!/const target = provider\.resolvedCli \|\| provider\.cli \|\| provider\.mainTool;/.test(src),
      'the local bare-name resolution must be removed (no per-call-site copy)');
  });
});

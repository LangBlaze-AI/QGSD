'use strict';

// resolveUpdateCommand — the shared update-command resolver used by BOTH
// bin/update-agents.cjs (runUpdate) and bin/nForma.cjs (updateAgentsFlow).
//
// Regression origin: the two callers duplicated the routing, and the non-npm
// `else` branch hardcoded `gh extension upgrade copilot`. So any family whose
// installType wasn't npm-global — antigravity (curl-script), kimi (self-update)
// — was "updated" with copilot's command (nForma.cjs) or no-op'd (update-agents.cjs).
// Extracting one resolver fixes the class in both. (CodeRabbit, PR #373.)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveUpdateCommand } = require('./update-agents.cjs');

describe('resolveUpdateCommand', () => {
  it('npm-global → npm install -g <pkg>@latest (no shell)', () => {
    assert.deepEqual(
      resolveUpdateCommand({ installType: 'npm-global', pkg: '@openai/codex' }),
      { cmd: 'npm', args: ['install', '-g', '@openai/codex@latest'], shell: false }
    );
  });

  it('gh-extension → gh extension upgrade copilot (no shell)', () => {
    assert.deepEqual(
      resolveUpdateCommand({ installType: 'gh-extension', ext: 'github/gh-copilot' }),
      { cmd: 'gh', args: ['extension', 'upgrade', 'copilot'], shell: false }
    );
  });

  it('kimi (self-update) → its own `kimi upgrade`, NOT copilot, via shell', () => {
    const c = resolveUpdateCommand({ installType: 'self-update', bin: 'kimi', installCommand: 'kimi upgrade' });
    assert.equal(c.cmd, 'kimi upgrade');
    assert.equal(c.shell, true);
    // the specific defect this guards: kimi must never be routed to copilot's command
    assert.notEqual(c.cmd, 'gh');
    assert.ok(!/copilot/.test(JSON.stringify(c)), 'kimi update must not mention copilot');
  });

  it('antigravity (curl-script) → its curl installer, NOT copilot, via shell', () => {
    const c = resolveUpdateCommand({ installType: 'curl-script', bin: 'agy', installCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' });
    assert.equal(c.shell, true, 'a piped curl command must run through a shell');
    assert.ok(/curl/.test(c.cmd) && /antigravity/.test(c.cmd), 'must run the antigravity installer');
    assert.ok(!/copilot/.test(c.cmd), 'antigravity update must not run copilot');
  });

  it('any installCommand-bearing family runs that command (not the copilot fallback)', () => {
    const c = resolveUpdateCommand({ installType: 'whatever-future-type', installCommand: 'foo update' });
    assert.deepEqual(c, { cmd: 'foo update', args: [], shell: true });
  });

  it('returns null for an unknown installType with no installCommand (caller handles, no wrong command)', () => {
    assert.equal(resolveUpdateCommand({ installType: 'mystery' }), null);
    assert.equal(resolveUpdateCommand({}), null);
    assert.equal(resolveUpdateCommand(null), null);
  });

  it('npm-global without a pkg is not treated as npm (falls through, never a bad npm install)', () => {
    // A malformed npm-global entry must not produce `npm install -g undefined@latest`.
    assert.equal(resolveUpdateCommand({ installType: 'npm-global' }), null);
  });
});

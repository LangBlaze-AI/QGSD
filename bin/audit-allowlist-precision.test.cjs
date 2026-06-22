'use strict';
// bin/audit-allowlist-precision.test.cjs
// Guards two audit-precision fixes + one allowlist fix found by dogfooding:
//   F4a — audit-agent-payloads ran nf-solve.cjs (a captured but slow orchestrator)
//         to a 15s timeout and reported `error`.
//   F4c — it ran trace-corpus-stats.cjs (whose --json is fire-and-forget, written
//         to an evidence file and discarded) and reported a 256KB oversize warning.
//         Both are now `skipped` with an accurate reason via KNOWN_NON_PAYLOAD.
//   F38 — mcp-set-model.md calls `mcp__<agent>__identity` directly, so the slot
//         must be allow-listed; the phantom `ccr-*` entries are dropped and the
//         real Daintree slots (claude-z-ai, claude-minimax) are added.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { auditScript, KNOWN_NON_PAYLOAD } = require('./audit-agent-payloads.cjs');

describe('F4a/F4c — payload audit skips non-payload scripts accurately', () => {
  it('nf-solve.cjs → skipped (orchestrator), not error', () => {
    const r = auditScript('nf-solve.cjs');
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /orchestrator/i);
  });

  it('trace-corpus-stats.cjs → skipped (fire-and-forget), not an oversize warning', () => {
    const r = auditScript('trace-corpus-stats.cjs');
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /fire-and-forget|discarded/i);
  });

  it('the skip-map is scoped to exactly those two known scripts', () => {
    assert.deepEqual(Object.keys(KNOWN_NON_PAYLOAD).sort(),
      ['nf-solve.cjs', 'trace-corpus-stats.cjs']);
  });

  it('requiring the module has no side effects (does not run the audit)', () => {
    // If require() ran main(), the test process would have audited every script.
    // Reaching here at all proves the require.main guard works; assert the export
    // surface is the pure functions.
    assert.equal(typeof auditScript, 'function');
  });
});

describe('F38 — mcp-set-model allow-lists the real default slots', () => {
  const md = fs.readFileSync(path.join(__dirname, '../commands/nf/mcp-set-model.md'), 'utf8');
  it('includes the Daintree slots that Step 3 calls directly', () => {
    assert.ok(/mcp__claude-z-ai__identity/.test(md));
    assert.ok(/mcp__claude-minimax__identity/.test(md));
  });
  it('no longer lists phantom ccr-* slots', () => {
    assert.ok(!/mcp__ccr-\d+__identity/.test(md));
  });
  it('still lists the standard slots', () => {
    for (const s of ['codex-1', 'gemini-1', 'opencode-1', 'copilot-1', 'claude-1']) {
      assert.ok(md.includes(`mcp__${s}__identity`), `${s} must stay allow-listed`);
    }
  });

  it('its Step 5 eval passes env BEFORE node (process.env.AGENT/MODEL not undefined)', () => {
    // Same class as the mcp-setup F1 bug: `node -e "<js>" AGENT="x" MODEL="y"` puts
    // the assignments in argv, not env, so process.env.AGENT/MODEL were undefined
    // and the write stored model_preferences[undefined]=undefined.
    assert.ok(!/node -e "(?:[^"\\]|\\.)*"[ \t]+[A-Z_][A-Z0-9_]*=/.test(md),
      'no trailing-env-after-eval may remain');
    assert.ok(/AGENT="\$AGENT" MODEL="\$MODEL" node -e "/.test(md),
      'env must be assigned before node -e');
  });
});

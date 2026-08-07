'use strict';

// STALL-TIMEOUT-03 — the timer model a live quorum ruled on (2026-08-07).
//
// The old model asked "has this slot produced < 500 bytes?" and treated that as evidence
// of a hang. A quorum run falsified it by killing three of its own five voters mid-answer:
// they had emitted a ~200-byte preamble in under a second and were thinking in silence.
// Byte count never measured liveness — STREAMING does. So there are now two windows:
//   • before the first byte → ttfb_timeout_ms (default 30s), where fast-fail belongs
//   • after the first byte  → inter_chunk_ceiling_ms, else the caller's idle budget
// `stall_timeout_ms` survives as a legacy alias for the ceiling, because the values
// already in that field were measured against post-preamble silence.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveTtfbTimeout, resolveInterChunkCeiling, runSubprocess, parseVerdictLine } = require('./call-quorum-slot.cjs');

describe('resolveTtfbTimeout — the only window that may fast-fail', () => {
  it('defaults to 30s', () => {
    assert.deepEqual(resolveTtfbTimeout({ name: 'codex-1' }), { ms: 30000, source: 'default' });
    assert.deepEqual(resolveTtfbTimeout({}), { ms: 30000, source: 'default' });
  });

  it('honors an explicit per-slot ttfb_timeout_ms', () => {
    assert.deepEqual(resolveTtfbTimeout({ ttfb_timeout_ms: 120000 }), { ms: 120000, source: 'per-slot' });
    assert.equal(resolveTtfbTimeout({ ttfb_timeout_ms: '45000' }).ms, 45000);
  });

  it('is NOT derived from idle_timeout_ms — that derivation was the bug', () => {
    // STALL-TIMEOUT-02 derived the kill window from idle_timeout_ms, which made that
    // field mean "how long may this model think before output". For copilot-1 (30s) and
    // claude-1 (90s) the configured value was far below real think time, so both were
    // killed mid-answer. TTFB must ignore it entirely.
    assert.deepEqual(resolveTtfbTimeout({ idle_timeout_ms: 90000 }), { ms: 30000, source: 'default' });
    assert.deepEqual(resolveTtfbTimeout({ idle_timeout_ms: 30000 }), { ms: 30000, source: 'default' });
  });

  it('falls back to the default for garbage / non-numeric values', () => {
    for (const bad of [0, -5, 'nope', null, true, {}, Infinity === 0]) {
      assert.equal(resolveTtfbTimeout({ ttfb_timeout_ms: bad }).ms, 30000, `bad=${JSON.stringify(bad)}`);
    }
  });

  it('clamps an oversized value to TIMEOUT_MAX (Node fires >2^31-1ms timers immediately)', () => {
    assert.equal(resolveTtfbTimeout({ ttfb_timeout_ms: 3e9 }).ms, 2147483647);
    assert.equal(resolveTtfbTimeout({ ttfb_timeout_ms: Infinity }).ms, 2147483647);
  });
});

describe('resolveInterChunkCeiling — a streaming slot is alive', () => {
  it("defaults to the caller's idle budget once bytes are flowing", () => {
    // This is the fix for the three killed voters: the caller had budgeted 300s while
    // the derived window was 30s/90s.
    assert.deepEqual(resolveInterChunkCeiling({ idle_timeout_ms: 90000 }, 300000), { ms: 300000, source: 'idle-budget' });
    assert.deepEqual(resolveInterChunkCeiling({ idle_timeout_ms: 30000 }, 300000), { ms: 300000, source: 'idle-budget' });
  });

  it('honors an explicit per-slot ceiling above the caller budget (kimi ~610s)', () => {
    assert.deepEqual(
      resolveInterChunkCeiling({ inter_chunk_ceiling_ms: 660000 }, 300000),
      { ms: 660000, source: 'per-slot' },
    );
  });

  it('treats a legacy stall_timeout_ms as the ceiling, not as TTFB', () => {
    // Values already in that field were measured against post-preamble silence, which
    // is exactly what the ceiling governs — so the migration is semantics-preserving.
    assert.deepEqual(resolveInterChunkCeiling({ stall_timeout_ms: 270000 }, 300000), { ms: 270000, source: 'legacy-stall' });
    // The new field wins when both are present.
    assert.equal(resolveInterChunkCeiling({ inter_chunk_ceiling_ms: 400000, stall_timeout_ms: 270000 }, 300000).ms, 400000);
  });

  it('falls back to 90s only when the caller supplies no budget at all', () => {
    assert.deepEqual(resolveInterChunkCeiling({}), { ms: 90000, source: 'default' });
    assert.deepEqual(resolveInterChunkCeiling({}, 0), { ms: 90000, source: 'default' });
  });

  it('reports a source for every branch, so the dispatch log is diagnosable', () => {
    assert.equal(resolveInterChunkCeiling({ inter_chunk_ceiling_ms: 1 }, 5).source, 'per-slot');
    assert.equal(resolveInterChunkCeiling({ stall_timeout_ms: 1 }, 5).source, 'legacy-stall');
    assert.equal(resolveInterChunkCeiling({}, 5).source, 'idle-budget');
    assert.equal(resolveInterChunkCeiling({}).source, 'default');
  });
});

// ─── LIVE PATH ────────────────────────────────────────────────────────────────
// A resolver returning the right number is worth nothing if the number never reaches
// the timer. These spawn real CLIs shaped like the two failure modes.

// Emits a short preamble immediately, then thinks in silence, then answers — the exact
// shape of claude-1 / copilot-1 / claude-z-ai, which the old model killed mid-answer.
const FAKE_BURSTY = `
'use strict';
process.stdout.write('thinking...\\n');
setTimeout(() => {
  process.stdout.write('verdict: APPROVE\\n');
  process.exit(0);
}, Number(process.env.NF_FAKE_PAUSE_MS || 900));
`;

// Emits NOTHING at all — the only shape that is genuinely indistinguishable from hung.
const FAKE_SILENT = `
'use strict';
setTimeout(() => { process.stdout.write('too late\\n'); process.exit(0); }, 5000);
`;

// Cleanup on process exit rather than TestContext.after: `t.after` landed in Node
// 18.8, and package.json declares engines.node ">=18.0.0".
const TMP_DIRS = [];
process.on('exit', () => {
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

function makeFakeSlotDir(body = FAKE_BURSTY) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-stall-'));
  TMP_DIRS.push(dir);
  // findProjectRoot() walks up to the nearest .planning/ — without one here it would
  // find the real repo and write this test's telemetry into it.
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  const cli = path.join(dir, 'fake-cli.cjs');
  fs.writeFileSync(cli, body, 'utf8');
  return { dir, cli };
}

function fakeProvider(cli) {
  return { name: 'fake-slot', type: 'subprocess', mainTool: 'node', cli: 'node', args_template: [cli, '{prompt}'] };
}

describe('LIVE PATH: two windows, two failure modes', () => {
  it('THE REGRESSION: a preamble then a long silence SURVIVES a short TTFB window', async () => {
    // This is the whole point. Old model: 200 bytes < 500 → the tight window governs →
    // killed at 400ms. New model: the first byte disarms TTFB and the inter-chunk
    // ceiling (3s) governs the 900ms think. Three real voters died on exactly this.
    // Margins are generous on purpose: a 400ms TTFB window made this test fail when node
    // process startup itself crossed it under parallel load — that measures the machine,
    // not the semantics. 1.5s TTFB vs a 4s silence cannot be crossed by startup jitter,
    // and a still-armed TTFB would kill at 1.5s, well short of the 4s answer.
    const { cli } = makeFakeSlotDir();
    const provider = { ...fakeProvider(cli), env: { NF_FAKE_PAUSE_MS: '4000' } };
    const out = await runSubprocess(provider, 'q', 20000, 30000, null, {}, { ttfb: 1500, interChunk: 12000 });
    assert.match(out, /verdict: APPROVE/, 'a streaming slot must not be killed by the TTFB window');
  });

  it('a slot that produces NOTHING is still killed fast, at the TTFB window', async () => {
    // Fast-fail must survive the change, or a dead slot burns the full budget × retries.
    const { cli } = makeFakeSlotDir(FAKE_SILENT);
    await assert.rejects(
      () => runSubprocess(fakeProvider(cli), 'q', 30000, 40000, null, {}, { ttfb: 500, interChunk: 30000 }),
      /STALL: no output at all for 500ms/,
    );
  });

  it('a mid-stream gap beyond the ceiling is an IDLE kill, reporting bytes seen', async () => {
    const { cli } = makeFakeSlotDir();
    await assert.rejects(
      () => runSubprocess(fakeProvider(cli), 'q', 10000, 15000, null, {}, { ttfb: 5000, interChunk: 300 }),
      /IDLE_TIMEOUT after 300ms of inactivity \(\d+ bytes received before the gap\)/,
    );
  });

  it('falls back to provider resolution when handed garbage timers', async () => {
    // Number(true) === 1 would arm a 1ms timer and kill everything instantly.
    const { cli } = makeFakeSlotDir();
    const out = await runSubprocess(fakeProvider(cli), 'q', 10000, 15000, null, {},
      { ttfb: true, interChunk: 'nope' });
    assert.match(out, /verdict: APPROVE/);
  });
});

describe('LIVE PATH: the child derives and reports the stall window (#385)', () => {
  // Runs the real child end-to-end against a temp providers.json, so the derivation
  // in main() — not just the helper — is under test, along with the log line that
  // makes the window diagnosable from run output (suggestion 3).
  function dispatch(providerExtras, extraArgv = []) {
    const { dir, cli } = makeFakeSlotDir();
    const providersPath = path.join(dir, 'providers.json');
    fs.writeFileSync(providersPath, JSON.stringify({
      providers: [{
        name: 'fake-slot', type: 'subprocess', mainTool: 'node', cli: 'node',
        args_template: [cli, '{prompt}'], ...providerExtras,
      }],
    }), 'utf8');
    const res = spawnSync(process.execPath, [
      path.join(__dirname, 'call-quorum-slot.cjs'), '--slot', 'fake-slot', '--cwd', dir, ...extraArgv,
    ], {
      cwd: dir, input: 'question\n', encoding: 'utf8', timeout: 30000,
      env: { ...process.env, UNIFIED_PROVIDERS_CONFIG: providersPath, NF_FAKE_PAUSE_MS: '150' },
    });
    return res.stderr || '';
  }

  it('reports both windows and their sources', () => {
    // The exact shipped shape of claude-z-ai / claude-minimax / claude-kimi.
    const stderr = dispatch({ idle_timeout_ms: 90000 });
    assert.match(stderr, /ttfb=30000ms \(default\)/, 'TTFB must not inherit idle_timeout_ms');
    assert.match(stderr, /inter-chunk=90000ms \(idle-budget\)/);
  });

  it('keeps the 30s TTFB default — labelled as such — for a slot that configures nothing', () => {
    const stderr = dispatch({});
    assert.match(stderr, /ttfb=30000ms \(default\)/);
  });

  it('THE FIX: the #385 dispatch shape now gets the caller budget, not the 90s derivation', () => {
    // Same dispatch that killed claude-1/copilot-1/claude-z-ai mid-answer. The caller
    // budgeted 300s; the old model handed them 90s (or 30s) and killed them.
    const stderr = dispatch({ idle_timeout_ms: 90000 }, ['--timeout', '300000']);
    assert.match(stderr, /ttfb=30000ms \(default\)/);
    assert.match(stderr, /inter-chunk=300000ms \(idle-budget\)/);
    assert.doesNotMatch(stderr, /inter-chunk=90000ms/, 'the killed-voter derivation must be gone');
  });

  it('does not warn about the parent dispatcher\'s own flags when the PARENT requires it', () => {
    // #385: quorum-slot-dispatch.cjs require()s this module for parseVerdictLine, which
    // ran the #202 argv check against the PARENT's argv — so every dispatch warned that
    // the parent's own flags were "ignored", flags that do reach the CLI. Direct child
    // execution can't catch this (its argv is clean and the old code passed too); the
    // regression only reproduces through a require() with dispatcher flags in argv.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-stall-req-'));
    TMP_DIRS.push(dir);
    const parent = path.join(dir, 'fake-parent.cjs');
    fs.writeFileSync(parent,
      `require(${JSON.stringify(path.join(__dirname, 'call-quorum-slot.cjs'))});\n`, 'utf8');
    const res = spawnSync(process.execPath, [
      parent, '--mode', 'deliberate', '--question', 'q', '--artifact-path', '/tmp/a',
      '--review-context', 'ctx', '--request-improvements',
    ], { cwd: dir, encoding: 'utf8', timeout: 30000, input: '' });
    assert.doesNotMatch(res.stderr || '', /unrecognized dispatch flag/);
  });

  it('still warns about a genuinely unknown flag on a real child dispatch (#202 intact)', () => {
    // The guard must narrow WHERE the check runs, not disable it: parent→child contract
    // drift is exactly what it exists to catch.
    const stderr = dispatch({}, ['--not-a-real-flag', 'x']);
    assert.match(stderr, /unrecognized dispatch flag\(s\) ignored: --not-a-real-flag/);
  });
});

// ─── ADVERSARIAL: parseVerdictLine robustness ─────────────────────────────────
describe('ADVERSARIAL: parseVerdictLine edge cases', () => {
  it('extracts APPROVE from a markdown-bolded value "verdict: **APPROVE**"', () => {
    // VERDICT_LINE_RE requires the keyword immediately after `verdict:\s*`, so a
    // markdown-emphasized value (very common in LLM output) parses as null and the
    // verdict telemetry the whole VERDICT-01 fix exists to protect silently records
    // UNKNOWN.
    assert.equal(parseVerdictLine('verdict: **APPROVE**'), 'APPROVE');
  });

  it('parses a verdict that appears mid-text on its own line, case-insensitively', () => {
    // Sanity guard the multiline anchor + case-insensitivity actually work together.
    assert.equal(parseVerdictLine('here is my reasoning\nVerdict: reject\n(done)'), 'REJECT');
  });

  // ─── ADVERSARIAL round 2 ────────────────────────────────────────────────────
  it('a verdict line with trailing PROSE is NOT a clean sentinel (sentinel-only contract)', () => {
    // Sentinel-only (CodeRabbit #278): the keyword must end the line modulo
    // punctuation. Trailing WORDS ("BUT WITH CONCERNS") mean the line is prose, not a
    // vote — so it must NOT register. This is what stops a reasoning bullet like
    // `- verdict: REJECT would overstate the issue` from flipping consensus under
    // last-match-wins. A clean verdict line (even with a trailing period/bold) still parses.
    assert.equal(parseVerdictLine('verdict: APPROVE BUT WITH CONCERNS'), null);
    assert.equal(parseVerdictLine('verdict: APPROVE.'), 'APPROVE');
    assert.equal(parseVerdictLine('verdict: **APPROVE**'), 'APPROVE');
    // The consensus-flip CodeRabbit flagged: a clean APPROVE wins over a later prose bullet.
    assert.equal(parseVerdictLine('verdict: APPROVE\n- verdict: REJECT would overstate the issue'), 'APPROVE');
  });

  it('does NOT false-match REJECT inside "verdict: REJECTED" — the \\b boundary rejects an off-protocol suffix', () => {
    // REJECTED is off the APPROVE|REJECT|FLAG protocol. The trailing \b after REJECT
    // sees T→E (two word chars, no boundary), so the capture fails and the parser
    // returns null rather than silently coercing a partial match to REJECT. This
    // invariant-confirms the boundary anchor isn't leaking longer words into telemetry.
    assert.equal(parseVerdictLine('verdict: REJECTED'), null);
  });

  it('extracts a verdict across a CRLF (\\r\\n) line ending without the \\r leaking into the keyword', () => {
    // LLM output piped through Windows-ish tooling can carry CRLFs. The multiline ^
    // must re-anchor after \n and a trailing \r must not corrupt the captured keyword
    // (a \r immediately after APPROVE is non-word, so \b still holds).
    assert.equal(parseVerdictLine('reasoning here\r\nverdict: APPROVE\r\nnext line'), 'APPROVE');
  });
});

'use strict';

// STALL-TIMEOUT-01: the <500-byte "stall" timer was hardcoded to 30s, which
// false-killed slow-bursty models (GLM-5.2[1m], MiniMax-M3 via a third-party
// Anthropic-compatible API) — they emit a short preamble then pause >30s while
// generating. `stall_timeout_ms` on the provider raises the threshold; absent /
// invalid values fall back to the 30s default.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { stallTimeoutFor, resolveStallTimeout, runSubprocess, parseVerdictLine } = require('./call-quorum-slot.cjs');

describe('stallTimeoutFor — per-slot stall timeout override', () => {
  it('defaults to 30000ms when stall_timeout_ms is absent', () => {
    assert.equal(stallTimeoutFor({ name: 'codex-1' }), 30000);
    assert.equal(stallTimeoutFor({}), 30000);
  });

  it('honors a positive per-slot stall_timeout_ms (the GLM/MiniMax fix)', () => {
    assert.equal(stallTimeoutFor({ name: 'claude-z-ai', stall_timeout_ms: 120000 }), 120000);
    assert.equal(stallTimeoutFor({ stall_timeout_ms: 90000 }), 90000);
  });

  it('accepts a numeric string value', () => {
    assert.equal(stallTimeoutFor({ stall_timeout_ms: '120000' }), 120000);
  });

  it('falls back to 30000 for non-positive / NaN / null values', () => {
    assert.equal(stallTimeoutFor({ stall_timeout_ms: 0 }), 30000);
    assert.equal(stallTimeoutFor({ stall_timeout_ms: -5 }), 30000);
    assert.equal(stallTimeoutFor({ stall_timeout_ms: 'nope' }), 30000);
    assert.equal(stallTimeoutFor({ stall_timeout_ms: null }), 30000);
  });

  it('never returns the bare 30s default for a slot that configured a longer one', () => {
    // Regression guard: before STALL-TIMEOUT-01 this was hardcoded 30000 regardless.
    assert.notEqual(stallTimeoutFor({ stall_timeout_ms: 120000 }), 30000);
  });

  it('clamps oversized values to TIMEOUT_MAX (Node fires >2^31-1ms timers immediately)', () => {
    const MAX = 2147483647;
    assert.equal(stallTimeoutFor({ stall_timeout_ms: 3e9 }), MAX);
    assert.equal(stallTimeoutFor({ stall_timeout_ms: MAX + 1 }), MAX);
    assert.equal(stallTimeoutFor({ stall_timeout_ms: Infinity }), MAX);
    assert.equal(stallTimeoutFor({ stall_timeout_ms: MAX }), MAX); // boundary, unchanged
  });

  // ─── ADVERSARIAL: type-coercion gap ──────────────────────────────────────────
  it('falls back to 30000 for a boolean true instead of a 1ms stall timer (type-coercion gap)', () => {
    // Number(true) === 1, which passes the `v > 0` guard, so a boolean config value
    // yields a 1ms stall timeout — every slot is instantly false-killed as STALLed.
    // A non-numeric type like a boolean is not a valid duration and must fall back.
    assert.equal(stallTimeoutFor({ stall_timeout_ms: true }), 30000);
  });
});

// ─── STALL-TIMEOUT-02 (issue #385) ────────────────────────────────────────────
// The per-slot escape hatch existed but nothing set it: claude-z-ai / claude-minimax
// / claude-kimi ship `idle_timeout_ms: 90000` and no `stall_timeout_ms`, so all three
// were killed at 30s inside their 217–420-byte preamble, every round. An explicitly
// configured idle tolerance now derives the stall window.
describe('resolveStallTimeout — idle-derived stall window (#385)', () => {
  it('derives the stall window from the slot\'s configured idle timeout', () => {
    // The exact shape of the three false-killed slots.
    const zai = { name: 'claude-z-ai', idle_timeout_ms: 90000 };
    assert.deepEqual(resolveStallTimeout(zai, 90000), { ms: 90000, source: 'idle' });
    assert.deepEqual(resolveStallTimeout(zai), { ms: 90000, source: 'idle' });
  });

  it('keeps the 30s default when nothing is configured', () => {
    // Fast-fail on genuinely hung slots must survive this fix — deriving from the
    // built-in 90s idle FALLBACK would silently disable the stall timer fleet-wide.
    assert.deepEqual(resolveStallTimeout({ name: 'codex-1' }, 90000), { ms: 30000, source: 'default' });
    assert.deepEqual(resolveStallTimeout({ name: 'codex-1' }), { ms: 30000, source: 'default' });
  });

  it('a caller-supplied idle budget cannot INFLATE the window past the slot config', () => {
    // The run in #385 dispatched with --timeout 300000 (idle=300000ms in the log).
    // Deriving from that would make a genuinely dead slot cost 5 minutes per retry;
    // the slot's own 90s declaration is the claim about how slow it is.
    assert.deepEqual(resolveStallTimeout({ idle_timeout_ms: 90000 }, 300000), { ms: 90000, source: 'idle' });
    // …and a slot that declared nothing gets no window from --timeout at all.
    assert.deepEqual(resolveStallTimeout({}, 300000), { ms: 30000, source: 'default' });
  });

  it('a caller that LOWERS the idle budget caps the derived window', () => {
    // latency_budget_ms / --timeout below the configured idle: the caller's budget wins.
    assert.deepEqual(resolveStallTimeout({ idle_timeout_ms: 90000 }, 45000), { ms: 45000, source: 'idle' });
    // Clamped all the way down to the floor → indistinguishable from the default.
    assert.deepEqual(resolveStallTimeout({ idle_timeout_ms: 90000 }, 10000), { ms: 30000, source: 'default' });
  });

  it('an explicit stall_timeout_ms still wins over the idle timeout', () => {
    const p = { stall_timeout_ms: 45000, idle_timeout_ms: 300000 };
    assert.deepEqual(resolveStallTimeout(p, 300000), { ms: 45000, source: 'per-slot' });
  });

  it('does not LOWER the stall window below 30s for a short idle timeout', () => {
    // codex-1 configures idle=30000; a slot with idle=5000 must not get a 5s stall
    // timer — the derivation only ever raises the window.
    assert.deepEqual(resolveStallTimeout({ idle_timeout_ms: 30000 }, 30000), { ms: 30000, source: 'default' });
    assert.deepEqual(resolveStallTimeout({ idle_timeout_ms: 5000 }, 5000), { ms: 30000, source: 'default' });
  });

  it('ignores a garbage idle timeout instead of deriving a nonsense window', () => {
    assert.equal(resolveStallTimeout({ idle_timeout_ms: 'soon' }).ms, 30000);
    assert.equal(resolveStallTimeout({ idle_timeout_ms: true }).ms, 30000);
    assert.equal(resolveStallTimeout({ idle_timeout_ms: -1 }).ms, 30000);
    assert.equal(resolveStallTimeout({ idle_timeout_ms: 0 }).ms, 30000);
  });

  it('clamps an oversized derived window to TIMEOUT_MAX (Node fires >2^31-1ms timers immediately)', () => {
    assert.equal(resolveStallTimeout({ idle_timeout_ms: 3e9 }).ms, 2147483647);
  });

  it('reports a source label for every branch (so the dispatch log is diagnosable)', () => {
    // Suggestion 3 in #385: the run output must say WHERE the window came from,
    // instead of requiring a source read to tell 30s-default from 30s-configured.
    assert.equal(resolveStallTimeout({ stall_timeout_ms: 90000 }).source, 'per-slot');
    assert.equal(resolveStallTimeout({ idle_timeout_ms: 90000 }).source, 'idle');
    assert.equal(resolveStallTimeout({}).source, 'default');
  });
});

// ─── LIVE PATH ────────────────────────────────────────────────────────────────
// A resolver that returns the right number is worth nothing if the number never
// reaches the timer, or reaches the timer but not the slot that needed it. These
// two tests exercise the real dispatch: a spawned CLI that emits a sub-500-byte
// preamble and then goes quiet — exactly the shape that false-killed the three
// third-party slots — and the real `node call-quorum-slot.cjs --slot …` child.

// A stand-in CLI: prints a short preamble (well under the 500-byte stall
// threshold), pauses, then answers. NF_FAKE_PAUSE_MS controls the silence.
const FAKE_CLI = `
'use strict';
process.stdout.write('thinking...\\n');
setTimeout(() => {
  process.stdout.write('verdict: APPROVE\\n');
  process.exit(0);
}, Number(process.env.NF_FAKE_PAUSE_MS || 900));
`;

// Cleanup on process exit rather than TestContext.after: `t.after` landed in Node
// 18.8, and package.json declares engines.node ">=18.0.0".
const TMP_DIRS = [];
process.on('exit', () => {
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

function makeFakeSlotDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-stall-'));
  TMP_DIRS.push(dir);
  // findProjectRoot() walks up to the nearest .planning/ — without one here it would
  // find the real repo and write this test's telemetry into it.
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  const cli = path.join(dir, 'fake-cli.cjs');
  fs.writeFileSync(cli, FAKE_CLI, 'utf8');
  return { dir, cli };
}

describe('LIVE PATH: the resolved stall window drives the real timer (#385)', () => {
  it('kills a quiet sub-500-byte slot at the window it was given, not the 30s constant', async () => {
    const { cli } = makeFakeSlotDir();
    const provider = {
      name: 'fake-slow', type: 'subprocess', mainTool: 'node', cli: 'node',
      args_template: [cli, '{prompt}'],
    };
    // 400ms window vs a 900ms pause: the 30s default would have let this finish, so a
    // STALL here proves the passed window — not the constant — armed the timer.
    await assert.rejects(
      () => runSubprocess(provider, 'q', 10000, 15000, null, {}, 400),
      /STALL: only \d+ bytes received then silence for 400ms/,
    );
  });

  it('lets that same slot finish when the window covers its pause', async () => {
    const { cli } = makeFakeSlotDir();
    const provider = {
      name: 'fake-slow', type: 'subprocess', mainTool: 'node', cli: 'node',
      args_template: [cli, '{prompt}'],
    };
    const out = await runSubprocess(provider, 'q', 10000, 15000, null, {}, 3000);
    assert.match(out, /verdict: APPROVE/);
  });

  it('falls back to the provider-derived window when handed a garbage one', async () => {
    const { cli } = makeFakeSlotDir();
    // Number(true) === 1 → a 1ms stall timer would false-kill this slot instantly.
    const provider = {
      name: 'fake-slow', type: 'subprocess', mainTool: 'node', cli: 'node',
      args_template: [cli, '{prompt}'],
    };
    const out = await runSubprocess(provider, 'q', 10000, 15000, null, {}, true);
    assert.match(out, /verdict: APPROVE/);
  });

});

// The direct-caller fallback inside runSubprocess (`stallTimeoutFor(provider,
// idleTimeoutMs)`) applies the same rule main() does — a caller idle budget caps the
// window, floored at 30s. Its semantics are pinned at the resolver above rather than
// behaviorally: every value that branch can produce is ≥ 30s, so telling them apart
// through a live subprocess would need a >30s pause per case.

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

  it('derives the window from a preset that sets idle_timeout_ms but no stall_timeout_ms', () => {
    // The exact shipped shape of claude-z-ai / claude-minimax / claude-kimi.
    const stderr = dispatch({ idle_timeout_ms: 90000 });
    assert.match(stderr, /stall=90000ms \(idle\)/);
  });

  it('keeps the 30s default — labelled as such — for a slot that configures nothing', () => {
    const stderr = dispatch({});
    assert.match(stderr, /stall=30000ms \(default\)/);
  });

  it('reproduces the #385 dispatch (--timeout 300000) without inflating the window to 5min', () => {
    const stderr = dispatch({ idle_timeout_ms: 90000 }, ['--timeout', '300000']);
    assert.match(stderr, /idle=300000ms hard=300000ms stall=90000ms \(idle\)/);
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

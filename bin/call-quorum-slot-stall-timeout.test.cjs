'use strict';

// STALL-TIMEOUT-01: the <500-byte "stall" timer was hardcoded to 30s, which
// false-killed slow-bursty models (GLM-5.2[1m], MiniMax-M3 via a third-party
// Anthropic-compatible API) — they emit a short preamble then pause >30s while
// generating. `stall_timeout_ms` on the provider raises the threshold; absent /
// invalid values fall back to the 30s default.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { stallTimeoutFor, parseVerdictLine } = require('./call-quorum-slot.cjs');

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

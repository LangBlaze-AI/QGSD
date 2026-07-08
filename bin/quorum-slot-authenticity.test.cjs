'use strict';

// Authenticity contract for quorum slot results: prove that the "it's the real
// sub-agent (dispatch script), not the Haiku relay hallucinating" check is enforced
// in code, not just in the skill prose. The relay returns chat text but cannot write
// --output-file; a genuine result therefore needs a script-written 32-hex
// dispatch_nonce AND a completed (non-PENDING) verdict.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateSlotResult } = require('./quorum-slot-dispatch.cjs');

const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // 32 hex

test('genuine: script-written nonce + a completed verdict', () => {
  const r = validateSlotResult(`slot: codex-1\nround: 1\nverdict: APPROVE\ndispatch_nonce: ${NONCE}\nreasoning: ok`);
  assert.equal(r.genuine, true);
  assert.equal(r.verdict, 'APPROVE');
  assert.equal(r.nonce, NONCE);
});

test('genuine for a free-form Mode-A verdict (must NOT require a keyword)', () => {
  // Mode A verdicts are prose; keyword-matching would false-reject real work.
  const r = validateSlotResult(`verdict: Now I have sufficient grounding — my position is APPROVE\ndispatch_nonce: ${NONCE}`);
  assert.equal(r.genuine, true, 'a prose verdict line with a real nonce is genuine');
});

test('FABRICATION: chat-only relay output with NO file → not genuine', () => {
  assert.equal(validateSlotResult('').genuine, false);
  assert.equal(validateSlotResult(null).genuine, false);
  assert.match(validateSlotResult('').reason, /empty\/missing/);
});

test('FABRICATION: a verdict but NO dispatch_nonce → not genuine', () => {
  // e.g. Haiku echoing a plausible-looking block that lacks the script nonce.
  const r = validateSlotResult('slot: codex-1\nverdict: APPROVE\nreasoning: trust me');
  assert.equal(r.genuine, false);
  assert.match(r.reason, /no valid 32-hex dispatch_nonce/);
});

test('FABRICATION: malformed nonce (not 32-hex) → not genuine', () => {
  assert.equal(validateSlotResult('verdict: APPROVE\ndispatch_nonce: not-a-real-nonce').genuine, false);
  assert.equal(validateSlotResult(`verdict: APPROVE\ndispatch_nonce: ${NONCE}extra`).genuine, false, 'over-long hex rejected');
  assert.equal(validateSlotResult('verdict: APPROVE\ndispatch_nonce: a1b2c3').genuine, false, 'too-short rejected');
});

test('INCOMPLETE: PENDING sentinel (dispatch started, CLI never answered) → not genuine', () => {
  // This is the closed gap: the early write has a VALID nonce but verdict PENDING.
  const r = validateSlotResult(`slot: codex-1\nround: 1\nverdict: PENDING\ndispatch_nonce: ${NONCE}\nreasoning: dispatch started, awaiting CLI response`);
  assert.equal(r.genuine, false, 'a valid nonce alone must NOT pass — PENDING means no real answer');
  assert.equal(r.nonce, NONCE, 'nonce is still surfaced for diagnostics');
  assert.match(r.reason, /PENDING/);
});

test('INCOMPLETE: no verdict line at all (nonce only) → not genuine', () => {
  assert.equal(validateSlotResult(`dispatch_nonce: ${NONCE}\nreasoning: x`).genuine, false);
});

test('nonce match is anchored to its own line and case-normalized', () => {
  const upper = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
  const r = validateSlotResult(`verdict: BLOCK\ndispatch_nonce: ${upper}`);
  assert.equal(r.genuine, true);
  assert.equal(r.nonce, upper.toLowerCase());
});

// formal/prism/oauth-rotation.pm
// Handwritten — not generated from XState.
// Source: bin/call-quorum-slot.cjs (runSubprocessWithRotation),
//         bin/providers.json (oauth_rotation.max_retries)
//
// OAuth Rotation Success — DTMC Model
// Requirements: CRED-01
//
// Models the probability that at least one sequential OAuth rotation attempt
// succeeds within max_retries tries. Accounts are tried one by one; on failure
// the next account in the pool is activated via rotate_cmd.
//
// State encoding (1-safe, linear):
//   s = max_retries+1 : ATTEMPTING — max_retries attempts remaining (initial)
//   s = max_retries   : ATTEMPTING — (max_retries-1) remaining
//   ...
//   s = 2             : ATTEMPTING — 1 attempt remaining (last chance)
//   s = 1             : SUCCEEDED  (absorbing)
//   s = 0             : EXHAUSTED  — all attempts failed (absorbing)
//
// To run (requires PRISM_BIN env var):
//   $PRISM_BIN formal/prism/oauth-rotation.pm formal/prism/oauth-rotation.props
//
// To override failure rate with empirical values:
//   $PRISM_BIN formal/prism/oauth-rotation.pm formal/prism/oauth-rotation.props \
//     -const p_fail=0.15 -const max_retries=3

dtmc

// P(individual attempt fails — quota exhausted or auth error)
// Default: 0.30 (conservative — Gemini free-tier hits quota ~30% of peak hours)
const double p_fail     = 0.30;

// Maximum rotation attempts (from providers.json oauth_rotation.max_retries)
// Changing this constant re-parameterises the entire model.
// Value injected via -const max_retries=N by run-oauth-rotation-prism.cjs.
// Falls back to 3 if not injected (safe default; matches legacy gemini-1 config).
const int    max_retries     = 3;

module oauth_rotation

    // s encodes current state per the header comment above
    s : [0..max_retries+1] init max_retries+1;

    // ATTEMPTING with multiple attempts remaining: try, then succeed or rotate
    [] s >= 3 ->
        (1-p_fail) : (s'=1)    // this attempt succeeded → SUCCEEDED
        + p_fail   : (s'=s-1); // this attempt failed    → rotate, one fewer

    // ATTEMPTING with exactly 1 attempt remaining: last chance before exhaustion
    [] s = 2 ->
        (1-p_fail) : (s'=1)    // last attempt succeeded → SUCCEEDED
        + p_fail   : (s'=0);   // last attempt failed    → EXHAUSTED

    // Absorbing: SUCCEEDED
    [] s = 1 -> 1 : (s'=1);

    // Absorbing: EXHAUSTED
    [] s = 0 -> 1 : (s'=0);

endmodule

// ── Rewards: count rotation steps ─────────────────────────────────────────────
rewards "rotations"
    // Each non-absorbing transition = one rotation attempt
    s >= 2 : 1;
endrewards

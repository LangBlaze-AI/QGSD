# Quorum Debate
Question: Is the quorum system robust?
Date: 2026-05-13
Consensus: APPROVE
Rounds: 1
Mode: A (pure question)

## Round 1

| Model | Position | Citations |
|---|---|---|
| Claude (ADVISORY — not a vote) | Integrity strong; availability + Byzantine defense weak. CE rules and nonce mechanism robust against transport-layer failures; orchestrator framing power + correlated provider drift remain unhandled. | commands/nf/quorum.md (CE-1/2/3); bin/quorum-slot-dispatch.cjs (nonce) |
| codex-1 (primary) | UNAVAIL — CLI subprocess did not respond in window (dispatch wrote PENDING with valid nonce, no verdict). | — |
| opencode-1 (T1 fallback) | APPROVE — robust but with known operational fragility. Integrity mechanisms production-grade (CE-2 BLOCK-absolute, nonce authenticity, FALLBACK-01 enforcement, Poisson-binomial gating). Availability is the weak axis: thin-unanimity risk under degraded roster; third-party CLI hangs/rate-limits/missing binaries; self-eval bias channel via orchestrator presentation. | nf-stop.js:518-526,756-770; call-quorum-slot.cjs:255,264; quorum-consensus-gate.cjs:33-58,187-203; quorum-slot-dispatch.cjs:46-96 |
| gemini-1 (primary) | APPROVE — "robust, security-hardened multi-model consensus protocol". Strongest: CE-1..3 unanimity + facilitator-only orchestrator, nonce-verified file results, adaptive fan-out (FAN-01..04), tiered fallback + scoreboard flakiness tracking. Failure modes: consensus gridlock on subjective questions, provider bottlenecks (slowest-provider parallel dispatch), context window exhaustion in deliberation. | commands/nf/quorum.md (CE-1/2/3); bin/quorum-slot-dispatch.cjs (nonce + file write); agents/nf-quorum-orchestrator.md (tiered fallback); bin/update-scoreboard.cjs (computeFlakiness) |

## Outcome

**APPROVE — robust on integrity, fragile on availability.**

Both external voters converged on the same shape of answer despite different framing:

**Strongest design properties (consensus):**
- CE-1/CE-2/CE-3 consensus rules — facilitator-only + absolute BLOCK + unanimity. CE-2 transcript-enforced by `nf-stop.js:756-770`.
- File-based nonce authenticity in `quorum-slot-dispatch.cjs` closes the relay-fabrication attack vector.
- Tiered fallback (T1 sub → T2 api) with FALLBACK_CHECKPOINT (`nf-stop.js:518-526`) blocks fail-open. **This run exercised it in Round 1** — codex-1 PENDING → opencode-1 T1 → CE-3 unanimity preserved.
- Poisson-binomial consensus gating (`quorum-consensus-gate.cjs:33-58`) enables mathematically grounded early escalation.
- Adaptive fan-out by envelope risk balances token cost with rigor.

**Top failure modes (consensus):**
1. **Availability surface is the weak axis.** This very run is the evidence — codex-1 hung. Both voters flagged third-party CLI hangs, rate-limits, missing binaries.
2. **Degraded-roster thin unanimity.** CE-3 1/1=100% is technically correct but pragmatically weak. No minimum-live-quorum floor today.
3. **Consensus gridlock & context exhaustion** in deliberation rounds, especially on subjective questions or with large artifacts cross-pollinated through smaller models.
4. **Self-evaluation / orchestrator framing bias.** CE-1 makes Claude advisory, but the orchestrator still controls peer-result synthesis and display.

**Recommendations (consensus-aligned, not voted):**
- Add a **minimum-live-quorum floor** so 1/1 unanimity does not silently count on high-risk decisions.
- Add **slot-health SLOs** to scoreboard so chronic UNAVAIL slots auto-rotate out of `$DISPATCH_LIST` primary positions.
- Consider Byzantine-resistant model-family diversification on high-risk questions.

## Notes

- FAN_OUT_COUNT=3 (medium risk default) → 2 external slots in `$DISPATCH_LIST`: codex-1, gemini-1.
- FALLBACK_CHECKPOINT: codex-1 UNAVAIL → opencode-1 dispatched as T1 fallback (auth_type=sub, next in working list).
- Consensus reached on Round 1 with 2/2 valid voters APPROVE.

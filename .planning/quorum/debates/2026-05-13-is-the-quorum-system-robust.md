# Quorum Debate
Question: is the quorum system robust?
Date: 2026-05-13
Consensus: APPROVE (1/1 valid external voter — degraded roster)
Rounds: 1

## Round 1
| Model | Position | Citations |
|---|---|---|
| Claude (ADVISORY — not a vote) | Moderately robust: strong structural safeguards (CE-1/2/3, nonce auth, FALLBACK_CHECKPOINT, tiered fallback, adaptive fan-out), but operational fragility around third-party CLI surfaces (recent patches e25c31fd, 600908a1, 6427d31e, 49ca5168) and self-evaluation bias. | recent commits e25c31fd / 600908a1 / 6427d31e / 49ca5168 |
| codex-1 (primary) | UNAVAIL — CLI hung past 300s timeout; only PENDING placeholder written. | — |
| gemini-1 (primary) | UNAVAIL — RATE_LIMITED after 2 retries. | — |
| opencode-1 (T1 fallback) | **APPROVE.** Defense-in-depth: stop-hook FALLBACK-01 detection, nonce + PENDING write, per-provider rate-limit semaphores. Non-blocking weaknesses: empty providers.json in worktree pre-install, ceiling counts successful calls without echo-chamber detection, shallow-merge can silently shrink quorum, bag-of-words precedent matching. | hooks/nf-stop.js:432-530, 659-664, 752-771; bin/quorum-slot-dispatch.cjs:1466-1487, 46-96; hooks/config-loader.js:119-138 |
| copilot-1 (T1 fallback) | UNAVAIL — `spawn ask ENOENT`; copilot CLI binary missing/misconfigured in this env. | — |
| claude-1 (T1 fallback) | UNAVAIL — CONTEXT_OVERFLOW; unavail_message captured a draft APPROVE noting strong formal verification (TLA+ unanimity/bounded-deliberation proofs, PRISM DTMC), but per CE-3 only the `verdict:` field counts. | NFQuorum.tla:108-110, 134-138; call-quorum-slot.cjs:255, 362, 529, 688-691; quorum.pm:49 |

## Outcome

**CONSENSUS: APPROVE** under CE-3 (1 valid external voter, 0 BLOCK, 4 UNAVAIL → 1/1 = 100% unanimity).

The single surviving voter (opencode-1) approved on the strength of: nonce-authenticated file IPC bypassing relay tampering, stop-hook structural enforcement of FALLBACK-01, per-provider rate-limit semaphores, and layered defense-in-depth. claude-1's draft APPROVE (lost to context overflow) independently cited formal TLA+/PRISM verification as a credibility multiplier.

**However, the run itself is meta-evidence of operational fragility:** 4 of 5 slots failed in distinct ways within a single dispatch — CLI hang (codex-1), rate-limit (gemini-1), missing binary (copilot-1), context overflow (claude-1). The protocol's degraded-roster semantics held — CE-3 was satisfied by a single voter — but a 1-of-5 "unanimous" consensus is technically correct and pragmatically thin. claude-1's own unavail_message flagged exactly this concern before being killed.

**Net assessment:** The system's *integrity* mechanisms (nonce, FALLBACK_CHECKPOINT, BLOCK-is-absolute, formal verification) are robust. The system's *availability* surface (third-party CLIs, rate limits, context windows, install/config drift) is fragile and currently being actively patched. APPROVE for production with degraded-roster semantics explicitly defined and CLI-availability monitoring treated as an SLO, not an afterthought.

External voter tally: 1 APPROVE / 0 BLOCK / 4 UNAVAIL (Claude's position excluded per CE-1)

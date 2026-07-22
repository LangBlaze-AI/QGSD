# Quorum Debate
Question: Deep assessment of nForma's current state — top 3 priorities (ranked), benchmark-sync.yml FIX-vs-RETIRE, top 3 risks, blind spots.
Date: 2026-07-07
Consensus: APPROVE (unanimous, 4 valid voters)
Rounds: 1

## Round 1
| Model | Position | Citations |
|---|---|---|
| Claude (ADVISORY) | Retire sync #1; rationalize release #2; #44 #3 | benchmark-sync.yml, package.json, STATE.md |
| codex-1 (gpt-5.4) | APPROVE | — |
| opencode-1 (grok-code-fast-1) | APPROVE — release #1, #44 #2, retire-sync+STATE #3 | nf-solve.cjs:4923-4930,5143,5540; STATE.md:9-11; benchmark-sync.yml:38 |
| copilot-1 (gpt-4.1) | APPROVE — release #1, retire-sync #2, #44 #3; flags test-coverage collapse | unit-test-coverage.json; benchmark-sync.yml:38; package.json |
| claude-1 (opus-4-6, T1 fallback) | APPROVE — release #1, #44 #2, retire-sync #3; blind spot = ~1.3% test coverage | nf-solve.cjs:4930,5143; STATE.md:9-10; benchmark-sync.yml:30 |
| claude-minimax | UNAVAIL (stall + cooldown) | — |

External voter tally: 4 APPROVE / 0 BLOCK / 1 UNAVAIL (Claude advisory excluded per CE-1)

## Outcome
Unanimous consensus. The quorum RE-RANKED the facilitator's priorities: **release-unblock #1**, **wire `degraded` into convergence (#44) #2**, **retire benchmark-sync.yml + refresh STATE.md #3**. Decisive RETIRE verdict on benchmark-sync.yml. Biggest surfaced blind spot: catastrophically low requirement→test coverage (~1.3%), flagged independently by copilot-1 and claude-1.

## Improvements (all accepted, no BLOCK)
| Model | Suggestion | Rationale |
|---|---|---|
| opencode-1 | Gate the OK-GREEN return (nf-solve.cjs ~5540) on `!degraded` so residual===0 with unmeasured layers reports DEGRADED/INCONCLUSIVE | Makes the #346 guard load-bearing; closes the DIAG-02 false-convergence hole |
| opencode-1 | If keeping any LLM benchmark, make it a nightly SCHEDULED job writing to an artifact/issue — never auto-commit to main | Preserves the autonomy signal without noise-commits or per-push write access |
| copilot-1 | Add `# DEPRECATED — see benchmark-fixtures.yml` + disable trigger before deleting sync | Prevents accidental re-enablement; preserves history |
| copilot-1 | Add STATE.md freshness check to health --repair (abort if milestone >1 minor behind package.json) | Stops stale STATE.md propagating into automated repair |
| claude-1 | Also remove `benchmarks/solve-baseline.json` when retiring sync | Dead artifact breeds "let me fix sync" confusion |
| claude-1 | Emit a `degraded_convergence: boolean` field in the DECISION output | Actionable for consumers without parsing `unmeasured_layers` |

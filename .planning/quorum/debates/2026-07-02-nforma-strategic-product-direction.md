# Quorum Debate
Question: nForma strategic product direction — A (fix measurement) / B (build repair capability) / C (fix autocommit root cause)
Date: 2026-07-02
Consensus: APPROVE
Rounds: 1

## Round 1
| Model | Position | Citations |
|---|---|---|
| Claude (ADVISORY) | A — can't steer B on a 23%-broken metric; A's cleanup subsumes much of C; defer B | PR#8, project_benchmark-measurement-quality |
| codex-1 | A — make the score trustworthy before steering capability; building repair against a corpus with wrong expectations optimizes noise; autocommit chokepoint already partly narrowed | .planning/STATE.md:35-39, solve-commit-artifacts.cjs:9/17/30 |
| claude-1 | A — cheapest/highest-certainty; PR#8 +5 verified; 54 unwinnable need reclassification not engineering; C partly done (#287/#290/#295), 109-file cleanup is a subtask of A; B premature (needs metric to validate) | reverse-flow debate, project_benchmark-measurement-quality, project_report-only-no-mutation, project_nf-solve-repair-taxonomy |
| claude-z-ai | A — without a trustworthy north-star you cannot steer product, validate B, or confirm C; A unblocks everything, low risk | (memories) |

## Outcome
UNANIMOUS CONSENSUS: **Option A — Fix the Measurement**, as the primary next direction.

Rationale (agreed by all 3 external voters + Claude advisory):
- A is the only rational FIRST move by sequencing: B (capability) and C (root-cause completeness) both need a trustworthy north-star metric to validate against. The session itself proved measurement beats estimation (a quorum-approved reverse-flow fix was empirically DISPROVED; report-only idempotency was twice mis-estimated).
- A is cheapest + highest-certainty: PR #8 has +5 verified FAIL→PASS (zero regression); the 54 unwinnable challenges need reclassification (correct expected layers) not engineering; the 109 stray bench-* files are a mechanical cleanup.
- C is largely SUBSUMED by A: the 109-file cleanup is a subtask of A, and the autocommit idempotency was already largely fixed (#287/#290/#295). Fold remaining C hardening into A.
- B is the correct long-term moat (autonomous repair) but PREMATURE — building repair tooling you can't measure; repair is layer-dependent and multi-month; sequence it AFTER A provides incremental validation.

Concrete A scope: merge PR #8 → clean 109 stray bench-* files from nForma bin/ → redesign the 54+ broken challenges (correct expected layers) → close the harness snapshot-coverage gap. Then use the trustworthy score to prioritize B and confirm C.

# Quorum Debate
Question: What should behavior #4 be — is the FP-safe formal-behavioral detector set complete, and are BENCH-188 (weak invariant) + the code-concurrency candidates framework-limited?
Date: 2026-07-04
Consensus: APPROVE
Rounds: 1

## Round 1
| Model | Position | Citations |
|---|---|---|
| Claude (ADVISORY) | The 3 FP-safe formal detectors exhaust the decidable behavioral defects; BENCH-188 is oracle-dependent (redundant with #1 if the strong property is present, else undecidable); code-concurrency is FP-prone/undecidable on arbitrary JS → declare complete, document the boundary | — |
| codex-1 | UNAVAIL (CLI error) | — |
| opencode-1 | UNAVAIL (relay incomplete) | — |
| copilot-1 | APPROVE — empirically confirmed all 7 concurrency BENCHes + BENCH-188 score 0/passed:false ("No expected layer showed increased residual"); "too weak" is structurally irreducible (WeakInvariant.tla passes TLC cleanly). UPPAAL timed-automata would be a valid #4 for a DIFFERENT defect class but no remaining benchmark candidate PASSes from it | nf-benchmark/results/BENCH-188-*.json |
| claude-1 | APPROVE — 3 detectors share decidable verification procedures; 0-baseline proves FP-safety empirically; BENCH-188 oracle-dependent; concurrency undecidable (whole-program alias + scheduling). layer-constants.cjs has no slot for a 4th behavioral detector | nf-solve.cjs:4332,4365,3963-3987; layer-constants.cjs:11-20 |
| claude-minimax (T1 fallback) | APPROVE — 3 behaviors map to the standard taxonomy (safety/reachability/temporal), each decidable + FP-bounded. Rice's theorem applies to JS race/ABA. Considered & rejected candidate #4s: refinement/simulation (needs mapping oracle), action-precondition reachability (subsumed by #1), init-predicate satisfiability (#1 catches empty reachable set), hyperproperty/non-interference (unrealistic for corpus), SANY errors (separate lint). Redirect budget to sensitivity sweeps (SENS-01/02/03) / annotation coverage (ANNOT-01) | PR #305/#306/#307; requirements LIVE-01/02 |

## Outcome
Unanimous APPROVE (3 valid external voters — claude-1, copilot-1, claude-minimax; 0 BLOCK; codex-1 & opencode-1 UNAVAIL, claude-z-ai UNAVAIL/429). min_live_voters=2 satisfied.

**The FP-safe formal-behavioral detection set is COMPLETE at three detectors:**
1. Safety — reachable invariant-violation (model_check, TLC INVARIANT).
2. Structural reachability — Petri unreachable-marking (petri_check, static dead-place).
3. Temporal — unsatisfiable liveness under fairness (model_check, TLC PROPERTY, dual-gated).

These map onto the standard taxonomy of finite-state model-checkable properties; each is decidable and FP-bounded by the checker's own correctness, empirically validated by 0-baseline on 197 real models + benchmark FAIL→PASS (#305/#306/#307).

**FRAMEWORK-LIMITED (not shippable without breaking the 0-baseline invariant):**
- **BENCH-188 "weak invariant"** — oracle-dependent. "Too weak" is meaningful only relative to an intended stronger property; supply it and behavior #1 already catches the violation, omit it and the judgment requires an external oracle (LLM), not a decidable check. Already documented in `nf-benchmark/docs/DETECTION-INFEASIBLE-FORMAL.md`.
- **Code-concurrency set (BENCH-104 ABA, 048 semaphore-deadlock, 122 distributed-lock race, 031/191 test races, 152/178 shared-state races)** — sound static race/ABA detection on arbitrary JS reduces to aliasing + happens-before over a Turing-complete language (Rice's theorem); any sound approximation either explodes FP rate or needs user annotations (re-introducing the oracle). Shipping it would collapse the signal-vs-noise 0-baseline invariant.

**Rejected candidate #4s** (claude-minimax): refinement/simulation checking, action-precondition reachability, init-predicate satisfiability, hyperproperty/non-interference, SANY/operator-resolution errors — all subsumed by #1, oracle-dependent, or already separate lint passes.

**Action:** Do NOT chase a phantom behavior #4. Document the boundary (this file + a note in the infeasibility doc). Higher-leverage next budget: sensitivity sweeps (SENS-01/02/03) or property-annotation coverage (ANNOT-01) — both uncovered — rather than a brittle FP-prone concurrency/oracle heuristic.

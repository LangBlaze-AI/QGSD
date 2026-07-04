# Quorum Debate
Question: Improve nForma by closing the FSM→TLA→model_check loop — extend model_check to consume the 68 FSM-emitted sibling cfgs so nForma's own transpiled state machines get model-checked.
Date: 2026-07-04
Consensus: APPROVE (Round 2, after amendment)
Rounds: 2

## Round 1
| Model | Position | Citations |
|---|---|---|
| Claude (ADVISORY) | Close the loop by running TLC with the provided sibling cfg (pins CONSTANTS); activates 68 dormant models; FP-risk shifts to trusting emitted cfg + triaging a possibly-nonzero baseline | check-model-invariants.cjs, emitter-tla.cjs |
| claude-1 | APPROVE w/ scope amendment — emitter emits SEQUENTIAL [][Next]_vars not interleaved processes; ship cfg-consumption (small/safe), DEFER concurrency (needs PlusCal); CHECK_DEADLOCK needs final-states/Termination annotation | check-model-invariants.cjs:145 |
| copilot-1 | APPROVE — cfgs deterministically emitted → as FP-safe as transpiler; triage-then-baseline, gate on 0-DELTA; tag results source:"fsm-transpiled"; cfg has PROPERTY blocks too | MCaccount-manager.cfg |
| claude-minimax | APPROVE w/ refinements — sibling-cfg lookup before CONSTANTS skip; preflight naming consistency; verify emitter fairness | — |
| antigravity-1 (T1 fallback) | **BLOCK** — running liveness/PROPERTY on SEQUENTIAL non-interleaved models is not FP-safe (vacuous pass / spurious fail); baselining churns + false-passes once step 2 lands. Amend to INVARIANT-only | — |

## Round 2 (amended: INVARIANT-only step 1, defer liveness/deadlock/concurrency)
| Model | Position | Citations |
|---|---|---|
| antigravity-1 | APPROVE — INVARIANT-only + CHECK_DEADLOCK FALSE + registry pairing + 0-DELTA gate resolves the FP concern | model-registry.json; run-tlc.cjs:365-373 |
| claude-1 | APPROVE — check-model-invariants.cjs already separates INVARIANT (L161) from PROPERTY (L170-177); 67 cfgs have INVARIANT, 26 PROPERTY-only; registry (236 entries) keys by file path → registry pairing is correct; only risk is the lookup plumbing | check-model-invariants.cjs:161,153; model-registry.json |
| copilot-1 | APPROVE — existing cfgs already CHECK_DEADLOCK FALSE + INVARIANT-only form; ~69 cfgs; BLOCK concern directly addressed | MCactivity.cfg |
| claude-minimax | APPROVE — INVARIANT-only skips vacuous/FP liveness; 0-DELTA prevents churn; registry pairing handles opaque MCactivity.cfg→QGSDActivityTracking.tla; empirical 0-violations makes the gate sound | — |

## Outcome
Unanimous APPROVE on the AMENDED step 1 (4/4 valid Round-2 voters; the Round-1 BLOCK was resolved by amendment, not overridden).

**The improvement — close the FSM→TLA→model_check loop (step 1, INVARIANT-only):**
nForma already transpiles its own state machines to TLA via `fsm-to-tla` (28 adapters), emitting 68 `MC*.cfg` models — but `model_check` skips all of them (CONSTANTS → concrete-only gate). Extend `check-model-invariants.cjs` to:
1. Pair each `MC*.cfg` to its `.tla` via `model-registry.json` (keyed by file path — filename stems match for only ~16/68; e.g. `MCactivity.cfg → QGSDActivityTracking.tla`). Reuse `run-tlc.cjs:365-373` pairing heuristics + `constants-mapping.json` for constant bindings (fixes NFQuorum's unassigned `MaxDeliberation`).
2. Run TLC with the provided cfg but **INVARIANT-only** — strip/skip `PROPERTY` (liveness) lines, keep `CHECK_DEADLOCK FALSE`. (67 cfgs carry INVARIANT; 26 are PROPERTY-only and are skipped.)
3. Flag invariant-violations tagged `source:"fsm-transpiled"` (keeps triage separate).
4. **Triage-then-baseline:** classify any violation (real defect vs artifact), gate CI on **0-DELTA** vs a recorded baseline (not 0-absolute). Empirically 0 invariant-violations on the resolvable pairs so far → the gate starts as a conservative no-op.

**DEFERRED to a separate step 2** (do not conflate): liveness/PROPERTY checks on FSMs, `CHECK_DEADLOCK TRUE` (needs a final-states/Termination annotation to avoid terminating-FSM FPs), and making arbitrary concurrency decidable (needs an emitter change to PlusCal `process` composition for interleaved execution — the current emitter is sequential).

**Why it's the highest-leverage improvement:** ~90% of the infrastructure already exists (transpilation done, cfgs emitted, registry + pairing heuristics present); only the "consume the cfg" step is missing. It activates model-checking across nForma's own state machines and lays the groundwork for making FSM-expressible concurrency decidable by construction (sidestepping Rice's theorem via a constrained input language) in step 2.

## Step 2 outcome + deadlock/concurrency boundary (empirical, post-implementation)

Shipped: FSM invariant checking (#309, 62 models) and FSM liveness under the fairness
dual gate (#310, 21 fairness-carrying models) — both 0-baseline, FP-safe.

**Deadlock detection — NOT shipped (empirically not FP-safe on this corpus):**
- Naive `CHECK_DEADLOCK TRUE` fires on **26 of 62** models. Triage: these are
  LEGITIMATE terminal states, not defects (e.g. BugModelLookup reaching `phase="done"`,
  which even satisfies its own `<>(phase="done")` under `WF_` fairness).
- The corpus is HETEROGENEOUS: the deadlocking models are handwritten (QGSDEnforcement)
  or code-scan-derived (`formal-scope-scan.cjs` → BugModelLookup/NFDispatch), NOT
  fsm-to-tla emitter output — so there is no single emitter to fix, and they carry no
  machine-readable terminal annotation.
- No FP-safe heuristic separates "stuck" from "done": splitting on "declares a `<>`
  goal" gives 14 with / 12 without, but a spec can legitimately terminate without
  declaring a liveness goal, so the 12 are not reliably defects.
- Crucially, deadlock is **SUBSUMED by liveness**: for a model that declares a goal
  `<>Done` under fairness, the shipped liveness check already proves it reaches the
  goal (a stuck-short-of-goal state fails liveness). So deadlock adds nothing FP-safe.
- FP-safe deadlock would require per-spec Termination annotations (`Next \/ (isFinal /\
  UNCHANGED vars)`) across 26 heterogeneous hand/scan-authored specs — high effort,
  low marginal value, and outside a detector's scope.

**Multi-process concurrency — NOT shipped (needs an emitter research spike):** the
emitter is sequential single-process; interleaving races (semaphore/lock/shared-state)
need PlusCal `process` composition, a separate research-grade effort.

**Conclusion:** the FP-safe, decidable half of the FSM→TLA loop (safety + liveness) is
COMPLETE. The remaining behaviors are either subsumed, FP-unsafe on the current corpus,
or require an emitter refactor — none is a clean detector addition.

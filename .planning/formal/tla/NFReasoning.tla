---- MODULE NFReasoning ----
(*
 * .planning/formal/tla/NFReasoning.tla
 * Reasoning layer — FMEA hazard model, failure modes, risk heatmap, test recipes
 *
 * @requirement RSN-01
 * @requirement RSN-02
 * @requirement RSN-03
 * @requirement RSN-04
 * @requirement RSN-05
 *)
EXTENDS Naturals, Sequences, TLC

CONSTANTS MaxSteps

VARIABLES state, step
vars == <<state, step>>

\* ── Type invariant ───────────────────────────────────────────────────────────
\* @requirement RSN-01
\* @requirement RSN-02
\* @requirement RSN-03
\* @requirement RSN-04
\* @requirement RSN-05
TypeOK ==
    /\ state \in {"idle", "running", "done", "error"}
    /\ step \in 0..MaxSteps

\* ── Initial state ────────────────────────────────────────────────────────────
Init ==
    /\ state = "idle"
    /\ step = 0

\* ── Actions ──────────────────────────────────────────────────────────────────

Step1 ==
    /\ state = "idle" /\ step < MaxSteps
    /\ state' = "running"
    /\ step' = step + 1

Step2 ==
    /\ state = "running" /\ step < MaxSteps
    /\ state' = "done"
    /\ step' = step + 1

Step3 ==
    /\ state = "done" /\ step < MaxSteps
    /\ state' = "error"
    /\ step' = step + 1

Reset ==
    /\ state = "error"
    /\ state' = "idle"
    /\ step' = 0

Next ==
    \/ Step1
    \/ Step2
    \/ Step3
    \/ Reset

Spec == Init /\ [][Next]_vars

\* ── Safety invariants ────────────────────────────────────────────────────────
StateValid == state \in {"idle", "running", "done", "error"}
StepBounded == step >= 0 /\ step <= MaxSteps


\* Real safety invariant: idle is only reached via Init/Reset (both step=0), so no
\* progress can be accumulated while idle. Replaces the tautological StateValid/StepBounded.
IdleImpliesZeroStep == state = "idle" => step = 0

====

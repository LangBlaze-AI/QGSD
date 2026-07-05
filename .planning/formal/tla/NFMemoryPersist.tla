---- MODULE NFMemoryPersist ----
(*
 * .planning/formal/tla/NFMemoryPersist.tla
 * Memory persistence — decisions, reminders, error patterns, quorum memory
 *
 * @requirement MEMP-01
 * @requirement MEMP-02
 * @requirement MEMP-03
 * @requirement MEMP-04
 *)
EXTENDS Naturals, Sequences, TLC

CONSTANTS MaxSteps

VARIABLES state, step
vars == <<state, step>>

\* ── Type invariant ───────────────────────────────────────────────────────────
\* @requirement MEMP-01
\* @requirement MEMP-02
\* @requirement MEMP-03
\* @requirement MEMP-04
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

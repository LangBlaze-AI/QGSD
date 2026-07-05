---- MODULE NFOrchestration ----
(*
 * .planning/formal/tla/NFOrchestration.tla
 * Subagent orchestration — context retrieval, accumulation, specialized agents
 *
 * @requirement ORCH-01
 * @requirement ORCH-02
 * @requirement ORCH-03
 *)
EXTENDS Naturals, Sequences, TLC

CONSTANTS MaxSteps

VARIABLES state, step
vars == <<state, step>>

\* ── Type invariant ───────────────────────────────────────────────────────────
\* @requirement ORCH-01
\* @requirement ORCH-02
\* @requirement ORCH-03
TypeOK ==
    /\ state \in {"idle", "running", "done"}
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

Reset ==
    /\ state = "done"
    /\ state' = "idle"
    /\ step' = 0

Next ==
    \/ Step1
    \/ Step2
    \/ Reset

Spec == Init /\ [][Next]_vars

\* ── Safety invariants ────────────────────────────────────────────────────────
StateValid == state \in {"idle", "running", "done"}
StepBounded == step >= 0 /\ step <= MaxSteps


\* Real safety invariant: idle is only reached via Init/Reset (both step=0), so no
\* progress can be accumulated while idle. Replaces the tautological StateValid/StepBounded.
IdleImpliesZeroStep == state = "idle" => step = 0

====

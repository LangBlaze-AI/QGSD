---- MODULE NFQuorum ----
(*
 * .planning/formal/tla/NFQuorum.tla
 * GENERATED — do not edit by hand.
 * Source of truth: src/machines/nf-workflow.machine.ts
 * Regenerate:      node bin/generate-formal-specs.cjs
 * Generated:       2026-05-13

 * Models the quorum workflow defined in src/machines/nf-workflow.machine.ts.
 * Guard translations (from GUARD_REGISTRY in bin/generate-formal-specs.cjs):
 *   unanimityMet (successCount >= polledCount):   n = p
 *   noInfiniteDeliberation (deliberationRounds < maxDeliberation):  deliberationRounds < MaxDeliberation
*)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    Agents,          \* Set of quorum model slots (e.g., {"a1","a2","a3","a4","a5"})
    MaxDeliberation, \* Maximum deliberation rounds before forced DECIDED (default: 9)
    MaxSize          \* Cap on voters polled per round (default: 3)

ASSUME MaxDeliberation \in Nat /\ MaxDeliberation > 0

\* N = total number of agents; used for cardinality checks
N == Cardinality(Agents)

ASSUME MaxSize \in 1..N

\* AgentSymmetry: referenced by MCsafety.cfg as SYMMETRY AgentSymmetry.
AgentSymmetry == Permutations(Agents)

VARIABLES
    phase,              \* One of: "IDLE", "COLLECTING_VOTES", "DELIBERATING", "DECIDED"
    successCount,       \* Number of APPROVE votes collected in current round
    polledCount,        \* Number of agents actually recruited this round (≤ MaxSize; may be less if roster runs dry)
    deliberationRounds  \* Number of deliberation rounds completed

vars == <<phase, successCount, polledCount, deliberationRounds>>

\* ── Type invariant ───────────────────────────────────────────────────────────
\* @requirement QUORUM-01
TypeOK ==
    /\ phase \in {"IDLE", "COLLECTING_VOTES", "DELIBERATING", "DECIDED"}
    /\ successCount \in 0..MaxSize
    /\ polledCount \in 0..MaxSize
    /\ deliberationRounds \in 0..MaxDeliberation

\* ── Initial state ────────────────────────────────────────────────────────────
Init ==
    /\ phase              = "IDLE"
    /\ successCount       = 0
    /\ polledCount        = 0
    /\ deliberationRounds = 0

\* ── Actions ──────────────────────────────────────────────────────────────────

\* StartQuorum: workflow leaves IDLE → COLLECTING_VOTES
StartQuorum ==
    /\ phase = "IDLE"
    /\ phase' = "COLLECTING_VOTES"
    /\ UNCHANGED <<successCount, polledCount, deliberationRounds>>

\* CollectVotes(n, p): n APPROVE votes from p polled agents (p ≤ MaxSize).
\* unanimityMet (successCount >= polledCount): All polled agents approved (unanimity within the polled set).
\* n = p → DECIDED; otherwise → DELIBERATING.
CollectVotes(n, p) ==
    /\ phase = "COLLECTING_VOTES"
    /\ p \in 1..MaxSize
    /\ n \in 0..p
    /\ successCount' = n
    /\ polledCount' = p
    /\ IF n = p
       THEN /\ phase' = "DECIDED"
            /\ UNCHANGED deliberationRounds
       ELSE /\ phase' = "DELIBERATING"
            /\ deliberationRounds' = deliberationRounds + 1

\* Deliberate(n): n APPROVE votes after a deliberation round.
\* Unanimity or exhaustion (deliberationRounds >= MaxDeliberation) → DECIDED.
Deliberate(n) ==
    /\ phase = "DELIBERATING"
    /\ n \in 0..MaxSize
    /\ successCount' = n
    /\ IF n = polledCount \/ deliberationRounds >= MaxDeliberation
       THEN /\ phase' = "DECIDED"
            /\ UNCHANGED deliberationRounds
       ELSE /\ phase' = "DELIBERATING"
            /\ deliberationRounds' = deliberationRounds + 1
    /\ UNCHANGED polledCount

\* Decide: forced termination when deliberation limit is exhausted.
Decide ==
    /\ phase = "DELIBERATING"
    /\ deliberationRounds >= MaxDeliberation
    /\ phase' = "DECIDED"
    /\ UNCHANGED <<successCount, polledCount, deliberationRounds>>

Next ==
    \/ StartQuorum
    \/ \E p \in 1..MaxSize : \E n \in 0..p : CollectVotes(n, p)
    \/ \E n \in 0..MaxSize : Deliberate(n)
    \/ Decide

\* ── Safety invariants ────────────────────────────────────────────────────────

\* UnanimityMet: if DECIDED via approval, unanimity was achieved or deliberation was exhausted.
\* @requirement QUORUM-02
\* @requirement SAFE-01
UnanimityMet ==
    phase = "DECIDED" =>
        (successCount = polledCount \/ deliberationRounds >= MaxDeliberation)

\* QuorumCeilingMet: when DECIDED, polledCount did not exceed MaxSize.
\* @requirement QUORUM-03
\* @requirement SLOT-01
QuorumCeilingMet ==
    phase = "DECIDED" =>
        /\ polledCount <= MaxSize
        /\ (successCount = polledCount \/ deliberationRounds >= MaxDeliberation)

\* NoInvalidTransition: IDLE can only advance to COLLECTING_VOTES.
\* Kept for backwards compatibility; AllTransitionsValid covers this and all other states.
NoInvalidTransition ==
    [][phase = "IDLE" => phase' \in {"IDLE", "COLLECTING_VOTES"}]_vars

\* AllTransitionsValid: every state can only reach its defined successors.
\* Covers all four states — a superset of NoInvalidTransition.
\* @requirement SAFE-02
AllTransitionsValid ==
    /\ [][phase = "IDLE" => phase' \in {"IDLE", "COLLECTING_VOTES"}]_vars
    /\ [][phase = "COLLECTING_VOTES" => phase' \in {"COLLECTING_VOTES", "DELIBERATING", "DECIDED"}]_vars
    /\ [][phase = "DELIBERATING" => phase' \in {"DELIBERATING", "DECIDED"}]_vars
    /\ [][phase = "DECIDED" => phase' = "DECIDED"]_vars

\* DeliberationBounded: deliberationRounds never exceeds MaxDeliberation.
\* Follows from the guard noInfiniteDeliberation on the DELIBERATING→DELIBERATING branch.
\* @requirement LOOP-01
DeliberationBounded ==
    deliberationRounds <= MaxDeliberation

\* DeliberationMonotone: deliberationRounds only ever increases.
\* Ensures rounds cannot be rolled back — a key soundness property.
\* @requirement SAFE-03
DeliberationMonotone ==
    [][deliberationRounds' >= deliberationRounds]_vars

\* ── Liveness ─────────────────────────────────────────────────────────────────

\* EventualConsensus: every behavior eventually reaches DECIDED.
\* @requirement QUORUM-04
\* @requirement RECV-01
EventualConsensus == <>(phase = "DECIDED")

\* ── Composite actions for fairness ──────────────────────────────────────────
AnyCollectVotes == \E p \in 1..MaxSize : \E n \in 0..p : CollectVotes(n, p)
AnyDeliberate   == \E n \in 0..MaxSize : Deliberate(n)

\* ── Full specification with fairness ────────────────────────────────────────
Spec == Init /\ [][Next]_vars
        /\ WF_vars(Decide)
        /\ WF_vars(StartQuorum)
        /\ WF_vars(AnyCollectVotes)
        /\ WF_vars(AnyDeliberate)

====

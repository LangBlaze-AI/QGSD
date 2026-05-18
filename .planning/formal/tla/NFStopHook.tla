---- MODULE NFStopHook ----
(*
 * formal/tla/QGSDStopHook.tla
 * Handwritten — not generated from XState.
 * Source: hooks/qgsd-stop.js (hasQuorumCommand + wasSlotWorkerUsed + successCount logic)
 *
 * SPEC-01: Stop hook decision logic.
 * Formalizes the gate: HasPlanningCommand ∧ ¬HasQuorumEvidence ⟹ BLOCK
 *
 * The Stop hook is the most critical enforcement gate in QGSD — it makes
 * quorum non-skippable. This spec catches logic errors that code review misses
 * and provides machine-checkable guarantees for safety + liveness contracts.
 *
 * Safety invariants:
 *   SafetyInvariant1: BLOCK decision implies a planning command was detected
 *   SafetyInvariant2: BLOCK decision implies quorum evidence is absent
 *   SafetyInvariant3: PASS decision implies both command detected AND quorum evidence present
 *
 * Liveness properties:
 *   LivenessProperty1: The algorithm always eventually terminates
 *   LivenessProperty2: If quorum evidence is present, the decision eventually reaches PASS
 *   LivenessProperty3: If command detected and no quorum evidence, decision eventually reaches BLOCK
 *
 * Run: node bin/run-stop-hook-tlc.cjs MCStopHook  (requires Java >=17 + tla2tools.jar)
 *)

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  MaxTurnLines,  \* Maximum transcript lines considered (model: 500)
  MinLiveVoters  \* Minimum live voters for valid consensus (issue #170, default: 2)

VARIABLES
  hasCommand,        \* TRUE if a planning command (e.g. /qgsd:plan-phase) was found in current turn
  hasQuorumEvidence, \* TRUE if quorum evidence (slot-worker calls or successful MCP responses) present
  liveVoterCount,    \* Number of live (non-UNAVAIL) voters detected
  decision,          \* "UNDECIDED" | "BLOCK" | "PASS"
  algorithmDone      \* TRUE when MakeDecision has fired

vars == <<hasCommand, hasQuorumEvidence, liveVoterCount, decision, algorithmDone>>

(*
 * TypeOK — type invariant for all variables.
 *)
\* @requirement STOP-01
TypeOK ==
  /\ hasCommand        \in BOOLEAN
  /\ hasQuorumEvidence \in BOOLEAN
  /\ liveVoterCount    \in Nat
  /\ decision          \in {"UNDECIDED", "BLOCK", "PASS"}
  /\ algorithmDone     \in BOOLEAN

(*
 * Init — initial state before transcript scanning.
 * Hook begins with no detections, no decision.
 *)
Init ==
  /\ hasCommand        = FALSE
  /\ hasQuorumEvidence = FALSE
  /\ liveVoterCount    = 0
  /\ decision          = "UNDECIDED"
  /\ algorithmDone     = FALSE

(*
 * DetectCommand — nondeterministic: the hook either finds or does not find
 * a planning command in the transcript.
 *
 * Models: hasQuorumCommand(currentTurnLines, cmdPattern)
 * Nondeterminism covers all possible transcript states.
 *)
DetectCommand ==
  /\ ~algorithmDone
  /\ hasCommand = FALSE
  /\ hasCommand' \in BOOLEAN
  /\ UNCHANGED <<hasQuorumEvidence, liveVoterCount, decision, algorithmDone>>

(*
 * DetectQuorumEvidence — nondeterministic: the hook either finds or does not find
 * quorum evidence (slot-worker call or sufficient successful MCP responses).
 *
 * Models: wasSlotWorkerUsed(currentTurnLines) OR successCount >= maxSize
 * Nondeterminism covers all transcript histories.
 *)
DetectQuorumEvidence ==
  /\ ~algorithmDone
  /\ hasQuorumEvidence = FALSE
  /\ hasQuorumEvidence' \in BOOLEAN
  /\ UNCHANGED <<hasCommand, liveVoterCount, decision, algorithmDone>>

(*
 * DetectLiveVoters — nondeterministic: the hook detects N live (non-UNAVAIL) voters.
 * Models: countLiveSlotWorkers() or successCount from MCP call counting.
 *)
DetectLiveVoters ==
  /\ ~algorithmDone
  /\ liveVoterCount = 0
  /\ liveVoterCount' \in 0..MaxTurnLines
  /\ UNCHANGED <<hasCommand, hasQuorumEvidence, decision, algorithmDone>>

(*
 * MakeDecision — applies the Stop hook gate logic once detection is complete.
 *
 * Models the exact if/else logic from hooks/qgsd-stop.js:
 *   - If no planning command: PASS (GUARD 4: exit 0)
 *   - If planning command AND quorum evidence: PASS (successCount >= maxSize)
 *   - If planning command AND no quorum evidence: BLOCK
 *
 * This action fires exactly once, setting algorithmDone = TRUE.
 *)
MakeDecision ==
  /\ ~algorithmDone
  /\ decision = "UNDECIDED"
  /\ decision' =
       IF ~hasCommand THEN "PASS"
       ELSE IF hasCommand /\ hasQuorumEvidence /\ liveVoterCount >= MinLiveVoters THEN "PASS"
       ELSE "BLOCK"
  /\ algorithmDone' = TRUE
  /\ UNCHANGED <<hasCommand, hasQuorumEvidence, liveVoterCount>>

(*
 * Next — step relation: detection steps or the decision step.
 * Once algorithmDone = TRUE, all variables remain unchanged (terminal state).
 *)
Next ==
  \/ DetectCommand
  \/ DetectQuorumEvidence
  \/ DetectLiveVoters
  \/ MakeDecision
  \/ (algorithmDone /\ UNCHANGED vars)  \* Stuttering in terminal state

(*
 * Spec — the full temporal formula.
 * Fairness on MakeDecision ensures the algorithm eventually terminates.
 * Fairness on detect actions ensures both detection steps can fire.
 *
 * IMPORTANT: Do NOT add a separate FAIRNESS line in MCStopHook.cfg.
 * Fairness is declared here via WF_vars() — same pattern as MCoscillation.cfg.
 *)
Spec ==
  Init
  /\ [][Next]_vars
  /\ WF_vars(MakeDecision)
  /\ WF_vars(DetectCommand)
  /\ WF_vars(DetectQuorumEvidence)
  /\ WF_vars(DetectLiveVoters)

\* ── Safety Invariants ──────────────────────────────────────────────────────

(*
 * SafetyInvariant1: BLOCK can only be decided if a planning command was detected.
 * Prevents false blocks on non-planning turns.
 *)
\* @requirement STOP-02
\* @requirement SPEC-01
SafetyInvariant1 ==
  decision = "BLOCK" => hasCommand

(*
 * SafetyInvariant2: BLOCK can only be decided if quorum evidence is absent.
 * Prevents blocking a turn that already satisfied the quorum requirement.
 *)
\* @requirement STOP-03
SafetyInvariant2 ==
  decision = "BLOCK" => ~hasQuorumEvidence

(*
 * SafetyInvariant3: PASS can only be decided on a planning turn if quorum evidence is present
 * AND live voter count meets the floor.
 * (When hasCommand=FALSE, PASS is trivially correct — not a planning turn.)
 *)
\* @requirement STOP-04
SafetyInvariant3 ==
  (decision = "PASS" /\ hasCommand) => hasQuorumEvidence

(*
 * FloorSafety: PASS on a planning turn requires live voters >= MinLiveVoters.
 * Prevents thin consensus where a single surviving voter declares unanimity.
 *)
\* @requirement QUORUM-170
FloorSafety ==
  (decision = "PASS" /\ hasCommand) => liveVoterCount >= MinLiveVoters

\* ── Liveness Properties ────────────────────────────────────────────────────

(*
 * LivenessProperty1: The algorithm always eventually completes.
 * Guarantees the hook never hangs indefinitely.
 *)
\* @requirement STOP-05
LivenessProperty1 == <>algorithmDone

(*
 * LivenessProperty2: If quorum evidence is present AND live voters meet the floor,
 * the decision eventually reaches PASS.
 * Ensures the hook doesn't block when quorum is satisfied with adequate voters.
 *)
\* @requirement STOP-06
LivenessProperty2 == (hasQuorumEvidence /\ liveVoterCount >= MinLiveVoters) => <>(decision = "PASS")

(*
 * LivenessProperty3: If a command is detected with no quorum evidence OR below-floor
 * live voters, the decision eventually reaches BLOCK.
 *)
\* @requirement STOP-07
LivenessProperty3 == (hasCommand /\ (~hasQuorumEvidence \/ liveVoterCount < MinLiveVoters)) => <>(decision = "BLOCK")

====

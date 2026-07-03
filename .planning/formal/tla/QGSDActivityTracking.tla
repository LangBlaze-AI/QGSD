---- MODULE QGSDActivityTracking ----
(*
 * .planning/formal/tla/QGSDActivityTracking.tla
 * Handwritten — models the current-activity.json lifecycle.
 * Source: qgsd-core/workflows/execute-phase.md, resume-work.md, plan-phase.md
 *
 * Models the activity file state machine:
 *   IDLE     = no activity file exists
 *   ACTIVE   = activity file written (workflow in progress)
 *   RESUMED  = activity file read for recovery routing
 *
 * @requirement ACT-01
 * @requirement ACT-02
 * @requirement ACT-03
 * @requirement ACT-04
 * @requirement ACT-05
 * @requirement ACT-06
 * @requirement ACT-07
 *)
EXTENDS Naturals, TLC

CONSTANTS
    MaxWorkflows,   \* maximum concurrent workflow transitions to explore
    Activities      \* set of activity names (e.g., {"execute", "plan", "debug", "quorum", "breaker"})

ASSUME MaxWorkflows \in Nat /\ MaxWorkflows >= 1

VARIABLES
    fileExists,     \* BOOLEAN — whether current-activity.json exists on disk
    activity,       \* current activity name (element of Activities or "none")
    subActivity,    \* current sub_activity (simplified to "idle" | "running" | "complete")
    stepCount,      \* number of stage transitions in current workflow
    recovered       \* BOOLEAN — whether resume-work has read the file this cycle

vars == <<fileExists, activity, subActivity, stepCount, recovered>>

\* ── Type invariant ─────────────────────────────────────────────────────────
\* @requirement ACT-02
TypeOK ==
    /\ fileExists  \in BOOLEAN
    /\ activity    \in Activities \cup {"none"}
    /\ subActivity \in {"idle", "running", "complete"}
    /\ stepCount   \in 0..MaxWorkflows
    /\ recovered   \in BOOLEAN

\* ── Initial state ──────────────────────────────────────────────────────────
Init ==
    /\ fileExists  = FALSE
    /\ activity    = "none"
    /\ subActivity = "idle"
    /\ stepCount   = 0
    /\ recovered   = FALSE

\* ── Actions ────────────────────────────────────────────────────────────────

\* ACT-01: Atomic write at workflow state transition
\* @requirement ACT-01
WriteActivity(act) ==
    /\ act \in Activities
    /\ stepCount < MaxWorkflows
    /\ fileExists'  = TRUE
    /\ activity'    = act
    /\ subActivity' = "running"
    /\ stepCount'   = stepCount + 1
    /\ recovered'   = FALSE

\* ACT-05/ACT-06: Stage boundary transition within active workflow
\* @requirement ACT-05
\* @requirement ACT-06
StageTransition ==
    /\ fileExists = TRUE
    /\ subActivity = "running"
    /\ stepCount < MaxWorkflows
    /\ fileExists'  = TRUE
    /\ activity'    = activity
    /\ subActivity' = "running"
    /\ stepCount'   = stepCount + 1
    /\ recovered'   = FALSE

\* ACT-07: Clear on successful completion
\* @requirement ACT-07
ClearActivity ==
    /\ fileExists = TRUE
    /\ subActivity = "running"
    /\ fileExists'  = FALSE
    /\ activity'    = "none"
    /\ subActivity' = "idle"
    /\ stepCount'   = 0
    /\ recovered'   = FALSE

\* ACT-04: resume-work reads file and routes to recovery point
\* @requirement ACT-04
ResumeWork ==
    /\ fileExists = TRUE
    /\ recovered = FALSE
    /\ fileExists'  = TRUE
    /\ activity'    = activity
    /\ subActivity' = "running"
    /\ stepCount'   = stepCount
    /\ recovered'   = TRUE

\* ACT-03: activity-clear CLI command removes file
\* @requirement ACT-03
ActivityClear ==
    /\ fileExists = TRUE
    /\ fileExists'  = FALSE
    /\ activity'    = "none"
    /\ subActivity' = "idle"
    /\ stepCount'   = 0
    /\ recovered'   = FALSE

\* ── Next-state relation ────────────────────────────────────────────────────
Next ==
    \/ \E act \in Activities : WriteActivity(act)
    \/ StageTransition
    \/ ClearActivity
    \/ ResumeWork
    \/ ActivityClear

\* ── Safety invariants ──────────────────────────────────────────────────────

\* @requirement ACT-01
\* Activity name is always valid when file exists
ActivityValid ==
    fileExists = TRUE => activity \in Activities

\* @requirement ACT-07
\* When file is cleared, activity resets to "none"
ClearResetsActivity ==
    fileExists = FALSE => activity = "none"

\* @requirement ACT-04
\* Recovery only happens when file exists
RecoveryRequiresFile ==
    recovered = TRUE => fileExists = TRUE

\* ── Specification ──────────────────────────────────────────────────────────
Spec ==
    /\ Init
    /\ [][Next]_vars

====

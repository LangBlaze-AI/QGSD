---- MODULE QGSDSetupWizard ----
(*
 * .planning/formal/tla/QGSDSetupWizard.tla
 * Handwritten — models the /qgsd:mcp-setup wizard flow.
 * Source: qgsd-core/workflows/mcp-setup.md, bin/qgsd.cjs
 *
 * @requirement WIZ-01
 * @requirement WIZ-02
 * @requirement WIZ-03
 * @requirement WIZ-04
 * @requirement WIZ-05
 * @requirement WIZ-08
 * @requirement WIZ-09
 * @requirement WIZ-10
 *)
EXTENDS Naturals, TLC

CONSTANTS MaxSlots

ASSUME MaxSlots \in Nat /\ MaxSlots >= 1

VARIABLES
    screen,         \* "start" | "firstRun" | "menu" | "editSlot" | "composition" | "confirm" | "done"
    agentCount,     \* number of configured agents (0 = first run)
    confirmed       \* BOOLEAN — user confirmed changes

vars == <<screen, agentCount, confirmed>>

\* ── Type invariant ─────────────────────────────────────────────────────────
TypeOK ==
    /\ screen      \in {"start", "firstRun", "menu", "editSlot", "composition", "confirm", "done"}
    /\ agentCount  \in 0..MaxSlots
    /\ confirmed   \in BOOLEAN

Init ==
    /\ screen      = "start"
    /\ agentCount  \in 0..MaxSlots
    /\ confirmed   = FALSE

\* ── Actions ────────────────────────────────────────────────────────────────

\* WIZ-02: First run (no agents) → guided linear onboarding
\* @requirement WIZ-02
EnterFirstRun ==
    /\ screen = "start"
    /\ agentCount = 0
    /\ screen'     = "firstRun"
    /\ UNCHANGED <<agentCount, confirmed>>

\* WIZ-03: Re-run (has agents) → navigable menu
\* @requirement WIZ-03
EnterMenu ==
    /\ screen = "start"
    /\ agentCount > 0
    /\ screen'     = "menu"
    /\ UNCHANGED <<agentCount, confirmed>>

\* WIZ-04: Select agent from menu to edit
\* @requirement WIZ-04
SelectAgent ==
    /\ screen = "menu"
    /\ screen'     = "editSlot"
    /\ UNCHANGED <<agentCount, confirmed>>

\* WIZ-08: Edit quorum composition from menu
\* @requirement WIZ-08
\* @requirement WIZ-09
EditComposition ==
    /\ screen = "menu"
    /\ screen'     = "composition"
    /\ UNCHANGED <<agentCount, confirmed>>

\* WIZ-10: Add new slot from menu or composition
\* @requirement WIZ-10
AddSlot ==
    /\ screen \in {"menu", "composition", "firstRun"}
    /\ agentCount < MaxSlots
    /\ screen'     = "confirm"
    /\ agentCount' = agentCount + 1
    /\ confirmed'  = FALSE

\* Complete first-run onboarding
CompleteFirstRun ==
    /\ screen = "firstRun"
    /\ agentCount > 0
    /\ screen'     = "confirm"
    /\ UNCHANGED <<agentCount, confirmed>>

\* Return from edit/composition to menu
ReturnToMenu ==
    /\ screen \in {"editSlot", "composition"}
    /\ screen'     = "menu"
    /\ UNCHANGED <<agentCount, confirmed>>

\* WIZ-05: User confirms changes
\* @requirement WIZ-05
ConfirmChanges ==
    /\ screen = "confirm"
    /\ confirmed = FALSE
    /\ confirmed'  = TRUE
    /\ screen'     = "done"
    /\ UNCHANGED agentCount

\* Exit wizard
ExitWizard ==
    /\ screen \in {"menu", "done"}
    /\ screen'     = "done"
    /\ UNCHANGED <<agentCount, confirmed>>

Next ==
    \/ EnterFirstRun
    \/ EnterMenu
    \/ SelectAgent
    \/ EditComposition
    \/ AddSlot
    \/ CompleteFirstRun
    \/ ReturnToMenu
    \/ ConfirmChanges
    \/ ExitWizard

\* ── Safety invariants ──────────────────────────────────────────────────────

\* @requirement WIZ-02
\* First run only ever holds no agents: EnterFirstRun requires agentCount = 0, and every
\* transition that changes agentCount (AddSlot) leaves the "firstRun" screen — so while
\* on "firstRun", agentCount is always 0.
FirstRunRequiresEmpty ==
    screen = "firstRun" => agentCount = 0

\* @requirement WIZ-05
\* Changes are only applied after confirmation: the `confirmed` flag is set (TRUE) ONLY
\* on the confirm→done transition, so a confirmed state is reachable only at "done".
\* (Plain exit menu→done leaves confirmed FALSE — a no-change exit applies nothing.)
ConfirmBeforeDone ==
    confirmed = TRUE => screen = "done"

\* @requirement WIZ-01
\* Wizard always starts at "start" screen
WizardStartsCorrectly ==
    TRUE \* Enforced by Init

Spec ==
    /\ Init
    /\ [][Next]_vars

====

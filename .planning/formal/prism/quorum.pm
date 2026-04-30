// .planning/formal/prism/quorum.pm
// GENERATED — do not edit by hand.
// Source of truth: src/machines/nf-workflow.machine.ts
// Regenerate:      node bin/generate-formal-specs.cjs
// Generated:       2026-04-30

// nForma Quorum Convergence — DTMC Model
// Requirements: PRM-01
//
// Discrete-Time Markov Chain modeling quorum state transitions.
// States:
//   s=0 : COLLECTING_VOTES  (initial)
//   s=1 : DECIDED       (absorbing)
//   s=2 : DELIBERATING     (retry)
//
// Derived from src/machines/nf-workflow.machine.ts:
//   IDLE, COLLECTING_VOTES, DELIBERATING, DECIDED
//
// Guard translations (from GUARD_REGISTRY):
//   unanimityMet (successCount >= polledCount): All polled agents approved (unanimity within the polled set)
//   PRISM translation: tp_rate = P(all polled agents approve)
//
// Default rates are conservative priors. Override with empirical values:
//   node bin/export-prism-constants.cjs
//
// To run (requires PRISM_BIN env var):
//   $PRISM_BIN .planning/formal/prism/quorum.pm -pf "P=? [ F s=1 ]"
//
// To override rates from empirical scoreboard data (no file-include in PRISM):
//   $PRISM_BIN .planning/formal/prism/quorum.pm -pf "P=? [ F s=1 ]" -const tp_rate=0.72 -const unavail=0.28

dtmc

// Slot aggregate rates (conservative priors — override with empirical data)
// tp_rate = P(a slot votes APPROVE | it is AVAILABLE) — unanimityMet criterion
// unavail = P(slot is UNAVAILABLE in a given round)
const double tp_rate;   // injected by run-prism.cjs from scoreboard (see bin/export-prism-constants.cjs)
const double unavail;   // injected by run-prism.cjs from scoreboard (see bin/export-prism-constants.cjs)

module quorum_convergence
    s : [0..2] init 0;

    // From COLLECTING_VOTES:
    // unanimityMet → DECIDED; otherwise → DELIBERATING
    [] s=0 -> (tp_rate * (1 - unavail)) : (s'=1)
            + (1 - tp_rate * (1 - unavail)) : (s'=2);

    // From DELIBERATING: same transition probabilities (memoryless DTMC)
    // Note: MaxDeliberation (9) is enforced by XState guard, not modeled here.
    // The DTMC captures convergence probability per round, not the capped count.
    [] s=2 -> (tp_rate * (1 - unavail)) : (s'=1)
            + (1 - tp_rate * (1 - unavail)) : (s'=2);

    // DECIDED is an absorbing state
    [] s=1 -> 1.0 : (s'=1);

endmodule

// Reward structure: count deliberation rounds (steps spent outside DECIDED)
rewards "rounds"
    s=0 : 1;  // cost of one COLLECTING_VOTES step
    s=2 : 1;  // cost of one DELIBERATING step
endrewards

// Properties checked in .planning/formal/prism/quorum.props (run with quorum.props file):
// P1: Eventual convergence — P=? [ F s=1 ]   (should be 1.0)
// P2: Expected rounds     — R{"rounds"}=? [ F s=1 ]   (should be ~1/p where p=tp_rate*(1-unavail))
// P3: Decide within 9 rounds — P=? [ F<=9 s=1 ]
// P4: Decide within 10    — P=? [ F<=10 s=1 ]

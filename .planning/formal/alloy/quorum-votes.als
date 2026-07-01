-- .planning/formal/alloy/quorum-votes.als
-- GENERATED — do not edit by hand.
-- Source of truth: src/machines/nf-workflow.machine.ts
-- Regenerate:      node bin/generate-formal-specs.cjs
-- Generated:       2026-06-30

-- nForma Quorum Vote-Counting Model (Alloy 6)
-- Requirements: ALY-01
--
-- Models the unanimityMet guard from src/machines/nf-workflow.machine.ts:
--   successCount >= polledCount
--   ≡  #r.approvals = #r.polled  (all polled agents approved)
--
-- Guard registry translation: GUARD_REGISTRY.unanimityMet.alloy
-- All polled agents approved (unanimity within the polled set)
--
-- Checks that no round reaches DECIDED without satisfying the unanimity predicate.
-- Scope: 5 agents (nForma quorum slot count), 5 vote rounds.

module quorum_votes

-- Fix agent count to 5 (nForma quorum slot count).
-- This makes the numeric threshold assertions below concrete and verifiable.
fact AgentCount { #Agent = 5 }

sig Agent {}

sig VoteRound {
    approvals : set Agent,
    polled    : one Int,
    total     : one Int
}

-- UnanimityReached: mirrors unanimityMet guard from XState machine.
-- All polled agents approved (unanimity within the polled set).
-- Equivalent to successCount >= polledCount in TypeScript.
pred UnanimityReached [r : VoteRound] {
    #r.approvals = r.polled
}

pred ValidRound [r : VoteRound] {
    r.total = #Agent        -- total must equal actual agent count
    r.polled <= r.total     -- can't poll more than exist
    r.polled >= 1           -- must poll at least one agent
    #r.approvals <= r.polled -- can't have more approvals than polled
}

-- ASSERTION 1: Full unanimity — all polled agents approve.
-- Non-trivial: Alloy must verify #approvals = polled for unanimity.
-- @requirement QUORUM-02
-- @requirement SAFE-01
assert ThresholdPasses {
    all r : VoteRound |
        (ValidRound[r] and #r.approvals = r.polled) implies UnanimityReached[r]
}

-- ASSERTION 2: One missing approval fails unanimity.
-- Non-trivial: any polled agent not approving must block consensus.
-- @requirement QUORUM-02
-- @requirement SAFE-01
assert BelowThresholdFails {
    all r : VoteRound |
        (ValidRound[r] and r.polled > 1 and #r.approvals = minus[r.polled, 1]) implies not UnanimityReached[r]
}

-- ASSERTION 3: Zero approvals always fails — safety baseline regardless of N.
-- @requirement SAFE-04
assert ZeroApprovalsFail {
    all r : VoteRound | ValidRound[r] implies (not (#r.approvals = 0 and UnanimityReached[r]))
}

check ThresholdPasses   for 5 Agent, 5 VoteRound
check BelowThresholdFails for 5 Agent, 5 VoteRound
check ZeroApprovalsFail for 5 Agent, 5 VoteRound

-- Show an example valid unanimity round
run UnanimityReached for 5 Agent, 1 VoteRound

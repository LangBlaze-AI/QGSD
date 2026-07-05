---
name: nf:spec-phase
description: Clarify WHAT a phase delivers with ambiguity scoring — produces a falsifiable SPEC.md before discuss-phase
argument-hint: "[phase]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
---

<objective>
Lock **what** a phase delivers (and why) before **how** (discuss-phase) and the plan. Runs a structured Socratic interview with **quantitative ambiguity scoring**, and only writes `SPEC.md` once the phase is falsifiable enough to build against.

Position in the flow: `spec-phase → discuss-phase → plan-phase → execute → verify`.

Ported from open-gsd/gsd-core's spec-phase. **nForma fusion:** the spec's falsifiable "the system MUST X" statements are exactly what our formal layer consumes — each is tagged as a **candidate invariant**, and a fifth scoring dimension (**formal-verifiability**) rewards requirements that can be stated as a checkable property. On completion the candidates are offered to `/nf:close-formal-gaps` so "what" becomes a proven invariant, not just prose.

Output: `${PHASE_DIR}/${PADDED_PHASE}-SPEC.md` — falsifiable requirements + candidate invariants.
</objective>

<execution_context>
@~/.claude/nf/workflows/spec-phase.md
</execution_context>

<context>
Phase number: $ARGUMENTS (required). Loads PROJECT/REQUIREMENTS/ROADMAP/STATE context in-workflow.
</context>

<process>
1. Load phase context; surface what's already known vs unknown.
2. Socratic interview loop (≤6 rounds, rotating perspectives: user / adversary / integrator / formal-verifier).
3. After each round, score ambiguity across 5 weighted dimensions (completeness, testability, boundary-clarity, consistency, **formal-verifiability**).
4. Gate: overall ambiguity ≤ 0.20 AND every dimension ≥ its minimum → write SPEC.md with falsifiable requirements + a **Candidate Invariants** section.
5. Offer to route the candidate invariants into `/nf:close-formal-gaps`.
</process>

# Workflow: spec-phase

Clarify WHAT a phase delivers via Socratic questioning + quantitative ambiguity scoring, gated to a falsifiable SPEC.md. Ported from open-gsd/gsd-core, fused with nForma's formal layer (falsifiable requirements → candidate invariants).

<step name="load_context">
Resolve the phase and load context (fail-open on missing files):
- `.planning/PROJECT.md` / `.planning/REQUIREMENTS.md` — the domain and existing requirements.
- `.planning/ROADMAP.md` — this phase's stated goal and success criteria.
- `.planning/STATE.md` — where we are.

Summarize what is already pinned vs. what is genuinely open for this phase. If the phase goal is already fully falsifiable (rare), note it and offer to skip straight to discuss-phase.

Continue to socratic_loop.
</step>

<step name="socratic_loop">
Run up to **6 rounds** of clarifying questions. Each round rotates the lens so the phase is probed from every angle:
1. **User** — what outcome does the user actually need? what does success look like they'd recognize?
2. **Adversary** — how could this be misread? what edge/failure case is unspecified?
3. **Integrator** — what does this touch upstream/downstream? what contract must hold?
4. **Formal-verifier** — which statements could be a checkable property (an invariant), and what would falsify each?

Ask 2–4 sharp questions per round (not a survey). Record answers. Stop early if the gate (below) is met.
</step>

<step name="score_ambiguity">
After each round, score ambiguity in [0,1] (0 = crisp, 1 = wide open) across 5 weighted dimensions, then compute the weighted overall:

| Dimension | Weight | 0.0 means… |
|-----------|--------|------------|
| Completeness | 0.25 | every success criterion has a concrete acceptance test |
| Testability | 0.25 | each requirement is falsifiable — you can name what would prove it wrong |
| Boundary-clarity | 0.20 | in-scope / out-of-scope is explicit; no "maybe" |
| Consistency | 0.15 | no two requirements conflict; terms used one way |
| **Formal-verifiability** | 0.15 | the safety/liveness claims are stated as checkable properties (candidate invariants) |

**Gate:** overall ≤ **0.20** AND every dimension ≤ **0.35**. If not met and rounds remain, loop with questions targeting the worst dimension. After 6 rounds, if still not met, write SPEC.md anyway but flag the residual ambiguity explicitly (never silently ship a vague spec).

Continue to write_spec once the gate is met (or rounds exhausted).
</step>

<step name="write_spec">
Write `${PHASE_DIR}/${PADDED_PHASE}-SPEC.md`:

```markdown
# Phase ${PHASE} — Spec (what & why)

## Outcome
{the user-recognizable result}

## Falsifiable Requirements
- **{REQ}** — {statement}. **Falsified if:** {concrete failing observation}.

## Scope
**In:** {…}  **Out:** {…}

## Candidate Invariants (nForma fusion)
Requirements that read as a checkable property — offered to the formal layer:
- {property} — safety/liveness; suggested TLA+/Alloy form: {sketch}

## Ambiguity score
overall: {x} (completeness {..}, testability {..}, boundary {..}, consistency {..}, formal-verifiability {..})
```

Commit the SPEC (docs commit). Then **offer** to route the Candidate Invariants into `/nf:close-formal-gaps ${PHASE}` so the falsifiable "what" becomes a proven invariant. discuss-phase picks up the SPEC automatically on its next run. Never invent requirements the interview didn't establish.
</step>

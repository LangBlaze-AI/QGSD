---
name: nf:extract-learnings
description: Mine a completed phase's artifacts into LEARNINGS.md — decisions, lessons, patterns, surprises
argument-hint: "[phase]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
---

<objective>
Turn a completed phase's artifacts (PLAN.md, SUMMARY.md, VERIFICATION.md, UAT.md, STATE.md) into a structured `LEARNINGS.md` — what was decided and why, what surprised us, which patterns recurred — so the next phase and the next milestone start smarter.

Ported from open-gsd/gsd-core's extract-learnings. **nForma fusion:** also mines the *formal* and *quorum* record — which invariants/models changed, what formal verification caught, and which quorum decisions were made — and feeds the durable ones into nForma's decision memory (`bin/memory-store.cjs`), so a learning isn't just a file, it's recalled in future sessions.
</objective>

<execution_context>
@~/.claude/nf/workflows/extract-learnings.md
</execution_context>

<context>
Phase number: $ARGUMENTS (optional — default: the most recently completed phase).
</context>

<process>
1. Resolve the target phase; read its artifacts (PLAN/SUMMARY/VERIFICATION/UAT/STATE) — fail-open on any missing file.
2. Synthesize four sections: **Decisions** (what + why), **Lessons** (what we'd do differently), **Patterns** (what recurred), **Surprises** (what we didn't expect).
3. Fusion pass: add **Formal** (invariants/models added or changed, what formal-verify caught) and **Quorum** (notable consensus/BLOCK decisions) subsections from `.planning/formal/` and the quorum record.
4. Write `${PHASE_DIR}/${PADDED_PHASE}-LEARNINGS.md`; record each durable decision into memory via `bin/memory-store.cjs`.
</process>

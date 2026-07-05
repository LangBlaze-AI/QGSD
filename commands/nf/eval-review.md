---
name: nf:eval-review
description: Audit an AI/LLM feature's evaluation coverage → scored EVAL-REVIEW.md with a production-readiness verdict
argument-hint: "[phase or feature]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
---

<objective>
Retroactively audit whether an AI/LLM feature is actually evaluated — not just built. Checks the planned eval rubric (faithfulness, hallucination, safety, schema, task-specific dimensions) against what's really implemented, scores it deterministically, and produces an `EVAL-REVIEW.md` with a production-readiness verdict + remediation plan.

Ported from open-gsd/gsd-core's eval pipeline. **nForma fusion:** nForma is itself an LLM system (quorum + LLM-powered skills), so it should hold its own AI features to this bar. And because we have a real multi-LLM quorum, a **borderline verdict is confirmed by quorum** — `bin/eval-score.cjs` flags `quorum_recommended` when the score sits near a threshold, and this command routes that call to `/nf:quorum` for a multi-model second opinion instead of trusting one judge.

Output: `${PHASE_DIR}/EVAL-REVIEW.md` — score, verdict, dimension coverage, infra audit, remediation.
</objective>

<execution_context>
@~/.claude/nf/workflows/eval-review.md
</execution_context>

<context>
Target: $ARGUMENTS — a phase number or an AI feature name (e.g. "quorum consensus"). Reads the phase's AI-SPEC.md / eval strategy if present.
</context>

<process>
1. Identify the AI feature + its planned eval rubric (from AI-SPEC.md, REQUIREMENTS, or infer the dimensions the feature demands).
2. Audit each dimension COVERED / PARTIAL / MISSING against the implementation (does an eval that targets the behavior actually run?), and the 5 infra components (tooling / dataset / cicd / guardrails / tracing) ok / partial / missing.
3. Score deterministically via `bin/eval-score.cjs` — never compute by hand.
4. If the result is `quorum_recommended` (borderline), offer to confirm the verdict via `/nf:quorum`.
5. Write EVAL-REVIEW.md with the verbatim score/verdict + a remediation plan for every PARTIAL/MISSING.
</process>

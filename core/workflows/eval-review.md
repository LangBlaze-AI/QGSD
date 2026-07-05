# Workflow: eval-review

Audit an AI/LLM feature's evaluation coverage, score it deterministically, and produce EVAL-REVIEW.md. Ported from open-gsd/gsd-core, fused with nForma's quorum (borderline verdicts are quorum-confirmed).

<step name="identify_feature">
Resolve the target from `$ARGUMENTS` (a phase number or a feature name).

- Read the phase's `AI-SPEC.md` / eval strategy if present. If none exists, infer the rubric the feature demands — for an LLM feature that typically includes: **faithfulness/groundedness, hallucination, safety/refusal, output-schema conformance,** plus any task-specific dimension.
- List the total rubric dimensions `D`. If there is genuinely no AI/LLM behavior here, report "not an AI feature — eval-review does not apply" and stop.

Continue to audit_dimensions.
</step>

<step name="audit_dimensions">
For each rubric dimension, classify against the **implementation** (be adversarial — "an eval file exists" ≠ "the behavior is evaluated"):
- **COVERED** — an eval targeting this behavior exists and actually runs (automated or documented-manual).
- **PARTIAL** — exists but incomplete / not automated / known gaps. (counts as 0.5)
- **MISSING** — no implementation for this dimension.

Count `covered` = (#COVERED) + 0.5·(#PARTIAL). Record, for each PARTIAL/MISSING, what was planned, what was found, and the specific remediation to reach COVERED.

Then audit the **5 infra components** ok / partial / missing:
- **tooling** — eval framework installed AND actually called (not just a dependency).
- **dataset** — a reference dataset file exists and meets the size/composition spec.
- **cicd** — evals run in CI, not only locally.
- **guardrails** — each planned online guardrail is in the request path (not stubbed).
- **tracing** — tracing configured and wrapping the actual AI calls.

Continue to score.
</step>

<step name="score">
Score deterministically — do NOT compute by hand:

```bash
REQ="${HOME}/.claude/nf-bin/eval-score.cjs"; [ -f "$REQ" ] || REQ="./bin/eval-score.cjs"
node "$REQ" --covered <covered> --total <D> --infra <tooling>,<dataset>,<cicd>,<guardrails>,<tracing> --json
```

Parse `coverage_score`, `infra_score`, `overall_score`, `verdict`, `quorum_recommended`. Use them verbatim.

**Fusion — borderline → quorum:** if `quorum_recommended` is true (the score sits within 5 points of a verdict boundary), the single-judge call is not trustworthy. Offer:

> Verdict {V} is **borderline** ({score}/100). Confirm with a multi-model second opinion? → `/nf:quorum` "Is the {feature} AI evaluation production-ready given: {dimension summary}?"

Continue to report.
</step>

<step name="report">
Write `${PHASE_DIR}/EVAL-REVIEW.md`:

```markdown
# EVAL-REVIEW — {feature}

**Overall:** {overall_score}/100  ·  **Verdict:** {verdict}{ (borderline — quorum-confirm) if flagged}
Coverage {coverage_score} · Infra {infra_score}

## Dimension coverage
| Dimension | Status | Evidence | Remediation (if not COVERED) |

## Infra
| Component | Status | Note |

## Remediation plan
1. {highest-leverage gap → concrete action}
```

Lead with the verdict, list every PARTIAL/MISSING with a concrete path to COVERED, and — if borderline — the quorum-confirm offer. Never recompute or override the tool's score. Read-only except writing EVAL-REVIEW.md.
</step>

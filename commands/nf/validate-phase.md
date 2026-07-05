---
name: nf:validate-phase
description: Adversarially fill a phase's validation gaps — generate failing-capable tests per uncovered requirement
argument-hint: "[phase]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Task
---

<objective>
Close the validation gaps in a completed phase's VALIDATION.md by spawning the `nf-nyquist-auditor` agent (adversarial FORCE stance: assume every gap is genuinely uncovered until a passing behavioral test proves the requirement is met — never "test file created = gap filled").

Ported from open-gsd/gsd-core's nyquist validate-phase and fused with nForma:
- **Formal-priority** — gaps for formally-modeled requirements (non-empty `formal_models`) are filled first, and their tests must exercise the invariant's behavior.
- **Impl bugs escalate to our remediation** — the auditor never edits implementation; a real impl bug is ESCALATED and tagged for `/nf:harden` or `/nf:solve`.
- Composes with `/nf:harden` — both generate failing-capable tests; nyquist audits requirement coverage, harden hardens against adversarial edges.

Output: an updated VALIDATION.md (gaps FILLED with green tests) + an ESCALATED list for real implementation bugs.
</objective>

<execution_context>
@~/.claude/nf/workflows/validate-phase.md
</execution_context>

<context>
Phase number: $ARGUMENTS (required). Reads `${PHASE_DIR}/${PADDED_PHASE}-VALIDATION.md`.
</context>

<process>
1. Read the phase's VALIDATION.md; extract the open validation gaps (requirements mapped to manual-only or no evidence).
2. Order gaps formal-priority first (cross-reference `.planning/formal/requirements.json`).
3. Spawn `nf-nyquist-auditor` with the gap batch; it generates + runs a behavioral test per gap (max 3 debug iterations), classifying FILLED / ESCALATED.
4. Update VALIDATION.md; surface ESCALATED impl bugs with a recommendation to run `/nf:harden ${PHASE}` or `/nf:solve`.
</process>

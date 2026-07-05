# Workflow: validate-phase

Adversarially close a completed phase's validation gaps by spawning the `nf-nyquist-auditor`. Ported from open-gsd/gsd-core's nyquist gate, fused with nForma's formal + harden layers.

<step name="load_gaps">
Resolve the phase and its VALIDATION.md.

```bash
PHASE="${ARGUMENTS}"
PINFO=$(node ~/.claude/nf/bin/nf-tools.cjs find-phase "${PHASE}" 2>/dev/null || true)
```

- Locate `${PHASE_DIR}/${PADDED_PHASE}-VALIDATION.md`. If it does not exist, report "no VALIDATION.md for phase ${PHASE} — run /nf:plan-phase (nyquist enabled) first" and stop.
- Parse the validation map: extract every gap — a requirement whose evidence is manual-only, missing, or a `test_fails` entry. Each gap: `{ gap_id, requirement, task_id, behavior, current_evidence }`.
- If there are no open gaps, report "validation complete — all requirements test-backed" and stop.

Continue to order_gaps.
</step>

<step name="order_gaps">
Order the gaps **formal-priority first**: cross-reference each gap's requirement ID against `.planning/formal/requirements.json`.

```bash
REQ="${HOME}/.claude/nf-bin/gap-analysis.cjs"; [ -f "$REQ" ] || REQ="./bin/gap-analysis.cjs"
node "$REQ" --phase "${PHASE}" --json 2>/dev/null || true
```

Any gap whose requirement has a non-empty `formal_models` (surfaced by gap-analysis as a HIGH item) goes to the front of the queue — a formally-pinned requirement with no test is the worst gap. Fail-open: if the formal data is unavailable, keep the VALIDATION.md order.

Continue to spawn_auditor.
</step>

<step name="spawn_auditor">
Spawn the `nf-nyquist-auditor` with the ordered gap batch.

Use the Task tool with `subagent_type="nf-nyquist-auditor"`. Pass the gaps in a `<gaps>` block and a `<required_reading>` block (the VALIDATION.md + the touched implementation/test files). The auditor generates one focused behavioral test per gap, runs it, debugs up to 3 iterations, and classifies each **FILLED** (green test) or **ESCALATED** (impl bug / unresolvable). It only ever writes tests, fixtures, and VALIDATION.md.

For a large gap set, batch (≤8 gaps per auditor spawn) and run batches in parallel.

Continue to report.
</step>

<step name="report">
Update VALIDATION.md with the auditor's results and present:

```
## Phase ${PHASE} validation — {filled}/{total} gaps filled

### FILLED (green behavioral tests)
- {requirement} — {test file} · {command}

### ESCALATED (implementation bugs — not the auditor's to fix)
- {requirement} — {reason}; last error: {error}
```

If any gaps ESCALATED, recommend the nForma remediation path: `/nf:harden ${PHASE}` (adversarial hardening loop) for behavioral edges, or `/nf:solve` for a detected residual. Never mark an escalated gap as filled, and never let the auditor weaken an assertion to make a test pass.
</step>

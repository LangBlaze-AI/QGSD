# Workflow: autonomous

Drive every remaining milestone phase to completion: **discuss → plan → execute → verify**, per phase, advancing automatically. Quorum-gated planning + formal/harden-gated verification. Pause only on real blockers. Ported from open-gsd/gsd-core's autonomous mode and fused with nForma's quorum + formal layers.

<step name="preflight">
Establish the run and the phase range.

```bash
STATE=$(node ~/.claude/nf/bin/nf-tools.cjs state 2>/dev/null || true)
ROADMAP=$(node ~/.claude/nf/bin/nf-tools.cjs roadmap analyze 2>/dev/null || true)
```

- Parse `$ARGUMENTS` for `--from N`, `--to N`, `--only N`, `--fully-auto`, `--interactive`.
- From `$ROADMAP.phases`, build the ordered list of **incomplete** phases — those whose `disk_status` is not `"complete"` (or `roadmap_complete` is false), sorted by `number`. Apply `--only N` (single phase), else `--from`/`--to` bounds, else all remaining incomplete phases.
- If the roadmap or state cannot be read, STOP with: `Cannot read roadmap/state — run /nf:progress to diagnose.` (never guess a phase range).
- If there are no incomplete phases: report "milestone already complete" and route to the milestone-close step.

Display the run plan:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► AUTONOMOUS RUN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Phases: {list}          Mode: {pause-before-execute | fully-auto}
 Gates:  plan=quorum · verify=formal+harden · pause-on-blocker
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Continue to phase_loop.
</step>

<step name="phase_loop">
For each phase P in the range, in order, run the sub-steps below. Do NOT parallelize phases — each depends on the prior phase's committed state.

**A. Discuss** — build context.
- `--interactive`: run `/nf:discuss-phase P` inline (ask the user the real questions).
- default: if a CONTEXT.md already exists for P, skip; otherwise run `/nf:discuss-phase P --auto` (answer from roadmap/requirements where confident; escalate genuine ambiguity as a blocker rather than guessing).

**B. Plan** — quorum-gated. Dispatch `/nf:plan-phase P` (planning already routes through the multi-LLM quorum). This also runs the plan:pre schema-gate and the plan:post gap-analysis. **If gap-analysis reports HIGH-priority gaps** (a requirement with a formal model but no plan), surface them and treat as a blocker unless the user waives — a formally-pinned requirement must not be silently skipped.

**C. Go/no-go** — unless `--fully-auto`, pause with a one-line summary of what will execute and wait for the user's go/no-go before any code changes. On `--fully-auto`, skip this pause (still honor the blocker protocol below).

**D. Execute** — dispatch `/nf:execute-phase P`. Use the Task tool to spawn (per the plan-phase note — never substitute a Skill/MCP tool call for a sub-agent).

**E. Verify (formal + adversarial gate)** — a phase is NOT done until all three pass:
  1. `/nf:verify-work P` — goal-backward verification.
  2. Formal check — run `run-formal-verify` on any models this phase touched; a reachable invariant violation is a blocker.
  3. `/nf:harden P` — adversarial hardening loop to convergence.
  If any gate fails: attempt one remediation pass (`/nf:solve` for a detected residual, or continue the `/nf:harden` loop). If it still fails, STOP and surface as a blocker — do NOT advance a failing phase.

**F. Advance** — on all-green, mark the phase complete and continue to the next P. Report a one-line phase summary (`Phase P ✓ — plan(quorum) · execute · verify(formal+harden)`).

Continue to milestone_close when the range is exhausted.
</step>

<step name="blocker_protocol">
A blocker is anything the loop cannot safely resolve on its own: a genuine ambiguity in discuss, a HIGH formal-gap the user hasn't waived, a failing verify/formal/harden gate after one remediation pass, a merge conflict, or any destructive/irreversible action.

On a blocker: STOP the loop, print `⏸ BLOCKED at Phase P — {reason}` with the concrete state and 2–3 options, and hand control back. Never force past a blocker, never force-push, never fabricate a passing verify.
</step>

<step name="milestone_close">
When all phases in the range are complete (and the range covers the milestone's remaining phases):
1. `/nf:audit-milestone` — cross-phase integration + coverage audit.
2. If the audit is clean, `/nf:complete-milestone`; otherwise surface the audit findings as a blocker.
3. `/nf:cleanup` — tidy worktrees/artifacts.

Report the final summary: phases completed, gates passed, anything deferred. Stop.
</step>

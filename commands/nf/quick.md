---
name: nf:quick
description: Execute a quick task with NF guarantees (atomic commits, state tracking) but skip optional agents
argument-hint: "[--full] [--delegate {slot}] [--audit {slot}] [--max-revisions {n}] [--force-quorum]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - AskUserQuestion
---
<objective>
Execute small, ad-hoc tasks with NF guarantees (atomic commits, STATE.md tracking).

Quick mode is the same system with a shorter path:
- Spawns nf-planner (quick mode) + nf-executor(s)
- Quick tasks live in `.planning/quick/` separate from planned phases
- Updates STATE.md "Quick Tasks Completed" table (NOT ROADMAP.md)

**Default:** Skips research, plan-checker, verifier. Use when you know exactly what to do.

**`--full` flag:** Single-phase rigor tier. Enables:
- Plan-checking (max 2 iterations) and post-execution verification
- Formal scope scan: discovers relevant `.planning/formal/spec/*/invariants.md` and injects invariant context into the planner
- Plan frontmatter must declare `formal_artifacts:` (none | update | create) with .planning/formal/ file targets
- Executor commits .planning/formal/ files atomically when `formal_artifacts` is non-empty
- Verifier checks invariant compliance and formal artifact syntax
- Quorum reviews VERIFICATION.md after passing (can downgrade to "Needs Review")

Use when you want quality guarantees with formal correctness properties, without full milestone ceremony.

**`--delegate {slot}` flag:** Delegates the entire task to a specific quorum slot (e.g., `codex-1`, `gemini-1`). The slot name is passed as a routing hint to PresetPolicy, which will prefer that slot if it is eligible (subprocess with file access). If the slot is ineligible, falls back to default routing.

**`--audit {slot}` flag:** (requires `--delegate`) Runs the delegated task through the **worker+auditor loop** (`bin/delegate-loop.cjs`): the `--delegate` slot is the worker (it keeps a resumable session across revisions), and the `--audit` slot is an INDEPENDENT auditor of a *different* model family that reviews each diff — APPROVE ends the step, REVISE sends the issues back to the same worker session (up to `--max-revisions`, default 2), BLOCK stops. Both must be session-capable families (`codex`, `claude`); otherwise it degrades to one-shot delegation. Example: `/nf:quick --delegate codex-1 --audit claude-1 "fix the off-by-one in paginate()"`.

**`--force-quorum` flag:** Forces quorum review even in non-full mode.
</objective>

<execution_context>
@~/.claude/nf/workflows/quick.md
</execution_context>

<context>
$ARGUMENTS

Context files are resolved inside the workflow (`init quick`) and delegated via `<files_to_read>` blocks.
</context>

<process>
Execute the quick workflow from @~/.claude/nf/workflows/quick.md end-to-end.
Preserve all workflow gates (validation, task description, planning, execution, state updates, commits).
</process>

## Verification Gap Auto-Proceed Override

**Scope:** Applies only during Step 6.5 of the NF quick workflow (post-execution verification, `$FULL_MODE` only). The `passed` and `human_needed` branches from the upstream workflow are unchanged.

### Rule: gaps_found — auto-fix loop (replaces pause-and-ask)

When Step 6.5 reaches `gaps_found` status, do NOT pause for user input and do NOT offer "accept as-is." Instead:

**1. Display:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► GAPS FOUND — AUTO-FIX
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Verification found gaps. Spawning fix executor...
```

**2. Initialize iteration counter:** `$GAP_FIX_ITERATION = 1`. Max iterations = 2.

**3. Spawn fix executor** with VERIFICATION.md and PLAN.md as context:

```
Task(
  prompt="
Fix gaps identified in verification.

<files_to_read>
- ${QUICK_DIR}/${next_num}-PLAN.md (Original plan)
- ${QUICK_DIR}/${next_num}-VERIFICATION.md (Gaps to fix)
- .planning/STATE.md (Project state)
</files_to_read>

<constraints>
- Address only the gaps listed in VERIFICATION.md
- Do not re-implement tasks already marked as passing
- Commit fixes atomically using nf-tools.cjs commit
- Return the fix commit hash in your response (format: 'Fix Commit: {hash}')
</constraints>
",
  subagent_type="nf-executor",
  model="{executor_model}",
  description="Fix gaps: ${DESCRIPTION}"
)
```

**4. After fix executor returns, run quorum-test to verify gaps are closed:**

Determine test scope from VERIFICATION.md artifacts. If test files exist (`*.test.js`, `*.test.ts`, etc.), call `/nf:quorum-test` with those files. If no test files are present (non-testable gaps), skip quorum-test and proceed directly to step 5 treating the result as PASS.

Evaluate quorum-test consensus:

| Verdict | Action |
|---------|--------|
| **PASS** | Gaps confirmed closed. Set `$VERIFICATION_STATUS = "Verified"`. Proceed to status update. |
| **REVIEW-NEEDED** | Treat as passing (gap closure confirmed, concerns noted). Set `$VERIFICATION_STATUS = "Verified (Review Noted)"`. Proceed to status update. |
| **BLOCK** | Gaps not resolved. If `$GAP_FIX_ITERATION < 2`, increment `$GAP_FIX_ITERATION` and repeat from step 3. |
| **ALL models UNAVAILABLE** | Escalate to human. Display the unavailable-models banner (see below). Wait for human response. |

**Unavailable-models banner:**

```
All quorum models unavailable — cannot verify gap closure automatically.
Please manually verify and type "verified" to continue, or "skip" to record as Needs Review.
```

Set `$VERIFICATION_STATUS` based on human response ("verified" → "Verified", "skip" → "Needs Review").

**5. If BLOCK after max iterations (2):** Set `$VERIFICATION_STATUS = "Gaps"`. Display:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► AUTO-FIX EXHAUSTED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Max fix iterations reached. Quorum still reports gaps.

Options:
1. Provide guidance and retry: describe the issue
2. Accept current state: type "accept"
```

Wait for human response.

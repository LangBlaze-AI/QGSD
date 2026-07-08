<purpose>
Execute small, ad-hoc tasks with nForma guarantees (atomic commits, STATE.md tracking). Quick mode spawns nf-planner (quick mode) + nf-executor(s), tracks tasks in `.planning/quick/`, and updates STATE.md's "Quick Tasks Completed" table.

With `--full` flag: enables plan-checking (max 2 iterations) and post-execution verification for quality guarantees without full milestone ceremony.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>
**Step 1: Parse arguments and get task description**

Parse `$ARGUMENTS` for:
- `--full` flag → store as `$FULL_MODE` (true/false)
- `--no-branch` flag → store as `$NO_BRANCH` (default: false)
- `--force-quorum` flag → store as `$FORCE_QUORUM` (default: false). Forces medium-or-higher quorum fan-out regardless of risk classifier output.
- `--delegate {slot-name}` flag → store as `$DELEGATE_SLOT` (string or null). The value is the next token after `--delegate`.
- `--audit {slot-name}` flag → store as `$AUDIT_SLOT` (string or null). The value is the next token after `--audit`. Opt-in worker+auditor loop for delegate mode (see Step 5D).
- `--max-revisions {n}` flag → store as `$MAX_REVISIONS` (integer or null). Max REVISE rounds in audited mode (default 2). Ignored unless `--audit` is set.
- Remaining text → use as `$DESCRIPTION` if non-empty

**Delegate flag validation:**
- If `--delegate` is present without a value (next token is missing or starts with `--`): error: "Error: --delegate requires a slot name (e.g., --delegate codex-1)"
- If `--delegate` and `--full` are both present: error: "Error: --delegate and --full cannot be used together. --delegate performs full delegation to the external agent."
- If `--audit` is present without `--delegate`: error: "Error: --audit requires --delegate (the auditor reviews the delegated worker's work)."
- If `--audit` is present without a value (next token missing or starts with `--`): error: "Error: --audit requires a slot name (e.g., --audit claude-1)."
- If `--audit` equals `--delegate`'s slot: warn "⚠ --audit slot equals the worker slot — the audit is not independent; prefer a different model family (e.g. worker codex-1, auditor claude-1)."

If `$DESCRIPTION` is empty after parsing, prompt user interactively:

```
AskUserQuestion(
  header: "Quick Task",
  question: "What do you want to do?",
  followUp: null
)
```

Store response as `$DESCRIPTION`.

If still empty, re-prompt: "Please provide a task description."

If `$FULL_MODE`:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► QUICK TASK (FULL MODE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Plan checking + verification enabled
```

If `$DELEGATE_SLOT`:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► QUICK TASK (DELEGATE MODE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Delegating to: ${DELEGATE_SLOT}
```

---

**Step 2: Initialize**

```bash
INIT=$(node ~/.claude/nf/bin/nf-tools.cjs init quick "$DESCRIPTION")
```

Parse JSON for: `planner_model`, `executor_model`, `checker_model`, `verifier_model`, `commit_docs`, `next_num`, `slug`, `date`, `timestamp`, `quick_dir`, `task_dir`, `roadmap_exists`, `planning_exists`, `current_branch`, `is_protected`, `quick_branch_name`, `protected_branches`.

**If `roadmap_exists` is false:** Error — Quick mode requires an active project with ROADMAP.md. Run `/nf:new-project` first.

Quick tasks can run mid-phase - validation only checks ROADMAP.md exists, not phase status.

---

**Step 2.5: Handle branching (smart default)**

Parse from init JSON: `current_branch`, `is_protected`, `quick_branch_name`, `protected_branches`.

**Branching logic:**

- If `$NO_BRANCH` is true: skip branching. Report "Branch creation skipped (--no-branch)."
- If `is_protected` is true AND `$NO_BRANCH` is false: run `git checkout -b "${quick_branch_name}"`. Report with a `::` prefix showing the protected branch and the created branch name. Store `$CREATED_BRANCH = quick_branch_name`.
- If `is_protected` is false: report "On feature branch ${current_branch} -- committing here." Store `$CREATED_BRANCH = null`.

---

**Step 2.7: Derive approach and write scope contract (INTENT-01, INTENT-02, INTENT-03)**

<!-- MUST_NOT_SKIP: This step is MANDATORY when $FULL_MODE is true. The orchestrator MUST spawn the 3 Haiku subagents (approach, classification, risk). Do NOT substitute your own judgment for "obvious" classifications. -->

This step is automatic (non-modal per INTENT-03). No user dialog or confirmation.

1. **Derive approach via Haiku subagent:**

Spawn a Haiku subagent to analyze the task description and derive a structured approach:

```
Task(
  subagent_type="general-purpose",
  model="haiku",
  description="Derive approach for quick task",
  prompt="
You are deriving a task scope contract from a quick task description.

## Task Description
${DESCRIPTION}

## Your Task
Analyze the description and produce a JSON object with:
{
  \"approach\": \"[One sentence: what will be done]\",
  \"out_of_scope\": [\"[item 1]\", \"[item 2]\", ...]
}

Guidelines:
- approach: One sentence, imperative voice, specific outcome
- out_of_scope: Literal items explicitly NOT in scope. Include at least 1-2 items.
- Be conservative — when uncertain, mark something as out-of-scope

Respond with ONLY the JSON object, no markdown fencing or extra text.
"
)
```

Parse the Haiku response as JSON. Store as `$APPROACH_BLOCK`.

**Fail-open:** If Haiku is unavailable, response is empty, or JSON parsing fails, use fallback:
```json
{
  "approach": "Complete the task as described",
  "out_of_scope": []
}
```

Log: `"Step 2.7: Approach derived — ${APPROACH_BLOCK.approach}"`
If fallback was used, log: `"Step 2.7: Approach derivation fell back to generic (Haiku unavailable or parse error)"`

1.5. **Classify task type via Haiku subagent (ROUTE-01):**

Spawn a Haiku subagent to classify the task:

```
Task(
  subagent_type="general-purpose",
  model="haiku",
  description="Classify quick task type",
  prompt="
You are classifying a development task into exactly one category.

## Task Description
${DESCRIPTION}

## Categories
- bug_fix: The task fixes a bug, error, regression, crash, or broken behavior. Signal words: fix, bug, error, broken, regression, crash, failing, wrong, incorrect, undefined, null, NaN, timeout, hang.
- feature: The task adds new functionality or capability. Signal words: add, implement, create, new, feature, enable, support, introduce.
- refactor: The task reorganizes, renames, cleans up, or simplifies existing code without changing behavior. Signal words: refactor, rename, reorganize, clean, simplify, extract, move, consolidate.

## Your Task
Respond with ONLY a JSON object:
{
  \"type\": \"bug_fix\" | \"feature\" | \"refactor\",
  \"confidence\": 0.0-1.0
}

Guidelines:
- Choose the SINGLE best category. When mixed signals exist, choose the primary intent.
- Confidence: 0.9+ for clear signals, 0.7-0.9 for moderate signals, below 0.7 for ambiguous.
- Respond with ONLY the JSON object, no markdown fencing or extra text.
"
)
```

Parse the Haiku response as JSON. Store as `$CLASSIFICATION`.

**Fail-open:** If Haiku is unavailable, response is empty, or JSON parsing fails, use fallback:
```json
{
  "type": "feature",
  "confidence": 0.0
}
```

Log: `"Step 2.7: Task classified as ${CLASSIFICATION.type} (confidence: ${CLASSIFICATION.confidence})"`
If fallback was used, log: `"Step 2.7: Classification fell back to feature (Haiku unavailable or parse error)"`

Store `$CLASSIFICATION` for use in scope contract write (sub-step 2) and routing (Step 5.8 in Plan 51-02).

1.7. **Classify task risk level via Haiku subagent:**

Spawn a Haiku subagent to assess quorum fan-out risk:

```
Task(
  subagent_type="general-purpose",
  model="haiku",
  description="Classify risk level for quick task",
  prompt="
You are a risk classifier for a code change task. Analyze the signals below and output a risk level.

## Task Description
${DESCRIPTION}

## Approach (from prior classification)
${APPROACH_BLOCK.approach}

## Task Type
${CLASSIFICATION.type}

## Risk Signals

LOW risk (ALL must be true):
- 1 file touched
- Task type is rename, typo, config, or version-bump
- No requirements affected
- Estimated diff < ~20 lines

HIGH risk (ANY one is sufficient):
- Formal model files touched (.tla, .cfg, invariants.md, requirements.json)
- Multi-phase plan or cross-phase dependency
- New requirement added or existing requirement modified
- Hook or installer files changed (hooks/, bin/install.js)
- 5+ files across multiple directories

MEDIUM risk:
- Everything else (this is the default)

## GUARDRAILS (never classify as low)
The following MUST be classified as medium or high, never low:
- Changes to ROADMAP.md, STATE.md, or any .planning/formal/ files
- Changes to hooks/ or bin/install.js (installer)
- Changes to workflow files (core/workflows/, commands/)
- Any task that adds, modifies, or removes a requirement

## IMPORTANT
- Bias toward caution: if uncertain between low and medium, choose medium
- Bias toward caution: if uncertain between medium and high, choose high
- False-high is acceptable; false-low is dangerous

Output a JSON object:
{
  \"risk_level\": \"low\" | \"medium\" | \"high\",
  \"reason\": \"[One sentence explaining the classification]\"
}
"
)
```

Parse the Haiku response as JSON. Extract `risk_level` and `reason`.

**Fail-open fallback** (if Haiku is unavailable or JSON parse fails):
```json
{
  "risk_level": "medium",
  "reason": "Risk classification fell back to medium (Haiku unavailable or parse error)"
}
```

Note: fail-open defaults to medium (not low) — this is intentional caution bias.

**--force-quorum override:** After classification, if `$FORCE_QUORUM` is true AND `risk_level` is "low", override to "medium". Log: `"Step 2.7: --force-quorum active — overriding risk_level from low to medium"`

Store as `$RISK_LEVEL` and `$RISK_REASON`.

Log: `"Step 2.7: Risk classified as ${RISK_LEVEL} (${RISK_REASON})"`
If fallback was used, log: `"Step 2.7: Risk classification fell back to medium (Haiku unavailable or parse error)"`

Store `$RISK_LEVEL` for use in Step 5.7 (quorum fan-out). The risk_level determines how many external quorum slots are dispatched.

2. **Write scope contract to task directory (INTENT-02):**

Determine the branch name: use `$CREATED_BRANCH` if set (from Step 2.5), otherwise use `$current_branch`.

Write the scope contract directly to the task directory (created in Step 3):
`${task_dir}/scope-contract.json`

Note: Step 3 creates `${task_dir}` — if it doesn't exist yet, create it now with `mkdir -p`.

```json
{
  "${branch_name}": {
    "task_id": ${next_num},
    "task_description": "${DESCRIPTION}",
    "approach": "${APPROACH_BLOCK.approach}",
    "out_of_scope": [${APPROACH_BLOCK.out_of_scope items as JSON array}],
    "classification": {
      "type": "${CLASSIFICATION.type}",
      "confidence": ${CLASSIFICATION.confidence},
      "routed_through_debug": false
    },
    "risk_level": "${RISK_LEVEL}",
    "risk_reason": "${RISK_REASON}",
    "branches_affected": ["${branch_name}"],
    "created_at": "${timestamp}",
    "planner_model": "${planner_model}",
    "created_by": "quick-orchestrator"
  }
}
```

Each task gets its own scope-contract.json — no merge logic needed.

**Fail-open:** If the write fails (permission error, disk full), log a warning and proceed.

Log: `"Step 2.7: Scope contract written to ${task_dir}/scope-contract.json (key: ${branch_name}, type: ${CLASSIFICATION.type})"`

3. **Store APPROACH_BLOCK for planner context:**

Store `$APPROACH_BLOCK` for use in Step 5 (planner spawn). The planner prompt in Step 5 must include the approach block so the planner knows the declared scope.

---

**Step 2.75: Repowise Context Packing**

Pack Repowise intelligence context for the quick task. This provides hotspot risk data and co-change coupling to the planner, enabling risk-aware task planning.

```bash
REPOWISE_CONTEXT=""
if command -v node >/dev/null 2>&1; then
  REPOWISE_CONTEXT=$(node ~/.claude/nf-bin/context-packer.cjs --hotspot --cochange --project-root="$(pwd)" 2>/dev/null || node bin/repowise/context-packer.cjs --hotspot --cochange --project-root="$(pwd)" 2>/dev/null || echo "")
fi
```

Fail-open: if the script is not found, errors, or returns empty, skip silently. `$REPOWISE_CONTEXT` stays empty and the planner proceeds without Repowise context.

Store `$REPOWISE_CONTEXT` for use in Step 5 (planner spawn).

---

**Step 2.8: Validate delegate slot (only when `$DELEGATE_SLOT` is set)**

Skip this step if `$DELEGATE_SLOT` is null.

1. Read `bin/providers.json`, parse the `providers` array.
2. Find the entry where `name === $DELEGATE_SLOT`.
3. If not found: error listing valid subprocess slot names:
   ```
   Error: Unknown slot '${DELEGATE_SLOT}'. Available subprocess slots: codex-1, gemini-1, opencode-1, copilot-1, ...
   ```
   (List all entries from providers.json where `type === 'subprocess'`.)
4. If found but `type !== 'subprocess'` OR `has_file_access !== true`: error:
   ```
   Error: Slot '${DELEGATE_SLOT}' is not a file-access subprocess provider. Delegation requires a full CLI agent.
   ```
5. Store the validated slot as `$VALIDATED_DELEGATE_SLOT`.

Log: `"Step 2.8: Delegate slot validated — ${VALIDATED_DELEGATE_SLOT}"`

---

**Step 3: Create task directory**

```bash
mkdir -p "${task_dir}"
```

---

**Step 4: Create quick task directory**

Create the directory for this quick task:

```bash
QUICK_DIR=".planning/quick/${next_num}-${slug}"
mkdir -p "$QUICK_DIR"
```

Report to user:
```
Creating quick task ${next_num}: ${DESCRIPTION}
Directory: ${QUICK_DIR}
```

Store `$QUICK_DIR` for use in orchestration.

---

**Step 4.5: Formal scope scan (only when `$FULL_MODE`)**

<!-- MUST_NOT_SKIP: This step is MANDATORY when $FULL_MODE is true. Skipping this step violates the --full contract. If tooling is missing, log a WARNING and continue -- but do NOT silently omit the step. -->

Skip this step entirely if NOT `$FULL_MODE`.

```bash
FORMAL_SPEC_CONTEXT=()
if [ -d ".planning/formal/spec" ]; then
  # Use centralized semantic matching via scope.json metadata
  while IFS=$'\t' read -r mod modpath; do
    FORMAL_SPEC_CONTEXT+=("{\"module\":\"$mod\",\"path\":\"$modpath\"}")
  done < <(node bin/formal-scope-scan.cjs --description "$DESCRIPTION" --no-l3 --format lines)
  MATCH_COUNT=${#FORMAL_SPEC_CONTEXT[@]}
  if [ "$MATCH_COUNT" -gt 0 ]; then
    MATCHED_MODULES=$(printf '%s\n' "${FORMAL_SPEC_CONTEXT[@]}" | node --input-type=module -e "
      import { readFileSync } from 'fs';
      const lines = readFileSync('/dev/stdin','utf8').trim().split('\n');
      console.log(lines.map(l=>JSON.parse(l).module).join(', '));
    ")
    echo ":: Formal scope scan: found ${MATCH_COUNT} module(s): ${MATCHED_MODULES}"
  else
    echo ":: Formal scope scan: no modules matched (fail-open)"
  fi
fi
```

Matching uses exact concept tokens from each module's `scope.json` (no substring matching). Examples:
- Description "fix quorum deliberation bug" → modules matching: `quorum`, `deliberation`
- Description "update TUI navigation flow" → modules matching: `tui-nav`
- Description "refactor breaker circuit logic" → modules matching: `breaker`

Store `$FORMAL_SPEC_CONTEXT` for use in steps 5, 5.5, 6.5.

---

**If `$DELEGATE_SLOT` is set:** Skip Steps 5, 5.5, 5.7, 5.8, 6, 6.3, 6.5, 6.7. Instead, execute the delegate branch (Steps 5D and 6D) below, then jump to the completion banner.

Step 4.5 (formal scope scan) is also skipped for delegate mode — the external agent handles its own formal checks.

---

**Step 5D: Dispatch to external agent via Mode C (only when `$DELEGATE_SLOT` is set)**

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► DELEGATING TO ${DELEGATE_SLOT}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Task: ${DESCRIPTION}
  Repo: $(pwd)
  Timeout: 300000ms
```

Build the delegation prompt using the `buildCodingPrompt` format from `bin/coding-task-router.cjs`. The task description should include:
- The original `$DESCRIPTION`
- The derived approach from `$APPROACH_BLOCK.approach`
- Instruction: "You are a full Claude Code instance with nForma installed. Execute this task completely: implement, test, and commit. Return your result in the structured format."

Dispatch via CLI. When `$AUDIT_SLOT` is set (from `--audit {slot}`), pass `--audit "${AUDIT_SLOT}"` so the task runs through the **worker+auditor loop** (`bin/delegate-loop.cjs`): the worker keeps a resumable session across revisions, and an INDEPENDENT auditor (the `--audit` slot, a different model family) reviews each diff — APPROVE ends the step, REVISE sends the issues back to the same worker session (up to `--max-revisions`, default 2), BLOCK stops. Both slots must be session-capable families (`codex`, `claude`); otherwise the loop degrades to the one-shot path automatically.

```bash
DELEGATE_RESULT=$(node bin/coding-task-router.cjs \
  --slot "${VALIDATED_DELEGATE_SLOT}" \
  --task "${DESCRIPTION}. Approach: ${APPROACH_BLOCK.approach}. You are a full Claude Code instance with nForma installed. Execute this task completely: implement, test, and commit. Return your result in the structured format." \
  --cwd "$(pwd)" \
  ${AUDIT_SLOT:+--audit "${AUDIT_SLOT}"} \
  ${MAX_REVISIONS:+--max-revisions "${MAX_REVISIONS}"} \
  --timeout 300000 2>&1)
DELEGATE_EXIT=$?
```

Parse the JSON result. Extract: `status`, `filesModified`, `summary`, `latencyMs`. In audited mode the result also carries `audit_verdict`, `audit_issues`, `revisions`, and `worker_session` — surface `audit_verdict` + `revisions` in the banner and record them in Step 6D.

**Route on status:**

| Status | Action |
|--------|--------|
| SUCCESS | Display success banner, proceed to Step 6D (recording) |
| PARTIAL | Display partial banner with summary, proceed to Step 6D (recording) |
| FAILED | Display failure with summary, proceed to Step 6D (recording — do NOT retry) |
| UNAVAIL | Display error: "Slot ${DELEGATE_SLOT} is unavailable: ${summary}". Proceed to Step 6D (recording) |

---

**Step 6D: Record delegate result (only when `$DELEGATE_SLOT` is set)**

1. Create `${QUICK_DIR}/${next_num}-SUMMARY.md` with delegate-specific template:

```markdown
# Quick Task ${next_num} Summary (Delegated)

## Task
${DESCRIPTION}

## Delegation
- Slot: ${VALIDATED_DELEGATE_SLOT}
- Status: ${status}
- Latency: ${latencyMs}ms
- Files modified: ${filesModified.join(', ') || 'none reported'}

## Result
${summary}
```

2. Update STATE.md "Quick Tasks Completed" table with status mapped from delegate result:
   - SUCCESS -> "Delegated (OK)"
   - PARTIAL -> "Delegated (Partial)"
   - FAILED -> "Delegated (Failed)"
   - UNAVAIL -> "Delegated (Unavail)"

3. Commit PLAN.md + SUMMARY.md + STATE.md atomically:
```bash
node ~/.claude/nf/bin/nf-tools.cjs commit "docs(quick-${next_num}): delegate ${DESCRIPTION}" \
  --files ${QUICK_DIR}/${next_num}-PLAN.md ${QUICK_DIR}/${next_num}-SUMMARY.md .planning/STATE.md
```

4. Display completion banner:
```
---

nForma > QUICK TASK COMPLETE (DELEGATED)

Quick Task ${next_num}: ${DESCRIPTION}
Delegated to: ${VALIDATED_DELEGATE_SLOT}
Status: ${status}
Latency: ${latencyMs}ms
Summary: ${QUICK_DIR}/${next_num}-SUMMARY.md
Commit: ${commit_hash}
Branch: ${CREATED_BRANCH || current_branch}
${CREATED_BRANCH ? '-> Ready for PR' : ''}

---

Ready for next task: /nf:quick
```

5. Run: `node ~/.claude/nf/bin/nf-tools.cjs activity-clear`

**Important implementation notes:**
- Steps 2 (init), 2.5 (branching), 2.7 (scope contract), 2.8 (slot validation), 3 (task dir), 4 (quick dir) all still run for delegate mode. This ensures local tracking is preserved.
- Step 4.5 (formal scope scan) is skipped for delegate mode (the external agent handles its own formal checks).
- Step 5.7 (quorum review of plan) is skipped because there is no local plan to review — the external agent does its own planning.
- The delegate branch terminates with the completion banner — there is no shared post-Step-6 cleanup to rejoin.

**Invariant compliance:**
- EventualConsensus (quorum): Not violated — quorum is skipped because there is no local plan artifact to review. The delegate is a full agent that runs its own quorum if needed.
- RouteCLiveness (planningstate): Not affected — delegate mode creates STATE.md entries just like normal mode.
- No direct MCP calls are made — delegation goes through `coding-task-router.cjs` which uses `call-quorum-slot.cjs` subprocess dispatch (R3.2 compliant).

---

**Step 5: Spawn planner (quick mode)**

<!-- MUST_NOT_SKIP: This step is MANDATORY. The orchestrator MUST spawn the nf-planner subagent. Do NOT write code directly — the planner creates the plan, the executor implements it. Skipping this step collapses the plan-execute separation that makes verification possible. -->

**If `$FULL_MODE`:** Use `quick-full` mode with stricter constraints.

**If NOT `$FULL_MODE`:** Use standard `quick` mode.

```bash
node ~/.claude/nf/bin/nf-tools.cjs activity-set \
  "{\"activity\":\"quick\",\"sub_activity\":\"planning\"}"
```

```
Task(
  prompt="
<planning_context>

**Mode:** ${FULL_MODE ? 'quick-full' : 'quick'}
**Directory:** ${QUICK_DIR}
**Description:** ${DESCRIPTION}

**Approach (auto-derived, INTENT-01):**
- What: ${APPROACH_BLOCK.approach}
- Out of scope: ${APPROACH_BLOCK.out_of_scope.join(', ')}

<files_to_read>
- .planning/STATE.md (Project State)
- ./CLAUDE.md (if exists — follow project-specific guidelines)
${FORMAL_SPEC_CONTEXT.length > 0 ? FORMAL_SPEC_CONTEXT.map(f => `- ${f.path} (Formal invariants for module: ${f.module})`).join('\n') : ''}
</files_to_read>

**Project skills:** Check .agents/skills/ directory (if exists) — read SKILL.md files, plans should account for project skill rules

<formal_context>
${FORMAL_SPEC_CONTEXT.length > 0 ?
`Relevant formal modules identified: ${FORMAL_SPEC_CONTEXT.map(f => f.module).join(', ')}

Constraints:
- Read the injected invariants.md files and identify which invariants apply to this task
- Declare \`formal_artifacts:\` in plan frontmatter (required field when FORMAL_SPEC_CONTEXT is non-empty):
  - \`none\` — task does not create or modify .planning/formal/ files
  - \`update: [list of .planning/formal/ file paths]\` — task modifies existing .planning/formal/ files
  - \`create: [list of {path, type (tla|alloy|prism), description}]\` — task creates new .planning/formal/ files
- Plan tasks MUST NOT violate the identified invariants` :
`No existing formal modules matched this task. Evaluate whether this task introduces logic that warrants a NEW formal model:
- Does it add logic with 3+ distinct states and conditional transitions? (state machine candidate)
- Does it introduce invariants or safety properties that should be formally verified?
- Does it add a new subsystem with correctness requirements?

If YES to any: declare \`formal_artifacts: create\` with specific file paths, types (tla|alloy|prism), and descriptions.
If NO: declare \`formal_artifacts: none\`.

The \`formal_artifacts:\` field is REQUIRED in plan frontmatter regardless of FORMAL_SPEC_CONTEXT.`}
</formal_context>

</planning_context>

<constraints>
- Create a SINGLE plan with 1-3 focused tasks
- Quick tasks should be atomic and self-contained
- No research phase
${FULL_MODE ? '- Target ~40% context usage (structured for verification)' : '- Target ~30% context usage (simple, focused)'}
${FULL_MODE ? '- MUST generate `must_haves` in plan frontmatter (truths, artifacts, key_links)' : ''}
${FULL_MODE ? '- Each task MUST have `files`, `action`, `verify`, `done` fields' : ''}
</constraints>

<output>
Write plan to: ${QUICK_DIR}/${next_num}-PLAN.md
Return: ## PLANNING COMPLETE with plan path
</output>
",
  subagent_type="nf-planner",
  model="{planner_model}",
  description="Quick plan: ${DESCRIPTION}"
)
```

After planner returns:
1. Verify plan exists at `${QUICK_DIR}/${next_num}-PLAN.md`
2. Extract plan count (typically 1 for quick tasks)
3. Report: "Plan created: ${QUICK_DIR}/${next_num}-PLAN.md"

If plan not found, error: "Planner failed to create ${next_num}-PLAN.md"

---

**Step 5.5: Plan-checker loop (only when `$FULL_MODE`)**

<!-- MUST_NOT_SKIP: This step is MANDATORY when $FULL_MODE is true. The orchestrator MUST spawn the plan-checker subagent. Do NOT skip because "the plan looks fine" — the checker catches issues the planner misses. -->

Skip this step entirely if NOT `$FULL_MODE`.

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► CHECKING PLAN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning plan checker...
```

Checker prompt:

```markdown
<verification_context>
**Mode:** quick-full
**Task Description:** ${DESCRIPTION}

<files_to_read>
- ${QUICK_DIR}/${next_num}-PLAN.md (Plan to verify)
${FORMAL_SPEC_CONTEXT.map(f => `- ${f.path} (Formal invariants for module: ${f.module})`).join('\n')}
</files_to_read>

**Scope:** This is a quick task, not a full phase. Skip checks that require a ROADMAP phase goal.
</verification_context>

<check_dimensions>
- Requirement coverage: Does the plan address the task description?
- Task completeness: Do tasks have files, action, verify, done fields?
- Key links: Are referenced files real?
- Scope sanity: Is this appropriately sized for a quick task (1-3 tasks)?
- must_haves derivation: Are must_haves traceable to the task description?
- Formal artifacts (--full only): If `formal_artifacts` is `update` or `create`, are the target file paths well-specified (not vague)?
- Invariant compliance (--full only): Do plan tasks avoid operations that would violate the invariants identified in the formal context? (If `$FORMAL_SPEC_CONTEXT` is empty, skip this check.)

Skip: context compliance (no CONTEXT.md), cross-plan deps (single plan), ROADMAP alignment
</check_dimensions>

<formal_context>
${FORMAL_SPEC_CONTEXT.length > 0 ? `Relevant formal modules: ${FORMAL_SPEC_CONTEXT.map(f => f.module).join(', ')}. Check plan formal_artifacts declaration and invariant compliance.` : 'No formal modules matched. If plan declares formal_artifacts: none, that is valid. If plan declares formal_artifacts: create, validate that file paths and types are well-specified.'}
</formal_context>

<expected_output>
- ## VERIFICATION PASSED — all checks pass
- ## ISSUES FOUND — structured issue list
</expected_output>
```

```
Task(
  prompt=checker_prompt,
  subagent_type="nf-plan-checker",
  model="{checker_model}",
  description="Check quick plan: ${DESCRIPTION}"
)
```

**Handle checker return:**

- **`## VERIFICATION PASSED`:** Display confirmation, proceed to step 6.
- **`## ISSUES FOUND`:** Display issues, check iteration count, enter revision loop.

**Revision loop (max 2 iterations):**

Track `iteration_count` (starts at 1 after initial plan + check).

**If iteration_count < 2:**

Display: `Sending back to planner for revision... (iteration ${N}/2)`

Revision prompt:

```markdown
<revision_context>
**Mode:** quick-full (revision)

<files_to_read>
- ${QUICK_DIR}/${next_num}-PLAN.md (Existing plan)
</files_to_read>

**Checker issues:** ${structured_issues_from_checker}

</revision_context>

<instructions>
Make targeted updates to address checker issues.
Do NOT replan from scratch unless issues are fundamental.
Return what changed.
</instructions>
```

```
Task(
  prompt="First, read ~/.claude/agents/nf-planner.md for your role and instructions.\n\n" + revision_prompt,
  subagent_type="general-purpose",
  model="{planner_model}",
  description="Revise quick plan: ${DESCRIPTION}"
)
```

After planner returns → spawn checker again, increment iteration_count.

**If iteration_count >= 2:**

Display: `Max iterations reached. ${N} issues remain:` + issue list

Offer: 1) Force proceed, 2) Abort

---

**Step 5.7: Quorum review of plan with R3.6 (required by R3.1 + R3.6)**

<!-- MUST_NOT_SKIP: This step is MANDATORY regardless of mode (R3.1). The orchestrator MUST dispatch quorum slot-workers. Do NOT skip because "quorum slots are probably unavailable" or "the plan already passed the checker" — quorum catches different issues than the checker. If all slots are UNAVAIL, the fail-open path handles it. -->

This step is MANDATORY regardless of `--full` mode. R3.1 requires quorum for any planning output from `/nf:quick`. R3.6 wraps this in an improvement-iteration loop (up to 10 iterations).

Initialize: `improvement_iteration = 0`, `$QUORUM_BLOCK_COUNT = 0`, `$ALL_BLOCK_REASONS = []`

**LOOP** (while `improvement_iteration <= 10`):

Form your ADVISORY position on the current plan (per CE-1 from quorum.md, your position is context for external voters — NOT a vote in the tally). State your analysis as 1-2 sentences. This is shared with external voters to inform their independent decisions.

**Quorum preflight (use scripts — do NOT write inline `node -e` commands):**

```bash
# Get all quorum config in one call
PREFLIGHT=$(node "$HOME/.claude/nf-bin/quorum-preflight.cjs" --all)
# → { "quorum_active": [...], "max_quorum_size": 3, "team": { "slot-name": { "model": "...", "quorum_timeout_ms": 300000, "idle_timeout_ms": 90000 }, ... } }
```

Parse `PREFLIGHT` JSON to get `$MAX_QUORUM_SIZE`, the list of active slot names (keys of `team` object), and build `$SLOT_TIMEOUTS` map from each slot's `quorum_timeout_ms` field (used as `timeout_ms` in dispatch YAML).

Use `$RISK_LEVEL` from Step 2.7 risk classification (defaults to "medium" if not set). Compute fan-out:

```
case "$RISK_LEVEL" in
  low)      FAN_OUT_COUNT=1 ;;    # Self only — quorum SKIPPED
  medium)   FAN_OUT_COUNT=3 ;;    # 2 external + self
  high)     FAN_OUT_COUNT=5 ;;    # 4 external + self
  *)        FAN_OUT_COUNT=3 ;;    # fail-open: unknown -> medium
esac
```

**If FAN_OUT_COUNT = 1 (low risk — quorum SKIPPED):**
- Do NOT dispatch any external quorum slot-workers
- Do NOT run preflight team capture, deliberation, or scoreboard init
- Emit audit log (see below) and skip directly to Step 5.8 (or Step 6 if 5.8 is skipped)
- Note: EventualConsensus and ProtocolTerminates invariants do not apply when quorum is skipped (no quorum protocol runs)

**If FAN_OUT_COUNT >= 3:**
- Apply cap: `$DISPATCH_LIST` = first `FAN_OUT_COUNT - 1` slot names from `team` keys
- If available slots < `FAN_OUT_COUNT - 1`: use all available (emit FAN-05 reduced-quorum note per quorum-dispatch.md Section 3)
- Proceed with standard quorum dispatch below

**Audit logging (when quorum is reduced or skipped):**

If `FAN_OUT_COUNT < $MAX_QUORUM_SIZE` OR `FAN_OUT_COUNT = 1`, emit:

```
[AUDIT] Quorum fan-out adjusted
  risk_level: ${RISK_LEVEL}
  risk_reason: ${RISK_REASON}
  fan_out_count: ${FAN_OUT_COUNT}
  max_quorum_size: ${MAX_QUORUM_SIZE}
  action: ${FAN_OUT_COUNT == 1 ? "SKIPPED (low risk — self only)" : "REDUCED (${FAN_OUT_COUNT}/${MAX_QUORUM_SIZE} participants)"}
  force_quorum: ${FORCE_QUORUM}
  timestamp: ${ISO 8601 timestamp}
```

This audit trail ensures that every quorum reduction or skip is traceable. The log is emitted to stdout (visible in Claude session output).

**If FAN_OUT_COUNT = 1:** Skip the rest of Step 5.7 and proceed to Step 5.8.

Run quorum inline — follow the canonical protocol in @core/references/quorum-dispatch.md:
- Mode A — artifact review (plan is pre-execution; no traces to pass)
- artifact_path: `${QUICK_DIR}/${next_num}-PLAN.md`
- review_context: "This is a pre-execution task plan. The code does not exist yet. Evaluate whether the task breakdown is atomic, safe to execute, and correctly addresses the objective — not whether the implementation already exists."
- request_improvements: true          ← R3.6 signal infrastructure
- **Exact YAML format for worker prompts** (from reference section 4):
  ```yaml
  slot: <slotName>
  round: <round_number>
  timeout_ms: <from $SLOT_TIMEOUTS or 300000>
  repo_dir: <absolute path to project root>
  mode: A
  question: <question text>
  artifact_path: ${QUICK_DIR}/${next_num}-PLAN.md
  review_context: "This is a pre-execution task plan..."
  request_improvements: true
  prior_positions: |
    [included from Round 2 onward]
  ```
- Dispatch `$DISPATCH_LIST` as sibling `nf-quorum-slot-worker` Tasks with `model="haiku", max_turns=100`
- Deliberate up to 10 rounds per R3.3
- **FALLBACK-01 required:** If ANY dispatched slot returns UNAVAIL, follow the tiered fallback protocol from @core/references/quorum-dispatch.md §6 before evaluating consensus. Dispatch T1 (flat-rate CLI, `auth_type=sub`) then T2 (pay-per-use API) unused slots from the preflight `available_slots` list. Complete the FALLBACK_CHECKPOINT before proceeding.

Fail-open: if all slots AND all fallback tiers are exhausted (UNAVAIL), note it and proceed — same as R6 policy.

After quorum returns, extract the improvements signal from your own output:

Scan for the HTML comment block in the quorum response:
```
<!-- QUORUM_IMPROVEMENTS_START
[...]
QUORUM_IMPROVEMENTS_END -->
```
Extract the text between `QUORUM_IMPROVEMENTS_START` and `QUORUM_IMPROVEMENTS_END`, trim whitespace, and parse as a JSON array. Store as `$QUORUM_IMPROVEMENTS`.

**Do NOT summarize or paraphrase the JSON — extract the exact text between the delimiters.**

If the signal is absent, the delimiters don't match, or JSON.parse would fail: set `$QUORUM_IMPROVEMENTS = []` (fail-open — R3.6 does not fire).

**Route:**

- **BLOCKED** → Increment `$QUORUM_BLOCK_COUNT`. Append the full block reason text to `$ALL_BLOCK_REASONS`.

  If `$QUORUM_BLOCK_COUNT >= 3`:
    Display:
    ```
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     nForma ► R3.6 CONVERGENCE REWRITE (block count: ${QUORUM_BLOCK_COUNT})
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    ```

    Collect all BLOCK reasons from `$ALL_BLOCK_REASONS` (accumulated across all previous rounds).
    Spawn a fresh planner with the original task description AND all accumulated BLOCK reasons as hard constraints:

    ```
    Task(
      prompt="First, read ~/.claude/agents/nf-planner.md for your role and instructions.\n\n
      <revision_context>
      Mode: convergence-rewrite (R3.6 fresh rewrite after ${QUORUM_BLOCK_COUNT} BLOCK rounds)

      <files_to_read>
      - ${QUICK_DIR}/${next_num}-PLAN.md (current plan — read for context, then replace)
      </files_to_read>

      <accumulated_blocks>
      ${ALL_BLOCK_REASONS formatted as a numbered list}
      </accumulated_blocks>

      <instructions>
      The quorum has blocked ${QUORUM_BLOCK_COUNT} times. Incremental patching is not working.
      Rewrite the plan from scratch using the original task description as the goal.
      Every item in accumulated_blocks is a HARD CONSTRAINT — the new plan must not repeat these issues.
      Return ## PLANNING COMPLETE when done.
      </instructions>
      </revision_context>",
      subagent_type="nf-planner",
      model="{planner_model}",
      description="Convergence rewrite after ${QUORUM_BLOCK_COUNT} BLOCKs: ${DESCRIPTION}"
    )
    ```

    After planner returns, reset `$QUORUM_BLOCK_COUNT = 0` and `improvement_iteration = 0`. Continue loop (do NOT break).

  Else (block count < 3):
    Report the blocker to the user. A BLOCK from any external voter is absolute (CE-2) — do NOT override or rationalize it away. Do not execute. **Break loop.**

- **ESCALATED** → Present the escalation to the user. Do not execute until resolved. **Break loop.**

- **APPROVED AND ($QUORUM_IMPROVEMENTS is empty OR improvement_iteration >= 10)**:
    Include `<!-- nForma_DECISION -->` in your response summarizing quorum results.
    If `improvement_iteration > 0`: note "R3.6: ${improvement_iteration} iteration(s) ran."
    If `improvement_iteration >= 10` AND improvements remained: note
      "R3.6 cap reached — improvements not incorporated."
    Proceed to Step 6. **Break loop.**

- **APPROVED AND $QUORUM_IMPROVEMENTS non-empty AND improvement_iteration < 10**:
    `improvement_iteration += 1`

    Display:
    ```
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     nForma ► QUICK TASK — R3.6 improvements (${improvement_iteration}/10)
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    ```

    List each improvement: `• <model>: <suggestion> — <rationale>`

    Display: `Sending improvements to planner...`

    Conflict check: if two improvements are mutually incompatible, escalate to user before
    spawning planner. Await user resolution, then filter improvements to the chosen set.

    Spawn planner in improvement-revision mode:

    ```
    Task(
      prompt="First, read ~/.claude/agents/nf-planner.md for your role and instructions.\n\n
      <revision_context>
      Mode: improvement-revision (R3.6 iteration ${improvement_iteration}/10)

      <files_to_read>
      - ${QUICK_DIR}/${next_num}-PLAN.md (current plan to revise)
      </files_to_read>

      <quorum_improvements>
      ${QUORUM_IMPROVEMENTS formatted as readable bullet list}
      </quorum_improvements>

      <instructions>
      Incorporate the quorum improvements above into the plan.
      Make targeted updates only. Do NOT replan from scratch.
      Return a summary of what changed.
      </instructions>
      </revision_context>",
      subagent_type="general-purpose",
      model="{planner_model}",
      description="R3.6 improvements (iteration ${improvement_iteration})"
    )
    ```

    After planner returns:
    - **If planner returns `## PLANNING COMPLETE` or equivalent success:** plan at
      `${QUICK_DIR}/${next_num}-PLAN.md` is updated. Continue loop.
    - **If planner returns `## PLANNING INCONCLUSIVE` or fails to update the file:**
      Do NOT loop again on the same improvements. Display:
      > "R3.6: planner could not incorporate improvements in iteration ${improvement_iteration}. Proceeding with current plan."
      Include `<!-- nForma_DECISION -->` summarizing quorum results. Proceed to Step 6. **Break loop.**

**END LOOP**

---

**Step 5.8: Debug routing (ROUTE-02, ROUTE-03)**

<!-- MUST_NOT_SKIP: When classification is bug_fix with confidence >= 0.7, this step is MANDATORY. The orchestrator MUST spawn /nf:debug. Do NOT skip because "I already understand the bug" — the debug pipeline extracts formal constraints that the executor needs. If the subagent errors or times out, the fail-open path handles it. -->

Route bug_fix tasks through /nf:debug before execution. Feature and refactor tasks skip this step entirely.

**Skip if:** `$CLASSIFICATION.type` is NOT `bug_fix`, OR `$CLASSIFICATION.confidence` is below 0.7.

If skipped, log: `"Step 5.8: Skipping debug routing (type: ${CLASSIFICATION.type}, confidence: ${CLASSIFICATION.confidence})"`

**If routing:**

1. Log: `"Step 5.8: Bug fix detected (confidence: ${CLASSIFICATION.confidence}) — routing through /nf:debug"`

2. Spawn /nf:debug as a Task subagent:

```
Task(
  prompt="
Run /nf:debug with the following failure context.

## Task Description (from quick task)
${DESCRIPTION}

## Instructions
- Run the full debug pipeline (Steps A through A.8: collect context, discovery, reproduction, refinement, constraint extraction)
- Return the debug output including:
  - \$CONSTRAINTS (extracted constraints from Loop 1, if any)
  - \$FORMAL_VERDICT (pass/fail/skip from formal model checking, if any)
  - \$REPRODUCING_MODEL (path to reproducing formal model, if any)
- If any step fails or produces no output, continue with remaining steps (fail-open)
- Do NOT fix the bug — only diagnose and extract constraints. The executor will apply the fix.
",
  subagent_type="general-purpose",
  description="Debug routing for bug_fix task: ${DESCRIPTION}"
)
```

3. Parse debug output. Extract and store:
   - `$DEBUG_CONSTRAINTS` — constraints from Loop 1 refinement (may be empty)
   - `$DEBUG_FORMAL_VERDICT` — formal model check result (may be "skipped")
   - `$DEBUG_REPRODUCING_MODEL` — path to reproducing model (may be null)

4. Update scope-contract.json: set `classification.routed_through_debug` to `true`:

```bash
# Read existing scope-contract, update routed_through_debug, write back
node --input-type=module << 'NF_EVAL'
import { existsSync, readFileSync, writeFileSync } from 'fs';
const scPath = '${task_dir}/scope-contract.json';
if (existsSync(scPath)) {
  try {
    const sc = JSON.parse(readFileSync(scPath, 'utf8'));
    const key = Object.keys(sc)[0];
    if (key && sc[key].classification) {
      sc[key].classification.routed_through_debug = true;
      writeFileSync(scPath, JSON.stringify(sc, null, 2) + '\n');
    }
  } catch (e) { /* malformed scope-contract.json → skip the routed_through_debug flag */ }
}
NF_EVAL
```

5. Log: `"Step 5.8: Debug routing complete. Constraints: ${DEBUG_CONSTRAINTS ? 'found' : 'none'}, Verdict: ${DEBUG_FORMAL_VERDICT || 'skipped'}"`

**Fail-open:** If the debug subagent errors or times out, log a warning and proceed to Step 6 without debug context. Set `$DEBUG_CONSTRAINTS = null`, `$DEBUG_FORMAL_VERDICT = null`, `$DEBUG_REPRODUCING_MODEL = null`.

Store debug output variables for use in Step 6.

---

**Step 5.9: Formal tooling baseline check (only when `$FULL_MODE`)**

Skip this step entirely if NOT `$FULL_MODE`.

<!-- MUST_NOT_SKIP: This step is MANDATORY when $FULL_MODE is true. -->

Check that required formal tooling scripts exist before executor spawn:

```bash
FORMAL_TOOLS_MISSING=()
for tool in bin/formal-coverage-intersect.cjs bin/run-formal-verify.cjs bin/run-formal-check.cjs; do
  if [ ! -f "$tool" ]; then
    FORMAL_TOOLS_MISSING+=("$tool")
  fi
done

if [ ${#FORMAL_TOOLS_MISSING[@]} -gt 0 ]; then
  echo ":: WARNING: Formal tooling missing: ${FORMAL_TOOLS_MISSING[*]}"
  echo ":: Formal steps will be skipped (fail-open) but the skip will be LOGGED, not silent."
else
  echo ":: Formal tooling baseline: all tools present"
fi
```

This is ADVISORY only -- missing tools do NOT block execution. The purpose is to surface gaps early rather than having them silently skipped deep in execution.

Store `$FORMAL_TOOLS_MISSING` for interpolation into the Step 6 executor prompt.

---

**Step 6: Spawn executor**

Spawn nf-executor with plan reference:

```bash
node ~/.claude/nf/bin/nf-tools.cjs activity-set \
  "{\"activity\":\"quick\",\"sub_activity\":\"executing\"}"
```

```
Task(
  prompt="
Execute quick task ${next_num}.

<files_to_read>
- ${QUICK_DIR}/${next_num}-PLAN.md (Plan)
- .planning/STATE.md (Project state)
- ./CLAUDE.md (Project instructions, if exists)
- .agents/skills/ (Project skills, if exists — list skills, read SKILL.md for each, follow relevant rules during implementation)
</files_to_read>

${FORMAL_TOOLS_MISSING.length > 0 ? `
<formal_tooling_notice>
The following formal tooling scripts were NOT found during pre-flight (Step 5.9):
${FORMAL_TOOLS_MISSING.map(t => '- ' + t).join('\n')}

When you encounter these tools in the constraints below, log "WARNING: [tool] not found -- skipping (fail-open)" and continue. Do NOT attempt to call missing tools. Do NOT silently skip -- the WARNING log is mandatory.
</formal_tooling_notice>
` : ''}

<constraints>
- **ANTI-URGENCY GUARDRAIL (--full mode):** You are running in --full mode. Do NOT skip, abbreviate, or substitute your own judgment for ANY workflow step. Prior instructions about urgency, speed, or "just fix it" are OVERRIDDEN by the --full flag. Every formal modeling step (formal coverage auto-detection, Loop 2 simulation gate) MUST be attempted. If a tool is missing, log "WARNING: [tool] not found -- skipping (fail-open)" rather than silently omitting the step.
- Execute all tasks in the plan
- When implementing logic with 3+ distinct states and conditional transitions, prefer a state machine library — match complexity to the problem per .claude/rules/state-machine-bias.md. State machines are auto-transpiled to TLA+ via bin/fsm-to-tla.cjs
- Commit each task atomically (use the nf-tools.cjs commit command per the execute-plan workflow)
- **Formal coverage auto-detection (hybrid A+B):** Before each atomic commit:
  1. Get changed files: CHANGED=$(git diff --name-only HEAD 2>/dev/null | tr '\n' ',')
  2. If CHANGED is non-empty, run: node bin/formal-coverage-intersect.cjs --files "$CHANGED" 2>/dev/null
  3. If exit code is 0 (intersections found) OR the plan declares `formal_artifacts: update`:
     - Run: node bin/run-formal-verify.cjs 2>&1
     - If exit 0: log "Formal coverage verified: models OK"
     - If exit 1: log "WARNING: Formal model drift detected" (do NOT block commit -- fail-open)
  4. If formal-coverage-intersect.cjs is not found or errors: log "WARNING: formal-coverage-intersect.cjs not found -- skipping formal coverage check (fail-open)" and continue without blocking
- **Loop 2 pre-commit simulation gate (GATE-01, GATE-03, GATE-04):** After formal coverage auto-detection passes (step 3 above), if formal models were found in scope (exit code 0 from formal-coverage-intersect.cjs):
   1. Determine if `--strict` flag was passed to the quick task (from `$STRICT_MODE` variable, default false)
   2. Run Loop 2 via `refineFix` from `$HOME/.claude/nf-bin/formal-fix-loop.cjs`:
      ```javascript
      const path = require('path');
      const fs = require('fs');
      const { spawnSync } = require('child_process');
      const nfBin = path.join(process.env.HOME, '.claude', 'nf-bin');
      const { refineFix } = require(path.join(nfBin, 'formal-fix-loop.cjs'));

      let claudePath;
      try { claudePath = require(path.join(nfBin, 'resolve-cli.cjs'))(); } catch (_) { claudePath = 'claude'; }

      const callLlm = (prompt) => spawnSync(claudePath, [
        '-p', prompt, '--model', 'claude-haiku-4-5-20251001', '--max-turns', '1'
      ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 120000 });

      // Read the files being modified in this commit
      const buggySource = fs.readFileSync('<file being fixed>', 'utf8');
      const testSource = fs.readFileSync('<test file>', 'utf8');
      const testFailureOutput = 'Output from running the test before fix';

      const result = await refineFix({
        buggySource,
        testSource,
        testPath: '<absolute path to test file>',
        stubPath: '<absolute path to file being fixed>',
        testFailureOutput,
        constraint: { invariant: '<from formal model>', english: '<human-readable constraint>' },
        spec: '<formal spec from formal-model-loop, if available>',
        bugExplanation: '${DESCRIPTION}',
        maxIterations: 10,
        callLlm,
        onLog: (msg) => process.stderr.write(msg + '\n')
      });
      ```
      Store the result object with fields: `converged`, `iterations`, `fixedSource`, `gates`, `rejectionReasons`.
   3. Route on result:
      - **converged === true:** Log `"Loop 2 simulation: CONVERGED after ${result.iterations} iteration(s)"`. Proceed to commit.
      - **converged === false AND NOT $STRICT_MODE (fail-open, default):** Log `"WARNING: Loop 2 simulation did not converge — ${result.iterations} iterations. Proceeding (fail-open)."`. Proceed to commit anyway.
      - **converged === false AND $STRICT_MODE (fail-closed):** Log `"BLOCKED: Loop 2 simulation failed to converge after ${result.iterations} iterations. Fix required before commit."`. Do NOT commit. Report failure to orchestrator.
   4. **Non-convergence reporting (fail-open path only):** When Loop 2 did not converge and the commit proceeds:
      - When creating SUMMARY.md, include under "## Issues Encountered":
        ```
        ### Loop 2 Simulation Warning
        - **Status:** Non-converged (fail-open)
        - **Iterations:** ${result.iterations}
        - **Gates passed:** ${Object.entries(result.gates).filter(([k,v]) => v).map(([k]) => k).join(', ') || 'none'}
        - **Rejection reasons:** ${result.rejectionReasons.slice(-1)[0] || 'max iterations reached'}
        ```
   5. **Non-convergence reporting (fail-closed path):** When --strict blocks the commit, include rejection reasons in BLOCKED message: `"Loop 2 blocked: ${result.rejectionReasons.slice(-1)[0]}"`
   7. **Loop 2 SUMMARY.md reporting (--full mode, MANDATORY):** When `$FULL_MODE` is true, Loop 2 results MUST always be recorded in SUMMARY.md regardless of outcome:
      - **Converged:** Under "## Formal Modeling", add: `### Loop 2 Simulation\n- **Status:** Converged\n- **Iterations:** ${result.iterations}\n- **Gates:** ${JSON.stringify(result.gates)}`
      - **Non-converged (fail-open):** Use the existing "## Issues Encountered" format (item 4 above).
      - **Skipped (tool unavailable):** Under "## Formal Modeling", add: `### Loop 2 Simulation\n- **Status:** Skipped (tool unavailable)\n- **Reason:** formal-fix-loop.cjs not found`
      - **Not applicable (no intersections):** Under "## Formal Modeling", add: `### Loop 2 Simulation\n- **Status:** Not applicable (no formal coverage intersections)`
      This ensures the Step 6.1 audit gate can reliably grep SUMMARY.md for Loop 2 evidence.
   6. If formal-fix-loop.cjs is not found, module loading fails, or refineFix throws: log "WARNING: formal-fix-loop.cjs not found or errored -- skipping Loop 2 simulation (fail-open)". Do NOT skip silently.
- If formal-coverage-intersect.cjs found NO intersections (exit code non-zero): skip Loop 2 entirely — log "INFO: No formal coverage intersections found -- Loop 2 not needed (GATE-03)." If the tool was not found, log "WARNING: formal-coverage-intersect.cjs not found -- skipping Loop 2 (fail-open, GATE-03)."
- If the plan declares `formal_artifacts: update` or `formal_artifacts: create`, execute those formal file changes and include the .planning/formal/ files in the atomic commit for that task (alongside the implementation files)
- Formal/ files must never be committed separately — always include in the task's atomic commit
- Create summary at: ${QUICK_DIR}/${next_num}-SUMMARY.md
- Do NOT update ROADMAP.md (quick tasks are separate from planned phases)
- After creating the SUMMARY.md, update STATE.md "Quick Tasks Completed" table:
  - If the table doesn't exist, create it after "### Blockers/Concerns" with columns:
    | # | Description | Date | Commit | Status | Directory |
  - Append a new row: | ${next_num} | ${DESCRIPTION} | ${date} | {commit_hash} | Pending | [${next_num}-${slug}](./quick/${next_num}-${slug}/) |
    Use "Pending" as the Status placeholder (orchestrator will update when verifier runs, if --full)
  - Update "Last activity" line: "${date} - Completed quick task ${next_num}: ${DESCRIPTION}"
- Commit STATE.md alongside PLAN.md and SUMMARY.md in a single final commit:
  node ~/.claude/nf/bin/nf-tools.cjs commit "docs(quick-${next_num}): ${DESCRIPTION}" \
    --files ${QUICK_DIR}/${next_num}-PLAN.md ${QUICK_DIR}/${next_num}-SUMMARY.md .planning/STATE.md
- After committing, run: node ~/.claude/nf/bin/nf-tools.cjs activity-clear
- Return the final commit hash in your completion response (format: "Commit: {hash}")
</constraints>

${DEBUG_CONSTRAINTS || DEBUG_FORMAL_VERDICT || DEBUG_REPRODUCING_MODEL ?
`<debug_context>
This task was routed through /nf:debug before execution. Use the following debug output as supplementary context for your implementation:

${DEBUG_CONSTRAINTS ? `**Constraints from formal model refinement:**\n${DEBUG_CONSTRAINTS}` : ''}
${DEBUG_FORMAL_VERDICT ? `**Formal verdict:** ${DEBUG_FORMAL_VERDICT}` : ''}
${DEBUG_REPRODUCING_MODEL ? `**Reproducing model:** ${DEBUG_REPRODUCING_MODEL}` : ''}

These constraints inform the fix but do not gate it. If constraints conflict with the plan, follow the plan.
</debug_context>` : ''}
",
  subagent_type="nf-executor",
  model="{executor_model}",
  description="Execute: ${DESCRIPTION}"
)
```

After executor returns:
1. Verify summary exists at `${QUICK_DIR}/${next_num}-SUMMARY.md`
2. Extract commit hash from executor output ("Commit: {hash}" pattern)
3. **Consumer integration check:** For each new bin/ script or data file created by the executor, verify it has at least one system-level consumer (skill command, workflow, or pipeline script that invokes it). Check:
   ```bash
   # For each new .cjs file in the commit
   for f in $(git diff --name-only --diff-filter=A HEAD~1 -- 'bin/*.cjs' | grep -v test); do
     name=$(basename "$f" .cjs)
     consumers=$(grep -rl "$name" commands/ core/workflows/ bin/nf-solve.cjs bin/run-formal-verify.cjs bin/observe-handler-*.cjs 2>/dev/null | grep -v test | wc -l)
     if [ "$consumers" -eq 0 ]; then
       echo "WARNING: $f has no system-level consumer — risk of orphaned producer"
     fi
   done
   ```
   If any new scripts lack consumers, log a warning in the completion banner. This does NOT block completion — it surfaces the integration gap for the user to address.
4. Display the completion banner (see below)

**Known Claude Code bug (classifyHandoffIfNeeded):** If executor reports "failed" with error `classifyHandoffIfNeeded is not defined`, this is a Claude Code runtime bug — not a real failure. Check if summary file exists and git log shows commits. If so, treat as successful.

If summary not found, error: "Executor failed to create ${next_num}-SUMMARY.md"

Note: For quick tasks producing multiple plans (rare), spawn executors in parallel waves per execute-phase patterns.

**Completion banner (NOT --full, or --full before verification):**

```
---

nForma > QUICK TASK COMPLETE

Quick Task ${next_num}: ${DESCRIPTION}

Summary: ${QUICK_DIR}/${next_num}-SUMMARY.md
Commit: ${commit_hash}
Branch: ${CREATED_BRANCH || current_branch}
${CREATED_BRANCH ? '-> Ready for PR' : ''}

---

Ready for next task: /nf:quick
```

---

**Step 6.1: Post-execution formal loop audit (only when `$FULL_MODE`)**

Skip this step entirely if NOT `$FULL_MODE`.

<!-- MUST_NOT_SKIP: This step is MANDATORY when $FULL_MODE is true. -->

After the executor returns, audit its output for evidence that formal modeling steps were attempted:

```bash
# Read the executor's summary
SUMMARY_CONTENT=$(cat "${QUICK_DIR}/${next_num}-SUMMARY.md" 2>/dev/null)

# Check for formal step execution evidence
FORMAL_COVERAGE_RAN=$(echo "$SUMMARY_CONTENT" | grep -c "formal-coverage-intersect\|Formal coverage verified\|formal coverage")
LOOP2_RAN=$(echo "$SUMMARY_CONTENT" | grep -c "Loop 2\|formal-fix-loop\|CONVERGED\|Non-converged\|Skipped (tool unavailable)\|Not applicable")

if [ "$FORMAL_COVERAGE_RAN" -eq 0 ] && [ ${#FORMAL_TOOLS_MISSING[@]} -eq 0 ]; then
  echo ":: AUDIT WARNING: Formal coverage auto-detection appears to have been skipped despite tools being available."
  echo ":: This may indicate the executor bypassed formal modeling steps."
fi

if [ "$LOOP2_RAN" -eq 0 ] && [ ${#FORMAL_TOOLS_MISSING[@]} -eq 0 ]; then
  echo ":: AUDIT WARNING: Loop 2 simulation gate appears to have been skipped despite tools being available."
fi
```

These warnings are ADVISORY -- they do not block completion. They surface to the user that formal steps may have been skipped so the user can decide whether to re-run.

---

**Step 6.3: Post-execution formal check (only when `$FULL_MODE` AND `$FORMAL_SPEC_CONTEXT` non-empty)**

<!-- MUST_NOT_SKIP: This step is MANDATORY when $FULL_MODE is true. Skipping this step violates the --full contract. If tooling is missing, log a WARNING and continue -- but do NOT silently omit the step. -->

Skip this step entirely if NOT `$FULL_MODE` or `$FORMAL_SPEC_CONTEXT` is empty.

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► FORMAL CHECK (post-execution)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Running TLC/Alloy/PRISM for modules: ${FORMAL_SPEC_CONTEXT.map(f => f.module).join(', ')}
```

Build the module list:
```bash
MODULES=$(FORMAL_SPEC_CONTEXT.map(f => f.module).join(','))
```

Run the formal check script:
```bash
FORMAL_CHECK_OUTPUT=$(node bin/run-formal-check.cjs --modules=${MODULES} 2>&1)
FORMAL_CHECK_EXIT=$?
```

Parse the result line from output:
```bash
FORMAL_CHECK_RESULT=$(echo "$FORMAL_CHECK_OUTPUT" | grep '^FORMAL_CHECK_RESULT=' | cut -d= -f2-)
```

Display the output to the user (stream FORMAL_CHECK_OUTPUT to console).

Store `$FORMAL_CHECK_RESULT` and `$FORMAL_CHECK_EXIT` for use in Step 6.5.

**Route on exit code:**

| Exit code | Meaning | Action |
|-----------|---------|--------|
| 0 | All checks passed or skipped (no counterexample) | Display: `◆ Formal check: PASSED`. Continue to Step 6.5. |
| 1 | Counterexample found | Display: `◆ Formal check: COUNTEREXAMPLE FOUND — see output above`. Store result. Continue to Step 6.5 (do NOT abort — verifier receives this as hard failure signal). |

**Fail-open clause:** If `node bin/run-formal-check.cjs` itself fails to launch (e.g., Node.js error, script not found), log:
```
◆ Formal check: WARNING — run-formal-check.cjs not found or errored. Skipping.
```
Set `$FORMAL_CHECK_RESULT = null`. Continue to Step 6.5 without blocking.

---

**Step 6.5: Verification (only when `$FULL_MODE`)**

<!-- MUST_NOT_SKIP: This step is MANDATORY when $FULL_MODE is true. Skipping this step violates the --full contract. If tooling is missing, log a WARNING and continue -- but do NOT silently omit the step. -->

Skip this step entirely if NOT `$FULL_MODE`.

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► VERIFYING RESULTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning verifier...
```

```
Task(
  prompt="Verify quick task goal achievement.
Task directory: ${QUICK_DIR}
Task goal: ${DESCRIPTION}

<files_to_read>
- ${QUICK_DIR}/${next_num}-PLAN.md (Plan)
${FORMAL_SPEC_CONTEXT.map(f => `- ${f.path} (Formal invariants for module: ${f.module})`).join('\n')}
</files_to_read>

<formal_context>
${FORMAL_SPEC_CONTEXT.length > 0 ?
`Relevant formal modules: ${FORMAL_SPEC_CONTEXT.map(f => f.module).join(', ')}

Additional verification checks:
- Did executor respect the identified invariants? Check implementation files against invariant conditions.
- If plan declared formal_artifacts update or create: are the modified/created .planning/formal/ files syntactically reasonable for their type (TLA+/Alloy/PRISM)? (Basic structure check, not model checking.)

Formal check result from Step 6.3: ${FORMAL_CHECK_RESULT !== null ? JSON.stringify(FORMAL_CHECK_RESULT) : 'skipped (tool unavailable)'}
If failed > 0 in formal check result: treat as a HARD FAILURE in your verification — must_haves cannot pass if a counterexample was found.` :
'No existing formal modules matched. If plan declared formal_artifacts: create, verify the created .planning/formal/ files are syntactically reasonable for their type. If plan declared formal_artifacts: none, skip formal invariant checks.'}
</formal_context>

Check must_haves against actual codebase. Create VERIFICATION.md at ${QUICK_DIR}/${next_num}-VERIFICATION.md.",
  subagent_type="nf-verifier",
  model="{verifier_model}",
  description="Verify: ${DESCRIPTION}"
)
```

Read verification status:
```bash
grep "^status:" "${QUICK_DIR}/${next_num}-VERIFICATION.md" | cut -d: -f2 | tr -d ' '
```

Store as `$VERIFICATION_STATUS`.

| Status | Action |
|--------|--------|
| `passed` | Store `$VERIFICATION_STATUS = "Verified"`, continue to status update |
| `human_needed` | Run quorum resolution loop (see below). If quorum resolves → store `$VERIFICATION_STATUS = "Verified"`, continue. If quorum cannot resolve → display items, store `$VERIFICATION_STATUS = "Needs Review"`, continue |
| `gaps_found` | Display gap summary, offer: 1) Re-run executor to fix gaps, 2) Accept as-is. Store `$VERIFICATION_STATUS = "Gaps"` |

**Step 6.5.1: Quorum review of VERIFICATION.md (only when `$FULL_MODE` and `$VERIFICATION_STATUS = "Verified"`)**

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► QUORUM REVIEW OF VERIFICATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Running quorum review of VERIFICATION.md...
```

Form your ADVISORY analysis (per CE-1 — not a vote in the tally): does VERIFICATION.md confirm all must_haves are met and no invariants violated? State your analysis as 1-2 sentences to share with external voters.

Run quorum inline — follow the canonical protocol in @core/references/quorum-dispatch.md:
- Mode A — artifact review
- artifact_path: `${QUICK_DIR}/${next_num}-VERIFICATION.md`
- review_context: "Review this VERIFICATION.md and answer: (1) Are all must_haves confirmed met? (2) Are any invariants from the formal context violated? Vote APPROVE if verification is sound and complete. Vote BLOCK if must_haves are not confirmed or invariants are violated."
- request_improvements: false
- Reuse `$DISPATCH_LIST` from step 5.7 preflight (or re-run `node "$HOME/.claude/nf-bin/quorum-preflight.cjs" --all` if not in scope)
- **Exact YAML format for worker prompts** (from reference section 4):
  ```yaml
  slot: <slotName>
  round: <round_number>
  timeout_ms: <from $SLOT_TIMEOUTS or 300000>
  repo_dir: <absolute path to project root>
  mode: A
  question: <question text>
  artifact_path: ${QUICK_DIR}/${next_num}-VERIFICATION.md
  review_context: "Review this VERIFICATION.md..."
  request_improvements: false
  prior_positions: |
    [included from Round 2 onward]
  ```
- Dispatch `$DISPATCH_LIST` as sibling `nf-quorum-slot-worker` Tasks with `model="haiku", max_turns=100`
- **FALLBACK-01 required:** If ANY dispatched slot returns UNAVAIL, follow the tiered fallback protocol from @core/references/quorum-dispatch.md §6 before evaluating consensus. Dispatch T1 (flat-rate CLI, `auth_type=sub`) then T2 (pay-per-use API) unused slots from the preflight `available_slots` list. Complete the FALLBACK_CHECKPOINT before proceeding.

Fail-open: if all slots AND all fallback tiers are exhausted (UNAVAIL), keep `$VERIFICATION_STATUS = "Verified"` and note: "Quorum unavailable — verification result uncontested."

Route on quorum result:
| Verdict | Action |
|---------|--------|
| **APPROVED** | Keep `$VERIFICATION_STATUS = "Verified"`. Proceed to status update. |
| **BLOCKED** | Set `$VERIFICATION_STATUS = "Needs Review"`. Display block reason. Proceed to status update. |
| **ESCALATED** | Present escalation to user. Set `$VERIFICATION_STATUS = "Needs Review"`. Proceed to status update. |

---

**Quorum resolution loop for human_needed:**

1. Read the full `human_verification` section from `${QUICK_DIR}/${next_num}-VERIFICATION.md`.

2. Form your ADVISORY analysis (per CE-1 — not a vote in the tally): can each item be verified via available tools (grep, file reads, quorum-test)? State your analysis as 1-2 sentences to share with external voters.

3. Run quorum inline — follow the canonical protocol in @core/references/quorum-dispatch.md:
   - Mode A — pure question
   - Question: "Can each human_needed item from quick task ${next_num} be resolved using available tools (grep, file inspection, quorum-test)? Vote APPROVE (can resolve programmatically) or BLOCK (genuinely needs human eyes)."
   - Include the full `human_verification` section as context
   - **Exact YAML format for worker prompts** (from reference section 4):
     ```yaml
     slot: <slotName>
     round: <round_number>
     timeout_ms: <from $SLOT_TIMEOUTS or 300000>
     repo_dir: <absolute path to project root>
     mode: A
     question: "Can each human_needed item from quick task..."
     prior_positions: |
       [included from Round 2 onward]
     ```
   - Reuse `$DISPATCH_LIST` from step 5.7 preflight (or re-run `node "$HOME/.claude/nf-bin/quorum-preflight.cjs" --all` if not in scope). Then dispatch `$DISPATCH_LIST` as sibling `nf-quorum-slot-worker` Tasks with `model="haiku", max_turns=100` — do NOT dispatch slots outside `$DISPATCH_LIST`
   - Synthesize results inline, deliberate up to 10 rounds per R3.3
   - **FALLBACK-01 required:** If ANY dispatched slot returns UNAVAIL, follow the tiered fallback protocol from @core/references/quorum-dispatch.md §6 before evaluating consensus. Dispatch T1 (flat-rate CLI, `auth_type=sub`) then T2 (pay-per-use API) unused slots from the preflight `available_slots` list. Complete the FALLBACK_CHECKPOINT before proceeding.

   Fail-open: if all slots AND all fallback tiers are exhausted (UNAVAIL), treat as BLOCK (escalate to user).

4. Route on quorum_result:
   - **APPROVED** → Consensus reached. Store `$VERIFICATION_STATUS = "Verified"`. Proceed to status update.
   - **BLOCKED** → Cannot auto-resolve. Display items needing manual check to user. Store `$VERIFICATION_STATUS = "Needs Review"`. Continue to status update.
   - **ESCALATED** → Present escalation to user as "Needs Review". Continue to status update.

**Update STATE.md Status cell after verification:**

Read STATE.md, find the row for `${next_num}`, replace "Pending" with the actual `$VERIFICATION_STATUS`. Then commit:

```bash
node ~/.claude/nf/bin/nf-tools.cjs commit "docs(quick-${next_num}): update verification status" \
  --files .planning/STATE.md ${QUICK_DIR}/${next_num}-VERIFICATION.md
```

---

**Step 6.6: Adversarial hardening (only when `$FULL_MODE` AND `$VERIFICATION_STATUS = "Verified"`)**

<!-- MUST_NOT_SKIP: This step runs after verification passes and before requirement elevation. Skip only if NOT $FULL_MODE or VERIFICATION_STATUS is not "Verified". -->

Skip this step if NOT `$FULL_MODE` OR `$VERIFICATION_STATUS` is not `"Verified"`.

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► ADVERSARIAL HARDENING (quick --full)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning hardening loop (max 5 iterations)...
```

Spawn the harden workflow inline as a Task subagent:

```
Task(
  subagent_type="general-purpose",
  model="{executor_model}",
  description="Adversarial hardening: ${DESCRIPTION}",
  prompt="
Run the adversarial hardening loop for the quick task that just completed.

Read @~/.claude/nf/workflows/harden.md for the full workflow instructions.

## Arguments
--max 5

## Context
This is called from nf:quick --full post-verification. The implementation was just verified as passing. The goal is to harden it against edge cases.

## Constraints
- Max 5 iterations (--max 5)
- Use the repo root as scope (no --area flag)
- Fail-open: if no test files found, return status: skipped and stop gracefully
- Do NOT re-run the verifier after hardening — this step is hardening only
- Return the final harden status (converged | cap_exhausted | skipped | blocked) in your response (format: 'Harden Status: {status}')
"
)
```

Parse the subagent response for `Harden Status: {status}`.

**Fail-open:** If the subagent errors, times out, or returns no status, log:
```
◆ WARNING: Adversarial hardening subagent did not complete cleanly. Proceeding (fail-open).
```
Set `$HARDEN_STATUS = "skipped"`. Continue to Step 6.7.

Display result line based on status:
- `converged` → `◆ Hardening: CONVERGED`
- `cap_exhausted` → `◆ Hardening: CAP REACHED (5 iterations) — some edge cases may remain`
- `skipped` → `◆ Hardening: SKIPPED (no test files found)`
- `blocked` → `◆ Hardening: SKIPPED (baseline failures detected — fix first)`

Store `$HARDEN_STATUS` for inclusion in the final completion banner.

---

**Step 6.7: Requirement elevation (only when `$FULL_MODE` AND `$VERIFICATION_STATUS = "Verified"`)**

Skip this step if NOT `$FULL_MODE` or `$VERIFICATION_STATUS` is not `"Verified"`.

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► REQUIREMENT ELEVATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Drafting requirement from verified quick task...
```

**6.7.1: Draft requirement via Haiku**

Spawn a Haiku subagent to draft a formal requirement from the completed task:

```
Task(
  subagent_type="general-purpose",
  model="haiku",
  description="Draft requirement from quick task",
  prompt="
You are drafting a formal requirement from a completed quick task.

## Task context
- Description: ${DESCRIPTION}
- Plan: Read ${QUICK_DIR}/${next_num}-PLAN.md
- Summary: Read ${QUICK_DIR}/${next_num}-SUMMARY.md

## Existing requirements
Read .planning/formal/requirements.json. Note all existing ID prefixes and their counts.

## Your task

Draft a single requirement that captures what this quick task delivered. Follow these rules:

1. **ID**: Pick the most semantically appropriate existing prefix. If no prefix fits, propose a new one (2-6 uppercase letters). Append the next available number for that prefix (e.g., if STOP-09 exists, use STOP-10).

2. **Text**: One sentence describing the deliverable — what the system now does, not what the task was. Use present tense, imperative style matching existing requirements.

3. **Category**: Match an existing category from the same prefix group, or propose a new one.

4. **Phase**: Use 'unknown' (quick tasks are not phase-tracked).

5. **Background**: 1-2 sentences explaining why this requirement exists and what problem it solves.

## Response format

Respond with EXACTLY this JSON (no markdown fencing, no extra text):
{
  \"id\": \"PREFIX-NN\",
  \"text\": \"...\",
  \"category\": \"...\",
  \"phase\": \"unknown\",
  \"status\": \"Complete\",
  \"background\": \"...\"
}
"
)
```

Parse the Haiku response as JSON. Store as `$DRAFT_REQ`.

**6.7.2: Present to user for approval**

Display the drafted requirement:

```
◆ Proposed requirement from quick task ${next_num}:

  ID:         ${DRAFT_REQ.id}
  Text:       ${DRAFT_REQ.text}
  Category:   ${DRAFT_REQ.category}
  Background: ${DRAFT_REQ.background}
```

Ask the user:

```
AskUserQuestion(
  header: "Elevate?",
  question: "Add this requirement to .planning/formal/requirements.json?",
  options: [
    { label: "Yes, add it", description: "Add the requirement as drafted" },
    { label: "Edit first", description: "I'll modify the ID, text, or category before adding" },
    { label: "Skip", description: "Don't add a requirement for this task" }
  ],
  multiSelect: false
)
```

**Route on user response:**

- **"Yes, add it"** → Proceed to 6.7.3.
- **"Edit first"** → Ask follow-up questions for each field the user wants to change (id, text, category, background). Update `$DRAFT_REQ` with user edits. Then proceed to 6.7.3.
- **"Skip"** → Display: `◆ Requirement elevation skipped.` Proceed to completion banner.

**6.7.3: Write requirement with conflict checks**

Execute the add-requirement workflow inline (same checks as `/nf:add-requirement`):

1. **Duplicate ID check**: Search existing requirements for exact ID match on `$DRAFT_REQ.id`. If found, show conflict and ask user for a different ID.

2. **Semantic conflict check** (MANDATORY — always runs): Spawn Haiku with the conflict-detection prompt from `add-requirement.md` workflow (step `check_semantic_conflicts`) against the ENTIRE envelope, not just same-prefix. If `CONFLICT` returned, show it to user and ask how to proceed.

3. **Unfreeze** `.planning/formal/requirements.json` if `frozen_at` is not null.

4. **Append** `$DRAFT_REQ` to the requirements array with provenance:
   ```json
   {
     "source_file": "${QUICK_DIR}/${next_num}-PLAN.md",
     "milestone": "quick-${next_num}"
   }
   ```

5. **Sort** array by ID, **recompute** `content_hash`, update `aggregated_at`.

6. **Write** atomically (temp + rename).

7. **Re-freeze** the envelope.

8. **Commit**:
   ```bash
   node ~/.claude/nf/bin/nf-tools.cjs commit "req(quick-${next_num}): add ${DRAFT_REQ.id}" \
     --files .planning/formal/requirements.json
   ```

9. Display:
   ```
   ◆ Requirement ${DRAFT_REQ.id} added to .planning/formal/requirements.json
     Total requirements: ${new_count}
   ```

---

Display final completion banner:

```
---

nForma > QUICK TASK COMPLETE (FULL MODE)

Quick Task ${next_num}: ${DESCRIPTION}

Summary: ${QUICK_DIR}/${next_num}-SUMMARY.md
Verification: ${QUICK_DIR}/${next_num}-VERIFICATION.md (${VERIFICATION_STATUS})
Hardening: ${HARDEN_STATUS || 'not run'}
${DRAFT_REQ ? 'Requirement: ' + DRAFT_REQ.id + ' (elevated to .planning/formal/requirements.json)' : ''}
Commit: ${commit_hash}
Branch: ${CREATED_BRANCH || current_branch}
${CREATED_BRANCH ? '-> Ready for PR' : ''}

---

Ready for next task: /nf:quick
```

</process>

<success_criteria>
- [ ] ROADMAP.md validation passes
- [ ] User provides task description
- [ ] `--full` flag parsed from arguments when present
- [ ] Slug generated (lowercase, hyphens, max 40 chars)
- [ ] Next number calculated (001, 002, 003...)
- [ ] Directory created at `.planning/quick/NNN-slug/`
- [ ] `${next_num}-PLAN.md` created by planner
- [ ] (--full) Formal scope scan runs before planner (step 4.5), $FORMAL_SPEC_CONTEXT populated
- [ ] (--full) Planner receives relevant invariants.md in files_to_read
- [ ] (--full) Plan declares formal_artifacts field in frontmatter
- [ ] (--full) Plan checker validates plan, revision loop capped at 2
- [ ] Quorum ran (step 5.7) with `request_improvements: true`
- [ ] R3.6 loop ran: if improvements proposed, planner revision spawned; if none or planner failed, loop exited; `<!-- nForma_DECISION -->` present in response
- [ ] `${next_num}-SUMMARY.md` created by executor
- [ ] (--full) Executor includes .planning/formal/ files in atomic commits when formal_artifacts non-empty
- [ ] (--full) `${next_num}-VERIFICATION.md` created by verifier
- [ ] (--full) Verifier checks invariant compliance and formal artifact syntax
- [ ] (--full) Step 6.3 formal check ran when FORMAL_SPEC_CONTEXT non-empty; FORMAL_CHECK_RESULT passed to verifier
- [ ] (--full) Quorum reviews VERIFICATION.md after passed status (step 6.5.1)
- [ ] Executor commits PLAN.md + SUMMARY.md + STATE.md atomically
- [ ] (--full) Orchestrator updates STATE.md Status cell after verification
- [ ] (--full) Requirement elevation runs when VERIFICATION_STATUS is "Verified" (step 6.7)
- [ ] (--full) Haiku drafts requirement from task context (description + plan + summary)
- [ ] (--full) User is asked to approve, edit, or skip the drafted requirement
- [ ] (--full) If approved: duplicate ID check, semantic conflict check (Haiku), then write to .planning/formal/requirements.json with unfreeze/re-freeze lifecycle
- [ ] (--full) Elevated requirement uses provenance { source_file: quick plan path, milestone: "quick-NNN" }
- [ ] `--delegate` flag parsed from arguments when present
- [ ] `--delegate` and `--full` are mutually exclusive
- [ ] Delegate slot validated against providers.json (subprocess + has_file_access)
- [ ] Mode C dispatch via coding-task-router.cjs for delegate tasks
- [ ] Delegate result recorded in SUMMARY.md and STATE.md
- [ ] Steps 5-6 skipped for delegate mode (no local plan, no local execution)
- [ ] (--full) MUST_NOT_SKIP annotations present on orchestrator steps 2.7, 5, 5.5, 5.7, 5.8 AND executor steps 4.5, 5.9, 6.1, 6.3, 6.5
- [ ] (--full) Anti-urgency guardrail injected as first constraint in executor prompt
- [ ] (--full) Step 5.9 baseline check runs before executor spawn
- [ ] (--full) Step 6.1 audit gate checks executor output for formal step evidence
- [ ] (--full) No "skip silently" clauses remain in executor constraints -- all skips are logged
- [ ] (--full) Loop 2 results always recorded in SUMMARY.md (converged, non-converged, skipped, or N/A)
- [ ] (--full) FORMAL_TOOLS_MISSING interpolated into executor prompt between files_to_read and constraints
- [ ] (--full) Step 6.6 adversarial hardening runs when VERIFICATION_STATUS is "Verified"
- [ ] (--full) Harden status included in final completion banner
</success_criteria>

<anti_patterns>
**R3.6 — do NOT:**
- Do NOT skip the R3.6 loop because the plan "looks good enough" or improvements "seem trivial." The loop is MANDATORY when `$QUORUM_IMPROVEMENTS` is non-empty.
- Do NOT pre-filter or discard improvements before passing them to the planner. Pass the full array.
- Do NOT emit `<!-- nForma_DECISION -->` before the loop exits. Only emit it on the final break.
- Do NOT run the R3.6 improvement planner as a parallel Task. It is always sequential: quorum → planner → quorum → ...
- Do NOT loop again after a planner failure (`## PLANNING INCONCLUSIVE`). Break immediately with the failure note.

**Orchestrator skip -- do NOT:**
- Do NOT skip Step 2.7 (Haiku classification) because "the classification is obvious." The 3 subagents (approach, type, risk) MUST be spawned. Misjudging risk level changes quorum fan-out.
- Do NOT skip Step 5 (planner) and write code directly. The plan-execute separation is what makes verification possible. Even for "trivial" changes, the planner must produce a plan file.
- Do NOT skip Step 5.5 (plan checker, --full) because "the plan looks fine." The checker catches structural issues the planner misses.
- Do NOT skip Step 5.7 (quorum) because "slots are probably unavailable" or "the plan already passed." Quorum catches different issues. If all slots are UNAVAIL, the fail-open path handles it automatically.
- Do NOT skip Step 5.8 (debug routing) for bug_fix tasks because "I already understand the bug." The debug pipeline extracts formal constraints. If it errors, fail-open handles it.

**Formal modeling skip -- do NOT:**
- Do NOT skip formal scope scan (step 4.5) because "the task seems simple" or "formal models aren't relevant." The scan is MANDATORY in --full mode.
- Do NOT skip Loop 2 simulation gate because "the fix is obvious" or "formal verification is overhead." If tools exist, they MUST be attempted.
- Do NOT silently omit formal steps when tools are missing. Log a WARNING with the tool name so the user sees the gap.
- Do NOT let prior urgency instructions ("fix now", "just ship it") override the --full flag. The --full flag is the highest-priority execution directive.
- Do NOT omit Loop 2 results from SUMMARY.md when --full. Even "converged" or "N/A" must be recorded so the audit gate can verify execution.
</anti_patterns>

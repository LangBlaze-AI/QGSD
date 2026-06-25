<purpose>
Execute all plans in a phase using wave-based parallel execution. Orchestrator stays lean — delegates plan execution to subagents.
</purpose>

<core_principle>
Orchestrator coordinates, not executes. Each subagent loads the full execute-plan context. Orchestrator: discover plans → analyze deps → group waves → spawn agents → handle checkpoints → collect results.
</core_principle>

<required_reading>
Read STATE.md before any operation to load project context.
</required_reading>

<process>

<step name="initialize" priority="first">
Load all context in one call:

```bash
INIT=$(node ~/.claude/nf/bin/nf-tools.cjs init execute-phase "${PHASE_ARG}")
```

Parse JSON for: `executor_model`, `verifier_model`, `commit_docs`, `parallelization`, `branching_strategy`, `branch_name`, `phase_found`, `phase_dir`, `phase_number`, `phase_name`, `phase_slug`, `plans`, `incomplete_plans`, `plan_count`, `incomplete_count`, `state_exists`, `roadmap_exists`.

**If `phase_found` is false:** Error — phase directory not found.
**If `plan_count` is 0:** Error — no plans found in phase.
**If `state_exists` is false but `.planning/` exists:** Offer reconstruct or continue.

When `parallelization` is false, plans within a wave execute sequentially.
</step>

<step name="handle_branching">
Check `branching_strategy` from init:

**"none":** Skip, continue on current branch.

**"phase" or "milestone":** Use pre-computed `branch_name` from init:
```bash
git checkout -b "$BRANCH_NAME" 2>/dev/null || git checkout "$BRANCH_NAME"
```

All subsequent commits go to this branch. User handles merging.
</step>

<step name="validate_phase">
From init JSON: `phase_dir`, `plan_count`, `incomplete_count`.

Report: "Found {plan_count} plans in {phase_dir} ({incomplete_count} incomplete)"
</step>

<step name="discover_and_group_plans">
Load plan inventory with wave grouping in one call:

```bash
PLAN_INDEX=$(node ~/.claude/nf/bin/nf-tools.cjs phase-plan-index "${PHASE_NUMBER}")
```

Parse JSON for: `phase`, `plans[]` (each with `id`, `wave`, `autonomous`, `objective`, `files_modified`, `task_count`, `has_summary`), `waves` (map of wave number → plan IDs), `incomplete`, `has_checkpoints`.

**Filtering:** Skip plans where `has_summary: true`. If `--gaps-only`: also skip non-gap_closure plans. If all filtered: "No matching incomplete plans" → exit.

Report:
```
## Execution Plan

**Phase {X}: {Name}** — {total_plans} plans across {wave_count} waves

| Wave | Plans | What it builds |
|------|-------|----------------|
| 1 | 01-01, 01-02 | {from plan objectives, 3-8 words} |
| 2 | 01-03 | ... |
```
</step>

<step name="execute_waves">
Execute each wave in sequence. Within a wave: parallel if `PARALLELIZATION=true`, sequential if `false`.

**For each wave:**

Run this Bash command at the start of each plan execution (before spawning the executor agent), substituting `${PHASE_NUMBER}` (from init JSON), the current plan filename (e.g. `14-02-PLAN.md`), and the current wave number (e.g. `2`):
```bash
# Track current activity
node ~/.claude/nf/bin/nf-tools.cjs activity-set \
  "{\"activity\":\"execute_phase\",\"sub_activity\":\"executing_plan\",\"phase\":\"${PHASE_NUMBER}\",\"plan\":\"${PLAN_FILE}\",\"wave\":${WAVE_N}}"
```

1. **Describe what's being built (BEFORE spawning):**

   Read each plan's `<objective>`. Extract what's being built and why.

   ```
   ---
   ## Wave {N}

   **{Plan ID}: {Plan Name}**
   {2-3 sentences: what this builds, technical approach, why it matters}

   Spawning {count} agent(s)...
   ---
   ```

   - Bad: "Executing terrain generation plan"
   - Good: "Procedural terrain generator using Perlin noise — creates height maps, biome zones, and collision meshes. Required before vehicle physics can interact with ground."

1.5. **Classify plan type and debug routing (ROUTE-02, ROUTE-03):**

   For each plan, classify its objective and optionally route through `/nf:debug` before execution.

   **1.5a. Classify plan type via Haiku subagent:**

   Spawn a Haiku subagent to classify the plan's objective:

   ```
   Task(
     subagent_type="general-purpose",
     model="haiku",
     description="Classify plan type for debug routing",
     prompt="
   You are classifying a development plan into exactly one category.

   ## Plan Objective
   {plan_objective_text from <objective> tag}

   ## Categories
   - bug_fix: The plan fixes a bug, error, regression, crash, or broken behavior.
   - feature: The plan adds new functionality or capability.
   - refactor: The plan reorganizes, renames, cleans up, or simplifies existing code without changing behavior.

   Respond with ONLY a JSON object:
   {
     \"type\": \"bug_fix\" | \"feature\" | \"refactor\",
     \"confidence\": 0.0-1.0
   }
   "
   )
   ```

   Parse response as JSON. Store as `$PLAN_CLASSIFICATION`.

   **Fail-open:** If Haiku is unavailable or JSON parse fails, use `{ "type": "feature", "confidence": 0.0 }`.

   Log: `"Plan classification: ${PLAN_CLASSIFICATION.type} (confidence: ${PLAN_CLASSIFICATION.confidence})"`

   **1.5b. Debug routing:**

   **Skip if:** `$PLAN_CLASSIFICATION.type` is NOT `bug_fix`, OR `$PLAN_CLASSIFICATION.confidence` < 0.7.

   If skipped, log: `"Debug routing: skipped (type: ${PLAN_CLASSIFICATION.type}, confidence: ${PLAN_CLASSIFICATION.confidence})"`
   Set `$DEBUG_CONSTRAINTS = null`, `$DEBUG_FORMAL_VERDICT = null`, `$DEBUG_REPRODUCING_MODEL = null`.

   **If routing:**

   1. Log: `"Debug routing: bug_fix detected (confidence: ${PLAN_CLASSIFICATION.confidence}) — routing through /nf:debug"`

   2. Spawn `/nf:debug` as a Task subagent:

   ```
   Task(
     prompt="
   Run /nf:debug with the following failure context.

   ## Plan Objective (from phase plan)
   {plan_objective_text}

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
     description="Debug routing for plan {plan_number}: {plan_objective_summary}"
   )
   ```

   3. Parse debug output. Extract and store:
      - `$DEBUG_CONSTRAINTS` — constraints from Loop 1 refinement (may be empty)
      - `$DEBUG_FORMAL_VERDICT` — formal model check result (may be "skipped")
      - `$DEBUG_REPRODUCING_MODEL` — path to reproducing model (may be null)

   4. Log: `"Debug routing complete. Constraints: ${DEBUG_CONSTRAINTS ? 'found' : 'none'}, Verdict: ${DEBUG_FORMAL_VERDICT || 'skipped'}"`

   **Fail-open:** If the debug subagent errors or times out, log a warning and proceed without debug context. Set all debug vars to null.

2. **Spawn executor agents:**

   Pass paths only — executors read files themselves with their fresh 200k context.
   This keeps orchestrator context lean (~10-15%).

   ```
   Task(
     subagent_type="nf-executor",
     model="{executor_model}",
     prompt="
       <objective>
       Execute plan {plan_number} of phase {phase_number}-{phase_name}.
       Commit each task atomically. Create SUMMARY.md. Update STATE.md and ROADMAP.md.
       </objective>

       <execution_context>
       @~/.claude/nf/workflows/execute-plan.md
       @~/.claude/nf/templates/summary.md
       @~/.claude/nf/references/checkpoints.md
       @~/.claude/nf/references/tdd.md
       </execution_context>

       <files_to_read>
       Read these files at execution start using the Read tool:
       - {phase_dir}/{plan_file} (Plan)
       - .planning/STATE.md (State)
       - .planning/config.json (Config, if exists)
       - .agents/skills/ (Project skills, if exists — list skills, read SKILL.md for each skill, follow rules during implementation)
       </files_to_read>

       <formal_coverage_auto_detection>
       **Formal coverage auto-detection (hybrid A+B):** Before each atomic commit:
       1. Get changed files: CHANGED=$(git diff --name-only HEAD 2>/dev/null | tr '\n' ',')
       2. If CHANGED is non-empty, run: node bin/formal-coverage-intersect.cjs --files "$CHANGED" 2>/dev/null
       3. If exit code is 0 (intersections found) OR the plan declares `formal_artifacts: update`:
          - Run: node bin/run-formal-verify.cjs 2>&1
          - If exit 0: log "Formal coverage verified: models OK"
          - If exit 1: log "WARNING: Formal model drift detected" (do NOT block commit -- fail-open)
       4. If formal-coverage-intersect.cjs is not found or errors: skip silently (fail-open)
        5. **Loop 2 simulation gate (GATE-02, GATE-03, GATE-04):** If step 2 found intersections (exit code 0):
           a. Run Loop 2 via `refineFix` from `$HOME/.claude/nf-bin/formal-fix-loop.cjs` with:
              - `buggySource`: content of the file being changed in current diff
              - `testSource`: content of the associated test file
              - `testPath`: absolute path to the test file
              - `stubPath`: absolute path to the file being changed
              - `testFailureOutput`: output from running the test before fix
              - `constraint`: `{ invariant: '<from formal model>', english: '<human-readable>' }` (from formal-coverage-intersect results)
              - `maxIterations`: 10
              - `callLlm`: function that spawns LLM subprocess via `require(path.join(process.env.HOME, '.claude', 'nf-bin', 'resolve-cli.cjs'))()` + `spawnSync(claudePath, ['-p', prompt, '--model', 'claude-haiku-4-5-20251001', '--max-turns', '1'], { encoding: 'utf8', maxBuffer: 4*1024*1024, timeout: 120000 })`
              Store result with fields: `converged`, `iterations`, `fixedSource`, `gates`, `rejectionReasons`.
           b. Route on result:
              - **converged === true:** Log `"Loop 2: CONVERGED (${result.iterations} iterations)"`. Continue to commit.
              - **converged === false (fail-open, default):** Log `"WARNING: Loop 2 did not converge — ${result.iterations} iterations. Proceeding (fail-open)."`. Continue to commit.
              - **converged === false AND plan frontmatter contains `strict_simulation: true` (fail-closed):** Log `"BLOCKED: Loop 2 failed to converge. Fix required before commit."`. Do NOT commit.
           c. **Non-convergence reporting (fail-open path only):** When Loop 2 did not converge and the commit proceeds:
              - Include in SUMMARY.md under "## Issues Encountered":
                ```
                ### Loop 2 Simulation Warning
                - **Status:** Non-converged (fail-open)
                - **Iterations:** ${result.iterations}
                - **Gates passed:** ${Object.entries(result.gates).filter(([k,v]) => v).map(([k]) => k).join(', ') || 'none'}
                - **Reason:** ${result.rejectionReasons.slice(-1)[0] || 'Max iterations reached'}
                ```
           d. **Non-convergence reporting (fail-closed path):** Include rejection reasons in BLOCKED message: `"Loop 2 blocked: ${result.rejectionReasons.slice(-1)[0]}"`
           e. If formal-fix-loop.cjs is not found or throws: skip silently (fail-open)
        6. If step 2 found NO intersections: skip Loop 2 entirely (GATE-03) — silent, no log
       </formal_coverage_auto_detection>

       ${DEBUG_CONSTRAINTS || DEBUG_FORMAL_VERDICT || DEBUG_REPRODUCING_MODEL ?
       `<debug_context>
       This plan was routed through /nf:debug before execution. Use the following debug output as supplementary context for your implementation:

       ${DEBUG_CONSTRAINTS ? '**Constraints from formal model refinement:**\n' + DEBUG_CONSTRAINTS : ''}
       ${DEBUG_FORMAL_VERDICT ? '**Formal verdict:** ' + DEBUG_FORMAL_VERDICT : ''}
       ${DEBUG_REPRODUCING_MODEL ? '**Reproducing model:** ' + DEBUG_REPRODUCING_MODEL : ''}

       These constraints inform the fix but do not gate it. If constraints conflict with the plan, follow the plan.
       </debug_context>` : ''}

       <success_criteria>
       - [ ] All tasks executed
       - [ ] Each task committed individually
       - [ ] SUMMARY.md created in plan directory
       - [ ] STATE.md updated with position and decisions
       - [ ] ROADMAP.md updated with plan progress (via `roadmap update-plan-progress`)
       </success_criteria>
     ",
     description="Execute plan {plan_number}: {phase_number}-{phase_name}"
   )
   ```

3. **Wait for all agents in wave to complete.**

4. **Report completion — spot-check claims first:**

   For each SUMMARY.md:
   - Verify first 2 files from `key-files.created` exist on disk
   - Check `git log --oneline --all --grep="{phase}-{plan}"` returns ≥1 commit
   - Check for `## Self-Check: FAILED` marker

   If ANY spot-check fails: report which plan failed, then check SUMMARY.md for diagnosis markers.

   **Diagnosis detection heuristic:** SUMMARY.md is diagnosed when it contains any of: `Root Cause:`, `Diagnosed`, `Bug 1 —`, `Bug 2 —`, `CI Failures`, `Deferred: CI fixes`.

   - **Diagnosis present:** Read the diagnosis section. Auto-spawn quick task with the diagnosis as description (no user gate) — see auto-spawn mechanism below.
   - **No diagnosis:** Ask "Retry plan?" or "Continue with remaining waves?" (existing behavior).

   If pass:
   ```
   ---
   ## Wave {N} Complete

   **{Plan ID}: {Plan Name}**
   {What was built — from SUMMARY.md}
   {Notable deviations, if any}

   {If more waves: what this enables for next wave}
   ---
   ```

   - Bad: "Wave 2 complete. Proceeding to Wave 3."
   - Good: "Terrain system complete — 3 biome types, height-based texturing, physics collision meshes. Vehicle physics (Wave 3) can now reference ground surfaces."

5. **Handle failures:**

   **Known Claude Code bug (classifyHandoffIfNeeded):** If an agent reports "failed" with error containing `classifyHandoffIfNeeded is not defined`, this is a Claude Code runtime bug — not a nForma or agent issue. The error fires in the completion handler AFTER all tool calls finish. In this case: run the same spot-checks as step 4 (SUMMARY.md exists, git commits present, no Self-Check: FAILED). If spot-checks PASS → treat as **successful**. If spot-checks FAIL → treat as real failure below.

   For real failures: report which plan failed, then check SUMMARY.md for diagnosis markers (same heuristic as step 4: `Root Cause:`, `Diagnosed`, `Bug 1 —`, `Bug 2 —`, `CI Failures`, `Deferred: CI fixes`).

   - **Diagnosis present:** Read the diagnosis section. Auto-spawn quick task with the diagnosis as description (no user gate) — see auto-spawn mechanism below.
   - **No diagnosis:** Ask "Continue?" or "Stop?" → if continue, dependent plans may also fail. If stop, partial completion report.

   **Auto-spawn quick task mechanism** (used by both step 4 and step 5):
   Extract the diagnosis text from SUMMARY.md (all lines under any "Root Cause", "Diagnosed", "Bug N —", "CI Failures", or "Deferred: CI fixes" headings). Compose a description: "Fix CI failures diagnosed in {phase}-{plan}: {first-line-of-diagnosis}".

   Then execute these steps inline (no user gate):
   ```bash
   INIT=$(node ~/.claude/nf/bin/nf-tools.cjs init quick "$DESCRIPTION")
   # Parse next_num, slug, task_dir, planner_model, executor_model from INIT
   mkdir -p "${task_dir}"
   node ~/.claude/nf/bin/nf-tools.cjs activity-set \
     "{\"activity\":\"quick\",\"sub_activity\":\"planning\"}"
   ```
   Then spawn nf-planner Task with the description and QUICK_DIR (same prompt as quick.md Step 5 standard mode).
   After planner returns, run quorum review (quick.md Step 5.7).
   After quorum approves, spawn nf-executor Task (description="Execute quick task {task_number}: {slug}", same prompt as quick.md Step 6).
   After executor completes, update STATE.md quick tasks table and commit (same as quick.md Steps 7-8).

   **Post-fix verification (cap: 1 retry):**
   1. Re-run `/nf:quorum-test` on the same plan to confirm CI now passes.
   2. If quorum-test PASS → mark plan complete, continue to next wave/phase normally.
   3. If quorum-test BLOCK again → do NOT auto-spawn another quick task. Ask user: "CI still failing after fix. Review and retry manually?"

6. **Execute checkpoint plans between waves** — see `<checkpoint_handling>`.

7. **Proceed to next wave.**
</step>

<step name="checkpoint_handling">
Plans with `autonomous: false` require user interaction.

When an executor agent returns a `checkpoint:verify` result, run this Bash command before spawning `/nf:quorum-test`, substituting `${PHASE_NUMBER}` and the current plan filename:
```bash
# Track checkpoint:verify activity
node ~/.claude/nf/bin/nf-tools.cjs activity-set \
  "{\"activity\":\"execute_phase\",\"sub_activity\":\"checkpoint_verify\",\"phase\":\"${PHASE_NUMBER}\",\"plan\":\"${PLAN_FILE}\",\"checkpoint\":\"checkpoint:verify\"}"
```

**Auto-mode checkpoint handling:**

Read auto-advance config:
```bash
AUTO_CFG=$(node ~/.claude/nf/bin/nf-tools.cjs config-get workflow.auto_advance 2>/dev/null || echo "true")
```

When executor returns a checkpoint AND `AUTO_CFG` is `"true"`:
- **human-verify** → Run quorum consensus gate:
  1. Extract checkpoint details: `what-built` and `how-to-verify` from the checkpoint task XML. These MUST be included verbatim in the quorum question so workers have sufficient context for informed decisions.
  2. Form your ADVISORY analysis (per CE-1 from quorum.md — not a vote in the tally): can each verification criterion be confirmed via available tools? State your analysis as 1-2 sentences to share with external voters.
  3. Run quorum inline — follow the canonical protocol in @core/references/quorum-dispatch.md:
     - Mode A — pure question
     - Question: "Checkpoint verification for auto-mode: [what-built]. Criteria: [how-to-verify]. Can each criterion be confirmed programmatically using available tools (grep, file inspection, test output, curl)? Vote APPROVE if all criteria are verifiable and met, or BLOCK if any criterion genuinely requires human eyes."
     - Include the full checkpoint task XML as context (what-built, how-to-verify, resume-signal) so workers can evaluate each criterion independently.
     - risk_level: Use `medium` (yielding FAN_OUT_COUNT=3) unless the task envelope specifies a different risk_level, in which case inherit it. This gives 2 external workers + Claude for a 3-way consensus.
     - **Exact YAML format for worker prompts** (from reference section 4):
       ```yaml
       slot: <slotName>
       round: <round_number>
       timeout_ms: <from $SLOT_TIMEOUTS or 300000>
       repo_dir: <absolute path to project root>
       mode: A
       question: "Checkpoint verification for auto-mode..."
       prior_positions: |
         [included from Round 2 onward]
       ```
     - Build `$DISPATCH_LIST` (quorum.md Adaptive Fan-Out: read risk_level → compute FAN_OUT_COUNT → take first FAN_OUT_COUNT-1 slots from active working list). Dispatch as sibling `nf-quorum-slot-worker` Tasks with `model="haiku", max_turns=100`
     - Synthesize results inline, deliberate up to 10 rounds per R3.3
     - **Unanimous gate (CE-3): 100% of valid external voters must vote APPROVE. Claude's advisory analysis is excluded from the tally. A BLOCK from any external voter is absolute (CE-2) — escalate to user.**
     - **FALLBACK-01 required:** If ANY dispatched slot returns UNAVAIL, follow the tiered fallback protocol from @core/references/quorum-dispatch.md §6 before evaluating consensus. Dispatch T1 (flat-rate CLI, `auth_type=sub`) then T2 (pay-per-use API) unused slots from the preflight `available_slots` list. Complete the FALLBACK_CHECKPOINT before proceeding.

     Fail-open: if all slots AND all fallback tiers are exhausted (UNAVAIL), treat as BLOCK (escalate to user).
  4. Route on quorum_result:
     - **APPROVED (unanimous)** → Log `⚡ Quorum-approved checkpoint: [what-built]`. Spawn continuation agent with `{user_response}` = `"approved"`.
     - **BLOCKED (any BLOCK vote)** → Present checkpoint to user (standard flow below). Log `⚡ Quorum blocked checkpoint — escalating to user`.
     - **ESCALATED** → Present checkpoint to user with escalation details. Log `⚡ Quorum escalated checkpoint — presenting to user`.
- **decision** → Auto-spawn continuation agent with `{user_response}` = first option from checkpoint details. Log `⚡ Auto-selected: [option]`.
- **human-action** → Present to user (existing behavior below). Auth gates cannot be automated.

If quorum-test returns BLOCK or REVIEW-NEEDED and you enter a `/nf:debug` loop, run this Bash command before each debug round, substituting `${PHASE_NUMBER}`, the current plan filename, and the debug round counter (1, 2, or 3):
```bash
# Track debug loop activity
node ~/.claude/nf/bin/nf-tools.cjs activity-set \
  "{\"activity\":\"execute_phase\",\"sub_activity\":\"debug_loop\",\"phase\":\"${PHASE_NUMBER}\",\"plan\":\"${PLAN_FILE}\",\"debug_round\":${DEBUG_ROUND}}"
```

**Standard flow (not auto-mode, or human-action type):**

1. Spawn agent for checkpoint plan
2. Agent runs until checkpoint task or auth gate → returns structured state
3. Agent return includes: completed tasks table, current task + blocker, checkpoint type/details, what's awaited
4. **Present to user:**
   ```
   ## Checkpoint: [Type]

   **Plan:** 03-03 Dashboard Layout
   **Progress:** 2/3 tasks complete

   [Checkpoint Details from agent return]
   [Awaiting section from agent return]
   ```

   After presenting `checkpoint:human-verify` to the user, run this Bash command, substituting `${PHASE_NUMBER}` and the current plan filename:
   ```bash
   # Track human-verify pause
   node ~/.claude/nf/bin/nf-tools.cjs activity-set \
     "{\"activity\":\"execute_phase\",\"sub_activity\":\"awaiting_human_verify\",\"phase\":\"${PHASE_NUMBER}\",\"plan\":\"${PLAN_FILE}\"}"
   ```

5. User responds: "approved"/"done" | issue description | decision selection
6. **Spawn continuation agent (NOT resume)** using continuation-prompt.md template:
   - `{completed_tasks_table}`: From checkpoint return
   - `{resume_task_number}` + `{resume_task_name}`: Current task
   - `{user_response}`: What user provided
   - `{resume_instructions}`: Based on checkpoint type
7. Continuation agent verifies previous commits, continues from resume point
8. Repeat until plan completes or user stops

**Why fresh agent, not resume:** Resume relies on internal serialization that breaks with parallel tool calls. Fresh agents with explicit state are more reliable.

**Checkpoints in parallel waves:** Agent pauses and returns while other parallel agents may complete. Present checkpoint, spawn continuation, wait for all before next wave.
</step>

<step name="aggregate_results">
After all waves:

```markdown
## Phase {X}: {Name} Execution Complete

**Waves:** {N} | **Plans:** {M}/{total} complete

| Wave | Plans | Status |
|------|-------|--------|
| 1 | plan-01, plan-02 | ✓ Complete |
| CP | plan-03 | ✓ Verified |
| 2 | plan-04 | ✓ Complete |

### Plan Details
1. **03-01**: [one-liner from SUMMARY.md]
2. **03-02**: [one-liner from SUMMARY.md]

### Issues Encountered
[Aggregate from SUMMARYs, or "None"]
```
</step>

<step name="close_parent_artifacts">
**For decimal/polish phases only (X.Y pattern):** Close the feedback loop by resolving parent UAT and debug artifacts.

**Skip if** phase number has no decimal (e.g., `3`, `04`) — only applies to gap-closure phases like `4.1`, `03.1`.

**1. Detect decimal phase and derive parent:**
```bash
# Check if phase_number contains a decimal
if [[ "$PHASE_NUMBER" == *.* ]]; then
  PARENT_PHASE="${PHASE_NUMBER%%.*}"
fi
```

**2. Find parent UAT file:**
```bash
PARENT_INFO=$(node ~/.claude/nf/bin/nf-tools.cjs find-phase "${PARENT_PHASE}" --raw)
# Extract directory from PARENT_INFO JSON, then find UAT file in that directory
```

**If no parent UAT found:** Skip this step (gap-closure may have been triggered by VERIFICATION.md instead).

**3. Update UAT gap statuses:**

Read the parent UAT file's `## Gaps` section. For each gap entry with `status: failed`:
- Update to `status: resolved`

**4. Update UAT frontmatter:**

If all gaps now have `status: resolved`:
- Update frontmatter `status: diagnosed` → `status: resolved`
- Update frontmatter `updated:` timestamp

**5. Resolve referenced debug sessions:**

For each gap that has a `debug_session:` field:
- Read the debug session file
- Update frontmatter `status:` → `resolved`
- Update frontmatter `updated:` timestamp
- Move to resolved directory:
```bash
mkdir -p .planning/debug/resolved
mv .planning/debug/{slug}.md .planning/debug/resolved/
```

**6. Commit updated artifacts:**
```bash
node ~/.claude/nf/bin/nf-tools.cjs commit "docs(phase-${PARENT_PHASE}): resolve UAT gaps and debug sessions after ${PHASE_NUMBER} gap closure" --files .planning/phases/*${PARENT_PHASE}*/*-UAT.md .planning/debug/resolved/*.md
```
</step>

<step name="verify_phase_goal">
Verify phase achieved its GOAL, not just completed tasks.

```bash
PHASE_REQ_IDS=$(node ~/.claude/nf/bin/nf-tools.cjs roadmap get-phase "${PHASE_NUMBER}" | jq -r '.section' | grep -i "Requirements:" | sed 's/.*Requirements:\*\*\s*//' | sed 's/[\[\]]//g')
```

Before spawning the verifier Task, run this Bash command to track the verification activity:
```bash
# Track phase verification activity
node ~/.claude/nf/bin/nf-tools.cjs activity-set \
  "{\"activity\":\"execute_phase\",\"sub_activity\":\"verifying_phase\",\"phase\":\"${PHASE_NUMBER}\"}"
```

**Formal check (before verifier spawn):**

Run the keyword-match scan and formal check before spawning the verifier. The scan is identical to the plan-phase Step 4.5 algorithm.
Reference matcher shape: `tr ' -/'` plus `grep -qF "$KEYWORD" || echo "$KEYWORD" | grep -qF`.

```bash
# Formal scope scan — uses centralized bin/formal-scope-scan.cjs
FORMAL_SPEC_CONTEXT=()
if [ -d ".planning/formal/spec" ]; then
  PHASE_DESC=$(node ~/.claude/nf/bin/nf-tools.cjs roadmap get-phase "${PHASE_NUMBER}" | jq -r '.goal // .phase_name')
  while IFS=$'\t' read -r mod modpath; do
    FORMAL_SPEC_CONTEXT+=("{\"module\":\"$mod\",\"path\":\"$modpath\"}")
  done < <(node bin/formal-scope-scan.cjs --description "$PHASE_DESC" --format lines)
  MATCH_COUNT=${#FORMAL_SPEC_CONTEXT[@]}
  if [ "$MATCH_COUNT" -gt 0 ]; then
    MATCHED_MODULES=$(printf '%s\n' "${FORMAL_SPEC_CONTEXT[@]}" | node -e "
      const lines=require('fs').readFileSync('/dev/stdin','utf8').trim().split('\n');
      console.log(lines.map(l=>JSON.parse(l).module).join(', '));
    ")
    echo ":: Formal scope scan: found ${MATCH_COUNT} module(s): ${MATCHED_MODULES}"
  else
    echo ":: Formal scope scan: no modules matched (fail-open)"
  fi
fi
```

```bash
# Module extraction (bash-only, no node dependency)
MODULES=""
for ctx_entry in "${FORMAL_SPEC_CONTEXT[@]}"; do
  MOD=$(echo "$ctx_entry" | sed 's/.*"module":"\([^"]*\)".*/\1/')
  MODULES="${MODULES:+${MODULES},}${MOD}"
done
```

```bash
# Conditional formal check invocation
if [ -n "$MODULES" ]; then
  echo "◆ Running formal check for modules: ${MODULES}"
  FORMAL_CHECK_OUTPUT=$(node bin/run-formal-check.cjs --modules="${MODULES}" 2>&1)
  FORMAL_CHECK_EXIT=$?
  FORMAL_CHECK_RESULT=$(echo "$FORMAL_CHECK_OUTPUT" | grep '^FORMAL_CHECK_RESULT=' | cut -d= -f2-)
  echo "$FORMAL_CHECK_OUTPUT"
  if [ "$FORMAL_CHECK_EXIT" -eq 0 ]; then
    echo "◆ Formal check: PASSED (or tooling absent — see result)"
  else
    echo "◆ Formal check: COUNTEREXAMPLE FOUND — see output above"
  fi
else
  FORMAL_CHECK_RESULT=null
  FORMAL_CHECK_EXIT=0
  echo "◆ Formal check: SKIPPED (no keyword-matched modules in .planning/formal/spec/)"
fi
```

**Fail-open clause:** If `node bin/run-formal-check.cjs` fails to launch (script not found, Node error): log `◆ Formal check: WARNING — run-formal-check.cjs errored. Skipping.` Set `FORMAL_CHECK_RESULT=null`, `FORMAL_CHECK_EXIT=0`. Continue without blocking.

```
Task(
  prompt="Verify phase {phase_number} goal achievement.
Phase directory: {phase_dir}
Phase goal: {goal from ROADMAP.md}
Phase requirement IDs: {phase_req_ids}
Check must_haves against actual codebase.
Cross-reference requirement IDs from PLAN frontmatter against REQUIREMENTS.md — every ID MUST be accounted for.

<formal_context>
${FORMAL_CHECK_RESULT !== "null" ?
`Formal check completed. Result (real TLC/Alloy/PRISM output — not estimated):
${FORMAL_CHECK_RESULT}

Rules:
- If failed > 0: set status: counterexample_found in VERIFICATION.md. This is a HARD FAILURE — no must_haves can pass when a counterexample was found. Include counterexamples array in VERIFICATION.md frontmatter under formal_check: key.
- If skipped only (failed == 0, passed == 0): tooling was absent. Include skip warning in VERIFICATION.md but proceed normally (do NOT set counterexample_found).
- If passed > 0 and failed == 0: formal checks passed. Include pass/skip counts in VERIFICATION.md as evidence under formal_check: frontmatter key.` :
`No formal scope matched this phase (FORMAL_SPEC_CONTEXT was empty) or tooling unavailable. Skip formal verification section entirely.`}
</formal_context>

Create VERIFICATION.md.",
  subagent_type="nf-verifier",
  model="{verifier_model}",
  description="Verify phase {phase_number}"
)
```

Read status:
```bash
grep "^status:" "$PHASE_DIR"/*-VERIFICATION.md | cut -d: -f2 | tr -d ' '
```

| Status | Action |
|--------|--------|
| `passed` | → cleanup_review → update_roadmap |
| `human_needed` | Present items for human testing, get approval or feedback |
| `gaps_found` | Present gap summary, offer `/nf:plan-phase {phase} --gaps` |
| `counterexample_found` | → override prompt (see below) |

**If human_needed:**

**Automation-first attempt (before quorum):**

Before dispatching quorum workers, attempt to resolve each human_needed item using available automation tools:

a. Read each item from the `human_verification` section of VERIFICATION.md.
b. For each item, classify whether it can be verified automatically:
   - **URL/UI checks**: Use agent-browser or Playwright to navigate, screenshot, and verify DOM state
   - **API checks**: Use curl to verify endpoint responses
   - **File/artifact checks**: Use file reads and grep to verify existence and content
   - **Build/test checks**: Run relevant test or build commands
c. Attempt automated verification for each classifiable item.
d. If ALL items pass automated verification: treat as `passed` (skip quorum entirely). Log: `Automation resolved all human_needed items — treating as passed`. Proceed to update_roadmap.
e. If SOME items remain unresolved: include only the unresolved items in the quorum question (reduce quorum scope to genuinely ambiguous items).
f. If NO items could be automated: proceed to quorum as before (existing flow unchanged).

Before escalating to the user, run a quorum resolution loop to attempt automated resolution:

1. Read the full `human_verification` section from `${PHASE_DIR}/${PHASE_NUM}-VERIFICATION.md`.

2. Form your ADVISORY analysis (per CE-1 — not a vote in the tally): can each item be verified via available tools (grep, file reads, quorum-test)? State your analysis as 1-2 sentences to share with external voters.

3. Run quorum inline — follow the canonical protocol in @core/references/quorum-dispatch.md:
   - Mode A — pure question
   - Question: "Can each human_needed item from phase ${PHASE_NUMBER} be resolved using available tools (grep, file inspection, quorum-test)? Vote APPROVE (can resolve programmatically) or BLOCK (genuinely needs human eyes)."
   - Include the full `human_verification` section as context
   - **Exact YAML format for worker prompts** (from reference section 4):
     ```yaml
     slot: <slotName>
     round: <round_number>
     timeout_ms: <from $SLOT_TIMEOUTS or 300000>
     repo_dir: <absolute path to project root>
     mode: A
     question: "Can each human_needed item from phase..."
     prior_positions: |
       [included from Round 2 onward]
     ```
   - Build `$DISPATCH_LIST` first (quorum.md Adaptive Fan-Out: read risk_level → compute FAN_OUT_COUNT → take first FAN_OUT_COUNT-1 slots from active working list). Then dispatch `$DISPATCH_LIST` as sibling `nf-quorum-slot-worker` Tasks with `model="haiku", max_turns=100` — do NOT dispatch slots outside `$DISPATCH_LIST`
   - Synthesize results inline, deliberate up to 10 rounds per R3.3
   - **FALLBACK-01 required:** If ANY dispatched slot returns UNAVAIL, follow the tiered fallback protocol from @core/references/quorum-dispatch.md §6 before evaluating consensus. Dispatch T1 (flat-rate CLI, `auth_type=sub`) then T2 (pay-per-use API) unused slots from the preflight `available_slots` list. Complete the FALLBACK_CHECKPOINT before proceeding.

   Fail-open: if all slots AND all fallback tiers are exhausted (UNAVAIL), treat as BLOCK (escalate to user).

4. Route on quorum_result:
   - **APPROVED** → Consensus reached. Treat as `passed`. Log: `Quorum resolved human_needed items — treating as passed`. Proceed to → update_roadmap.
   - **BLOCKED** → Cannot auto-resolve. Escalate to user with the standard block below.
   - **ESCALATED** → Escalate to user with escalation details appended to the standard block.

**If escalating to user (quorum could not resolve):**
```
## Phase {X}: {Name} — Human Verification Required

All automated checks passed. Quorum attempted resolution but could not fully verify {N} items:

{From VERIFICATION.md human_verification section}

"approved" → continue | Report issues → gap closure
```

**If gaps_found:**

Read the gaps section from `${PHASE_DIR}/${PHASE_NUM}-VERIFICATION.md`. Extract each gap as a 1-sentence summary (keep compact — orchestrator context budget is ~10-15%).

Form your ADVISORY analysis (per CE-1 — not a vote in the tally): are these gaps auto-resolvable? State your analysis as 1-2 sentences to share with external voters.

Run R3 quorum inline — follow the canonical protocol in @core/references/quorum-dispatch.md:
- Mode A — compact prompt to preserve context budget
- Question: "Phase {PHASE_NUMBER} verification found {N} gaps. Are these auto-resolvable via plan-phase --gaps Task spawn, or do they require human review? Gaps: {1-sentence-per-gap — max 20 words each}. Vote APPROVE (auto-resolvable) or BLOCK (needs human)."
- **Exact YAML format for worker prompts** (from reference section 4):
  ```yaml
  slot: <slotName>
  round: <round_number>
  timeout_ms: <from $SLOT_TIMEOUTS or 300000>
  repo_dir: <absolute path to project root>
  mode: A
  question: "Phase {PHASE_NUMBER} verification found {N} gaps..."
  prior_positions: |
    [included from Round 2 onward]
  ```
- Build `$DISPATCH_LIST` first (quorum.md Adaptive Fan-Out: read risk_level → compute FAN_OUT_COUNT → take first FAN_OUT_COUNT-1 slots from active working list). Then dispatch `$DISPATCH_LIST` as sibling `nf-quorum-slot-worker` Tasks with `model="haiku", max_turns=100` — do NOT dispatch slots outside `$DISPATCH_LIST`
- Synthesize results inline, deliberate up to 10 rounds per R3.3

After quorum vote completes, update the scoreboard BEFORE spawning any Task:
Use the correct identity flags — `update-scoreboard` rejects a slot passed via `--model`:
- **native CLI model** (codex/gemini/opencode/copilot/claude): `--model <family>`
- **MCP slot instance** (e.g. `gemini-1`, `claude-2`): `--slot <slot> --model-id <id from health_check>` (NOT `--model`)
`--result` is the prediction-accuracy code (TP/TN/FP/FN); this gating vote has no ground truth, so pass `--result ""` (not scored) — the decision lives in `--verdict`.
```bash
node "$HOME/.claude/nf-bin/update-scoreboard.cjs" \
  --model <family> \
  --result "" \
  --task "execute-phase-{PHASE_NUMBER}" \
  --round <round_number> \
  --verdict <APPROVE|BLOCK> \
  --task-description "Phase {PHASE_NUMBER} verification gaps: auto-resolvable vs human-needed"
```

Route on quorum_result:
- **APPROVED**: Auto-spawn plan-phase --gaps Task:
  ```
  Task(
    prompt="Run /nf:plan-phase {PHASE_NUMBER} --gaps --auto",
    subagent_type="general-purpose",
    description="Plan gap closure for phase {PHASE_NUMBER}"
  )
  ```
  Log: `⚡ Quorum approved auto-fix — spawning plan-phase {PHASE_NUMBER} --gaps`

- **BLOCKED**: Escalate to user with gap report AND quorum diagnosis:
  ```
  ## ⚠ Phase {X}: {Name} — Gaps Found

  **Score:** {N}/{M} must-haves verified
  **Report:** {phase_dir}/{phase_num}-VERIFICATION.md

  ### What's Missing
  {Gap summaries from VERIFICATION.md}

  ### Quorum Diagnosis
  Quorum could not confirm auto-resolution:
  {quorum_block_reason — specific model objection(s)}

  ---
  ## ▶ Next Up

  `/nf:plan-phase {X} --gaps`

  <sub>`/clear` first → fresh context window</sub>

  Also: `cat {phase_dir}/{phase_num}-VERIFICATION.md` — full report
  Also: `/nf:verify-work {X}` — manual testing first
  ```

Gap closure cycle: `/nf:plan-phase {X} --gaps` reads VERIFICATION.md → creates gap plans with `gap_closure: true` → user runs `/nf:execute-phase {X} --gaps-only` → verifier re-runs.

**If counterexample_found:**

Read counterexample details from VERIFICATION.md:
```bash
grep "formal_check:" -A 20 "${PHASE_DIR}"/*-VERIFICATION.md | head -25
```

Present to user:
```
## Formal Counterexample Found — Phase {PHASE_NUMBER}

A formal model checker (TLC/Alloy/PRISM) found counterexamples:

{counterexamples from VERIFICATION.md formal_check section}

This is a hard block. You have two options:

1. **Investigate and fix**: Address the counterexample before proceeding.
   The counterexample indicates the formal model was violated.

2. **Override with acknowledgment**: Provide a reason why this is acceptable
   to proceed despite the formal violation. Your reason will be written to
   VERIFICATION.md with a timestamp as an audit trail.

Type your override reason, or type "abort" to stop.
```

If user provides a non-empty reason (not "abort"):
1. Spawn a continuation verifier Task to write the override record:
```
Task(
  prompt="Update VERIFICATION.md at {phase_dir}/{phase_num}-VERIFICATION.md.
User acknowledged counterexample block with reason: '{override_reason}'.
Write to VERIFICATION.md frontmatter a new field:
counterexample_override:
  acknowledged_at: {ISO timestamp now}
  reason: '{override_reason}'
  override_by: user
Also change status: from counterexample_found to passed.
Preserve ALL other existing VERIFICATION.md content unchanged.",
  subagent_type="nf-verifier",
  model="{verifier_model}",
  description="Write counterexample override to VERIFICATION.md"
)
```
2. After Task completes, read updated VERIFICATION.md status:
```bash
grep "^status:" "${PHASE_DIR}"/*-VERIFICATION.md | cut -d: -f2 | tr -d ' '
```
3. Confirm `counterexample_override:` field present:
```bash
grep "counterexample_override:" "${PHASE_DIR}"/*-VERIFICATION.md
```
4. If status is now `passed` and `counterexample_override:` present → continue to update_roadmap.
5. If field is missing → log error: "Override audit trail not written. Do not advance." Report to user.

If user types "abort":
- Report: "Phase {PHASE_NUMBER} halted due to formal counterexample. STATE.md position unchanged."
- Do NOT call update_roadmap.
- Do NOT advance phase completion.

Key constraint: ANY override MUST produce a `counterexample_override:` entry with timestamp and reason in VERIFICATION.md. Execute-phase confirms the field exists before advancing. This is the ENF-02 audit trail requirement — there is NO silent bypass path.
</step>

<step name="cleanup_review">
**Spawn Haiku-based cleanup subagent after successful verification.**

This step runs ONLY when verification status is `passed` (or resolved to passed via quorum/override). It is non-blocking -- if cleanup fails, phase completion continues normally.

**1. Determine files modified in the phase:**

```bash
# Get files modified across all phase commits
MODIFIED_FILES=$(git diff --name-only $(git log --all --oneline --grep="${PHASE_NUMBER}" --format="%H" | tail -1)^..HEAD 2>/dev/null | head -20)
```

If git diff fails or returns empty, fall back to extracting `files_modified` from plan SUMMARY files in the phase directory.

**2. Spawn cleanup subagent:**

```
Task(
  subagent_type="general-purpose",
  model="claude-haiku-4-5-20251001",
  prompt="
    <workflow>
    @core/workflows/cleanup-review.md
    </workflow>

    <context>
    Phase directory: {phase_dir}
    Phase name: {phase_name}
    Files modified in this phase:
    {modified_files_list}
    </context>

    Review the listed files for redundancy, dead code, and over-defensive patterns.
    Write CLEANUP-REPORT.md to the phase directory.
  ",
  description="Cleanup review for phase {phase_number}"
)
```

**3. Handle result:**

- If cleanup completes and CLEANUP-REPORT.md exists:
  ```bash
  FINDINGS=$(grep "Total:" "${PHASE_DIR}/CLEANUP-REPORT.md" 2>/dev/null || echo "unknown")
  echo "Cleanup review complete: ${FINDINGS}"
  ```
- If cleanup fails or CLEANUP-REPORT.md is not generated:
  ```
  echo "Cleanup review skipped: subagent did not produce a report. Continuing with phase completion."
  ```

The cleanup report is informational only. Do NOT fail the phase or block update_roadmap regardless of cleanup outcome.
</step>

<step name="update_roadmap">
**Mark phase complete and update all tracking files:**

```bash
COMPLETION=$(node ~/.claude/nf/bin/nf-tools.cjs phase complete "${PHASE_NUMBER}" 2>&1)
COMPLETION_EXIT=$?
```

**If `COMPLETION_EXIT` is non-zero and output contains "VERIFICATION.md":**

The CLI's verification gate blocked completion because `verify_phase_goal` was skipped or failed. Auto-recover by spawning the verifier now:

1. Log: `⚡ Verification gate triggered — spawning nf-verifier before phase completion`
2. Run the full `verify_phase_goal` step (above) — formal check + nf-verifier Task spawn + status routing.
3. If verifier produces VERIFICATION.md with `status: passed` → retry `phase complete`:
   ```bash
   COMPLETION=$(node ~/.claude/nf/bin/nf-tools.cjs phase complete "${PHASE_NUMBER}")
   ```
4. If verifier produces `gaps_found` or `human_needed` → route through existing `verify_phase_goal` handlers (do NOT retry `phase complete`).

This ensures the verifier always runs, even if earlier steps were skipped due to context limits or workflow version mismatch.

**If `COMPLETION_EXIT` is non-zero for any other reason:** Report the error and stop.

The CLI handles:
- Marking phase checkbox `[x]` with completion date
- Updating Progress table (Status → Complete, date)
- Updating plan count to final
- Advancing STATE.md to next phase
- Updating REQUIREMENTS.md traceability

Extract from result: `next_phase`, `next_phase_name`, `is_last_phase`.

After the `phase complete` call succeeds, run this Bash command to clear the activity state:
```bash
# Clear activity on successful completion
node ~/.claude/nf/bin/nf-tools.cjs activity-clear
```

```bash
node ~/.claude/nf/bin/nf-tools.cjs commit "docs(phase-{X}): complete phase execution" --files .planning/ROADMAP.md .planning/STATE.md .planning/REQUIREMENTS.md {phase_dir}/*-VERIFICATION.md
```
</step>

<step name="offer_next">

**Exception:** If `gaps_found`, the `verify_phase_goal` step handles routing via quorum (QUORUM-02). If quorum approved auto-fix, plan-phase --gaps was already spawned inline. If quorum blocked (escalated to user), the user sees the gap report — no additional routing needed. In both cases, skip auto-advance.

**Auto-advance detection:**

1. Parse `--auto` flag from $ARGUMENTS
2. Read `workflow.auto_advance` from config:
   ```bash
   AUTO_CFG=$(node ~/.claude/nf/bin/nf-tools.cjs config-get workflow.auto_advance 2>/dev/null || echo "true")
   ```

**If `--auto` flag present OR `AUTO_CFG` is true (AND verification passed with no gaps):**

```
╔══════════════════════════════════════════╗
║  AUTO-ADVANCING → TRANSITION             ║
║  Phase {X} verified, continuing chain    ║
╚══════════════════════════════════════════╝
```

Execute the transition workflow inline (do NOT use Task — orchestrator context is ~10-15%, transition needs phase completion data already in context):

Read and follow `~/.claude/nf/workflows/transition.md`, passing through the `--auto` flag so it propagates to the next phase invocation.

**If neither `--auto` nor `AUTO_CFG` is true:**

The workflow ends. The user runs `/nf:progress` or invokes the transition workflow manually.
</step>

</process>

<context_efficiency>
Orchestrator: ~10-15% context. Subagents: fresh 200k each. No polling (Task blocks). No context bleed.
</context_efficiency>

<failure_handling>
- **classifyHandoffIfNeeded false failure:** Agent reports "failed" but error is `classifyHandoffIfNeeded is not defined` → Claude Code bug, not nForma. Spot-check (SUMMARY exists, commits present) → if pass, treat as success
- **CI failures with diagnosed root causes:** Executor SUMMARY.md contains sections with "Root Cause:", "Diagnosed", "Bug N —", "CI Failures", or "Deferred: CI fixes" → read diagnosis → auto-spawn quick task using init quick + nf-planner + nf-executor sequence (quick.md Steps 2-6 pattern), no user gate → resume phase execution after quick task completes
- **Agent fails mid-plan:** Missing SUMMARY.md → report, ask user how to proceed
- **Dependency chain breaks:** Wave 1 fails → Wave 2 dependents likely fail → user chooses attempt or skip
- **All agents in wave fail:** Systemic issue → stop, report for investigation
- **Checkpoint unresolvable:** "Skip this plan?" or "Abort phase execution?" → record partial progress in STATE.md
</failure_handling>

<resumption>
Re-run `/nf:execute-phase {phase}` → discover_plans finds completed SUMMARYs → skips them → resumes from first incomplete plan → continues wave execution.

STATE.md tracks: last completed plan, current wave, pending checkpoints.
</resumption>

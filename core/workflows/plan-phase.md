<purpose>
Create executable phase prompts (PLAN.md files) for a roadmap phase with integrated research and verification. Default flow: Research (if needed) -> Plan -> Verify -> Done. Orchestrates nf-phase-researcher, nf-planner, and nf-plan-checker agents with a revision loop (max 3 iterations).
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.

@~/.claude/nf/references/ui-brand.md
</required_reading>

<process>

## 1. Initialize

Load all context in one call (paths only to minimize orchestrator context):

```bash
INIT=$(node ~/.claude/nf/bin/nf-tools.cjs init plan-phase "$PHASE")
```

Parse JSON for: `researcher_model`, `planner_model`, `checker_model`, `research_enabled`, `plan_checker_enabled`, `nyquist_validation_enabled`, `commit_docs`, `phase_found`, `phase_dir`, `phase_number`, `phase_name`, `phase_slug`, `padded_phase`, `has_research`, `has_context`, `has_plans`, `plan_count`, `planning_exists`, `roadmap_exists`.

**File paths (for <files_to_read> blocks):** `state_path`, `roadmap_path`, `requirements_path`, `context_path`, `research_path`, `verification_path`, `uat_path`. These are null if files don't exist.

**If `planning_exists` is false:** Error — run `/nf:new-project` first.

## 2. Parse and Normalize Arguments

Extract from $ARGUMENTS: phase number (integer or decimal like `2.1`), flags (`--research`, `--skip-research`, `--gaps`, `--skip-verify`).

**If no phase number:** Detect next unplanned phase from roadmap.

**If `phase_found` is false:** Validate phase exists in ROADMAP.md. If valid, create the directory using `phase_slug` and `padded_phase` from init:
```bash
mkdir -p ".planning/phases/${padded_phase}-${phase_slug}"
```

**Existing artifacts from init:** `has_research`, `has_plans`, `plan_count`.

## 3. Validate Phase

```bash
PHASE_INFO=$(node ~/.claude/nf/bin/nf-tools.cjs roadmap get-phase "${PHASE}")
```

**If `found` is false:** Error with available phases. **If `found` is true:** Extract `phase_number`, `phase_name`, `goal` from JSON.

## 4. Load CONTEXT.md

Check `context_path` from init JSON.

If `context_path` is not null, display: `Using phase context from: ${context_path}`

**If `context_path` is null (no CONTEXT.md exists):**

**If `--auto` flag is present:** Log `⚡ Auto-continuing without context (--auto mode)` and proceed to step 5 — no question asked.

**Otherwise:** Use AskUserQuestion:
- header: "No context"
- question: "No CONTEXT.md found for Phase {X}. Plans will use research and requirements only — your design preferences won't be included. Continue or capture context first?"
- options:
  - "Continue without context" — Plan using research + requirements only
  - "Run discuss-phase first" — Capture design decisions before planning

If "Continue without context": Proceed to step 5.
If "Run discuss-phase first": Display `/nf:discuss-phase {X}` and exit workflow.

## 4.5. Design Impact Analysis

Before spawning the researcher, run `design-impact.cjs` to assess the three-layer git diff impact of recent changes. This provides context on which formal layers (L1 instrumentation, L2 state transitions, L3 hazards) are affected by pending or recent changes.

```bash
DESIGN_IMPACT=""
if command -v node >/dev/null 2>&1; then
  DESIGN_IMPACT=$(node ~/.claude/nf-bin/design-impact.cjs --json --project-root="$(pwd)" 2>/dev/null || node bin/design-impact.cjs --json --project-root="$(pwd)" 2>/dev/null || echo "")
fi
```

If the script returns JSON, extract `impacted_layers` and `summary`. Pass this as additional context to the researcher and planner so they account for formal verification impact. Fail-open: if the script is not found, errors, or returns empty, skip silently and proceed.

## 4.6. Formal Scope Scan

Before spawning the researcher, scan `.planning/formal/spec/` for modules matching the phase description using centralized `bin/formal-scope-scan.cjs`. This populates `$FORMAL_SPEC_CONTEXT` for use in Step 8 (planner) and Step 10 (checker).

**Fail-open:** If `.planning/formal/spec/` does not exist, `formal-scope-scan.cjs` returns empty and FORMAL_SPEC_CONTEXT stays empty.

```bash
FORMAL_SPEC_CONTEXT=()
if [ -d ".planning/formal/spec" ]; then
  PHASE_DESC=$(node ~/.claude/nf/bin/nf-tools.cjs roadmap get-phase "${PHASE}" | jq -r '.goal // .phase_name')
  while IFS=$'\t' read -r mod modpath; do
    FORMAL_SPEC_CONTEXT+=("{\"module\":\"$mod\",\"path\":\"$modpath\"}")
  done < <(node bin/formal-scope-scan.cjs --description "$PHASE_DESC" --no-l3 --format lines)
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

Store `$FORMAL_SPEC_CONTEXT` for use in steps 7, 8, 10.

## 4.7. Repowise Context Packing

Before spawning the researcher, pack Repowise intelligence context for the phase. This provides hotspot risk data, co-change coupling, and skeleton views to the researcher and planner.

```bash
REPOWISE_CONTEXT=""
if command -v node >/dev/null 2>&1; then
  REPOWISE_CONTEXT=$(node ~/.claude/nf-bin/context-packer.cjs --hotspot --cochange --project-root="$(pwd)" 2>/dev/null || node bin/repowise/context-packer.cjs --hotspot --cochange --project-root="$(pwd)" 2>/dev/null || echo "")
fi
```

If the script returns XML or JSON, pass the context as additional context to the researcher and planner. Fail-open: if the script is not found, errors, or returns empty, skip silently and proceed.

Store `$REPOWISE_CONTEXT` for use in steps 5, 8.

## 5. Handle Research

**Skip if:** `--gaps` flag, `--skip-research` flag, or `research_enabled` is false (from init) without `--research` override.

**Research always runs** (overwriting any existing RESEARCH.md unless skipped via flags above). Research is not cached between plan-phase invocations.

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► RESEARCHING PHASE {X}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning researcher...
```

### Spawn nf-phase-researcher

```bash
node ~/.claude/nf/bin/nf-tools.cjs activity-set \
  "{\"activity\":\"plan_phase\",\"sub_activity\":\"researching\",\"phase\":${PHASE_NUMBER}}"
```

```bash
PHASE_DESC=$(node ~/.claude/nf/bin/nf-tools.cjs roadmap get-phase "${PHASE}" | jq -r '.section')
PHASE_REQ_IDS=$(node ~/.claude/nf/bin/nf-tools.cjs roadmap get-phase "${PHASE}" | jq -r '.section // empty' | grep -i "Requirements:" | head -1 | sed 's/.*Requirements:\*\*\s*//' | sed 's/[\[\]]//g' | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -v '^$' | tr '\n' ',' | sed 's/,$//')
```

Research prompt:

```markdown
<objective>
Research how to implement Phase {phase_number}: {phase_name}
Answer: "What do I need to know to PLAN this phase well?"
</objective>

<files_to_read>
- {context_path} (USER DECISIONS from /nf:discuss-phase)
- {requirements_path} (Project requirements)
- {state_path} (Project decisions and history)
</files_to_read>

<additional_context>
**Phase description:** {phase_description}
**Phase requirement IDs (MUST address):** {phase_req_ids}

**Project instructions:** Follow project-specific guidelines from CLAUDE.md context (already loaded)
**Project skills:** Check .agents/skills/ directory (if exists) — read SKILL.md files, research should account for project skill patterns

**Nyquist Validation:** If `nyquist_validation_enabled` is true (from INIT JSON), your RESEARCH.md MUST include a `## Validation Architecture` section covering:
- Test framework and commands (quick run command, full suite command)
- Wave 0 test scaffolding requirements (which test files need to exist before implementation starts)
- Per-task test type (unit / integration / smoke / manual) for each planned task
</additional_context>

<output>
Write to: {phase_dir}/{phase_num}-RESEARCH.md
</output>
```

> **Note:** Use the Task tool to spawn this sub-agent. Do NOT invoke any Skill tool (e.g., `mcp__gemini-1__gemini`, `mcp__codex-1__review`, `mcp__opencode-1__opencode`, `mcp__copilot-1__copilot`) as a substitute. Skill tool calls do not spawn sub-agents — they call external models directly, bypassing the agent system.

```
Task(
  prompt="First, read ~/.claude/agents/nf-phase-researcher.md for your role and instructions.\n\n" + research_prompt,
  subagent_type="general-purpose",
  model="{researcher_model}",
  description="Research Phase {phase}"
)
```

### Handle Researcher Return

- **`## RESEARCH COMPLETE`:** Display confirmation, continue to step 6
- **`## RESEARCH BLOCKED`:** Display blocker, offer: 1) Provide context, 2) Skip research, 3) Abort

## 5.5. Create Validation Strategy (if Nyquist enabled)

**Skip if:** `nyquist_validation_enabled` is false from INIT JSON.

After researcher completes, check if RESEARCH.md contains a Validation Architecture section:

```bash
grep -l "## Validation Architecture" "${PHASE_DIR}"/*-RESEARCH.md 2>/dev/null
```

**If found:**
1. Read validation template from `~/.claude/nf/templates/VALIDATION.md`
2. Write to `${PHASE_DIR}/${PADDED_PHASE}-VALIDATION.md`
3. Fill frontmatter: replace `{N}` with phase number, `{phase-slug}` with phase slug, `{date}` with current date
4. If `commit_docs` is true:
```bash
node ~/.claude/nf/bin/nf-tools.cjs commit "docs(phase-${PHASE}): add validation strategy" --files "${PHASE_DIR}/${PADDED_PHASE}-VALIDATION.md"
```

**If not found (and nyquist enabled):**

HALT with error:
```
ERROR: Nyquist validation is enabled but no "## Validation Architecture" section was found in RESEARCH.md.
       VALIDATION.md cannot be generated.

To fix: Either
  1. Re-run research (the researcher must include ## Validation Architecture in its output), or
  2. Disable Nyquist: node ~/.claude/nf/bin/nf-tools.cjs config-set workflow.nyquist_validation false

Do NOT proceed to plan creation without VALIDATION.md when nyquist_validation_enabled is true.
```

## 5.6. Envelope Init (ENV-01)

After researcher completes and VALIDATION.md is written:

```bash
# Initialize task envelope with research context
TASK_ENVELOPE_ENABLED=$(node ~/.claude/nf/bin/nf-tools.cjs config-get task_envelope_enabled 2>/dev/null || echo "true")
if [ "$TASK_ENVELOPE_ENABLED" = "true" ]; then
  PHASE_NUM="${PADDED_PHASE}"
  RISK_LEVEL=$(grep -oE '"risk_level"\s*:\s*"(low|medium|high)"' "${PHASE_DIR}/${PADDED_PHASE}-RESEARCH.md" 2>/dev/null | grep -oE '(low|medium|high)' | head -1 || echo "medium")
  OBJECTIVE=$(node -e "const fs=require('fs'); const r=fs.readFileSync('${PHASE_DIR}/${PADDED_PHASE}-RESEARCH.md','utf8'); const m=r.match(/^## Summary\n\n([^\n]+)/m); console.log(m ? m[1].substring(0,200) : 'phase objective')" 2>/dev/null || echo "phase objective")
  node bin/task-envelope.cjs init \
    --phase "${PHASE_NUM}" \
    --objective "${OBJECTIVE}" \
    --risk-level "${RISK_LEVEL:-medium}"
fi
```

## 6. Check Existing Plans

```bash
ls "${PHASE_DIR}"/*-PLAN.md 2>/dev/null
```

**If exists:** Offer: 1) Add more plans, 2) View existing, 3) Replan from scratch.

## 7. Use Context Paths from INIT

Extract from INIT JSON:

```bash
STATE_PATH=$(echo "$INIT" | jq -r '.state_path // empty')
ROADMAP_PATH=$(echo "$INIT" | jq -r '.roadmap_path // empty')
REQUIREMENTS_PATH=$(echo "$INIT" | jq -r '.requirements_path // empty')
RESEARCH_PATH=$(echo "$INIT" | jq -r '.research_path // empty')
VERIFICATION_PATH=$(echo "$INIT" | jq -r '.verification_path // empty')
UAT_PATH=$(echo "$INIT" | jq -r '.uat_path // empty')
CONTEXT_PATH=$(echo "$INIT" | jq -r '.context_path // empty')
```

## 8. Spawn nf-planner Agent

```bash
node ~/.claude/nf/bin/nf-tools.cjs activity-set \
  "{\"activity\":\"plan_phase\",\"sub_activity\":\"planning\",\"phase\":${PHASE_NUMBER}}"
```

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► PLANNING PHASE {X}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning planner...
```

Planner prompt:

```markdown
<planning_context>
**Phase:** {phase_number}
**Mode:** {standard | gap_closure}

<files_to_read>
- {state_path} (Project State)
- {roadmap_path} (Roadmap)
- {requirements_path} (Requirements)
- {context_path} (USER DECISIONS from /nf:discuss-phase)
- {research_path} (Technical Research)
- {verification_path} (Verification Gaps - if --gaps)
- {uat_path} (UAT Gaps - if --gaps)
${FORMAL_SPEC_CONTEXT.length > 0 ? FORMAL_SPEC_CONTEXT.map(f => `- ${f.path} (Formal invariants for module: ${f.module})`).join('\n') : ''}
</files_to_read>

**Phase requirement IDs (every ID MUST appear in a plan's `requirements` field):** {phase_req_ids}

**Project instructions:** Follow project-specific guidelines from CLAUDE.md context (already loaded)
**Project skills:** Check .agents/skills/ directory (if exists) — read SKILL.md files, plans should account for project skill rules

<state_machine_bias>
When the phase involves implementing logic with 3+ distinct states and conditional transitions, prefer a state machine library over ad-hoc if/else chains. Match complexity to the problem: flat FSMs get lightweight libraries (javascript-state-machine, transitions, looplab/fsm), complex workflows get statechart libraries (XState, sismic, Spring Statemachine). State machines can be auto-transpiled to TLA+ via bin/fsm-to-tla.cjs (28 frameworks across 13 languages). See .claude/rules/state-machine-bias.md for the full framework selection table. If the plan introduces state-transition logic, include a task to define the state machine and a follow-up task to run bin/fsm-to-tla.cjs for formal verification.
</state_machine_bias>

<formal_context>
${FORMAL_SPEC_CONTEXT.length > 0 ?
`Relevant formal modules identified: ${FORMAL_SPEC_CONTEXT.map(f => f.module).join(', ')}

Constraints:
- Read the injected invariants.md files and identify which invariants apply to this task
- MUST declare \`formal_artifacts:\` in EVERY plan frontmatter (required field when FORMAL_SPEC_CONTEXT is non-empty):
  - \`none\` — task does not create or modify .planning/formal/ files
  - \`update: [list of .planning/formal/ file paths]\` — task modifies existing .planning/formal/ files
  - \`create: [list of {path, type (tla|alloy|prism), description}]\` — task creates new .planning/formal/ files
- Plan tasks MUST NOT violate the identified invariants` :
`No formal modules matched this task. Declare \`formal_artifacts: none\` in plan frontmatter.`}
</formal_context>
</planning_context>

<binding_rule id="R9">
PLAN must_haves truths MUST be derived from ROADMAP success_criteria for this phase.
You MUST NOT:
- Invent truths that are weaker than ROADMAP success_criteria
- Reduce the count of truths below the count of success_criteria
- Soften language ("must" -> "should", "all" -> "some")
- Narrow the scope of what a truth covers compared to its source criterion

If ROADMAP has no success_criteria for this phase, derive truths from the phase goal
using goal-backward methodology. The truths must be AT LEAST as strong as the goal implies.

Any truth that relaxes a ROADMAP success criterion is a plan defect, not an optimization.
</binding_rule>

<downstream_consumer>
Output consumed by /nf:execute-phase. Plans need:
- Frontmatter (wave, depends_on, files_modified, autonomous)
- Tasks in XML format
- Verification criteria
- must_haves for goal-backward verification
</downstream_consumer>

<quality_gate>
- [ ] PLAN.md files created in phase directory
- [ ] Each plan has valid frontmatter
- [ ] Tasks are specific and actionable
- [ ] Dependencies correctly identified
- [ ] Waves assigned for parallel execution
- [ ] must_haves derived from phase goal
</quality_gate>
```

> **Note:** Use the Task tool to spawn this sub-agent. Do NOT invoke any Skill tool (e.g., `mcp__gemini-1__gemini`, `mcp__codex-1__review`, `mcp__opencode-1__opencode`, `mcp__copilot-1__copilot`) as a substitute. Skill tool calls do not spawn sub-agents — they call external models directly, bypassing the agent system.

```
Task(
  prompt="First, read ~/.claude/agents/nf-planner.md for your role and instructions.\n\n" + filled_prompt,
  subagent_type="general-purpose",
  model="{planner_model}",
  description="Plan Phase {phase}"
)
```

## 8.4. Envelope Update — Plan Section (ENV-02)

After planner completes and PLAN.md files are committed:

```bash
# Update envelope with plan metadata
TASK_ENVELOPE_ENABLED=$(node ~/.claude/nf/bin/nf-tools.cjs config-get task_envelope_enabled 2>/dev/null || echo "true")
if [ "$TASK_ENVELOPE_ENABLED" = "true" ]; then
  # Find first PLAN.md path for this phase
  PLAN_PATH=$(ls "${PHASE_DIR}/${PADDED_PHASE}-"*"-PLAN.md" 2>/dev/null | head -1 || echo "")
  if [ -n "$PLAN_PATH" ]; then
    node bin/task-envelope.cjs update \
      --section plan \
      --phase "${PADDED_PHASE}" \
      --plan-path "${PLAN_PATH}"
  fi
fi
```

## 8.5 Run QUORUM with R3.6 (per CLAUDE.md R3 + R3.6)

Before presenting planner output to the user, run QUORUM as required by R3.1.
R3.6 wraps this in an improvement-iteration loop (up to 10 iterations).

Set envelope_path for quorum context (ENV-02 context injection):

```bash
ENVELOPE_FILE="${PHASE_DIR}/task-envelope.json"
if [ -f "$ENVELOPE_FILE" ]; then
  ENVELOPE_PATH="$PWD/$ENVELOPE_FILE"
else
  ENVELOPE_PATH=""
fi
```

Initialize: `improvement_iteration = 0`

**LOOP** (while `improvement_iteration <= 10`):

```bash
node ~/.claude/nf/bin/nf-tools.cjs activity-set \
  "{\"activity\":\"plan_phase\",\"sub_activity\":\"quorum\",\"phase\":${PHASE_NUMBER},\"quorum_round\":${improvement_iteration + 1}}"
```

Form your ADVISORY analysis on the current plan files first (per CE-1 from quorum.md — not a vote in the tally): do they correctly address the phase goal, requirement IDs, and user decisions from CONTEXT.md? State your analysis as 1-2 sentences to share with external voters.

Run quorum inline — follow the canonical protocol in @core/references/quorum-dispatch.md:
- Mode A — pure question (reviewers read artifact directly)
- artifact_path: all current `${PHASE_DIR}/*-PLAN.md` files
- envelope_path: `${ENVELOPE_PATH}` (if file exists) for risk_level context
- review_context: "This is a pre-execution implementation plan. The code does not exist yet. Evaluate the plan's approach, task breakdown, and correctness — not whether the implementation already exists in the repository."
- request_improvements: true          ← R3.6 signal infrastructure
- Build `$DISPATCH_LIST` first (Adaptive Fan-Out: read risk_level → compute FAN_OUT_COUNT → take first FAN_OUT_COUNT-1 slots from active working list)
- **Exact YAML format for worker prompts** (from reference section 4):
  ```yaml
  slot: <slotName>
  round: <round_number>
  timeout_ms: <from $SLOT_TIMEOUTS or 300000>
  repo_dir: <absolute path to project root>
  mode: A
  question: <question text>
  artifact_path: ${PHASE_DIR}/*-PLAN.md
  review_context: "This is a pre-execution implementation plan..."
  request_improvements: true
  prior_positions: |
    [included from Round 2 onward]
  ```
- Dispatch `$DISPATCH_LIST` as sibling `nf-quorum-slot-worker` Tasks with `model="haiku", max_turns=100`
- Deliberate up to 10 rounds per R3.3

Fail-open: if a slot errors (UNAVAIL), note it and proceed — same as R6 policy.

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

- **BLOCKED** → Report blocker to user. Do not proceed. **Break loop.**
- **ESCALATED** → Present escalation to user. Do not proceed until resolved. **Break loop.**

- **APPROVED AND ($QUORUM_IMPROVEMENTS is empty OR improvement_iteration >= 10)**:
    Include `<!-- NF_DECISION -->` in your response summarizing quorum results.
    If `improvement_iteration > 0`: note "R3.6: ${improvement_iteration} iteration(s) ran."
    If `improvement_iteration >= 10` AND improvements remained: note
      "R3.6 cap reached — improvements not incorporated."
    Proceed to step 9. **Break loop.**

- **APPROVED AND $QUORUM_IMPROVEMENTS non-empty AND improvement_iteration < 10**:
    `improvement_iteration += 1`

    Display:
    ```
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     nForma ► QUORUM APPROVED — R3.6 improvements (${improvement_iteration}/10)
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    ```

    List each improvement: `• <model>: <suggestion> — <rationale>`

    Display: `Sending improvements to planner...`

    Conflict check: if two improvements are mutually incompatible (one undoes the other),
    escalate to user BEFORE spawning planner:
    > "R3.6 conflict: improvements from [model A] and [model B] are incompatible. [describe
    > conflict]. Which should take precedence?"
    Await user resolution, then filter improvements to the chosen set.

    Spawn planner in improvement-revision mode:

    ```
    Task(
      prompt="First, read ~/.claude/agents/nf-planner.md for your role and instructions.\n\n
      <revision_context>
      Phase: ${PHASE_NUMBER}
      Mode: improvement-revision (R3.6 iteration ${improvement_iteration}/10)

      <files_to_read>
      - ${PHASE_DIR}/*-PLAN.md (current plans to revise)
      - ${CONTEXT_PATH} (USER DECISIONS — must not contradict)
      </files_to_read>

      <quorum_improvements>
      ${QUORUM_IMPROVEMENTS formatted as readable bullet list}
      </quorum_improvements>

      <instructions>
      Incorporate the quorum improvements above into the plans.
      Make targeted updates only. Do NOT replan from scratch.
      If an improvement conflicts with user decisions in CONTEXT.md, skip it and note why.
      Return a summary of what changed.
      </instructions>
      </revision_context>",
      subagent_type="general-purpose",
      model="{planner_model}",
      description="R3.6 improvements (iteration ${improvement_iteration})"
    )
    ```

    After planner returns:
    - **If planner returns `## PLANNING COMPLETE` or equivalent success:** re-read
      `${PHASE_DIR}/*-PLAN.md` (plan files are now updated). Continue loop.
    - **If planner returns `## PLANNING INCONCLUSIVE` or fails to update files:**
      Do NOT loop again on the same improvements. Display:
      > "R3.6: planner could not incorporate improvements in iteration ${improvement_iteration}. Proceeding with current plan."
      Include `<!-- NF_DECISION -->` summarizing quorum results. Proceed to step 9. **Break loop.**

**END LOOP**

## 9. Handle Planner Return

- **`## PLANNING COMPLETE`:** Display plan count. If `--skip-verify` or `plan_checker_enabled` is false (from init): skip to step 13. Otherwise: step 10.
- **`## CHECKPOINT REACHED`:** Present to user, get response, spawn continuation (step 12)
- **`## PLANNING INCONCLUSIVE`:** Show attempts, offer: Add context / Retry / Manual

## 10. Spawn nf-plan-checker Agent

```bash
node ~/.claude/nf/bin/nf-tools.cjs activity-set \
  "{\"activity\":\"plan_phase\",\"sub_activity\":\"checking_plan\",\"phase\":${PHASE_NUMBER}}"
```

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► VERIFYING PLANS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning plan checker...
```

Checker prompt:

```markdown
<verification_context>
**Phase:** {phase_number}
**Phase Goal:** {goal from ROADMAP}

<files_to_read>
- {PHASE_DIR}/*-PLAN.md (Plans to verify)
- {roadmap_path} (Roadmap)
- {requirements_path} (Requirements)
- {context_path} (USER DECISIONS from /nf:discuss-phase)
</files_to_read>

**Phase requirement IDs (MUST ALL be covered):** {phase_req_ids}

**Project instructions:** Verify plans honor project guidelines from CLAUDE.md context (already loaded)
**Project skills:** Check .agents/skills/ directory (if exists) — verify plans account for project skill rules

<binding_rule id="R9">
Verify that PLAN must_haves truths cover ALL ROADMAP success_criteria for this phase.
Flag as BLOCKER if:
- Any ROADMAP success criterion has no corresponding PLAN truth
- Any PLAN truth is weaker than its source ROADMAP criterion (relaxed threshold, narrowed scope, softened language)
- The count of PLAN truths is less than the count of ROADMAP success_criteria
- Any truth uses "should" where ROADMAP uses "must", or "some" where ROADMAP uses "all"

Objective relaxation is NEVER acceptable as a plan optimization. Missing or weakened
criteria = blocker, not warning.
</binding_rule>

<check_dimensions>
- **formal_artifacts (mandatory):** Every PLAN.md frontmatter MUST declare `formal_artifacts:`. If `$FORMAL_SPEC_CONTEXT` was non-empty at planning time, the value must be one of `none`, `update: [list]`, or `create: [list]`. Missing `formal_artifacts:` field = BLOCKER.
- **formal_artifacts path validation:** If `formal_artifacts: update: [paths]`, each path must not be vague (not ending in "/", not a glob pattern). If `formal_artifacts: create: [list]`, each entry must have `path` and `type` (tla|alloy|prism). Vague paths = BLOCKER.
- **invariant compliance (soft check):** If `$FORMAL_SPEC_CONTEXT` is non-empty, scan each plan task's `<action>` and `<done>` blocks for operations that would violate the identified invariants. Report as WARNING (not BLOCKER) — actual model checking occurs at execution time.
</check_dimensions>

<formal_context>
${FORMAL_SPEC_CONTEXT.length > 0 ? `Relevant formal modules: ${FORMAL_SPEC_CONTEXT.map(f => f.module).join(', ')}. Check plan formal_artifacts declaration and invariant compliance per <check_dimensions> above.` : 'No formal modules matched. Verify every PLAN.md declares formal_artifacts: none.'}
</formal_context>
</verification_context>

<expected_output>
- ## VERIFICATION PASSED — all checks pass
- ## ISSUES FOUND — structured issue list
</expected_output>
```

> **Note:** Use the Task tool to spawn this sub-agent. Do NOT invoke any Skill tool (e.g., `mcp__gemini-1__gemini`, `mcp__codex-1__review`, `mcp__opencode-1__opencode`, `mcp__copilot-1__copilot`) as a substitute. Skill tool calls do not spawn sub-agents — they call external models directly, bypassing the agent system.

```
Task(
  prompt=checker_prompt,
  subagent_type="nf-plan-checker",
  model="{checker_model}",
  description="Verify Phase {phase} plans"
)
```

## 11. Handle Checker Return

- **`## VERIFICATION PASSED`:** Display confirmation, proceed to step 11.5.
- **`## ISSUES FOUND`:** Display issues, check iteration count, proceed to step 12.

## 11.5. Populate VALIDATION.md (if Nyquist enabled)

**Skip if:** `nyquist_validation_enabled` is false from INIT JSON, or `${PHASE_DIR}/${PADDED_PHASE}-VALIDATION.md` does not exist.

After plan-checker passes, the orchestrator populates VALIDATION.md with real data extracted from the approved plans. Step 5.5 created the template with placeholder values — this step fills them in.

**Process:**

1. **Detect test framework** from project root:
   ```bash
   # Check for common test config files
   ls jest.config.* vitest.config.* pytest.ini setup.cfg pyproject.toml Cargo.toml go.mod 2>/dev/null
   ```
   Map to framework name and commands:
   | Config found | Framework | Quick run | Full suite |
   |---|---|---|---|
   | `jest.config.*` | Jest | `npx jest --bail` | `npx jest` |
   | `vitest.config.*` | Vitest | `npx vitest run --bail 1` | `npx vitest run` |
   | `pytest.ini` / `pyproject.toml [tool.pytest]` | Pytest | `pytest -x --tb=short` | `pytest --tb=short` |
   | None found | (use project's existing test pattern from RESEARCH.md or STATE.md) | | |

2. **Extract task data from all approved PLAN.md files.** For each `${PHASE_DIR}/${PADDED_PHASE}-*-PLAN.md`:
   - Parse YAML frontmatter: `wave`, `requirements` (array of IDs)
   - Parse `<task>` XML blocks: extract task number and `<verify>` content
   - Build task ID: `${PADDED_PHASE}-{plan_number}-{task_number}` (e.g., `v0.22-01-01-01`)
   - Classify test type from verify content: `unit` (single test file), `integration` (multi-file or endpoint test), `smoke` (curl/HTTP check), `manual` (no automated command)

3. **Fill VALIDATION.md sections** by editing the file in-place:

   **Test Infrastructure table:** Replace placeholder values with detected framework, config path, quick/full commands, estimated runtime.

   **Nyquist Sampling Rate:** Replace `{quick run command}` and `{full suite command}` with actual detected commands. Set feedback latency to a reasonable default (30s for unit-heavy, 120s for integration-heavy).

   **Per-Task Verification Map:** Replace the 3 placeholder rows with one row per actual task:
   ```
   | {task_id} | {plan_num} | {wave} | {requirement_id} | {test_type} | `{verify_command}` | TBD | ⬜ pending |
   ```
   If a plan covers multiple requirements, create one row per task (the requirement is from the plan's `requirements` frontmatter, distributed across tasks).

   **Wave 0 Requirements:** If any plan has `wave: 0`, list its test scaffolding files. Otherwise write: "Existing infrastructure covers all phase requirements — no Wave 0 test tasks needed."

   **Manual-Only Verifications:** If any task has no `<verify>` block or verify says "manual", list it here. Otherwise write: "All phase behaviors have automated verification coverage."

   **Validation Sign-Off:** Check each box that is satisfied by the plan data. Set `nyquist_compliant: true` in frontmatter if all boxes pass.

   **Execution Tracking:** Leave as template — this is filled during `/nf:execute-phase`.

4. **Update frontmatter:**
   ```yaml
   status: approved
   nyquist_compliant: true  # or false if sign-off checks failed
   ```

5. **Commit if `commit_docs` is true:**
   ```bash
   node ~/.claude/nf/bin/nf-tools.cjs commit "docs(phase-${PHASE}): populate validation strategy from approved plans" --files "${PHASE_DIR}/${PADDED_PHASE}-VALIDATION.md"
   ```

Proceed to step 13.

## 12. Revision Loop (Max 3 Iterations)

Track `iteration_count` (starts at 1 after initial plan + check).

**If iteration_count < 3:**

Display: `Sending back to planner for revision... (iteration {N}/3)`

Revision prompt:

```markdown
<revision_context>
**Phase:** {phase_number}
**Mode:** revision

<files_to_read>
- {PHASE_DIR}/*-PLAN.md (Existing plans)
- {context_path} (USER DECISIONS from /nf:discuss-phase)
</files_to_read>

**Checker issues:** {structured_issues_from_checker}
</revision_context>

<instructions>
Make targeted updates to address checker issues.
Do NOT replan from scratch unless issues are fundamental.
Return what changed.
</instructions>
```

> **Note:** Use the Task tool to spawn this sub-agent. Do NOT invoke any Skill tool (e.g., `mcp__gemini-1__gemini`, `mcp__codex-1__review`, `mcp__opencode-1__opencode`, `mcp__copilot-1__copilot`) as a substitute. Skill tool calls do not spawn sub-agents — they call external models directly, bypassing the agent system.

```
Task(
  prompt="First, read ~/.claude/agents/nf-planner.md for your role and instructions.\n\n" + revision_prompt,
  subagent_type="general-purpose",
  model="{planner_model}",
  description="Revise Phase {phase} plans"
)
```

After planner returns -> spawn checker again (step 10), increment iteration_count.

**If iteration_count >= 3:**

Display: `Max iterations reached. {N} issues remain:` + issue list

Offer: 1) Force proceed, 2) Provide guidance and retry, 3) Abandon

## 13. Present Final Status

Route to `<offer_next>` OR `auto_advance` depending on flags/config.

After presenting final status to the user (offer_next output displayed OR auto-advance complete):

```bash
node ~/.claude/nf/bin/nf-tools.cjs activity-clear
```

## 14. Auto-Advance Check

Check for auto-advance trigger:

1. Parse `--auto` flag from $ARGUMENTS
2. Read `workflow.auto_advance` from config:
   ```bash
   AUTO_CFG=$(node ~/.claude/nf/bin/nf-tools.cjs config-get workflow.auto_advance 2>/dev/null || echo "true")
   ```

**If `--auto` flag present OR `AUTO_CFG` is true:**

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► AUTO-ADVANCING TO EXECUTE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Plans ready. Spawning execute-phase...
```

Spawn execute-phase as Task:

> **Note:** Use the Task tool to spawn this sub-agent. Do NOT invoke any Skill tool (e.g., `mcp__gemini-1__gemini`, `mcp__codex-1__review`, `mcp__opencode-1__opencode`, `mcp__copilot-1__copilot`) as a substitute. Skill tool calls do not spawn sub-agents — they call external models directly, bypassing the agent system.

```
Task(
  prompt="Run /nf:execute-phase ${PHASE} --auto",
  subagent_type="general-purpose",
  description="Execute Phase ${PHASE}"
)
```

**Handle execute-phase return:**
- **PHASE COMPLETE** → In --auto mode, determine NEXT_PHASE routing:

  1. Determine NEXT_PHASE from the execute-phase result (use the `next_phase` field returned by the transition/phase-complete call — same field used in execute-phase.md line ~639).

  2. Check if NEXT_PHASE already has CONTEXT.md:
     ```bash
     NEXT_CONTEXT=$(ls .planning/phases/*${NEXT_PHASE}*/*-CONTEXT.md 2>/dev/null | head -1)
     ```

  3. Display banner:
     ```
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      nForma ► PHASE ${PHASE} COMPLETE ✓
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

     Auto-advance pipeline finished.

     Next: /nf:discuss-phase ${NEXT_PHASE} --auto
     ```
     (If CONTEXT.md exists, show `Next: /nf:plan-phase ${NEXT_PHASE} --auto` instead)

  4. Invoke SlashCommand:
     - If `$NEXT_CONTEXT` is non-empty (CONTEXT.md exists): `SlashCommand("/nf:plan-phase ${NEXT_PHASE} --auto")`
     - Otherwise: `SlashCommand("/nf:discuss-phase ${NEXT_PHASE} --auto")`

- **GAPS FOUND / VERIFICATION FAILED** → Display result, stop chain (unchanged):
  ```
  Auto-advance stopped: Execution needs review.

  Review the output above and continue manually:
  /nf:execute-phase ${PHASE}
  ```

**If neither `--auto` nor config enabled:**
Route to `<offer_next>` (existing behavior).

</process>

<offer_next>
Output this markdown directly (not as a code block):

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► PHASE {X} PLANNED ✓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Phase {X}: {Name}** — {N} plan(s) in {M} wave(s)

| Wave | Plans | What it builds |
|------|-------|----------------|
| 1    | 01, 02 | [objectives] |
| 2    | 03     | [objective]  |

Research: {Completed | Skipped}
Verification: {Passed | Passed with override | Skipped}

───────────────────────────────────────────────────────────────

## ▶ Next Up

**Execute Phase {X}** — run all {N} plans

/nf:execute-phase {X}

<sub>/clear first → fresh context window</sub>

───────────────────────────────────────────────────────────────

**Also available:**
- cat .planning/phases/{phase-dir}/*-PLAN.md — review plans
- /nf:plan-phase {X} --research — re-research first

───────────────────────────────────────────────────────────────
</offer_next>

<success_criteria>
- [ ] .planning/ directory validated
- [ ] Phase validated against roadmap
- [ ] Phase directory created if needed
- [ ] CONTEXT.md loaded early (step 4) and passed to ALL agents
- [ ] Research completed (unless --skip-research or --gaps or research_enabled=false)
- [ ] nf-phase-researcher spawned with CONTEXT.md
- [ ] Existing plans checked
- [ ] nf-planner spawned with CONTEXT.md + RESEARCH.md
- [ ] Plans created (PLANNING COMPLETE or CHECKPOINT handled)
- [ ] nf-plan-checker spawned with CONTEXT.md
- [ ] Verification passed OR user override OR max iterations with user decision
- [ ] Quorum ran (step 8.5) with `request_improvements: true`
- [ ] R3.6 loop ran: if improvements were proposed, planner revision was spawned; if none, loop exited cleanly; `<!-- NF_DECISION -->` present in response
- [ ] User sees status between agent spawns
- [ ] User knows next steps
</success_criteria>

<anti_patterns>
**R3.6 — do NOT:**
- Do NOT skip the R3.6 loop because the plan "looks complete" or improvements "seem minor." The loop is MANDATORY when `request_improvements: true` returns a non-empty array.
- Do NOT pre-filter or discard improvements before passing them to the planner. Pass the full `$QUORUM_IMPROVEMENTS` array.
- Do NOT count the initial quorum run (improvement_iteration=0) as one of the 10 R3.6 iterations. Iteration counting starts at 1 when the first planner revision is spawned.
- Do NOT emit `<!-- NF_DECISION -->` before the loop exits. Only emit it on the final break.
- Do NOT run the R3.6 improvement planner as a parallel Task alongside anything else. It must be sequential — quorum → planner → quorum → ...
</anti_patterns>

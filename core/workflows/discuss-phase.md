<purpose>
Extract implementation decisions that downstream agents need. Analyze the phase to identify gray areas, let the user choose what to discuss, then deep-dive each selected area until satisfied.

You are a thinking partner, not an interviewer. The user is the visionary — you are the builder. Your job is to capture decisions that will guide research and planning, not to figure out implementation yourself.
</purpose>

<downstream_awareness>
**CONTEXT.md feeds into:**

1. **nf-phase-researcher** — Reads CONTEXT.md to know WHAT to research
   - "User wants card-based layout" → researcher investigates card component patterns
   - "Infinite scroll decided" → researcher looks into virtualization libraries

2. **nf-planner** — Reads CONTEXT.md to know WHAT decisions are locked
   - "Pull-to-refresh on mobile" → planner includes that in task specs
   - "Claude's Discretion: loading skeleton" → planner can decide approach

**Your job:** Capture decisions clearly enough that downstream agents can act on them without asking the user again.

**Not your job:** Figure out HOW to implement. That's what research and planning do with the decisions you capture.
</downstream_awareness>

<philosophy>
**User = founder/visionary. Claude = builder.**

The user knows:
- How they imagine it working
- What it should look/feel like
- What's essential vs nice-to-have
- Specific behaviors or references they have in mind

The user doesn't know (and shouldn't be asked):
- Codebase patterns (researcher reads the code)
- Technical risks (researcher identifies these)
- Implementation approach (planner figures this out)
- Success metrics (inferred from the work)

Ask about vision and implementation choices. Capture decisions for downstream agents.
</philosophy>

<scope_guardrail>
**CRITICAL: No scope creep.**

The phase boundary comes from ROADMAP.md and is FIXED. Discussion clarifies HOW to implement what's scoped, never WHETHER to add new capabilities.

**Allowed (clarifying ambiguity):**
- "How should posts be displayed?" (layout, density, info shown)
- "What happens on empty state?" (within the feature)
- "Pull to refresh or manual?" (behavior choice)

**Not allowed (scope creep):**
- "Should we also add comments?" (new capability)
- "What about search/filtering?" (new capability)
- "Maybe include bookmarking?" (new capability)

**The heuristic:** Does this clarify how we implement what's already in the phase, or does it add a new capability that could be its own phase?

**When user suggests scope creep:**
```
"[Feature X] would be a new capability — that's its own phase.
Want me to note it for the roadmap backlog?

For now, let's focus on [phase domain]."
```

Capture the idea in a "Deferred Ideas" section. Don't lose it, don't act on it.
</scope_guardrail>

<gray_area_identification>
Gray areas are **implementation decisions the user cares about** — things that could go multiple ways and would change the result.

**How to identify gray areas:**

1. **Read the phase goal** from ROADMAP.md
2. **Understand the domain** — What kind of thing is being built?
   - Something users SEE → visual presentation, interactions, states matter
   - Something users CALL → interface contracts, responses, errors matter
   - Something users RUN → invocation, output, behavior modes matter
   - Something users READ → structure, tone, depth, flow matter
   - Something being ORGANIZED → criteria, grouping, handling exceptions matter
3. **Generate phase-specific gray areas** — Not generic categories, but concrete decisions for THIS phase

**Don't use generic category labels** (UI, UX, Behavior). Generate specific gray areas:

```
Phase: "User authentication"
→ Session handling, Error responses, Multi-device policy, Recovery flow

Phase: "Organize photo library"
→ Grouping criteria, Duplicate handling, Naming convention, Folder structure

Phase: "CLI for database backups"
→ Output format, Flag design, Progress reporting, Error recovery

Phase: "API documentation"
→ Structure/navigation, Code examples depth, Versioning approach, Interactive elements
```

**The key question:** What decisions would change the outcome that the user should weigh in on?

**Claude handles these (don't ask):**
- Technical implementation details
- Architecture patterns
- Performance optimization
- Scope (roadmap defines this)
</gray_area_identification>

<process>

<step name="initialize" priority="first">
Phase number from argument (required).

```bash
INIT=$(node ~/.claude/nf/bin/nf-tools.cjs init phase-op "${PHASE}")
```

Parse JSON for: `commit_docs`, `phase_found`, `phase_dir`, `phase_number`, `phase_name`, `phase_slug`, `padded_phase`, `has_research`, `has_context`, `has_plans`, `has_verification`, `plan_count`, `roadmap_exists`, `planning_exists`.

**If `phase_found` is false:**
```
Phase [X] not found in roadmap.

Use /nf:progress to see available phases.
```
Exit workflow.

**If `phase_found` is true:** Continue to check_existing.
</step>

<step name="check_existing">
Check if CONTEXT.md already exists using `has_context` from init.

```bash
ls ${phase_dir}/*-CONTEXT.md 2>/dev/null
```

**If exists:**
Use AskUserQuestion:
- header: "Context"
- question: "Phase [X] already has context. What do you want to do?"
- options:
  - "Update it" — Review and revise existing context
  - "View it" — Show me what's there
  - "Skip" — Use existing context as-is

If "Update": Load existing, continue to analyze_phase
If "View": Display CONTEXT.md, then offer update/skip
If "Skip": Exit workflow

**If doesn't exist:**

Check `has_plans` and `plan_count` from init. **If `has_plans` is true:**

Use AskUserQuestion:
- header: "Plans exist"
- question: "Phase [X] already has {plan_count} plan(s) created without user context. Your decisions here won't affect existing plans unless you replan."
- options:
  - "Continue and replan after" — Capture context, then run /nf:plan-phase {X} to replan
  - "View existing plans" — Show plans before deciding
  - "Cancel" — Skip discuss-phase

If "Continue and replan after": Continue to analyze_phase.
If "View existing plans": Display plan files, then offer "Continue" / "Cancel".
If "Cancel": Exit workflow.

**If `has_plans` is false:** Continue to analyze_phase.
</step>

<step name="analyze_phase">
Analyze the phase to identify gray areas worth discussing.

**Read the phase description from ROADMAP.md and determine:**

1. **Domain boundary** — What capability is this phase delivering? State it clearly.

2. **Gray areas by category** — For each relevant category (UI, UX, Behavior, Empty States, Content), identify 1-2 specific ambiguities that would change implementation.

3. **Skip assessment** — If no meaningful gray areas exist (pure infrastructure, clear-cut implementation), the phase may not need discussion.

**Output your analysis internally, then present to user.**

Example analysis for "Post Feed" phase:
```
Domain: Displaying posts from followed users
Gray areas:
- UI: Layout style (cards vs timeline vs grid)
- UI: Information density (full posts vs previews)
- Behavior: Loading pattern (infinite scroll vs pagination)
- Empty State: What shows when no posts exist
- Content: What metadata displays (time, author, reactions count)
```
</step>

<step name="r4_pre_filter">
Apply the R4 pre-filter (CLAUDE.md §R4) to every gray area candidate before presenting anything to the user.

**This step is MANDATORY. Do NOT skip even if gray areas seem obvious.**

**For each gray area question identified in analyze_phase:**

1. **Form Claude's own position first** — Bias toward the long-term solution. Write a 1-2 sentence answer and classify as CONSENSUS-READY or USER-INPUT-NEEDED. This is Claude's active quorum vote.

2. **Run quorum inline** for this question (one quorum round per question — sequential, not parallel):

   Follow the canonical protocol in @core/references/quorum-dispatch.md — Mode A:
   - Question: "Should '[question text]' be decided by quorum now (removing it from the user's question list), or does it genuinely require the user's vision/preference? If quorum can decide: provide the recommended answer biased toward the long-term solution. Vote APPROVE (quorum can decide — CONSENSUS-READY) or BLOCK (user input needed)."
   - Include context: phase name, goal from ROADMAP.md, relevant patterns from STATE.md
   - **Exact YAML format for worker prompts** (from reference section 4):
     ```yaml
     slot: <slotName>
     round: <round_number>
     timeout_ms: <from $SLOT_TIMEOUTS or 300000>
     repo_dir: <absolute path to project root>
     mode: A
     question: "Should '[question text]' be decided by quorum..."
     prior_positions: |
       [included from Round 2 onward]
     ```
   - Build `$DISPATCH_LIST` first (quorum.md Adaptive Fan-Out: read risk_level → compute FAN_OUT_COUNT → take first FAN_OUT_COUNT-1 slots from active working list). Then dispatch `$DISPATCH_LIST` as sibling `nf-quorum-slot-worker` Tasks with `model="haiku", max_turns=100` — do NOT dispatch slots outside `$DISPATCH_LIST`
   - Synthesize results inline, deliberate up to 3 rounds per R4

   Fail-open: if all slots error (UNAVAIL), mark the question for user presentation per R6.

3. **Route on quorum_result:**
   - **APPROVED** → Record as auto-resolved assumption. Add to `auto_resolved[]` with the consensus answer from the sub-agent's final_positions. Remove from user-facing question list.
   - **BLOCKED or ESCALATED** → Mark for user presentation. Add to `for_user[]`.

4. **Maintain two lists:**
   - `auto_resolved[]` — Questions resolved by quorum consensus, with the recorded assumption
   - `for_user[]` — Questions that could not be resolved by quorum

5. **After processing all questions:** Pass `auto_resolved[]` and `for_user[]` to the `present_gray_areas` step.

**If `for_user[]` is empty** (all questions resolved): Skip `present_gray_areas`. Go directly to `discuss_areas` with a note:
```
All gray areas were resolved by quorum consensus. Proceeding with auto-resolved assumptions:

[list each assumption]

No further input needed for this phase. Proceeding to context capture.
```
Then jump to `write_context`.
</step>

<step name="present_gray_areas">
Present the domain boundary and gray areas to user.

**Auto mode second quorum pass (QUORUM-03):**

Before presenting to the user, check if auto mode is active:

```bash
AUTO_CFG=$(node ~/.claude/nf/bin/nf-tools.cjs config-get workflow.auto_advance 2>/dev/null || echo "true")
```

**If `--auto` flag present OR `AUTO_CFG` is `"true"` AND `for_user[]` is non-empty:**

Run a second quorum pass on each surviving item in `for_user[]`. This is distinct from the R4 pre-filter (which already ran at analyze_phase) — this is a second attempt on the survivors.

For each question still in `for_user[]` (process sequentially):

1. Form Claude's position: can quorum decide this question, or does it genuinely require the user's vision/preference? State APPROVE (quorum can decide) or BLOCK (needs user) with 1-2 sentence rationale.

2. Run R3 quorum inline — follow the canonical protocol in @core/references/quorum-dispatch.md:
   - Mode A — pure question
   - Question: "Should '[question text]' be decided by quorum now (removing it from user presentation), or does it genuinely require the user's vision/preference? Phase: {phase_name}. Goal: {phase_goal}. Context: {any relevant patterns from STATE.md}. If quorum can decide: provide the recommended answer biased toward the long-term solution."
   - **Exact YAML format for worker prompts** (from reference section 4):
     ```yaml
     slot: <slotName>
     round: <round_number>
     timeout_ms: <from $SLOT_TIMEOUTS or 300000>
     repo_dir: <absolute path to project root>
     mode: A
     question: "Should '[question text]' be decided by quorum now..."
     prior_positions: |
       [included from Round 2 onward]
     ```
   - Build `$DISPATCH_LIST` first (quorum.md Adaptive Fan-Out: read risk_level → compute FAN_OUT_COUNT → take first FAN_OUT_COUNT-1 slots from active working list). Then dispatch `$DISPATCH_LIST` as sibling `nf-quorum-slot-worker` Tasks with `model="haiku", max_turns=100` — do NOT dispatch slots outside `$DISPATCH_LIST`
   - Deliberate up to 3 rounds per R4 (secondary pre-filter, not full R3 10 rounds)

3. After quorum vote for this question, update scoreboard BEFORE moving to next question:
   Use the correct identity flags — `update-scoreboard` rejects a slot passed via `--model`:
   - **native CLI model** (codex/gemini/opencode/copilot/claude): `--model <family>`
   - **MCP slot instance** (e.g. `gemini-1`, `claude-2`): `--slot <slot> --model-id <id from health_check>` (NOT `--model`)
   `--result` is the prediction-accuracy code (TP/TN/FP/FN); a gray-area vote has no ground truth, so pass `--result ""` (not scored) — the decision lives in `--verdict`.
   ```bash
   node "$HOME/.claude/nf-bin/update-scoreboard.cjs" \
     --model <family> \
     --result "" \
     --task "discuss-phase-{PHASE_NUMBER}" \
     --round <round_number> \
     --verdict <APPROVE|BLOCK> \
     --task-description "Discuss-phase gray area: {question text (first 80 chars)}"
   ```

4. Route on quorum_result:
   - **APPROVED**: Record as auto-resolved assumption. Add to `auto_resolved[]` with the consensus answer. Remove from `for_user[]`.
   - **BLOCKED or ESCALATED**: Keep in `for_user[]`. Mark for user presentation.

**After processing all for_user[] items:**

- If `for_user[]` is now empty: Skip AskUserQuestion presentation. Go directly to `write_context` (same fast-path as R4 pre-filter empty case). Display:
  ```
  All gray areas resolved by quorum (including second-pass R4 survivors). Proceeding to context capture.

  [list each auto-resolved assumption from both R4 pre-filter and second pass]
  ```
- If `for_user[]` still has items: Continue to the standard AskUserQuestion presentation below.

**If neither `--auto` nor `AUTO_CFG` is true (interactive mode):** Skip this entire sub-section. Go directly to the standard display and AskUserQuestion below (unchanged).

**First, display auto-resolved assumptions (from r4_pre_filter):**

If `auto_resolved[]` is non-empty, display:
```
## Auto-Resolved by Quorum

The following gray areas were resolved without needing your input:

[For each item in auto_resolved[]:
- [Question text] → [Recorded assumption]]
```

Then display the domain boundary and present only the `for_user[]` items as checkboxes.

**State the boundary:**
```
Phase [X]: [Name]
Domain: [What this phase delivers — from your analysis]

We'll clarify HOW to implement this.
(New capabilities belong in other phases.)
```

**Then use AskUserQuestion (multiSelect: true):**
- header: "Discuss"
- question: "Which areas do you want to discuss for [phase name]?"
- options: Generate 3-4 phase-specific gray areas, each formatted as:
  - "[Specific area]" (label) — concrete, not generic
  - [1-2 questions this covers] (description)
  - **Highlight the recommended choice with brief explanation why**

**Do NOT include a "skip" or "you decide" option.** User ran this command to discuss — give them real choices.

**Examples by domain:**

For "Post Feed" (visual feature):
```
☐ Layout style — Cards vs list vs timeline? Information density?
☐ Loading behavior — Infinite scroll or pagination? Pull to refresh?
☐ Content ordering — Chronological, algorithmic, or user choice?
☐ Post metadata — What info per post? Timestamps, reactions, author?
```

For "Database backup CLI" (command-line tool):
```
☐ Output format — JSON, table, or plain text? Verbosity levels?
☐ Flag design — Short flags, long flags, or both? Required vs optional?
☐ Progress reporting — Silent, progress bar, or verbose logging?
☐ Error recovery — Fail fast, retry, or prompt for action?
```

For "Organize photo library" (organization task):
```
☐ Grouping criteria — By date, location, faces, or events?
☐ Duplicate handling — Keep best, keep all, or prompt each time?
☐ Naming convention — Original names, dates, or descriptive?
☐ Folder structure — Flat, nested by year, or by category?
```

Continue to discuss_areas with selected areas.
</step>

<step name="discuss_areas">
For each selected area, conduct a focused discussion loop.

**Philosophy: 4 questions, then check.**

Ask 4 questions per area before offering to continue or move on. Each answer often reveals the next question.

**For each area:**

1. **Announce the area:**
   ```
   Let's talk about [Area].
   ```

2. **Ask 4 questions using AskUserQuestion:**
   - header: "[Area]" (max 12 chars — abbreviate if needed)
   - question: Specific decision for this area
   - options: 2-3 concrete choices (AskUserQuestion adds "Other" automatically), with the recommended choice highlighted and brief explanation why
   - Include "You decide" as an option when reasonable — captures Claude discretion

3. **After 4 questions, check:**
   - header: "[Area]" (max 12 chars)
   - question: "More questions about [area], or move to next?"
   - options: "More questions" / "Next area"

   If "More questions" → ask 4 more, then check again
   If "Next area" → proceed to next selected area
   If "Other" (free text) → interpret intent: continuation phrases ("chat more", "keep going", "yes", "more") map to "More questions"; advancement phrases ("done", "move on", "next", "skip") map to "Next area". If ambiguous, ask: "Continue with more questions about [area], or move to the next area?"

4. **After all initially-selected areas complete:**
   - Summarize what was captured from the discussion so far
   - AskUserQuestion:
     - header: "Done"
     - question: "We've discussed [list areas]. Which gray areas remain unclear?"
     - options: "Explore more gray areas" / "I'm ready for context"
   - If "Explore more gray areas":
     - Identify 2-4 additional gray areas based on what was learned
     - Return to present_gray_areas logic with these new areas
     - Loop: discuss new areas, then prompt again
   - If "I'm ready for context": Proceed to write_context

**Question design:**
- Options should be concrete, not abstract ("Cards" not "Option A")
- Each answer should inform the next question
- If user picks "Other", receive their input, reflect it back, confirm

**Scope creep handling:**
If user mentions something outside the phase domain:
```
"[Feature] sounds like a new capability — that belongs in its own phase.
I'll note it as a deferred idea.

Back to [current area]: [return to current question]"
```

Track deferred ideas internally.
</step>

<step name="write_context">
Create CONTEXT.md capturing decisions made.

**Find or create phase directory:**

Use values from init: `phase_dir`, `phase_slug`, `padded_phase`.

If `phase_dir` is null (phase exists in roadmap but no directory):
```bash
mkdir -p ".planning/phases/${padded_phase}-${phase_slug}"
```

**File location:** `${phase_dir}/${padded_phase}-CONTEXT.md`

**Structure the content by what was discussed:**

```markdown
# Phase [X]: [Name] - Context

**Gathered:** [date]
**Status:** Ready for planning

<domain>
## Phase Boundary

[Clear statement of what this phase delivers — the scope anchor]

</domain>

<decisions>
## Implementation Decisions

### [Category 1 that was discussed]
- [Decision or preference captured]
- [Another decision if applicable]

### [Category 2 that was discussed]
- [Decision or preference captured]

### Claude's Discretion
[Areas where user said "you decide" — note that Claude has flexibility here]

</decisions>

<specifics>
## Specific Ideas

[Any particular references, examples, or "I want it like X" moments from discussion]

[If none: "No specific requirements — open to standard approaches"]

</specifics>

<deferred>
## Deferred Ideas

[Ideas that came up but belong in other phases. Don't lose them.]

[If none: "None — discussion stayed within phase scope"]

</deferred>

---

*Phase: XX-name*
*Context gathered: [date]*
```

Write file.
</step>

<step name="confirm_creation">
Present summary and next steps:

```
Created: .planning/phases/${PADDED_PHASE}-${SLUG}/${PADDED_PHASE}-CONTEXT.md

## Decisions Captured

### [Category]
- [Key decision]

### [Category]
- [Key decision]

[If deferred ideas exist:]
## Noted for Later
- [Deferred idea] — future phase

---

## ▶ Next Up

**Phase ${PHASE}: [Name]** — [Goal from ROADMAP.md]

`/nf:plan-phase ${PHASE}`

<sub>`/clear` first → fresh context window</sub>

---

**Also available:**
- `/nf:plan-phase ${PHASE} --skip-research` — plan without research
- Review/edit CONTEXT.md before continuing

---
```
</step>

<step name="git_commit">
Commit phase context (uses `commit_docs` from init internally):

```bash
node ~/.claude/nf/bin/nf-tools.cjs commit "docs(${padded_phase}): capture phase context" --files "${phase_dir}/${padded_phase}-CONTEXT.md"
```

Confirm: "Committed: docs(${padded_phase}): capture phase context"
</step>

<step name="update_state">
Update STATE.md with session info:

```bash
node ~/.claude/nf/bin/nf-tools.cjs state record-session \
  --stopped-at "Phase ${PHASE} context gathered" \
  --resume-file "${phase_dir}/${padded_phase}-CONTEXT.md"
```

Commit STATE.md:

```bash
node ~/.claude/nf/bin/nf-tools.cjs commit "docs(state): record phase ${PHASE} context session" --files .planning/STATE.md
```
</step>

<step name="auto_advance">
Check for auto-advance trigger:

1. Parse `--auto` flag from $ARGUMENTS
2. Read `workflow.auto_advance` from config:
   ```bash
   AUTO_CFG=$(node ~/.claude/nf/bin/nf-tools.cjs config-get workflow.auto_advance 2>/dev/null || echo "true")
   ```

**If `--auto` flag present AND `AUTO_CFG` is not true:** Persist auto-advance to config (handles direct `--auto` usage without new-project):
```bash
node ~/.claude/nf/bin/nf-tools.cjs config-set workflow.auto_advance true
```

**If `--auto` flag present OR `AUTO_CFG` is true:**

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► AUTO-ADVANCING TO PLAN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Context captured. Spawning plan-phase...
```

Spawn plan-phase as Task:

> **Note:** Use the Task tool to spawn this sub-agent. Do NOT invoke any Skill tool (e.g., `mcp__gemini-1__gemini`, `mcp__codex-1__review`, `mcp__opencode-1__opencode`, `mcp__copilot-1__copilot`) as a substitute. Skill tool calls do not spawn sub-agents — they call external models directly, bypassing the agent system.

```
Task(
  prompt="Run /nf:plan-phase ${PHASE} --auto",
  subagent_type="general-purpose",
  description="Plan Phase ${PHASE}"
)
```

**Handle plan-phase return:**
- **PLANNING COMPLETE** → Plan-phase handles chaining to execute-phase (via its own auto_advance step)
- **PLANNING INCONCLUSIVE / CHECKPOINT** → Display result, stop chain:
  ```
  Auto-advance stopped: Planning needs input.

  Review the output above and continue manually:
  /nf:plan-phase ${PHASE}
  ```

**If neither `--auto` nor config enabled:**
Route to `confirm_creation` step (existing behavior — show manual next steps).
</step>

</process>

<success_criteria>
- Phase validated against roadmap
- Gray areas identified through intelligent analysis (not generic questions)
- User selected which areas to discuss
- Each selected area explored until user satisfied
- Scope creep redirected to deferred ideas
- CONTEXT.md captures actual decisions, not vague vision
- Deferred ideas preserved for future phases
- STATE.md updated with session info
- User knows next steps
</success_criteria>

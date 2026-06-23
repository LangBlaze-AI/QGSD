<purpose>
Validate built features through conversational testing with persistent state. Creates UAT.md that tracks test progress, survives /clear, and feeds gaps into /nf:plan-phase --gaps.

User tests, Claude records. One test at a time. Plain text responses.
</purpose>

<philosophy>
**Show expected, ask if reality matches.**

Claude presents what SHOULD happen. User confirms or describes what's different.
- "yes" / "y" / "next" / empty → pass
- Anything else → logged as issue, severity inferred

No Pass/Fail buttons. No severity questions. Just: "Here's what should happen. Does it?"

**Automate first, ask second.** For each test, attempt automated verification using available tools before presenting to the user.
</philosophy>

<automation_first>
**Default: Automate verification. Fallback: Ask user.**

Before presenting ANY test to the user for manual verification, attempt automated verification using available tools in this priority order:

1. **Playwright/agent-browser** — If a browser MCP tool is available, use it to:
   - Navigate to the relevant URL
   - Take screenshots and verify visual state
   - Check browser console for errors
   - Verify DOM elements exist and contain expected content
   - Test interactive flows (click, type, submit)

2. **CLI verification** — Use curl, grep, file reads, or test commands:
   - API endpoints: `curl` the endpoint and verify response shape/status
   - File artifacts: Read the file, verify contents match expectations
   - Test suites: Run relevant test commands and check output
   - Build output: Verify build artifacts exist and are valid

3. **Code inspection** — Read source files to verify:
   - Correct imports and wiring between modules
   - Expected patterns present (e.g., error handling, type usage)
   - No regressions in related code

**Fall back to manual user testing ONLY when:**
- Subjective judgment required (design aesthetics, UX feel, copy tone)
- Real authentication credentials needed (OAuth flows, payment testing)
- Physical device interaction required (mobile gestures, hardware)
- All automated tools genuinely unavailable or insufficient

**For each test, record the verification method used:**
- `auto:browser` — Verified via Playwright/agent-browser
- `auto:cli` — Verified via curl/grep/test commands
- `auto:inspect` — Verified via code inspection
- `manual` — Required user interaction (state why)

When automated verification passes, auto-mark the test as passed and move to the next one. Only pause for user interaction when automation cannot resolve the test.
</automation_first>

<template>
@~/.claude/nf/templates/UAT.md
</template>

<process>

<step name="initialize" priority="first">
If $ARGUMENTS contains a phase number, load context:

```bash
INIT=$(node ~/.claude/nf/bin/nf-tools.cjs init verify-work "${PHASE_ARG}")
```

Parse JSON for: `planner_model`, `checker_model`, `commit_docs`, `phase_found`, `phase_dir`, `phase_number`, `phase_name`, `has_verification`.
</step>

<step name="check_active_session">
**First: Check for active UAT sessions**

```bash
find .planning/phases -name "*-UAT.md" -type f 2>/dev/null | head -5
```

**If active sessions exist AND no $ARGUMENTS provided:**

Read each file's frontmatter (status, phase) and Current Test section.

Display inline:

```
## Active UAT Sessions

| # | Phase | Status | Current Test | Progress |
|---|-------|--------|--------------|----------|
| 1 | 04-comments | testing | 3. Reply to Comment | 2/6 |
| 2 | 05-auth | testing | 1. Login Form | 0/4 |

Reply with a number to resume, or provide a phase number to start new.
```

Wait for user response.

- If user replies with number (1, 2) → Load that file, go to `resume_from_file`
- If user replies with phase number → Treat as new session, go to `create_uat_file`

**If active sessions exist AND $ARGUMENTS provided:**

Check if session exists for that phase. If yes, offer to resume or restart.
If no, continue to `create_uat_file`.

**If no active sessions AND no $ARGUMENTS:**

```
No active UAT sessions.

Provide a phase number to start testing (e.g., /nf:verify-work 4)
```

**If no active sessions AND $ARGUMENTS provided:**

Continue to `create_uat_file`.
</step>

<step name="find_summaries">
**Find what to test:**

Use `phase_dir` from init (or run init if not already done).

```bash
ls "$phase_dir"/*-SUMMARY.md 2>/dev/null
```

Read each SUMMARY.md to extract testable deliverables.
</step>

<step name="extract_tests">
**Extract testable deliverables from SUMMARY.md:**

Parse for:
1. **Accomplishments** - Features/functionality added
2. **User-facing changes** - UI, workflows, interactions

Focus on USER-OBSERVABLE outcomes, not implementation details.

For each deliverable, create a test:
- name: Brief test name
- expected: What the user should see/experience (specific, observable)

Examples:
- Accomplishment: "Added comment threading with infinite nesting"
  → Test: "Reply to a Comment"
  → Expected: "Clicking Reply opens inline composer below comment. Submitting shows reply nested under parent with visual indentation."

Skip internal/non-observable items (refactors, type changes, etc.).
</step>

<step name="create_uat_file">
**Create UAT file with all tests:**

```bash
mkdir -p "$PHASE_DIR"
```

Build test list from extracted deliverables.

Create file:

```markdown
---
status: testing
phase: XX-name
source: [list of SUMMARY.md files]
started: [ISO timestamp]
updated: [ISO timestamp]
---

## Current Test
<!-- OVERWRITE each test - shows where we are -->

number: 1
name: [first test name]
expected: |
  [what user should observe]
awaiting: user response

## Tests

### 1. [Test Name]
expected: [observable behavior]
result: [pending]

### 2. [Test Name]
expected: [observable behavior]
result: [pending]

...

## Summary

total: [N]
passed: 0
issues: 0
pending: [N]
skipped: 0

## Gaps

[none yet]
```

Write to `.planning/phases/XX-name/{phase_num}-UAT.md`

Proceed to `present_test`.
</step>

<step name="present_test">
**Present current test to user:**

Read Current Test section from UAT file.

    Before presenting this test, attempt automated verification per the `<automation_first>` protocol.

    Automation attempt (concrete):

    1. Discover project test runners and candidate test files using the repo's test discovery helper. Prefer framework-native discovery (Playwright first, then Jest, then pytest):

    ```bash
    # Discover tests (writes JSON with `runners`, `test_files`, `by_runner`)
    DISCOVER_JSON=$(mktemp)
    node ~/.claude/nf/bin/nf-tools.cjs maintain-tests discover --dir "${phase_dir:-.}" --output-file "$DISCOVER_JSON" || true
    ```

    2. If Playwright tests were discovered, prefer running only those (e2e). Otherwise fall back to Jest single-file runs when available.

    ```bash
    BATCH_FILE=$(mktemp)
    OUTPUT_JSON=$(mktemp)

    # Prefer playwright runner if present and has files
    if grep -q '"playwright"' "$DISCOVER_JSON" && grep -q '\.spec\.' "$DISCOVER_JSON"; then
      # Build a small batch manifest containing discovered Playwright spec files
      NF_DISCOVER="$DISCOVER_JSON" NF_BATCH="$BATCH_FILE" node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(process.env.NF_DISCOVER)); const files=(d.by_runner&&d.by_runner.playwright)||d.test_files||[]; const m={batch_id:Date.now(), runner:'playwright', files:files}; fs.writeFileSync(process.env.NF_BATCH, JSON.stringify(m));"
    else
      # Try jest files as fallback
      NF_DISCOVER="$DISCOVER_JSON" NF_BATCH="$BATCH_FILE" node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(process.env.NF_DISCOVER)); const files=(d.by_runner&&d.by_runner.jest)||d.test_files||[]; const m={batch_id:Date.now(), runner:'jest', files:files}; fs.writeFileSync(process.env.NF_BATCH, JSON.stringify(m));"
    fi

    # If manifest has files, run a short batch (timeout short to keep verify-work responsive)
    if [ -s "$BATCH_FILE" ] && grep -q '"files"' "$BATCH_FILE"; then
      node ~/.claude/nf/bin/nf-tools.cjs maintain-tests run-batch --batch-file "$BATCH_FILE" --output-file "$OUTPUT_JSON" --timeout 300 || true

      # Inspect results: if no failures, mark automated verification passed
      if grep -q '"failed_count": 0' "$OUTPUT_JSON" >/dev/null 2>&1; then
        # Record automated pass for this test (auto:browser for playwright, auto:jest for jest)
        echo "Automated verification succeeded via discovered tests. Results: $OUTPUT_JSON"
        # The workflow engine should update the UAT file: set Tests.{N}.result = pass and method = auto:{type}
        # (Interpreter: update in-memory test state and skip user presentation)
      else
        # Automation ran but some tests failed or timed out — capture artifacts and fall back to manual presentation
        echo "Automated verification attempted but reported failures. See $OUTPUT_JSON for details."
      fi
    else
      # No candidate test files discovered; fall back to lighter CLI/file inspection or present to user
      echo "No framework-native test files discovered for automated verification in ${phase_dir:-.}."
    fi
    ```

    - If automated verification (the maintain-tests run) succeeds with no failing tests: update the test result to `pass` with method `auto:{type}` (auto:browser for Playwright, auto:jest for Jest), skip user presentation, and proceed to the next test.
    - If automated verification fails, times out, or no tests were discovered: present to the user as normal (existing checkpoint box flow). If the run failed due to environment constraints (missing install, playwright browser missing, timeout), include remediation guidance in the UAT frontmatter (e.g., "run npm ci && npx playwright install", required ENV vars).

Display using checkpoint box format:

```
╔══════════════════════════════════════════════════════════════╗
║  CHECKPOINT: Verification Required                           ║
╚══════════════════════════════════════════════════════════════╝

**Test {number}: {name}**

{expected}

──────────────────────────────────────────────────────────────
→ Type "pass" or describe what's wrong
──────────────────────────────────────────────────────────────
```

Wait for user response (plain text, no AskUserQuestion).
</step>

<step name="process_response">
**Process user response and update file:**

**If response indicates pass:**
- Empty response, "yes", "y", "ok", "pass", "next", "approved", "✓"

Update Tests section:
```
### {N}. {name}
expected: {expected}
result: pass
method: {auto:browser|auto:cli|auto:inspect|manual}
```

**If response indicates skip:**
- "skip", "can't test", "n/a"

Update Tests section:
```
### {N}. {name}
expected: {expected}
result: skipped
reason: [user's reason if provided]
```

**If response is anything else:**
- Treat as issue description

Infer severity from description:
- Contains: crash, error, exception, fails, broken, unusable → blocker
- Contains: doesn't work, wrong, missing, can't → major
- Contains: slow, weird, off, minor, small → minor
- Contains: color, font, spacing, alignment, visual → cosmetic
- Default if unclear: major

Update Tests section:
```
### {N}. {name}
expected: {expected}
result: issue
reported: "{verbatim user response}"
severity: {inferred}
```

Append to Gaps section (structured YAML for plan-phase --gaps):
```yaml
- truth: "{expected behavior from test}"
  status: failed
  reason: "User reported: {verbatim user response}"
  severity: {inferred}
  test: {N}
  artifacts: []  # Filled by diagnosis
  missing: []    # Filled by diagnosis
```

**After any response:**

Update Summary counts.
Update frontmatter.updated timestamp.

If more tests remain → Update Current Test, go to `present_test`
If no more tests → Go to `complete_session`
</step>

<step name="resume_from_file">
**Resume testing from UAT file:**

Read the full UAT file.

Find first test with `result: [pending]`.

Announce:
```
Resuming: Phase {phase} UAT
Progress: {passed + issues + skipped}/{total}
Issues found so far: {issues count}

Continuing from Test {N}...
```

Update Current Test section with the pending test.
Proceed to `present_test`.
</step>

<step name="complete_session">
**Complete testing and commit:**

Update frontmatter:
- status: complete
- updated: [now]

Clear Current Test section:
```
## Current Test

[testing complete]
```

Commit the UAT file:
```bash
node ~/.claude/nf/bin/nf-tools.cjs commit "test({phase_num}): complete UAT - {passed} passed, {issues} issues" --files ".planning/phases/XX-name/{phase_num}-UAT.md"
```

Present summary:
```
## UAT Complete: Phase {phase}

| Result | Count |
|--------|-------|
| Passed | {N}   |
| Issues | {N}   |
| Skipped| {N}   |

[If issues > 0:]
### Issues Found

[List from Issues section]
```

**If issues > 0:** Proceed to `diagnose_issues`

**If issues == 0:**
```
All tests passed. Ready to continue.

- `/nf:plan-phase {next}` — Plan next phase
- `/nf:execute-phase {next}` — Execute next phase
```
</step>

<step name="diagnose_issues">
**Diagnose root causes before planning fixes:**

```
---

{N} issues found. Diagnosing root causes...

Spawning parallel debug agents to investigate each issue.
```

- Load diagnose-issues workflow
- Follow @~/.claude/nf/workflows/diagnose-issues.md
- Spawn parallel debug agents for each issue
- Collect root causes
- Update UAT.md with root causes
- Proceed to `plan_gap_closure`

Diagnosis runs automatically - no user prompt. Parallel agents investigate simultaneously, so overhead is minimal and fixes are more accurate.
</step>

<step name="plan_gap_closure">
**Auto-plan fixes from diagnosed gaps:**

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► PLANNING FIXES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning planner for gap closure...
```

Spawn nf-planner in --gaps mode:

```
Task(
  prompt="""
<planning_context>

**Phase:** {phase_number}
**Mode:** gap_closure

<files_to_read>
- {phase_dir}/{phase_num}-UAT.md (UAT with diagnoses)
- .planning/STATE.md (Project State)
- .planning/ROADMAP.md (Roadmap)
</files_to_read>

</planning_context>

<downstream_consumer>
Output consumed by /nf:execute-phase
Plans must be executable prompts.
</downstream_consumer>
""",
  subagent_type="nf-planner",
  model="{planner_model}",
  description="Plan gap fixes for Phase {phase}"
)
```

On return:
- **PLANNING COMPLETE:** Proceed to `verify_gap_plans`
- **PLANNING INCONCLUSIVE:** Report and offer manual intervention
</step>

<step name="verify_gap_plans">
**Verify fix plans with checker:**

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► VERIFYING FIX PLANS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning plan checker...
```

Initialize: `iteration_count = 1`

Spawn nf-plan-checker:

```
Task(
  prompt="""
<verification_context>

**Phase:** {phase_number}
**Phase Goal:** Close diagnosed gaps from UAT

<files_to_read>
- {phase_dir}/*-PLAN.md (Plans to verify)
</files_to_read>

</verification_context>

<expected_output>
Return one of:
- ## VERIFICATION PASSED — all checks pass
- ## ISSUES FOUND — structured issue list
</expected_output>
""",
  subagent_type="nf-plan-checker",
  model="{checker_model}",
  description="Verify Phase {phase} fix plans"
)
```

On return:
- **VERIFICATION PASSED:** Proceed to `present_ready`
- **ISSUES FOUND:** Proceed to `revision_loop`
</step>

<step name="revision_loop">
**Iterate planner ↔ checker until plans pass (max 3):**

**If iteration_count < 3:**

Display: `Sending back to planner for revision... (iteration {N}/3)`

Spawn nf-planner with revision context:

```
Task(
  prompt="""
<revision_context>

**Phase:** {phase_number}
**Mode:** revision

<files_to_read>
- {phase_dir}/*-PLAN.md (Existing plans)
</files_to_read>

**Checker issues:**
{structured_issues_from_checker}

</revision_context>

<instructions>
Read existing PLAN.md files. Make targeted updates to address checker issues.
Do NOT replan from scratch unless issues are fundamental.
</instructions>
""",
  subagent_type="nf-planner",
  model="{planner_model}",
  description="Revise Phase {phase} plans"
)
```

After planner returns → spawn checker again (verify_gap_plans logic)
Increment iteration_count

**If iteration_count >= 3:**

Display: `Max iterations reached. {N} issues remain.`

Offer options:
1. Force proceed (execute despite issues)
2. Provide guidance (user gives direction, retry)
3. Abandon (exit, user runs /nf:plan-phase manually)

Wait for user response.
</step>

<step name="present_ready">
**Present completion and next steps:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► FIXES READY ✓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Phase {X}: {Name}** — {N} gap(s) diagnosed, {M} fix plan(s) created

| Gap | Root Cause | Fix Plan |
|-----|------------|----------|
| {truth 1} | {root_cause} | {phase}-04 |
| {truth 2} | {root_cause} | {phase}-04 |

Plans verified and ready for execution.

───────────────────────────────────────────────────────────────

## ▶ Next Up

**Execute fixes** — run fix plans

`/clear` then `/nf:execute-phase {phase} --gaps-only`

───────────────────────────────────────────────────────────────
```

**Auto-advance (when --auto flag present OR `workflow.auto_advance` config is true):**

Check for --auto flag and config:
```bash
AUTO_CFG=$(node ~/.claude/nf/bin/nf-tools.cjs config-get workflow.auto_advance 2>/dev/null || echo "true")
```

**If `--auto` flag present OR `AUTO_CFG` is true:**

Two sub-cases based on gap result:

**Sub-case A — Gaps found (fix plans were created):**
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► AUTO-ADVANCING TO EXECUTE GAPS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Gap fix plans ready. Spawning execute-phase --gaps-only...
```
Invoke: `SlashCommand("/nf:execute-phase ${PHASE} --gaps-only --auto")`

**Sub-case B — All tests pass (no gaps found):**
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► VERIFICATION COMPLETE ✓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

All tests pass. Advancing to next phase...
```
Invoke: `SlashCommand("/nf:discuss-phase ${NEXT_PHASE} --auto")`

(NEXT_PHASE = the phase number immediately after the current phase, read from ROADMAP.md or `nf-tools.cjs roadmap get-phase` next field)

**If neither --auto nor config enabled:** Keep existing display-and-stop behavior unchanged.

</step>

</process>

<update_rules>
**Batched writes for efficiency:**

Keep results in memory. Write to file only when:
1. **Issue found** — Preserve the problem immediately
2. **Session complete** — Final write before commit
3. **Checkpoint** — Every 5 passed tests (safety net)

| Section | Rule | When Written |
|---------|------|--------------|
| Frontmatter.status | OVERWRITE | Start, complete |
| Frontmatter.updated | OVERWRITE | On any file write |
| Current Test | OVERWRITE | On any file write |
| Tests.{N}.result | OVERWRITE | On any file write |
| Summary | OVERWRITE | On any file write |
| Gaps | APPEND | When issue found |

On context reset: File shows last checkpoint. Resume from there.
</update_rules>

<severity_inference>
**Infer severity from user's natural language:**

| User says | Infer |
|-----------|-------|
| "crashes", "error", "exception", "fails completely" | blocker |
| "doesn't work", "nothing happens", "wrong behavior" | major |
| "works but...", "slow", "weird", "minor issue" | minor |
| "color", "spacing", "alignment", "looks off" | cosmetic |

Default to **major** if unclear. User can correct if needed.

**Never ask "how severe is this?"** - just infer and move on.
</severity_inference>

<success_criteria>
- [ ] UAT file created with all tests from SUMMARY.md
- [ ] Automated verification attempted for each test before user presentation
- [ ] Verification method recorded for each test result
- [ ] Tests presented one at a time with expected behavior
- [ ] User responses processed as pass/issue/skip
- [ ] Severity inferred from description (never asked)
- [ ] Batched writes: on issue, every 5 passes, or completion
- [ ] Committed on completion
- [ ] If issues: parallel debug agents diagnose root causes
- [ ] If issues: nf-planner creates fix plans (gap_closure mode)
- [ ] If issues: nf-plan-checker verifies fix plans
- [ ] If issues: revision loop until plans pass (max 3 iterations)
- [ ] Ready for `/nf:execute-phase --gaps-only` when complete
</success_criteria>

<purpose>
Verify phase goal achievement through goal-backward analysis. Check that the codebase delivers what the phase promised, not just that tasks completed.

Executed by a verification subagent spawned from execute-phase.md.
</purpose>

<core_principle>
**Task completion ≠ Goal achievement**

A task "create chat component" can be marked complete when the component is a placeholder. The task was done — but the goal "working chat interface" was not achieved.

Goal-backward verification:
1. What must be TRUE for the goal to be achieved?
2. What must EXIST for those truths to hold?
3. What must be WIRED for those artifacts to function?

Then verify each level against the actual codebase.
</core_principle>

<required_reading>
@~/.claude/nf/references/verification-patterns.md
@~/.claude/nf/templates/verification-report.md
</required_reading>

<process>

<step name="baseline_capture" priority="first">
**Step 0 — Capture ROADMAP Success Criteria as Immutable Baseline (R9)**

Before loading any PLAN must_haves, capture the ROADMAP success_criteria as the
immutable verification baseline. This prevents objective drift where PLAN truths
silently weaken ROADMAP criteria.

```bash
# Read ROADMAP success criteria for this phase
PHASE_DATA=$(node ~/.claude/nf/bin/nf-tools.cjs roadmap get-phase "${PHASE_ARG}" --raw 2>/dev/null)
ROADMAP_CRITERIA=$(echo "$PHASE_DATA" | node -e "
  let d;
  try { d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); }
  catch (e) { console.log('(no success_criteria in ROADMAP — will use PLAN must_haves as primary source)'); process.exit(0); }
  const sc = d.success_criteria || [];
  sc.forEach((c,i) => console.log('SC-' + (i+1) + ': ' + c));
  if (sc.length === 0) console.log('(no success_criteria in ROADMAP — will use PLAN must_haves as primary source)');
")
echo "$ROADMAP_CRITERIA"
```

Store `$ROADMAP_CRITERIA` as the baseline. This is the contract — it cannot be weakened.

**Schema validation guard (R9 robustness):**

If the ROADMAP phase entry exists but `success_criteria` is present and malformed (parse
error, non-array type, or array with empty/whitespace-only strings), flag immediately:
`ERROR (R9): ROADMAP success_criteria for phase "${PHASE_ARG}" exists but is malformed. Cannot establish baseline. Halting verification — fix ROADMAP before retrying.`
Exit the verification workflow at this point (do NOT fall through to "no criteria" path).
This prevents silent failures where corrupted ROADMAP data causes the baseline capture to
silently skip comparison, defeating the purpose of R9.

Only three states are valid:
1. `success_criteria` key absent or explicitly empty `[]` → no baseline, use PLAN must_haves
2. `success_criteria` is a well-formed non-empty array of strings → use as immutable baseline
3. Anything else (parse error, non-array, empty strings in array) → ERROR, halt

**After loading PLAN must_haves (in the establish_must_haves step), compare:**

If ROADMAP success_criteria exist (non-empty, validated):
1. Count ROADMAP criteria vs PLAN truths. If PLAN truths < ROADMAP criteria count, flag:
   `WARNING (R9): PLAN has fewer truths ({N}) than ROADMAP success_criteria ({M}). Possible objective reduction.`
2. For each ROADMAP criterion, check if a corresponding PLAN truth exists. If missing, flag:
   `WARNING (R9): ROADMAP criterion "{criterion}" has no matching PLAN truth. Verification may miss this objective.`
3. Include all R9 warnings in the VERIFICATION.md report under a dedicated `## R9 Baseline Comparison` section.

If ROADMAP success_criteria are empty, skip comparison — PLAN must_haves are the primary source (no baseline to compare against).
</step>

<step name="load_context" priority="first">
Load phase operation context:

```bash
INIT=$(node ~/.claude/nf/bin/nf-tools.cjs init phase-op "${PHASE_ARG}")
```

Extract from init JSON: `phase_dir`, `phase_number`, `phase_name`, `has_plans`, `plan_count`.

Then load phase details and list plans/summaries:
```bash
node ~/.claude/nf/bin/nf-tools.cjs roadmap get-phase "${phase_number}"
grep -E "^| ${phase_number}" .planning/REQUIREMENTS.md 2>/dev/null
ls "$phase_dir"/*-SUMMARY.md "$phase_dir"/*-PLAN.md 2>/dev/null
```

Extract **phase goal** from ROADMAP.md (the outcome to verify, not tasks) and **requirements** from REQUIREMENTS.md if it exists.
</step>

<step name="establish_must_haves">
<binding_rule id="R9">
ROADMAP success_criteria are the immutable contract. When both ROADMAP success_criteria
and PLAN must_haves exist:
- Success Criteria from ROADMAP override PLAN-level must_haves (this is already stated
  in Option B — R9 makes it explicit and mandatory)
- If PLAN truths are fewer or weaker than ROADMAP criteria, report as R9 deviation
- NEVER reduce verification scope to match what the code actually does
- If code fails a ROADMAP criterion, the verdict is FAILED — not "criterion was too strict"

Spec generation note: generate-phase-spec.cjs reads truths from PLAN frontmatter.
If PLAN truths have drifted from ROADMAP criteria, the generated TLA+ PROPERTY stubs
will inherit the weakness. Flag this in the R9 Baseline Comparison section.
</binding_rule>

**Option A: Must-haves in PLAN frontmatter**

Use nf-tools to extract must_haves from each PLAN:

```bash
for plan in "$PHASE_DIR"/*-PLAN.md; do
  MUST_HAVES=$(node ~/.claude/nf/bin/nf-tools.cjs frontmatter get "$plan" --field must_haves)
  echo "=== $plan ===" && echo "$MUST_HAVES"
done
```

Returns JSON: `{ truths: [...], artifacts: [...], key_links: [...] }`

Aggregate all must_haves across plans for phase-level verification.

**Option B: Use Success Criteria from ROADMAP.md**

If no must_haves in frontmatter (MUST_HAVES returns error or empty), check for Success Criteria:

```bash
PHASE_DATA=$(node ~/.claude/nf/bin/nf-tools.cjs roadmap get-phase "${phase_number}" --raw)
```

Parse the `success_criteria` array from the JSON output. If non-empty:
1. Use each Success Criterion directly as a **truth** (they are already written as observable, testable behaviors)
2. Derive **artifacts** (concrete file paths for each truth)
3. Derive **key links** (critical wiring where stubs hide)
4. Document the must-haves before proceeding

Success Criteria from ROADMAP.md are the contract — they override PLAN-level must_haves when both exist.

**Option C: Derive from phase goal (fallback)**

If no must_haves in frontmatter AND no Success Criteria in ROADMAP:
1. State the goal from ROADMAP.md
2. Derive **truths** (3-7 observable behaviors, each testable)
3. Derive **artifacts** (concrete file paths for each truth)
4. Derive **key links** (critical wiring where stubs hide)
5. Document derived must-haves before proceeding
</step>

<step name="verify_truths">
For each observable truth, determine if the codebase enables it.

**Status:** ✓ VERIFIED (all supporting artifacts pass) | ✗ FAILED (artifact missing/stub/unwired) | ? UNCERTAIN (needs human)

For each truth: identify supporting artifacts → check artifact status → check wiring → determine truth status.

**Example:** Truth "User can see existing messages" depends on Chat.tsx (renders), /api/chat GET (provides), Message model (schema). If Chat.tsx is a stub or API returns hardcoded [] → FAILED. If all exist, are substantive, and connected → VERIFIED.
</step>

<step name="verify_artifacts">
Use nf-tools for artifact verification against must_haves in each PLAN:

```bash
for plan in "$PHASE_DIR"/*-PLAN.md; do
  ARTIFACT_RESULT=$(node ~/.claude/nf/bin/nf-tools.cjs verify artifacts "$plan")
  echo "=== $plan ===" && echo "$ARTIFACT_RESULT"
done
```

Parse JSON result: `{ all_passed, passed, total, artifacts: [{path, exists, issues, passed}] }`

**Artifact status from result:**
- `exists=false` → MISSING
- `issues` not empty → STUB (check issues for "Only N lines" or "Missing pattern")
- `passed=true` → VERIFIED (Levels 1-2 pass)

**Level 3 — Wired (manual check for artifacts that pass Levels 1-2):**
```bash
grep -r "import.*$artifact_name" src/ --include="*.ts" --include="*.tsx"  # IMPORTED
grep -r "$artifact_name" src/ --include="*.ts" --include="*.tsx" | grep -v "import"  # USED
```
WIRED = imported AND used. ORPHANED = exists but not imported/used.

| Exists | Substantive | Wired | Status |
|--------|-------------|-------|--------|
| ✓ | ✓ | ✓ | ✓ VERIFIED |
| ✓ | ✓ | ✗ | ⚠️ ORPHANED |
| ✓ | ✗ | - | ✗ STUB |
| ✗ | - | - | ✗ MISSING |
</step>

<step name="verify_wiring">
Use nf-tools for key link verification against must_haves in each PLAN:

```bash
for plan in "$PHASE_DIR"/*-PLAN.md; do
  LINKS_RESULT=$(node ~/.claude/nf/bin/nf-tools.cjs verify key-links "$plan")
  echo "=== $plan ===" && echo "$LINKS_RESULT"
done
```

Parse JSON result: `{ all_verified, verified, total, links: [{from, to, via, verified, detail}] }`

**Link status from result:**
- `verified=true` → WIRED
- `verified=false` with "not found" → NOT_WIRED
- `verified=false` with "Pattern not found" → PARTIAL

**Fallback patterns (if key_links not in must_haves):**

| Pattern | Check | Status |
|---------|-------|--------|
| Component → API | fetch/axios call to API path, response used (await/.then/setState) | WIRED / PARTIAL (call but unused response) / NOT_WIRED |
| API → Database | Prisma/DB query on model, result returned via res.json() | WIRED / PARTIAL (query but not returned) / NOT_WIRED |
| Form → Handler | onSubmit with real implementation (fetch/axios/mutate/dispatch), not console.log/empty | WIRED / STUB (log-only/empty) / NOT_WIRED |
| State → Render | useState variable appears in JSX (`{stateVar}` or `{stateVar.property}`) | WIRED / NOT_WIRED |

Record status and evidence for each key link.
</step>

<step name="verify_requirements">
If REQUIREMENTS.md exists:
```bash
grep -E "Phase ${PHASE_NUM}" .planning/REQUIREMENTS.md 2>/dev/null
```

For each requirement: parse description → identify supporting truths/artifacts → status: ✓ SATISFIED / ✗ BLOCKED / ? NEEDS HUMAN.
</step>

<step name="scan_antipatterns">
Extract files modified in this phase from SUMMARY.md, scan each:

| Pattern | Search | Severity |
|---------|--------|----------|
| TODO/FIXME/XXX/HACK | `grep -n -E "TODO\|FIXME\|XXX\|HACK"` | ⚠️ Warning |
| Placeholder content | `grep -n -iE "placeholder\|coming soon\|will be here"` | 🛑 Blocker |
| Empty returns | `grep -n -E "return null\|return \{\}\|return \[\]\|=> \{\}"` | ⚠️ Warning |
| Log-only functions | Functions containing only console.log | ⚠️ Warning |

Categorize: 🛑 Blocker (prevents goal) | ⚠️ Warning (incomplete) | ℹ️ Info (notable).
</step>

<step name="quality_checklist_scan">
**Quality Checklist Scan**

After verifying must_haves, scan modified files against relevant quality checklists using the checklist registry.

Collect the list of files modified in this phase (from SUMMARY.md or git diff) as `$CHANGED_FILES` (comma-separated).
Collect the phase description or goal as `$TASK_DESCRIPTION`.

```bash
MATCHES=$(node $HOME/.claude/nf-bin/checklist-match.cjs --files "$CHANGED_FILES" --description "$TASK_DESCRIPTION" 2>/dev/null)
```

If `$MATCHES` is a non-empty JSON array, for each matched checklist:
1. Read `$HOME/.claude/nf/references/{file}` (where `{file}` comes from the match result)
2. Evaluate the modified code against each checklist item
3. Report violations as Warning-level findings

If `checklist-match.cjs` is not found or returns exit 1 (no matches), skip this step silently (fail-open).

Report violations in VERIFICATION.md under a `## Quality Checklist Warnings` section. These do NOT block verification — they are informational.
</step>

<step name="identify_human_verification">
**Always needs human:** Visual appearance, user flow completion, real-time behavior (WebSocket/SSE), external service integration, performance feel, error message clarity.

**Needs human if uncertain:** Complex wiring grep can't trace, dynamic state-dependent behavior, edge cases.

Format each as: Test Name → What to do → Expected result → Why can't verify programmatically.
</step>

<step name="determine_status">
**passed:** All truths VERIFIED, all artifacts pass levels 1-3, all key links WIRED, no blocker anti-patterns.

**gaps_found:** Any truth FAILED, artifact MISSING/STUB, key link NOT_WIRED, or blocker found.

**human_needed:** All automated checks pass but human verification items remain.

**Score:** `verified_truths / total_truths`

**r9_deviation:** ROADMAP success_criteria exist AND (PLAN truths count < ROADMAP criteria count OR any ROADMAP criterion has no matching PLAN truth).

R9 deviation severity and downstream action:
- **Does NOT change the overall PASS/FAIL status** of the verification — the phase verdict is determined solely by gap analysis against must_haves truths.
- **DOES produce a dedicated `## R9 Baseline Comparison` section** in VERIFICATION.md with each deviation listed and its specific drift description.
- **DOES emit a WARNING-level notice** in the verification summary block (not a blocker, not silent).
- **Downstream effect:** The R9 deviation section is designed for human review at the end of verification. It does not block execution of subsequent phases, but it signals that the PLAN's scope may have drifted from the ROADMAP contract. The user can then choose to: (a) update the PLAN truths to re-align with ROADMAP, (b) update ROADMAP criteria with explicit justification in Key Decisions, or (c) acknowledge and proceed.
- **Rationale for WARNING (not blocker):** R9 deviations may be legitimate (e.g., ROADMAP criteria were split across multiple phases). Blocking execution would create false-positive halts. The WARNING ensures visibility without halting the workflow.
</step>

<step name="generate_fix_plans">
If gaps_found:

1. **Cluster related gaps:** API stub + component unwired → "Wire frontend to backend". Multiple missing → "Complete core implementation". Wiring only → "Connect existing components".

2. **Generate plan per cluster:** Objective, 2-3 tasks (files/action/verify each), re-verify step. Keep focused: single concern per plan.

3. **Order by dependency:** Fix missing → fix stubs → fix wiring → verify.
</step>

<step name="create_report">
```bash
REPORT_PATH="$PHASE_DIR/${PHASE_NUM}-VERIFICATION.md"
```

Fill template sections: frontmatter (phase/timestamp/status/score), goal achievement, artifact table, wiring table, requirements coverage, anti-patterns, human verification, gaps summary, fix plans (if gaps_found), metadata.

See ~/.claude/nf/templates/verification-report.md for complete template.
</step>

<step name="return_to_orchestrator">
Return status (`passed` | `gaps_found` | `human_needed`), score (N/M must-haves), report path.

If gaps_found: list gaps + recommended fix plan names.
If human_needed: list items requiring human testing.

Orchestrator routes: `passed` → update_roadmap | `gaps_found` → create/execute fixes, re-verify | `human_needed` → present to user.
</step>

</process>

<success_criteria>
- [ ] Must-haves established (from frontmatter or derived)
- [ ] All truths verified with status and evidence
- [ ] All artifacts checked at all three levels
- [ ] All key links verified
- [ ] Requirements coverage assessed (if applicable)
- [ ] Anti-patterns scanned and categorized
- [ ] Human verification items identified
- [ ] Overall status determined
- [ ] Fix plans generated (if gaps_found)
- [ ] VERIFICATION.md created with complete report
- [ ] Results returned to orchestrator
</success_criteria>

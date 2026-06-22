---
name: nf:solve-report
description: Reporting phase sub-skill for nf:solve — generates before/after summary table, full formal verification detail, and post-convergence actions (gate maturity, quorum context, sensitivity)
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---

<objective>
Run the reporting phase of the nForma consistency solver. This sub-skill handles Steps 6-8: before/after summary table with detail expansion, state candidate discovery, full formal verification detail table, and post-convergence actions (gate maturity promotion, quorum context refresh, sensitivity sweep).

This is an internal-only sub-skill dispatched by the nf:solve orchestrator via Agent tool prompts. It is NOT user-invocable.
</objective>

<execution_context>
AUTONOMY REQUIREMENT: This skill runs FULLY AUTONOMOUSLY. Do NOT ask the user
any questions. Do NOT stop for human input. This sub-skill is display-only —
it reads data and produces formatted terminal output.

If reporting fails (e.g., missing residual data), write a structured error to stderr:
```json
{"status": "error", "reason": "..."}
```
and exit gracefully so the orchestrator can surface it.
</execution_context>

<input_contract>
The orchestrator passes a JSON object (as part of the Agent prompt):

```json
{
  "baseline_residual": { /* from initial diagnostic */ },
  "post_residual": { /* from re-diagnostic */ },
  "iteration_count": N,
  "flags": { "verbose": bool, "json": bool },
  "focus": null | { "phrase": string },
  "timing": null | { "layer_key": { "duration_ms": N, "skipped": bool }, ..., "total_diagnostic_ms": N }
}
```
</input_contract>

<output_contract>
Formatted terminal output (no JSON return needed -- this is display-only).
</output_contract>

<process>

## Step 6: Before/After Summary

If `input.focus` is non-null and `input.focus.phrase` is truthy, prepend the following line before the table:
```
**(focused: {focus.phrase})**
```

Display a comprehensive before/after comparison table:

```
Layer Transition         Before  After   Delta     Status
─────────────────────────────────────────────────────────
R -> F (Req->Formal)        {N}    {M}    {delta}   [status]
F -> T (Formal->Test)       {N}    {M}    {delta}   [status]
C -> F (Code->Formal)       {N}    {M}    {delta}   [status]
T -> C (Test->Code)         {N}    {M}    {delta}   [status]
F -> C (Formal->Code)       {N}    {M}    {delta}   [status]
R -> D (Req->Docs)          {N}    {M}    {delta}   [status]
D -> C (Docs->Code)         {N}    {M}    {delta}   [status]
P -> F (Prod->Formal)       {N}    {M}    {delta}   [status]
B -> F (Bug->Formal)        {N}    {M}    {delta}   [status]
  Forward subtotal:         {N}    {M}    {delta}
─ Reverse Discovery ────────────────────────────────────
C -> R (Code->Req)          {N}    {M}    {delta}   [status]
T -> R (Test->Req)          {N}    {M}    {delta}   [status]
D -> R (Docs->Req)          {N}    {M}    {delta}   [status]
  Discovery subtotal:       {N}    {M}    {delta}
─ Layer Alignment ──────────────────────────────────────
L1 -> L3 (Gate A)           {N}    {M}    {delta}   [status]
L3 -> TC (Gate C)           {N}    {M}    {delta}   [status]
  Alignment subtotal:       {N}    {M}    {delta}
─ Informational Signals (not gaps) ────────────────────
PMG (Per-Model Gates)        {N}    {M}    {delta}   [signal]
G -> H (Git Heatmap)         {N}    {M}    {delta}   [signal]
GitHist (TLA+ drift)         {N}    {M}    {delta}   [signal]
F-Lint (Formal Model Lint)   {N}    {M}    {delta}   [signal]
Hazard (FMEA high-RPN)       {N}    {M}    {delta}   [signal]
H -> M (Hazard->Model)       {N}    {M}    {delta}   [signal]
Model Stale (drift)          {N}    {M}    {delta}   [signal]
  Signal count:              {N}    {M}    {delta}
═════════════════════════════════════════════════════════
Grand total (forward):       {N}    {M}    {delta}
```

**IMPORTANT — Expand non-zero layers:** For any layer with residual > 0, display the full detail below the table. The residual number alone hides severity. For example, F->C residual=1 might mean "1 check failed with 7,086 individual divergences." Always show:

- **R->F**: List all uncovered requirement IDs
- **F->T**: Count of formal properties without test backing
- **T->C**: Show counts with symbols (fail, skip, todo) and list failing test names with error summaries. Format: `N failed, N skipped, N todo (of M total)`
- **C->F**: Table of each constant mismatch (name, formal value, config value)
- **F->C**: For each failing check: check_id, summary (including counts like "7086 divergences"), affected requirement IDs. Also list inconclusive checks separately.
- **R->D**: List all undocumented requirement IDs
- **D->C**: Table of each broken claim (doc_file, line, type, value, reason)
- **G->H**: Top uncovered hot zones with priority scores and signal types (churn, bugfix, numerical). Flag which ones were targeted for formal modeling this cycle.
- **Model Stale**: List each stale model path with reason (model_changed or source_changed) and affected requirement IDs. If first_hash_count > 0, note "N models hashed for first time (baseline established)".

Example F->C expansion:
```
F -> C Detail:
  ✗ ci:conformance-traces — 7086 divergence(s) in 20199 traces
  ⚠ ci:liveness-fairness-lint — fairness declarations missing for 10 properties
```

Example T->C expansion:
```
T -> C Detail:
  Tests: 2 failed, 3 skipped, 1 todo (of 42 total)
```

Example Model Stale expansion:
```
Model Stale Detail:
  ! .planning/formal/alloy/autoclose-signals.als — source_changed (bin/nf-solve.cjs) [STOP-01, STOP-02]
  ! .planning/formal/tla/quorum-race.tla — model_changed [DISP-03, DISP-04]
  i 12 models hashed for first time (baseline)
```

**Cross-Layer Alignment Dashboard:**

After displaying the before/after table, run the cross-layer dashboard for an aggregated alignment view:

```bash
node bin/cross-layer-dashboard.cjs --cached
```

Use `--cached` because gate scripts were already run during this solve cycle. Display the dashboard output as-is — it aggregates L1 coverage, Gate A, Gate B, and Gate C scores into a single terminal view showing overall cross-layer health.

If cross-layer-dashboard.cjs is not found, skip silently (fail-open).

If any gaps remain after convergence, append a summary of what couldn't be auto-fixed and why.

Note: R->D gaps are auto-remediated by generating developer doc entries in docs/dev/requirements-coverage.md. D->C gaps (stale file paths, CLI commands, dependencies) require manual review.

### State Candidate Discovery

After the before/after summary, run `state-candidates.cjs` to discover missing states that should be modeled:

```bash
node $HOME/.claude/nf-bin/state-candidates.cjs --json 2>/dev/null || node bin/state-candidates.cjs --json 2>/dev/null || true
```

If the script produces output, display a summary of unmodeled state candidates: count of unmapped actions and suggested missing transitions. These are informational — they feed into the next `/nf:solve` iteration if new formal models are created. Fail-open: if the script is not found or errors, skip silently.

### Step 6.2: Baseline Drift Check (CONV-04)

Re-run a lightweight diagnostic to get a fresh residual snapshot:
```bash
DRIFT_SNAPSHOT=$(node $HOME/.claude/nf-bin/nf-solve.cjs --json --report-only --fast --project-root=$(pwd) 2>/dev/null)
```
If nf-bin path doesn't exist, fall back to `bin/nf-solve.cjs`.

Then run baseline drift detection using the portable path:
```bash
BASELINE_DRIFT_SCRIPT="${HOME}/.claude/nf-bin/baseline-drift.cjs"
if [ ! -f "$BASELINE_DRIFT_SCRIPT" ]; then BASELINE_DRIFT_SCRIPT="bin/baseline-drift.cjs"; fi

# Parse environment variables and run detection
export BASELINE_JSON SNAPSHOT_JSON
$BASELINE_DRIFT_SCRIPT --project-root=$(pwd) 2>/dev/null
```
Or, if the script supports stdin:
```bash
BASELINE_DRIFT_SCRIPT="${HOME}/.claude/nf-bin/baseline-drift.cjs"
if [ ! -f "$BASELINE_DRIFT_SCRIPT" ]; then BASELINE_DRIFT_SCRIPT="bin/baseline-drift.cjs"; fi

# Run baseline drift detection
node "$BASELINE_DRIFT_SCRIPT" --project-root=$(pwd) 2>/dev/null || true
```

If `result.detected` is true:
- Display warning banner:
  ```
  --- Baseline Drift Warning ---------------------------------
  {result.warning}

  Affected layers:
  {for each layer in result.layers:}
    - {layer.layer}: {layer.baseline} -> {layer.current} ({layer.pct_change}% change)
  -------------------------------------------------------------
  ```
- Include `baseline_drift` in the report output

If `result.detected` is false:
- Log: `"Baseline drift check: clean -- no external changes detected"`

Fail-open: if the drift check script errors, log warning and continue.

### Step 6.3: Diagnostic Timing Summary

If `input.timing` is non-null and contains entries, display a timing summary section:

```
─ Diagnostic Timing ────────────────────────────────────
Total wall-clock:  {total_diagnostic_ms}ms

Top 5 slowest layers:
  {layer_name}           {duration_ms}ms
  {layer_name}           {duration_ms}ms
  {layer_name}           {duration_ms}ms
  {layer_name}           {duration_ms}ms
  {layer_name}           {duration_ms}ms

Layers skipped:    {count} of {total}
────────────────────────────────────────────────────────
```

To compute:
1. Extract `total_diagnostic_ms` from `input.timing.total_diagnostic_ms`
2. Collect all entries from `input.timing` where key !== `total_diagnostic_ms`
3. Sort by `duration_ms` descending, take top 5 (exclude entries where `skipped: true`)
4. Count entries where `skipped: true` for the "Layers skipped" line
5. Right-align the `ms` column for readability

If `input.timing` is null or empty, skip this section silently (fail-open — older solve runs won't have timing data).

### Step 6.5: Convergence Report

Display the convergence section showing trend sparklines, oscillation status, and action items:

```bash
node $HOME/.claude/nf-bin/convergence-report.cjs --project-root=$(pwd) 2>/dev/null || node bin/convergence-report.cjs --project-root=$(pwd) 2>/dev/null || true
```

If `$HOME/.claude/nf-bin/convergence-report.cjs` exists, prefer the installed path. Falls back to `bin/convergence-report.cjs` (CWD-relative).

This section is only meaningful after 5+ solve sessions (per MIN_POINTS threshold). On early runs, it displays a brief note indicating more sessions are needed. Fail-open: if the script errors, skip silently and continue to Step 7.

## Step 7: Full Formal Verification Detail Table

**ALWAYS display this table** — it shows every individual check from `run-formal-verify.cjs`, not just the solver-tracked layer residuals. The solver layer table (Step 6) can show all-green while real formal model failures hide underneath.

After the before/after table, run the full formal verification using absolute paths if not already run during remediation:
```bash
node $HOME/.claude/nf-bin/run-formal-verify.cjs --project-root=$(pwd)
```

If $HOME/.claude/nf-bin/run-formal-verify.cjs does not exist, fall back to bin/run-formal-verify.cjs (CWD-relative).

Parse `.planning/formal/check-results.ndjson` and display **every check** grouped by result:

```
Formal Verification Detail ({pass}/{total} passed):
─────────────────────────────────────────────────────────
CHECK                          RESULT     DETAIL
─────────────────────────────────────────────────────────
✓ check_id                     PASS       (optional note)
...
✗ check_id                     FAIL       summary of failure
...
⚠ check_id                     INCONC     reason for inconclusive
...
─────────────────────────────────────────────────────────
```

Rules for the detail column:
- **PASS**: Leave blank unless there's a notable caveat (e.g., "low-confidence — 0 traces", "empirical timing only")
- **FAIL**: Show the full summary from the check result (e.g., "7271 divergence(s) in 20651 traces", "MCMCPEnv model check failed", "tp_rate=0.49, unavail=0.45")
- **INCONCLUSIVE**: Show the reason (e.g., "fairness missing: PropertyName1, PropertyName2")

Display checks in this order: PASS first (alphabetical), then FAIL (alphabetical), then INCONCLUSIVE (alphabetical). This puts failures and inconclusives at the bottom where they're visually prominent.

After the table, if there are any FAIL or INCONCLUSIVE checks, add a brief actionability note:
```
{fail_count} check(s) failing, {inconc_count} inconclusive.
Failing checks need investigation — use /nf:quick to dispatch fixes for syntax/scope errors or conformance divergences.
Inconclusive checks are not failures but indicate incomplete verification (usually missing fairness declarations or tools).
```

This table is mandatory even when the solver layer residuals are all zero — because formal model failures (Alloy, TLA+, PRISM) may exist outside the solver's tracked CI checks.

## Step 8: Post-Convergence Actions

After convergence (or max iterations reached), run these additional steps. Each is fail-open — failures are logged but do not block the solve from completing.

### 8a. Gate Maturity Promotion (promote-gate-maturity.cjs)

Check if any gates can be promoted based on sustained zero residual. A gate qualifies for promotion when its corresponding layer alignment residual has been zero for the current and previous solve runs.

```bash
node bin/promote-gate-maturity.cjs --check --json --project-root=$(pwd)
```

If `$HOME/.claude/nf-bin/promote-gate-maturity.cjs` exists, prefer the installed path. Parse the JSON output and log any promotions or demotions:
- If models are eligible for promotion: log `"Gate maturity: {N} model(s) eligible for promotion"`
- If models need demotion (violations detected): log `"Gate maturity: {N} model(s) demoted due to violations"`
- If `--fix` would be appropriate (models have violations), log the suggestion but do NOT auto-fix — gate maturity changes require deliberate action.

### 8b. Refresh Quorum Formal Context (quorum-formal-context.cjs)

Regenerate the formal spec summary for subsequent quorum calls. This ensures quorum workers have up-to-date formal verification context.

Look for the most recent PLAN.md in `.planning/quick/` (sorted by modification time):
```bash
LATEST_PLAN=$(ls -t .planning/quick/*/PLAN.md 2>/dev/null | head -1)
if [ -n "$LATEST_PLAN" ]; then
  node bin/quorum-formal-context.cjs "$LATEST_PLAN"
fi
```

If no PLAN.md exists or the script fails, skip silently. The quorum context is refreshed opportunistically.

Log: `"Quorum context: refreshed formal spec summary for next quorum dispatch"`

### 8c. Sensitivity Sweep (optional — run-sensitivity-sweep.cjs)

If `--verbose` flag was passed to solve, run a sensitivity sweep to identify which model parameters have the highest impact on verification outcomes:

```bash
node bin/run-sensitivity-sweep.cjs
```

This writes results to `.planning/formal/sensitivity-report.ndjson`. The sweep is computationally expensive (runs TLC/PRISM multiple times with varied parameters), so it only runs in verbose mode.

Log: `"Sensitivity sweep: wrote {N} parameter variation(s) to sensitivity-report.ndjson"` or `"Sensitivity sweep: skipped (use --verbose to enable)"`

</process>

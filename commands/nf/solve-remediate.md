---
name: nf:solve-remediate
description: Remediation phase sub-skill for nf:solve — dispatches all 15 layer remediation steps (3a-3n + 3a-extra) in strict dependency order with Agent-per-layer isolation
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Agent
  - Skill
---

<objective>
Run the remediation phase of the nForma consistency solver. This sub-skill handles Steps 3a-3n (+ 3a-extra): all 15 layer remediation dispatches in strict dependency order. Each gap type with residual > 0 is dispatched as its own Agent call to prevent context accumulation across remediation steps.

This is an internal-only sub-skill dispatched by the nf:solve orchestrator via Agent tool prompts. It is NOT user-invocable.
</objective>

<execution_context>
PATH RESOLUTION: All bare `./bin/` require paths must resolve portably: try `$HOME/.claude/nf-bin/` first, fall back to `./bin/`. Use this helper at the top of any node -e snippet:
```javascript
const _nfBin = (n) => { const p = require('path').join(require('os').homedir(), '.claude/nf-bin', n); return require('fs').existsSync(p) ? p : './bin/' + n; };
```
AUTONOMY REQUIREMENT: This skill runs FULLY AUTONOMOUSLY. Do NOT ask the user
any questions. Do NOT stop for human input. If a sub-skill fails, log the
failure and continue to the next gap. The only valid reason to stop is:
all gap types exhausted.

RAM BUDGET: Never exceed 3 concurrent subagent Tasks at any point during
execution. Each Task subprocess consumes ~1GB RAM. With MCP servers and the
parent process, 3 parallel tasks keeps total usage under ~20GB. Dispatch in
sequential waves of 3, waiting for each wave to finish before the next.
</execution_context>

<input_contract>
The orchestrator passes a JSON object (as part of the Agent prompt or via a temp file):

```json
{
  "residual_vector": { /* from diagnostic sweep */ },
  "open_debt": [ /* from debt load */ ],
  "heatmap": { /* from heatmap analysis */ },
  "targets": null | { /* observe targets */ },
  "iteration": 1,
  "skip_inline_layers": ["hazard_model", "d_to_c"],
  "preflight_data": { "l3_to_tc_unvalidated": 0 }
}
```

**Optional fields (backward compatible):**
- `skip_inline_layers` (array of strings): layers already handled by the orchestrator's inline dispatch (solve-inline-dispatch.cjs). If missing or not an array, treat as empty — run all layers as before.
- `preflight_data` (object): pre-computed results from gate scripts. If missing, run gate scripts as before.
- `cascade_budget` (object): dispatch limits to prevent cascade blowup. Contains `r_to_f_limit` (number or null). If missing, no limits apply.
</input_contract>

<output_contract>
At the end of execution, emit a compact JSON result:

```json
{
  "status": "ok" | "bail" | "error",
  "reason": null | "convergence_stall" | "all_layers_skipped" | "...",
  "remediation_report": {
    "dispatched": [ /* list of { layer, skill, status } */ ],
    "skipped": [ /* layers with 0 residual */ ],
    "failed": [ /* dispatches that errored */ ],
    "capped_layers": [
      {"layer": "l1_to_l3", "dispatched": 100, "max": 100},
      {"layer": "l3_to_tc", "dispatched": 100, "max": 100}
    ],
    "wave_timing": [
      { "wave": 1, "layers": ["r_to_f", "r_to_d", "t_to_c"], "start_ms": 0, "duration_ms": 12000 },
      { "wave": 2, "layers": ["f_to_t", "c_to_f"], "start_ms": 12000, "duration_ms": 8000 }
    ],
    "total_wall_ms": 45000,
    "sequential_estimate_ms": 120000
  },
  "files_touched": ["path/to/file1.cjs", ".planning/formal/alloy/model.als"]
}
```

When `status` is `"bail"` (e.g., all layers skipped or convergence stall detected), the orchestrator breaks the loop early. When `status` is `"error"`, the orchestrator logs the reason and exits gracefully.
</output_contract>

<process>

## Remediation Dispatch Pattern

Each layer is dispatched as its own **Agent call** to prevent context accumulation. The remediate agent only sees compact JSON results — the detailed remediation output stays in the per-layer subprocess.

Track dispatched, skipped, and failed lists for the output report.

## Step 3: Wave-Parallel Remediation Dispatch

**Important:** Dispatch remediation in dependency-ordered waves because R->F coverage is a prerequisite for F->T test stubs. New formal specs create new invariants needing test backing. Remediation order is enforced by the dependency DAG in `bin/solve-wave-dag.cjs`. Within each wave, layers run in parallel. Cross-wave dependencies are respected.

**Pre-dispatch:** Transition matched debt entries to 'resolving':

```javascript
const { transitionDebtEntries } = require(_nfBin('solve-debt-bridge.cjs'));
const matched = matchDebtToResidual(openDebt, residualVector);
const resolvingFPs = matched.matched.map(m => m.entry.fingerprint);
transitionDebtEntries('.planning/formal/debt.json', resolvingFPs, 'open', 'resolving');
transitionDebtEntries('.planning/formal/debt.json', resolvingFPs, 'acknowledged', 'resolving');
```

Log: `"Debt: {resolvingFPs.length} entries transitioned to 'resolving'"`

**Wave computation:** Load the dependency DAG and compute wave groupings:

```javascript
const { computeWaves } = require(_nfBin('solve-wave-dag.cjs'));
const waves = computeWaves(residualVector);
```

This produces an array of wave objects: `[{ wave: 1, layers: ['r_to_f', 'r_to_d', 't_to_c'] }, ...]`. Layers within a wave have no cross-dependencies and can execute in parallel. Waves with `sequential: true` (the gate chain) execute their layers one at a time within the wave.

**Per-layer Agent dispatch template:** For each layer in a wave, if residual > 0, dispatch:

```
Agent(
  subagent_type="general-purpose",
  description="solve-rem: {layer_label}",
  prompt="Read commands/nf/solve-remediate.md and execute ONLY section '{section_header}'.
Residual detail (JSON): {residual_vector.{layer_key}}
Open debt entries: {relevant_debt_subset}
Heatmap (for 3h only): {heatmap}
After completing the section, determine the classification of this remediation action: 'real_fix' for genuine bug fixes or additions to production code (src/, test/, docs/), 'true_positive_closure' for closing false positives that were actually bugs, 'fp_suppression' for suppressing false positives without fixing code, 'reclassification' for changing classifications or categories without code changes.
Return ONLY this JSON:
{\"layer\": \"{layer_key}\", \"status\": \"ok\" | \"error\" | \"skipped\", \"actions_taken\": N, \"failures\": N, \"summary\": \"...\", \"classification\": \"real_fix\" | \"true_positive_closure\" | \"fp_suppression\" | \"reclassification\"}"
)
```

Parse the compact JSON result. Append to dispatched/skipped/failed lists.

**Wave-parallel dispatch loop:**

For each wave from `computeWaves(residualVector)`:

1. Display wave banner: `"Wave {N}/{total}: dispatching {layers} in parallel"`
2. Record wave start time: `const waveStart = Date.now()`
3. For **inline layers** (d_to_c, hazard_model): execute the section directly at the start of the wave before dispatching parallel agents (they produce minimal output)
4. For **sequential waves** (`wave.sequential === true`): dispatch layers one at a time within the wave (the gate chain: hazard_model -> l1_to_l3 -> l3_to_tc -> per_model_gates)
5. For **parallel waves**: dispatch all Agent layers in the wave simultaneously (up to 3 concurrent per RAM budget)
6. Wait for ALL agents in the wave to complete
7. Record wave end time: `const waveDuration = Date.now() - waveStart`
8. Log: `"Wave {N} complete: {waveDuration}ms"`
9. Track layer-level timing for each dispatched agent
10. Move to next wave

**RAM constraint:** Waves respect the 3-agent limit. Waves with >3 layers are automatically split into sub-waves of 3 by `computeWaves()`. Never exceed 3 concurrent Agent calls at any point.

**Layer reference table** (layers are dispatched by wave grouping, not this table order):

| Layer Key | Section | Agent? |
|-----------|---------|--------|
| r_to_f | 3a. R->F Gaps | Yes — dispatches /nf:close-formal-gaps |
| r_to_d | 3f. R->D Gaps | Yes — spawns nf-executor agent |
| t_to_c | 3c. T->C Gaps | Yes — dispatches /nf:fix-tests |
| p_to_f | 3h-extra. P->F Gaps | Yes — dispatches /nf:close-formal-gaps |
| f_to_t | 3b. F->T Gaps | Yes — spawns nf-executor agents |
| c_to_f | 3d. C->F Gaps | Yes — dispatches /nf:quick |
| f_to_c | 3e. F->C Gaps | Yes — runs verification + dispatches fixes |
| d_to_c | 3g. D->C Gaps | **No** — display-only, keep inline |
| git_heatmap | 3h. Git Heatmap | Yes — dispatches /nf:close-formal-gaps |
| c_to_r + t_to_r + d_to_r | 3i. Reverse Discovery | Yes — interactive human approval |
| hazard_model | 3j. Hazard Model Refresh | **No** — single bash command, keep inline |
| l1_to_l3 | 3k. Gate A (collapsed L1->L3) | Yes — dispatches /nf:quick |
| l3_to_tc | 3m. Gate C | Yes — dispatches /nf:quick |
| per_model_gates | 3m-extra. Per-Model Gates | Yes — dispatches /nf:quick |
| h_to_m | 3n. H->M Gaps | Yes -- dispatches /nf:quick |
| b_to_f | 3a-extra. B->F Gaps | Yes — dispatches /nf:close-formal-gaps + /nf:debug |

---

## Layer Reference Sections

The following sections are executed by per-layer Agent subprocesses. Each sub-agent reads this file and executes ONLY the section matching its dispatch.

### 3a. R->F Gaps (residual_vector.r_to_f.residual > 0)

Extract the list of uncovered requirement IDs from `residual_vector.r_to_f.detail.uncovered_requirements`.

**Cascade budget check:** If `cascade_budget.r_to_f_limit` is a number and the uncovered list has more IDs than the limit, truncate the list to the first `r_to_f_limit` IDs. Log: `"Cascade budget: dispatching {r_to_f_limit} of {total} R→F gaps (F→T has pending work)"`. The remaining IDs will be addressed in subsequent iterations as downstream layers clear. If `r_to_f_limit` is null or missing, dispatch all IDs (no limit).

**Coderlm seed-file discovery and dispatch (CREM-01):**

For each uncovered requirement ID (after applying cascade budget truncation), run the following node snippet to collect seed files via coderlm's synchronous API:

```bash
node -e "
const _nfBin = (n) => { const p = require('path').join(require('os').homedir(), '.claude/nf-bin', n); return require('fs').existsSync(p) ? p : './bin/' + n; };
const { createAdapter } = require(_nfBin('coderlm-adapter.cjs'));
const adapter = createAdapter({ enabled: true });

// Health check — skip entirely if server not responding
const health = adapter.healthSync();
if (health.error) {
  process.stdout.write(JSON.stringify({ seed_files: [], skipped: true, reason: health.error }));
  process.exit(0);
}

const reqId = process.argv[1];
const seedSet = new Set();

// Parse the requirement text to extract a function name heuristic.
// getImplementation expects a symbol name (function/class), NOT a requirement ID string.
// Strategy: use the first camelCase or snake_case token from the requirement description
// that looks like a function name (length >= 4, starts with lowercase letter).
// Fall back to the requirement ID stripped of dashes if no such token is found.
function extractSymbolHint(id) {
  // e.g. 'CREM-01' -> 'crem01' (last-resort fallback)
  return id.replace(/-/g, '').toLowerCase();
}

// Attempt with symbol hint derived from requirement text (caller must pass as argv[2] if known)
const symbolHint = process.argv[2] || extractSymbolHint(reqId);

const impl = adapter.getImplementationSync(symbolHint);
if (impl && impl.file && !impl.error) {
  seedSet.add(impl.file);
  // getCallersSync(symbolHint, impl.file) — first arg is the function name symbol, second arg scopes the search to the implementation file
  const callers = adapter.getCallersSync(symbolHint, impl.file);
  if (callers && callers.callers && !callers.error) {
    for (const c of callers.callers.slice(0, 3)) {
      if (c.file) seedSet.add(c.file);
    }
  }
}

process.stdout.write(JSON.stringify({ seed_files: [...seedSet], skipped: false }));
" -- \"\$REQ_ID\" \"\$SYMBOL_HINT\" 2>/dev/null || echo '{"seed_files":[],"skipped":true,"reason":"node error"}'
```

For each requirement ID:
1. Set `REQ_ID` to the requirement ID (e.g., "REQ-01")
2. Set `SYMBOL_HINT` to the function name derived from the requirement text (if available from the traceability matrix or roadmap requirement text), otherwise leave empty to use the fallback.
3. Run the node snippet above. Parse the JSON output.
4. If `seed_files` is non-empty: set `SEED_FILES_ARG="--seed-files=$(IFS=,; echo "${seed_files[*]}")"` and dispatch individually:
   ```
   /nf:close-formal-gaps --ids=$REQ_ID $SEED_FILES_ARG
   ```
   Log: `"R->F [$REQ_ID]: coderlm seed discovery: ${#seed_files[@]} seed files — dispatching individually"`
5. If `seed_files` is empty (coderlm unavailable OR no implementation found):
   - Accumulate the ID into `$BATCH_IDS`
   - Log: `"R->F [$REQ_ID]: no seed files (skipped=${skipped}) — adding to batch"`

After the per-requirement loop, if `$BATCH_IDS` is non-empty, run the existing batch dispatch:
```
/nf:close-formal-gaps --batch --ids=$BATCH_IDS
```

This preserves the existing batch behavior for all requirements when coderlm is unavailable, while scoping seed-enriched dispatches to individual requirements to prevent cross-contamination.

Note: `$SEED_FILES_ARG` is empty string when coderlm is unavailable — requirements accumulate in `$BATCH_IDS` and the existing batch dispatch fires, preserving pre-integration behavior exactly (fail-open, CADP-02).

Wait for the skill to complete. If it fails, log the failure and continue to the next gap type.

**IMPORTANT — Verify generated models:** After close-formal-gaps completes, run the model checkers on every newly created model:
- **TLA+**: `java -cp <tla2tools.jar> tlc2.TLC -config <MC*.cfg> <*.tla> -workers 1` in `.planning/formal/tla/`
- **Alloy**: `java -jar <alloy.jar> exec --output - --type text --quiet <*.als>` in `.planning/formal/alloy/`

If a model fails verification (syntax error, counterexample, scope error), fix it immediately and re-run. Up to 3 fix attempts per model. Models that pass are confirmed; models that fail after 3 attempts are logged as needing manual review.

Find tool JARs at: `.planning/formal/tla/tla2tools.jar` (or `~/.claude/.planning/formal/tla/tla2tools.jar`) and `.planning/formal/alloy/org.alloytools.alloy.dist.jar` (or `~/.claude/.planning/formal/alloy/org.alloytools.alloy.dist.jar`).

### 3a-extra. B->F Gaps (residual_vector.b_to_f.residual > 0)

**Skip if:** `b_to_f` residual <= 0 or -1.

Read `b_to_f.detail` from the residual vector. Extract:
- `not_covered`: entries from `b_to_f.detail.classification` where `classification === 'not_covered'`
- `covered_not_reproduced`: entries from `b_to_f.detail.classification` where `classification === 'covered_not_reproduced'`

**Priority ordering (per CONTEXT.md decisions):**
- Dispatch `not_covered` before `covered_not_reproduced`
- Within each bucket: sort by `bug_id` ascending (deterministic tiebreaker — repeated failure count sorting deferred to future phase)

**Phase 1 — Route `not_covered` gaps (max 100/cycle):**

Track a counter for B->F not_covered dispatches. For each not_covered entry (up to 100):

1. Extract requirement IDs linked to the failing test from the traceability matrix (stored in `b_to_f.detail.classification[].test` → look up in traceability matrix)
2. If requirement IDs found, dispatch:
   ```
   /nf:close-formal-gaps --batch --ids={linked_requirement_ids}
   ```
   If no requirement IDs are linked (unmapped test), dispatch with `--target={test_file_path}` to generate a model based on the test's code coverage area.
3. Log: `"B->F: dispatching close-formal-gaps for not_covered bug {bug_id} ({N} linked requirements)"`

If the counter reaches 100, log `"B->F: max not_covered dispatches (100) reached this cycle — {N} remaining not_covered gaps deferred"`, append `{ "layer": "b_to_f", "dispatched": 100, "max": 100, "bucket": "not_covered" }` to the `capped_layers` array, and skip remaining not_covered entries.

**Phase 2 — Route `covered_not_reproduced` blind spots (max 100/cycle):**

Track a counter for B->F blind spot dispatches. For each covered_not_reproduced entry (up to 100):

1. Extract the model paths from the classification detail (`b_to_f.detail.classification[].models`)
2. Extract the test file path as the failure context description
3. Dispatch:
   ```
   /nf:debug "{test_file_path}: test fails but formal model passes" --files={model_paths}
   ```
   The debug skill's discovery phase identifies relevant formal models and injects the failure description into spec refinement, biasing toward capturing the failure mode.

   Note: /nf:debug uses formal-model-loop.cjs for iterative
   refinement (convergent loop with callLlm injection, up to 5 iterations).
   The loop generates and validates formal specs until the model explains the bug.

4. Log: `"B->F: dispatching /nf:debug (formal-model-loop, convergent refinement) for blind spot {bug_id} ({N} models to refine)"`

If the counter reaches 100, log `"B->F: max blind spot dispatches (100) reached this cycle — {N} remaining blind spots deferred"`, append `{ "layer": "b_to_f", "dispatched": 100, "max": 100, "bucket": "blind_spots" }` to the `capped_layers` array, and skip remaining blind spot entries.

**Post-dispatch summary:**
Log: `"B->F: {not_covered_dispatched}/{not_covered_total} not_covered, {blind_spot_dispatched}/{blind_spot_total} blind spots dispatched"`

---

### 3b. F->T Gaps (residual_vector.f_to_t.residual > 0)

**Phase 1 — Generate stubs:** Run the formal-test-sync script to generate test stubs and update traceability sidecars:
```bash
node ~/.claude/nf-bin/formal-test-sync.cjs --project-root=$(pwd)
```

If ~/.claude/nf-bin/formal-test-sync.cjs does not exist, fall back to bin/formal-test-sync.cjs (CWD-relative).

Log: `"F->T phase 1: formal-test-sync generated {N} stubs"`

**Phase 1a — Enrich recipes with observed test patterns (CREM-02):** After stubs are generated, run formal-test-sync with `--enrich-recipes` to augment recipe JSON sidecars with assert patterns observed in existing tests via coderlm. This is fail-open — if coderlm is unavailable, enrichment is skipped silently and recipes remain as-is.

```bash
node $([ -f "$HOME/.claude/nf-bin/formal-test-sync.cjs" ] && echo "$HOME/.claude/nf-bin/formal-test-sync.cjs" || echo "bin/formal-test-sync.cjs") --project-root=$(pwd) --report-only --enrich-recipes
```

Note on flag interaction: `--report-only` suppresses stub file writes only; it does NOT suppress recipe JSON mutations. `--enrich-recipes` writes `observed_test_patterns` into recipe JSON regardless of `--report-only`. This is the intended behavior — recipe enrichment is a metadata update, not a stub generation. Verify this is working as expected: after Phase 1a, recipe JSON files should contain `observed_test_patterns` but no new `.test.cjs` stub files should be created.

Log: `"F->T phase 1a: recipe enrichment complete (see stderr for coderlm stats — enriched/skipped/errors)"`

**Phase 1b — Validate recipes:** After stubs are generated and recipes enriched, count recipe files and check completeness:
```bash
node -e "
const fs = require('fs');
const dir = '.planning/formal/generated-stubs';
const recipes = fs.readdirSync(dir).filter(f => f.endsWith('.stub.recipe.json'));
const incomplete = recipes.filter(f => {
  const r = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8'));
  return !r.source_files.length || !r.formal_property.definition;
});
console.log('[solve] Recipes: ' + recipes.length + ' total, ' + incomplete.length + ' incomplete');
"
```
Incomplete recipes (missing source_files or definition) produce lower-quality tests but do NOT block dispatch.

**Phase 2 — Implement stubs via direct parallel executor dispatch:** Stubs alone do not close the gap — they contain `assert.fail('TODO')`. The solver dispatches `nf-executor` agents directly to implement real test logic — it does NOT use `/nf:quick` for bulk stub implementation.

1. **Load context:** Parse `.planning/formal/formal-test-sync-report.json` for each stub's `requirement_id`, `formal_properties[].model_file`, `formal_properties[].property`. Also verify recipe files exist at `.planning/formal/generated-stubs/{ID}.stub.recipe.json` — these contain pre-resolved context (requirement text, property definition, source files, import hints, test strategy).

2. **Group into batches** by category prefix (e.g., all `ACT-*`, all `CONF-*`), max 5 stubs per batch. **No cap per iteration** — process ALL stubs. The convergence loop handles failures.

3. **Cleanup stale batches** — Before scaffolding, remove leftover directories from prior incomplete solve runs:
   ```bash
   for dir in .planning/quick/solve-ft-batch-*/; do
     if [ -d "$dir" ] && [ ! -f "$dir/SUMMARY.md" ] && [ ! -f "$dir/*-SUMMARY.md" ]; then
       rm -rf "$dir"
     fi
   done
   ```
   Log: `"F->T cleanup: removed {N} stale batch directories from prior run"`

4. **Scaffold and execute in just-in-time waves of 3** — To avoid orphan directories when sessions end mid-execution, do NOT write all PLAN.md files upfront. Instead, for each wave, write only that wave's PLAN.md files immediately before dispatching executors.

   MAX_PARALLEL_EXECUTORS = 3. This is a hard limit — never exceed it regardless of batch count.

   For each wave of up to 3 batches:

   **4a. Write PLAN.md files for THIS wave only.** The solve skill IS the planner for these mechanical tasks. For each batch in the wave, write a PLAN.md to `.planning/quick/solve-ft-batch-{iteration}-{B}/PLAN.md` with:
   - YAML frontmatter: `autonomous: true`, `requirements: [IDs]`, `files_modified: [stub paths]`
   - Objective: implement stubs by reading formal model + requirement text + finding source module
   - Task block per batch with `<action>/<verify>/<done>` fields
   - Each task specifies: stub file path, formal model path, property name, requirement text

   PLAN.md template for each batch:
   ```markdown
   ---
   phase: solve-ft-batch-{iteration}-{B}
   plan: 01
   type: execute
   wave: 1
   depends_on: []
   files_modified:
     - .planning/formal/generated-stubs/{ID1}.stub.test.js
     - .planning/formal/generated-stubs/{ID2}.stub.test.js
   autonomous: true
   requirements: [{ID1}, {ID2}]
   formal_artifacts: none
   ---

   <objective>
   Implement {N} test stubs for {category} requirements.

   For each stub, read its recipe JSON for pre-resolved context, then replace
   assert.fail('TODO') with real test logic using node:test + node:assert/strict.

   Formal context:
   - {ID1}: model={model_file} property={property_name} text="{requirement text}"
     recipe=.planning/formal/generated-stubs/{ID1}.stub.recipe.json
   - {ID2}: ...
   </objective>

   <tasks>
   <task type="auto">
     <name>Implement stubs: {ID1}, {ID2}, ... {IDn}</name>
     <files>.planning/formal/generated-stubs/{ID1}.stub.test.js, ...</files>
     <action>
   For each stub:
   1. Read .planning/formal/generated-stubs/{ID}.stub.recipe.json
   1b. If recipe.observed_test_patterns.assert_patterns is a non-empty array, use the assert_patterns and setup_patterns
       as concrete examples to follow. Prefer these observed patterns over generic boilerplate.
       Example: if observed assert_patterns include "assert.strictEqual(result.status, 'ok')",
       model your assertions on the same style.
   2. Read the stub file (.stub.test.js)
   3. Use recipe.formal_property.definition as the property under test
   4. Import from recipe.import_hint (adjust relative path if needed)
   5. Follow recipe.test_strategy:
      - structural: assert function/export exists with correct signature
      - behavioral: call function with known input, assert output matches formal property
      - constant: assert code constant === formal value from property definition
   6. If recipe.source_files is empty, use Grep to find the implementing module
   7. Replace assert.fail('TODO') with real test logic using node:test + node:assert/strict
     </action>
     <verify>node --test .planning/formal/generated-stubs/{ID1}.stub.test.js</verify>
     <done>No assert.fail('TODO') remains. Each stub has real test logic.</done>
   </task>
   </tasks>
   ```

   **4b. Dispatch executors for THIS wave.** Spawn all executors in the wave as parallel sibling Tasks:
   ```
   Wave 1: write 3 PLAN.md files -> Task(subagent_type="nf-executor", description="F->T stubs batch 1"), batch 2, batch 3
   [wait for all 3 to complete]
   Wave 2: write 3 PLAN.md files -> Task(subagent_type="nf-executor", description="F->T stubs batch 4"), batch 5, batch 6
   [wait for all 3 to complete]
   ... continue until all batches dispatched
   ```

   **Why just-in-time:** If a session ends mid-execution, only the current wave's directories exist as orphans (max 3), not the full batch set. Incomplete batches can be resumed via `/nf:resume-quick --pattern=solve-ft-batch-*`.

5. **Run tests once:** `node --test .planning/formal/generated-stubs/*.stub.test.js`. Log pass/fail counts. Failed stubs are handled by T->C in the next iteration.

6. Log: `"F->T phase 2: spawned {N} executors in waves of 3 for {M} stubs (no quorum overhead)"`

### 3c. T->C Gaps (residual_vector.t_to_c.residual > 0)

The T->C residual counts both failures and skipped tests. Extract detail:
- `detail.failed` — tests that ran and failed
- `detail.skipped` — tests marked skip (still count as unresolved gaps)
- `detail.todo` — tests marked todo (informational, do not inflate residual)

Dispatch the fix-tests skill:
```
/nf:fix-tests
```

This will discover and autonomously fix failing AND skipped tests. Skipped tests often indicate incomplete implementations or platform-specific guards that need resolution.

Log: `"Dispatching T->C remediation: fix-tests for {failed} failing + {skipped} skipped tests"`

If it fails, log the failure and continue.

### 3d. C->F Gaps (residual_vector.c_to_f.residual > 0)

Constant mismatches between code and formal specs. Display the mismatch table, then dispatch `/nf:quick` to align them:

```
C->F: {N} constant mismatch(es) — dispatching quick task to align
```

Display detail table:
```
Constant        Source            Formal Value    Config Value
─────────────────────────────────────────────────────────────
constant_name   formal_spec_file  formal_val      config_val
```

Dispatch:
```
/nf:quick Fix C->F constant mismatches: update formal specs OR code config to align these values: {mismatch_summary}
```

If the mismatch has `intentional_divergence: true`, skip it and log as intentional.

### 3e. F->C Gaps (residual_vector.f_to_c.residual > 0)

First, run the formal verification using absolute paths to get fresh failure data:
```bash
node ~/.claude/nf-bin/run-formal-verify.cjs --project-root=$(pwd)
```

If ~/.claude/nf-bin/run-formal-verify.cjs does not exist, fall back to bin/run-formal-verify.cjs (CWD-relative).

Then parse `.planning/formal/check-results.ndjson` and for each entry with `result` of "fail" or "error", classify using `classifyTlcFailure` from `bin/classify-tlc-failure.cjs`:

```bash
CLASSIFIER="$HOME/.claude/nf-bin/classify-tlc-failure.cjs"
[ -f "$CLASSIFIER" ] || CLASSIFIER="bin/classify-tlc-failure.cjs"
FAILURE_CLASS=$(node -e "const {classifyTlcFailure}=require(process.argv[1]); const e=JSON.parse(process.argv[2]); console.log(classifyTlcFailure(e))" "$CLASSIFIER" "$ENTRY_JSON")
```

Then dispatch based on the classification result:

| Classification | failure_class | Dispatch |
|---------------|--------------|----------|
| **Deadlock** | `deadlock` | Auto-fix: Add `Done == phase \in {terminal_states} /\ UNCHANGED vars` stuttering step to the spec. Identify terminal state(s) from the spec's state enum/set. Add `Done` to the `Next` disjunction (`Next == ... \/ Done`). If `Done` already exists, check that it covers all `UNCHANGED vars`. |
| **SANY semantic error** | `sany_semantic` | Auto-fix: Parse the "multiply-defined symbol 'X'" from summary. Find the second binding of `X` (typically in fairness quantifiers like `\A X \in ...`). Rename it to `X_fair` or `Xd` to avoid collision. Verify the rename does not break other references. |
| **Fairness gap** | `fairness_gap` | Auto-fix: Parse the violated temporal property name from summary. Identify the action that is enabled but never fires from the counterexample trace (the stuttering action). Add `WF_vars(ActionName)` to the `Spec` definition's fairness conjunction. If the Spec already has fairness, append with `/\`. |
| **Syntax error** | `syntax_error` | `/nf:quick Fix Alloy/TLA+ syntax error in {model_file}: {error_detail}` |
| **Scope error** | Summary contains "scope", "sig" | `/nf:quick Fix scope declaration in {model_file}: {error_detail}` |
| **Conformance divergence** | check_id contains "conformance" | `/nf:quick Fix conformance trace divergences in {model_file}: {error_detail}` |
| **Invariant violation** | `invariant_violation` | `/nf:quick Fix formal verification counterexample in {check_id}: {summary}` |
| **Missing tool** | "not found", "not installed" in summary | Log as infrastructure gap, skip |
| **Inconclusive** | result = "inconclusive" | Skip -- not a failure |

Dispatch each fixable failure **sequentially** (one at a time) to the appropriate skill. **Deadlock, SANY semantic, and fairness gap failures are auto-fixed first** (no LLM dispatch needed), using the specific instructions above. Then process syntax/scope errors via `/nf:quick` (they're usually quick fixes), then conformance/verification failures (require deeper investigation). Wait for each dispatch to complete before starting the next.

Log: `"F->C: {total} checks, {pass} pass, {fail} fail — dispatching {syntax_count} to quick, {debug_count} to debug, {skip_count} skipped"`

Each dispatch is independent — if one fails, log and continue to the next. Do NOT dispatch F->C fixes in parallel.

**F->C Root-Cause Attribution:** After dispatching all F->C fixes, run `attribute-trace-divergence.cjs` to provide actionable root causes for any conformance divergences:

```bash
ATTR=$(node ~/.claude/nf-bin/attribute-trace-divergence.cjs --output-json 2>/dev/null || node bin/attribute-trace-divergence.cjs --output-json 2>/dev/null || echo '[]')
```

If the script returns non-empty JSON, log each attribution's `recommendation` field. These attributions help the next iteration target the right layer (spec-bug vs impl-bug) when dispatching fixes. Fail-open: if the script is not found or errors, skip silently.

**F->C Trace Corpus Context:** Also run `trace-corpus-stats.cjs` to provide session/action/transition context for the divergences:

```bash
node ~/.claude/nf-bin/trace-corpus-stats.cjs --json 2>/dev/null || node bin/trace-corpus-stats.cjs --json 2>/dev/null || true
```

This writes `.planning/formal/evidence/trace-corpus-stats.json` which enriches subsequent analysis. Fail-open: if the script is not found or errors, skip silently.

### 3f. R->D Gaps (residual_vector.r_to_d.residual > 0)

Requirements that shipped but are not mentioned in developer docs (docs/dev/).
User docs (docs/) are human-controlled and are never auto-modified.

Display the undocumented requirement IDs from `residual_vector.r_to_d.detail.undocumented_requirements`:

```
R->D: {N} requirement(s) undocumented in developer docs:
  - REQ-01
  - REQ-02
  ...
```

Then auto-remediate by dispatching a single `nf-executor` agent directly — it does NOT use `/nf:quick` for bulk doc generation.

1. Read `.planning/formal/requirements.json` to get the text/description for each undocumented requirement ID.
2. For each undocumented ID, identify the most relevant source file(s) by grepping the codebase for the requirement ID and its key terms (use Grep tool).
3. **Write ONE PLAN.md** to `.planning/quick/solve-rd-{iteration}/PLAN.md` covering all undocumented requirements (up to 100). The plan has multiple `<task>` blocks (one per group of ~15 IDs) for natural checkpointing. Each task specifies: requirement IDs, requirement text, relevant source files, and the output format for `docs/dev/requirements-coverage.md`.

   Each task block's action should instruct the executor to append sections following this format:
   ```
   ## {REQ-ID}: {requirement title or first 80 chars of text}

   **Requirement:** {full requirement text}

   **Implementation:** {1-3 sentence summary of how the codebase satisfies this requirement, citing specific files/functions}

   **Source files:** {comma-separated list of relevant source files}
   ```

   Do NOT modify docs/ (user docs). Only write to docs/dev/requirements-coverage.md.

4. **Spawn ONE executor:**
   ```
   Task(subagent_type="nf-executor", description="R->D: generate doc entries for {N} requirements")
   ```
   Wait for it to complete. If it fails, log the failure and continue.

Log: `"R->D: spawned 1 executor for {N} requirements (no quorum overhead)"`

### 3g. D->C Gaps (residual_vector.d_to_c.residual > 0)

**Skip check:** If `d_to_c` is in `skip_inline_layers` array: Log `"D->C: skipped (handled by orchestrator inline dispatch)"` and record as `{"layer": "d_to_c", "status": "skipped-inline"}`. Do NOT display the table again. Proceed to next section.

Stale structural claims in documentation — file paths, CLI commands, or dependencies referenced in docs that no longer exist in the codebase. This is a manual-review-only gap.

Display the broken claims table from `residual_vector.d_to_c.detail.broken_claims`:

```
D->C: {N} stale structural claim(s) in docs:
  Doc File              Line  Type         Value                    Reason
  ──────────────────────────────────────────────────────────────────────────
  README.md             42    file_path    bin/old-script.cjs       file not found
  docs/setup.md         15    cli_command  node bin/missing.cjs     script not found
  docs/deps.md          8     dependency   old-package              not in package.json
```

Log: `"D->C: {N} stale structural claim(s) in docs — manual review required"`

Do NOT dispatch any skill — this is informational only.

### 3h. Git Heatmap Risk Prioritization (G->H)

The diagnostic sweep includes a `git_heatmap` section that identifies **uncovered hot zones** — files with high churn, bugfix frequency, or oscillating numerical constants that lack formal model coverage.

Extract from diagnostic output:
- `residual_vector.git_heatmap.detail.uncovered_hot_zones` — ranked list of files with `priority`, `signals` (churn, bugfix, numerical), and coverage gaps
- `residual_vector.git_heatmap.detail.total_hot_zones` — count of uncovered hot zones

**This is NOT informational-only — it drives formal model prioritization.**

When `total_hot_zones > 0`:
1. Take the top 5 hot zones by priority score
2. For each hot zone file, check if it already has a formal model in `.planning/formal/` (TLA+, Alloy, or PRISM spec referencing the file)
3. For any hot zone file WITHOUT a formal model, dispatch `/nf:close-formal-gaps` with `--target=<file>` to generate an exhaustive formal spec. The `--exhaustive` flag should be passed for files in the top 3 — these are the highest-risk files and warrant thorough state-space modeling rather than lightweight property stubs.
4. For hot zone files WITH existing formal models that have `signals` including `"numerical"` (oscillating constants), dispatch `/nf:quick` to verify the model's constants match current code values — these are drift-prone by definition.

**After formal modeling, refresh proposed metrics:**

Run `analyze-assumptions.cjs` to extract metric proposals from all formal models (including any newly generated ones):
```bash
node ~/.claude/nf-bin/analyze-assumptions.cjs --json --project-root=$(pwd)
```
If `~/.claude/nf-bin/analyze-assumptions.cjs` does not exist, fall back to `bin/analyze-assumptions.cjs`.

This writes `.planning/formal/evidence/proposed-metrics.json` — a structured list of metrics that formal models say should exist in the codebase. Each entry includes `metric_name`, `metric_type`, `tier`, `source_model`, and `instrumentation_snippet`. The `nf:observe` internal handler reads this file and surfaces unimplemented metrics as drifts.

**Why automated:** Unlike reverse discovery (C->R, T->R, D->R) which could cause infinite expansion loops, heatmap-driven formalization is bounded — it only targets files that already exist in the codebase and have demonstrated instability through git history. The formal models it generates enter the existing F->T->C forward flow naturally. The proposed metrics pipeline is also bounded — it only proposes metrics for assumptions that already exist in formal models.

Log: `"Heatmap: {N} hot zones, {M} targeted for formal modeling, {K} already covered, {P} metrics proposed"`

### 3i. Reverse Traceability Discovery (C->R + T->R + D->R)

This step surfaces implementation artifacts that have no requirement backing. Unlike forward layers (which auto-remediate), reverse layers use a **two-step pattern**: autonomous discovery followed by human approval.

**Phase 1 — Discovery (autonomous):**

Extract reverse residuals from the diagnostic sweep (already computed in Step 1):
- `residual_vector.c_to_r.detail.untraced_modules` — source files in bin/ and hooks/ with no requirement tracing
- `residual_vector.t_to_r.detail.orphan_tests` — test files with no @req annotation or formal-test-sync mapping
- `residual_vector.d_to_r.detail.unbacked_claims` — doc capability claims without requirement backing

The diagnostic engine runs `assembleReverseCandidates()` automatically, which:
1. Merges candidates from all 3 scanners
2. Deduplicates (e.g., if test/foo.test.cjs and bin/foo.cjs are both untraced, merge into 1 candidate)
3. Filters out .planning/ files, generated stubs, and node_modules paths
4. Removes candidates present in `.planning/formal/acknowledged-not-required.json`
5. Caps at 200 candidates maximum

If `assembled_candidates.candidates` is empty after dedup + filtering: Log `"Reverse discovery: 0 candidates after dedup/filtering"` and skip Phase 2.

**Phase 2 — Quorum Approval (autonomous):**

For each batch of up to 10 candidates (to keep quorum prompts manageable):

  Build quorum question:
  ```
  Review these reverse-traceability candidates discovered by the nForma solver.
  Each candidate is a code module, test, or doc claim that has no requirement backing.
  For each candidate, determine if it represents a GENUINE requirement that should be added to the requirements envelope.

  Candidates:
  {numbered list with source scanner, evidence, candidate description}

  Vote APPROVE with the list of candidate numbers you consider genuine requirements.
  Vote BLOCK if NONE of the candidates are genuine (all are false positives or noise).

  Criteria for genuine: The candidate represents a real user-facing or system capability that the project intentionally provides but has no formal requirement backing.
  ```

  Dispatch as parallel sibling nf-quorum-slot-worker Tasks (per R3.2).
  Synthesize results, deliberate up to 10 rounds per R3.3.

  **Unanimous gate: 100% of valid external voters must APPROVE the same candidate set.**
  - **APPROVED (unanimous on candidate set)** -> For each approved candidate, dispatch `/nf:add-requirement` with candidate evidence. Write rejected candidates to `.planning/formal/acknowledged-not-required.json`.
  - **BLOCKED (any BLOCK vote)** -> Quorum debates per standard protocol (slots see prior positions, iterate).
    - If consensus reached after debate -> apply outcome.
    - If debate exhausted with no consensus -> Write ALL candidates in this batch to acknowledged-not-required.json with reason "quorum-no-consensus". Log warning: "Reverse discovery batch: quorum could not reach consensus — candidates shelved. Human review recommended."

  Note: Unlike forward-flow auto-remediation, debate exhaustion here does NOT escalate to human interactively. Instead, candidates are shelved (written to acknowledged-not-required.json) and will not resurface. This keeps the solve loop fully autonomous. The user can review acknowledged-not-required.json at leisure.

Log line update: `"Reverse discovery: {N} candidates presented to quorum, {M} approved (unanimous), {K} rejected, {J} shelved (no consensus)"`

### 3j. Hazard Model Refresh (pre-gate)

**Skip check:** If `hazard_model` is in `skip_inline_layers` array: Log `"Hazard model: skipped (handled by orchestrator inline dispatch)"` and record as `{"layer": "hazard_model", "status": "skipped-inline"}`. Do NOT re-run hazard-model.cjs. Proceed to next section.

Before remediating gate failures, refresh the L3 hazard model so gate checks evaluate current data:

```bash
node bin/hazard-model.cjs --json
```

Parse the JSON output. Log: `"Hazard model: {total_hazards} hazards scored, {high_rpn_count} high-RPN (>100)"`

If hazard-model.cjs is not found or fails, skip silently and continue to gate remediation (fail-open). The hazard model is an input to gate evaluation — stale hazard data produces false gate failures.

### 3k. Gate A Remediation (residual_vector.l1_to_l3.residual > 0)

Gate A measures grounding alignment between L1 evidence and L3 reasoning models (L2 collapsed — STRUCT-01). The diagnostic engine already computed the residual via gate-a-grounding.cjs.

**Max dispatches: 100 per solve cycle.** Track a counter for Gate A dispatches. If the counter reaches 100, log `"Gate A: max remediation dispatches (100) reached this cycle — skipping further auto-fixes"`, append `{ "layer": "l1_to_l3", "dispatched": 100, "max": 100 }` to the `capped_layers` array, and skip to Step 3l.

Extract detail from `residual_vector.l1_to_l3.detail`:
- `unexplained_breakdown.instrumentation_bug` — actions not in event-vocabulary.json
- `unexplained_breakdown.model_gap` — actions in vocabulary but XState replay fails
- `unexplained_breakdown.genuine_violation` — model_gap events violating declared invariants

Remediation strategy by classification:

| Classification | Count Field | Dispatch |
|---------------|-------------|----------|
| **instrumentation_bug** | > 0 | `/nf:quick Add missing action mappings to .planning/formal/evidence/event-vocabulary.json for {N} unmapped trace actions from Gate A` |
| **model_gap** | > 0 | `/nf:quick Fix {N} XState model gaps identified by Gate A grounding check — update observed FSM or conformance trace annotations` |
| **genuine_violation** | > 0 | Log as critical: `"Gate A: {N} genuine invariant violations require investigation"` — do NOT auto-remediate (these indicate real bugs requiring manual investigation, not automated dispatch) |

All `/nf:quick` dispatches use default mode (no `--full` flag) to avoid unnecessary overhead during automated remediation. Dispatch instrumentation_bug and model_gap fixes sequentially. Wait for each to complete before the next. Each dispatch increments the Gate A counter.

Log: `"Gate A: grounding_score={score}, {inst_bug} instrumentation bugs, {model_gap} model gaps, {genuine} genuine violations"`

### 3l. Gate B Remediation (residual_vector.l1_to_l3 purpose check)

Gate B verifies every model has requirement backing (purpose check — L2 collapsed, STRUCT-01). Models without requirements lack purpose backing and inflate the residual.

**Max dispatches: 100 per solve cycle.** Track a counter for Gate B dispatches. If the counter reaches 100, log `"Gate B: max remediation dispatches (100) reached this cycle — skipping further auto-fixes"`, append `{ "layer": "l1_to_l3", "dispatched": 100, "max": 100 }` to the `capped_layers` array, and skip to Step 3m.

Gate B score is derived from the aggregate gate computation. If `gate_b_score < 1.0`, models without requirements need requirements added:

```
/nf:quick Add requirement mappings for {N} models without requirement backing identified by Gate B — update model-registry.json requirements arrays (gate_b_score={score})
```

All `/nf:quick` dispatches use default mode (no `--full` flag). Each dispatch increments the Gate B counter.

Log: `"Gate B: gate_b_score={score}, {orphaned_count} models without requirement backing"`

### 3m. Gate C Remediation (residual_vector.l3_to_tc.residual > 0)

Gate C verifies every L3 failure mode maps to at least one test recipe. Unvalidated failure modes lack test coverage.

**Preflight check:** If `preflight_data.l3_to_tc_unvalidated` is present and is a number >= 0, skip the test-recipe-gen.cjs run below. Use the preflight value directly as `unvalidated_count`. Log `"Gate C: using preflight data (unvalidated={N}) — skipping gate script re-runs"`. Still dispatch /nf:quick if unvalidated > 0.

**Max dispatches: 100 per solve cycle.** Track a counter for Gate C dispatches. If the counter reaches 100, log `"Gate C: max remediation dispatches (100) reached this cycle — skipping further auto-fixes"`, append `{ "layer": "l3_to_tc", "dispatched": 100, "max": 100 }` to the `capped_layers` array, and skip.

Extract detail from `residual_vector.l3_to_tc.detail`:
- `unvalidated_count` — failure modes with no test recipe (the diagnostic engine's `unvalidated_entries`)
- `total_failure_modes` — total L3 failure modes

First, regenerate test recipes to ensure freshness (skip if preflight data available):
```bash
node bin/test-recipe-gen.cjs
```

If unvalidated_count is still > 0 after regeneration, use the original `unvalidated_count` from the diagnostic (and the preflight value when present). The standalone `gate-c-validation.cjs` re-check script was removed (its count now comes from the diagnostic engine / preflight data — see Step 5 and the deletion in `chore(quick-241)`), so there is no separate gate script to re-run here.

**Important:** The Gate C freshness step here (the `test-recipe-gen.cjs` regeneration) is a local check only. It does NOT update the `residual_vector` used by the convergence loop in Step 5. The residual_vector is only updated at the top of the next iteration when nf-solve.cjs runs a full re-diagnostic sweep. This is by design — each iteration gets a consistent snapshot from the diagnostic engine rather than piecemeal updates from individual gate scripts.

If unvalidated failures still remain (per the diagnostic/preflight count), dispatch:
```
/nf:quick Generate test recipes for {N} uncovered L3 failure modes identified by Gate C — add entries to .planning/formal/test-recipes/test-recipes.json mapping each failure mode to concrete test steps
```

All `/nf:quick` dispatches use default mode (no `--full` flag). Each dispatch increments the Gate C counter.

Log: `"Gate C: gate_c_score={score}, {unvalidated_count}/{total_failure_modes} failure modes lack test recipes"`

### 3n. H->M Gaps (residual_vector.h_to_m.residual > 0)

Hypothesis violations -- formal model assumptions that diverge from observed reality. Each violated assumption represents a model constant that needs updating.

Extract detail from `residual_vector.h_to_m.detail`:
- `violated` -- count of VIOLATED assumptions
- `measurements_path` -- path to full measurement data

Read `.planning/formal/evidence/hypothesis-measurements.json` and filter to entries with `verdict: "VIOLATED"`.

For each violated measurement:
1. If `actual_source` is "scoreboard" and assumption relates to TP/UNAVAIL rates: dispatch `/nf:quick` to update the PRISM model constants (same flow as C->F constant alignment)
2. If `actual_source` is "conformance-events" and assumption relates to max rounds/iterations: dispatch `/nf:quick` to update the TLA+ CONSTANT definition
3. If `actual_source` is "telemetry" and assumption relates to timeouts/latencies: dispatch `/nf:quick` to update the relevant formal spec bound
4. Otherwise: log as informational -- `"H->M: {assumption_name} violated but no auto-fix strategy -- manual review required"`

**Max dispatches: 100 per solve cycle.** Track a counter for H->M dispatches. If the counter reaches 100, log `"H->M: max remediation dispatches (100) reached this cycle"`, append `{ "layer": "h_to_m", "dispatched": 100, "max": 100 }` to the `capped_layers` array, and skip further auto-fixes.

All `/nf:quick` dispatches use default mode (no `--full` flag).

Log: `"H->M: {violated} violated assumptions, {dispatched} auto-fix dispatches, {skipped} manual-only"`

## Collation: capped_layers

Before emitting the output JSON, collate all `capped_layers` entries accumulated during Gate A (3k), Gate B (3l), Gate C (3m), and H->M (3n) into the `remediation_report.capped_layers` array. If no gate hit its cap, emit an empty array. Initialize `capped_layers = []` at the start of remediation dispatch, and each gate section appends to it when the max-100 cap is reached.

## Files Touched Collection (QUICK-344)

After all waves complete, collect the list of files created or modified by remediation for incremental diagnostic filtering:

```bash
# Get files changed since the remediation started (unstaged + staged + committed during this dispatch)
files_touched=$(git diff --name-only HEAD~$(git log --oneline --since="5 minutes ago" | wc -l | tr -d ' ') HEAD 2>/dev/null || echo "")
```

If the git command fails or returns empty, set `files_touched = []`. Otherwise, split the output by newlines into an array and include in the output JSON as `"files_touched": [...]`.

This is best-effort — if no file tracking is available, the orchestrator falls back to full diagnostic sweep (fail-open).

## Wave Timing and Performance Comparison

After all waves complete, compute and log the timing comparison:

1. Sum all wave durations for total wall-clock time (`total_wall_ms`)
2. Sum all individual layer durations as if they ran one at a time (`sequential_estimate_ms`) — this is the estimated sequential time
3. Compute speedup ratio: `sequential_estimate_ms / total_wall_ms`
4. Add to the output JSON:
   ```json
   "performance": {
     "total_wall_ms": 45000,
     "sequential_estimate_ms": 120000,
     "speedup_ratio": 2.67,
     "waves_executed": 6,
     "layers_dispatched": 14
   }
   ```
5. Log a summary line: `"Remediation: {M} layers in {N} waves, {total_wall_ms}ms wall (est. {sequential_estimate_ms}ms sequential, {speedup_ratio}x speedup)"`

The `wave_timing` array in the remediation report captures per-wave detail:
```json
"wave_timing": [
  { "wave": 1, "layers": ["r_to_f", "r_to_d", "t_to_c"], "start_ms": 0, "duration_ms": 12000 },
  { "wave": 2, "layers": ["f_to_t", "c_to_f", "p_to_f"], "start_ms": 12000, "duration_ms": 8000 }
]
```

Each wave records: the wave number, layer keys dispatched, start offset from remediation begin, and wall-clock duration. For parallel waves, `duration_ms` is the time of the slowest layer. For sequential waves, it is the sum of all layer durations within the wave.

## Step 4: Run Real Tests and Lint

After all remediation waves complete, run real tests and lint to identify any new failures introduced by the changes:

```bash
npm run test:ci
npm run lint:isolation
```

Parse the output for failures:
- If `npm run test:ci` exits non-zero, extract failing test files from TAP output
- If `npm run lint:isolation` exits non-zero, extract lint violations

For each real failure:
1. Classify the failure type (test failure vs lint error)
2. Dispatch `/nf:quick` to fix the failure: "Fix {failure_type} in {file}: {error_message}"
3. Wait for each fix to complete before starting the next

Log: `"Real tests: {pass_count}/{total} pass, {fail_count} failures — dispatched {fix_count} quick fixes"`

This ensures remediation produces working code, not just formal artifacts.

4. **Ordering** — Remediation order is enforced by the dependency DAG in `bin/solve-wave-dag.cjs`. Within each wave, layers run in parallel. Cross-wave dependencies are respected. R->F must precede F->T (new formal specs create new invariants needing test backing). T->C fixes must happen before F->C verification (tests must pass before checking formal properties against code).

5. **State machine bias** — when implementing or fixing logic that manages distinct states and conditional transitions (3+ states), prefer a state machine library from the supported registry (28 frameworks across 13 languages). State machines defined this way are automatically transpiled to TLA+ by `bin/fsm-to-tla.cjs`, closing the formal verification loop. Match complexity to the problem: flat FSMs get lightweight libraries (e.g., `javascript-state-machine`, `transitions`, `looplab/fsm`), while complex workflows get statechart libraries (e.g., XState, `sismic`, Spring Statemachine). See `.claude/rules/state-machine-bias.md` for the full framework selection table.

6. **Full skill arsenal** — the solver dispatches to the right skill for each gap type. It never stops at "stubs generated" or "manual review required" if a skill exists that can attempt the fix. The hierarchy is:
   - **close-formal-gaps --batch** for missing formal models (R->F), then **run model checkers** to verify them
   - **formal-test-sync** to generate stubs (F->T phase 1), then **direct parallel executor dispatch** to implement real test logic (F->T phase 2)
   - **fix-tests** for failing tests (T->C)
   - **quick** for constant mismatches (C->F), syntax/scope errors, conformance divergences (F->C)
   - **direct executor dispatch** for R->D documentation generation

9. **Layer alignment remediation** — Gate A/B/C failures and H->M violations are remediated via `/nf:quick` dispatch (default mode, no `--full` flag) after the hazard model is refreshed (Step 3j). The full dependency chain is: hazard-model refresh (3j) -> Gate A (3k, L1->L3) -> Gate B (3l, purpose) -> test-recipe-gen (in 3m) -> Gate C (3m, L3->TC). H->M (3n) runs independently (no dependencies). This ordering ensures: (a) L3 artifacts are fresh before gates evaluate them, (b) Gate A (L1->L3) fixes propagate before Gate B (purpose) checks requirement backing, (c) test recipes are regenerated before Gate C (L3->TC) evaluates coverage. Each gate and H->M remediation is capped at 100 dispatches per solve cycle to prevent runaway loops if residuals never converge.

</process>

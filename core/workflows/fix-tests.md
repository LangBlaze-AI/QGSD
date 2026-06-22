# fix-tests Workflow

## Overview

4-phase ddmin pipeline: (1) full-suite pinned-order baseline capture + per-test ddmin isolation + dependency graph construction, (2) triage report generation + R3 quorum approval gate, (3) sequential dependency-ordered fixing with per-fix quorum approval + regression detection, (4) final full-suite verification + quorum-reviewed terminal report.

This workflow replaces the batch-based approach. Batching hides cross-batch test pollution — a fix in one batch that changes how another batch's test fails goes undetected because the post-batch run still reports the same test as failing. The ddmin pipeline eliminates this blind spot: tests are fixed in dependency order after the pollution topology is fully understood and quorum-approved.

---

## Invocation

Fresh start is default. `--resume` resumes from the saved `pipeline_phase` in state.

```bash
# Check if --resume flag was passed
# If --resume AND valid state exists: load state, resume from saved pipeline_phase
# If fresh start: clear any existing ddmin-*.json planning files and start from Step 1.1
```

On fresh start, clear stale artifacts:
```bash
rm -f .planning/ddmin-discover.json .planning/ddmin-manifest.json .planning/ddmin-baseline.json \
      .planning/ddmin-triage-report.md .planning/ddmin-final-report.md \
      .planning/ddmin-signatures.json .planning/ddmin-flakiness.json \
      .planning/ddmin-results-all.json .planning/ddmin-graph.json
```

---

## Phase 1: ddmin Isolation

### Step 1.1: Set Activity

```bash
node ~/.claude/nf/bin/nf-tools.cjs activity-set \
  '{"activity":"fix_tests","sub_activity":"ddmin_isolation","state_file":".planning/maintain-tests-state.json"}'
```

Print: `nForma fix-tests: Phase 1 — ddmin isolation`

### Step 1.2: Discover Tests

```bash
node ~/.claude/nf/bin/nf-tools.cjs maintain-tests discover \
  --output-file .planning/ddmin-discover.json
```

Read `.planning/ddmin-discover.json`. Extract total test count.

Print: `nForma fix-tests: Discovered {N} test files`

### Step 1.3: Full-Suite Pinned Run (Baseline Capture)

Pin execution order with a fixed seed. **This seed MUST be used for all subsequent ddmin invocations** to guarantee the same relative test ordering.

```bash
BASELINE_SEED=42

# Create a single mega-batch containing ALL tests in seed-pinned order
node ~/.claude/nf/bin/nf-tools.cjs maintain-tests batch \
  --input-file .planning/ddmin-discover.json \
  --seed $BASELINE_SEED \
  --size 9999 \
  --manifest-file .planning/ddmin-manifest.json

# Run all tests (single batch, index 0)
node ~/.claude/nf/bin/nf-tools.cjs maintain-tests run-batch \
  --batch-file .planning/ddmin-manifest.json \
  --batch-index 0 \
  --timeout 3600 \
  --output-file .planning/ddmin-baseline.json
```

Read `.planning/ddmin-baseline.json`. Extract:
- `passing_tests`: results where `status == "passed"` or `status == "skipped"`
- `failing_tests`: results where `status == "failed"` and `flaky != true`
- `flaky_initial`: results where `status == "flaky"`

Print: `nForma fix-tests: Baseline complete — {pass_count + fail_count + flaky_count} individual tests ({pass_count} passed, {fail_count} failed, {flaky_count} initially-flaky)`

### Step 1.4: Compute Failure Signatures

For each test in `failing_tests`, compute a normalized SHA-256 error signature using an inline Python script. Write the Python script to `/tmp/compute-signatures.py` using the Write tool, then execute it.

The script reads `.planning/ddmin-baseline.json`, applies these normalization rules to each failed test's `error_summary`:
1. Strip line numbers: replace `:\d+:\d+` patterns with `:LINE:COL`
2. Strip absolute paths: replace the CWD prefix with `<ROOT>/`
3. Strip UUIDs: replace `[0-9a-f-]{36}` with `<UUID>`
4. Strip ISO timestamps: replace `\d{4}-\d{2}-\d{2}T[\d:.Z]+` with `<TS>`
5. Lowercase and strip

Compute SHA-256 of the normalized string. Write output to `.planning/ddmin-signatures.json`:
```json
{
  "seed": 42,
  "signatures": {
    "path/to/test.test.js": {
      "status": "failed",
      "error_hash": "<sha256>",
      "error_summary": "<first 500 chars of original error_summary>",
      "normalized": "<normalized error text>"
    }
  }
}
```

```bash
python3 /tmp/compute-signatures.py
```

Print: `nForma fix-tests: Signatures computed for {N} failing tests`

### Step 1.5: Flakiness Pre-Filter (N=10 reruns)

Before running ddmin, classify each failing test into one of three categories based on isolation fail rate AND baseline full-suite behavior:

| Category | Isolation Fail Rate | Full-Suite Fail? | Action |
|----------|-------------------|------------------|--------|
| `independent_failure` | High (8-10/10) | Yes | ddmin (or skip ddmin if 10/10 — see Step 1.6) |
| `pollution_victim` | Low (0-2/10) | Yes | ddmin (test passes alone but fails in suite) |
| `true_flaky` | Medium (3-7/10) | Sometimes | Skip ddmin |

Write an inline Python script to `/tmp/flakiness-filter.py` using the Write tool. The script:
1. Reads the list of failing tests from `.planning/ddmin-signatures.json`
2. For each failing test, reruns it 10 times in isolation using `run-batch` with a single-test manifest
3. Counts `fail_count` out of 10
4. Classifies using three-way logic:
   - If `fail_count >= 8` → `independent_failure` (stable in isolation — fails on its own)
   - If `fail_count <= 2` → `pollution_victim` (passes in isolation — a co-runner pollutes it)
   - If `3 <= fail_count <= 7` → `true_flaky` (non-deterministic — skip ddmin)
5. Both `independent_failure` and `pollution_victim` tests proceed to ddmin. Only `true_flaky` tests are excluded.
6. Writes `.planning/ddmin-flakiness.json`:

```json
{
  "stable": ["path/to/independent.test.js", "path/to/victim.test.js"],
  "flaky": ["path/to/flaky.test.js"],
  "pollution_victims": ["path/to/victim.test.js"],
  "independent_failures": ["path/to/independent.test.js"],
  "details": {
    "path/to/test.test.js": {
      "rerun_count": 10,
      "fail_count": 7,
      "category": "true_flaky|independent_failure|pollution_victim"
    }
  }
}
```

Note: `stable` is the union of `independent_failures` + `pollution_victims` (all tests proceeding to ddmin). This preserves backward compatibility with Step 1.6 which reads `stable`.

Script uses the same `BASELINE_SEED` for all single-test reruns. The NF_TOOLS path is `~/.claude/nf/bin/nf-tools.cjs`. Each single-test rerun invocation MUST include `--timeout 60` to prevent hung runners from stalling the flakiness loop indefinitely.

```bash
python3 /tmp/flakiness-filter.py
```

Read `.planning/ddmin-flakiness.json`. Extract `stable` (list of tests proceeding to ddmin), `flaky` (list skipped), `pollution_victims`, and `independent_failures`.

Print: `nForma fix-tests: Flakiness filter — {independent_count} independent, {victim_count} pollution victims (→ ddmin), {flaky_count} true flaky (→ skipped)`

### Step 1.6: ddmin Per Failing Test

For each test in `stable` from Step 1.5, run ddmin — **unless the test fails 10/10 in isolation**, in which case skip ddmin and classify directly as `independent_failure` with `polluter_set: []`. A test that fails 100% in isolation has no pollution dependency; ddmin would always return an empty polluter set, wasting subprocess overhead.

**Cap: if `stable` has more than 100 tests, process only the first 100 and flag the rest as `unanalyzed` in state.** (Scope bound to prevent runaway execution time.)

Write a Python orchestration script to `/tmp/ddmin-orchestrator.py`. The script:

1. Reads `.planning/ddmin-manifest.json` (the pinned-order full-suite manifest) to get the ordered list of all tests.
2. Reads `.planning/ddmin-flakiness.json` to get the `stable` list and `details` (with per-test `fail_count`).
3. For each failing test in `stable` (up to 100):

   **Short-circuit for 10/10 independent failures:**
   ```python
   details = flakiness_data['details'][test]
   if details['fail_count'] == 10:
       # Test fails 100% in isolation — no pollution possible, skip ddmin
       results.append({
           "failing_test": test,
           "polluter_set": [],
           "ddmin_ran": False,
           "runs_performed": 0,
           "reason": "independent_failure_confirmed_by_flakiness_filter",
           "run_cap_reached": False
       })
       continue
   ```

   **For all other tests (pollution victims with 0-2/10, or borderline 8-9/10), run ddmin:**

   a. Build a candidates list: ALL tests from the pinned manifest EXCEPT the target failing test, preserving the original seed order. This is critical — same order as baseline.

   b. Write candidates to `.planning/ddmin-candidates-<hash>.json` where `<hash>` is the first 8 chars of SHA-256 of the test file path.

   c. Run ddmin via shell:
   ```bash
   node ~/.claude/nf/bin/nf-tools.cjs maintain-tests ddmin \
     --failing-test <target_test> \
     --candidates-file .planning/ddmin-candidates-<hash>.json \
     --run-cap 200 \
     --timeout 300 \
     --output-file .planning/ddmin-result-<hash>.json
   ```

   d. Read `.planning/ddmin-result-<hash>.json`. Record: `failing_test`, `polluter_set`, `ddmin_ran`, `runs_performed`, `reason`.

4. Writes `.planning/ddmin-results-all.json`:
```json
{
  "results": [
    {
      "failing_test": "path/to/test.test.js",
      "polluter_set": ["path/to/polluter.test.js"],
      "ddmin_ran": true,
      "runs_performed": 12,
      "reason": "minimal polluter set found",
      "run_cap_reached": false
    }
  ],
  "unanalyzed": ["path/to/test-101.test.js"]
}
```

```bash
python3 /tmp/ddmin-orchestrator.py
```

Print progress for each ddmin run: `nForma fix-tests: ddmin [{target}] → {N} polluters ({runs} runs)`

Print after all: `nForma fix-tests: ddmin complete — {N} tests analyzed, {U} unanalyzed (>100 cap)`

### Step 1.7: Build Dependency Graph + Detect Cycles

Write a Python script to `/tmp/build-graph.py`. The script:

1. Reads `.planning/ddmin-results-all.json`.
2. Builds a directed graph: edge `polluter → failing_test` (polluter must be fixed before failing_test).
3. Classifies each test:
   - `independent_failures`: `ddmin_ran == true` AND `polluter_set == []` (fails alone consistently)
   - `pollution_chains`: `polluter_set` non-empty → directed dependency edges
   - `unanalyzed`: from `unanalyzed` list in results

4. Cycle detection using iterative DFS (Tarjan-style SCC):
   - Find all strongly connected components with size > 1 → these are cycle groups
   - Mark nodes in cycle groups separately

5. Topological sort (Kahn's algorithm) over the DAG (excluding cycle-group nodes) to produce `fix_order`:
   - Order: independent_failures first, then topologically sorted pollution chain nodes (polluters before polluted), then flaky tests (from Step 1.5), then cycle groups last, then unanalyzed last
   - Within each group: sort by test file path for determinism

6. Writes `.planning/ddmin-graph.json`:
```json
{
  "nodes": ["path/to/a.test.js"],
  "edges": [{"from": "path/to/polluter.test.js", "to": "path/to/victim.test.js", "type": "pollutes", "run_cap_reached": false}],
  "cycles": [["path/to/a.test.js", "path/to/b.test.js"]],
  "independent_failures": ["path/to/c.test.js"],
  "flaky": ["path/to/d.test.js"],
  "unanalyzed": [],
  "fix_order": ["path/to/c.test.js", "path/to/polluter.test.js", "path/to/victim.test.js"]
}
```

```bash
python3 /tmp/build-graph.py
```

Print: `nForma fix-tests: Graph built — {independent} independent, {chains} pollution chains, {cycles} cycle groups, {flaky} flaky`

### Step 1.8: Save Phase 1 State

Save the full Phase 1 state using `maintain-tests save-state`. Build the state JSON conforming to schema_version 2:

```json
{
  "schema_version": 2,
  "pipeline_phase": "triage",
  "baseline_seed": 42,
  "baseline_signatures": "<contents of ddmin-signatures.json signatures field>",
  "flakiness": "<contents of ddmin-flakiness.json details field>",
  "dependency_graph": "<contents of ddmin-graph.json>",
  "triage_report_path": ".planning/ddmin-triage-report.md",
  "triage_quorum_verdict": null,
  "fix_order": "<fix_order array from ddmin-graph.json>",
  "fix_log": [],
  "current_fix_index": 0,
  "regression_detected": false,
  "final_report_path": ".planning/ddmin-final-report.md",
  "final_quorum_verdict": null
}
```

```bash
node ~/.claude/nf/bin/nf-tools.cjs maintain-tests save-state \
  --state-json '<state JSON>'
```

Print: `nForma fix-tests: Phase 1 complete — state saved (pipeline_phase: triage)`

---

## Phase 2: Triage Report + Quorum Approval

### Step 2.1: Generate Triage Report

Write an inline Python script to `/tmp/generate-triage.py` that reads `.planning/ddmin-graph.json`, `.planning/ddmin-flakiness.json`, and `.planning/ddmin-results-all.json`, and writes `.planning/ddmin-triage-report.md` using this exact template:

```markdown
# nForma ddmin Triage Report

**Generated:** <ISO timestamp>
**Baseline seed:** 42
**Total tests:** {total} | **Failing (stable):** {stable_count} | **Flaky:** {flaky_count} | **Cycle groups:** {cycle_count} | **Unanalyzed:** {unanalyzed_count}

## 1. Independent Failures (fix first — no dependencies)

| Test | Ddmin Runs | Notes |
|------|-----------|-------|
| {test_path} | {runs_performed} | isolated {fail_count}/10 |

(If none: "None identified.")

## 2. Pollution Chains (fix polluters before polluted tests)

### Chain {N}
| Order | Test | Role |
|-------|------|------|
| 1 | {polluter_path} | POLLUTER |
| 2 | {victim_path} | POLLUTED |

(If none: "No pollution chains identified.")

## 3. Cycle Groups (require atomic fix or quarantine)

### Cycle {N}
Tests: [{test_a}, {test_b}]
Note: Tests pollute each other. Fix atomically (shared state in beforeEach/afterEach) or quarantine.

(If none: "No cycles detected.")

## 4. Flaky Tests (fix last or skip)

| Test | Fail Rate | Notes |
|------|-----------|-------|
| {test_path} | {fail_count}/10 | Statistical flakiness |

(If none: "No flaky tests identified.")

## 5. Proposed Fix Order

{fix_order list, one per line with index}

## 6. Unanalyzed (>100 test cap)

{unanalyzed list or "None — all failing tests were analyzed."}
```

```bash
python3 /tmp/generate-triage.py
```

Print: `nForma fix-tests: Triage report generated → .planning/ddmin-triage-report.md`

### Step 2.2: Quorum Approval Gate

**This is a hard gate. Do NOT proceed to Phase 3 until quorum returns APPROVED.**

Run quorum inline — follow the canonical protocol in @core/references/quorum-dispatch.md. Mode A — artifact review:
- artifact_path: `.planning/ddmin-triage-report.md`
- review_context: "Review the test triage report. Evaluate: (1) independent failures are genuine bugs, (2) pollution chains ordered correctly, (3) cycle groups identified, (4) fix order safe. Vote APPROVE to proceed with fixing or BLOCK with concerns."
- Question: "Does the triage report correctly categorize test failures and is the fix ordering sound? Evaluate: (1) independent failures look like genuine standalone bugs, (2) pollution chains ordered correctly, (3) cycle groups properly identified, (4) fix order safe to execute. Vote APPROVE to begin fixing, or BLOCK with specific concerns."
- **Exact YAML format for worker prompts** (from reference section 4):
  ```yaml
  slot: <slotName>
  round: <round_number>
  timeout_ms: <from $SLOT_TIMEOUTS or 300000>
  repo_dir: <absolute path to project root>
  mode: A
  question: "Does the triage report correctly categorize test failures..."
  artifact_path: .planning/ddmin-triage-report.md
  review_context: "Review the test triage report for correctness..."
  prior_positions: |
    [included from Round 2 onward]
  ```
- Build `$DISPATCH_LIST` first (quorum.md Adaptive Fan-Out: read risk_level → compute FAN_OUT_COUNT → take first FAN_OUT_COUNT-1 slots from active working list). Then dispatch `$DISPATCH_LIST` as sibling `nf-quorum-slot-worker` Tasks — do NOT dispatch slots outside `$DISPATCH_LIST`
- Synthesize results inline, deliberate up to 10 rounds per R3.3

Parse the quorum verdict from inline synthesis.

- If `APPROVED`: continue to Step 2.3.
- If `BLOCKED`: print the block reason, update state `triage_quorum_verdict = "BLOCKED"`, save state, and HALT. Print instructions to the user: `nForma fix-tests: Triage BLOCKED by quorum. Review .planning/ddmin-triage-report.md and re-run after addressing concerns.`

Print: `nForma fix-tests: Triage quorum verdict: {verdict}`

### Step 2.3: Save Phase 2 State

Update state: set `triage_quorum_verdict = "APPROVED"`, `pipeline_phase = "fixing"`.

```bash
node ~/.claude/nf/bin/nf-tools.cjs maintain-tests save-state \
  --state-json '<updated state with triage_quorum_verdict = "APPROVED" and pipeline_phase = "fixing">'
```

Print: `nForma fix-tests: Phase 2 complete — quorum approved, pipeline_phase: fixing`

---

## Phase 3: Sequential Fixing

Phase 3 iterates through `state.fix_order` (from the dependency graph). Each fix is:
1. State-diffed for root-cause evidence
2. AI-proposed with quorum approval
3. Committed with regression test + approval record
4. Followed by a full-suite re-run and signature diff

### Step 3.0: Pre-Phase Guard + Load Fix Order

**Working tree check (skip if `current_fix_index > 0` — i.e., resuming mid-phase):**
```bash
git status --porcelain
```
If output is non-empty: print `nForma fix-tests: ERROR — working tree is dirty before Phase 3 begins. Commit or stash changes before running fix-tests.` and exit.

**Branch isolation (skip if resuming):**
Create a timestamped fix branch to keep fixes isolated:
```bash
git checkout -b fix-tests/$(date +%Y%m%d-%H%M%S)
```
If branch creation fails (already on a fix-tests/* branch from a previous run): continue on current branch — this is a resume scenario.

Load state via `maintain-tests load-state`. Extract:
- `fix_order`: ordered list of tests to fix
- `current_fix_index`: index of next test to fix (allows resume)
- `fix_log`: existing fix records
- `dependency_graph.cycles`: cycle groups

Read `current_fix_index`. If it equals `len(fix_order)`: all tests processed — skip to Phase 4.

### Step 3.1: Handle Cycle Groups First

Before processing `fix_order`, identify cycle groups from `state.dependency_graph.cycles`. For each cycle group:

**Cycle resolution strategy:**
Spawn a Task sub-agent to diagnose the shared state causing the cycle and propose an atomic fix:

```
Task(
  prompt="You are diagnosing a test cycle group that requires an atomic fix.

Cycle group: {list of test files in cycle}

Instructions:
1. Read each test file in the cycle group.
2. Identify the shared state (global variable, DB table, file, module-level singleton, or beforeAll/afterAll hook) that creates the bidirectional pollution.
3. Propose a single atomic fix that resolves all tests in the cycle simultaneously (typically: add beforeEach/afterEach cleanup for the shared state).
4. The fix must not change test assertions — only add isolation teardown.

Return a JSON object:
{
  'shared_state_identified': '<description>',
  'fix_description': '<one paragraph>',
  'files_to_modify': ['path/to/file.js'],
  'confidence': 'high|medium|low'
}
",
  description="Diagnose cycle group: {cycle_tests}"
)
```

Wait for the Task to return.

- If `confidence == "high"` or `"medium"`: proceed to per-fix quorum approval (Step 3.3) with the proposed cycle fix. Apply it atomically (all files in the cycle group in a single commit). After commit, proceed to regression check (Step 3.4).
- If `confidence == "low"` or Task fails: quarantine the cycle group. Write a quarantine record to state:
  ```json
  {
    "cycle_group": ["path/to/a.test.js", "path/to/b.test.js"],
    "status": "quarantined",
    "reason": "No shared state identified with sufficient confidence",
    "timestamp": "<ISO timestamp>"
  }
  ```
  Append to `state.fix_log`. Save state. Print: `nForma fix-tests: Cycle group quarantined — {files}. Documented in fix_log.`
  Continue to next group.

Print per-cycle outcome: `nForma fix-tests: Cycle group {N} → {resolved|quarantined}`

**After all cycle groups processed — filter fix_order:**
Build `cycle_group_tests`: the union of all test paths that appear in ANY entry of `state.dependency_graph.cycles`. Filter `state.fix_order` to remove all entries in `cycle_group_tests`. Update `state.fix_order` in the state JSON and save state. This prevents cycle group tests from being re-encountered in the sequential fix loop.

```
state.fix_order = [t for t in state.fix_order if t not in cycle_group_tests]
state.current_fix_index = 0  # Reset since list changed
```

Print: `nForma fix-tests: Filtered {N} cycle-group tests from fix_order. Sequential loop has {len(fix_order)} tests.`

### Step 3.2: Capture State Diff (per fix)

For the current test at `fix_order[current_fix_index]`:

Print: `nForma fix-tests: Fixing [{current_fix_index + 1}/{len(fix_order)}] {test_file}`

Set activity:
```bash
node ~/.claude/nf/bin/nf-tools.cjs activity-set \
  '{"activity":"fix_tests","sub_activity":"fixing","test_file":"{test_file}","fix_index":{current_fix_index},"state_file":".planning/maintain-tests-state.json"}'
```

**Capture pre-fix state evidence.** This diff will be passed to the fix proposal agent as context.

Run the failing test once in isolation to capture its current failure output:
```bash
node ~/.claude/nf/bin/nf-tools.cjs maintain-tests run-batch \
  --batch-file /tmp/single-test-manifest-{hash}.json \
  --batch-index 0 \
  --timeout 120 \
  --output-file /tmp/pre-fix-result-{hash}.json
```
(Build the single-test manifest using `maintain-tests batch --input-json '{"test_files":["<test_file>"]}' --seed $BASELINE_SEED --size 1 --manifest-file /tmp/single-test-manifest-{hash}.json`)

Record the current failure output (`error_summary`) as `pre_fix_error`.

Get polluter context from state: read `state.dependency_graph.edges` to find edges where `to == test_file`. These are the polluter tests. Pass their paths as additional context.

### Step 3.3: AI Proposes Fix + Quorum Approval

Spawn a fix proposal Task sub-agent:

```
Task(
  prompt="You are proposing a fix for a failing test.

Test file: {test_file}
Failure output (pre-fix):
{pre_fix_error}

Polluters (tests that cause this failure when run first):
{polluter_list — or 'None (independent failure)'}

From the dependency graph:
- This test is: {independent failure | polluted by <polluters>}
- Ddmin runs to confirm: {runs_performed}

Instructions:
1. Read the test file: Read({test_file})
2. If polluters exist: read the first polluter file to understand the shared state.
3. Identify the root cause (shared global variable, uncleaned DB state, unreset module-level variable, etc.).
4. Propose a minimal fix:
   - For pollution: add beforeEach/afterEach cleanup in the TEST file (not the source code) to reset the shared state.
   - For independent failures: fix the underlying code defect or update the test assertion if the code was intentionally changed.
5. Write a one-paragraph fix description including: root cause, specific variable/function/table being cleaned, which file is modified, and why.

Return a JSON object:
{
  'root_cause': '<one sentence>',
  'fix_description': '<one paragraph>',
  'files_to_modify': ['path/to/file.js'],
  'fix_type': 'cleanup|assertion_update|code_fix',
  'confidence': 'high|medium|low'
}
",
  description="Propose fix for {test_file}"
)
```

Wait for the Task to return. Extract `fix_description`, `files_to_modify`, `root_cause`.

**Write fix evidence bundle to `.planning/fix-evidence-{hash}.md`:**

```markdown
# Fix Evidence: {test_file}

**Fix index:** {current_fix_index}
**Timestamp:** <ISO timestamp>

## Failure Output (pre-fix)
{pre_fix_error}

## Polluters
{polluter_list or "None"}

## Proposed Fix
{fix_description}

## Root Cause
{root_cause}

## Files to Modify
{files_to_modify}
```

**Quorum approval gate:**

Run quorum inline — follow the canonical protocol in @core/references/quorum-dispatch.md. Mode A — artifact review:
- artifact_path: `.planning/fix-evidence-{hash}.md`
- review_context: "Review the proposed fix. Evaluate: (1) root cause matches failure, (2) fix is minimal and correct, (3) fix prevents pollution chain. Vote APPROVE to apply or BLOCK with concerns."
- Question: "Does this fix correctly address the root cause without introducing regressions? Evaluate: (1) root cause explanation matches failure output, (2) fix is minimal and correct, (3) fix prevents the pollution chain. Vote APPROVE to proceed, or BLOCK with specific concerns."
- **Exact YAML format for worker prompts** (from reference section 4):
  ```yaml
  slot: <slotName>
  round: <round_number>
  timeout_ms: <from $SLOT_TIMEOUTS or 300000>
  repo_dir: <absolute path to project root>
  mode: A
  question: "Does this fix correctly address the root cause..."
  artifact_path: .planning/fix-evidence-{hash}.md
  review_context: "Review the proposed fix for correctness and safety"
  prior_positions: |
    [included from Round 2 onward]
  ```
- Build `$DISPATCH_LIST` first (quorum.md Adaptive Fan-Out: read risk_level → compute FAN_OUT_COUNT → take first FAN_OUT_COUNT-1 slots from active working list). Then dispatch `$DISPATCH_LIST` as sibling `nf-quorum-slot-worker` Tasks — do NOT dispatch slots outside `$DISPATCH_LIST`
- Synthesize results inline, deliberate up to 10 rounds per R3.3

- If `APPROVED`: proceed to Step 3.4.
- If `BLOCKED`: print block reason. Save state (do not increment `current_fix_index`). Print: `nForma fix-tests: Fix BLOCKED by quorum for {test_file}. Halting. Review .planning/fix-evidence-{hash}.md and re-run.` Then HALT.

Print: `nForma fix-tests: Fix quorum verdict [{test_file}]: {verdict}`

### Step 3.4: Apply Fix, Add Regression Test, Commit

Spawn a fix-application Task sub-agent:

```
Task(
  prompt="Apply an approved fix to a test file.

Fix details:
{fix_description}

Files to modify: {files_to_modify}

Instructions:
1. Apply the fix exactly as described — no scope creep.
2. Write a regression test that verifies the fix:
   - Create a new file at `tests/__regression__/{test_file_stem}-regression.test.{ext}` (use same extension as original test file).
   - The regression test must: import the relevant module/function, set up the SAME conditions that caused the failure (including the shared state that was polluting), and assert the test passes without cleanup.
   - If a regression test is not applicable (e.g., the fix is a beforeEach cleanup): create a minimal regression test that verifies the cleanup runs correctly.
3. Run the fixed test in isolation to confirm it passes:
   ```bash
   node ~/.claude/nf/bin/nf-tools.cjs maintain-tests run-batch \
     --batch-file /tmp/single-test-manifest-{hash}.json \
     --batch-index 0 \
     --timeout 120 \
     --output-file /tmp/post-fix-result-{hash}.json
   ```
4. Read `/tmp/post-fix-result-{hash}.json`. Confirm `status == 'passed'`.
5. If the test still fails after the fix: report the failure output and DO NOT commit. Return: {'status': 'fix_failed', 'error': '<failure output>'}
6. If the test passes: commit with this exact structure:

```bash
git add {files_to_modify} tests/__regression__/{regression_file}
git commit -m 'fix(tests): {one-line fix description}

Root cause: {root_cause}

Fix: {fix_description}

Regression test: tests/__regression__/{regression_file}

Quorum approval: APPROVED ({model_count} models: {model_list})
Approval timestamp: {timestamp}'
```

7. Return: {'status': 'committed', 'commit_hash': '<hash>', 'regression_test': '<path>'}
",
  description="Apply fix for {test_file}"
)
```

Wait for Task to return.

- If `status == 'fix_failed'`: print failure output, save state without advancing `current_fix_index`, HALT with message: `nForma fix-tests: Fix application failed for {test_file}. The quorum-approved fix did not make the test pass. Manual review required.`
- If `status == 'committed'`: record in fix_log, proceed to Step 3.5.

### Step 3.5: Post-Fix Full-Suite Run + Signature Diff

After each successful commit, re-run the full suite to detect regressions:

```bash
node ~/.claude/nf/bin/nf-tools.cjs maintain-tests run-batch \
  --batch-file .planning/ddmin-manifest.json \
  --batch-index 0 \
  --timeout 3600 \
  --output-file .planning/ddmin-post-fix-run.json
```

Compute post-fix signatures using the same normalization as Step 1.4 (write and run `/tmp/compute-signatures-postfix.py`). Write to `.planning/ddmin-signatures-postfix.json`.

**Diff signatures against baseline:**

Write an inline Python script to `/tmp/diff-signatures.py` that compares `.planning/ddmin-signatures.json` (baseline) with `.planning/ddmin-signatures-postfix.json` (post-fix) and identifies:
- `resolved`: tests that were failing and are now passing → good
- `new_failures`: tests not in baseline failing set that are now failing → REGRESSION
- `signature_changed`: tests still failing but with different error hash → shifted failure, investigate

```bash
python3 /tmp/diff-signatures.py
```

**If `new_failures` is non-empty:**

Print: `nForma fix-tests: REGRESSION DETECTED — {N} new failures after fix of {test_file}`

Set `state.regression_detected = true`.

Revert the polluting commit immediately:
```bash
git revert HEAD --no-edit
```

Print: `nForma fix-tests: Reverted fix commit. Running ddmin on regression delta...`

Run ddmin on each new failure to understand what the just-reverted fix broke. Use the orchestrator from Step 1.6 logic, scoped to only the `new_failures` tests. Save results to `.planning/ddmin-regression-results.json`.

Append a regression record to `state.fix_log`:
```json
{
  "test_file": "{test_file}",
  "fix_quorum_verdict": "APPROVED",
  "commit_hash": null,
  "status": "reverted_regression",
  "regression_tests": ["<new failure paths>"],
  "regression_ddmin_path": ".planning/ddmin-regression-results.json",
  "timestamp": "<ISO>"
}
```

Save state WITHOUT advancing `current_fix_index`.

Print: `nForma fix-tests: Fix reverted. Regression ddmin saved to .planning/ddmin-regression-results.json. Re-run after reviewing.`

HALT.

**If `new_failures` is empty:**

Update `state.fix_log` with the committed fix record:
```json
{
  "test_file": "{test_file}",
  "fix_type": "{fix_type}",
  "fix_description": "{fix_description}",
  "fix_quorum_verdict": "APPROVED",
  "commit_hash": "{commit_hash}",
  "regression_test_added": true,
  "regression_test_path": "{regression_test}",
  "resolved_count": "{len(resolved)}",
  "signature_changed_count": "{len(signature_changed)}",
  "timestamp": "<ISO>"
}
```

Increment `current_fix_index` by 1.

If `signature_changed` is non-empty: print a warning but continue. `nForma fix-tests: Warning — {N} tests changed failure signature. Not blocking; recording in fix_log.`

**Advance baseline signatures:** Update `.planning/ddmin-signatures.json` to use post-fix signatures as the new baseline for the next comparison. (The post-fix state IS the new baseline.)

Save state.

Print: `nForma fix-tests: Fix committed [{test_file}]. {resolved_count} tests resolved. Next: [{current_fix_index + 1}/{len(fix_order)}]`

### Step 3.6: Loop or Advance to Phase 4

If `current_fix_index < len(fix_order)`: go back to Step 3.2 with the next test.

If `current_fix_index == len(fix_order)`: all fixes processed.

Update state: `pipeline_phase = "verification"`. Save state.

```bash
node ~/.claude/nf/bin/nf-tools.cjs activity-set \
  '{"activity":"fix_tests","sub_activity":"verification","state_file":".planning/maintain-tests-state.json"}'
```

Print: `nForma fix-tests: Phase 3 complete — {len(fix_log)} fixes applied. Advancing to Phase 4.`

---

## Phase 4: Final Verification

### Step 4.1: Final Full-Suite Run

```bash
node ~/.claude/nf/bin/nf-tools.cjs activity-set \
  '{"activity":"fix_tests","sub_activity":"final_verification","state_file":".planning/maintain-tests-state.json"}'
```

Print: `nForma fix-tests: Phase 4 — final verification run`

Run the full suite one final time with the same pinned seed:

```bash
node ~/.claude/nf/bin/nf-tools.cjs maintain-tests run-batch \
  --batch-file .planning/ddmin-manifest.json \
  --batch-index 0 \
  --timeout 3600 \
  --output-file .planning/ddmin-final-run.json
```

Compute final signatures using the normalization script pattern from Step 1.4. Write to `.planning/ddmin-signatures-final.json`.

Diff `.planning/ddmin-signatures.json` (original baseline from Phase 1) against `.planning/ddmin-signatures-final.json` (final state) to produce the complete picture:
- `resolved`: tests fixed by Phase 3
- `still_failing`: tests still failing (were in baseline, still failing in final)
- `new_failures`: tests not in baseline that are now failing (regressions not caught by Phase 3)

### Step 4.2: Generate Final Report

Write an inline Python script to `/tmp/generate-final-report.py` that reads all ddmin artifacts and state, and writes `.planning/ddmin-final-report.md`:

```markdown
# nForma fix-tests Final Report

**Run completed:** <ISO timestamp>
**Baseline seed:** {baseline_seed}
**Phase 3 fixes applied:** {len(fix_log)}
**Quarantined cycle groups:** {quarantine_count}

## Summary

| Category | Count |
|----------|-------|
| Tests resolved (now passing) | {resolved_count} |
| Tests still failing | {still_failing_count} |
| Regressions introduced (net new failures) | {new_failures_count} |
| Flaky (excluded from ddmin) | {flaky_count} |
| Cycle groups quarantined | {quarantine_count} |
| Tests unanalyzed (>100 cap) | {unanalyzed_count} |

## Resolved Tests

{list of resolved tests, one per line with fix description from fix_log}

(If none: "No tests were resolved in this run.")

## Still Failing Tests

| Test | Original Failure Type | Notes |
|------|----------------------|-------|
| {test_path} | {failure_type_from_triage} | {notes} |

(If none: "All originally failing tests were resolved.")

## Regressions

| Test | Introduced By | Notes |
|------|--------------|-------|
| {test_path} | {fix_commit or "unknown"} | {notes} |

(If none: "No regressions detected.")

## Quarantined Cycle Groups

{for each quarantined group: list the tests and the reason for quarantine}

(If none: "No cycle groups were quarantined.")

## Flaky Tests (excluded from analysis)

{flaky test list from Phase 1}

## Fix Log (Phase 3 audit trail)

{for each entry in fix_log:}
### Fix {N}: {test_file}
- **Status:** {committed|reverted_regression|quarantined}
- **Root cause:** {root_cause if available}
- **Commit:** {commit_hash or "N/A"}
- **Regression test:** {regression_test_path or "N/A"}
- **Quorum verdict:** APPROVED
```

```bash
python3 /tmp/generate-final-report.py
```

Print: `nForma fix-tests: Final report generated → .planning/ddmin-final-report.md`

### Step 4.3: Quorum Final Review

Run quorum inline — follow the canonical protocol in @core/references/quorum-dispatch.md. Mode A — artifact review:
- artifact_path: `.planning/ddmin-final-report.md`
- review_context: "Review the final test report. Evaluate: (1) applied fixes sound, (2) remaining failures diagnosed, (3) quarantined groups explained, (4) state trustworthy. Vote APPROVE if complete, NOTE if observations only, BLOCK for critical issues."
- Question: "Is the fix pipeline complete and the final report accurate? Evaluate: (1) applied fixes were sound, (2) remaining failures documented with sufficient diagnosis, (3) quarantined cycle groups explained, (4) state trustworthy. Vote APPROVE if pipeline completed correctly, NOTE (non-blocking) if observations only, BLOCK only for critical errors or unexplained regressions."
- **Exact YAML format for worker prompts** (from reference section 4):
  ```yaml
  slot: <slotName>
  round: <round_number>
  timeout_ms: <from $SLOT_TIMEOUTS or 300000>
  repo_dir: <absolute path to project root>
  mode: A
  question: "Is the fix pipeline complete and the final report accurate..."
  artifact_path: .planning/ddmin-final-report.md
  review_context: "Review the final test report for completeness..."
  prior_positions: |
    [included from Round 2 onward]
  ```
- Build `$DISPATCH_LIST` first (quorum.md Adaptive Fan-Out: read risk_level → compute FAN_OUT_COUNT → take first FAN_OUT_COUNT-1 slots from active working list). Then dispatch `$DISPATCH_LIST` as sibling `nf-quorum-slot-worker` Tasks — do NOT dispatch slots outside `$DISPATCH_LIST`
- Synthesize results inline

This quorum call is advisory — a NOTE does not halt the workflow. Only BLOCK halts.

- If `APPROVED` or `NOTE`: update state `final_quorum_verdict = "APPROVED"`, `pipeline_phase = "complete"`. Save state.
- If `BLOCKED`: update state `final_quorum_verdict = "BLOCKED"`, save state. Print block concerns. The workflow still prints the terminal summary, but marks status as BLOCKED.

Print: `nForma fix-tests: Final quorum verdict: {verdict}`

### Step 4.4: Clear Activity + Terminal Summary

```bash
node ~/.claude/nf/bin/nf-tools.cjs activity-set \
  '{"activity":"fix_tests","sub_activity":"complete","state_file":".planning/maintain-tests-state.json"}'
node ~/.claude/nf/bin/nf-tools.cjs activity-clear
```

Print the terminal summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► FIX-TESTS: ddmin Pipeline Complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Pipeline phases completed: 4/4
 Baseline seed: {baseline_seed}

 Triage quorum: {triage_quorum_verdict}
 Final quorum:  {final_quorum_verdict}

 Tests resolved:        {resolved_count}
 Tests still failing:   {still_failing_count}
 Regressions:           {new_failures_count}
 Flaky (excluded):      {flaky_count}
 Cycle groups:          {cycle_total} total ({quarantine_count} quarantined)
 Fixes applied:         {committed_count}
 Fixes reverted:        {reverted_count}

 Triage report:  .planning/ddmin-triage-report.md
 Final report:   .planning/ddmin-final-report.md
 State file:     .planning/maintain-tests-state.json
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Error Handling (all phases)

If any Bash or Python step exits with non-zero:
1. Print: `nForma fix-tests: ERROR at <step name> — <stderr first 300 chars>`
2. Run: `node ~/.claude/nf/bin/nf-tools.cjs activity-clear`
3. Surface the original error to the user.
4. Do NOT continue to the next step.

## Resume Logic

On `--resume`:
1. Load state via `maintain-tests load-state`.
2. Read `pipeline_phase` from state:
   - `ddmin_isolation` → resume from Step 1.3 (re-run baseline).
   - `triage` → skip Phase 1, jump to Step 2.1.
   - `fixing` → skip Phases 1 and 2, jump to Phase 3 (Step 3.0).
   - `verification` → skip to Phase 4.
   - `complete` → print "Already complete" and exit.

---

## INTG-03 Compliance Note

This workflow calls the quorum orchestrator at three explicit gates:
1. Phase 2.2 — Triage approval (APPROVE/BLOCK)
2. Phase 3.3 — Per-fix approval (APPROVE/BLOCK, once per test in fix_order)
3. Phase 4.3 — Final review (APPROVE/NOTE/BLOCK, advisory)

All quorum calls are via inline dispatch using `nf-quorum-slot-worker` Tasks (one per active slot per round) — NEVER the deprecated `nf-quorum-orchestrator` or direct MCP tool calls. Follow the `<dispatch_pattern>` in `commands/nf/quorum.md`. fix-tests MUST NOT be in `quorum_commands` in nf.json. The quorum gates here are inline investigation calls, not planning quorum.

---
name: nf:debug
description: Debug loop with quorum consensus on next step. Feed failure context to 4 quorum workers — each identifies the single most likely root cause and next debugging step. Renders a NEXT STEP table. Call repeatedly: run test → fail → /nf:debug → apply step → run test again.
argument-hint: "[failure context: test output, error trace, or symptom description]"
allowed-tools:
  - Task
---

<objective>
Dispatch the full quorum debug process to a subagent. The main command stays clean — only the dispatch header and the final NEXT STEP table surface to the conversation context. All bundle assembly, quorum worker dispatch, result collection, artifact writing, and execution happen inside the subagent.
</objective>

<process>

**Step 1: Show dispatch header**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► QUORUM-DEBUG: Dispatching debug subagent...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Step 2: Spawn the quorum debug subagent**

Spawn ONE Task with the full failure context and process instructions embedded:

```
Task(
  subagent_type="general-purpose",
  description="Quorum debug orchestration",
  prompt="""
You are the nForma quorum debug orchestrator. Run the full process below for this failure.

ARGUMENTS: $ARGUMENTS

---

## PROCESS

### Step A: Collect failure context

If ARGUMENTS is non-empty, use it as the initial failure description.

Discover test files:
  find . ( -name "*.test.js" -o -name "*.test.cjs" ) -not -path "*/node_modules/*" -not -path "*/.git/*"

If test files exist, run them:
  node --test $TEST_FILES 2>&1; echo "EXIT:$?"

Store as $TEST_OUTPUT and $EXIT_CODE. If exit code is 0 and ARGUMENTS is empty, stop and return:

  QUORUM-DEBUG: No failure detected — tests pass (exit 0).
  If you have a symptom not captured by tests, run: /nf:debug [describe the symptom]

### Step A.3: Repowise Context Injection

Pack Repowise intelligence context for the debug session. This injects hotspot risk data and co-change coupling, so quorum workers can see which files are structurally risky or implicitly coupled.

```bash
REPOWISE_CONTEXT=""
if command -v node >/dev/null 2>&1; then
  REPOWISE_CONTEXT=$(node ~/.claude/nf-bin/repowise/context-packer.cjs --hotspot --cochange --focus "$ARGUMENTS" --project-root="$(pwd)" 2>/dev/null || node bin/repowise/context-packer.cjs --hotspot --cochange --project-root="$(pwd)" 2>/dev/null || echo "")
fi
```

Fail-open: if the script is not found, errors, or returns empty, skip silently. `$REPOWISE_CONTEXT` stays empty and the debug session proceeds without Repowise context.

If `$REPOWISE_CONTEXT` is non-empty, include it in the $BUNDLE (Step B) under a `<repowise_context>` tag so quorum workers can factor in hotspot risk and co-change coupling.

### Step A.5: Formal Model Consultation

Run formal model consultation to check if formal models cover this failure:

```bash
node bin/debug-formal-context.cjs --description "$ARGUMENTS" --format json 2>/dev/null
```

Parse the JSON output. The output schema is:
  { "verdict": "reproduced|not-reproduced|no-model", "constraints": [...], "models": [...] }

Assign from parsed JSON:
  - $FORMAL_VERDICT = parsed.verdict (one of: "reproduced", "not-reproduced", "no-model")
  - $FORMAL_CONTEXT = the full parsed JSON object (used in Steps B, C, E, and G)

If the command fails or produces no output, set:
  - $FORMAL_VERDICT = "no-model"
  - $FORMAL_CONTEXT = { "verdict": "no-model", "constraints": [], "models": [] }
and continue (fail-open — formal context is advisory).

### Step B: Assemble bundle

Compose $BUNDLE:
  FAILURE CONTEXT: $ARGUMENTS
  EXIT CODE: $EXIT_CODE (or "N/A — symptom only" if no test run)
  FORMAL VERDICT: $FORMAL_VERDICT (or "skipped" if Step A.5 failed)
  === TEST OUTPUT ===
  $TEST_OUTPUT (or "N/A" if not a test failure)

### Step C: Dispatch 4 parallel quorum workers

Worker prompt template (inline $BUNDLE verbatim in each):

  You are a debugging advisor for the nForma project.

  <bundle>
  $BUNDLE
  </bundle>

  If $FORMAL_CONTEXT.constraints is non-empty, insert the following block here:

  [FORMAL CONSTRAINTS]
  The following constraints were extracted from formal models that cover this failure:
  - [constraint 1 text]
  - [constraint 2 text]
  - [constraint 3 text]

  These are verified properties of the system. Do NOT propose fixes that violate these constraints.
  [END FORMAL CONSTRAINTS]

  Given this failure, answer ONLY:

  root_cause: <the single most likely root cause in one sentence>
  next_step: <the single best next debugging action — be specific: what file to check, what to log, what to run>
  confidence: HIGH | MEDIUM | LOW

  Rules:
  - Do NOT suggest a fix. Suggest the next investigative step only.
  - Be specific: name the file, function, line range, or command to run.
  - If the bundle lacks enough context to diagnose, say so in root_cause and set confidence: LOW.
  - If FORMAL CONSTRAINTS are present, respect them — they represent verified properties of the system.

Dispatch all 4 workers as parallel Task calls:
- Task(subagent_type="general-purpose", prompt="Call mcp__gemini-1__gemini with: [worker prompt with $BUNDLE inlined verbatim]")
- Task(subagent_type="general-purpose", prompt="Call mcp__opencode-1__opencode with: [worker prompt with $BUNDLE inlined verbatim]")
- Task(subagent_type="general-purpose", prompt="Call mcp__copilot-1__copilot with: [worker prompt with $BUNDLE inlined verbatim]")
- Task(subagent_type="general-purpose", prompt="Call mcp__codex-1__codex with: [worker prompt with $BUNDLE inlined verbatim]")

### Step D: Collect and parse responses

Parse each worker response for root_cause:, next_step:, confidence: lines.
If a worker errored or returned unparseable output, mark as UNAVAIL.

Consensus rules:
- 3+ workers agree on same root cause area → consensus root cause
- 3+ workers recommend same next step → consensus step
- Otherwise → list all unique recommendations; note lack of consensus

### Step E: Render NEXT STEP table

Return this output:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► QUORUM-DEBUG RESULTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

┌──────────────┬──────────────┬─────────────────────────────────────────────┐
│ Model        │ Confidence   │ Next Step                                   │
├──────────────┼──────────────┼─────────────────────────────────────────────┤
│ Gemini       │ [confidence] │ [next_step]                                 │
│ OpenCode     │ [confidence] │ [next_step]                                 │
│ Copilot      │ [confidence] │ [next_step]                                 │
│ Codex        │ [confidence] │ [next_step]                                 │
├──────────────┼──────────────┼─────────────────────────────────────────────┤
│ FORMAL       │ [see below]  │ [see below]                                 │
├──────────────┼──────────────┼─────────────────────────────────────────────┤
│ CONSENSUS    │ [HIGH/MED/—] │ [consensus step or "No consensus — see above"]│
└──────────────┴──────────────┴─────────────────────────────────────────────┘

**FORMAL row rendering** (based on $FORMAL_VERDICT):
- **reproduced**: `│ FORMAL │ HIGH (model) │ Model {name} reproduced bug. Constraint: {top_constraint} │`
  where `{name}` = `$FORMAL_CONTEXT.models.find(m => m.reproduced).name` and `{top_constraint}` = `$FORMAL_CONTEXT.constraints[0].text` (or "see model output" if constraints is empty)
- **not-reproduced**: `│ FORMAL │ LOW (model) │ Models exist but none reproduced. Bug may be environmental. │`
- **no-model**: `│ FORMAL │ N/A │ No formal model covers this failure. Gap tracked in bug-model-gaps.json. │`

**Divergence note** (conditional — render only when both conditions are true):
If $FORMAL_VERDICT == "reproduced" AND `$FORMAL_CONTEXT.constraints[0].text` is NOT found as a case-insensitive substring in `$CONSENSUS_ROOT_CAUSE`, render:

  **Note:** Formal model reproduction suggests a constraint violation (`{$FORMAL_CONTEXT.constraints[0].text}`), but workers attribute the bug to a different cause. Consider: is the constraint too strict, or is the worker diagnosis incomplete?

Root Cause Hypothesis (consensus): [one-sentence summary or "No consensus"]

If models give different next steps, list them all below the table with their root cause hypotheses.

### Step F: Save artifact

Write .planning/quick/quorum-debug-latest.md:

  # quorum-debug artifact
  date: [ISO timestamp]
  failure_context: $ARGUMENTS
  exit_code: $EXIT_CODE

  ## consensus
  root_cause: [consensus root cause or "no consensus"]
  next_step: [consensus next step or "no consensus"]

  ## worker responses
  [table as text]

  ## bundle
  [full $BUNDLE]

### Step G: Execute or escalate

IF consensus was reached:
  Execute the consensus next step using available tools (Bash, Read, Grep, etc.)
  Report what was done.
  Then return:
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    Consensus step executed. Run /nf:debug again to continue.
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

IF no consensus:
  Return:
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    No consensus — review recommendations above and apply the most relevant step.
    Then run /nf:debug again with updated output.
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### Gap Persistence (formal model coverage tracking)

If $FORMAL_VERDICT is "no-model":

```bash
node << 'GAPEOF'
const fs = require('fs');
const crypto = require('crypto');
const gapPath = '.planning/formal/bug-model-gaps.json';
const description = process.env.ARGUMENTS || '';
const bundle = process.env.BUNDLE || '';
const consensusRoot = process.env.CONSENSUS_ROOT_CAUSE || 'no consensus';
const consensusStep = process.env.CONSENSUS_NEXT_STEP || 'no consensus';

let data;
try {
  data = JSON.parse(fs.readFileSync(gapPath, 'utf8'));
} catch {
  data = { version: '1.0', entries: [] };
}

// Ensure entries array exists (handle legacy or partial files)
if (!Array.isArray(data.entries)) {
  data.entries = [];
}

const bugId = crypto.createHash('sha256').update(description).digest('hex').slice(0, 8);
if (data.entries.some(e => e.bug_id === bugId)) {
  console.log('Gap already tracked: bug_id=' + bugId);
  process.exit(0);
}

data.entries.push({
  bug_id: bugId,
  description: description.slice(0, 500),
  failure_context: bundle.slice(0, 500),
  timestamp: new Date().toISOString(),
  status: 'no_coverage',
  worker_consensus_root_cause: consensusRoot,
  worker_consensus_next_step: consensusStep
});

try {
  fs.writeFileSync(gapPath, JSON.stringify(data, null, 2));
  console.log('Gap tracked: bug_id=' + bugId + ' — no formal model coverage for this failure.');
} catch (e) {
  console.error('Failed to persist gap (fail-open):', e.message);
}
GAPEOF
```
"""
)
```

**Step 3: Report result**

Return the subagent's NEXT STEP table and conclusion to the user.

</process>

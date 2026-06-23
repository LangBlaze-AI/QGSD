---
name: nf:quorum
description: Answer a question using full quorum consensus (Claude + native CLI agents + all configured claude-mcp-server instances) following nForma quorum protocol. Use when no arguments provided to answer the current conversation's open question.
argument-hint: "[question or prompt]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Task
  - Glob
  - Grep
---

<objective>
Run a question or prompt through the full nForma quorum (R3 protocol): Claude + native CLI agents (Codex, Gemini, OpenCode, Copilot) + all claude-mcp-server instances configured in `~/.claude.json`.

**Two modes** based on context:
- **Mode A — Pure Question**: No commands required. Claude forms its own position first, then dispatches all slot-workers as parallel Tasks, deliberates to consensus.
- **Mode B — Execution + Trace Review**: Running commands is necessary before a verdict is possible. Claude runs them, preserves full traces, quorum reviews traces and gives verdicts.
</objective>

<dispatch_pattern>
**Execution path:** Claude runs the full R3 protocol directly in the main conversation thread.
Dispatch slot-workers via sibling Task calls (one per slot in `$DISPATCH_LIST` per round — capped by `FAN_OUT_COUNT`).
No orchestrator intermediary — the fallback logic, round loop, and scoreboard are all inline.

Resolve the question to pass:

1. If $ARGUMENTS is non-empty → use it directly as the question/prompt.
2. If $ARGUMENTS is empty → scan the current conversation using this priority order:
   - **Priority 1** — Most recent message containing `?` without a substantive answer yet.
   - **Priority 2** — Most recent message describing a choice/trade-off (keywords: "should we", "which approach", "option A vs", "do we", "whether to").
   - **Priority 3** — Most recent open concern or blocker ("not sure", "concern", "blocker", "unclear", "wondering").
   - If none found: stop with `"No open question found. Provide one explicitly: /nf:quorum <question>"`

When question is inferred, display before dispatching:
```
Using conversation context as question (Priority N - [type]):
"[inferred question text]"
```
</dispatch_pattern>

## Consensus Enforcement Rules

These three rules govern ALL consensus determination in both Mode A and Mode B. They are non-negotiable and mechanistic — no interpretation, rationalization, or override is permitted.

**RULE CE-1: Orchestrator Is Facilitator Only**
- Claude's position (`$CLAUDE_POSITION`) is ADVISORY context provided to external voters to help them form informed positions.
- Claude's position MUST NOT be counted as a vote in any consensus tally.
- The consensus tally counts ONLY external slot-worker votes (from `$DISPATCH_LIST`).
- When displaying the positions table, Claude's row MUST be labeled `Claude (ADVISORY — not a vote)`.

**RULE CE-2: BLOCK Is Absolute**
- A BLOCK (or REJECT in Mode B) vote from ANY single valid (non-UNAVAIL) external voter prevents consensus from being reached.
- The orchestrator MUST NOT override, rationalize away, dismiss, or reinterpret a BLOCK vote. The BLOCK stands as-is.
- When a BLOCK occurs: the system MUST enter deliberation (provide the BLOCK rationale to all voters for the next round) or escalate after max rounds.
- Prohibited phrases in orchestrator reasoning: "despite the BLOCK", "overriding the BLOCK because", "the BLOCK analysis was inaccurate", "majority overrides the BLOCK".

**RULE CE-3: Unanimity Required**
- Consensus means 100% of valid (non-UNAVAIL) external voters agree on the same verdict.
- There is NO majority-based approval. 2-out-of-3 APPROVE with 1 BLOCK is NOT consensus — it is a disagreement requiring deliberation.
- UNAVAIL voters are excluded from the denominator (they are not valid voters for this round).
- If only 1 external voter is valid and they APPROVE, that is consensus (1/1 = 100%) — provided `min_live_voters` is satisfied (see CE-4).

**RULE CE-4: Minimum Live Voters Floor**
- After tier fallback, if the number of live (non-UNAVAIL) external voters is below `min_live_voters` (default: 2), consensus MUST NOT be declared — even if all remaining voters agree.
- `min_live_voters` is read from `quorum.min_live_voters` in config (default: 2). The floor prevents thin consensus where a single surviving voter satisfies unanimity after mass UNAVAIL.
- The orchestrator must either:
  1. Re-dispatch with extended timeouts to recover UNAVAIL slots, OR
  2. Surface the degraded-roster state to the user for an explicit waiver via `--force-quorum`
- Below-floor consensus is BLOCKED by `nf-stop.js` with a clear error — it does not silently pass.

---

<mode_detection>
**Default: Mode A.**

Switch to **Mode B** only if the question/prompt explicitly requires running commands before answering — e.g.:
- "should we approve this plan", "does this pass", "is this safe to execute"
- "run [command] and tell me if...", "verify that [thing] works"
- "review the output of...", "check if the tests pass and then..."

If $ARGUMENTS is empty: use the most recent open question or decision from the current conversation context as the question.
</mode_detection>

---

> **Worker Task dispatch is PARALLEL per round.** Dispatch all slot workers for a given round as sibling Task calls in one message turn. Between rounds (Bash scoreboard calls, set-availability) remain sequential.

---

### Provider pre-flight (run once before team capture)

Before any model calls, run a fast HTTP probe of the underlying LLM providers:

```bash
node "$HOME/.claude/nf-bin/check-provider-health.cjs" --json
```

Parse the JSON output. Build two structures:

1. **`$PROVIDER_STATUS`**: `{ providerName: healthy }` — map of provider name to up/down status.

2. **`$CLAUDE_MCP_SERVERS`**: flat list of `{ serverName, model, providerName, available }` — extracted from the `servers[]` and `models[]` arrays in each provider entry. A server's `available` is `false` if its provider's `healthy` is `false`.

Any server with `available: false` must be marked UNAVAIL immediately — skip its health_check and inference calls entirely. This prevents hangs from unresponsive provider endpoints.

3. **`$QUORUM_ACTIVE`**: read from `~/.claude/nf.json` (project config takes precedence over global):
```bash
node "$HOME/.claude/nf-bin/quorum-preflight.cjs" --quorum-active
```
If `$QUORUM_ACTIVE` is empty (`[]`), all entries in `$CLAUDE_MCP_SERVERS` participate.
If non-empty, intersect: only servers whose `serverName` appears in `$QUORUM_ACTIVE` are called.
A server in `$QUORUM_ACTIVE` but absent from `$CLAUDE_MCP_SERVERS` = skip silently (fail-open).

**Pre-flight slot skip:** After building `$CLAUDE_MCP_SERVERS`, immediately filter the list for the quorum run:
- For each server with `available: false`, log: `Pre-flight skip: <serverName> (<providerName> DOWN)`
- Remove these servers from the working list for all subsequent steps (team capture, Round 1, deliberation).
- Reorder the remaining working list: healthy servers first (preserving discovery order within each group).
- Log the final working list as: `Active slots: <slot1>, <slot2>, ...`

**max_quorum_size check:** Read `max_quorum_size` from `~/.claude/nf.json` (project config takes precedence; default: 3 if absent):
```bash
node "$HOME/.claude/nf-bin/quorum-preflight.cjs" --max-quorum-size
```
Count available slots (those not marked UNAVAIL and passing $QUORUM_ACTIVE filter). Claude is the facilitator and does NOT count toward max_quorum_size. Count only external slots.
If `availableCount < max_quorum_size`:
  - If $ARGUMENTS contains `--force-quorum`: log warning `[WARN] Quorum below max_quorum_size (N available, min M) — proceeding due to --force-quorum` and continue.
  - Otherwise: stop with:
    ```
    QUORUM BLOCKED: Only N model(s) available (max_quorum_size = M).
    Available: [list slots]
    UNAVAIL:   [list skipped slots with reason]
    Re-run with --force-quorum to override, or wait for providers to recover.
    ```

Display pre-flight result inline (one line):
```
Provider pre-flight: <providerName>=✓/✗ ...  (<N> claude-mcp servers found)
```

---

### Team identity capture (idempotent — run once per session)

Before any quorum round, capture the active team fingerprint. Build TEAM_JSON directly from `providers.json` — no MCP calls needed for identity.

```bash
node "$HOME/.claude/nf-bin/quorum-preflight.cjs" --team
```

Store result as `TEAM_JSON`. Also build three lookup maps from `providers.json` for use during dispatch:
- `$SLOT_TIMEOUTS: { slotName: quorum_timeout_ms }` (fallback: 300000)
- `$SLOT_MODELS: { slotName: model }` (fallback: `"unknown"`)
- `$SLOT_CLI: { slotName: display_type }` (fallback: `"cli"`)

Use `$SLOT_CLI[slotName]` and `$SLOT_MODELS[slotName]` in Task `description=` fields so the parallel UI shows both the CLI binary and LLM being called (e.g., `"gemini-1 [gemini-cli · gemini-3-pro-preview] quorum R1"`).

Detect Claude's model ID from: `CLAUDE_MODEL` env var → `ANTHROPIC_MODEL` env var → current session model name from system context.

Run:
```bash
node "$HOME/.claude/nf-bin/update-scoreboard.cjs" init-team \
  --claude-model "<claude_model_id>" \
  --team '<TEAM_JSON>'
```

The command prints `[init-team] fingerprint: <fp> | no change` if unchanged, or `[init-team] fingerprint: <fp> (updated from <old>) | N agents` if updated. Then proceed to Envelope Risk Level read and Mode A or Mode B.

### Envelope Risk Level (ENV-03 — fail-open)

Read risk_level from task envelope if available. Falls back gracefully if absent or malformed.

```bash
# Parse envelope_path from context (passed by plan-phase.md)
ENVELOPE_PATH=$(echo "${CONTEXT_YAML:-}" | grep '^envelope_path:' | sed 's/envelope_path:[[:space:]]*//')

if [ -n "$ENVELOPE_PATH" ] && [ -f "$ENVELOPE_PATH" ]; then
  RISK_LEVEL=$(ENVELOPE_PATH="$ENVELOPE_PATH" node -e "
    try {
      const e = JSON.parse(require('fs').readFileSync(process.env.ENVELOPE_PATH, 'utf8'));
      const valid = ['low','medium','high'];
      const r = e.risk_level;
      if (valid.includes(r)) { console.log(r); } else { process.stderr.write('[quorum] envelope risk_level=' + r + ' (invalid) → using medium\n'); console.log('medium'); }
    } catch(err) {
      process.stderr.write('[quorum] envelope parse error → using medium\n');
      console.log('medium');
    }
  " 2>&1)
  echo "Envelope risk_level: ${RISK_LEVEL}"
else
  RISK_LEVEL="medium"
  if [ -n "$ENVELOPE_PATH" ]; then
    echo "Envelope not found at ${ENVELOPE_PATH} — using default risk (medium)"
  else
    echo "No envelope_path provided — using default risk (medium)"
  fi
fi
```

### Adaptive Fan-Out Dispatch Count (FAN-01..FAN-04)

After reading RISK_LEVEL, compute the fan-out dispatch count:

```bash
# Map RISK_LEVEL to fan_out_count (total participants = Claude + external slots)
if [ "$RISK_LEVEL" = "routine" ] || [ "$RISK_LEVEL" = "low" ]; then
  FAN_OUT_COUNT=2
elif [ "$RISK_LEVEL" = "medium" ]; then
  FAN_OUT_COUNT=3
else
  # high, absent, or invalid → fail-open to max_quorum_size
  FAN_OUT_COUNT="$MAX_QUORUM_SIZE"
fi

echo "Adaptive fan-out: risk_level=${RISK_LEVEL} → fan_out_count=${FAN_OUT_COUNT} (of max ${MAX_QUORUM_SIZE})"
```

**Apply cap — build DISPATCH_LIST:** Take the first `FAN_OUT_COUNT - 1` slots from the active working list (healthy-first order from pre-flight). This is the definitive slot cap. Call this `$DISPATCH_LIST`. All subsequent round dispatches (Round 1 and deliberation) use `$DISPATCH_LIST` — never the full working list.

> **Why here and not only in the hook:** `nf-prompt.js` enforces this cap via `--n` for main-session prompts. But quorum is also dispatched inline from subagents (e.g., `nf-planner` in step 8.5 of `plan-phase.md`) where no UserPromptSubmit hook fires. `quorum.md` must self-enforce the cap for all dispatch contexts.

### R6.4 Reduced-Quorum Note (FAN-05)

When fan-out is below `max_quorum_size`, emit a reduced-quorum note per R6.4 so the user understands why fewer models are participating. This is an informational note — it does not block execution.

```bash
if [ "$FAN_OUT_COUNT" -lt "$MAX_QUORUM_SIZE" ] 2>/dev/null; then
  EXTERNAL_COUNT=$((FAN_OUT_COUNT - 1))
  echo "[R6.4 reduced-quorum note] Operating with ${FAN_OUT_COUNT} total participants (Claude + ${EXTERNAL_COUNT} external); max_quorum_size is ${MAX_QUORUM_SIZE}. Reason: envelope risk_level=${RISK_LEVEL}. This is intentional — routine/medium tasks use fewer models to reduce token cost (FAN-01, FAN-02)."
fi
# When FAN_OUT_COUNT = MAX_QUORUM_SIZE (high/absent): no note emitted.
```

The RISK_LEVEL variable is available downstream for use by Phase v0.18-04 Adaptive Fan-Out. The fan-out logic is now implemented in both quorum.md (above) and nf-prompt.js (which emits `--n N` for downstream ceiling verification).

### Preflight Slot Assignment Display (FAN-06)

After computing `$DISPATCH_LIST` and before first dispatch, emit the QUORUM SLOT ASSIGNMENT display to show the user which slots are primary and which are fallback:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► QUORUM SLOT ASSIGNMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Primary slots (${FAN_OUT_COUNT - 1}):
   ${DISPATCH_LIST entries with model names}

 Fallback order:
   T1 (flat-rate CLI): ${T1_UNUSED slots, or "none"}
   T2 (pay-per-use API): ${T2_FALLBACK slots, or "none"}

 Total available: ${available_slots count}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

This display allows users to diagnose slot assignment and understand the fallback chain before execution begins. Emit this once per quorum run, after preflight completes and before Round 1 dispatch.

---

## Mode A — Pure Question

### Parse question

If $ARGUMENTS is empty, scan the current conversation using this priority order:

Priority 1 - Explicit question: Find the most recent message containing a literal "?" that has not yet received a substantive answer. Use that as the question.

Priority 2 - Pending decision: Find the most recent message that describes a choice or trade-off between options (keywords: "should we", "which approach", "option A vs", "do we", "whether to"). Use that as the question.

Priority 3 - Open concern or blocker: Find the most recent message that raises a concern, flags a risk, or states something is unclear (keywords: "not sure", "concern", "blocker", "question:", "unclear", "wondering"). Restate it as a question.

If none of the above applies: stop with:
"No open question found. Looked for: explicit '?' question, pending decision, or open concern in recent conversation. Provide a question explicitly: /nf:quorum <question>"

When a question is inferred via any priority, Claude MUST display before proceeding:
"Using conversation context as question (Priority N - [type]):
"[inferred question text]""

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► QUORUM: Round 1 — N workers dispatched
 Active: gemini-1, opencode-1, copilot-1, codex-1
 Fallback pool: T1 = unused slots with auth_type=sub; T2 = slots with auth_type≠sub (on UNAVAIL)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Question: [question]
```
(The Active line lists the actual active slots resolved at runtime, not hardcoded names. The example above is illustrative — the executor renders it dynamically using the resolved slot list from provider pre-flight.)

### Claude's advisory position (Round 1)

Before querying any model, state Claude's own analysis and reasoning:
```
Claude (ADVISORY — Round 1): [analysis + reasoning — 2–4 sentences]
```

Store as `$CLAUDE_POSITION`.

This position is ADVISORY per CE-1. It is shared with external voters as context but is NOT counted in the consensus tally.

### Query models (parallel — one Task per slot)

Dispatch one `Task(subagent_type="nf-quorum-slot-worker", model="haiku", ...)` per slot in **`$DISPATCH_LIST`** (capped to `FAN_OUT_COUNT - 1` external slots) as **parallel sibling calls** in one message turn. Do NOT dispatch slots outside `$DISPATCH_LIST`.

**Pre-built command dispatch (Option C):** The orchestrator builds the complete bash command. The slot-worker just runs it — zero interpretation needed. The Node script writes the result file directly via `--output-file`, making Haiku's relay behavior irrelevant.

Build the command per slot:
```
node "$HOME/.claude/nf-bin/quorum-slot-dispatch.cjs" \
  --slot <slotName> \
  --mode A \
  --round <round_number> \
  --question "<question text — shell-escape single quotes>" \
  --cwd <absolute path to working directory> \
  --timeout <slot_timeout from $SLOT_TIMEOUTS> \
  --output-file "<repo_dir>/.planning/quorum/slot-results/<slotName>-round-<round_number>.txt" \
  [--artifact-path "<path to artifact file>"] \
  [--review-context "<one-sentence framing>"] \
  [--request-improvements]
```

`--review-context` is optional but strongly recommended when `--artifact-path` is present.
Set it to the evaluation criteria appropriate for the artifact type, e.g.:
- Plan:     "This is a pre-execution plan. Evaluate approach and completeness — not whether code already exists."
- Roadmap:  "This is a strategic roadmap. Evaluate phase sequencing and requirements coverage."
- Test run: "These are post-execution test results. Evaluate whether tests genuinely pass and assertions are meaningful."
- Audit:    "This is a milestone audit. Evaluate whether the work achieves the stated milestone goals."

Example dispatch (all Tasks in one message turn):
- `Task(subagent_type="nf-quorum-slot-worker", model="haiku", description="gemini-1 [gemini-cli · gemini-3-pro-preview] quorum R1", prompt='node "$HOME/.claude/nf-bin/quorum-slot-dispatch.cjs" --slot gemini-1 --mode A --round 1 --question "..." --cwd /path/to/repo --timeout 300000 --output-file "/path/to/repo/.planning/quorum/slot-results/gemini-1-round-1.txt"')`
- `Task(subagent_type="nf-quorum-slot-worker", model="haiku", description="codex-1 [codex-cli · gpt-5.3-codex] quorum R1", prompt='...')`
- `Task(subagent_type="nf-quorum-slot-worker", model="haiku", description="claude-1 [claude-code-router · deepseek-ai/DeepSeek-V3.2] quorum R1", prompt='...')` ← one per claude-mcp server with `available: true`

(model="haiku" — slot-workers just run one Bash command. The actual reasoning is done by the external CLI via quorum-slot-dispatch.cjs. Haiku is fastest for this relay role.)

**Reading results (file-first, Option C):** After all Tasks in a round complete, read each result from its file:
1. Read `.planning/quorum/slot-results/<slotName>-round-<round_number>.txt`
2. If the file exists and has content → use it as the authoritative result (parse `verdict:`, `reasoning:`, `dispatch_nonce:`, `citations:`, `improvements:`)
3. If the file is empty or missing → check the Task's returned output as fallback
4. If both are empty → mark slot as UNAVAIL for this round

**Nonce authenticity check:** Genuine results contain a `dispatch_nonce:` field — a 32-character hex string generated by quorum-slot-dispatch.cjs. The nonce MUST come from the result **file** (written by Node directly), NOT from the Task's returned output. Haiku can fabricate nonce-like strings in its output, but it cannot write to `--output-file` — only the Node script does that. If the file is missing or has no `dispatch_nonce:`, treat the slot as UNAVAIL regardless of what the Task output says.

**Clean up before each round:** Delete old result files and any stale checkpoint for the round before dispatching: `rm -f .planning/quorum/slot-results/*-round-<N>.txt .planning/quorum/checkpoints/round-<N>.json`

Handle UNAVAILABLE per R6: note unavailability, then apply the **tiered fallback rule** below before continuing.

#### Tiered fallback rule (FALLBACK-01)

When one or more dispatched slots return UNAVAIL, collect ALL UNAVAIL results first (wait for all parallel Tasks to complete), then dispatch ALL needed fallback replacements together as **parallel sibling Tasks in ONE message turn**.

Classification is based on runtime `auth_type` from `providers.json` / config — **not** hardcoded slot names. Any slot can be `sub` or `api` depending on how it is configured.

1. **T1 — unused sub-CLI slots**: slots in the working list where `auth_type=sub` AND not in `$DISPATCH_LIST`. Build `$T1_UNUSED` = `[working-list slots with auth_type=sub] − $DISPATCH_LIST`. Dispatch `$T1_UNUSED` first — same subscription tier as the primaries, no extra cost.
2. **T2 — final fallback slots**: slots in the working list where `auth_type≠sub` AND not in `$DISPATCH_LIST`. Dispatch T2 only if `$T1_UNUSED` is empty or fully exhausted/UNAVAIL. Slots already dispatched as primary are excluded from both T1 and T2.

**Deduplication rule:** Each fallback slot is dispatched AT MOST ONCE per round, regardless of how many primaries returned UNAVAIL. If two primaries both return UNAVAIL and `$T1_UNUSED = [opencode-1, copilot-1]`, dispatch both `opencode-1` AND `copilot-1` as **parallel sibling Tasks in one message turn** — not one per UNAVAIL primary. Never dispatch the same slot twice in one round.

**Parallel dispatch requirement:** All T1 fallback Tasks (and separately, all T2 fallback Tasks if T1 is exhausted) MUST be dispatched as parallel sibling Task calls in ONE message turn — the same way primary slots are dispatched. Do NOT dispatch fallbacks sequentially (one per message turn). This is required to avoid multiplying fallback latency.

**Why this matters:** With `FAN_OUT_COUNT=3`, only 2 external slots are in `$DISPATCH_LIST`. If both primaries are UNAVAIL, any remaining `auth_type=sub` slots should be tried before falling to `auth_type=api` (ccr) slots. The exact slot names in each tier depend on `--n` and the runtime config — they are not fixed.

**Display label:** Use `(T1 fallback)` for `auth_type=sub` replacements, `(T2 fallback)` for `auth_type≠sub` replacements.

#### FALLBACK-01 checkpoint (mandatory before consensus evaluation)

**STOP.** Before evaluating consensus, you MUST complete this checkpoint if ANY primary slot returned UNAVAIL. This is structurally enforced by the Stop hook — skipping it will cause a BLOCK.

Run `quorum-checkpoint.cjs` to write a **structured JSON checkpoint file** to `.planning/quorum/checkpoints/round-<N>.json`. The script schema-validates the values, writes the file, and prints a human-readable `<!-- FALLBACK_CHECKPOINT -->` block to stdout for the transcript. The Stop hook reads and validates that file — it does NOT parse the HTML comment, so formatting variation cannot bypass or trigger the gate.

```bash
node "$HOME/.claude/nf-bin/quorum-checkpoint.cjs" \
  --round <round_number> \
  --cwd <absolute path to working directory> \
  --unavail-primaries "<comma-separated primaries that returned UNAVAIL, or none>" \
  --fallback-dispatched <true|false> \
  --t1-slots "<comma-separated T1 slots dispatched, or none>" \
  --t2-slots "<comma-separated T2 slots dispatched, or none>" \
  --all-tiers-exhausted <true|false> \
  --proceed-reason "<why it is now safe to evaluate consensus>"
```

The `--round` value MUST match the `--round` passed to the slot-worker Tasks for this round — the Stop hook keys the checkpoint to that round number.

**Rules:**
- If primaries returned UNAVAIL AND `--fallback-dispatched false`, you MUST go back and dispatch fallback Tasks before continuing. Do NOT proceed to consensus. (The script will warn; the Stop hook will BLOCK.)
- `--all-tiers-exhausted true` is only valid if every slot in T1 AND T2 was either dispatched and returned UNAVAIL, or the pool was empty.
- If a T1 fallback succeeded (returned APPROVE/BLOCK), pass `--all-tiers-exhausted false --fallback-dispatched true` — `proceed-reason` is valid because you have a replacement vote.
- The Stop hook clears the gate only when the checkpoint file for the round exists, passes schema validation, and has `fallback_dispatched: true` OR `all_tiers_exhausted: true`. A malformed or missing checkpoint = BLOCK.

### Evaluate Round 1 — check for consensus

Display all positions as a table with one row per team member (native agents first, then claude-mcp servers in discovery order):

```
┌────────────────────────────────┬──────────────────────────────────────────────────────────┐
│ Model                          │ Round N Position                                         │
├────────────────────────────────┼──────────────────────────────────────────────────────────┤
│ Claude                         │ [summary — $CLAUDE_POSITION]                             │
│ <slot-A> (primary)             │ [summary or UNAVAIL]                                      │
│   ├─ <T1-next> (T1 fallback)  │ [summary or UNAVAIL — next unused auth_type=sub slot]     │
│   └─ <T2-next> (T2 fallback)  │ [summary or UNAVAIL — first auth_type≠sub slot, T1 done]  │
│ <slot-B> (primary)             │ [summary or UNAVAIL]                                      │
│   ├─ <T1-next> (T1 fallback)  │ [summary or UNAVAIL — only if slot-B UNAVAIL + T1 unused] │
│   └─ <T2-next> (T2 fallback)  │ [summary or UNAVAIL — only if all T1 also UNAVAIL]        │
│ <slot-C> (primary)             │ [summary or UNAVAIL — only shown if in $DISPATCH_LIST]    │
└────────────────────────────────┴───────────────────────────────────────────────────────────┘
```

Actual slot names in each tier are resolved at runtime from `providers.json` based on `auth_type`. T1 = `auth_type=sub` slots not in `$DISPATCH_LIST`; T2 = `auth_type≠sub` slots. With `--n 5` all sub-CLI slots may be primary, leaving T1 empty. Fallback rows (├─ / └─) are only rendered when the corresponding primary returned UNAVAIL and a fallback was dispatched. A T1 row is omitted if that slot was already dispatched as a primary.

**Important: fallback slots appear at most once in this table.** If multiple primaries return UNAVAIL and share the same T1 replacement pool, each T1 slot appears in the table only once (under the first UNAVAIL primary that needed it). The table is for display only — the actual dispatch is `$T1_UNUSED` dispatched all at once in parallel, not one per UNAVAIL primary row.

If all valid (non-UNAVAIL) external voters agree (CE-3 unanimity) → skip to **Consensus output**. Claude's advisory position is NOT counted in this check (CE-1). If ANY external voter voted BLOCK, consensus is NOT reached regardless of other votes (CE-2).

### Deliberation rounds (R3.3)

Run up to 9 deliberation rounds (max 10 total rounds including Round 1).

For each round, dispatch one `Task(subagent_type="nf-quorum-slot-worker", model="haiku", ...)` per slot in **`$DISPATCH_LIST`** as **parallel sibling calls**. For Round 2+, write a prior-positions file and pass it via `--prior-positions-file`:

1. Write prior positions to `.planning/quorum/slot-results/prior-positions-round-<N>.txt`:
```
• Claude:
  position: [position from $CLAUDE_POSITION]
  citations: [citations from Claude's analysis, or "(none)"]
• <slotName>:
  position: [position from slot result block, or UNAVAIL]
  citations: [citations field from slot result block, or "(none)"]
[one entry per active slot in the same format]
```

2. Build the command with `--prior-positions-file` added:
```
node "$HOME/.claude/nf-bin/quorum-slot-dispatch.cjs" \
  --slot <slotName> --mode A --round <N> \
  --question "<question>" --cwd <repo_dir> --timeout <ms> \
  --output-file "<repo_dir>/.planning/quorum/slot-results/<slotName>-round-<N>.txt" \
  --prior-positions-file "<repo_dir>/.planning/quorum/slot-results/prior-positions-round-<N>.txt" \
  [--artifact-path "..."] [--review-context "..."] [--request-improvements]
```

Always carry `--artifact-path` and `--review-context` through to deliberation rounds unchanged.

Populate `citations:` from the `citations:` field in each model's result file. If the result had no `citations:` field or it was empty, write `(none)`. For Claude's own position, include any file paths or line numbers Claude cited in its reasoning.

Workers are dispatched as **parallel sibling Tasks** per round. Between rounds (Bash scoreboard calls, set-availability) remain sequential.

Stop deliberation **immediately** upon CONSENSUS (all valid external voters agree per CE-3). Claude's advisory position is NOT counted in this check. A single BLOCK from any external voter means consensus has NOT been reached (CE-2) — continue deliberation.

After 10 total rounds with no consensus → **Escalate**.

### Consensus output

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► QUORUM CONSENSUS REACHED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Question: [question]
Rounds to consensus: [N]

CONSENSUS ANSWER:
[Full consensus answer — detailed and actionable]

Supporting positions:
• Claude (ADVISORY):  [brief]
• Codex:     [brief or UNAVAIL]
• Gemini:    [brief or UNAVAIL]
• OpenCode:  [brief or UNAVAIL]
• Copilot:   [brief or UNAVAIL]
[one line per claude-mcp server: • <display-name>: [brief or UNAVAIL]]

External voter tally: {N} APPROVE / {N} BLOCK / {N} UNAVAIL (Claude's position excluded per CE-1)
```

Update the scoreboard: for each model that voted this round, run:

```bash
# For native agents:
node "$HOME/.claude/nf-bin/update-scoreboard.cjs" \
  --model <model_name> \
  --result <vote_code> \
  --task "<task_label>" \
  --round <round_number> \
  --verdict <VERDICT> \
  --task-description "<question or topic being debated>"

# For each claude-mcp server (use slot + full model-id, NOT --model):
node "$HOME/.claude/nf-bin/update-scoreboard.cjs" \
  --slot <slotName> \
  --model-id <fullModelId> \
  --result <vote_code> \
  --task "<task_label>" \
  --round <round_number> \
  --verdict <VERDICT> \
  --task-description "<question or topic being debated>"
```

- `--model` for native agents: `claude`, `gemini`, `opencode`, `copilot`, `codex`
- For claude-mcp servers: use `--slot <slotName>` (e.g. `claude-1`) and `--model-id <fullModelId>` (e.g. `deepseek-ai/DeepSeek-V3` — the exact string returned by health_check, NOT a derived short key). This writes to `data.slots{}` with composite key `<slot>:<model-id>`.
- `--result` values: TP, TN, FP, FN, TP+ (improvement accepted), or leave as empty string if model did not participate. Skip calling update-scoreboard entirely for models that were UNAVAIL.
- `--task` label: short identifier, e.g. "quick-25" or "plan-ph17"
- `--round`: the round number that just completed
- `--verdict`: the consensus verdict (APPROVE | BLOCK | DELIBERATE | CONSENSUS | GAPS_FOUND)
- `--task-description`: the full debate question/topic (the `[question]` value). Used by Haiku to auto-classify the category. Omit if the question is too long (>500 chars) — use a shortened summary instead.

Run one command per model per round. Each call is atomic and idempotent — if re-run for the same task+round+model it overwrites that model's vote and recalculates from scratch.

**Post-consensus improvements extraction (Mode A, when `request_improvements: true`):**

1. Collect `improvements:` fields from worker result blocks of the **final consensus round** (the last round where all available models agreed — NOT aggregated across all rounds). Filter to blocks where `verdict` is not UNAVAIL and `improvements:` is present and non-empty.

2. De-duplicate: if multiple models propose the same improvement (same suggestion text or semantically equivalent), keep only the first occurrence.

3. If any improvements collected, display:
   ```
   Improvements proposed:
   • <slotName>: [suggestion]  —  [rationale]
   • <slotName>: [suggestion]  —  [rationale]
   ```

4. Emit structured signal (parseable by calling workflow):
   ```
   <!-- QUORUM_IMPROVEMENTS_START
   [{"model":"<slotName>","suggestion":"...","rationale":"..."},...]
   QUORUM_IMPROVEMENTS_END -->
   ```

5. If no improvements collected: emit `<!-- QUORUM_IMPROVEMENTS_START [] QUORUM_IMPROVEMENTS_END -->`

6. If `request_improvements` was not set (false or absent): do NOT emit the signal block.

**Debate file path:** If `artifact_path` was provided → write to the same directory as the artifact (e.g. `.planning/phases/v0.14-02/QUORUM_DEBATE.md`). Otherwise → `.planning/quorum/debates/YYYY-MM-DD-<short-slug>.md` where `<short-slug>` is the first 6 words of the question lowercased, spaces replaced with hyphens, non-alphanumeric chars stripped.

Create `.planning/quorum/debates/` if it does not exist.

Write QUORUM_DEBATE.md using the debate file path rule above. Set `Consensus: APPROVE` (Mode A consensus means all models agree on APPROVE). Include one `## Round N` section per round that occurred, populated from the per-round position data collected during this quorum run.

The debate file format:
```markdown
# Quorum Debate
Question: <question text>
Date: <YYYY-MM-DD>
Consensus: <APPROVE / REJECT / FLAG / ESCALATED>
Rounds: <N>

## Round 1
| Model | Position | Citations |
|---|---|---|
| Claude | <position> | <citations or —> |
| <slotName> | <position or UNAVAIL> | <citations or —> |
...

## Round N (if deliberation occurred — one section per round)
[same table format]

## Outcome
<Full consensus answer (Mode A) or verdict + rationale (Mode B) or escalation summary>

## Improvements
| Model | Suggestion | Rationale |
|---|---|---|
| <slotName> | ... | ... |
```

Only write the `## Improvements` section when `request_improvements: true` AND improvements were proposed. Omit entirely when no improvements or when `request_improvements` is not set.

### Escalate — no consensus after 10 rounds

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► QUORUM ESCALATING — NO CONSENSUS AFTER 10 ROUNDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Question: [question]

Final positions:
• Claude:    [position + key reasoning]
• Codex:     [position + key reasoning or UNAVAIL]
• Gemini:    [position + key reasoning or UNAVAIL]
• OpenCode:  [position + key reasoning or UNAVAIL]
• Copilot:   [position + key reasoning or UNAVAIL]
[one line per claude-mcp server: • <display-name>: [position + key reasoning or UNAVAIL]]

Core disagreement: [1–2 sentences on what models disagree about]

Claude's recommendation: [Claude's position with rationale]
```

Update the scoreboard: for each model that voted this round, run:

```bash
# For native agents:
node "$HOME/.claude/nf-bin/update-scoreboard.cjs" \
  --model <model_name> \
  --result <vote_code> \
  --task "<task_label>" \
  --round <round_number> \
  --verdict <VERDICT> \
  --task-description "<question or topic being debated>"

# For each claude-mcp server (use slot + full model-id, NOT --model):
node "$HOME/.claude/nf-bin/update-scoreboard.cjs" \
  --slot <slotName> \
  --model-id <fullModelId> \
  --result <vote_code> \
  --task "<task_label>" \
  --round <round_number> \
  --verdict <VERDICT> \
  --task-description "<question or topic being debated>"
```

- `--model` for native agents: `claude`, `gemini`, `opencode`, `copilot`, `codex`
- For claude-mcp servers: use `--slot <slotName>` (e.g. `claude-1`) and `--model-id <fullModelId>` (e.g. `deepseek-ai/DeepSeek-V3` — the exact string returned by health_check, NOT a derived short key). This writes to `data.slots{}` with composite key `<slot>:<model-id>`.
- `--result` values: TP, TN, FP, FN, TP+ (improvement accepted), or leave as empty string if model did not participate. Skip calling update-scoreboard entirely for models that were UNAVAIL.
- `--round`: the round number that just completed
- `--verdict`: the consensus verdict (APPROVE | BLOCK | DELIBERATE | CONSENSUS | GAPS_FOUND)

Run one command per model per round. Each call is atomic and idempotent.

Write QUORUM_DEBATE.md using the debate file path rule above. Set `Consensus: ESCALATED`. Include one `## Round N` section per round (all 10). Set `## Outcome` to the core disagreement summary and Claude's recommendation from the escalation output above.

---

## Mode B — Execution + Trace Review

### Parse commands

Extract command(s) to run from $ARGUMENTS. If unclear, ask the user to specify.

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► QUORUM: Mode B — Execution + Trace Review
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Question: [original question]
Commands: [list]

Running commands...
```

### Execute and capture traces

Run each command, capturing full stdout + stderr + exit code.

Store as `$TRACES`:
```
=== Command: [cmd] ===
Exit code: N
Output:
[full output — not summarized]
```

Claude also gives its own verdict before dispatching workers.

### Assemble review bundle

```
QUESTION: [original question]

=== EXECUTION TRACES ===
$TRACES
```

### Dispatch quorum workers via Task (parallel per round)

Dispatch one `Task(subagent_type="nf-quorum-slot-worker", model="haiku", ...)` per slot in **`$DISPATCH_LIST`** (capped to `FAN_OUT_COUNT - 1` external slots) as **parallel sibling calls** in one message turn. Do NOT dispatch slots outside `$DISPATCH_LIST`.

For Mode B, write the traces to a temp file first, then pass via `--traces-file`:

1. Write `$TRACES` to `.planning/quorum/slot-results/traces-round-<N>.txt`
2. Build the command per slot:
```
node "$HOME/.claude/nf-bin/quorum-slot-dispatch.cjs" \
  --slot <slotName> --mode B --round <N> \
  --question "<question>" --cwd <repo_dir> --timeout <ms> \
  --output-file "<repo_dir>/.planning/quorum/slot-results/<slotName>-round-<N>.txt" \
  --traces-file "<repo_dir>/.planning/quorum/slot-results/traces-round-<N>.txt" \
  [--prior-positions-file "<repo_dir>/.planning/quorum/slot-results/prior-positions-round-<N>.txt"]
```

For Round 2+ deliberation, also write prior positions to file and add `--prior-positions-file` (same as Mode A deliberation pattern above).

Example dispatch (all Tasks in one message turn):
- `Task(subagent_type="nf-quorum-slot-worker", model="haiku", description="gemini-1 [gemini-cli · gemini-3-pro-preview] quorum R1", prompt='node "$HOME/.claude/nf-bin/quorum-slot-dispatch.cjs" --slot gemini-1 --mode B --round 1 --question "..." --cwd /path --timeout 300000 --output-file ".planning/quorum/slot-results/gemini-1-round-1.txt" --traces-file ".planning/quorum/slot-results/traces-round-1.txt"')`
- (one per slot in `$DISPATCH_LIST`)

**Reading results:** Same file-first approach as Mode A — read `.planning/quorum/slot-results/<slotName>-round-<N>.txt`. Parse `verdict: APPROVE | REJECT | FLAG` field.

### Collect verdicts

Parse each worker response for `verdict:` and `reasoning:` lines. Mark non-parseable as `UNAVAIL`.

Apply CE-1, CE-2, CE-3. Claude's verdict is ADVISORY — excluded from the tally below. Only external voter verdicts are counted:

Determine consensus:
- All available APPROVE → `APPROVE`
- Any REJECT → `REJECT`
- All FLAG (no APPROVE, no REJECT) → `FLAG`
- Mixed APPROVE/FLAG → `FLAG`
- All UNAVAIL → stop: "All quorum models unavailable — cannot evaluate."

If split: run deliberation (up to 9 deliberation rounds, max 10 total rounds including Round 1) with traces always included in context.

### Output consensus verdict

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► QUORUM VERDICT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

┌────────────────────────────────┬──────────────┬──────────────────────────────────────────┐
│ Model                          │ Verdict      │ Reasoning                                │
├────────────────────────────────┼──────────────┼──────────────────────────────────────────┤
│ Claude                         │ [verdict]    │ [summary]                                │
│ <slot-A> (primary)             │ [verdict]    │ [summary or UNAVAIL]                     │
│   ├─ <T1-next> (T1 fallback)  │ [verdict]    │ [only if slot-A UNAVAIL + T1 unused]     │
│   └─ <T2-next> (T2 fallback)  │ [verdict]    │ [only if all T1 also UNAVAIL]            │
│ <slot-B> (primary)             │ [verdict]    │ [summary or UNAVAIL]                     │
│   ├─ <T1-next> (T1 fallback)  │ [verdict]    │ [only if slot-B UNAVAIL + T1 unused]     │
│   └─ <T2-next> (T2 fallback)  │ [verdict]    │ [only if all T1 also UNAVAIL]            │
│ <slot-C> (primary)             │ [verdict]    │ [only if in $DISPATCH_LIST]              │
├────────────────────────────────┼──────────────┼──────────────────────────────────────────┤
│ CONSENSUS                      │ [verdict]    │ [N APPROVE, N REJECT, N FLAG, N UNAVAIL] │
└────────────────────────────────┴──────────────┴──────────────────────────────────────────┘

Slot names in each tier are resolved at runtime from `auth_type` in `providers.json`. T1 = `auth_type=sub` slots not in `$DISPATCH_LIST`; T2 = `auth_type≠sub` slots. Fallback rows are only rendered when the primary returned UNAVAIL and a replacement was dispatched. A T1 row is omitted if that slot was already dispatched as primary.

**Important: fallback slots appear at most once in this table.** Each T1/T2 slot is dispatched at most once per round (deduplication rule — see FALLBACK-01 in Mode A section). The table is for display only.

[rationale — what the traces showed]
```

Update the scoreboard with the same `update-scoreboard.cjs` pattern as Mode A.

`--model` for native agents: `claude`, `gemini`, `opencode`, `copilot`, `codex`
`--slot` for claude-mcp servers: use the slot name (e.g. `claude-1`); `--model-id`: use the `model` field returned by the `health_check` response (e.g. `deepseek-ai/DeepSeek-V3`). Use `--slot` + `--model-id` instead of `--model` for all claude-mcp instances.
`--result` values: TP, TN, FP, FN, TP+ (improvement accepted), UNAVAIL (model skipped), or leave as empty string if model did not participate
`--task` label: short identifier, e.g. "quick-25" or "plan-ph17"
`--round`: the round number that just completed
`--verdict`: the consensus verdict (APPROVE | BLOCK | DELIBERATE | CONSENSUS | GAPS_FOUND)
`--task-description`: a brief description of what was being verified/reviewed (from $ARGUMENTS or a short summary). Used by Haiku to auto-classify. Optional — omit if not meaningful.

Run one command per model per round. Each call is atomic and idempotent — if re-run for the same task+round+model it overwrites that model's vote and recalculates from scratch.

Write QUORUM_DEBATE.md using the debate file path rule above. Set `Consensus:` to the final consensus verdict (APPROVE / REJECT / FLAG). Include one `## Round N` section per round that occurred. Set `## Outcome` to the rationale from the verdict output above. If 10 rounds elapsed without full consensus, set `Consensus: ESCALATED`.

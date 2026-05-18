---
title: Canonical Quorum Dispatch Protocol
reference: true
source: commands/nf/quorum.md
last_updated: 2026-03-15
---

# Canonical Quorum Dispatch Protocol

> **IMPORTANT:** This is the implementation reference extracted from `commands/nf/quorum.md`. The quorum.md command remains the authoritative specification. Edit quorum.md first, then sync changes here.

This document provides the complete protocol for dispatching quorum workers to external models. All 8 workflows and the resolve command reference this document when implementing quorum consensus.

---

## 1. Provider Preflight (Run Once)

**Purpose:** Verify provider availability before team capture.

```bash
# Step 1: Probe LLM provider health
PROVIDER_HEALTH=$(node "$HOME/.claude/nf-bin/check-provider-health.cjs" --json)

# Step 2: Build provider status map and server list
# Extract from PROVIDER_HEALTH JSON:
# - $PROVIDER_STATUS = { providerName: healthy }
# - $CLAUDE_MCP_SERVERS = [{ serverName, model, providerName, available }]

# Step 3: Read active quorum slots from config
node "$HOME/.claude/nf-bin/quorum-preflight.cjs" --quorum-active

# Step 4: Filter for max_quorum_size and availability
node "$HOME/.claude/nf-bin/quorum-preflight.cjs" --max-quorum-size
```

**Fail-open rules:**
- Any server with `available: false` → skip immediately (mark UNAVAIL)
- Server in config but absent from health check → skip silently
- If available count < max_quorum_size and no `--force-quorum`: STOP with quorum blocked message
- Otherwise: continue with reduced quorum (emit FAN-05 note)

**Output:**
- `$DISPATCH_LIST` = first (FAN_OUT_COUNT - 1) available slots from health-filtered list
- Log format: `Active slots: slot1, slot2, slot3, ...`

---

## 2. Team Identity Capture (Run Once per Session)

**Purpose:** Build slot timeout/model lookups and initialize scoreboard.

```bash
# Capture team fingerprint from providers.json
TEAM_JSON=$(node "$HOME/.claude/nf-bin/quorum-preflight.cjs" --team)

# Build lookup maps from team JSON (each slot includes quorum_timeout_ms, idle_timeout_ms):
# - $SLOT_TIMEOUTS: { slotName: quorum_timeout_ms } (from team JSON, fallback: 300000)
# - $SLOT_MODELS: { slotName: model } (fallback: "unknown")
# - $SLOT_CLI: { slotName: display_type } (fallback: "cli")

# Detect Claude's model
CLAUDE_MODEL="${CLAUDE_MODEL:-${ANTHROPIC_MODEL:-$(current session model)}}"

# Initialize scoreboard
node "$HOME/.claude/nf-bin/update-scoreboard.cjs" init-team \
  --claude-model "${CLAUDE_MODEL}" \
  --team "${TEAM_JSON}"
```

Use `$SLOT_CLI[slotName]` and `$SLOT_MODELS[slotName]` in Task description fields for parallel UI display (e.g., `"gemini-1 [gemini-cli · gemini-3-pro-preview] quorum R1"`).

---

## 3. Adaptive Fan-Out (Based on Risk Level)

**Purpose:** Determine quorum size from risk_level (classified by Step 2.7 risk classifier in quick workflow, or from envelope in phase workflows).

```bash
# Read risk_level from classifier output or envelope (ENV-03 — fail-open)
# Quick workflow: $RISK_LEVEL set by Step 2.7 Haiku risk classifier
# Phase workflow: RISK_LEVEL=$(cat "$ENVELOPE_PATH" | jq -r '.risk_level // "medium"')

# Map to fan-out count
case "$RISK_LEVEL" in
  low)      FAN_OUT_COUNT=1 ;;    # Self only — quorum SKIPPED
  medium)   FAN_OUT_COUNT=3 ;;    # 2 external + self
  high)     FAN_OUT_COUNT=5 ;;    # 4 external + self
  *)        FAN_OUT_COUNT=3 ;;    # fail-open: unknown/absent -> medium
esac

# Build DISPATCH_LIST = first (FAN_OUT_COUNT - 1) available slots
# This is the definitive cap for all rounds in this quorum run.
# When FAN_OUT_COUNT = 1: DISPATCH_LIST is empty — quorum is skipped entirely.
```

**Tiered Slot Ordering (TIER-01):** The preflight `available_slots` array is pre-sorted with CLI/CCR slots (subprocess and ccr types) first and HTTP API slots last. Since `$DISPATCH_LIST` picks the first `(FAN_OUT_COUNT - 1)` entries, HTTP API slots are backup-only — they are never dispatched when sufficient CLI/CCR slots are available. The preflight output also includes `primary_slots` (CLI/CCR) and `backup_slots` (HTTP API) arrays for diagnostic transparency.

**Skip-quorum path (FAN_OUT_COUNT = 1):** When risk_level is "low", no external quorum workers are dispatched. The orchestrator proceeds directly to execution. EventualConsensus and ProtocolTerminates invariants do not apply (no quorum protocol runs). An audit log is emitted to ensure traceability.

**Reduced-quorum note (FAN-05):** If FAN_OUT_COUNT < MAX_QUORUM_SIZE AND FAN_OUT_COUNT > 1, emit:
```
[R6.4 reduced-quorum note] Operating with ${FAN_OUT_COUNT} total participants
(Claude + ${FAN_OUT_COUNT - 1} external); max_quorum_size is ${MAX_QUORUM_SIZE}.
Reason: risk_level=${RISK_LEVEL}. Reduced fan-out — task risk does not warrant full quorum.
```

**Preflight Slot Assignment Display (FAN-06):** After computing `$DISPATCH_LIST`, emit:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► QUORUM SLOT ASSIGNMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Primary slots (${FAN_OUT_COUNT - 1}):
   ${DISPATCH_LIST entries with model names}

 Fallback order (tiered):
   T1 (flat-rate CLI/CCR): ${primary slots not in dispatch list, or "none"}
   T2 (pay-per-use HTTP API, backup-only): ${backup_slots, or "none"}

 Total available: ${available_slots count}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

This display allows users to diagnose slot assignment and understand the fallback chain before execution begins.

---

## 4. Slot-Worker Task Dispatch Template

**YAML Format (CRITICAL):** Must match `nf-quorum-slot-worker.md` grep patterns exactly.

```yaml
slot: <slotName>
round: <round_number>
timeout_ms: <timeout from $SLOT_TIMEOUTS, default 300000>
repo_dir: <absolute path to project root>
mode: <A|B>
question: <question text>
artifact_path: <path to artifact, or empty if N/A>
review_context: <evaluation criteria for artifact, or empty>
request_improvements: <true|false>
prior_positions: |
  • Claude:
    position: [position text]
    citations: [file paths or citations, or "(none)"]
  • <slotName>:
    position: [position text]
    citations: [citations or "(none)"]
```

**Mode A (Pure Question):**
- `mode: A`
- `question:` required (the debate question)
- `artifact_path:` optional (for artifact review)
- `review_context:` optional but recommended (evaluation framing)
- `request_improvements:` optional (true to collect improvement suggestions)
- Include `prior_positions:` from Round 2 onward (deliberation)

**Mode B (Execution + Trace Review):**
- `mode: B`
- `question:` required (original question)
- `traces:` required (full execution output)
- `prior_positions:` optional (for deliberation rounds)

---

## 5. Task Dispatch (Parallel Per Round)

**Protocol:** Dispatch one `Task(subagent_type="nf-quorum-slot-worker", ...)` per slot in `$DISPATCH_LIST` as **parallel sibling calls** in one message turn.

```
Task(
  subagent_type="nf-quorum-slot-worker",
  model="haiku",
  max_turns=100,
  description="<slotName> [<$SLOT_CLI[slotName]> · <$SLOT_MODELS[slotName]>] quorum R<round>",
  prompt=<YAML block from section 4 above>
)
```

**Critical rules:**
- Do NOT dispatch slots outside `$DISPATCH_LIST`
- All workers in one round are dispatched in ONE message turn (parallel)
- Do NOT iterate over `$DISPATCH_LIST` sequentially (one Task per message)
- Between rounds: run Bash commands (preflight, scoreboard updates) sequentially
- `model="haiku"` always — slot-workers are orchestrators, not reasoners

---

## 6. Tiered Fallback (FALLBACK-01)

**When:** A dispatched slot returns UNAVAIL.

**Rules:**
1. **Collect all UNAVAIL results** from current round's parallel Tasks before proceeding
2. **T1 — flat-rate CLI fallback:** Unused slots with `auth_type=sub` (flat-rate subscription CLIs)
   - `$T1_UNUSED = [available slots with auth_type=sub] − $DISPATCH_LIST`
   - Dispatch all T1 slots at once as parallel Tasks (one message turn)
3. **T2 — pay-per-use API fallback:** Unused slots with `auth_type≠sub`
   - Only dispatch T2 if T1 is empty or fully UNAVAIL
   - `$T2_FALLBACK = [available slots with auth_type≠sub] − $DISPATCH_LIST − [already dispatched]`
   - Dispatch all T2 slots at once as parallel Tasks (one message turn)

**Deduplication:** Each slot dispatched AT MOST ONCE per round, regardless of how many primaries returned UNAVAIL.

**Display format:**
```
| <slotName> (primary)      | [position or UNAVAIL]           |
|   ├─ <T1-slot> (T1)       | [position or UNAVAIL]           |
|   └─ <T2-slot> (T2)       | [position or UNAVAIL]           |
```

### FALLBACK-01 Checkpoint (Mandatory Before Consensus)

**STOP.** Before evaluating consensus, you MUST complete this checkpoint if ANY primary slot returned UNAVAIL. Skipping this checkpoint is a protocol violation.

Run `quorum-checkpoint.cjs` to write a **structured JSON checkpoint** to `.planning/quorum/checkpoints/round-<N>.json`. The script schema-validates the values, writes the file, and prints a human-readable `<!-- FALLBACK_CHECKPOINT -->` block to stdout for the transcript. The Stop hook reads and schema-validates that file — it no longer regex-parses the HTML comment, so LLM formatting variation cannot bypass or trigger the gate.

```
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

The checkpoint file fields:

| Field | Meaning |
|---|---|
| `round` | Quorum round number — MUST match the `--round` passed to slot-worker Tasks |
| `unavail_primaries` | Primary slots that returned UNAVAIL (`[]` if none) |
| `fallback_dispatched` | Whether T1 or T2 fallback Tasks were dispatched |
| `t1_slots_tried` / `t2_slots_tried` | Fallback slots dispatched per tier (`[]` if none) |
| `all_tiers_exhausted` | True only if every T1 AND T2 slot was dispatched-and-UNAVAIL or the pool was empty |
| `proceed_reason` | Why it is now safe to evaluate consensus |

**Rules:**
- If primaries returned UNAVAIL AND `fallback_dispatched` is false, you MUST go back and dispatch fallback Tasks before continuing. Do NOT proceed to consensus.
- `all_tiers_exhausted` can only be true if every slot in T1 AND T2 was either dispatched and returned UNAVAIL, or the pool was empty.
- If a T1 fallback succeeded (returned APPROVE/BLOCK), `all_tiers_exhausted` is false but `proceed_reason` is valid because you have a replacement vote.
- **Ordering: T1 fully UNAVAIL → dispatch T2 → THEN check consensus.** Do not short-circuit to consensus after T1 when T2 slots remain undispatched.
- The Stop hook clears the gate only when the checkpoint file for the round exists, passes schema validation, and has `fallback_dispatched: true` OR `all_tiers_exhausted: true`.

---

## 7. Consensus Enforcement (CE-1, CE-2, CE-3)

**RULE CE-1: Claude is Advisory Only**
- Claude's position is context for external voters, NOT counted in tally
- Label Claude's row: `Claude (ADVISORY — not a vote)`
- Tally counts ONLY external slot-worker votes

**RULE CE-2: BLOCK Is Absolute**
- ANY BLOCK from a valid (non-UNAVAIL) external voter → NO consensus
- BLOCK stands as-is; no override or rationalization permitted
- System enters deliberation or escalates after max rounds

**RULE CE-3: Unanimity Required**
- Consensus = 100% of valid (non-UNAVAIL) external voters agree
- No majority-based approval (2/3 APPROVE + 1 BLOCK ≠ consensus)
- UNAVAIL voters excluded from denominator
- 1/1 available voters = consensus if they APPROVE **only after FALLBACK-01 checkpoint confirms all tiers exhausted**
- If FALLBACK-01 checkpoint has not been completed (i.e., undispatched T2 slots remain), 1/1 does NOT qualify as consensus — dispatch remaining tiers first

---

## 8. Scoreboard Update Post-Round

**Purpose:** Track model participation and verdicts.

```bash
# For native agents:
node "$HOME/.claude/nf-bin/update-scoreboard.cjs" \
  --model <model_name> \
  --result <vote_code> \
  --task "<task_label>" \
  --round <round_number> \
  --verdict <VERDICT> \
  --task-description "<question or topic (first 500 chars)>"

# For claude-mcp servers:
node "$HOME/.claude/nf-bin/update-scoreboard.cjs" \
  --slot <slotName> \
  --model-id <fullModelId> \
  --result <vote_code> \
  --task "<task_label>" \
  --round <round_number> \
  --verdict <VERDICT> \
  --task-description "<question or topic (first 500 chars)>"
```

**Fields:**
- `--result`: TP, TN, FP, FN, TP+, or "" (empty if model didn't participate)
- Skip entirely if model was UNAVAIL
- `--verdict`: APPROVE, BLOCK, DELIBERATE, CONSENSUS, GAPS_FOUND, ESCALATED
- Run one command per model per round (idempotent)

---

## 9. Deliberation (Up to 9 Rounds)

**Loop condition:** Continue while:
- Fewer than 10 total rounds (incl. Round 1)
- No consensus reached per CE-3 (all valid external voters agree)

**Each deliberation round:**
1. Dispatch workers to `$DISPATCH_LIST` with updated `prior_positions:` block
2. Carry `artifact_path`, `review_context`, and `request_improvements` unchanged
3. Include all models' prior positions in `prior_positions:` section
4. Collect verdicts and test for consensus (CE-1, CE-2, CE-3)
5. Update scoreboard after each round
6. If consensus → Consensus output (section 10)
7. If no consensus after round 10 → Escalate (section 11)

---

## 10. Error Classification (UNAVAIL Results)

**Categories:** Classify dispatch errors using `classifyDispatchError`:
- `TIMEOUT`: Slot exceeded timeout_ms
- `AUTH`: Auth/login error (auth gate)
- `QUOTA`: API quota exceeded (Provider DOWN)
- `SERVICE_DOWN`: Provider service unavailable
- `SPAWN_ERROR`: Task spawn/subprocess failed
- `CLI_SYNTAX`: Invalid CLI command or argument

**For auth gates:** STOP, return checkpoint with type `human-action`, provide exact auth steps (commands, where to get keys), specify verification command.

---

## 10.5. Dispatch Nonce Verification

**Purpose:** Detect fabricated result blocks from slot-workers that answered instead of dispatching.

Every genuine result block from `quorum-slot-dispatch.cjs` contains:
```
dispatch_nonce: <32-char hex>
```

The nonce is generated per-dispatch via `crypto.randomBytes(16).toString('hex')`.

**Verification rule:** If a slot-worker's output contains a structured result block but NO `dispatch_nonce:` field, treat the result as SUSPECT -> UNAVAIL. Log: `[WARN] Slot <name> result missing dispatch_nonce -- treating as UNAVAIL`.

**Why nonce, not HMAC:** The nonce is generated and verified within the same trust boundary (Node.js process chain). No shared secret is needed -- presence of a nonce proves the dispatch script ran.

---

## 11. Improvements Extraction (Mode A Only)

**Condition:** When `request_improvements: true` and consensus reached.

```bash
# 1. Collect improvements: from worker result blocks of final consensus round
# 2. Filter to non-UNAVAIL verdicts with non-empty improvements:
# 3. De-duplicate: same suggestion text = keep first only
# 4. If any improvements collected, emit:
```

```markdown
Improvements proposed:
• <slotName>: [suggestion]  —  [rationale]
• <slotName>: [suggestion]  —  [rationale]
```

Also emit structured signal (parseable by calling workflow):
```html
<!-- QUORUM_IMPROVEMENTS_START
[{"model":"<slotName>","suggestion":"...","rationale":"..."},...]
QUORUM_IMPROVEMENTS_END -->
```

If no improvements: emit `<!-- QUORUM_IMPROVEMENTS_START [] QUORUM_IMPROVEMENTS_END -->`

If `request_improvements` was not set: do NOT emit signal block.

---

## 12. Debate File Creation

**Path rule:**
- If `artifact_path` provided → write to same directory: `.planning/phases/v0.X-Y/QUORUM_DEBATE.md`
- Otherwise → `.planning/quorum/debates/YYYY-MM-DD-<short-slug>.md` (slug = first 6 words of question, lowercase, hyphens, no special chars)

**Format:**
```markdown
# Quorum Debate
Question: <question text>
Date: <YYYY-MM-DD>
Consensus: <APPROVE | REJECT | FLAG | ESCALATED>
Rounds: <N>

## Round 1
| Model | Position | Citations |
|---|---|---|
| Claude | <position> | <citations or —> |
| <slotName> | <position or UNAVAIL> | <citations or —> |

## Round N (if deliberation occurred)
[same table format]

## Outcome
<Consensus answer (Mode A) or verdict + rationale (Mode B) or escalation summary>

## Improvements
| Model | Suggestion | Rationale |
|---|---|---|
| <slotName> | ... | ... |
```

Only include `## Improvements` section when `request_improvements: true` AND improvements were proposed.

---

## Quick Reference: Preflight → Dispatch → Deliberate → Consensus

```
1. Provider health check (check-provider-health.cjs)
2. Build $DISPATCH_LIST (adaptive fan-out from risk_level)
3. Display QUORUM SLOT ASSIGNMENT (preflight preview of primary + fallback tiers)
4. Team fingerprint + scoreboard init (quorum-preflight.cjs --team)
5. Dispatch Round 1: nf-quorum-slot-worker Tasks (parallel)
6. If ANY slot UNAVAIL → FALLBACK-01:
   ├─ Dispatch T1 (unused auth_type=sub slots, parallel)
   ├─ If T1 empty or fully UNAVAIL → Dispatch T2 (auth_type≠sub slots, parallel)
   └─ Run quorum-checkpoint.cjs → structured checkpoint file (mandatory)
7. Check consensus (CE-1, CE-2, CE-3) — only after FALLBACK-01 complete
   ├─ If CONSENSUS: Output consensus, update scoreboard, create debate file
   ├─ If NO CONSENSUS: Deliberation rounds 2-10
   │  ├─ Each round: dispatch $DISPATCH_LIST + fallback for UNAVAIL slots
   │  └─ FALLBACK-01 checkpoint required each round before consensus check
   └─ If still NO CONSENSUS after round 10: Escalate, output final positions
```

All dispatch sites across the 8 workflows follow this protocol.

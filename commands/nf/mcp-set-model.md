---
name: nf:mcp-set-model
description: Set the default model for a quorum agent — validates against the agent's available_models and persists to ~/.claude/nf.json
argument-hint: "<agent> <model>"
allowed-tools:
  - Bash
  # Step 3 calls `mcp__<agent>__identity` DIRECTLY, so the target slot must be
  # allow-listed here or the identity probe is blocked and the skill falls back to
  # an unvalidated write. Slots are user-configurable, so a static list can't be
  # exhaustive — this covers the common ones (default CLI + Daintree + the
  # documented ccr-1..6) and the graceful fallback handles any other slot a user
  # has added. The real gap fixed here was the previously-MISSING Daintree slots
  # (claude-z-ai, claude-minimax); the ccr-* entries are retained.
  - mcp__codex-1__identity
  - mcp__gemini-1__identity
  - mcp__opencode-1__identity
  - mcp__copilot-1__identity
  - mcp__claude-1__identity
  - mcp__claude-z-ai__identity
  - mcp__claude-minimax__identity
  - mcp__ccr-1__identity
  - mcp__ccr-2__identity
  - mcp__ccr-3__identity
  - mcp__ccr-4__identity
  - mcp__ccr-5__identity
  - mcp__ccr-6__identity
---

<objective>
Set the default model for a named quorum agent. The preference is written to `~/.claude/nf.json` under `model_preferences` and is picked up by the nForma prompt hook on the next quorum invocation.
</objective>

<process>

## Step 1 — Parse arguments

Parse `$ARGUMENTS` as two tokens: `$AGENT` and `$MODEL`.

If either token is missing, print usage and stop:
```
Usage: /nf:mcp-set-model <agent> <model>

Valid agents: read dynamically from ~/.claude.json (run without arguments to list)
```

## Step 2 — Validate agent name

Run this Bash command to get valid slots from `~/.claude.json`:

```bash
node << 'NF_EVAL'
const fs=require('fs'),os=require('os'),path=require('path');
const SKIP=['canopy','sentry'];
try {
  const cfg=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude.json'),'utf8'));
  const slots=Object.keys(cfg.mcpServers||{}).filter(s=>!SKIP.includes(s));
  console.log(JSON.stringify(slots));
} catch(e) {
  console.log('[]');
}
NF_EVAL
```

Parse the output as `$VALID_SLOTS` (JSON array of strings).

If `$AGENT` is not in `$VALID_SLOTS`, print an error and stop:
```
Error: Unknown agent "$AGENT"

Valid agents: <$VALID_SLOTS joined with spaces>
```

## Step 3 — Fetch available_models from identity tool

Call the identity tool for `$AGENT` — one sequential call:

`mcp__<$AGENT>__identity`

(Replace hyphens in the agent name with hyphens as-is: `codex-1` → `mcp__codex-1__identity`)

Parse the response. Extract the `available_models` array.

If the tool call errors or times out, print a warning and proceed to manual confirmation:
```
Warning: Could not reach $AGENT identity tool — cannot validate model name.
Proceeding with write (unvalidated).
```
Skip the model validation in Step 4 and go directly to Step 5.

## Step 4 — Validate model name

Check if `$MODEL` appears in the `available_models` array from Step 3.

If NOT in the list, print an error and stop:
```
Error: Model "$MODEL" is not in $AGENT's available_models list.

Available models for $AGENT:
  <list each model on its own line>

Run /nf:mcp-set-model $AGENT <model> with one of the above models.
```

## Step 5 — Write model preference to nf.json

Run this inline node script via Bash:

```bash
AGENT="$AGENT" MODEL="$MODEL" node -e "
const fs = require('fs');
const path = require('path');
const os = require('os');

const cfgPath = path.join(os.homedir(), '.claude', 'nf.json');

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
} catch (e) {
  // File missing or malformed — start with minimal defaults
  cfg = { quorum_commands: ['plan-phase', 'new-project', 'new-milestone', 'discuss-phase', 'verify-work', 'research-phase', 'quick'] };
}

const oldModel = (cfg.model_preferences || {})[process.env.AGENT] || null;
cfg.model_preferences = cfg.model_preferences || {};
cfg.model_preferences[process.env.AGENT] = process.env.MODEL;

fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

const result = { oldModel, newModel: process.env.MODEL, agent: process.env.AGENT };
process.stdout.write(JSON.stringify(result) + '\n');
"
```

Parse the JSON output to get `oldModel` and `newModel`.

## Step 6 — Print confirmation

Display:
```
Model preference updated

  Agent:     $AGENT
  Old model: <oldModel or "(none — using agent default)">
  New model: $MODEL

The preference is saved to ~/.claude/nf.json.
The next quorum invocation will pass model="$MODEL" when calling $AGENT.
```

</process>

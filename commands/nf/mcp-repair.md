---
name: nf:mcp-repair
description: Auto-diagnose and repair quorum slot connectivity — restarts MCP servers, checks CLI binaries, deep inference probes, reports unfixable issues
allowed-tools:
  - Bash
  - Read
  # MCP tool access: this skill calls mcp__<slot>__identity, mcp__<slot>__health_check,
  # and mcp__<slot>__deep_health_check for each slot discovered from ~/.claude.json mcpServers.
  # MCP tools become available at session startup based on what is configured in ~/.claude.json —
  # slots present there are accessible without being explicitly listed here.
  # Note: listing specific mcp__*__ tool names here is not required; the session's registered
  # tool set is determined by session startup, not by this frontmatter. The comment above is
  # documentation only.
  # The executor must NOT attempt to call tools for slots not present in ~/.claude.json.
---

<objective>
Auto-diagnose all quorum slot connectivity issues and apply automatic repairs where possible.

When quorum slots fail (MCP servers down, CLI auth expired, quota exhausted), users currently must manually diagnose and fix each one. This command automates the diagnosis-repair-verify cycle using a 4-step diagnostic:

1. **Diagnose** — collect identity + health_check + deep_health_check from all configured slots
2. **Classify** — categorize each slot's failure mode using layered probe results
3. **Auto-repair** — restart downed services (service.start for ccr slots) and MCP servers (pkill + reconnect)
4. **Guide** — provide actionable instructions for non-auto-fixable issues
5. **Verify** — re-check repaired slots to confirm fix
6. **Summarize** — show before/after health comparison

This command is read-only except for the service restart and pkill restart actions. It does NOT invoke quorum and is NOT in quorum_commands.
</objective>

<process>

> **IMPORTANT: Run every Bash call in this workflow sequentially (one at a time). Never issue two Bash calls in parallel. A failure in one parallel sibling cancels all other parallel siblings — sequential execution isolates failures.**

## Step 1 — Initial diagnosis (before state)

First, discover the configured slot names from `~/.claude.json`:

```bash
SLOT_NAMES=$(node << 'NF_EVAL'
var fs = require("fs"), path = require("path"), os = require("os");
try {
  var cj = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
  var slots = Object.keys(cj.mcpServers || {}).filter(function(k) { return k !== "unified-1"; });
  console.log(JSON.stringify(slots));
} catch (e) {
  process.stderr.write("Warning: could not read ~/.claude.json: " + e.message + "\n");
  console.log(JSON.stringify([]));
}
NF_EVAL
)
```

`$SLOT_NAMES` is now a JSON array string. Example with the default fleet: `["codex-1","gemini-1","opencode-1","copilot-1","claude-1"]`. With user-added Claude Code Router slots, the array also includes entries like `"ccr-1"`, `"ccr-2"`, etc. — those are no longer pre-installed.

Parse the slot count from `$SLOT_NAMES` (array length) for the banner. Store as `$SLOT_COUNT`.

Display banner:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► MCP REPAIR (4-step diagnostic)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Diagnosing $SLOT_COUNT quorum slots...
```

For each slot name in `$SLOT_NAMES`, call the following MCP tools directly in the orchestrator, one at a time, sequentially. If a tool is unavailable or throws, record null for that slot/field. Note: MCP servers that are not health-check servers (e.g., filesystem-1, brave-1, gmail) may not expose `identity` or `health_check` tools — treat null or "tool not found" results for these as "unresponsive" rather than errors.

For each slot `<slot>` in $SLOT_NAMES:
- Call `mcp__<slot>__identity({})` → record as identity result (null if tool unavailable)
- Call `mcp__<slot>__health_check({})` → record as hc result (null if tool unavailable)
- Call `mcp__<slot>__deep_health_check({})` → record as deep result (null if tool unavailable)

Repeat this pattern for every slot in `$SLOT_NAMES` before moving to the next step.

Assemble `$BEFORE_STATE` as a JSON object keyed by slot name:
{
  "<slot-name>": { "identity": <result or null>, "hc": <result or null>, "deep": <result or null> },
  ...one entry per slot in $SLOT_NAMES...
}

Store this as `$BEFORE_STATE`.

## Step 2 — 4-step diagnostic classification

### Step 2a — Shallow check (existing health_check)

Use results from `$BEFORE_STATE`. If identity is null and health_check is null, the slot is unreachable.

### Step 2b — Service status check

For slots that have `service` config in providers.json (claude-1..6), check service status:

```bash
node << 'NF_EVAL'
var fs = require("fs");
var cp = require("child_process");
var os = require("os"), path = require("path");
// Portable + guarded providers.json load (installed at ~/.claude/nf-bin, or
// ./bin from the repo). A missing/malformed file must not crash with ENOENT.
var providers = null;
[path.join(os.homedir(),".claude","nf","bin","providers.json"),
 path.join(os.homedir(),".claude","nf-bin","providers.json"),
 path.join(process.cwd(),"bin","providers.json")].some(function(pp){
  try { var parsed = JSON.parse(fs.readFileSync(pp,"utf8")); if (parsed && Array.isArray(parsed.providers)) { providers = parsed; return true; } return false; } catch(e) { return false; }
});
if (!providers || !Array.isArray(providers.providers)) { console.log(JSON.stringify({})); process.exit(0); }
var result = {};
providers.providers.forEach(function(p) {
  if (p.service && p.service.status) {
    try {
      var out = cp.execFileSync(p.service.status[0], p.service.status.slice(1), {encoding:"utf8", timeout: 5000});
      result[p.name] = out.trim();
    } catch(e) {
      result[p.name] = "error: " + (e.message || "unknown");
    }
  }
});
console.log(JSON.stringify(result));
NF_EVAL
```

If any service reports not-running/stopped, classify as SERVICE_DOWN and attempt auto-start:

```bash
# For each SERVICE_DOWN slot, run the start command then poll status
node << 'NF_EVAL'
var fs = require("fs");
var cp = require("child_process");
var os = require("os"), path = require("path");
// Portable + guarded providers.json load (see Step 2b above).
var providers = null;
[path.join(os.homedir(),".claude","nf","bin","providers.json"),
 path.join(os.homedir(),".claude","nf-bin","providers.json"),
 path.join(process.cwd(),"bin","providers.json")].some(function(pp){
  try { var parsed = JSON.parse(fs.readFileSync(pp,"utf8")); if (parsed && Array.isArray(parsed.providers)) { providers = parsed; return true; } return false; } catch(e) { return false; }
});
if (!providers || !Array.isArray(providers.providers)) { console.log("Cannot read providers.json — skipping service restart."); process.exit(0); }
var downSlots = providers.providers.filter(function(p) {
  if (!p.service || !p.service.status) return false;
  try {
    var out = cp.execFileSync(p.service.status[0], p.service.status.slice(1), {encoding:"utf8", timeout: 5000});
    return out.toLowerCase().includes("not running") || out.toLowerCase().includes("stopped");
  } catch(e) { return true; }
});
downSlots.forEach(function(p) {
  console.log("Restarting " + p.name + "...");
  try {
    cp.execFileSync(p.service.start[0], p.service.start.slice(1), {encoding:"utf8", timeout: 10000});
  } catch(e) {
    console.log("Restarting " + p.name + "... FAILED: " + e.message);
    return;
  }
  // Poll status every 1s, up to 10s total
  var ok = false;
  for (var i = 0; i < 10; i++) {
    cp.execFileSync("sleep", ["1"]);
    try {
      var status = cp.execFileSync(p.service.status[0], p.service.status.slice(1), {encoding:"utf8", timeout: 3000});
      if (!status.toLowerCase().includes("not running") && !status.toLowerCase().includes("stopped")) {
        ok = true;
        break;
      }
    } catch(e) { /* continue polling */ }
  }
  console.log("Restarting " + p.name + "... " + (ok ? "OK" : "FAILED"));
});
if (downSlots.length === 0) console.log("All services running.");
NF_EVAL
```

### Step 2c — Deep probe

Use the `deep` field from `$BEFORE_STATE` for each slot. The deep_health_check result contains `{ healthy, latencyMs, layer, error }` where `layer` classifies the failure point.

### Step 2d — Final classification

Combine results from all 4 steps to classify each slot:

Check CLI binary existence using three-tier resolution:

```bash
node << 'NF_EVAL'
var fs = require("fs");
var cp = require("child_process");
var os = require("os"), path = require("path");
// Portable + guarded providers.json load (see Step 2b above).
var providers = null;
[path.join(os.homedir(),".claude","nf","bin","providers.json"),
 path.join(os.homedir(),".claude","nf-bin","providers.json"),
 path.join(process.cwd(),"bin","providers.json")].some(function(pp){
  try { var parsed = JSON.parse(fs.readFileSync(pp,"utf8")); if (parsed && Array.isArray(parsed.providers)) { providers = parsed; return true; } return false; } catch(e) { return false; }
});
if (!providers || !Array.isArray(providers.providers)) { console.log(JSON.stringify({})); process.exit(0); }
var result = {};
providers.providers.forEach(function(p) {
  if (p.mainTool) {
    var found = false;
    try { found = p.cli ? fs.existsSync(p.cli) : false; } catch(_) {}
    if (!found) {
      try { cp.execFileSync("which", [p.mainTool], {encoding:"utf8"}); found = true; } catch(_) {}
    }
    result[p.name] = found ? "found" : "missing";
  }
});
console.log(JSON.stringify(result));
NF_EVAL
```

Store as `$BINARY_STATUS`.

For each slot, apply the combined classification using the deep_health_check layer as the primary signal:

| Layer from deep_health_check | Category | Auto-fixable? |
|---|---|---|
| INFERENCE_OK | healthy | No action needed |
| BINARY_MISSING | cli-missing | NO — tell user to install |
| SERVICE_DOWN | service-down | YES — auto-start attempted in Step 2b |
| AUTH_EXPIRED | auth-expired | NO — tell user to re-auth |
| QUOTA_EXCEEDED | quota-exceeded | NO — report wait time |
| INFERENCE_TIMEOUT | timeout | NO — suggest /nf:mcp-restart |

Fallback classification (when deep_health_check result is null/unavailable):

| Category | Condition | Auto-fixable? |
|---|---|---|
| `healthy` | identity OK + health_check healthy | No action needed |
| `mcp-down` | identity null/threw (claude-1..6 only) | YES — pkill + reconnect |
| `cli-missing` | `$BINARY_STATUS[slot]` is "missing" | NO — tell user to install |
| `auth-expired` | identity OK but hc fails with 401/403 | NO — tell user to re-auth |
| `quota-exceeded` | identity OK but hc fails with 402/429 | NO — report wait time |
| `timeout` | identity or hc timed out (null result for CLI slots) | NO — suggest `/nf:mcp-restart <slot>` |
| `unknown` | any other failure | NO — report raw error |

Store classified results as `$DIAGNOSIS` (map of slot name to category).

## Step 3 — Display diagnosis table

Render a diagnosis table with columns: Slot | Type | Layer | Status | Issue | Action.

```
┌─────────────┬──────────┬──────────────────┬──────────┬─────────────────────┬──────────────────────────────┐
│ Slot        │ Type     │ Layer            │ Status   │ Issue               │ Action                       │
├─────────────┼──────────┼──────────────────┼──────────┼─────────────────────┼──────────────────────────────┤
│ codex-1     │ CLI      │ INFERENCE_OK     │ healthy  │ —                   │ —                            │
│ gemini-1    │ CLI      │ QUOTA_EXCEEDED   │ quota    │ 429 rate limited    │ wait ~30min                  │
│ claude-1    │ MCP      │ SERVICE_DOWN     │ down     │ service stopped     │ auto-restarting              │
│ ...         │          │                  │          │                     │                              │
└─────────────┴──────────┴──────────────────┴──────────┴─────────────────────┴──────────────────────────────┘
```

Slot Type is determined from providers.json: slots with `mainTool` field = `CLI`, without = `MCP`.

Count healthy vs unhealthy: `M/$SLOT_COUNT healthy`

## Step 4 — Auto-repair: restart downed services and MCP servers

### Service auto-start (ccr slots)

For each slot classified as `service-down` with `service.start` config in providers.json:

1. Print "Restarting <slot>..."
2. Run `service.start` command
3. Poll status every 1s, up to 10s total (do NOT use a hardcoded sleep)
4. Print "Restarting <slot>... OK" or "Restarting <slot>... FAILED" based on poll result
5. Re-run deep_health_check to verify:

Call mcp__<slot>__deep_health_check({}) directly and record the result.

### MCP server restart (pkill for mcp-down slots)

For each slot classified as `mcp-down` (claude-1..6 only, when service auto-start did not resolve):

1. Read `~/.claude.json` to find the exact process command/path for that slot's MCP server entry (same logic as mcp-restart.md Step 3):

```bash
AGENT="<slot-name>" node << 'NF_EVAL'
var fs = require("fs"), path = require("path"), os = require("os");
var cj;
try { cj = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8")); }
catch(e) { process.stderr.write("could not read ~/.claude.json: " + (e && e.message || e) + "\n"); process.exit(2); }
var sc = (cj.mcpServers || {})[process.env.AGENT];
if (sc === undefined) { process.stderr.write("not configured\n"); process.exit(2); }
var cmd = sc.command, args = sc.args || [];
if (cmd === "node" && args.length > 0) console.log(JSON.stringify({type:"local",processPath:args[0]}));
else if (cmd === "npx" || cmd === "npm") console.log(JSON.stringify({type:"npx",packageName:args[args.length-1]}));
else console.log(JSON.stringify({type:"unknown",command:cmd}));
NF_EVAL
```

2. Kill using the exact process path from ~/.claude.json — do NOT use broad patterns like `pkill -f "claude"` which would over-match:

**type = "local":**
```bash
pkill -f "$PROCESS_PATH" 2>/dev/null || true
```

**type = "npx":**
```bash
pkill -f "npm exec $PACKAGE_NAME" 2>/dev/null || true
sleep 0.5
pkill -f "$PACKAGE_NAME" 2>/dev/null || true
```

3. Wait 3 seconds for Claude Code to auto-restart:
```bash
sleep 3
```

4. Call the identity tool to verify reconnection:
`mcp__<slot>__identity`

Print progress: `Restarting <slot>... [OK|FAILED]`

If NO slots need auto-repair, print: `No auto-fixable issues found.`

**Deduplication note:** All claude-1..6 slots typically share one process (`unified-mcp-server.mjs`). If multiple claude-* slots are down, kill once and verify all. Avoid redundant kills of the same process.

## Step 5 — Report manual actions needed

For each non-auto-fixable slot, print specific guidance:

**cli-missing:**
```
<slot>: Binary not found. Install with:
  codex:    npm install -g @openai/codex
  gemini:   npm install -g @google/gemini-cli
  opencode: go install github.com/anthropics/opencode@latest
  copilot:  gh extension install github/gh-copilot
```

**auth-expired:**
```
<slot>: Auth expired. Run in a separate terminal:
  codex:    codex auth login
  gemini:   gemini auth login
  opencode: opencode auth login
  copilot:  gh auth login
```

**quota-exceeded:**
```
<slot>: Quota exceeded. Resets in ~30 minutes.
        Use --force-quorum to skip this slot.
```

**timeout:**
```
<slot>: Timed out (no auto-retry in v1).
        Run: /nf:mcp-restart <slot>
```

**unknown:**
```
<slot>: Unknown error: <raw error message from identity or health_check>
```

If no manual actions needed, skip this step.

## Step 6 — Post-repair verification (after state)

If any auto-repairs were attempted in Step 4, call identity, health_check, and deep_health_check directly on ONLY the repaired slots (same sequential direct-call pattern as Step 1). Assemble results into `$AFTER_STATE` using the same JSON structure as `$BEFORE_STATE` but only for repaired slots.

Store as `$AFTER_STATE`.

If no repairs were attempted, skip this step.

## Step 7 — Before/after summary

**If repairs were attempted:**

```
━━━ REPAIR SUMMARY ━━━

  Before: M/N healthy
  After:  P/N healthy

  Repaired:
    claude-1: SERVICE_DOWN → INFERENCE_OK
    codex-1: SERVICE_DOWN → INFERENCE_OK

  Still broken (manual action needed):
    gemini-1: QUOTA_EXCEEDED — wait ~30min
```

Where N = total configured slots from providers.json.

**If no repairs needed and all slots healthy:**

```
All N quorum slots healthy. No repairs needed.
```

**If no repairs needed but some slots broken (all non-auto-fixable):**

```
No auto-fixable issues found. Manual action needed for M slot(s) — see above.
```

</process>

<success_criteria>
- All configured slots from ~/.claude.json mcpServers are diagnosed (not a hardcoded list)
- Slot names are discovered dynamically at runtime from ~/.claude.json mcpServers keys
- Diagnosis table shows Slot | Type | Layer | Status | Issue | Action for every slot
- Deep inference probe (deep_health_check) used for comprehensive diagnosis
- Service auto-start attempted for SERVICE_DOWN slots with service.start config
- Auto-start uses polling loop (1s interval, 10s max) instead of hardcoded sleep
- Auto-start prints "Restarting <slot>... OK/FAILED" for user visibility
- CLI binary existence checked via three-tier resolution (providers.json cli field, which fallback, missing)
- Downed MCP servers (claude-1..6) auto-repaired via pkill using exact process path from ~/.claude.json
- Non-auto-fixable issues (auth, quota, missing binary, timeout) produce actionable user guidance
- Before/after summary shows health improvement metrics after repairs
- MCP tool calls issued directly in the orchestrator (not via Task() sub-agents, which lack MCP server access)
- Result JSON includes "deep" field per slot
- Sequential Bash execution pattern followed throughout
- No quorum invariants violated (observational + restart only)
</success_criteria>

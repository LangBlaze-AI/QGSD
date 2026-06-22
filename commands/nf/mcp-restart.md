---
name: nf:mcp-restart
description: Restart a quorum agent's MCP server process — kills the running process and waits for Claude Code to reconnect automatically
argument-hint: "<agent>"
allowed-tools:
  - Bash
  - mcp__codex-1__identity
  - mcp__gemini-1__identity
  - mcp__opencode-1__identity
  - mcp__copilot-1__identity
  - mcp__claude-1__identity
  - mcp__ccr-1__identity
  - mcp__ccr-2__identity
  - mcp__ccr-3__identity
  - mcp__ccr-4__identity
  - mcp__ccr-5__identity
  - mcp__ccr-6__identity
---

<objective>
Restart a named quorum agent's MCP server process. Reads `~/.claude.json` to identify the running process, kills it, and waits for Claude Code to automatically reconnect. Claude Code manages MCP server lifecycles — when a child process dies, Claude Code restarts it automatically. After killing the process, this command waits 2 seconds and calls the agent's identity tool to confirm reconnection.
</objective>

<process>

## Step 1 — Parse arguments

Parse `$ARGUMENTS` as one token: `$AGENT`.

If `$AGENT` is missing, print usage and stop:
```
Usage: /nf:mcp-restart <agent>

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

## Step 3 — Read process identity from ~/.claude.json

Run this inline node script via Bash:

```bash
AGENT="$AGENT" node -e "
const fs = require('fs');
const path = require('path');
const os = require('os');

const claudeJsonPath = path.join(os.homedir(), '.claude.json');
let claudeJson;
try {
  claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
} catch (e) {
  console.error('Error: Cannot read ~/.claude.json: ' + e.message);
  process.exit(1);
}

const servers = claudeJson.mcpServers || {};
const agent = process.env.AGENT;
const serverConfig = servers[agent];

if (!serverConfig) {
  console.error('Error: Agent \"' + agent + '\" is not configured in ~/.claude.json mcpServers');
  process.exit(2);
}

const command = serverConfig.command;
const args = serverConfig.args || [];

let result;
if (command === 'node' && args.length > 0) {
  // local node path: kill by matching argv path
  result = { type: 'local', processPath: args[0] };
} else if (command === 'npx' || command === 'npm') {
  // npx-based: kill by package name (matches both npm exec and node child)
  const packageName = args[args.length - 1];
  result = { type: 'npx', packageName };
} else {
  result = { type: 'unknown', command };
}

process.stdout.write(JSON.stringify(result) + '\n');
"
```

Store output as `$PROCESS_INFO`.

If exit code 1 or 2: print the error message and stop.
If exit code 0: parse `$PROCESS_INFO` JSON.

## Step 4 — Kill the MCP server process

Based on the `type` field from `$PROCESS_INFO`:

**type = "local":**

Kill all node processes whose argv path matches the server path:
```bash
pkill -f "$PROCESS_PATH" 2>/dev/null || true
```
where `$PROCESS_PATH` is `process_info.processPath`.

Print: `Sending SIGTERM to processes matching: $PROCESS_PATH`

**type = "npx":**

Kill both the npm exec parent and the node child subprocess:
```bash
pkill -f "npm exec $PACKAGE_NAME" 2>/dev/null || true
sleep 0.5
pkill -f "$PACKAGE_NAME" 2>/dev/null || true
```
where `$PACKAGE_NAME` is `process_info.packageName`.

Print: `Sending SIGTERM to npm exec + node processes for: $PACKAGE_NAME`

**type = "unknown":**
Print:
```
Warning: Cannot determine process pattern for $AGENT (command: <command>).
Cannot restart automatically. Restart Claude Code session to reload this agent.
```
Stop.

## Step 5 — Wait for reconnection

Wait 2 seconds:
```bash
sleep 2
```

Print: `Waiting for Claude Code to reconnect...`

## Step 6 — Verify reconnection via identity tool

Call the identity tool for `$AGENT` — one sequential call:

`mcp__<$AGENT>__identity`

(Replace hyphens in the agent name with hyphens as-is: `codex-1` → `mcp__codex-1__identity`)

**If identity tool returns successfully:**
Parse response. Print:
```
Agent $AGENT restarted and responding

  Name:    <name from identity>
  Version: <version from identity>
  Model:   <model from identity>
```

**If identity tool errors or times out:**
Print:
```
Processes killed. Claude Code is reconnecting to $AGENT.
Check status in a few seconds: /nf:mcp-status
```

</process>

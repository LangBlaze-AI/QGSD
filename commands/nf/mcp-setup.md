---
name: nf:mcp-setup
description: Configure quorum agents — first-run linear onboarding for new installs, live-status agent menu for re-runs
allowed-tools:
  - Bash
  - Read
---

<objective>
Configure nForma quorum agents in `~/.claude.json`. Detects whether any MCP servers are configured and routes to the appropriate flow:
- **First-run** (zero configured entries): linear onboarding — select agent templates, collect API keys via secrets store, write batch changes with backup, restart agents
- **Re-run** (existing entries): live-status agent roster menu — view model/provider/key status, select agent, choose action (set key / swap provider / remove)
</objective>

<process>

## Step 1: Detect first-run vs re-run

Run this Bash command and store the output as SETUP_INFO:

```bash
SETUP_INFO=$(node -e "
const fs = require('fs');
const path = require('path');
const os = require('os');

const claudeJsonPath = path.join(os.homedir(), '.claude.json');
let claudeJson = {};
try {
  claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
} catch (e) {
  // Missing or corrupt: treat as fresh install
}
const servers = claudeJson.mcpServers || {};
const configured = Object.entries(servers).filter(([k, v]) => v && v.command && v.args);
const isFirstRun = configured.length === 0;
const result = { isFirstRun, configuredCount: configured.length, agentKeys: configured.map(([k]) => k) };
process.stdout.write(JSON.stringify(result) + '\n');
")
```

Parse SETUP_INFO JSON for: `isFirstRun` (boolean), `configuredCount` (int), `agentKeys` (array).

**If `isFirstRun` is true:** Continue to Step 2 (first-run flow).

**If `isFirstRun` is false:** Skip to the Re-run Agent Menu section below.

---

## Step 2: First-run onboarding flow

Display the welcome banner:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► MCP SETUP — FIRST RUN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

No quorum agents configured. Let's set up your first agent.

Each agent is a claude-mcp-server instance connected to a
different LLM provider. You need at least one to use quorum.
```

**Provider template map** (reference throughout the first-run flow):

> ℹ️ **Note**: The `ccr-*` templates below are **not pre-installed** in
> `bin/providers.json` (they were retired from the default fleet — Together.xyz routing via
> Claude Code Router is still fully supported, just opt-in). This wizard still configures
> them on demand: picking one writes both the MCP server entry to `~/.claude.json` and a
> matching provider entry to `~/.claude/nf/bin/providers.json`. Pick "Skip" if you don't
> need open-weight routing.

| Agent | Provider | Base URL | Model |
|---|---|---|---|
| ccr-1 | Together.xyz | https://api.together.xyz/v1 | MiniMaxAI/MiniMax-M2.5 |
| ccr-2 | Together.xyz | https://api.together.xyz/v1 | Qwen/Qwen3.5-397B-A17B |
| ccr-3 | Together.xyz | https://api.together.xyz/v1 | Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8 |
| ccr-4 | Together.xyz | https://api.together.xyz/v1 | moonshotai/Kimi-K2.5 |
| ccr-5 | Together.xyz | https://api.together.xyz/v1 | openai/gpt-oss-120b |
| ccr-6 | Together.xyz | https://api.together.xyz/v1 | zai-org/GLM-5.1 |

### Step 2a: Select agent template

Use AskUserQuestion:
- header: "Choose an agent to configure"
- question: "Select an agent template to set up. You can add more after."
- options (omit agents already configured or skipped in this session):
  - "1 — ccr-1 (Together.xyz, MiniMax-M2.5)"
  - "2 — ccr-2 (Together.xyz, Qwen3.5-397B)"
  - "3 — ccr-3 (Together.xyz, Qwen3-Coder-480B)"
  - "4 — ccr-4 (Together.xyz, Kimi-K2.5)"
  - "5 — ccr-5 (Together.xyz, gpt-oss-120b)"
  - "6 — ccr-6 (Together.xyz, GLM-5.1)"
  - "Skip — configure later via /nf:mcp-setup"

If "Skip" is chosen, display:

```
⚠ No agents configured. Run /nf:mcp-setup when ready.
```

Stop.

### Step 2b: Collect API key

Resolve agent name, provider name, base URL, and model from the selection using the template map above.

Use AskUserQuestion:
- header: "API Key — {agent-name}"
- question: "Enter your {provider-name} API key.\n\nThe key will be stored in your secrets store (secrets store). It will not appear in any log or plain-text file."
- options:
  - "Continue (I have my key ready)"
  - "Skip this agent"

If "Skip this agent": add agent to skipped list, return to Step 2a.

If "Continue": use a second AskUserQuestion to collect the key:
- header: "Enter API Key"
- question: "Paste the API key for {agent-name} ({provider-name}):"
- options: (user types key and selects "Confirm")
  - "Confirm key"

Store the key using this Bash command (substitute AGENT_KEY and API_KEY):

```bash
KEY_RESULT=$(node -e "
const { set, SERVICE } = require('~/.claude/nf-bin/secrets.cjs');
const agentKey = process.env.AGENT_KEY;
const apiKey   = process.env.API_KEY;
(async () => {
  try {
    const keyName = 'ANTHROPIC_API_KEY_' + agentKey.toUpperCase().replace(/-/g,'_');
    await set(SERVICE, keyName, apiKey);
    process.stdout.write(JSON.stringify({ stored: true, method: 'secrets store', keyName }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ stored: false, error: e.message }) + '\n');
  }
})();
" AGENT_KEY="{agent-name}" API_KEY="{user-key}")
```

Parse KEY_RESULT:
- `stored: true` — mark agent as `method: secrets store` in pending batch
- `stored: false` (secrets store unavailable) — handle fallback below

**Keytar unavailable fallback:**

Use AskUserQuestion:
- header: "Keychain Unavailable"
- question: "System keychain unavailable. API key will be stored unencrypted in ~/.claude.json (less secure). Confirm?\n\nLinux users: sudo apt install libsecret-1-dev gnome-keyring"
- options:
  - "Store unencrypted in ~/.claude.json (less secure)"
  - "Skip this agent"

If "Skip this agent": add to skipped list, return to Step 2a.

If "Store unencrypted": mark agent as `method: env_block` with the key value in pending batch. Write audit log:

```bash
mkdir -p ~/.claude/debug
node -e "
const fs = require('fs');
const ts = new Date().toISOString();
const msg = ts + ' nForma mcp-setup: secrets store unavailable for ' + process.env.AGENT_KEY + ' — API key stored unencrypted in env block\n';
fs.appendFileSync(require('os').homedir() + '/.claude/debug/mcp-setup-audit.log', msg);
" AGENT_KEY="{agent-name}"
```

### Step 2c: Add another or finish

Use AskUserQuestion:
- header: "Agent Added"
- question: "Agent {agent-name} configured. Add another or finish?"
- options:
  - "Add another agent"
  - "Finish setup"

If "Add another agent": return to Step 2a (omit already-configured agents).
If "Finish setup": continue to Step 3.

---

## Step 3: Apply pending changes

If pending batch is empty (all skipped):

```
⚠ No agents configured. Run /nf:mcp-setup when ready.
```

Stop.

Display pending summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► REVIEW PENDING CHANGES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Agents to add to ~/.claude.json:

  ◆ {agent-name}  →  {provider}  ({base-url})
    Key: {stored in secrets store | stored in env block (unencrypted)}
  [repeat for each pending agent]

Skipped:
  ○ {agent-name} — run /nf:mcp-setup to configure later
```

Use AskUserQuestion:
- header: "Apply Changes"
- question: "Apply changes to ~/.claude.json and restart configured agents?"
- options:
  - "Apply and restart agents"
  - "Cancel — discard all changes"

If "Cancel": display "Changes discarded." Stop.

If "Apply and restart agents":

### Step 3a: Backup ~/.claude.json

```bash
cp ~/.claude.json ~/.claude.json.backup-$(date +%Y-%m-%d-%H%M%S) 2>/dev/null || true
```

### Step 3b: Resolve claude-mcp-server path

```bash
CLAUDE_MCP_PATH=$(node -e "
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { spawnSync } = require('child_process');

// Strategy 1: read from existing ~/.claude.json entries
try {
  const cj = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
  for (const [, cfg] of Object.entries(cj.mcpServers || {})) {
    if ((cfg.args || []).some(a => String(a).includes('claude-mcp-server'))) {
      process.stdout.write(cfg.args[0]);
      process.exit(0);
    }
  }
} catch (e) {}

// Strategy 2: check global npm root
try {
  const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  const npmRoot = (r.stdout || '').trim();
  const candidate = path.join(npmRoot, 'claude-mcp-server', 'dist', 'index.js');
  if (fs.existsSync(candidate)) { process.stdout.write(candidate); process.exit(0); }
} catch (e) {}

process.stdout.write('');
" 2>/dev/null)
```

### Step 3c: Write entries to ~/.claude.json

If `$CLAUDE_MCP_PATH` is empty (Step 3b returned empty string), display a warning and use the fallback:

```bash
if [ -z "$CLAUDE_MCP_PATH" ]; then
  echo "⚠ Could not resolve claude-mcp-server path automatically. The mcpServers entry will use 'claude-mcp-server' as the args value. You may need to update the path manually after installation."
  CLAUDE_MCP_PATH="claude-mcp-server"
fi
```

For each pending agent, add the mcpServers entry. Use this inline node script as a template (adapt for the actual pending agents in the session):

```bash
node -e "
const fs  = require('fs');
const path = require('path');
const os  = require('os');

const claudeJsonPath = path.join(os.homedir(), '.claude.json');
let claudeJson = {};
try { claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch (e) {}
if (!claudeJson.mcpServers) claudeJson.mcpServers = {};

// pendingAgents is an array of { name, baseUrl, model, method, apiKey }
// where method is 'secrets store' or 'env_block'
const pendingAgents = JSON.parse(process.env.PENDING_AGENTS_JSON);
const mcpPath = process.env.CLAUDE_MCP_PATH || '';

for (const agent of pendingAgents) {
  claudeJson.mcpServers[agent.name] = {
    command: 'node',
    args: [mcpPath],
    env: {
      ANTHROPIC_API_KEY: agent.method === 'env_block' ? agent.apiKey : '',
      ANTHROPIC_BASE_URL: agent.baseUrl,
      CLAUDE_DEFAULT_MODEL: agent.model
    }
  };
}

fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
process.stdout.write(JSON.stringify({ written: true, count: pendingAgents.length }) + '\n');
" PENDING_AGENTS_JSON='...' CLAUDE_MCP_PATH="$CLAUDE_MCP_PATH"
```

### Step 3d: Write auth_type to nf.json for all pending agents

After writing mcpServers entries, synchronize `auth_type` from `providers.json` to `~/.claude/nf.json` `agent_config` for each pending agent. This ensures correct T1/T2 tiered dispatch (FALLBACK-01) by classifying each slot as `sub` (subscription CLI) or `api` (ccr-routed API).

```bash
node -e "
const fs = require('fs');
const path = require('path');
const os = require('os');

// Resolve nForma install dir from this script's installed location
const nfBinDir = path.join(os.homedir(), '.claude', 'nf-bin');
const providersPath = path.join(path.dirname(nfBinDir), 'nf', 'bin', 'providers.json');
const providersData = JSON.parse(fs.readFileSync(providersPath, 'utf8'));
const providerMap = {};
for (const p of (providersData.providers || [])) {
  providerMap[p.name] = p;
}

const nfPath = path.join(os.homedir(), '.claude', 'nf.json');
let nfCfg = {};
try { nfCfg = JSON.parse(fs.readFileSync(nfPath, 'utf8')); } catch(e) {}
const agentConfig = nfCfg.agent_config || {};

const selectedSlots = JSON.parse(process.env.SELECTED_SLOTS_JSON || '[]');
for (const slot of selectedSlots) {
  const provider = providerMap[slot];
  if (!agentConfig[slot]) agentConfig[slot] = {};
  agentConfig[slot].auth_type = provider ? provider.auth_type : 'api';
}

nfCfg.agent_config = agentConfig;
fs.writeFileSync(nfPath, JSON.stringify(nfCfg, null, 2) + '\n');
console.log('auth_type written for: ' + selectedSlots.join(', '));
" SELECTED_SLOTS_JSON='[list of pending agent names as JSON array]'
```

The `SELECTED_SLOTS_JSON` value comes from the pending batch built in Steps 2a-2c. Pass all agent names that were configured (not skipped) as a JSON array string.

### Step 3e: Sync secrets store secrets to env blocks

```bash
node -e "
const { syncToClaudeJson, SERVICE } = require('~/.claude/nf-bin/secrets.cjs');
syncToClaudeJson(SERVICE)
  .then(() => process.stdout.write('synced\n'))
  .catch(e => process.stderr.write('sync warning: ' + e.message + '\n'));
"
```

### Step 3f: Restart each configured agent (sequential — one at a time)

For each agent in the pending batch:

Invoke `/nf:mcp-restart {agent-name}`.

If restart fails or times out, leave config in written state and display:

```
⚠ {agent-name}: restart failed. Config was written — agent will reload on next Claude Code restart.
  Manual retry: /nf:mcp-restart {agent-name}
```

### Step 3g: Closing summary

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► SETUP COMPLETE ✓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Changes applied and agents restarted.

  ✓ {agent-name} — restarted
  [repeat for each successfully restarted agent]

  ○ {agent-name} — skipped (run /nf:mcp-setup to configure later)
  [repeat for each skipped agent]

Run /nf:mcp-status to verify agent health.
```

**Utility tools available during setup:**
- `node bin/set-secret.cjs <agent-name> <key>` — CLI secret setter (wraps secrets.cjs secrets store integration)
- `node bin/gh-account-rotate.cjs` — Rotate gh auth accounts for copilot slots (useful when setting up copilot-1 agent)

---

## Re-run Agent Menu

### Sync auth_type from providers.json

Before displaying the agent roster, synchronize `auth_type` from `providers.json` to `~/.claude/nf.json` for all currently configured agents. This ensures correct `[sub]` vs `[key]` badge display and fixes T1/T2 tiering for existing installations that were set up before `auth_type` was added to `providers.json`.

```bash
node -e "
const fs = require('fs');
const path = require('path');
const os = require('os');

// Read providers.json for auth_type lookup
const providersPath = path.join(os.homedir(), '.claude', 'nf', 'bin', 'providers.json');
const providersData = JSON.parse(fs.readFileSync(providersPath, 'utf8'));
const providerMap = {};
for (const p of (providersData.providers || [])) {
  providerMap[p.name] = p;
}

// Read ~/.claude.json to find all configured agents
let claudeJson = {};
try {
  claudeJson = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
} catch(e) {}
const configuredSlots = Object.keys(claudeJson.mcpServers || {});

// Read existing nf.json
const nfPath = path.join(os.homedir(), '.claude', 'nf.json');
let nfCfg = {};
try { nfCfg = JSON.parse(fs.readFileSync(nfPath, 'utf8')); } catch(e) {}
const agentConfig = nfCfg.agent_config || {};

let updated = 0;
for (const slot of configuredSlots) {
  const provider = providerMap[slot];
  if (provider && provider.auth_type) {
    if (!agentConfig[slot]) agentConfig[slot] = {};
    if (agentConfig[slot].auth_type !== provider.auth_type) {
      agentConfig[slot].auth_type = provider.auth_type;
      updated++;
    }
  }
}

if (updated > 0) {
  nfCfg.agent_config = agentConfig;
  fs.writeFileSync(nfPath, JSON.stringify(nfCfg, null, 2) + '\n');
  console.log('auth_type synced for ' + updated + ' slot(s) from providers.json');
} else {
  console.log('auth_type already up-to-date for all configured slots');
}
"
```

### Read agent roster

Read the current agent roster from `~/.claude.json`:

```bash
ROSTER=$(node -e "
const fs   = require('fs');
const path = require('path');
const os   = require('os');

(async () => {
  let claudeJson = {};
  try {
    claudeJson = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
  } catch (e) {}

  const servers = claudeJson.mcpServers || {};
  const agents = [];

  for (const [name, cfg] of Object.entries(servers)) {
    const env      = cfg.env || {};
    const model    = env.CLAUDE_DEFAULT_MODEL || '—';
    const provider = env.ANTHROPIC_BASE_URL   || '—';

    let keyStatus = 'no key';
    try {
      const { get, SERVICE } = require('~/.claude/nf-bin/secrets.cjs');
      const keyName = 'ANTHROPIC_API_KEY_' + name.toUpperCase().replace(/-/g,'_');
      const stored  = await get(SERVICE, keyName);
      keyStatus = stored ? 'key stored' : (env.ANTHROPIC_API_KEY ? 'key in env' : 'no key');
    } catch (e) {
      keyStatus = env.ANTHROPIC_API_KEY ? 'key in env' : 'no key';
    }

    agents.push({ name, model, provider, keyStatus });
  }

  process.stdout.write(JSON.stringify({ agents }) + '\n');
})();
")
```

Parse ROSTER for `agents` array.

Display re-run banner:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► MCP SETUP — AGENT ROSTER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Render a numbered table with columns: #, Agent, Model, Provider, Key:

```
#   Agent                Model                       Provider                               Key
──  ───────────────────  ──────────────────────────  ─────────────────────────────────────  ──────────
1   ccr-1                MiniMaxAI/MiniMax-M2.5      https://api.together.xyz/v1            key stored
2   ccr-2                Qwen/Qwen3.5-397B-A17B      https://api.together.xyz/v1            no key
```

Use AskUserQuestion:
- header: "Select Agent"
- question: "Enter the number of the agent to configure, or choose an option:"
- options:
  - "1 — {agent-name}" (one per agent)
  - "Add new agent"
  - "Edit Quorum Composition"
  - "Exit"

If "Exit": display "No changes made." Stop.

If "Edit Quorum Composition": route to **Composition Screen** section below.

If "Add new agent":

**Step A — Select agent template**

First, detect which servers are already configured in `~/.claude.json`:

```bash
EXISTING_SERVERS=$(node -e "
const fs = require('fs'), os = require('os');
try {
  const cj = JSON.parse(fs.readFileSync(os.homedir() + '/.claude.json', 'utf8'));
  console.log(JSON.stringify(Object.keys(cj.mcpServers || {})));
} catch(e) { console.log('[]'); }
")
```

Parse `EXISTING_SERVERS` as a JSON array. Use this array to filter the options below.

Then use AskUserQuestion with two sections of options:

- header: "Add Agent — Select Template"
- question: "Select an agent template to add:\n\n(Agents already configured are excluded)"
- options — build the list using these filtering rules:
  - **CCR slots** (omit if agent name already in EXISTING_SERVERS):
    - "1 — ccr-1 (Together.xyz, MiniMax-M2.5)"
    - "2 — ccr-2 (Together.xyz, Qwen3.5-397B)"
    - "3 — ccr-3 (Together.xyz, Qwen3-Coder-480B)"
    - "4 — ccr-4 (Together.xyz, Kimi-K2.5)"
    - "5 — ccr-5 (Together.xyz, gpt-oss-120b)"
    - "6 — ccr-6 (Together.xyz, GLM-5.1)"
  - **Native CLI second slots** (omit if second slot already in EXISTING_SERVERS OR if first slot NOT in EXISTING_SERVERS):
    - "7 — codex-cli-2 (second Codex slot — copies codex-cli-1 config)" [show only if codex-cli-1 is in EXISTING_SERVERS AND codex-cli-2 is NOT in EXISTING_SERVERS]
    - "8 — gemini-cli-2 (second Gemini slot — copies gemini-cli-1 config)" [show only if gemini-cli-1 is in EXISTING_SERVERS AND gemini-cli-2 is NOT in EXISTING_SERVERS]
    - "9 — copilot-2 (second Copilot slot — copies copilot-1 config)" [show only if copilot-1 is in EXISTING_SERVERS AND copilot-2 is NOT in EXISTING_SERVERS]
  - "Cancel — back to roster"

If "Cancel — back to roster": display "No changes made." Return to roster display.

**Resolver — map selection to slot details:**

CCR slot resolver (options 1–6):
- "1 — ccr-1…" → agentName=`ccr-1`, provider=`Together.xyz`, baseUrl=`https://api.together.xyz/v1`, model=`MiniMaxAI/MiniMax-M2.5`
- "2 — ccr-2…" → agentName=`ccr-2`, provider=`Together.xyz`, baseUrl=`https://api.together.xyz/v1`, model=`Qwen/Qwen3.5-397B-A17B`
- "3 — ccr-3…" → agentName=`ccr-3`, provider=`Together.xyz`, baseUrl=`https://api.together.xyz/v1`, model=`Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8`
- "4 — ccr-4…" → agentName=`ccr-4`, provider=`Together.xyz`, baseUrl=`https://api.together.xyz/v1`, model=`moonshotai/Kimi-K2.5`
- "5 — ccr-5…" → agentName=`ccr-5`, provider=`Together.xyz`, baseUrl=`https://api.together.xyz/v1`, model=`openai/gpt-oss-120b`
- "6 — ccr-6…" → agentName=`ccr-6`, provider=`Together.xyz`, baseUrl=`https://api.together.xyz/v1`, model=`zai-org/GLM-5.1`

→ When options 1–6 selected: continue to Step B (API key collection) as before.

Native CLI second-slot resolver (options 7–9):
- "7 — codex-cli-2…" → newSlot=`codex-cli-2`, sourceSlot=`codex-cli-1`
- "8 — gemini-cli-2…" → newSlot=`gemini-cli-2`, sourceSlot=`gemini-cli-1`
- "9 — copilot-2…" → newSlot=`copilot-2`, sourceSlot=`copilot-1`

→ When options 7–9 selected: route to **Step B-native** below (skip the API key step).

**Step B — Collect API key (claude-mcp-server slots only)**

Use AskUserQuestion:
- header: "API Key — {agent-name}"
- question: `"Enter your {provider-name} API key.\n\nThe key will be stored in your secrets store (secrets store). It will not appear in any log or plain-text file."`
- options:
  - "Continue (I have my key ready)"
  - "Cancel"

If "Cancel": display "No changes made." Return to roster display.

If "Continue": second AskUserQuestion:
- header: "Enter API Key — {agent-name}"
- question: `"Paste the API key for {agent-name} ({provider-name}):"`
- options:
  - "Confirm key"
  - "Cancel"

If "Cancel": display "No changes made." Return to roster display.

Store the key using bin/secrets.cjs (agent name and key passed via env vars — never interpolated):

```bash
KEY_RESULT=$(node -e "
const { set, SERVICE } = require('~/.claude/nf-bin/secrets.cjs');
const agentKey = process.env.AGENT_KEY;
const apiKey   = process.env.API_KEY;
(async () => {
  try {
    const keyName = 'ANTHROPIC_API_KEY_' + agentKey.toUpperCase().replace(/-/g,'_');
    await set(SERVICE, keyName, apiKey);
    process.stdout.write(JSON.stringify({ stored: true, method: 'secrets store', keyName }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ stored: false, error: e.message }) + '\n');
  }
})();
" AGENT_KEY="{agent-name}" API_KEY="{user-key}")
```

Parse KEY_RESULT:
- `stored: true` — proceed to Step C
- `stored: false` — secrets store unavailable fallback:

  Use AskUserQuestion:
  - header: "Keychain Unavailable"
  - question: "System keychain unavailable. API key will be stored unencrypted in ~/.claude.json (less secure). Confirm?\n\nLinux users: sudo apt install libsecret-1-dev gnome-keyring"
  - options:
    - "Store unencrypted in ~/.claude.json (less secure)"
    - "Cancel — back to roster"

  If "Cancel — back to roster": display "No changes made." Return to roster display.

  If "Store unencrypted in ~/.claude.json (less secure)": write audit log then mark agent as `method: env_block` in pending changes and proceed to Step C:
  ```bash
  mkdir -p ~/.claude/debug
  node -e "
  const fs = require('fs');
  const ts = new Date().toISOString();
  const msg = ts + ' nForma mcp-setup: secrets store unavailable for ' + process.env.AGENT_KEY + ' — API key stored unencrypted in env block\n';
  fs.appendFileSync(require('os').homedir() + '/.claude/debug/mcp-setup-audit.log', msg);
  " AGENT_KEY="{agent-name}"
  ```

**Step C — Confirm + apply**

Show pending summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► REVIEW PENDING CHANGES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ◆ {agent-name}  →  {provider-name}  ({base-url})
    Key: {stored in secrets store | stored in env block (unencrypted)}
```

Use AskUserQuestion:
- header: "Add Agent"
- question: "Add {agent-name} to ~/.claude.json and start it?"
- options:
  - "Add and start"
  - "Cancel — discard changes"

If "Cancel — discard changes": display "Changes discarded." Return to roster display.

If "Add and start":

1. Backup ~/.claude.json:
```bash
cp ~/.claude.json ~/.claude.json.backup-$(date +%Y-%m-%d-%H%M%S) 2>/dev/null || true
```

2. Resolve claude-mcp-server path (read from existing entries, then npm root fallback):
```bash
CLAUDE_MCP_PATH=$(node -e "
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { spawnSync } = require('child_process');

// Strategy 1: read from existing ~/.claude.json entries
try {
  const cj = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
  for (const [, cfg] of Object.entries(cj.mcpServers || {})) {
    if ((cfg.args || []).some(a => String(a).includes('claude-mcp-server'))) {
      process.stdout.write(cfg.args[0]);
      process.exit(0);
    }
  }
} catch (e) {}

// Strategy 2: check global npm root
try {
  const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  const npmRoot = (r.stdout || '').trim();
  const candidate = path.join(npmRoot, 'claude-mcp-server', 'dist', 'index.js');
  if (fs.existsSync(candidate)) { process.stdout.write(candidate); process.exit(0); }
} catch (e) {}

process.stdout.write('');
" 2>/dev/null)
```

If `CLAUDE_MCP_PATH` is empty: display warning and use placeholder args `["claude-mcp-server"]` (command: `"node"`).

3. Write new mcpServers entry via inline node (all values passed via env vars — never interpolated):
```bash
node -e "
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const claudeJsonPath = path.join(os.homedir(), '.claude.json');
let claudeJson = {};
try { claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch (e) {}
if (!claudeJson.mcpServers) claudeJson.mcpServers = {};
const agentName = process.env.AGENT_NAME;
const baseUrl   = process.env.BASE_URL;
const model     = process.env.MODEL;
const mcpPath   = process.env.MCP_PATH;
const apiKey    = process.env.API_KEY_ENV || '';
claudeJson.mcpServers[agentName] = {
  command: 'node',
  args: [mcpPath],
  env: {
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_BASE_URL: baseUrl,
    CLAUDE_DEFAULT_MODEL: model
  }
};
fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
process.stdout.write(JSON.stringify({ written: true }) + '\n');
" AGENT_NAME="{agent-name}" BASE_URL="{base-url}" MODEL="{model}" MCP_PATH="$CLAUDE_MCP_PATH" API_KEY_ENV="{api-key-if-env-block-method}"
```

4. Sync secrets store secrets to ~/.claude.json:
```bash
node -e "
const { syncToClaudeJson, SERVICE } = require('~/.claude/nf-bin/secrets.cjs');
syncToClaudeJson(SERVICE).then(() => process.stdout.write('synced\n')).catch(e => process.stderr.write(e.message + '\n'));
"
```

5. Invoke `/nf:mcp-restart {agent-name}` to start the new agent process.

**Step D — Identity ping (AGENT-03)**

After restart, display: `"◆ Waiting for {agent-name} to start... calling identity tool"`

Invoke the `identity` tool on the newly started agent. Display the result:

If identity responds:
```
✓ Agent added and verified live.

  ✓ {agent-name} — added, restarted, identity confirmed
    Name:    {identity.name}
    Version: {identity.version}
    Model:   {identity.model}

Run /nf:mcp-status to see full agent roster.
```

If identity times out or errors:
```
✓ Agent added and restarted.

  ◆ {agent-name} — added, restarted (identity ping timed out — agent may need a moment to start)

Run /nf:mcp-status to verify agent health.
```

**Return path:** If this add-slot flow was entered from the Composition Screen (via "Add new slot"), return to Composition Screen after identity ping. Otherwise, return to roster display (re-read roster to show new agent).

---

**Step B-native — Add Native CLI Slot (options 6–9 from Step A)**

This branch is entered when the user selected a native CLI second slot (options 6–9) in Step A. At this point `newSlot` and `sourceSlot` are set from the resolver.

Show a confirmation screen:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► REVIEW PENDING CHANGES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ◆ {new-slot-name}  →  copied from {source-slot-name}
    Binary: {path from source slot}
    Auth: uses {source-slot-name}'s existing credentials
    quorum_active: will be appended
```

Use AskUserQuestion:
- header: "Add Native CLI Slot"
- question: "Add {new-slot-name} to ~/.claude.json and quorum_active?"
- options:
  - "Add and start"
  - "Cancel — discard changes"

If "Cancel — discard changes": display "Changes discarded." Return to roster display.

If "Add and start":

1. Backup `~/.claude.json`:
```bash
cp ~/.claude.json ~/.claude.json.backup-$(date +%Y-%m-%d-%H%M%S) 2>/dev/null || true
```

2. Copy mcpServers entry from source slot to new slot (deep copy — command, args, env all preserved):
```bash
node -e "
const fs   = require('fs');
const os   = require('os');
const claudeJsonPath = os.homedir() + '/.claude.json';
let cj = {};
try { cj = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch(e) {}
const srcSlot = process.env.SOURCE_SLOT;
const newSlot = process.env.NEW_SLOT;
const src = (cj.mcpServers || {})[srcSlot];
if (!src) { process.stdout.write(JSON.stringify({ written: false, error: 'source slot not found' }) + '\n'); process.exit(1); }
cj.mcpServers = cj.mcpServers || {};
cj.mcpServers[newSlot] = JSON.parse(JSON.stringify(src)); // deep copy
fs.writeFileSync(claudeJsonPath, JSON.stringify(cj, null, 2));
process.stdout.write(JSON.stringify({ written: true, newSlot, sourceSlot: srcSlot }) + '\n');
" SOURCE_SLOT="{source-slot-name}" NEW_SLOT="{new-slot-name}"
```

If `written: false`: display error and return to roster.

3. Append new slot to `quorum_active` in `~/.claude/nf.json`:
```bash
node -e "
const fs = require('fs'), os = require('os');
const nfPath = os.homedir() + '/.claude/nf.json';
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(nfPath, 'utf8')); } catch(e) {}
const active = Array.isArray(cfg.quorum_active) ? cfg.quorum_active : [];
const newSlot = process.env.NEW_SLOT;
if (!active.includes(newSlot)) {
  cfg.quorum_active = [...active, newSlot];
  fs.writeFileSync(nfPath, JSON.stringify(cfg, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ added: true, slot: newSlot }) + '\n');
} else {
  process.stdout.write(JSON.stringify({ added: false, slot: newSlot, reason: 'already present' }) + '\n');
}
" NEW_SLOT="{new-slot-name}"
```

4. Invoke `/nf:mcp-restart {new-slot-name}` to start the new agent process.

**Step D — Identity ping** (same as claude-mcp-server path):

After restart, display: `"◆ Waiting for {new-slot-name} to start... calling identity tool"`

Invoke the `identity` tool on the newly started agent. Display the result:

If identity responds:
```
✓ Agent added and verified live.

  ✓ {new-slot-name} — added, restarted, identity confirmed
    Name:    {identity.name}
    Version: {identity.version}
    Model:   {identity.model}

Run /nf:mcp-status to see full agent roster.
```

If identity times out or errors:
```
✓ Agent added and restarted.

  ◆ {new-slot-name} — added, restarted (identity ping timed out — agent may need a moment to start)

Run /nf:mcp-status to verify agent health.
```

**Return path:** If this add-slot flow was entered from the Composition Screen (via "Add new slot"), return to Composition Screen after identity ping. Otherwise, return to roster display (re-read roster to show new agent).

---

If agent selected: continue to Agent Sub-Menu.

---

## Composition Screen

This screen is entered when the user selects "Edit Quorum Composition" from the re-run menu. It shows all configured slots with their current `quorum_active` status and allows toggling.

**Step CS-1: Read slots and quorum_active**

```bash
COMPOSITION_DATA=$(node -e "
const fs = require('fs'), os = require('os');
let slots = [];
let active = [];
try {
  const cj = JSON.parse(fs.readFileSync(os.homedir() + '/.claude.json', 'utf8'));
  slots = Object.keys(cj.mcpServers || {});
} catch(e) {}
try {
  const nfCfg = JSON.parse(fs.readFileSync(os.homedir() + '/.claude/nf.json', 'utf8'));
  active = Array.isArray(nf.quorum_active) ? nf.quorum_active : [];
} catch(e) {}
process.stdout.write(JSON.stringify({ slots, active }) + '\n');
")
```

Parse `COMPOSITION_DATA` for `slots` (array of all slot names from `~/.claude.json`) and `active` (current `quorum_active` array from `~/.claude/nf.json`).

**Step CS-2: Display composition table**

Display banner:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► QUORUM COMPOSITION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Render a numbered table. Status rules:
- If `active` is **empty**: show `● ON (all)` for every slot — fail-open mode means all slots participate
- If `active` is **non-empty** AND slot IS in `active`: show `● ON`
- If `active` is **non-empty** AND slot NOT in `active`: show `○ OFF`

```
#   Slot              Status
──  ────────────────  ──────
1   codex-cli-1       ● ON
2   gemini-cli-1      ● ON
3   opencode-1        ○ OFF
4   copilot-1         ● ON
```

If `active` is empty, display a note below the table:

```
ℹ  quorum_active is empty — all slots participate (fail-open mode)
```

**Step CS-3: AskUserQuestion for composition actions**

Initialize `PENDING_ACTIVE` as a copy of `active` (in-memory working array).

Use AskUserQuestion:
- header: "Quorum Composition"
- question: "Enter slot number to toggle ON/OFF, or choose an option:"
- options:
  - "1 — {slot-name} [{current PENDING_ACTIVE status}]" (one per slot — show ● ON or ○ OFF based on current PENDING_ACTIVE state)
  - "Apply — save changes to nf.json"
  - "Add new slot — add a slot to ~/.claude.json and quorum_active"
  - "Cancel — discard changes"

**Toggle handler:** When user selects slot number N:

- If slot IS currently in `PENDING_ACTIVE`:
  - If `PENDING_ACTIVE.length === 1` (removing would empty the array): use a second AskUserQuestion to warn: "Removing this slot will leave quorum_active empty — all slots will participate (fail-open). Continue?" with options "Yes — set fail-open mode" / "Cancel". If confirmed: set `PENDING_ACTIVE = []`. If cancelled: no change.
  - Otherwise: remove slot from `PENDING_ACTIVE` → status becomes `○ OFF`
- If slot is NOT in `PENDING_ACTIVE` AND `PENDING_ACTIVE` is **non-empty**: add slot to `PENDING_ACTIVE` → status becomes `● ON`
- If slot is NOT in `PENDING_ACTIVE` AND `PENDING_ACTIVE` is **empty**: `PENDING_ACTIVE = [slot]` (switching from fail-open to explicit single-slot list — slot becomes `● ON`, others become `○ OFF`)

Re-display the AskUserQuestion with updated statuses after each toggle.

**Apply handler:** When "Apply" selected:

```bash
node -e "
const fs = require('fs'), os = require('os');
const nfPath = os.homedir() + '/.claude/nf.json';
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(nfPath, 'utf8')); } catch(e) {}
cfg.quorum_active = JSON.parse(process.env.PENDING_ACTIVE);
fs.writeFileSync(nfPath, JSON.stringify(cfg, null, 2) + '\n');
process.stdout.write(JSON.stringify({ written: true, count: cfg.quorum_active.length }) + '\n');
" PENDING_ACTIVE="{JSON.stringify(PENDING_ACTIVE)}"
```

If `written: true`: display:

```
✓ quorum_active updated — {N} slot(s) active.

  Changes take effect on next quorum call (no restart required).
```

Return to roster display.

If error: display error message and return to roster.

**Add new slot handler:** When "Add new slot" selected:

Route to **Step A** (EXISTING_SERVERS detection + template selection). This is the same flow as "Add new agent" from the roster menu. After Step D (identity ping) completes:

- Return to **Composition Screen** (re-read fresh `slots` and `active` data from disk).
- The newly added slot will appear in the table with ● ON status (it was added to `quorum_active` during the Step B or Step B-native apply flow).
- Re-display the Composition Screen AskUserQuestion.

**Cancel handler:** When "Cancel" selected:

Display "No changes made." Return to roster display.

---

## Agent Sub-Menu

**Determine agent type** before displaying the menu. Read `~/.claude/nf.json` → `agent_config[{agent-name}].auth_type`. If not found, check `providers.json` for the slot's `auth_type` field. Classify:
- `auth_type === "sub"` → **CLI agent** (codex, gemini, opencode, copilot)
- `auth_type === "api"` or missing → **API agent** (claude-mcp-server instances)

Display agent detail banner:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► {agent-name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Type:     {CLI agent | API agent}
  Model:    {model}
  Provider: {provider}
  Key:      {keyStatus}   ← omit for CLI agents
```

**If CLI agent** (`auth_type === "sub"`), use AskUserQuestion:
- header: "Actions — {agent-name}"
- question: "Choose an action:"
- options:
  - "1 — Re-authenticate (login)"
  - "2 — Restart agent"
  - "3 — Edit model / timeout"
  - "4 — Remove agent"
  - "Back — return to agent list"

**If API agent** (`auth_type === "api"` or missing), use AskUserQuestion:
- header: "Actions — {agent-name}"
- question: "Choose an action:"
- options:
  - "1 — Set / update API key"
  - "2 — Swap provider"
  - "3 — Remove agent"
  - "Back — return to agent list"

### CLI Agent Actions

**CLI Option 1 — Re-authenticate (login):**

Determine the CLI binary name from `providers.json` for this slot (e.g., `codex`, `gemini`, `opencode`, `copilot`).

Display:
```
Running {cli} login...
```

```bash
{cli} login 2>&1 || echo "Login command failed or not supported for {cli}"
```

Display the command output. Return to Agent Sub-Menu.

**CLI Option 2 — Restart agent:**

Use `/nf:mcp-restart {agent-name}` to restart the MCP server process for this slot.

Display: `"✓ Restarted {agent-name}"`

Return to Agent Sub-Menu.

**CLI Option 3 — Edit model / timeout:**

Read current values from `~/.claude/nf.json` → `agent_config[{agent-name}]` and `providers.json`.

Use AskUserQuestion:
- header: "Edit — {agent-name}"
- question: "Which field?"
- options:
  - "Model — current: {model or '(not set)'}"
  - "Timeout — current: {timeout or '180000'}ms"
  - "Back — return to agent menu"

If "Model": prompt for new model name, update `providers.json` entry's `model` field.
If "Timeout": prompt for new timeout value, update `providers.json` entry's `quorum_timeout_ms` field.

Return to Agent Sub-Menu after each edit.

**CLI Option 4 — Remove agent:** Same as API Option 3 below.

### API Agent Actions

**Option 1 — Set / update API key:**

**Step A — Check existing key status**

Run an inline node script to check whether a key is already stored in secrets store for the selected agent:

```bash
KEY_CHECK_RESULT=$(node -e "
const { get, SERVICE } = require('~/.claude/nf-bin/secrets.cjs');
(async () => {
  try {
    const agentName = process.env.AGENT_NAME;
    const keyName   = 'ANTHROPIC_API_KEY_' + agentName.toUpperCase().replace(/-/g,'_');
    const stored    = await get(SERVICE, keyName);
    if (stored) {
      process.stdout.write(JSON.stringify({ hasKey: true, method: 'secrets store' }) + '\n');
    } else {
      // Check env block fallback
      const fs = require('fs'), path = require('path'), os = require('os');
      let envVal = '';
      try {
        const cj = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
        envVal = (cj.mcpServers && cj.mcpServers[agentName] && cj.mcpServers[agentName].env && cj.mcpServers[agentName].env.ANTHROPIC_API_KEY) || '';
      } catch (e) {}
      if (envVal) {
        process.stdout.write(JSON.stringify({ hasKey: true, method: 'env_block' }) + '\n');
      } else {
        process.stdout.write(JSON.stringify({ hasKey: false, method: 'none' }) + '\n');
      }
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ hasKey: false, method: 'none', error: e.message }) + '\n');
  }
})();
" AGENT_NAME="{agent-name}")
```

Parse KEY_CHECK_RESULT for: `hasKey` (boolean), `method` ('secrets store'|'env_block'|'none').

**Step B — Prompt user with key-status hint**

Use AskUserQuestion:
- header: "Set API Key — {agent-name}"
- question: one of:
  - If `hasKey` is true and `method` is `secrets store`: `"API key already stored in secrets store (key stored). Enter a new key to overwrite it, or skip.\n\nThe key will be stored in your secrets store (secrets store). It will not appear in any log or plain-text file."`
  - If `method` is `env_block`: `"API key currently stored in ~/.claude.json env block. Enter a new key to move it to the secrets store, or skip.\n\nThe key will be stored in your secrets store (secrets store). It will not appear in any log or plain-text file."`
  - If `method` is `none`: `"No API key configured for {agent-name}. Enter a key to store it in your secrets store.\n\nThe key will be stored in your secrets store (secrets store). It will not appear in any log or plain-text file."`
- options:
  - "Continue (I have my key ready)"
  - "Skip — back to agent menu"

If "Skip — back to agent menu": display "No changes made." Return to Agent Sub-Menu (re-display sub-menu for the same agent).

**Step C — Collect the key value**

Use a second AskUserQuestion to receive the actual key:
- header: "Enter API Key — {agent-name}"
- question: `"Paste your API key for {agent-name}:"`
- options:
  - "Confirm key"
  - "Cancel"

If "Cancel": display "No changes made." Return to Agent Sub-Menu.

**Step D — Store in secrets store**

Run inline node script using `set()` from `bin/secrets.cjs`. Pass key via environment variable only — never interpolate into the script body:

```bash
KEY_STORE_RESULT=$(node -e "
const { set, SERVICE } = require('~/.claude/nf-bin/secrets.cjs');
(async () => {
  try {
    const agentName = process.env.AGENT_NAME;
    const apiKey    = process.env.API_KEY;
    const keyName   = 'ANTHROPIC_API_KEY_' + agentName.toUpperCase().replace(/-/g,'_');
    await set(SERVICE, keyName, apiKey);
    process.stdout.write(JSON.stringify({ stored: true, method: 'secrets store', keyName }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ stored: false, error: e.message }) + '\n');
  }
})();
" AGENT_NAME="{agent-name}" API_KEY="{user-entered-key}")
```

Parse KEY_STORE_RESULT:
- `stored: true` — continue to Step E
- `stored: false` — handle secrets store fallback:

  Use AskUserQuestion:
  - header: "Keychain Unavailable"
  - question: "System keychain unavailable. API key will be stored unencrypted in ~/.claude.json (less secure). Confirm?\n\nLinux users: sudo apt install libsecret-1-dev gnome-keyring"
  - options:
    - "Store unencrypted in ~/.claude.json (less secure)"
    - "Skip — back to agent menu"

  If "Skip — back to agent menu": display "No changes made." Return to Agent Sub-Menu.

  If "Store unencrypted in ~/.claude.json (less secure)": write audit log then proceed to Step E with `method: env_block`:
  ```bash
  mkdir -p ~/.claude/debug
  node -e "
  const fs = require('fs');
  const ts = new Date().toISOString();
  const msg = ts + ' nForma mcp-setup: secrets store unavailable for ' + process.env.AGENT_KEY + ' — API key stored unencrypted in env block\n';
  fs.appendFileSync(require('os').homedir() + '/.claude/debug/mcp-setup-audit.log', msg);
  " AGENT_KEY="{agent-name}"
  ```

**Step E — Confirm + apply**

Show pending summary using the existing "Confirm + Apply + Restart Flow" pattern:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► REVIEW PENDING CHANGES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ◆ {agent-name} — API key updated (stored in secrets store)
```

Use AskUserQuestion:
- header: "Apply Key Change"
- question: "Apply key change to ~/.claude.json and restart {agent-name}?"
- options:
  - "Apply and restart"
  - "Cancel — discard changes"

If "Cancel — discard changes": display "Changes discarded." Return to Agent Sub-Menu.

If "Apply and restart":

1. Backup ~/.claude.json:
```bash
cp ~/.claude.json ~/.claude.json.backup-$(date +%Y-%m-%d-%H%M%S) 2>/dev/null || true
```

2. Patch ANTHROPIC_API_KEY in the agent's env block. Pass key via environment variable only — never interpolate the value into the script body:
```bash
node -e "
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const claudeJsonPath = path.join(os.homedir(), '.claude.json');
let claudeJson = {};
try { claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch (e) {}
const agentName = process.env.AGENT_NAME;
const apiKey    = process.env.API_KEY;
if (claudeJson.mcpServers && claudeJson.mcpServers[agentName]) {
  if (!claudeJson.mcpServers[agentName].env) claudeJson.mcpServers[agentName].env = {};
  claudeJson.mcpServers[agentName].env.ANTHROPIC_API_KEY = apiKey;
}
fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
process.stdout.write(JSON.stringify({ written: true }) + '\n');
" AGENT_NAME="{agent-name}" API_KEY="{user-entered-key}"
```

3. Sync all secrets store secrets back to ~/.claude.json:
```bash
node -e "
const { syncToClaudeJson, SERVICE } = require('~/.claude/nf-bin/secrets.cjs');
syncToClaudeJson(SERVICE).then(() => process.stdout.write('synced\n')).catch(e => process.stderr.write(e.message + '\n'));
"
```

4. Invoke `/nf:mcp-restart {agent-name}` (sequential). If restart fails, leave config written and display:
```
⚠ {agent-name}: restart failed. Config applied — reload on next Claude Code restart.
  Manual retry: /nf:mcp-restart {agent-name}
```

5. Display:
```
✓ API key updated and agent restarted.

  ✓ {agent-name} — key updated, restarted

Run /nf:mcp-status to verify agent health.
```

Return to Agent Sub-Menu (user can make further changes or go Back).

**Option 2 — Swap provider:**

**Step A — Show current provider**

Read the agent's current `ANTHROPIC_BASE_URL` from `~/.claude.json`:

```bash
CURRENT_PROVIDER=$(node -e "
const fs = require('fs'), path = require('path'), os = require('os');
let url = '—';
try {
  const cj = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
  url = (cj.mcpServers && cj.mcpServers[process.env.AGENT_NAME] && cj.mcpServers[process.env.AGENT_NAME].env && cj.mcpServers[process.env.AGENT_NAME].env.ANTHROPIC_BASE_URL) || '—';
} catch (e) {}
process.stdout.write(url + '\n');
" AGENT_NAME="{agent-name}")
```

Map the raw URL to a friendly provider name for display:
- `https://api.akashml.com/v1` → `AkashML`
- `https://api.together.xyz/v1` → `Together.xyz`
- `https://api.fireworks.ai/inference/v1` → `Fireworks`
- anything else → the raw URL value

**Step B — Prompt user with provider selection**

Use AskUserQuestion:
- header: "Swap Provider — {agent-name}"
- question: `"Current provider: {friendly-provider-name}\n\nSelect a new provider for {agent-name}:"`
- options:
  - "1 — AkashML (https://api.akashml.com/v1)"
  - "2 — Together.xyz (https://api.together.xyz/v1)"
  - "3 — Fireworks (https://api.fireworks.ai/inference/v1)"
  - "4 — Custom URL"
  - "Skip — back to agent menu"

If "Skip — back to agent menu": display "No changes made." Return to Agent Sub-Menu.

**Step C — Resolve new URL**

For curated selections (1–3): resolve the canonical URL from the selection:
- "1 — AkashML…" → `NEW_URL="https://api.akashml.com/v1"`, `NEW_PROVIDER_NAME="AkashML"`
- "2 — Together.xyz…" → `NEW_URL="https://api.together.xyz/v1"`, `NEW_PROVIDER_NAME="Together.xyz"`
- "3 — Fireworks…" → `NEW_URL="https://api.fireworks.ai/inference/v1"`, `NEW_PROVIDER_NAME="Fireworks"`

For "4 — Custom URL": use a second AskUserQuestion to collect the URL:
- header: "Custom Provider URL — {agent-name}"
- question: `"Enter the full base URL for the custom provider (e.g. https://openrouter.ai/api/v1):"`
- options:
  - "Confirm URL"
  - "Cancel"

If "Cancel": display "No changes made." Return to Agent Sub-Menu.

Store the user-entered value as `NEW_URL` and `NEW_PROVIDER_NAME="custom"`.

**Step D — Confirm + apply**

Show pending summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► REVIEW PENDING CHANGES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ◆ {agent-name} — provider changed to {NEW_PROVIDER_NAME} ({NEW_URL})
```

Use AskUserQuestion:
- header: "Apply Provider Change"
- question: "Apply provider change to ~/.claude.json and restart {agent-name}?"
- options:
  - "Apply and restart"
  - "Cancel — discard changes"

If "Cancel — discard changes": display "Changes discarded." Return to Agent Sub-Menu.

If "Apply and restart":

1. Backup ~/.claude.json:
```bash
cp ~/.claude.json ~/.claude.json.backup-$(date +%Y-%m-%d-%H%M%S) 2>/dev/null || true
```

2. Patch ANTHROPIC_BASE_URL in the agent's env block. Pass the new URL via environment variable — never interpolate into the script body:
```bash
node -e "
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const claudeJsonPath = path.join(os.homedir(), '.claude.json');
let claudeJson = {};
try { claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch (e) {}
const agentName = process.env.AGENT_NAME;
const newUrl    = process.env.NEW_URL;
if (claudeJson.mcpServers && claudeJson.mcpServers[agentName]) {
  if (!claudeJson.mcpServers[agentName].env) claudeJson.mcpServers[agentName].env = {};
  claudeJson.mcpServers[agentName].env.ANTHROPIC_BASE_URL = newUrl;
}
fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
process.stdout.write(JSON.stringify({ written: true }) + '\n');
" AGENT_NAME="{agent-name}" NEW_URL="{new-url}"
```

3. Sync secrets store secrets to ~/.claude.json:
```bash
node -e "
const { syncToClaudeJson, SERVICE } = require('~/.claude/nf-bin/secrets.cjs');
syncToClaudeJson(SERVICE).then(() => process.stdout.write('synced\n')).catch(e => process.stderr.write(e.message + '\n'));
"
```

4. Invoke `/nf:mcp-restart {agent-name}` (sequential). If restart fails, leave config written and display:
```
⚠ {agent-name}: restart failed. Config applied — reload on next Claude Code restart.
  Manual retry: /nf:mcp-restart {agent-name}
```

5. Display:
```
✓ Provider updated and agent restarted.

  ✓ {agent-name} — provider changed to {NEW_PROVIDER_NAME}, restarted

Run /nf:mcp-status to verify agent health.
```

Return to Agent Sub-Menu (user can make further changes or go Back).

**Option 3 — Remove agent:**

**Step A — Confirm removal**

Display removal warning:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► REMOVE AGENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ⚠ This will permanently remove {agent-name} from
    ~/.claude.json. The agent will be deregistered on
    the next Claude Code restart.
```

Use AskUserQuestion:
- header: "Remove Agent — {agent-name}"
- question: `"Remove {agent-name} from ~/.claude.json?\n\nThis deletes the mcpServers entry. The agent process will be deregistered on the next Claude Code restart."`
- options:
  - "Remove agent"
  - "Cancel — back to agent menu"

If "Cancel — back to agent menu": display "No changes made." Return to Agent Sub-Menu.

**Step B — Delete mcpServers entry**

If "Remove agent":

1. Backup ~/.claude.json:
```bash
cp ~/.claude.json ~/.claude.json.backup-$(date +%Y-%m-%d-%H%M%S) 2>/dev/null || true
```

2. Delete the agent's mcpServers entry via inline node (agent name passed via env var — never interpolated):
```bash
node -e "
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const claudeJsonPath = path.join(os.homedir(), '.claude.json');
let claudeJson = {};
try { claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch (e) {}
const agentName = process.env.AGENT_NAME;
if (claudeJson.mcpServers && claudeJson.mcpServers[agentName]) {
  delete claudeJson.mcpServers[agentName];
}
fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
process.stdout.write(JSON.stringify({ removed: true, agent: agentName }) + '\n');
" AGENT_NAME="{agent-name}"
```

3. Display:
```
✓ Agent removed.

  ✓ {agent-name} — removed from ~/.claude.json
    The agent will be deregistered on next Claude Code restart.

Run /nf:mcp-status to verify the updated agent roster.
```

Return to roster display (re-read roster — removed agent no longer appears).

**Option "Back":** Return to Re-run Agent Menu.

---

## Confirm + Apply + Restart Flow

Used by actions that accumulate pending changes in a session.

Display pending summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► REVIEW PENDING CHANGES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ◆ {agent-name} — {description of change}
```

Use AskUserQuestion:
- header: "Apply Changes"
- question: "Apply changes to ~/.claude.json and restart affected agents?"
- options:
  - "Apply and restart"
  - "Cancel — discard changes"

If "Cancel": display "Changes discarded." Return to roster.

If "Apply and restart":

1. Backup:
```bash
cp ~/.claude.json ~/.claude.json.backup-$(date +%Y-%m-%d-%H%M%S) 2>/dev/null || true
```

2. Write changes to `~/.claude.json` (inline node — read current, apply patch, write with 2-space indent).

3. Sync secrets store secrets:
```bash
node -e "
const { syncToClaudeJson, SERVICE } = require('~/.claude/nf-bin/secrets.cjs');
syncToClaudeJson(SERVICE).then(() => process.stdout.write('synced\n')).catch(e => process.stderr.write(e.message + '\n'));
"
```

4. For each affected agent (sequential, one at a time): invoke `/nf:mcp-restart {agent-name}`.

5. Display:
```
✓ Changes applied and agent(s) restarted.

  ✓ {agent-name} — restarted

Run /nf:mcp-status to verify agent health.
```

If a restart fails, leave config written and display:
```
⚠ {agent-name}: restart failed. Config applied — reload on next Claude Code restart.
  Manual retry: /nf:mcp-restart {agent-name}
```

## Utility Scripts Reference

The following scripts are available for advanced configuration tasks:

- **Secret management:** Use `node ~/.claude/nf-bin/set-secret.cjs <KEY_NAME> <value>` (or `node bin/set-secret.cjs`) to store API keys in the OS keychain under the `nforma` service and auto-sync them to `~/.claude.json` env blocks. This is the preferred method for managing secrets outside the interactive flow.

- **GitHub account rotation:** Use `node ~/.claude/nf-bin/gh-account-rotate.cjs` (or `node bin/gh-account-rotate.cjs`) to rotate to the next `gh auth` account. This is used by copilot slots that require OAuth rotation between different GitHub accounts. Only relevant when multiple `gh auth` accounts are configured.

</process>

<success_criteria>
- First-run (no mcpServers): welcome banner + agent template list + key collection (secrets store/fallback) + batch-write + backup + restart + summary
- Re-run (existing entries): numbered agent roster with model/provider/key-status columns
- Sub-menu per agent: full API key set/update flow (Option 1), full provider swap flow (Option 2), full remove-agent flow (Option 3)
- Add-agent flow (roster menu): template select (filtered) → key collection → mcpServers write → syncToClaudeJson → restart → identity ping
- Remove-agent flow (Option 3): confirm → backup → delete mcpServers[agent] entry → write
- Option 1 API key flow: key-status check → "(key stored)" hint → key input → secrets store store → confirm → backup → patch ~/.claude.json → syncToClaudeJson → mcp-restart
- Option 2 provider swap flow: current provider display → curated list (AkashML/Together.xyz/Fireworks) + Custom URL → confirm → backup → patch ANTHROPIC_BASE_URL → mcp-restart
- Confirm+apply+restart: backup then write then sync secrets store then mcp-restart per agent then confirmation
- No changes applied without explicit user confirmation
- Keytar failure: warning + Linux hint + confirmation before env-block fallback + audit log
- Key value never appears in displayed text, log output, or shell history (passed via env var only)
- Edit Quorum Composition flow (WIZ-08): re-run menu option "Edit Quorum Composition" → routes to Composition Screen
- Composition toggle flow (WIZ-09): slot list with ● ON / ○ OFF indicators → toggle updates PENDING_ACTIVE → apply writes quorum_active to ~/.claude/nf.json → no restart required
- Add slot from composition flow (WIZ-10): "Add new slot" → Step A/B/B-native → identity ping → return to Composition Screen showing new slot ● ON
</success_criteria>

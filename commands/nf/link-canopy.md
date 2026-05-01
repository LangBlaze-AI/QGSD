---
name: nf:link-canopy
description: Link nForma with an installed Canopy IDE — import agent config and optionally register quorum agents
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---

<objective>
Discover a local Canopy IDE installation, import its agent and MCP configuration into nForma, and optionally register nForma's quorum agents back into Canopy's user agent registry. All writes require explicit user confirmation.

Three phases:
1. **Discover** — detect Canopy install, read config, display summary
2. **Import** (Path A) — write Canopy's MCP endpoint and agent info into `~/.claude/nf.json`
3. **Register** (Path B, optional) — write nForma quorum agents into Canopy's `userAgentRegistry`
</objective>

<process>

## Step 1: Discover Canopy installation

Run this Bash command and store the output as CANOPY_INFO:

```bash
CANOPY_INFO=$(node << 'NF_EVAL'
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Daintree-first path resolver with canopy-app fallback (issue 138) ──
// Daintree is the renamed product; legacy installs may still use canopy-app paths.
const platform = process.platform;
function resolvePath(productName) {
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', productName, 'config.json');
  if (platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), productName, 'config.json');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), productName, 'config.json');
}
const daintreeConfigPath = resolvePath('Daintree');
const canopyConfigPath = resolvePath('canopy-app');
let configPath = null;
let productName = null;
if (fs.existsSync(daintreeConfigPath)) { configPath = daintreeConfigPath; productName = 'Daintree'; }
else if (fs.existsSync(canopyConfigPath)) { configPath = canopyConfigPath; productName = 'canopy-app'; }
else { configPath = daintreeConfigPath; productName = 'Daintree'; } // for the not-found banner

// MCP and plugins dir: Daintree-first (~/.daintree/...), canopy-app fallback (~/.canopy/...)
const daintreeMcpPath = path.join(os.homedir(), '.daintree', 'mcp.json');
const canopyMcpPath = path.join(os.homedir(), '.canopy', 'mcp.json');
const mcpPath = fs.existsSync(daintreeMcpPath) ? daintreeMcpPath : canopyMcpPath;

const daintreePluginsDir = path.join(os.homedir(), '.daintree', 'plugins');
const canopyPluginsDir = path.join(os.homedir(), '.canopy', 'plugins');
let pluginsDir = canopyPluginsDir;
try { if (fs.statSync(daintreePluginsDir).isDirectory()) pluginsDir = daintreePluginsDir; } catch (e) {}

const result = {
  platform,
  productName,
  configPath,
  daintreeConfigPath,
  canopyConfigPath,
  configExists: false,
  mcpPath,
  mcpExists: false,
  pluginsDir,
  pluginsDirExists: false,
  mcp: null,
  agents: [],
  userAgents: [],
  agentSettings: {},
  customPresets: {},
  globalEnv: {},
  providerTemplates: {}
};

// Check config.json
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  result.configExists = true;

  // Extract built-in agent settings
  if (config.agentSettings && config.agentSettings.agents) {
    result.agentSettings = config.agentSettings.agents;
    result.agents = Object.keys(config.agentSettings.agents);
  }

  // Extract user-defined agents
  if (config.userAgentRegistry) {
    result.userAgents = Object.keys(config.userAgentRegistry);
  }

  // Extract Daintree extended agent settings (issue 138 AC1)
  if (config.agentSettings) {
    result.customPresets = config.agentSettings.customPresets || {};
    result.globalEnv = config.agentSettings.globalEnv || {};
    result.providerTemplates = config.agentSettings.providerTemplates || {};
  }
} catch (e) {
  // config.json not found or unreadable
}

// Check mcp.json
try {
  const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
  result.mcpExists = true;
  // Look up under "daintree" key first, fall back to legacy "canopy"
  if (mcp.mcpServers && (mcp.mcpServers.daintree || mcp.mcpServers.canopy)) {
    result.mcp = mcp.mcpServers.daintree || mcp.mcpServers.canopy;
  }
} catch (e) {
  // mcp.json not found
}

// Check plugins dir
try {
  result.pluginsDirExists = fs.statSync(pluginsDir).isDirectory();
} catch (e) {}

process.stdout.write(JSON.stringify(result) + '\n');
NF_EVAL
)
```

Parse CANOPY_INFO JSON.

**If `configExists` is false:**

Display:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► LINK CANOPY — NOT FOUND
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Daintree (or legacy Canopy) config not found at:
  {daintreeConfigPath}

Also tried legacy path:
  {canopyConfigPath}

Install Daintree IDE and run it once to generate config,
then re-run /nf:link-canopy. Legacy canopy-app installs are
also detected automatically.
```

Stop.

**If `configExists` is true:**

Display discovery banner:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► LINK CANOPY — DISCOVERED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Product:       {productName}     (Daintree, or canopy-app on legacy installs)
  Platform:      {platform}
  Config:        {configPath}
  MCP Server:    {mcp.url or "not configured"}
  Plugins Dir:   {pluginsDir} ({pluginsDirExists ? "exists" : "not created yet"})

  Built-in Agents (selected):
    {comma-separated list of agents where agentSettings[agent].selected === true}

  Built-in Agents (disabled):
    {comma-separated list of agents where agentSettings[agent].selected === false, or "none"}

  User Agents ({userAgents.length}):
    {comma-separated list or "none"}

  Custom Presets ({Object.keys(customPresets).length}):
    {comma-separated list of customPresets keys, or "none"}

  Global Env Keys ({Object.keys(globalEnv).length}):
    {comma-separated list of globalEnv keys, or "none"}

  Provider Templates ({Object.keys(providerTemplates).length}):
    {comma-separated list of providerTemplates keys, or "none"}
```

Continue to Step 2.

---

## Step 2: Import Canopy config into nForma (Path A)

### Step 2a: Import MCP endpoint

If `mcp` is not null (Canopy MCP server is configured):

Use AskUserQuestion:
- header: "MCP"
- question: "Import Canopy's MCP server endpoint into nForma?\n\n  URL:  {mcp.url}\n  Type: {mcp.type}"
- options:
  - "Yes — import MCP endpoint"
  - "No — skip MCP"

Track the user's decision. If "Yes": add to pending import list.

If `mcp` is null: skip this question, display "MCP Server: not configured — skipping."

### Step 2b: Per-agent import decisions

Filter Canopy's agents to only those with `selected: true` in agentSettings. Agents with `selected: false` are disabled in Canopy and should not be offered for import.

For each **selected** agent from the CANOPY_INFO `agentSettings`, use AskUserQuestion:
- header: "{agent-name}"
- question: "Import {agent-name} from Canopy?\n\n  Selected:        {agentSettings[agent].selected}\n  Dangerous mode:  {agentSettings[agent].dangerousEnabled}\n  Inline mode:     {agentSettings[agent].inlineMode}\n  Custom flags:    {agentSettings[agent].customFlags || 'none'}"
- options:
  - "Yes — import"
  - "No — skip"

Collect the user's decisions. Build an `importedAgents` array from "Yes" responses.

### Step 2c: Confirm and write

If no MCP and no agents were selected: display "Import skipped — nothing selected." Continue to Step 3.

Otherwise, display pending summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► REVIEW IMPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Will write to ~/.claude/nf.json:

  {if MCP selected: "◆ MCP endpoint: " + mcp.url}
  {for each importedAgent: "◆ Agent: " + agent-name}
```

Use AskUserQuestion:
- header: "Confirm"
- question: "Write selected Canopy config to ~/.claude/nf.json?"
- options:
  - "Apply"
  - "Cancel — discard"

**If "Cancel":** display "Import cancelled." Continue to Step 3.

**If "Apply":**

Backup nf.json:

```bash
cp ~/.claude/nf.json ~/.claude/nf.json.backup-$(date +%Y-%m-%d-%H%M%S) 2>/dev/null || true
```

Write canopy section to nf.json. Pass all values via environment variables — never interpolate:

```bash
IMPORT_RESULT=$(node << 'NF_EVAL'
const fs = require('fs');
const path = require('path');
const os = require('os');

const nfPath = path.join(os.homedir(), '.claude', 'nf.json');
let nfCfg = {};
try { nfCfg = JSON.parse(fs.readFileSync(nfPath, 'utf8')); } catch(e) {}

const canopyInfo = JSON.parse(process.env.CANOPY_INFO);
const importedAgents = JSON.parse(process.env.IMPORTED_AGENTS_JSON);
const importMcp = process.env.IMPORT_MCP === 'true';

nfCfg.canopy = {
  linked: true,
  linked_at: new Date().toISOString(),
  config_path: canopyInfo.configPath,
  mcp_url: importMcp && canopyInfo.mcp ? canopyInfo.mcp.url : null,
  mcp_type: importMcp && canopyInfo.mcp ? canopyInfo.mcp.type : null,
  agents: importedAgents,
  plugins_dir: canopyInfo.pluginsDir
};

fs.writeFileSync(nfPath, JSON.stringify(nfCfg, null, 2) + '\n');
process.stdout.write(JSON.stringify({ written: true, agentCount: importedAgents.length, hasMcp: importMcp }) + '\n');
NF_EVAL
)
```

The environment variables are:
- `CANOPY_INFO` — raw JSON from Step 1
- `IMPORTED_AGENTS_JSON` — JSON array of selected agent names (e.g., `["claude","gemini","codex"]`)
- `IMPORT_MCP` — `"true"` or `"false"`

Parse IMPORT_RESULT. If `written: true`:

```
✓ Canopy config imported into ~/.claude/nf.json

  {if hasMcp: "MCP URL:  " + mcp.url}
  Agents:   {importedAgents joined by ", "}
```

Continue to Step 3.

---

## Step 3: Register nForma agents in Canopy (Path B — optional)

### Step 3a: Read nForma quorum slots with provider details

Read both `~/.claude.json` (slot names) and `providers.json` (model, provider, auth type) to build a rich slot table. Exclude non-quorum entries (e.g., `canopy` MCP server) by filtering to only slots that appear in providers.json.

```bash
QUORUM_SLOTS=$(node << 'NF_EVAL'
const fs = require('fs');
const path = require('path');
const os = require('os');

// Read ~/.claude.json for configured slots
const claudeJsonPath = path.join(os.homedir(), '.claude.json');
let claudeJson = {};
try { claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch (e) {}
const servers = claudeJson.mcpServers || {};

// Read providers.json for model/provider details
const providersCandidates = [
  path.join(os.homedir(), '.claude', 'nf', 'bin', 'providers.json'),
  path.join(os.homedir(), '.claude', 'nf-bin', 'providers.json'),
];
let providersData = { providers: [] };
for (const p of providersCandidates) {
  try { providersData = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch(e) {}
}
const providerMap = {};
for (const p of providersData.providers) {
  providerMap[p.name] = p;
}

// Build slots with enriched data — only include slots found in providers.json
const slots = [];
for (const [name] of Object.entries(servers)) {
  const provider = providerMap[name];
  if (!provider) continue; // Skip non-quorum entries (e.g., canopy MCP server)
  slots.push({
    name,
    model: provider.model || 'unknown',
    display_provider: provider.display_provider || provider.provider || 'unknown',
    auth_type: provider.auth_type || 'api',
    cli: provider.cli || 'unknown',
    description: provider.description || '',
    type: provider.display_type || provider.type || 'unknown'
  });
}
process.stdout.write(JSON.stringify({ slots, count: slots.length }) + '\n');
NF_EVAL
)
```

Parse QUORUM_SLOTS for `slots` array and `count`.

**If `count` is 0:**

Display:

```
No nForma quorum agents found in ~/.claude.json.
Run /nf:mcp-setup to configure agents first.
```

Continue to Step 4 (closing).

**If `count` > 0:**

Display the slots with full detail:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► REGISTER AGENTS IN CANOPY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

nForma quorum agents found ({count}):

#   Slot              Model                                     Provider        Auth   Type
──  ────────────────  ────────────────────────────────────────  ──────────────  ─────  ──────────────────
1   codex-1           gpt-5.4                                   OpenAI          sub    codex-cli
2   gemini-1          gemini-3-pro-preview                      Google          sub    gemini-cli
3   opencode-1        grok-code-fast-1                          OpenCode        sub    opencode-cli
4   copilot-1         gpt-4.1                                   GitHub          sub    copilot-cli
5   claude-1          claude-opus-4-6                           Anthropic       sub    claude-cli
6   ccr-1             MiniMaxAI/MiniMax-M2.5                    Together.xyz    api    unified-mcp-server
7   ccr-2             Qwen/Qwen3.5-397B-A17B                    Together.xyz    api    unified-mcp-server
8   ccr-3             Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8  Together.xyz    api    unified-mcp-server
9   ccr-4             moonshotai/Kimi-K2.5                      Together.xyz    api    unified-mcp-server
10  ccr-5             openai/gpt-oss-120b                       Together.xyz    api    unified-mcp-server
11  ccr-6             zai-org/GLM-5.1                           Together.xyz    api    unified-mcp-server
```

(Table rows are dynamically generated from the slots data — the above is an example.)

### Step 3b: Per-agent registration decision

Iterate through each slot and ask the user whether to register it. This gives full control over which agents appear in Canopy.

Use AskUserQuestion:
- header: "Register"
- question: "Which agents should be registered in Canopy's user agent registry?\n\nCanopy will show registered agents in its toolbar and agent palette. Requires Canopy restart."
- options:
  - "Register all — add all {count} quorum agents to Canopy"
  - "Pick individually — decide per agent"
  - "Skip — do not register any"

**If "Skip":** display "Registration skipped." Continue to Step 4.

**If "Register all":** mark all slots as selected. Continue to Step 3c.

**If "Pick individually":**

For each slot in order, use AskUserQuestion:
- header: "{slot.name}"
- question: "Register {slot.name} in Canopy?\n\n  Model:    {slot.model}\n  Provider: {slot.display_provider}\n  Auth:     {slot.auth_type}\n  Type:     {slot.type}\n  {slot.description}"
- options:
  - "Yes — register in Canopy"
  - "No — skip this agent"

Collect the user's decision for each slot. Build a `selectedSlots` array from the "Yes" responses.

If no agents were selected: display "No agents selected. Registration skipped." Continue to Step 4.

Continue to Step 3c with the selected slots.

### Step 3c: Confirm registration

Display pending summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► REVIEW PENDING CHANGES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Will add to Canopy's userAgentRegistry:

  ◆ nf-{slot-name}  →  {slot.model} via {slot.display_provider} [{slot.auth_type}]
  [repeat for each selected slot]

Target: {configPath}
```

Use AskUserQuestion:
- header: "Apply to Canopy"
- question: "Write these agents to Canopy's config.json?\n\nCanopy must be restarted for changes to take effect."
- options:
  - "Apply"
  - "Cancel — discard changes"

**If "Cancel":** display "Changes discarded." Continue to Step 4.

### Step 3d: Backup and write to Canopy config

**If "Apply":**

Backup Canopy config:

```bash
cp "$CANOPY_CONFIG_PATH" "${CANOPY_CONFIG_PATH}.backup-$(date +%Y-%m-%d-%H%M%S)" 2>/dev/null || true
```

Where `$CANOPY_CONFIG_PATH` is the `configPath` from Step 1.

Write user agents to Canopy's config. Pass slots and config path via env vars:

```bash
REGISTER_RESULT=$(node << 'NF_EVAL'
const fs = require('fs');

const configPath = process.env.CANOPY_CONFIG_PATH;
const selectedSlots = JSON.parse(process.env.SELECTED_SLOTS_JSON);

let config = {};
try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch(e) {
  process.stdout.write(JSON.stringify({ written: false, error: 'Cannot read Canopy config' }) + '\n');
  process.exit(1);
}

if (!config.userAgentRegistry) config.userAgentRegistry = {};

const registered = [];
for (const slot of selectedSlots) {
  const agentId = 'nf-' + slot.name;

  // Do not overwrite if already exists — user may have customized
  if (config.userAgentRegistry[agentId]) {
    registered.push({ id: agentId, status: 'skipped (already exists)' });
    continue;
  }

  config.userAgentRegistry[agentId] = {
    id: agentId,
    name: 'nForma: ' + slot.name,
    command: (slot.cli || 'node').split('/').pop(),
    color: '#6366f1',
    iconId: 'brain-circuit',
    supportsContextInjection: true,
    tooltip: slot.display_provider + ' — ' + slot.model + ' [' + slot.auth_type + ']'
  };

  registered.push({ id: agentId, status: 'added' });
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
process.stdout.write(JSON.stringify({ written: true, registered }) + '\n');
NF_EVAL
)
```

Parse REGISTER_RESULT. If `written: true`:

```
✓ Agents registered in Canopy

{for each registered entry:}
  {status === 'added' ? '✓' : '○'} {id} — {status}

⚠ Restart Canopy for changes to take effect.
```

Continue to Step 4.

---

## Step 4: Closing summary

Display:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► LINK CANOPY — COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Import:   {imported ? "✓ Canopy config imported to nf.json" : "○ Skipped"}
  Register: {registered ? "✓ " + registeredCount + " agent(s) added to Canopy" : "○ Skipped"}

Re-run /nf:link-canopy any time to refresh the link.
```

</process>

<success_criteria>
- Canopy install detected via platform-specific config.json path (macOS/Windows/Linux)
- Discovery banner shows MCP URL, agents, user agents, plugins dir
- Not-found case handled gracefully with install instructions
- Import writes `canopy` section to ~/.claude/nf.json with MCP URL and agent list
- nf.json backup created before any write
- Registration writes to Canopy's userAgentRegistry with `nf-` prefixed agent IDs
- Canopy config.json backup created before any write
- Existing user agents in Canopy are never overwritten (skipped with notice)
- No changes applied without explicit user confirmation via AskUserQuestion
- All values passed via environment variables — never interpolated into script bodies
- Cross-platform: macOS (~/Library/Application Support), Windows (%APPDATA%), Linux (~/.config)
- Idempotent: safe to re-run — updates canopy section, skips existing agents
</success_criteria>

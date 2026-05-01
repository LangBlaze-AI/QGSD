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

### Step 2d: Import preset env overrides into providers.json (issue 138 AC2 + AC5)

This step imports env overrides defined in Daintree's `agentSettings.customPresets` and `agentSettings.globalEnv` into nForma's `bin/providers.json` provider entries — model IDs, base URLs, API key references — so that nForma's quorum agents inherit the same provider configuration the user already set up in Daintree.

**Idempotency rule (AC5):** the merge NEVER overwrites a non-empty existing value in `providers[i].env`. Re-running this step is safe.

**Skip gate:** if `CANOPY_INFO.customPresets` is empty AND `CANOPY_INFO.globalEnv` is empty, display "No presets or globalEnv to import — skipping." and continue to Step 3.

Otherwise, build candidate matches between presets and providers using this heuristic (in order):

1. **Exact match** — `preset.id === provider.name` (e.g., preset `"ccr-1"` matches provider `"ccr-1"`).
2. **Prefix match** — `preset.id` starts with `provider.name + "-"` or `provider.name` starts with `preset.id + "-"`.
3. **Model match** — `preset.env.MODEL || preset.model` equals `provider.model`.

For each candidate match, list which env keys would be merged into `providers[i].env`. Common keys: `ANTHROPIC_BASE_URL`, `MODEL`, `*_API_KEY` (key NAMES only — values from preset.env). Mark a key as "skipped (already set)" if `providers[i].env[key]` is already non-empty.

**globalEnv allowlist (AC5 safety guardrail):** to avoid leaking arbitrary user env into providers.json, globalEnv keys are gated through this regex allowlist before merging:

```
^(ANTHROPIC_|OPENAI_|GOOGLE_|TOGETHER_|DEEPSEEK_|OLLAMA_|OPENROUTER_|XAI_|MODEL$|.*_BASE_URL$|.*_API_KEY$)
```

This pattern covers every provider listed in BRAND_COLORS (Step 3e) — Anthropic, OpenAI, Google, Together.xyz, DeepSeek, Ollama, OpenRouter, xAI — plus generic MODEL, *_BASE_URL, and *_API_KEY keys. Document the allowlist in the REVIEW banner so the user sees exactly which keys will pass through.

Display the REVIEW PRESET ENV IMPORT banner:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► REVIEW PRESET ENV IMPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

globalEnv allowlist (only keys matching this pattern are merged):
  ^(ANTHROPIC_|OPENAI_|GOOGLE_|TOGETHER_|DEEPSEEK_|OLLAMA_|OPENROUTER_|XAI_|MODEL$|.*_BASE_URL$|.*_API_KEY$)

Preset → Provider env merges:
  ◆ {preset.id} → {provider.name}
      merge keys: ANTHROPIC_BASE_URL, MODEL  (skipped: API_KEY [already set])
  [repeat for each match]

globalEnv keys (allowlisted, applied to all matched providers):
  {comma-separated list of allowlisted keys, or "none"}

Existing non-empty values in providers.json are NEVER overwritten (idempotent — AC5 guard).
```

Use AskUserQuestion:
- header: "Apply"
- question: "Apply preset env overrides to providers.json?\n\nA timestamped backup will be created before any write."
- options:
  - "Apply"
  - "Cancel — discard"

**If "Cancel":** display "Preset env import cancelled." Continue to Step 3.

**If "Apply":**

Backup providers.json BEFORE writing (try every candidate path — only back up the one that exists):

```bash
for cand in "$HOME/.claude/nf/bin/providers.json" "$HOME/.claude/nf-bin/providers.json" "bin/providers.json"; do
  [ -f "$cand" ] && cp "$cand" "${cand}.backup-$(date +%Y-%m-%d-%H%M%S)"
done
```

Then merge env values via Node. Pass CANOPY_INFO and SELECTED_MATCHES_JSON via env vars — never interpolate:

```bash
IMPORT_RESULT=$(node << 'NF_EVAL'
const fs = require('fs');
const path = require('path');
const os = require('os');

const canopyInfo = JSON.parse(process.env.CANOPY_INFO);
const selectedMatches = JSON.parse(process.env.SELECTED_MATCHES_JSON || '[]');

// Locate providers.json — same candidate paths used elsewhere in this file
const providersCandidates = [
  path.join(os.homedir(), '.claude', 'nf', 'bin', 'providers.json'),
  path.join(os.homedir(), '.claude', 'nf-bin', 'providers.json'),
  path.join(process.cwd(), 'bin', 'providers.json')
];
let providersPath = null;
let providersData = { providers: [] };
for (const p of providersCandidates) {
  try { providersData = JSON.parse(fs.readFileSync(p, 'utf8')); providersPath = p; break; } catch(e) {}
}
if (!providersPath) {
  process.stdout.write(JSON.stringify({ written: false, error: 'providers.json not found' }) + '\n');
  process.exit(0);
}

// globalEnv allowlist — restricts which globalEnv keys may be merged into providers
const ALLOWLIST = /^(ANTHROPIC_|OPENAI_|GOOGLE_|TOGETHER_|DEEPSEEK_|OLLAMA_|OPENROUTER_|XAI_|MODEL$|.*_BASE_URL$|.*_API_KEY$)/;
const allowedGlobalEnv = {};
for (const [k, v] of Object.entries(canopyInfo.globalEnv || {})) {
  if (ALLOWLIST.test(k)) allowedGlobalEnv[k] = v;
}

const perProvider = [];
let providersUpdated = 0;
for (const match of selectedMatches) {
  const provider = providersData.providers.find(p => p.name === match.providerName);
  if (!provider) continue;
  provider.env = provider.env || {};
  const merged = [];
  const skipped = [];

  // Merge preset env (idempotent — AC5: never overwrite non-empty existing values)
  const presetEnv = (canopyInfo.customPresets[match.presetId] || {}).env || {};
  for (const [key, value] of Object.entries(presetEnv)) {
    const current = provider.env[key];
    if (!current || current === '') { provider.env[key] = value; merged.push(key); }
    else { skipped.push({ key, reason: 'already set' }); }
  }

  // Merge allowlisted globalEnv (same non-overwrite rule)
  for (const [key, value] of Object.entries(allowedGlobalEnv)) {
    const current = provider.env[key];
    if (!current || current === '') { provider.env[key] = value; merged.push(key + ' (globalEnv)'); }
    else { skipped.push({ key, reason: 'already set' }); }
  }

  if (merged.length > 0) providersUpdated++;
  perProvider.push({ provider: provider.name, merged, skipped });
}

fs.writeFileSync(providersPath, JSON.stringify(providersData, null, 2) + '\n');
process.stdout.write(JSON.stringify({ written: true, providersPath, providersUpdated, perProvider }) + '\n');
NF_EVAL
)
```

The environment variables are:
- `CANOPY_INFO` — raw JSON from Step 1 (carries `customPresets`, `globalEnv`)
- `SELECTED_MATCHES_JSON` — JSON array of `{ presetId, providerName }` matches the user approved

Parse IMPORT_RESULT. Display result with ✓ for merged keys and ○ for skipped (already-set):

```
✓ Preset env imported into providers.json

{for each perProvider entry:}
  {provider}: ✓ merged [{merged}]   ○ skipped [{skipped}]

Providers updated: {providersUpdated}
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

Write user agents to Canopy's config. Pass slots and config path via env vars. This script ALSO writes Step 3e's `customPresets` entries in the same atomic config write, with brand colors derived from a fixed BRAND_COLORS map (see Step 3e below for the full mapping rationale):

```bash
REGISTER_RESULT=$(node << 'NF_EVAL'
const fs = require('fs');
const path = require('path');
const os = require('os');

const configPath = process.env.CANOPY_CONFIG_PATH;
const selectedSlots = JSON.parse(process.env.SELECTED_SLOTS_JSON);

// BRAND_COLORS — fixed lookup for customPreset.color (issue 138 AC4)
// Keys are lowercased provider/display_provider strings.
const BRAND_COLORS = {
  openai:        '#10a37f',  // OpenAI green
  google:        '#4285f4',  // Google blue
  anthropic:     '#d97757',  // Anthropic clay
  github:        '#181717',  // GitHub black
  xai:           '#000000',  // xAI black
  opencode:      '#f97316',  // OpenCode orange
  together:      '#0f6fff',  // Together.xyz blue
  'together.xyz':'#0f6fff',  // Together.xyz blue (display_provider variant)
  openrouter:    '#6366f1',  // OpenRouter indigo
  deepseek:      '#22c55e',  // DeepSeek green
  ollama:        '#a855f7',  // Ollama purple
  default:       '#6366f1'   // fallback indigo
};
function colorFor(provider) {
  const key = String(provider || '').toLowerCase();
  return BRAND_COLORS[key] || BRAND_COLORS.default;
}

// Load providers.json so customPresets export carries MODEL, ANTHROPIC_BASE_URL, *_API_KEY names
const providersCandidates = [
  path.join(os.homedir(), '.claude', 'nf', 'bin', 'providers.json'),
  path.join(os.homedir(), '.claude', 'nf-bin', 'providers.json'),
  path.join(process.cwd(), 'bin', 'providers.json')
];
let providersData = { providers: [] };
for (const p of providersCandidates) {
  try { providersData = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch(e) {}
}

let config = {};
try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch(e) {
  process.stdout.write(JSON.stringify({ written: false, error: 'Cannot read Canopy config' }) + '\n');
  process.exit(1);
}

if (!config.userAgentRegistry) config.userAgentRegistry = {};
config.agentSettings = config.agentSettings || {};
config.agentSettings.customPresets = config.agentSettings.customPresets || {};

const registered = [];
for (const slot of selectedSlots) {
  const agentId = 'nf-' + slot.name;
  const providerEntry = providersData.providers.find(p => p.name === slot.name) || {};

  // ── userAgentRegistry entry (existing behavior — never overwrites) ──
  if (config.userAgentRegistry[agentId]) {
    registered.push({ id: agentId, kind: 'userAgent', status: 'skipped (already exists)' });
  } else {
    config.userAgentRegistry[agentId] = {
      id: agentId,
      name: 'nForma: ' + slot.name,
      command: (slot.cli || providerEntry.mainTool || 'node').split('/').pop(),
      color: colorFor(providerEntry.provider || slot.display_provider),
      iconId: 'brain-circuit',
      supportsContextInjection: true,
      tooltip: slot.display_provider + ' — ' + slot.model + ' [' + slot.auth_type + ']'
    };
    registered.push({ id: agentId, kind: 'userAgent', status: 'added' });
  }

  // ── customPresets entry (Step 3e — issue 138 AC3, AC4, AC5) ──
  // Idempotent: existing presets show 'unchanged' — values are NEVER overwritten by default.
  const presetId = 'nf-' + slot.name;
  if (config.agentSettings.customPresets[presetId]) {
    registered.push({ id: presetId, kind: 'customPreset', status: 'unchanged' });
  } else {
    // Derive env from providers.json — pull MODEL, ANTHROPIC_BASE_URL, *_API_KEY (key NAMES only,
    // values resolved by Daintree at runtime via ${ENV_VAR} placeholders — never embed secrets here)
    const env = {};
    if (providerEntry.model)                       env.MODEL = providerEntry.model;
    if (providerEntry.env && providerEntry.env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = providerEntry.env.ANTHROPIC_BASE_URL;
    for (const k of Object.keys(providerEntry.env || {})) {
      if (/_API_KEY$/.test(k)) env[k] = '${' + k + '}';
    }

    config.agentSettings.customPresets[presetId] = {
      id: presetId,
      name: 'nForma: ' + slot.name,
      command: (slot.cli || providerEntry.mainTool || 'node').split('/').pop(),
      color: colorFor(providerEntry.provider || slot.display_provider),
      iconId: 'brain-circuit',
      description: (providerEntry.display_provider || slot.display_provider || 'unknown') + ' — ' + (providerEntry.model || slot.model || 'unknown'),
      env
    };
    registered.push({ id: presetId, kind: 'customPreset', status: 'added' });
  }
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
process.stdout.write(JSON.stringify({ written: true, registered }) + '\n');
NF_EVAL
)
```

Parse REGISTER_RESULT. If `written: true`, display two columns — userAgentRegistry entries on the left, customPresets entries on the right — so the user sees both export channels:

```
✓ Agents registered in Canopy

  userAgentRegistry                       customPresets (Daintree IDE preset palette)
  ──────────────────────────────────────  ──────────────────────────────────────
{for each registered entry, group by kind:}
  ✓ nf-codex-1 — added                    ✓ nf-codex-1 — added
  ○ nf-claude-1 — skipped (already exists) ○ nf-claude-1 — unchanged

⚠ Restart Daintree (or canopy-app) for changes to take effect.
```

Re-running this command shows `unchanged` for any customPresets that already exist — entries are NEVER overwritten by default (issue 138 AC5 idempotency).

### Step 3e: Custom preset export — implementation notes (issue 138 AC3 + AC4)

Step 3e is implemented as part of Step 3d's atomic write above (one config read, one config write — avoids dual-backup risk). What it does:

1. **Builds a `customPresets` entry per selected quorum slot** (id = `nf-{slot.name}`, mirroring the userAgentRegistry id).
2. **Derives env from `providers.json`** — MODEL is copied verbatim, ANTHROPIC_BASE_URL is copied if set, and any `*_API_KEY` keys are emitted as Daintree placeholder strings `${KEY_NAME}` so Daintree resolves them from the user's runtime env (no secrets embedded in config).
3. **Picks brand color from `BRAND_COLORS`** — keyed by `providerEntry.provider` (lowercased), e.g., `openai → #10a37f`, `anthropic → #d97757`, `together.xyz → #0f6fff`. Unknown providers fall back to `#6366f1` (indigo).
4. **Idempotency (AC5):** existing `customPresets[presetId]` entries are left untouched and emit a `status: 'unchanged'` row in the result. The user must manually delete a preset in Daintree to force re-export.

Continue to Step 4.

---

## Step 4: Closing summary

Display:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► LINK CANOPY — COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Product detected:        {productName} (Daintree, or canopy-app legacy)
  Import (nf.json):        {imported ? "✓ Canopy config imported to nf.json" : "○ Skipped"}
  Preset env imported:     {presetEnvImported ? "✓ " + providersUpdated + " provider(s) updated in providers.json" : "○ Skipped"}
  Register userAgents:     {registered ? "✓ " + userAgentsAddedCount + " added, " + userAgentsSkippedCount + " skipped" : "○ Skipped"}
  Custom presets exported: {customPresetsAddedCount > 0 || customPresetsUnchangedCount > 0 ? "✓ " + customPresetsAddedCount + " added, " + customPresetsUnchangedCount + " unchanged" : "○ Skipped"}

Re-run /nf:link-canopy any time to refresh the link.
Existing customPresets and providers.json env values are NEVER overwritten (idempotent — issue 138 AC5).
```

</process>

<success_criteria>
- Daintree detected first; canopy-app paths used as backwards-compatible fallback
- Discovery banner shows MCP URL, agents, user agents, plugins dir
- Custom presets, globalEnv, and providerTemplates from Daintree agentSettings are surfaced in discovery banner (issue 138 AC1)
- Not-found case handled gracefully with install instructions for both Daintree and legacy canopy-app paths
- Import writes `canopy` section to ~/.claude/nf.json with MCP URL and agent list
- nf.json backup created before any write
- Import path merges preset env into matching providers.json slots without overwriting non-empty values (issue 138 AC2 + AC5)
- providers.json backup created before any env merge write
- globalEnv merges are gated by allowlist `^(ANTHROPIC_|OPENAI_|GOOGLE_|TOGETHER_|DEEPSEEK_|OLLAMA_|OPENROUTER_|XAI_|MODEL$|.*_BASE_URL$|.*_API_KEY$)` — covers all BRAND_COLORS providers
- Registration writes to Canopy's userAgentRegistry with `nf-` prefixed agent IDs
- Export path writes nForma quorum slots to Daintree customPresets with provider-specific brand colors from BRAND_COLORS mapping (issue 138 AC3 + AC4)
- Canopy config.json backup created before any write
- Existing user agents and customPresets in Canopy are never overwritten — re-running shows 'unchanged' (issue 138 AC5 idempotency)
- No changes applied without explicit user confirmation via AskUserQuestion
- All values passed via environment variables — never interpolated into script bodies
- Cross-platform: macOS (~/Library/Application Support), Windows (%APPDATA%), Linux (~/.config)
- Idempotent: safe to re-run — updates canopy section, skips existing agents and customPresets
</success_criteria>

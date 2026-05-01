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
  // Per-agent customPresets — keyed by Daintree agent name (claude, codex, gemini, ...)
  // each value is an array of preset objects {id, name, description, env, color, fallbacks, dangerousEnabled}
  customPresetsByAgent: {},
  // Per-agent active preset id (agentSettings.agents.<agent>.presetId) — the preset the user
  // currently has selected in Daintree. Used by the discovery banner to mark which preset is
  // active. NOTE: Step 2d uses fan-out semantics (every preset becomes its own slot), so this
  // field is informational only — not a gate on which presets get imported.
  activePresetIdByAgent: {},
  presetCount: 0,
  // Top-level Daintree key — flat object of env-key → env-value
  globalEnvironmentVariables: {}
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

  // Daintree v20 schema (issue 138 AC1):
  //   - customPresets live PER AGENT as arrays at agentSettings.agents.<agent>.customPresets[]
  //   - globalEnvironmentVariables is a top-level object on the config root (not under agentSettings)
  //   - providerTemplates does not exist in v20 — omitted from this command
  if (config.agentSettings && config.agentSettings.agents) {
    for (const [agentName, agentCfg] of Object.entries(config.agentSettings.agents)) {
      if (Array.isArray(agentCfg.customPresets) && agentCfg.customPresets.length > 0) {
        result.customPresetsByAgent[agentName] = agentCfg.customPresets;
        result.presetCount += agentCfg.customPresets.length;
      }
      // Accept any non-null presetId — Daintree may emit it as a number or other primitive
      // depending on schema generation; coerce to string at lookup time, not record time, so
      // the stored type matches whatever customPresets[].id uses.
      if (agentCfg.presetId != null) {
        result.activePresetIdByAgent[agentName] = agentCfg.presetId;
      }
    }
  }
  if (config.globalEnvironmentVariables && typeof config.globalEnvironmentVariables === 'object') {
    result.globalEnvironmentVariables = config.globalEnvironmentVariables;
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

  Custom Presets ({presetCount} across {Object.keys(customPresetsByAgent).length} agent(s)):
    {for each [agent, presets] in customPresetsByAgent:
       activeId = String(activePresetIdByAgent[agent] ?? "")
       slugify = name => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
       // String() coercion on both sides — Daintree may emit presetId/preset.id as a number or
       // a string; without normalization the active marker would silently show "(none)".
       "{agent} (active = {presets.find(p => String(p.id) === activeId)?.name ?? "(none)"}):"
       for each preset in presets:
         marker = String(preset.id) === activeId ? "★" : " "
         "  {marker} {preset.name}  →  would create slot: {agent}-{slugify(preset.name)}"}
    {if presetCount === 0: "none"}

  Global Environment Variables ({Object.keys(globalEnvironmentVariables).length}):
    {comma-separated list of globalEnvironmentVariables keys, or "none"}
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

### Step 2d: Fan-out import — Daintree presets become nForma quorum slots (issue 138 AC2 + AC5)

Each Daintree preset becomes its **own** nForma quorum slot, alongside the existing vanilla slot for that agent. The vanilla slot stays vanilla. Example: with Daintree's `claude` agent owning `Z.AI` and `MiniMax` presets, the import produces — in addition to `claude-1` (vanilla) — `claude-z-ai` and `claude-minimax`.

This writes to three live files (each backed up first):

1. `~/.claude/nf/bin/providers.json` — append a new provider entry per preset, cloning the vanilla provider for the family and overlaying the preset's allowlisted env.
2. `~/.claude.json` `mcpServers` — clone the vanilla slot's MCP entry with `PROVIDER_SLOT` set to the new slot name (so the MCP server runs against the new env).
3. `~/.claude/nf.json` `quorum_active` — append the new slot name.

**Slot-name slug rule.** nForma slot names must match `^[a-z][a-z0-9-]*$` (canonical regex at `bin/provider-mapping.test.cjs:143`). Preset names are slugified:
- lowercase
- replace any non-`[a-z0-9]` with `-`
- collapse runs of `-`
- trim leading/trailing `-`

The new slot name is `{agentName}-{slug}` — using the **Daintree agent name** as the prefix (NOT the vanilla slot's full name). With vanilla `claude-1` and preset `Z.AI`, the result is `claude-z-ai`, not `claude-1-z-ai`. On collision (two presets slugifying to the same value within one agent), append `-2`, `-3`, etc.

**Family gate.** A preset is matched to the *vanilla* slot whose `mainTool === agentName` AND `provider === inferredFamily(preset.env)`. Family is inferred from the preset's allowlisted env-key prefixes:

| env-key prefix | inferred family |
|---|---|
| `ANTHROPIC_*` | `anthropic` |
| `OPENAI_*` | `openai` |
| `GOOGLE_*` / `GEMINI_*` | `google` |
| `TOGETHER_*` | `together` |
| `XAI_*` / `GROK_*` | `xai` |
| `DEEPSEEK_*` | `deepseek` |
| `OPENROUTER_*` | `openrouter` |
| `OLLAMA_*` | `ollama` |

If no family can be inferred (e.g., preset only has generic `MODEL` / `*_BASE_URL` / `*_API_KEY`), the family check is bypassed and any provider with `mainTool === agentName` is acceptable as the vanilla. If multiple vanilla candidates exist after both gates, prefer the one with no `daintree_preset_id` field (the original) and the lowest numeric suffix (`claude-1` over `claude-2`).

**Idempotency (AC5).** Each new slot carries a `daintree_preset_id` field equal to `preset.id`. On re-import:
- A **vanilla** slot (no `daintree_preset_id`) is never touched. Its env, model, and description survive every re-import.
- A **preset-linked** slot (matched by `daintree_preset_id`) is updated in place: the allowlisted preset env keys overlay the slot's existing env (preset values win on collision; non-allowlisted env the user added by hand is preserved), and `model` / `description` / `daintree_preset_name` / `daintree_preset_family` are refreshed. The slot's `name` is kept stable even if the preset name changed in Daintree.
- A preset-linked slot whose `daintree_preset_id` references a preset Daintree no longer has is **preserved by default** (option b — the user removes it manually). This avoids silently destroying slots already referenced in user prompts/scripts.

The export direction (Step 3e) is also idempotent but with **no-overwrite** semantics: existing `customPresets[]` entries with a matching `id` are left untouched (status `unchanged`). To force a re-export, delete the preset in Daintree first.

**Allowlist (AC5 safety guardrail).** Preset env keys must match this regex before being copied into the new slot's env:

```
^(ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|TOGETHER_|DEEPSEEK_|OLLAMA_|OPENROUTER_|XAI_|GROK_|MODEL$|.*_BASE_URL$|.*_API_KEY$)
```

Top-level `globalEnvironmentVariables` keys, after the same filter, are merged into every newly-created slot's env (non-overwrite — preset values win over global).

**Skip gate.** If `CANOPY_INFO.presetCount === 0` AND `CANOPY_INFO.globalEnvironmentVariables` has zero keys, display "No presets or globalEnvironmentVariables to import — skipping." and continue to Step 3.

Display the REVIEW FAN-OUT IMPORT banner:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► REVIEW FAN-OUT IMPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Allowlist (preset env keys must match):
  ^(ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|TOGETHER_|DEEPSEEK_|OLLAMA_|OPENROUTER_|XAI_|GROK_|MODEL$|.*_BASE_URL$|.*_API_KEY$)

New slots (one per Daintree preset):
  ◆ {agentName}: vanilla = {vanillaSlotName} (preserved unchanged)
      • {preset.name}  →  {agentName}-{slug}   [family={inferredFamily}, env keys={allowlisted preset env keys}]
      • {preset.name}  →  {agentName}-{slug}-2 (collision-suffixed)   [...]
  [repeat per agent]

Skipped:
  ◆ {agentName}: {reason — e.g., no vanilla provider, family mismatch, no presets}

Each new slot also gets:
  - cloned MCP server entry in ~/.claude.json (PROVIDER_SLOT={newName})
  - appended to quorum_active in ~/.claude/nf.json
  - daintree_preset_id field for re-import idempotency

Backups (timestamped) are written for all three files before any change.
```

Use AskUserQuestion:
- header: "Apply"
- question: "Apply fan-out import — create one nForma slot per Daintree preset?"
- options:
  - "Apply"
  - "Cancel — discard"

**If "Cancel":** display "Fan-out import cancelled." Continue to Step 3.

**If "Apply":**

Backup all three files BEFORE writing:

```bash
TS=$(date +%Y-%m-%d-%H%M%S)
for cand in "$HOME/.claude/nf/bin/providers.json" "$HOME/.claude/nf-bin/providers.json" "bin/providers.json"; do
  [ -f "$cand" ] && cp "$cand" "${cand}.backup-${TS}"
done
[ -f "$HOME/.claude.json" ] && cp "$HOME/.claude.json" "$HOME/.claude.json.backup-${TS}"
[ -f "$HOME/.claude/nf.json" ] && cp "$HOME/.claude/nf.json" "$HOME/.claude/nf.json.backup-${TS}"
```

Then run the fan-out via Node. Pass CANOPY_INFO via env var — never interpolate:

```bash
IMPORT_RESULT=$(node << 'NF_EVAL'
const fs = require('fs');
const path = require('path');
const os = require('os');

const canopyInfo = JSON.parse(process.env.CANOPY_INFO);

// ── Locate providers.json ──────────────────────────────────────────────
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

// ── Slug + family inference ────────────────────────────────────────────
const SLOT_NAME_RE = /^[a-z][a-z0-9-]*$/;
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
const ALLOWLIST = /^(ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|TOGETHER_|DEEPSEEK_|OLLAMA_|OPENROUTER_|XAI_|GROK_|MODEL$|.*_BASE_URL$|.*_API_KEY$)/;
function filterAllowlisted(envObj) {
  const out = {};
  for (const [k, v] of Object.entries(envObj || {})) if (ALLOWLIST.test(k)) out[k] = v;
  return out;
}
const FAMILY_PREFIXES = [
  ['anthropic',  /^ANTHROPIC_/],
  ['openai',     /^OPENAI_/],
  ['google',     /^(GOOGLE_|GEMINI_)/],
  ['together',   /^TOGETHER_/],
  ['xai',        /^(XAI_|GROK_)/],
  ['deepseek',   /^DEEPSEEK_/],
  ['openrouter', /^OPENROUTER_/],
  ['ollama',     /^OLLAMA_/],
];
function inferFamily(envObj) {
  const counts = {};
  for (const k of Object.keys(envObj || {})) {
    for (const [fam, re] of FAMILY_PREFIXES) if (re.test(k)) counts[fam] = (counts[fam] || 0) + 1;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return ranked.length ? ranked[0][0] : null; // null = no family signal; bypass family gate
}

// ── Find vanilla provider for a Daintree agent + family ────────────────
function findVanilla(agentName, family) {
  const candidates = providersData.providers.filter(p => p.mainTool === agentName);
  const familyMatch = family ? candidates.filter(p => p.provider === family) : candidates;
  const pool = familyMatch.length ? familyMatch : (family ? [] : candidates);
  // Prefer provider without daintree_preset_id, then lowest numeric suffix
  pool.sort((a, b) => {
    const aIsClone = !!a.daintree_preset_id;
    const bIsClone = !!b.daintree_preset_id;
    if (aIsClone !== bIsClone) return aIsClone ? 1 : -1;
    const an = parseInt((a.name.match(/-(\d+)$/) || [])[1] || '0', 10);
    const bn = parseInt((b.name.match(/-(\d+)$/) || [])[1] || '0', 10);
    return an - bn;
  });
  return pool[0] || null;
}

// ── Build new-slot plan ────────────────────────────────────────────────
const customPresetsByAgent = canopyInfo.customPresetsByAgent || {};
const allowedGlobalEnv = filterAllowlisted(canopyInfo.globalEnvironmentVariables);

const plan = []; // { kind: 'add'|'update'|'skip', preset, vanilla, newName, env, family, reason? }
const usedNames = new Set(providersData.providers.map(p => p.name));

for (const [agentName, presets] of Object.entries(customPresetsByAgent)) {
  for (const preset of presets) {
    const allowedEnv = filterAllowlisted(preset.env);
    const family = inferFamily(allowedEnv);

    // Normalize daintree_preset_id to a string everywhere — plan, lookup, and stored field —
    // so a Daintree schema-generation change between runs (string vs number) never breaks
    // re-import idempotency. Without this, a string-vs-number id mismatch would create
    // duplicate preset-linked slots instead of updating in place (AC5 violation).
    const daintreePresetId = String(preset.id);
    // Idempotency: existing provider with this daintree_preset_id?
    const existing = providersData.providers.find(p => String(p.daintree_preset_id) === daintreePresetId);
    const vanilla = findVanilla(agentName, family);

    if (!vanilla && !existing) {
      plan.push({ kind: 'skip', preset, agentName, family, reason: 'no vanilla provider with mainTool=' + agentName + (family ? ' + provider=' + family : '') });
      continue;
    }

    // Carry both env layers separately so apply-time can compose with the documented precedence:
    //   globalEnv (base) → vanilla → preset (top). vanilla wins over globalEnv (so globalEnv is
    //   non-overwrite from the slot's perspective), preset wins over both.
    if (existing) {
      // Pass `vanilla` as-is (may be null if the matching vanilla disappeared between runs).
      // The apply branch only refreshes `description` when a fresh vanilla is available — using
      // the existing preset-linked slot's description as a base would compound the
      // " — Daintree preset: ..." suffix on every re-run.
      plan.push({ kind: 'update', preset, agentName, family, vanilla, existingName: existing.name, presetEnv: allowedEnv, globalEnv: allowedGlobalEnv });
      continue;
    }

    // Build the new slot name. Format: {agentName}-{slug(preset.name)} — e.g., "claude-z-ai".
    // Use the Daintree agent name as prefix (NOT the vanilla slot's full name) so a vanilla
    // "claude-1" and a preset "Z.AI" produce "claude-z-ai", not "claude-1-z-ai".
    // String() coercion makes the id-hash fallback safe for non-string ids (numbers, etc).
    const baseSlug = slugify(preset.name) || (
      'preset-' +
      Math.abs([...String(preset.id)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 0)).toString(36)
    );
    let candidate = agentName + '-' + baseSlug;
    if (!SLOT_NAME_RE.test(candidate)) candidate = agentName + '-preset'; // last resort
    let n = 2;
    while (usedNames.has(candidate)) {
      candidate = agentName + '-' + baseSlug + '-' + n;
      n++;
    }
    usedNames.add(candidate);

    plan.push({ kind: 'add', preset, agentName, family, vanilla, newName: candidate, presetEnv: allowedEnv, globalEnv: allowedGlobalEnv });
  }
}

// ── Apply to providers.json ────────────────────────────────────────────
const written = { providers: { added: [], updated: [], skipped: [] }, mcpServers: { added: [], skipped: [] }, quorum: { added: [], skipped: [] } };

for (const item of plan) {
  if (item.kind === 'skip') {
    written.providers.skipped.push({ preset: item.preset.name, agent: item.agentName, reason: item.reason });
    continue;
  }
  if (item.kind === 'add') {
    const v = item.vanilla;
    const newProvider = JSON.parse(JSON.stringify(v));
    newProvider.name = item.newName;
    // Three-layer env composition (low → high precedence):
    //   1. globalEnv  — allowlisted Daintree globalEnvironmentVariables; non-overwrite from
    //                   the slot's perspective (vanilla wins where it has a key).
    //   2. vanilla    — the cloned vanilla provider's existing env.
    //   3. presetEnv  — allowlisted preset env; preset wins over vanilla and globalEnv.
    newProvider.env = { ...(item.globalEnv || {}), ...(v.env || {}), ...(item.presetEnv || {}) };
    // If the preset carries a MODEL override, propagate it to provider.model. Keeps Step 3d
    // export round-trip-correct.
    if (typeof item.presetEnv?.MODEL === 'string' && item.presetEnv.MODEL.length > 0) {
      newProvider.model = item.presetEnv.MODEL;
    }
    newProvider.description = (v.description || '') + ' — Daintree preset: ' + item.preset.name;
    newProvider.daintree_preset_id = String(item.preset.id);
    newProvider.daintree_preset_name = item.preset.name;
    if (item.family) newProvider.daintree_preset_family = item.family;
    providersData.providers.push(newProvider);
    const envKeys = [...new Set([...Object.keys(item.globalEnv || {}), ...Object.keys(item.presetEnv || {})])];
    written.providers.added.push({ name: item.newName, presetName: item.preset.name, presetId: String(item.preset.id), vanilla: v.name, envKeys });
  } else if (item.kind === 'update') {
    const existingId = String(item.preset.id);
    const existing = providersData.providers.find(p => String(p.daintree_preset_id) === existingId);
    // On update, we layer onto the slot's CURRENT env (not the vanilla's) so any non-allowlisted
    // runtime env the user added by hand survives. globalEnv stays non-overwrite, preset wins.
    existing.env = { ...(item.globalEnv || {}), ...(existing.env || {}), ...(item.presetEnv || {}) };
    if (typeof item.presetEnv?.MODEL === 'string' && item.presetEnv.MODEL.length > 0) {
      existing.model = item.presetEnv.MODEL;
    }
    // Only refresh description when a fresh, un-suffixed vanilla is available. If we were to
    // base the description on `existing` (or on a previously-cloned slot used as a fallback
    // vanilla), the " — Daintree preset: X" suffix would compound on every re-import.
    if (item.vanilla && !item.vanilla.daintree_preset_id) {
      existing.description = (item.vanilla.description || '') + ' — Daintree preset: ' + item.preset.name;
    }
    existing.daintree_preset_name = item.preset.name;
    if (item.family) existing.daintree_preset_family = item.family;
    const envKeys = [...new Set([...Object.keys(item.globalEnv || {}), ...Object.keys(item.presetEnv || {})])];
    written.providers.updated.push({ name: existing.name, presetName: item.preset.name, presetId: existingId, envKeys });
  }
}

fs.writeFileSync(providersPath, JSON.stringify(providersData, null, 2) + '\n');

// ── Apply to ~/.claude.json (clone vanilla MCP server entry per new slot) ──
const claudeJsonPath = path.join(os.homedir(), '.claude.json');
let claudeJson = {};
try { claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch (e) {}
claudeJson.mcpServers = claudeJson.mcpServers || {};
for (const item of plan.filter(p => p.kind === 'add')) {
  const v = item.vanilla;
  const vanillaEntry = claudeJson.mcpServers[v.name];
  if (!vanillaEntry) {
    written.mcpServers.skipped.push({ name: item.newName, reason: 'vanilla MCP server entry "' + v.name + '" not in ~/.claude.json' });
    continue;
  }
  if (claudeJson.mcpServers[item.newName]) {
    written.mcpServers.skipped.push({ name: item.newName, reason: 'already present' });
    continue;
  }
  const cloned = JSON.parse(JSON.stringify(vanillaEntry));
  cloned.env = cloned.env || {};
  cloned.env.PROVIDER_SLOT = item.newName;
  // unified-mcp-server.mjs reads providers.json from its own __dirname (repo source) by default.
  // The new slot only exists in the providers.json we just wrote (the installed copy), so we
  // point this MCP instance at that copy via UNIFIED_PROVIDERS_CONFIG. Without this, the server
  // would exit with "Unknown PROVIDER_SLOT" because the new slot is invisible to it.
  cloned.env.UNIFIED_PROVIDERS_CONFIG = providersPath;
  claudeJson.mcpServers[item.newName] = cloned;
  written.mcpServers.added.push({ name: item.newName, vanilla: v.name });
}
fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + '\n');

// ── Apply to ~/.claude/nf.json (append to quorum_active) ──
const nfJsonPath = path.join(os.homedir(), '.claude', 'nf.json');
let nfJson = {};
try { nfJson = JSON.parse(fs.readFileSync(nfJsonPath, 'utf8')); } catch (e) {}
nfJson.quorum_active = Array.isArray(nfJson.quorum_active) ? nfJson.quorum_active : [];
for (const item of plan.filter(p => p.kind === 'add')) {
  if (nfJson.quorum_active.includes(item.newName)) {
    written.quorum.skipped.push({ name: item.newName, reason: 'already in quorum_active' });
  } else {
    nfJson.quorum_active.push(item.newName);
    written.quorum.added.push({ name: item.newName });
  }
}
fs.writeFileSync(nfJsonPath, JSON.stringify(nfJson, null, 2) + '\n');

// CRITICAL: do NOT include `plan` in the stdout payload. plan[].env carries allowlisted preset env
// which includes `*_API_KEY` values verbatim (the allowlist passes raw values for keys like
// ANTHROPIC_AUTH_TOKEN). Emitting plan would leak those secrets to terminal/logs/CI artifacts.
// `summary: written` carries only key NAMES (envKeys arrays), never values.
process.stdout.write(JSON.stringify({ written: true, providersPath, claudeJsonPath, nfJsonPath, summary: written }) + '\n');
NF_EVAL
)
```

The environment variables are:
- `CANOPY_INFO` — raw JSON from Step 1 (carries `customPresetsByAgent` and `globalEnvironmentVariables`)

Parse IMPORT_RESULT. Display the result:

```text
✓ Fan-out import complete

providers.json:
  ✓ added:    {summary.providers.added.map(a => a.name + " (from preset \"" + a.presetName + "\", clones " + a.vanilla + ")")}
  ↻ updated:  {summary.providers.updated.map(u => u.name + " ← preset \"" + u.presetName + "\"")}
  ○ skipped:  {summary.providers.skipped.map(s => "preset \"" + s.preset + "\" → " + s.reason)}

~/.claude.json mcpServers:
  ✓ added:    {summary.mcpServers.added.map(m => m.name + " (cloned from " + m.vanilla + ")")}
  ○ skipped:  {summary.mcpServers.skipped.map(m => m.name + " — " + m.reason)}

~/.claude/nf.json quorum_active:
  ✓ added:    {summary.quorum.added.map(q => q.name)}
  ○ skipped:  {summary.quorum.skipped.map(q => q.name + " — " + q.reason)}

⚠ Restart Claude Code to pick up the new MCP servers and quorum slots.
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
config.agentSettings.agents = config.agentSettings.agents || {};

// Pick the Daintree agent that should host this preset. We prefer providerEntry.mainTool
// (which is the CLI binary name and matches Daintree's agent keys: claude, codex, gemini, opencode).
// Treat slot.cli === 'unknown' as missing — Step 3a fills that literal when provider.cli is null,
// and we don't want it written into the registry as a real command name.
function targetAgentFor(slot, providerEntry) {
  const fromSlotCli = slot.cli && slot.cli !== 'unknown' ? slot.cli : null;
  return providerEntry.mainTool || fromSlotCli || 'claude';
}

const registered = [];
for (const slot of selectedSlots) {
  const agentId = 'nf-' + slot.name;
  const providerEntry = providersData.providers.find(p => p.name === slot.name) || {};

  // ── userAgentRegistry entry (existing behavior — never overwrites) ──
  if (config.userAgentRegistry[agentId]) {
    registered.push({ id: agentId, kind: 'userAgent', status: 'skipped (already exists)' });
  } else {
    // Pick a real command name. Step 3a sets slot.cli to the literal 'unknown' when
    // provider.cli is null, so prefer providerEntry.mainTool (the CLI binary) over that
    // sentinel — falling back to the literal only if mainTool is also missing, then 'node'.
    const cliFromSlot = slot.cli && slot.cli !== 'unknown' ? slot.cli : null;
    const command = (cliFromSlot || providerEntry.mainTool || 'node').split('/').pop();
    config.userAgentRegistry[agentId] = {
      id: agentId,
      name: 'nForma: ' + slot.name,
      command,
      color: colorFor(providerEntry.provider || slot.display_provider),
      iconId: 'brain-circuit',
      supportsContextInjection: true,
      tooltip: slot.display_provider + ' — ' + slot.model + ' [' + slot.auth_type + ']'
    };
    registered.push({ id: agentId, kind: 'userAgent', status: 'added' });
  }

  // ── customPresets entry (Step 3e — issue 138 AC3, AC4, AC5) ──
  // Daintree v20: customPresets is a per-agent ARRAY at agentSettings.agents.<agent>.customPresets[].
  // Each entry shape: {id, name, description, env, color, fallbacks: [], dangerousEnabled}.
  // Idempotency by id: existing entries with the same id show 'unchanged' and are NEVER overwritten.
  const presetId = 'nf-' + slot.name;
  let targetAgent = targetAgentFor(slot, providerEntry);
  let agentBucket = config.agentSettings.agents[targetAgent];

  // Wrapper/router slots (e.g. CCR pointing at provider.mainTool not in Daintree's agent set)
  // would otherwise be silently dropped from export. Fall back to the 'claude' bucket if Daintree
  // has it — covers the common case where the user runs the slot via the claude CLI even though
  // the upstream provider differs (Together.xyz, OpenRouter, etc.).
  const targetAgentRequested = targetAgent;
  let usedFallback = false;
  if (!agentBucket && config.agentSettings.agents.claude) {
    targetAgent = 'claude';
    agentBucket = config.agentSettings.agents.claude;
    usedFallback = true;
  }

  if (!agentBucket) {
    registered.push({ id: presetId, kind: 'customPreset', status: 'skipped (Daintree has no agent: ' + targetAgentRequested + ')', targetAgent: targetAgentRequested });
  } else {
    if (!Array.isArray(agentBucket.customPresets)) agentBucket.customPresets = [];
    const existing = agentBucket.customPresets.find(p => p && p.id === presetId);
    if (existing) {
      registered.push({ id: presetId, kind: 'customPreset', status: 'unchanged', targetAgent });
    } else {
      // Derive env from providers.json. *_API_KEY keys are emitted as ${KEY} placeholders so
      // Daintree resolves secrets from the user's runtime env at preset-launch time (no embedded
      // secrets in the config). *_BASE_URL keys are copied verbatim — they're endpoints, not
      // secrets, and per-provider overrides need to round-trip into Daintree.
      const env = {};
      if (providerEntry.model) env.MODEL = providerEntry.model;
      for (const [k, v] of Object.entries(providerEntry.env || {})) {
        if (/_API_KEY$/.test(k)) env[k] = '${' + k + '}';
        else if (/_BASE_URL$/.test(k)) env[k] = v;
      }

      agentBucket.customPresets.push({
        id: presetId,
        name: 'nForma: ' + slot.name,
        description: (providerEntry.display_provider || slot.display_provider || 'unknown') + ' — ' + (providerEntry.model || slot.model || 'unknown'),
        env,
        color: colorFor(providerEntry.provider || slot.display_provider),
        fallbacks: [],
        dangerousEnabled: false
      });
      registered.push({ id: presetId, kind: 'customPreset', status: usedFallback ? 'added (fallback to claude)' : 'added', targetAgent, ...(usedFallback ? { targetAgentRequested } : {}) });
    }
  }
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
process.stdout.write(JSON.stringify({ written: true, registered }) + '\n');
NF_EVAL
)
```

Parse REGISTER_RESULT. If `written: true`, display two columns — userAgentRegistry entries on the left, customPresets entries on the right — so the user sees both export channels:

```text
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
2. **Routes the entry to the correct Daintree agent bucket** — Daintree v20 stores `customPresets` as a per-agent **array** at `agentSettings.agents.<agent>.customPresets[]`. The target agent is `providerEntry.mainTool` (the CLI binary the slot drives), falling back to `slot.cli` (treating the literal `'unknown'` as missing), then `claude`. If the resolved target agent doesn't exist in Daintree's agent map, we fall back to the `claude` bucket (covers wrapper/router slots like CCR that drive the claude CLI but route to a non-anthropic provider) — and if even that's missing, the preset is skipped for that slot with a clear status row.
3. **Derives env from `providers.json`** — MODEL is copied verbatim, every `*_BASE_URL` (e.g. ANTHROPIC_BASE_URL, OPENAI_BASE_URL) is copied verbatim so endpoint overrides round-trip back to Daintree, and any `*_API_KEY` keys are emitted as Daintree placeholder strings `${KEY_NAME}` so Daintree resolves them from the user's runtime env (no secrets embedded in config).
4. **Picks brand color from `BRAND_COLORS`** — keyed by `providerEntry.provider` (lowercased), e.g., `openai → #10a37f`, `anthropic → #d97757`, `together.xyz → #0f6fff`. Unknown providers fall back to `#6366f1` (indigo).
5. **Idempotency (AC5):** existing entries (matched by `id` inside the per-agent array) are left untouched and emit `status: 'unchanged'`. The user must manually delete a preset in Daintree to force re-export.

The shape pushed into the array matches Daintree's preset schema: `{id, name, description, env, color, fallbacks: [], dangerousEnabled: false}`. We default `dangerousEnabled` to false — the slot's own configuration (claude.dangerousEnabled, etc.) governs invocation safety; presets only carry env overrides.

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

Re-run /nf:link-canopy any time to refresh the link. Idempotency rules:
  • Vanilla nForma slots (no daintree_preset_id) are never touched.
  • Preset-linked slots (matched by daintree_preset_id) are updated in place — env is overlaid
    with the latest preset values, name is kept stable.
  • Daintree customPresets exported by nForma (id = nf-{slot}) are never overwritten — re-runs
    show 'unchanged'. Delete the preset in Daintree first to force a re-export.
```

</process>

<success_criteria>
- Daintree detected first; canopy-app paths used as backwards-compatible fallback
- Discovery banner shows MCP URL, agents, user agents, plugins dir
- Custom presets (per-agent arrays at agentSettings.agents.<agent>.customPresets) and top-level globalEnvironmentVariables are surfaced in discovery banner (issue 138 AC1)
- Not-found case handled gracefully with install instructions for both Daintree and legacy canopy-app paths
- Import writes `canopy` section to ~/.claude/nf.json with MCP URL and agent list
- nf.json backup created before any write
- Import path fans out per-agent presets into new provider entries (matched via provider.mainTool === agentName + family inferred from preset env), overlaying allowlisted env onto the cloned vanilla. Vanilla slots are untouched; preset-linked slots are replaced in place on re-import. (issue 138 AC2 + AC5)
- providers.json backup created before any env merge write
- Both preset env and globalEnvironmentVariables merges are gated by allowlist `^(ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|TOGETHER_|DEEPSEEK_|OLLAMA_|OPENROUTER_|XAI_|GROK_|MODEL$|.*_BASE_URL$|.*_API_KEY$)` — covers all BRAND_COLORS providers
- Registration writes to Canopy's userAgentRegistry with `nf-` prefixed agent IDs
- Export path writes nForma quorum slots to per-agent Daintree customPresets arrays (agentSettings.agents.<agent>.customPresets[]) with provider-specific brand colors from BRAND_COLORS mapping (issue 138 AC3 + AC4)
- Canopy config.json backup created before any write
- Existing user agents and customPresets in Canopy are never overwritten — re-running shows 'unchanged' (issue 138 AC5 idempotency)
- No changes applied without explicit user confirmation via AskUserQuestion
- All values passed via environment variables — never interpolated into script bodies
- Cross-platform: macOS (~/Library/Application Support), Windows (%APPDATA%), Linux (~/.config)
- Idempotent: safe to re-run — updates canopy section, skips existing agents and customPresets
</success_criteria>

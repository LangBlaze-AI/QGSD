---
phase: 405-bidirectional-fleet-sync-canopy-presets
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - commands/nf/link-canopy.md
  - onboard.md
autonomous: true
requirements:
  - ISSUE-138-AC1
  - ISSUE-138-AC2
  - ISSUE-138-AC3
  - ISSUE-138-AC4
  - ISSUE-138-AC5
formal_artifacts: none
implementation_evolution:
  status: "Plan body below documents the ORIGINAL design. Live testing against a real Daintree v20 install surfaced schema and design errors; the shipped implementation diverges from this plan as follows. The body is left intact for historical reference."
  schema_corrections:
    - "customPresets is a per-agent ARRAY at agentSettings.agents.<agent>.customPresets[], not an object map at agentSettings.customPresets"
    - "globalEnv → globalEnvironmentVariables, lives at the config root (not under agentSettings)"
    - "providerTemplates does not exist in Daintree v20 — entirely removed from the command"
  design_changes:
    - "Step 2d switched from 'merge preset env into vanilla provider' to 'fan-out: each preset becomes its own new slot named {agentName}-{slug(preset.name)}, cloned from the matching vanilla'. Original active-preset merge would have given Together-routed ccr-* slots Anthropic env (verified broken via runtime test)."
    - "Family gate added on Step 2d match: provider.mainTool === agentName AND provider.provider === inferredFamily(preset.env). Without this gate, fan-out would still spread Anthropic env into Together-routed slots."
    - "Step 2d writes to THREE files now (not just providers.json): providers.json + ~/.claude.json mcpServers (cloned MCP entry per new slot) + ~/.claude/nf.json quorum_active. UNIFIED_PROVIDERS_CONFIG must be set on the cloned MCP entry so unified-mcp-server.mjs sees the new slot."
    - "Idempotency on re-import is REPLACE-IN-PLACE for preset-linked slots (matched by daintree_preset_id), not non-overwrite. Vanilla slots are still never touched. Plan's 'never overwrite' wording applies only to vanilla and to the export side."
    - "Step 3e routes presets to the per-agent customPresets array (push, not object key set). Daintree-agent fallback to 'claude' added for wrapper/router slots."
    - "Slot-name slug uses {agentName}-{slug}, NOT {vanillaSlotName}-{slug}. With vanilla 'claude-1' + preset 'Z.AI' → 'claude-z-ai', not 'claude-1-z-ai'."
must_haves:
  truths:
    - "Running /nf:link-canopy on a system with Daintree installed (productName Daintree, paths under ~/Library/Application Support/Daintree on macOS / %APPDATA%/Daintree on Windows / ~/.config/Daintree on Linux) detects the install and reads its config.json"
    - "Running /nf:link-canopy on a legacy system with only canopy-app paths (no Daintree) still detects via fallback paths and proceeds — backwards compatibility holds"
    - "The discovery banner displays customPresets, globalEnv keys, and providerTemplates from agentSettings (in addition to existing built-in/user agents)"
    - "Import direction: env overrides from Daintree presets (ANTHROPIC_BASE_URL, model IDs, API keys) are written into matching providers.json slot env blocks WITHOUT overwriting existing non-empty values (idempotent merge)"
    - "Export direction: each selected nForma quorum agent is written to Daintree's customPresets with full env overrides derived from providers.json (model, ANTHROPIC_BASE_URL when applicable, API key var names) and a provider-specific brand color from a fixed mapping table"
    - "Re-running /nf:link-canopy is idempotent — unchanged customPresets show 'unchanged' status, existing entries are not overwritten by default"
    - "onboard.md Step 1 detection includes Daintree alongside the existing CLI/MCP detection, with Daintree path falling back to canopy-app path"
  artifacts:
    - path: "commands/nf/link-canopy.md"
      provides: "Bidirectional sync command with Daintree detection (Daintree-first, canopy-app fallback), customPresets/globalEnv/providerTemplates parsing, env override import into providers.json, customPresets export with brand colors, idempotent re-run logic"
      contains: "Daintree"
      contains_alt: "customPresets"
    - path: "onboard.md"
      provides: "Detection step extended to surface Daintree (or legacy canopy-app) install in the dashboard"
      contains: "Daintree"
    - path: "bin/providers.json"
      provides: "Existing schema — env block on each provider receives merged overrides from Daintree presets when import path runs (no schema change required, env block already exists on every provider)"
      contains: "\"env\":"
  key_links:
    - from: "commands/nf/link-canopy.md (Step 1 discovery)"
      to: "Daintree config.json paths (macOS/Win/Linux) with canopy-app fallback"
      via: "platform-specific path resolution + fs.existsSync chain (try Daintree → fall back to canopy-app)"
      pattern: "Daintree.*canopy-app|fallback"
    - from: "commands/nf/link-canopy.md (Step 2 import)"
      to: "bin/providers.json env blocks"
      via: "Node script: read agentSettings.customPresets + globalEnv + providerTemplates, match preset env keys to provider name, merge into providers[i].env without overwriting non-empty values"
      pattern: "customPresets|globalEnv|providerTemplates"
    - from: "commands/nf/link-canopy.md (Step 3 register)"
      to: "Daintree config.agentSettings.customPresets (in addition to userAgentRegistry)"
      via: "Node script: build customPreset entry per selected quorum slot with {id, name, command, env: {ANTHROPIC_BASE_URL?, MODEL, API_KEY_VAR}, color from BRAND_COLORS map}, skip if id already present"
      pattern: "customPresets\\[.*\\] = "
    - from: "BRAND_COLORS lookup table (inline in link-canopy.md)"
      to: "customPreset.color field"
      via: "lookup by display_provider lowercased — fallback to default #6366f1 if unknown"
      pattern: "BRAND_COLORS|brand_colors"
    - from: "onboard.md Step 1 NF_DETECT script"
      to: "Daintree config detection block"
      via: "additional fs.existsSync check on platform-specific Daintree paths with canopy-app fallback, surfaced under result.daintree"
      pattern: "daintree|Daintree"
  consumers:
    - artifact: "commands/nf/link-canopy.md (slash command body)"
      consumed_by: "Claude Code slash command runtime via /nf:link-canopy invocation"
      integration: "Existing slash command — no new wiring needed; file is invoked directly when user types /nf:link-canopy"
      verify_pattern: "name: nf:link-canopy"
    - artifact: "onboard.md (detection script)"
      consumed_by: "Users pasting onboard.md content into a fresh agent session"
      integration: "Standalone user-invoked doc — Daintree detection is additive within Step 1 and surfaces in Step 2 dashboard"
      verify_pattern: "Daintree"
---

<objective>
> **⚠️ HISTORICAL PLAN.** Body retained for record. Live testing during execution
> surfaced a Daintree v20 schema mismatch (the body below references `globalEnv` and
> `providerTemplates` which don't exist in v20) and a design flaw in the merge-style
> import (would have given Together-routed `ccr-*` slots Anthropic env). The shipped
> implementation uses fan-out semantics with three-layer env composition. See the
> `implementation_evolution` block in this file's frontmatter for the corrections.

Implement bidirectional fleet sync between Daintree (renamed Canopy) presets and nForma providers per issue 138. Update commands/nf/link-canopy.md to detect Daintree paths first (with canopy-app fallback for backwards compat), parse agentSettings (customPresets, globalEnv, providerTemplates), import env overrides into matching providers.json slots without overwriting secrets, export nForma quorum agents back as Daintree customPresets with brand colors derived from a fixed mapping, and ensure idempotent re-runs. Adapt onboard.md Step 1 to detect Daintree alongside CLI detection.

Purpose: Issue 138 acceptance criteria — env overrides flow Daintree → nForma, quorum agents flow nForma → Daintree as customPresets, and the operation is idempotent and brand-aware.

Output: Updated link-canopy.md (sectional deltas, not full rewrite of 513 lines) and updated onboard.md with additive Daintree detection.
</objective>

<execution_context>
@./.claude/nf/workflows/execute-plan.md
</execution_context>

<context>
@.planning/STATE.md
@./CLAUDE.md
@commands/nf/link-canopy.md
@onboard.md
@bin/providers.json
</context>

<tasks>

<task type="auto">
  <name>Task 1: Update link-canopy.md Step 1 discovery — Daintree-first paths with canopy-app fallback, parse customPresets/globalEnv/providerTemplates, expand discovery banner</name>
  <files>commands/nf/link-canopy.md</files>
  <action>
Modify Step 1 of commands/nf/link-canopy.md (lines ~21-142) with a sectional edit. Do NOT rewrite the entire file. Apply these specific deltas:

(a) In the NF_EVAL Node script (lines ~26-95), replace the platform-specific path block with a Daintree-first resolver that falls back to canopy-app:

```js
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
```

Also resolve mcp paths similarly: try `~/.daintree/mcp.json` first, fall back to `~/.canopy/mcp.json`. Same for plugins dir (`~/.daintree/plugins` then `~/.canopy/plugins`).

(b) Extend the `result` object to include:
- `productName` (Daintree or canopy-app)
- `customPresets` (object — from `config.agentSettings.customPresets || {}`)
- `globalEnv` (object — from `config.agentSettings.globalEnv || {}`, keys only or full)
- `providerTemplates` (object — from `config.agentSettings.providerTemplates || {}`)

(c) Update the NOT-FOUND banner (lines ~104-114) to mention Daintree first: "Daintree (or legacy Canopy) config not found at: {daintreeConfigPath} (also tried: {canopyConfigPath})".

(d) Update the DISCOVERED banner (lines ~120-140) to add three new lines after the User Agents line:
```
  Custom Presets ({customPresets keys length}):
    {comma-separated list or "none"}
  Global Env Keys ({globalEnv keys length}):
    {comma-separated list or "none"}
  Provider Templates ({providerTemplates keys length}):
    {comma-separated list or "none"}
```
Also add `Product: {productName}` near the top of the banner so the user sees whether Daintree or legacy canopy-app was detected.

Pass all paths/values through env vars in subsequent Node invocations — never inline-interpolate.

Add no new external dependencies. Use only `fs`, `path`, `os` (already imported).
  </action>
  <verify>
1. `grep -c "Daintree" commands/nf/link-canopy.md` returns >= 5 (path resolver, banners, productName references).
2. `grep -c "canopy-app" commands/nf/link-canopy.md` returns >= 2 (fallback path + not-found banner).
3. `grep -c "customPresets" commands/nf/link-canopy.md` returns >= 3 (parse + banner + downstream use in Tasks 2/3).
4. `grep -c "globalEnv" commands/nf/link-canopy.md` returns >= 2.
5. `grep -c "providerTemplates" commands/nf/link-canopy.md` returns >= 2.
6. `grep -E "resolvePath|productName" commands/nf/link-canopy.md` shows the new resolver function and product name tracking.
7. Manually re-read Step 1 to confirm the Daintree-first / canopy-app-fallback ordering is correct and the banner shows the three new sections.
  </verify>
  <done>
Step 1 detects Daintree first, falls back to canopy-app paths, surfaces productName, customPresets, globalEnv, and providerTemplates in CANOPY_INFO JSON, and displays them in the DISCOVERED banner. NOT-FOUND banner mentions both paths. No other steps modified yet. File still parses as valid markdown with frontmatter intact.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add bidirectional env-override sync to link-canopy.md — Step 2 imports preset env into providers.json (idempotent merge), Step 3 exports quorum slots as customPresets with brand colors</name>
  <files>commands/nf/link-canopy.md</files>
  <action>
Apply two sectional edits to commands/nf/link-canopy.md. Do NOT rewrite untouched portions.

EDIT A — Extend Step 2 (after Step 2b agent import, before or merged into Step 2c) with a new Step 2d "Import preset env overrides into providers.json":

After the existing per-agent import questions, add a new flow:

1. If CANOPY_INFO.customPresets is non-empty, build a list of preset → provider candidate matches. Match heuristic (in order):
   - exact match: preset.id === provider.name (e.g., preset "ccr-1" → provider "ccr-1")
   - prefix match: preset.id starts with provider.name + "-" or vice versa
   - model match: preset.env.MODEL or preset.model equals provider.model
   For each candidate match, list which env keys would be merged into providers[i].env (e.g., ANTHROPIC_BASE_URL, MODEL, *_API_KEY).

2. Display a REVIEW PRESET ENV IMPORT banner showing:
   ```
   Preset → Provider env merges:
     ◆ {preset.id} → {provider.name}
       merge keys: ANTHROPIC_BASE_URL, MODEL  (skipped: API_KEY [already set])
   ```
   Use AskUserQuestion ("Apply", "Cancel — discard"). If "Apply", run a Node script that:
   - Locates providers.json via the same candidate paths used elsewhere in the file (`~/.claude/nf/bin/providers.json`, `~/.claude/nf-bin/providers.json`, and the repo's `bin/providers.json`).
   - Backs up providers.json with `.backup-$(date +%Y-%m-%d-%H%M%S)` suffix BEFORE writing (use cp in a Bash step before the Node call).
   - For each matched provider, merges preset env into providers[i].env using this rule: `if (!current[key] || current[key] === '') current[key] = preset.env[key]; else status='skipped (already set)'`. NEVER overwrite a non-empty existing value (issue 138 AC5 idempotency).
   - Also merges globalEnv keys into every matched provider's env using the same non-overwrite rule, but ONLY for keys that the user explicitly approved (or, for v1, only keys matching pattern `^(ANTHROPIC_|OPENAI_|GOOGLE_|TOGETHER_|MODEL$|.*_BASE_URL$)` to avoid leaking arbitrary env). Choose: gate behind the same Apply confirmation and document the allowlist pattern in the markdown.
   - Returns IMPORT_RESULT with per-provider status array: `{provider, merged: [keys], skipped: [{key, reason}]}`.
   - Pass CANOPY_INFO and a SELECTED_MATCHES JSON via env vars; never interpolate.

3. Display result with ✓ for merged, ○ for skipped (already set / not approved). State count of providers updated.

EDIT B — Extend Step 3 (after Step 3d Canopy config write, around line ~466) with a new Step 3e "Export selected quorum slots as Daintree customPresets":

Define a BRAND_COLORS lookup table inline in the Node script:
```js
const BRAND_COLORS = {
  openai:        '#10a37f',  // OpenAI green
  google:        '#4285f4',  // Google blue
  anthropic:     '#d97757',  // Anthropic clay
  github:        '#181717',  // GitHub black
  xai:           '#000000',  // xAI black
  opencode:      '#f97316',  // OpenCode orange
  together:      '#0f6fff',  // Together.xyz blue
  openrouter:    '#6366f1',  // OpenRouter indigo
  deepseek:      '#22c55e',  // DeepSeek green
  ollama:        '#a855f7',  // Ollama purple
  default:       '#6366f1'   // fallback indigo
};
function colorFor(provider) {
  const key = String(provider || '').toLowerCase();
  return BRAND_COLORS[key] || BRAND_COLORS.default;
}
```

For each selectedSlots entry, in addition to the existing userAgentRegistry write, also build a customPresets entry:

```js
const presetId = 'nf-' + slot.name;
config.agentSettings = config.agentSettings || {};
config.agentSettings.customPresets = config.agentSettings.customPresets || {};

if (config.agentSettings.customPresets[presetId]) {
  registered.push({ id: presetId, kind: 'customPreset', status: 'unchanged' });
} else {
  // Derive env from providers.json provider entry — pull through MODEL, ANTHROPIC_BASE_URL if set, and any *_API_KEY keys (by NAME only — values come from the user's actual env at runtime, not embedded here)
  const providerEntry = providersData.providers.find(p => p.name === slot.name);
  const env = {};
  if (providerEntry?.model)               env.MODEL = providerEntry.model;
  if (providerEntry?.env?.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = providerEntry.env.ANTHROPIC_BASE_URL;
  // Any keys from providerEntry.env matching API_KEY pattern: include the key NAME with value '${...}' placeholder so Daintree resolves from process env
  for (const k of Object.keys(providerEntry?.env || {})) {
    if (/_API_KEY$/.test(k)) env[k] = '${' + k + '}';
  }

  config.agentSettings.customPresets[presetId] = {
    id: presetId,
    name: 'nForma: ' + slot.name,
    command: (slot.cli || providerEntry?.mainTool || 'node').split('/').pop(),
    color: colorFor(providerEntry?.provider || slot.display_provider),
    iconId: 'brain-circuit',
    description: providerEntry?.display_provider + ' — ' + (providerEntry?.model || slot.model),
    env
  };
  registered.push({ id: presetId, kind: 'customPreset', status: 'added' });
}
```

The completion banner ("✓ Agents registered in Canopy") must distinguish userAgentRegistry entries from customPresets entries (two columns), and show "unchanged" rows for already-existing customPresets (idempotency surfacing per issue 138 AC5).

Update the closing summary (Step 4) to add a "Preset env imported: N providers updated" line and a "Custom presets exported: N added, M unchanged" line.

Update the `<success_criteria>` section at the bottom of the file to add:
- "Custom presets, globalEnv, and providerTemplates from Daintree agentSettings are surfaced in discovery banner"
- "Import path merges preset env into matching providers.json slots without overwriting non-empty values"
- "Export path writes nForma quorum slots to Daintree customPresets with provider-specific brand colors from a fixed mapping table"
- "Re-running shows 'unchanged' for existing customPresets — never overwrites by default"
- "Daintree detected first; canopy-app paths used as backwards-compatible fallback"
  </action>
  <verify>
1. `grep -c "BRAND_COLORS" commands/nf/link-canopy.md` returns >= 2 (definition + usage).
2. `grep -c "customPresets" commands/nf/link-canopy.md` returns >= 6 (parse, banner, idempotency check, write, status messages).
3. `grep -E "merge.*env|preset.*env" commands/nf/link-canopy.md` shows the import-direction merge logic.
4. `grep -c "providers.json" commands/nf/link-canopy.md` returns >= 3 (read in Step 3a, write in new Step 2d, backup line).
5. `grep -E "backup-\\\$\\(date" commands/nf/link-canopy.md` shows providers.json backup is taken before write.
6. `grep -c "unchanged" commands/nf/link-canopy.md` returns >= 2 (idempotency status string in result + display).
7. `grep -E "if \\(.*current\\[key\\]" commands/nf/link-canopy.md` (or equivalent) shows the non-overwrite merge guard.
8. `grep -c "AC5\|idempot" commands/nf/link-canopy.md` returns >= 1 (a comment or success-criteria line referencing idempotency).
9. Run `node --check` mental simulation: each new NF_EVAL block is self-contained, reads env vars, writes JSON to stdout, does not throw on missing fields (uses optional chaining and `|| {}`).
10. Visually re-read Step 4 closing summary to confirm new lines for preset env import and custom presets export are present.
  </verify>
  <done>
link-canopy.md contains a Step 2d that imports preset env into providers.json with idempotent merge (never overwrites non-empty existing values, takes backup, restricts globalEnv to allowlist pattern), and Step 3e that exports selected quorum slots to Daintree's customPresets with brand colors from BRAND_COLORS mapping. Re-running shows "unchanged" for existing customPresets. Closing summary lists both new operations. Success criteria section updated to cover all 5 issue 138 acceptance criteria.
  </done>
</task>

<task type="auto">
  <name>Task 3: Update onboard.md Step 1 to additively detect Daintree (with canopy-app fallback) and surface it in the Step 2 dashboard</name>
  <files>onboard.md</files>
  <action>
Apply a single sectional edit to onboard.md. Do NOT rewrite the file (342 lines).

EDIT — Inside the NF_DETECT Node script (Step 1, lines ~20-170), add a new detection block before `// ── Project state ──`:

```js
// ── Daintree (formerly Canopy) IDE detection ──
function daintreeConfigPath(productName) {
  if (process.platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'Application Support', productName, 'config.json');
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), productName, 'config.json');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), productName, 'config.json');
}
const dPath = daintreeConfigPath('Daintree');
const cPath = daintreeConfigPath('canopy-app');
let detectedPath = null, detectedProduct = null, customPresetCount = 0;
if (fs.existsSync(dPath)) { detectedPath = dPath; detectedProduct = 'Daintree'; }
else if (fs.existsSync(cPath)) { detectedPath = cPath; detectedProduct = 'canopy-app (legacy)'; }
if (detectedPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(detectedPath, 'utf8'));
    customPresetCount = cfg.agentSettings && cfg.agentSettings.customPresets
      ? Object.keys(cfg.agentSettings.customPresets).length : 0;
  } catch (e) {}
}
result.daintree = {
  installed: !!detectedPath,
  product: detectedProduct,
  config_path: detectedPath,
  custom_preset_count: customPresetCount
};
```

In Step 2 (status dashboard, lines ~180-205), add a new section between "MCP Servers" and "Project":

```
Daintree IDE
  Detected ................ {Daintree at {path} / canopy-app (legacy) at {path} / not installed}
  Custom Presets .......... {N defined / 0}
  Linked .................. {use /nf:link-canopy to sync}
```

In Step 3 routing logic (the "Unused CLIs detected" section C, around lines ~265-308), add a brief check after the existing CLI cross-reference: if `result.daintree.installed` is true AND `result.nforma.commands_synced` is true, mention to the user:

> I see Daintree (or legacy Canopy) is installed at {config_path} with {custom_preset_count} custom preset(s). Run `/nf:link-canopy` to import preset env overrides into nForma's providers and export nForma's quorum agents back as Daintree customPresets.

Keep the change additive — do NOT remove or restructure existing CLI-detection logic. Just append the new check.
  </action>
  <verify>
1. `grep -c "Daintree" onboard.md` returns >= 5 (detection block, dashboard section, routing-mention, fallback comments, function arg).
2. `grep -c "canopy-app" onboard.md` returns >= 2 (fallback path + dashboard label).
3. `grep -c "customPresets\|custom_preset_count\|Custom Presets" onboard.md` returns >= 3.
4. `grep -E "result\\.daintree" onboard.md` returns >= 1 match — confirms the new result key is set.
5. `grep -c "/nf:link-canopy" onboard.md` returns >= 1 (the new routing mention).
6. Re-read Step 2 dashboard format to confirm the new "Daintree IDE" section appears between MCP Servers and Project.
7. Re-read Step 1 NF_DETECT script to confirm the new block is placed BEFORE the project-state block and uses optional-chain-safe try/catch (does not throw if config is unreadable).
8. Confirm existing CLI / MCP detection blocks are untouched (run `git diff onboard.md` mentally — only additions, no deletions of existing logic).
  </verify>
  <done>
onboard.md Step 1 NF_DETECT script includes a Daintree detection block with canopy-app fallback that populates `result.daintree = { installed, product, config_path, custom_preset_count }`. Step 2 dashboard renders a new "Daintree IDE" section. Step 3 routing mentions /nf:link-canopy when both nForma and Daintree are present. All existing onboarding logic (CLI detection, MCP detection, project state, routes A-F) preserved unchanged.
  </done>
</task>

</tasks>

<verification>
After all three tasks complete, run these end-to-end checks:

1. `wc -l commands/nf/link-canopy.md onboard.md` — confirm files grew (link-canopy.md from ~513 to ~620-700; onboard.md from 342 to ~370-400). If line counts shrank significantly, something was deleted that shouldn't have been.

2. `grep -c "Daintree" commands/nf/link-canopy.md onboard.md` — both files should have multiple Daintree references.

3. Confirm backwards compatibility: `grep -c "canopy-app" commands/nf/link-canopy.md onboard.md` shows >= 2 in each file (path fallback + label).

4. Acceptance criteria coverage trace:
   - AC1 (banner shows customPresets/globalEnv/providerTemplates) → Task 1 verify steps 3-5
   - AC2 (preset env → providers.json) → Task 2 verify steps 3, 7
   - AC3 (nForma agents → Daintree customPresets) → Task 2 verify steps 1, 2
   - AC4 (brand colors per preset) → Task 2 verify step 1 (BRAND_COLORS)
   - AC5 (idempotent re-run) → Task 2 verify steps 6, 7, 8

5. Static lint: `node -e "const md = require('fs').readFileSync('commands/nf/link-canopy.md','utf8'); const yaml = md.match(/^---\\n([\\s\\S]*?)\\n---/); if (!yaml) throw 'frontmatter missing'; console.log('frontmatter OK');"` — confirms YAML frontmatter still parses.

6. Skim test: open commands/nf/link-canopy.md and confirm Steps 1, 2, 2d (new), 3, 3e (new), 4 are in order, with no orphaned code blocks or duplicate section headers.
</verification>

<success_criteria>
- commands/nf/link-canopy.md detects Daintree config first (productName "Daintree") and falls back to canopy-app paths on macOS, Windows, and Linux.
- Discovery banner shows customPresets, globalEnv, and providerTemplates counts (issue 138 AC1).
- Step 2d imports matching preset env keys into providers.json provider env blocks WITHOUT overwriting non-empty values; backup file created before write (issue 138 AC2 + AC5).
- Step 3e exports each selected quorum slot as a Daintree customPreset with env (MODEL, ANTHROPIC_BASE_URL when applicable, *_API_KEY name placeholders) and a brand color from BRAND_COLORS mapping; existing customPresets show "unchanged" status (issue 138 AC3 + AC4 + AC5).
- onboard.md Step 1 detects Daintree (with canopy-app fallback) and Step 2 dashboard surfaces a "Daintree IDE" section with custom preset count.
- Backwards compatibility: any system that has only legacy canopy-app paths still works.
- All edits are sectional/additive — no deletion of existing working logic in either file.
- All Node scripts pass values via env vars (CANOPY_INFO, IMPORTED_AGENTS_JSON, IMPORT_MCP, SELECTED_SLOTS_JSON, plus new SELECTED_MATCHES_JSON) — never interpolated.
- Both files retain valid YAML frontmatter and parse as markdown.
</success_criteria>

<output>
After completion, create `.planning/quick/405-bidirectional-fleet-sync-canopy-presets-/405-SUMMARY.md` recording:
- Sectional edits made to link-canopy.md (cite line ranges before/after)
- Sectional edits made to onboard.md (cite line ranges before/after)
- The BRAND_COLORS mapping table chosen
- The globalEnv allowlist pattern chosen for Step 2d
- Manual test checklist user can run if they have Daintree installed locally
</output>

---
phase: 405-bidirectional-fleet-sync-canopy-presets-
verified: 2026-05-01T11:00:00Z
status: human_needed
score: 7/7 must-haves verified (AC1-AC5 + onboard detection + idempotency); 1 item needs human runtime test
formal_check:
  passed: 2
  failed: 0
  skipped: 0
  counterexamples: []
human_verification:
  - test: "Run /nf:link-canopy on a system with Daintree installed locally"
    expected: "DISCOVERED banner shows Product: Daintree, Custom Presets count, Global Env Keys count, Provider Templates count; Step 2d offers preset->provider env merge with allowlist banner; Step 3d/3e writes customPresets to Daintree config.json with brand colors"
    why_human: "Cannot programmatically execute the slash command runtime; behavior depends on Claude Code's interactive AskUserQuestion dispatch and a real Daintree config on disk"
  - test: "Re-run /nf:link-canopy after presets are exported"
    expected: "Result block shows 'unchanged' for every existing customPresets entry; providers.json env keys that were already non-empty appear in 'skipped (already set)' list"
    why_human: "Runtime idempotency confirmation requires interactive replay (AC5)"
  - test: "Test backwards compatibility — temporarily move ~/Library/Application Support/Daintree to .Daintree-bak"
    expected: "If a legacy ~/Library/Application Support/canopy-app/config.json exists, Product line shows 'canopy-app'; if neither exists, NOT-FOUND banner lists both paths"
    why_human: "Filesystem-state-dependent fallback path; cannot programmatically verify which config is selected at runtime without an actual install"
  - test: "Onboard.md run in fresh agent session with Daintree installed"
    expected: "Step 2 dashboard shows 'Daintree IDE — Detected ... Daintree at <path>' with correct preset count; Step 3 section C mentions /nf:link-canopy with live custom_preset_count"
    why_human: "Onboard.md is a doc invoked by an agent — visual dashboard rendering and routing-text generation cannot be statically verified"
---

# Quick Task 405: Bidirectional Fleet Sync — Verification Report

**Task Goal:** Bidirectional fleet sync between Daintree (renamed Canopy) presets and nForma providers per issue 138. Update `commands/nf/link-canopy.md` to detect Daintree paths first (with canopy-app fallback) and sync presets bidirectionally. Adapt `onboard.md` to detect Daintree install.

**Verified:** 2026-05-01
**Status:** human_needed (all 7 automated truths verified; 4 runtime checks need human)
**Re-verification:** No — initial verification

## Goal Achievement — Observable Truths

| #   | Truth                                                                                                                      | Status     | Evidence                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Running /nf:link-canopy on a Daintree-installed system detects the install and reads its config                            | ✓ VERIFIED | `resolvePath('Daintree')` + `fs.existsSync(daintreeConfigPath)` precedence at link-canopy.md:34-45; productName tracked; `Daintree` count = 21          |
| 2   | Running on a legacy canopy-app system still detects via fallback paths (backwards compat)                                  | ✓ VERIFIED | Fallback at link-canopy.md:44 (`else if (fs.existsSync(canopyConfigPath))`); `canopy-app` count = 11; mcp/plugins fallback at link-canopy.md:48-55      |
| 3   | Discovery banner displays customPresets, globalEnv, providerTemplates from agentSettings                                   | ✓ VERIFIED | link-canopy.md:158-180 banner sections; `customPresets` count = 24, `globalEnv` count = 16, `providerTemplates` count = 5; result obj at lines 71-74 populated |
| 4   | Import direction: preset env → providers.json with idempotent (non-overwrite) merge                                        | ✓ VERIFIED | Step 2d at lines 297-444; non-overwrite guards `if (!current \|\| current === '')` at lines 408 & 415; backup `.backup-$(date +...)` at line 357; `providers.json` count = 28 |
| 5   | Export direction: nForma quorum slots → Daintree customPresets with provider-specific brand colors                         | ✓ VERIFIED | Step 3d/3e at lines 598-742; `BRAND_COLORS` map at lines 623-636 (8+ providers including together.xyz variant); `colorFor()` at line 637; `customPresets[presetId] = {...}` write at line 699; `nf-` + slot.name pattern at line 686 |
| 6   | Re-running /nf:link-canopy is idempotent — unchanged customPresets show 'unchanged' status; existing entries not overwritten | ✓ VERIFIED | Idempotency check `if (config.agentSettings.customPresets[presetId])` at line 687 → status 'unchanged'; `unchanged` count = 7 (status string + display + summary + comments + success_criteria) |
| 7   | onboard.md Step 1 detection includes Daintree alongside CLI/MCP detection, with canopy-app fallback                        | ✓ VERIFIED | Daintree block at onboard.md:153-178 placed before `// ── Project state ──`; populates `result.daintree`; Daintree count = 8, canopy-app count = 3, /nf:link-canopy count = 3, result.daintree count = 3 |

**Score: 7/7 truths verified** (the 4 human-verification items are runtime confirmations of behavior already statically wired in the code).

## Required Artifacts

| Artifact                  | Expected                                                                                                                                            | Status     | Details                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands/nf/link-canopy.md` | Bidirectional sync command with Daintree detection, customPresets/globalEnv/providerTemplates parsing, env import, customPresets export, idempotency | ✓ VERIFIED | 786 lines (was 513; +273). Contains Daintree (21x), customPresets (24x), globalEnv (16x), providerTemplates (5x), BRAND_COLORS (8x). Frontmatter `name: nf:link-canopy` preserved. |
| `onboard.md`              | Detection step extended to surface Daintree with canopy-app fallback                                                                                 | ✓ VERIFIED | 380 lines (was 342; +38). Daintree (8x), canopy-app (3x), result.daintree (3x), /nf:link-canopy (3x). Existing CLI/MCP detection intact (11 references). |
| `bin/providers.json`      | Existing schema — env block on each provider receives merged overrides (no schema change required)                                                  | ✓ VERIFIED | Not modified by this task. Step 2d Node block reads/writes the existing `env` blocks via candidate path resolution.                            |

## Key Link Verification

| From                                            | To                                                  | Via                                                                                            | Status      | Details                                                                                                              |
| ----------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| link-canopy.md Step 1 discovery                 | Daintree config.json paths (macOS/Win/Linux) + fallback | Platform-specific path resolver + `fs.existsSync` chain (Daintree → canopy-app)                | ✓ WIRED     | `resolvePath('Daintree')` at L39, fallback at L44, `productName` tracked through banner                              |
| link-canopy.md Step 2d import                   | bin/providers.json env blocks                       | Node script: read agentSettings.customPresets+globalEnv+providerTemplates, match preset.id to provider.name, merge non-overwrite | ✓ WIRED     | Match heuristic doc'd in markdown L305-311, allowlist L389, merge logic L405-417, providersData write at L423        |
| link-canopy.md Step 3 register                  | Daintree config.agentSettings.customPresets        | Build customPreset entry per slot: {id, name, command, env, color from BRAND_COLORS, iconId, description}; skip if exists | ✓ WIRED     | Idempotency at L687, write at L699, env derivation L693-697, `nf-` + slot.name at L686                               |
| BRAND_COLORS lookup table                       | customPreset.color field                            | Lowercased key lookup; default fallback `#6366f1`                                              | ✓ WIRED     | 11 keyed entries (8 providers + together.xyz variant + opencode + default), `colorFor()` lowercases input            |
| onboard.md Step 1 NF_DETECT                     | Daintree config detection block                     | Additional `fs.existsSync` checks on platform paths + canopy-app fallback, exposed as `result.daintree` | ✓ WIRED     | Block at L153-178, populates `result.daintree.{installed, product, config_path, custom_preset_count}` with try/catch |

## Requirements Coverage

| Requirement   | Source Plan | Description                                                                  | Status      | Evidence                                                                                                  |
| ------------- | ----------- | ---------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| ISSUE-138-AC1 | 405-PLAN    | Discovery banner shows customPresets, globalEnv, providerTemplates           | ✓ SATISFIED | link-canopy.md:170-180 banner; result obj populated at lines 71-74 and 92-98                              |
| ISSUE-138-AC2 | 405-PLAN    | Preset env → providers.json (idempotent merge, no overwrite of non-empty)    | ✓ SATISFIED | Step 2d L297-444; non-overwrite guards L408 & L415; backup L357                                           |
| ISSUE-138-AC3 | 405-PLAN    | nForma quorum slots → Daintree customPresets export                          | ✓ SATISFIED | Step 3d/3e L598-742; customPresets write at L699; env derivation from providers.json L693-697             |
| ISSUE-138-AC4 | 405-PLAN    | Provider-specific brand colors from fixed mapping                            | ✓ SATISFIED | BRAND_COLORS table L623-636 (openai, anthropic, google, github, deepseek, openrouter, ollama, xai, opencode, together, together.xyz, default); colorFor() L637 |
| ISSUE-138-AC5 | 405-PLAN    | Idempotent re-runs — unchanged status; never overwrite by default            | ✓ SATISFIED | customPresets idempotency L687; providers.json idempotency L408/L415; `unchanged` count = 7; allowlist gate L389 |

## Anti-Patterns Found

None. The non-overwrite guards intentionally use `if (!current || current === '')` which is the correct idempotency pattern (not a stub). No TODO/FIXME/PLACEHOLDER markers in the modified files. No empty `=> {}` handlers. All AskUserQuestion options have non-empty answer paths.

## Sectional-Edit / No-Destructive-Delete Verification

- **link-canopy.md grew 513 → 786 lines (+273).** Plan target was ~107-187, actual is +273; the SUMMARY decisions log explains the over-budget delta is from the inline allowlist regex documentation, banner text expansion, two-column result display, and Step 3e implementation notes. Functionally sectional — Step 1, 2a, 2b, 2c, 3a, 3b, 3c, 4 are unchanged in shape; new content lives in Step 1 (resolver + banner sections), Step 2d (new), Step 3d (extended in place), Step 3e (new doc-only section), Step 4 closing additions, success_criteria additions.
- **onboard.md grew 342 → 380 lines (+38), within plan's expected ~28-58 range.**
- **Zero deletions in onboard.md** across all 4 commits (verified via `git show <commit> -- onboard.md | grep -E '^-[^-]' | wc -l` = 0 for each of 24c528af, 4af07112, 7d23f5f3, fc2a0e25). Existing CLI/MCP detection logic intact (11 references to `detectCli`/`result.clis.*`/`result.mcp.configured` preserved).
- **link-canopy.md commit 24c528af** shows `+58/-17` — the 17 deletions are within the path-resolution block being replaced with the resolver function (intentional sectional edit per Task 1 action).
- **link-canopy.md commit 4af07112** shows `+257/-25` — the 25 deletions are inside Step 3d's existing Node block being extended in place to add customPresets write alongside userAgentRegistry write (per the plan's "EDIT B" guidance).
- **Frontmatter preserved:** `name: nf:link-canopy` parses as valid YAML, slash-command name unchanged.
- **Step ordering preserved:** `grep -n '^## Step\|^### Step'` shows 1 → 2a → 2b → 2c → 2d → 3a → 3b → 3c → 3d → 3e → 4 (correct sectional sequence).

## Formal Verification

**Status: PASSED**

| Module      | Property             | Result   | Notes                                                                                              |
| ----------- | -------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| agent-loop  | EventuallyTerminates | ✓ PASSED | WF on DoIteration; terminal states reached. Markdown-only edit; no agent-loop code path modified.  |
| installer   | OverridesPreserved   | ✓ PASSED | Safety property; once `projectOverrides=TRUE`, never cleared. No installer state machine modified. |

| Checks | Passed | Skipped | Failed |
| ------ | ------ | ------- | ------ |
| Total  | 2      | 0       | 0      |

**Counterexamples:** None.

**Formal artifacts compliance:** Plan declared `formal_artifacts: none`. Verified via `git show --stat <commit> -- '.planning/formal/' formal/` for all 4 task commits (24c528af, 4af07112, 7d23f5f3, fc2a0e25) — zero formal/ paths touched. Compliance confirmed.

## globalEnv Allowlist Verification

User-instructed allowlist extension verified at link-canopy.md:316, 329, 389, 777:

```
^(ANTHROPIC_|OPENAI_|GOOGLE_|TOGETHER_|DEEPSEEK_|OLLAMA_|OPENROUTER_|XAI_|MODEL$|.*_BASE_URL$|.*_API_KEY$)
```

All required prefixes present (ANTHROPIC_, OPENAI_, GOOGLE_, TOGETHER_, DEEPSEEK_, OLLAMA_, OPENROUTER_, XAI_, MODEL$, .*_BASE_URL$, .*_API_KEY$). Pattern is rendered verbatim in the markdown REVIEW banner (transparency for the user) and as a JS RegExp at L389 for the merge gate. Covers all 8 BRAND_COLORS providers per the SUMMARY's quorum-self-review correction note.

## Backwards Compatibility

Both files retain `canopy-app` references in the fallback paths and not-found banners:
- link-canopy.md: 11 references (path fallback, banner labels, mcp.json fallback, plugins dir fallback, mcpServers `canopy` key fallback, success_criteria)
- onboard.md: 3 references (canopy-app config path, dashboard label, comment)

Legacy installs without Daintree but with canopy-app paths will still detect successfully.

## Human Verification Required

The 4 items in `human_verification:` frontmatter all require runtime execution of the slash command or the onboard doc against a real (or simulated) Daintree install. Static code paths are correct and wired; the human checks confirm interactive runtime behavior matches.

1. **Live Daintree install — full /nf:link-canopy run** — confirms Step 1 banner sections, Step 2d allowlist banner + merge, Step 3d/3e customPresets write with brand colors.
2. **Idempotency replay** — re-run /nf:link-canopy and confirm `unchanged` rows + `skipped (already set)` keys (AC5 runtime confirmation).
3. **canopy-app fallback** — temporarily move Daintree config aside; confirm `Product: canopy-app` shows on legacy systems.
4. **Onboard.md dashboard rendering** — paste onboard.md in fresh session with Daintree installed; confirm "Daintree IDE" section in dashboard and Section C bridge mention.

## Gaps Summary

No gaps. All 5 issue 138 acceptance criteria (AC1-AC5) are statically wired into the codebase, the user-instructed onboard.md additive Daintree detection is in place, the globalEnv allowlist matches the orchestrator's instructions exactly, formal artifacts compliance is preserved (no .planning/formal/ files modified), backwards compatibility holds via canopy-app fallback, and the formal model checker reported 2 passed / 0 failed / 0 skipped.

The 4 human-verification items are not gaps — they are runtime confirmations of statically-correct code paths that depend on a real Daintree install or interactive AskUserQuestion dispatch.

---

_Verified: 2026-05-01_
_Verifier: Claude (nf-verifier)_

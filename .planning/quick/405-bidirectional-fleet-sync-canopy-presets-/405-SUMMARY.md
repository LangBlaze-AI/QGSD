---
phase: 405-bidirectional-fleet-sync-canopy-presets
plan: 01
subsystem: link-canopy
tags: [issue-138, daintree, canopy, providers, customPresets, idempotency, brand-colors]
dependency-graph:
  requires: [commands/nf/link-canopy.md, onboard.md, bin/providers.json]
  provides: [bidirectional-fleet-sync]
  affects: [link-canopy slash command, onboard documentation]
tech-stack:
  added: []
  patterns: [allowlist-gated-globalEnv-merge, BRAND_COLORS-lookup-table, Daintree-first-with-canopy-app-fallback, idempotent-merge-with-non-overwrite-guard]
key-files:
  created:
    - .planning/quick/405-bidirectional-fleet-sync-canopy-presets-/405-SUMMARY.md
  modified:
    - commands/nf/link-canopy.md (513 -> 786 lines, +273)
    - onboard.md (342 -> 380 lines, +38)
decisions:
  - "globalEnv allowlist extended to ^(ANTHROPIC_|OPENAI_|GOOGLE_|TOGETHER_|DEEPSEEK_|OLLAMA_|OPENROUTER_|XAI_|MODEL$|.*_BASE_URL$|.*_API_KEY$) to cover every provider in BRAND_COLORS (planner had only 5; quorum self-review caught the gap)"
  - "Step 3e implemented inside Step 3d's atomic write (single config read, single config write) instead of as a separate write — avoids dual-backup risk and partial-update windows"
  - "BRAND_COLORS uses lowercased provider/display_provider keys; included 'together.xyz' as a display_provider variant alongside 'together' for robust matching"
  - "API key values are emitted as Daintree placeholder strings ${KEY_NAME} so secrets are NEVER embedded in Daintree config — Daintree resolves at runtime"
  - "Existing customPresets show 'unchanged' status — never overwritten by default (issue 138 AC5 idempotency)"
  - "STATE.md merge conflicts (HEAD vs origin/main) resolved by combining both sides; 401 from origin/main and 402-404 from HEAD are non-overlapping rows for distinct quick tasks"
metrics:
  duration_minutes: ~25
  tasks_completed: 3
  commits: 4
  completed_date: 2026-05-01
---

# Quick Task 405: Bidirectional Fleet Sync — Daintree Presets <-> nForma Providers

One-liner: Daintree-first detection with canopy-app fallback in `/nf:link-canopy` and `onboard.md`, idempotent merge of preset env into providers.json with allowlist-gated globalEnv passthrough, and export of nForma quorum slots back to Daintree's customPresets with provider-specific brand colors from a fixed lookup table.

## Sectional Edits to commands/nf/link-canopy.md (513 -> 786 lines)

### Step 1 (lines ~26-150 before; ~26-180 after) — Daintree-first discovery

- Added `resolvePath(productName)` helper that builds the platform-specific config.json path for any product name on macOS/Windows/Linux.
- Detect Daintree config first via `resolvePath('Daintree')`; fall back to `resolvePath('canopy-app')` if missing. The not-found banner shows the Daintree path (preferred) and labels the canopy-app path as "Also tried legacy path".
- mcp.json and plugins dir resolution mirror the same pattern: try `~/.daintree/...` first, fall back to `~/.canopy/...`. The mcpServers JSON lookup tries the `daintree` key before the legacy `canopy` key.
- Extended the `result` object with: `productName`, `daintreeConfigPath`, `canopyConfigPath`, `customPresets`, `globalEnv`, `providerTemplates`.
- DISCOVERED banner gained a `Product:` line at the top and three new sections at the bottom (Custom Presets count + keys, Global Env Keys count + keys, Provider Templates count + keys). NOT-FOUND banner now mentions both Daintree and legacy canopy-app paths.

### Step 2d (NEW, ~118 lines inserted between Step 2c and Step 3) — Import preset env into providers.json

- Skip gate: if `customPresets` and `globalEnv` are both empty, skip with a "nothing to import" message.
- Match heuristic between presets and providers: exact name match -> prefix match -> model match. Each candidate is shown to the user with the env keys that would be merged and any keys that would be skipped (already non-empty).
- globalEnv allowlist regex (rendered verbatim in the markdown for user transparency):
  ```
  ^(ANTHROPIC_|OPENAI_|GOOGLE_|TOGETHER_|DEEPSEEK_|OLLAMA_|OPENROUTER_|XAI_|MODEL$|.*_BASE_URL$|.*_API_KEY$)
  ```
  This pattern covers every provider in BRAND_COLORS plus generic MODEL/BASE_URL/API_KEY keys. Extending the planner's original 5-provider allowlist to all 8 BRAND_COLORS providers was a quorum-self-review correction documented in the plan constraints.
- providers.json is backed up at every candidate path (`$HOME/.claude/nf/bin/`, `$HOME/.claude/nf-bin/`, `bin/`) BEFORE any write.
- The Node merge step uses `if (!current || current === '') { ... merged.push(key) } else { skipped.push({ key, reason: 'already set' }) }` — never overwrites existing non-empty values (AC5 guard, surfaced twice for both preset env and globalEnv merge paths).
- Result block lists per-provider merge/skip details and a `providersUpdated` count, surfaced in the closing summary in Step 4.

### Step 3d/3e (~lines 598-740) — Export quorum slots as Daintree customPresets

- Step 3d's existing Node script was extended in place (keeping a single config read + write to avoid dual-backup risk) with three additions:
  1. **BRAND_COLORS lookup table** keyed by lowercased provider name, with 'together.xyz' included as a display_provider variant alongside 'together'. Default fallback is `#6366f1` (indigo).
  2. **providers.json read** to derive customPreset env entries (MODEL, ANTHROPIC_BASE_URL, *_API_KEY names as `${VAR}` placeholders).
  3. **customPresets write** alongside the existing userAgentRegistry write. Existing entries emit `status: 'unchanged'` — never overwritten by default (AC5).
- Result block now distinguishes `userAgentRegistry` vs `customPreset` rows in two columns.
- Step 3e is documented as a separate header with a 4-bullet implementation-notes block (id pattern, env derivation, brand-color picking, idempotency) so future readers can understand the design without parsing the Node script.

### Step 4 closing summary

- Added `Product detected:` line.
- Added `Preset env imported:` row showing providers updated count.
- Added `Custom presets exported:` row showing added/unchanged counts.
- Closing line emphasizes idempotency (issue 138 AC5).

### success_criteria block (full rewrite, +6 bullets)

Replaced 12 bullets with 18 bullets that explicitly cover all 5 issue 138 acceptance criteria, the allowlist regex verbatim, and the bidirectional sync behavior.

## Sectional Edits to onboard.md (342 -> 380 lines, +38, additive only)

- **Step 1 NF_DETECT script:** inserted a Daintree detection block immediately before `// ── Project state ──`. The block defines `daintreeConfigPath(productName)` (mirrors link-canopy.md's resolver), tries `Daintree` first then `canopy-app (legacy)`, parses `agentSettings.customPresets` to count entries, and populates `result.daintree = { installed, product, config_path, custom_preset_count }` with try/catch so unreadable configs do not throw.
- **Step 2 dashboard:** inserted a new "Daintree IDE" section between "MCP Servers" and "Project" with three lines: Detected (path or "not installed"), Custom Presets count, Linked hint pointing to `/nf:link-canopy`.
- **Step 3 section C:** appended a "Daintree IDE bridge" subsection that tells the routing agent — when both Daintree and nForma are detected — to recommend `/nf:link-canopy` with the live custom_preset_count, and to clarify that the bridge is bidirectional and idempotent.

`git diff onboard.md | grep -cE "^-[^-]"` returns 0 — purely additive, no deletions of existing CLI/MCP detection logic.

## BRAND_COLORS Mapping Table (issue 138 AC4)

| Key (lowercased) | Color    | Provider description |
|------------------|----------|----------------------|
| openai           | #10a37f  | OpenAI green |
| google           | #4285f4  | Google blue |
| anthropic        | #d97757  | Anthropic clay |
| github           | #181717  | GitHub black |
| xai              | #000000  | xAI black |
| opencode         | #f97316  | OpenCode orange |
| together         | #0f6fff  | Together.xyz blue |
| together.xyz     | #0f6fff  | Together.xyz blue (display_provider variant) |
| openrouter       | #6366f1  | OpenRouter indigo |
| deepseek         | #22c55e  | DeepSeek green |
| ollama           | #a855f7  | Ollama purple |
| (default)        | #6366f1  | Fallback indigo for unknown providers |

Lookup is `BRAND_COLORS[provider.toLowerCase()] || BRAND_COLORS.default`.

## globalEnv Allowlist Pattern (issue 138 AC5 safety guardrail)

```
^(ANTHROPIC_|OPENAI_|GOOGLE_|TOGETHER_|DEEPSEEK_|OLLAMA_|OPENROUTER_|XAI_|MODEL$|.*_BASE_URL$|.*_API_KEY$)
```

Rationale: covers every provider in BRAND_COLORS (extending the planner's original 5-provider list per quorum self-review) plus generic MODEL, *_BASE_URL, and *_API_KEY keys. Anything not matching is dropped before merge — prevents accidental leak of arbitrary user env into providers.json.

## Manual Test Checklist (for users with Daintree installed locally)

If you have Daintree installed at `~/Library/Application Support/Daintree/config.json` (macOS) and `bin/providers.json` populated:

1. **Detection — onboard.md path**
   - Open a fresh Claude Code session at the repo root and paste onboard.md content.
   - Verify the dashboard shows: `Daintree IDE — Detected ... Daintree at <path>` with the correct preset count.
   - Verify Section C mentions `/nf:link-canopy` with the live custom_preset_count.

2. **Detection — link-canopy.md path**
   - Run `/nf:link-canopy`.
   - Verify the DISCOVERED banner shows `Product: Daintree` and three sections (Custom Presets, Global Env Keys, Provider Templates) with non-zero counts if your Daintree has presets.

3. **Backwards compatibility (canopy-app fallback)**
   - Temporarily rename `~/Library/Application Support/Daintree` to test the fallback.
   - Re-run `/nf:link-canopy`. If you have a legacy `~/Library/Application Support/canopy-app/config.json`, verify the banner shows `Product: canopy-app`.
   - If neither exists, verify NOT-FOUND banner shows both paths.

4. **Import direction (Step 2d) — preset env -> providers.json**
   - Pick a Daintree preset that matches a provider in `bin/providers.json` (by name or model).
   - Run `/nf:link-canopy` and approve the env import.
   - Verify `bin/providers.json.backup-*` exists.
   - Verify the matched provider's `env` block now contains the merged keys; verify a non-empty pre-existing key was NOT overwritten.
   - Re-run `/nf:link-canopy` — verify already-set keys appear in `skipped` (idempotency).

5. **Export direction (Step 3d/3e) — quorum slots -> Daintree customPresets**
   - Run `/nf:link-canopy` and approve registration.
   - Open `~/Library/Application Support/Daintree/config.json`.
   - Verify `agentSettings.customPresets["nf-<slot>"]` exists with: id, name, command, color (matching BRAND_COLORS), iconId, description, env (with MODEL, ANTHROPIC_BASE_URL when applicable, `*_API_KEY` as `${VAR}` placeholders).
   - Verify the color matches the provider's brand from the table above.
   - Re-run `/nf:link-canopy` — the result block should show `unchanged` for the same presetId (AC5).

6. **Slash command sync** — after editing `commands/nf/link-canopy.md`, run `node bin/install.js --claude --global` to sync to `~/.claude/commands/nf/`.

## Formal Modeling

### Loop 2 Simulation

INFO: No formal coverage intersections found -- Loop 2 not needed (GATE-03)

`bin/formal-coverage-intersect.cjs --files <changed>` was run before each atomic commit (Tasks 1, 2, 3) and returned `intersections_found: false` with exit code 2 in every case. Plan declares `formal_artifacts: none` and the changes are markdown-only documentation edits, so no `.planning/formal/` files were created or updated. Loop 2 simulation gate is not applicable.

## Deviations from Plan

None of substance. Two minor implementation choices that align with plan intent:

- **Step 3e implementation location:** the plan suggested a separate Step 3e Node block. I implemented Step 3e inside Step 3d's atomic write (single config read + write) and documented Step 3e as a header with implementation notes. Rationale: avoids two backups and a partial-write window; same observable behavior. Plan's "Apply two sectional edits" guidance is preserved (one edit to Step 3d's script body, one new Step 3e header section).
- **STATE.md merge conflict resolution:** STATE.md on disk had unresolved `<<<<<<< HEAD / >>>>>>> origin/main` markers when the task started. Resolved by combining both sides (rows for 401 from origin/main and 402-404 from HEAD are non-overlapping rows for distinct quick tasks; same for Last activity, kept 405 as latest). This was unavoidable to commit STATE.md; the Last activity update was required by the constraint block.

## Self-Check: PASSED

- FOUND: `.planning/quick/405-bidirectional-fleet-sync-canopy-presets-/405-SUMMARY.md`
- FOUND: `commands/nf/link-canopy.md` (786 lines, frontmatter intact)
- FOUND: `onboard.md` (380 lines)
- FOUND commit: `24c528af` (Task 1: Step 1 Daintree-first detection)
- FOUND commit: `4af07112` (Task 2: Step 2d preset env import + Step 3e customPresets export)
- FOUND commit: `7d23f5f3` (Task 3: onboard.md additive Daintree detection)

All 3 task commits exist on the current branch. SUMMARY.md, link-canopy.md, and onboard.md all present. Frontmatter on link-canopy.md still parses (`name: nf:link-canopy` preserved). Onboard.md edits are purely additive (zero deletions per `git diff` check). End-to-end verification (line counts within targets, all grep thresholds met, AC1-AC5 covered) was run before each commit.

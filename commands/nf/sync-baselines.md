---
name: nf:sync-baselines
description: Sync baseline requirements into .planning/formal/requirements.json (auto-detects project intent by default)
argument-hint: [--profile <web|mobile|desktop|api|cli|library>]
allowed-tools:
  - Read
  - Bash
  - AskUserQuestion
---

<objective>
Sync baseline requirements from the nForma defaults into `.planning/formal/requirements.json`. Auto-detects project intent by default by scanning the repo for framework, deployment, and configuration signals. Supports explicit `--profile` override. Runs `node bin/sync-baseline-requirements.cjs`, displays results, and commits if requirements were added.
</objective>

<process>

## Step 1: Detect Intent

If `--profile` in $ARGUMENTS, skip detection and jump to Step 3.

Otherwise, run auto-detection first (read-only, no sync yet):

```bash
node bin/detect-project-intent.cjs --root . --json > /tmp/detection.json
DETECTION=$(cat /tmp/detection.json)
```

Display signals table to user from `signals` array (dimension, confidence, evidence).
Display suggested profile: `Detected profile: <base_profile>`.

## Step 2: Confirm Intent

If `needs_confirmation` array is non-empty, ask user:

```
AskUserQuestion([{
  header: "Confirm Project Intent",
  question: "Auto-detected base profile: <base_profile>. Is this correct?",
  multiSelect: false,
  options: [
    { label: "Accept", description: "Use auto-detected intent as-is" },
    { label: "Customize", description: "Choose a different profile" },
    { label: "Cancel", description: "Skip baseline sync" }
  ]
}])
```

If "Customize", ask for profile selection (same AskUserQuestion as below), then use `--profile` in Step 3.
If "Cancel", exit.
If "Accept", proceed to Step 3 with no flags (auto-detect default).

If `needs_confirmation` is empty (all high confidence), proceed directly to Step 3 without asking.

## Step 3: Run Sync

If --profile was given or chosen via customize:

```bash
node bin/sync-baseline-requirements.cjs --profile "$PROFILE" --json
```

Otherwise (auto-detect default):

```bash
node bin/sync-baseline-requirements.cjs --json
```

Parse JSON output. Display human-readable summary:

```
Baseline sync complete (<mode>)
  Added:   N new requirements
  Skipped: M (already present)
  Total:   K requirements
```

If added > 0, list each: `+ [ID] text`

## Step 4: Store Intent (if auto-detected)

If intent was auto-detected (no --profile flag), persist to config:

```bash
NF_INTENT='<detected_intent_json>' node -e "
const fs = require('fs');
const configPath = '.planning/config.json';
let config = {};
try { if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) { /* malformed config → start fresh rather than crash */ }
const intent = JSON.parse(process.env.NF_INTENT);
config.intent = intent;
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
"
```

## Step 5: Commit if Needed

If `added.length > 0`:

```bash
node ~/.claude/nf/bin/nf-tools.cjs commit "req(baseline): sync N baseline requirements" --files .planning/formal/requirements.json
```

Also commit config if intent was stored:

```bash
node ~/.claude/nf/bin/nf-tools.cjs commit "chore(baseline): store detected project intent" --files .planning/config.json
```

Where N is the count of added requirements.

If `added.length === 0`: display "No new requirements to sync -- .planning/formal/requirements.json is up to date."

</process>

<success_criteria>
- [ ] sync-baseline-requirements.cjs ran without error
- [ ] Results displayed with added/skipped counts
- [ ] .planning/formal/requirements.json committed if changed
</success_criteria>

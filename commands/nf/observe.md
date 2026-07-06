---
name: nf:observe
description: Fetch issues and drifts from configured sources, render dual-table output, and write to debt ledger. Replaces /nf:triage.
argument-hint: "[--source github|sentry|sentry-feedback|bash|internal] [--since 24h|7d] [--limit N]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Task
  - AskUserQuestion
---

<objective>
Aggregate issues and drifts from all configured sources, deduplicate, render a prioritized dual-table output (Issues + Drifts), write observations to the debt ledger, and route the selected issue to the right nForma workflow.

This command is the project's unified "what's broken right now?" entry point. It replaces `/nf:triage` with debt-aware persistence and dual-table rendering.
</objective>

<process>

## Step 1: Parse arguments

From `$ARGUMENTS`, extract:
- `--source <type>` → `$SOURCE_FILTER` (filter to one source type; default: all)
- `--since <duration>` → `$SINCE_OVERRIDE` (e.g. `24h`, `7d`; overrides per-source config)
- `--limit <n>` → `$LIMIT_OVERRIDE` (max issues per source; default: 10)

## Step 2: Load source configuration

Use `loadObserveConfig()` from `observe-config.cjs` to load sources.

All bare `./bin/` require paths must resolve portably: try `$HOME/.claude/nf-bin/` first, fall back to `./bin/`. Use this helper at the top of any node -e snippet:
```javascript
const _nfBin = (n) => { const p = require('path').join(require('os').homedir(), '.claude/nf-bin', n); return require('fs').existsSync(p) ? p : './bin/' + n; };
```

```javascript
const _nfBin = (n) => { const p = require('path').join(require('os').homedir(), '.claude/nf-bin', n); return require('fs').existsSync(p) ? p : './bin/' + n; };
const { loadObserveConfig } = require(_nfBin('observe-config.cjs'));
const config = loadObserveConfig();
// config = { sources, configFile, observeConfig, error? }
```

The loader automatically:
1. Tries `.planning/observe-sources.md` first, falls back to `.planning/triage-sources.md` (backward compatible)
2. Parses YAML frontmatter to extract sources array
3. Infers `issue_type` for known source types (github/sentry/bash → "issue", prometheus/grafana/logstash → "drift")
4. Applies default timeout and fail_open settings

**If no config file exists or error is returned:**

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma > OBSERVE: No sources configured
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Create .planning/observe-sources.md to configure issue sources.
```
Stop.

**If `$SOURCE_FILTER` is set**, keep only sources whose `type` matches.

**Always-on internal source:** Regardless of config or filters, inject an internal work detection source:

```javascript
// Inject internal scanner unconditionally (always-on, no config needed)
const internalSource = { type: 'internal', label: 'Internal Work', issue_type: 'issue' };
// Add to sources array if not already present and not filtered out by --source
if (!$SOURCE_FILTER || $SOURCE_FILTER === 'internal') {
  config.sources.push(internalSource);
}

// Critical: check for empty sources AFTER internal injection
if (config.sources.length === 0) {
  // Display "no sources" message only if sources is empty AFTER internal source injection
  display("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n nForma > OBSERVE: No sources configured\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nCreate .planning/observe-sources.md to configure issue sources.");
  stop();
}
```

This ensures internal work detection runs even if observe-sources.md doesn't exist or if the user filters to `--source internal`.

## Step 3: Register handlers

Use the shared pipeline to register ALL handlers (core + production drift). This ensures handler registration stays in sync with `/nf:solve-diagnose` which uses the same pipeline.

```javascript
const { registerAllHandlers } = require(_nfBin('observe-pipeline.cjs'));
const registry = registerAllHandlers();
```

Display dispatch header:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma > OBSERVE: Fetching from N source(s)...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Step 3b: Tooling preflight (CLI-backed sources)

Some sources are backed by an external CLI rather than a plain HTTP endpoint:
the Sentry sources (`sentry`, `sentry-feedback`) lean on `sentry-cli`, and the
Grafana source on `gcx` (the Grafana Cloud CLI). Detect whether those CLIs are
installed and authenticated **before** dispatch, so that when one of those
sources errors we can tell "this is real drift" apart from "the CLI is missing
or you never logged in".

```javascript
const { detectObserveTooling, renderToolingStatus } = require(_nfBin('observe-tooling.cjs'));
const toolingStatus = detectObserveTooling(); // shells out to `<cli> --version` + an auth probe; fail-open

// Only surface tools that back at least one configured source (avoid noise when,
// e.g., no grafana source is configured). configuredTypes = set of source.type values.
const configuredTypes = new Set(config.sources.map(s => s.type));
const relevant = toolingStatus.filter(s => s.sources.some(t => configuredTypes.has(t)));
if (relevant.length > 0) display(renderToolingStatus(relevant));
```

`detectObserveTooling()` returns one status per tool:
`{ name, installed, authed, healthy, version, sources, hint }`. It never throws —
a missing binary, a crashed probe, or an odd exit code all degrade to
`installed:false` / `healthy:false`. Keep `toolingStatus` in scope for Step 4c.

## Step 4: Dispatch parallel fetch

Call `dispatchAll()` from `bin/observe-registry.cjs` — this dispatches ALL sources uniformly through the registry with per-source timeout. No special-casing per source type at this stage.

```javascript
const { dispatchAll } = require(_nfBin('observe-registry.cjs'));
const results = await dispatchAll(config.sources, { sinceOverride: $SINCE_OVERRIDE, limitOverride: $LIMIT_OVERRIDE });
```

This uses `Promise.allSettled` internally — one source failure does not block others (OBS-08).

## Step 4b: MCP bridge for pending_mcp results

After `dispatchAll` returns, iterate over results. For any result with `status: "pending_mcp"`:

1. Read the `_mcp_instruction` object from the result:
   ```javascript
   const { tool, params, mapper } = result._mcp_instruction;
   ```

2. Execute the MCP tool call directly (the observe command runs in Claude context where MCP tools are available). Call the tool named in `_mcp_instruction.tool` with `_mcp_instruction.params`. Try `mcp__sentry__<tool>` first, then `mcp__plugin_sentry_sentry__<tool>` as fallback.

3. Import the mapper function from `bin/observe-handlers.cjs`:
   ```javascript
   const handlers = require(_nfBin('observe-handlers.cjs'));
   const mapperFn = handlers[mapper]; // e.g., mapSentryIssuesToSchema or mapSentryFeedbackToSchema
   ```

4. Call the mapper with the MCP result and the original sourceConfig:
   ```javascript
   const mapped = mapperFn(mcpResult, sourceConfig);
   // mapped = { source_label, source_type, status: "ok", issues: [...] }
   ```

5. Replace the `pending_mcp` result in the results array with the mapped standard schema result.

6. If the MCP call fails, replace with:
   ```javascript
   { source_label, source_type, status: "error", error: "MCP call failed: {message}", issues: [] }
   ```

**Key principle:** This pattern keeps handlers as pure testable CJS functions while the observe command (running in Claude context) handles MCP execution. The registry's `dispatchAll` works uniformly — the MCP bridge is a post-processing step.

## Step 4c: Attribute errored sources to missing/unauthed tooling

Before rendering, annotate any errored result whose source type is backed by an
unhealthy CLI (from Step 3b). This turns an opaque grafana/sentry fetch error
into an actionable "likely tooling, not drift" hint instead of surfacing it as
noise.

```javascript
const { annotateResultsWithTooling } = require(_nfBin('observe-tooling.cjs'));
annotateResultsWithTooling(results, toolingStatus); // mutates results in place; only touches status:'error' rows
```

For any result that now carries a `tooling_hint`, display it under the error
section (e.g. `⚠ grafana: gcx not installed — this error is likely tooling, not
drift. Fix: brew install grafana/grafana/gcx`). A result whose backing CLI is
healthy is left untouched — its error is treated as real.

## Step 5: Collect and render

Call `renderObserveOutput()` from `bin/observe-render.cjs`:

```javascript
const { renderObserveOutput } = require(_nfBin('observe-render.cjs'));
const output = renderObserveOutput(results);
```

At this point ALL results are standard schema (pending_mcp results were resolved in Step 4b).

The renderer:
1. Separates successful results from errors
2. Splits issues by `issue_type`: "issue" items and "drift" items
3. Sorts each group by severity (error > bug > warning > info), then by age (newest first)
4. Renders ISSUES table with columns: #, Title, Source, Sev, Age
5. Renders DRIFTS table (if any) with columns: #, Parameter, Formal, Actual, Sev
6. Renders error section at bottom listing failed sources

Display the output.

If total issues = 0 and no drifts:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma > OBSERVE: All clear — no open issues found
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sources checked: <list>
```
Stop.

## Step 5b: Run analysis tools

After rendering the observe output, run supplementary analysis tools to enrich the observation context. Each tool is optional — if not found, skip silently (fail-open).

**Observed-behavior FSM derivation:**
```bash
node bin/observed-fsm.cjs --json 2>/dev/null || true
```
Derives an observed-behavior FSM from trace data. Useful for detecting state-transition anomalies that may correlate with observed issues. If JSON output is valid, log: `"Observed FSM: {state_count} states, {transition_count} transitions derived from traces"`

**Sensitivity sweep feedback:**
```bash
node bin/sensitivity-sweep-feedback.cjs 2>/dev/null || true
```
Compares empirical true-positive rate with sensitivity sweep predictions. If a deviation is detected, logs a warning that threshold calibration may need updating. This feeds back into the observe loop by surfacing issues with the observation pipeline itself.

**Security sweep:**
```bash
node bin/security-sweep.cjs --json 2>/dev/null || true
```
Runs a standalone security scan across the codebase. If findings are returned, inject them as additional issues with `source_type: 'internal'` and `severity: 'warning'` into the results array before the "Write to debt ledger" step processes them.

## Step 6a: Write to debt ledger

Call `writeObservationsToDebt()` from `bin/observe-debt-writer.cjs`:

```javascript
const { writeObservationsToDebt } = require(_nfBin('observe-debt-writer.cjs'));

// Collect all issues from all successful results
const allObservations = results
  .filter(r => r.status === 'ok')
  .flatMap(r => r.issues || []);

const { written, updated, errors } = writeObservationsToDebt(allObservations, '.planning/formal/debt.json');
```

Display:
```
Wrote {written} new, updated {updated} existing debt entries.
```

This upserts all observations by fingerprint (using v0.27-01's `fingerprintIssue` and `fingerprintDrift` functions). Same issues across runs update `occurrences` and `last_seen`, not duplicates.

## Step 6b: Show debt summary

Read the debt ledger and display status counts:

```javascript
const { readDebtLedger } = require(_nfBin('debt-ledger.cjs'));
const ledger = readDebtLedger('.planning/formal/debt.json');
const entries = ledger.debt_entries || [];

const counts = {
  open: entries.filter(e => e.status === 'open').length,
  acknowledged: entries.filter(e => e.status === 'acknowledged').length,
  resolving: entries.filter(e => e.status === 'resolving').length,
  resolved: entries.filter(e => e.status === 'resolved').length
};
```

Display:
```
Debt ledger: {open} open, {acknowledged} acknowledged, {resolving} resolving, {resolved} resolved
```

## Step 7: Route to action

Prompt the user:

```
Enter issue # to work on, "ack N" to acknowledge, "solve" for all internal issues, "solve N,M,..." to route selected issues, "all" for full details, or press Enter to skip:
```

**If user enters a number:**
- Load the full issue details (title, URL, meta) for that index.
- Determine routing:
  - If the issue has `source_type: 'internal'` and `_route` metadata: use the `_route` value as the suggested action (example: unfinished quick task suggests `/nf:quick "original-slug"`, debug session suggests `/nf:debug --resume`)
  - If the issue has `issue_type: 'upstream'`: route to **upstream evaluation** (see below)
  - Otherwise, routing by severity:
    - `severity: error` or `severity: bug` → suggest `/nf:debug`
    - `severity: warning` or `severity: info` → suggest `/nf:quick`
- Display:
  ```
  ◆ Issue: <title>
    URL: <url>
    Meta: <meta>

  Suggested action: /nf:debug "<title> — <meta>"
  Run it? [Y/n]
  ```
- If confirmed, invoke the suggested skill with the issue as context.

**Upstream evaluation routing (issue_type: 'upstream'):**

When the user selects an upstream item, do NOT blindly suggest porting it. Instead:

1. Fetch the release notes or PR diff from the upstream URL (use `gh release view <tag> --repo <repo> --json body` or `gh pr view <number> --repo <repo> --json body,files`)
2. Identify the areas of our codebase that overlap with the upstream change
3. **Compare quality**: For each overlapping area, assess whether:
   - Our implementation is already equivalent or better → `SKIP` (we diverged for good reason or already have it)
   - The upstream change introduces something we lack → `CANDIDATE` (worth porting)
   - The upstream change conflicts with our architecture → `INCOMPATIBLE` (their approach doesn't fit our patterns)
4. Display the evaluation:
   ```
   ◆ Upstream: <title>
     Source: <repo> <tag or #PR>
     URL: <url>

     Evaluation:
     ┌─────────────────────────────────────────────────┐
     │ Area              │ Ours  │ Theirs │ Verdict     │
     ├─────────────────────────────────────────────────┤
     │ hook registration │ ✓     │ ✓      │ SKIP        │
     │ error retry logic │ basic │ exp-bo │ CANDIDATE   │
     │ config format     │ YAML  │ TOML   │ INCOMPATIBLE│
     └─────────────────────────────────────────────────┘

     Candidates for porting: 1 of 3 areas
   ```
5. If there are CANDIDATE items, ask: `Port candidate changes? [Y/n]`
   - If yes → suggest `/nf:quick "port <area> from <repo> <tag>"` for each candidate

**If user enters "solve" followed by numbers (e.g., "solve 1,3,5" or "solve 1-3,7"):**
- Import the pipe bridge:
  ```javascript
  const { parseIssueSelection, buildTargetsManifest, writeTargetsManifest } = require(_nfBin('observe-solve-pipe.cjs'));
  ```
- Call `parseIssueSelection(userInput, allIssues.length)` to get selected zero-based indices
- If no valid indices, display: `"No valid issue numbers in selection. Try again."` and re-prompt
- Map indices to the actual issue objects from the rendered issues list (the same numbered list shown in the ISSUES table)
- Call `buildTargetsManifest(selectedIssues)` then `writeTargetsManifest(manifest)`
- Display:
  ```
  Piping {N} issue(s) to /nf:solve as targets:
    - #{idx}: {title}
    ...
  Targets written to .planning/observe-targets.json
  ```
- Invoke `/nf:solve --targets=.planning/observe-targets.json`

**If user enters "solve" (bare, no numbers):**
- Collect all issues with `source_type: 'internal'`
- Display: `Routing all internal issues to /nf:solve...`
- Invoke `/nf:solve` to address all internal consistency issues at once

**If user enters "ack N":**
- Acknowledge the debt entry for issue #N (transition status from "open" to "acknowledged" via the debt state machine).
- Display: `Acknowledged: <title>`

**If user enters "all":**
- Print the full metadata for each issue (title, URL, meta, created_at) as a numbered list.
- Then re-prompt for a number.

**If user presses Enter (blank):**
```
Observe complete. Run /nf:observe again when ready.
```

</process>

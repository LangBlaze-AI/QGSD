---
name: nf:proximity
description: Run the proximity graph pipeline — build graph, discover unlinked pairs, evaluate semantically, generate pairings
argument-hint: "[--rebuild] [--min-score N] [--max-hops N] [--top N] [--non-neighbor-top N] [--skip-eval] [--resolve]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
---

<objective>
Orchestrate the 5-step proximity pipeline. Build a semantic graph of model-requirement relationships, discover candidates with unmet links, evaluate using Haiku, compute semantic scores, and generate proximity pairings. Display progress and a summary dashboard showing metrics at each stage.
</objective>

<execution_context>
Self-contained pipeline of existing scripts. No external context needed.
</execution_context>

<process>

## Step 1: Parse arguments

Extract from `$ARGUMENTS`:
- `--rebuild` → force graph rebuild (delete existing proximity-index.json)
- `--min-score <N>` → minimum proximity score threshold (default: 0.6)
- `--max-hops <N>` → maximum graph hops for candidate discovery (default: 3)
- `--top <N>` → return only top N candidates by proximity score (default: 0 = no limit — let the ensemble + Haiku evaluation handle filtering)
- `--non-neighbor-top <N>` → include top N non-neighboring pairs by coverage gap (default: 20)
- `--skip-eval` → skip Haiku semantic evaluation step
- `--resolve` → suggest /nf:resolve at end of pipeline

Store parsed flags for use in downstream steps.

## Step 2: Build proximity graph

Run (portable — installed nf-bin primary, repo CWD fallback):
```bash
NFBIN="$HOME/.claude/nf-bin"; [ -f "$NFBIN/formal-proximity.cjs" ] || NFBIN="./bin"
node "$NFBIN/formal-proximity.cjs"
```

- **If graph exists and `--rebuild` NOT set:** Skip build, report cached graph stats: "Graph cached (N nodes, E edges, U orphans)"
- **If `--rebuild` is set:** Delete `.planning/formal/proximity-index.json` first, then run builder
- **Display:** Node count, edge count, orphan node count from builder output
- **On error:** Halt and display error message

Progress line: `[1/6] Building proximity graph...`

## Step 2.5: Build embedding cache (auto-detected)

Check if `@huggingface/transformers` is installed and embedding cache is missing or stale:

```bash
node -e "require('@huggingface/transformers')" 2>/dev/null
```

- **If dependency is NOT installed:** Skip silently (embeddings are optional).
- **If dependency IS installed but `.planning/formal/embedding-cache.json` is missing or `--rebuild` is set:**
  - Run (portable):
    ```bash
    NFBIN="$HOME/.claude/nf-bin"; [ -f "$NFBIN/proximity-embed.mjs" ] || NFBIN="./bin"
    node "$NFBIN/proximity-embed.mjs" --cache-only
    ```
  - Display: "Building embedding cache (local CPU, ~30s)..."
  - On completion: report vector count from output
- **If cache exists and `--rebuild` NOT set:** Skip, report: "Embedding cache loaded (N vectors)"

Progress line: `[1.5/6] Checking embeddings...`

> The candidate discovery step automatically uses the amplified ensemble (with embedding similarity) when the cache is present. No flags needed.

## Step 3: Discover candidates

Run (portable):
```bash
NFBIN="$HOME/.claude/nf-bin"; [ -f "$NFBIN/candidate-discovery.cjs" ] || NFBIN="./bin"
node "$NFBIN/candidate-discovery.cjs" --min-score <val> --max-hops <val> --top <val> --non-neighbor-top <val> --json
```

- Pass `--min-score` and `--max-hops` from parsed arguments
- If `--top` not specified by user, pass `--top 0` (no limit — ensemble naturally caps at ~100 candidates)
- Pass `--non-neighbor-top` from parsed arguments (default: 20)
- Display candidate count: "Found N graph candidates. Orphans: X models, Y requirements" (read `orphan_models_count` and `orphan_requirements_count` from metadata, or count from `orphans.models` and `orphans.requirements` arrays)
- Display score distribution histogram (5 buckets: <0.4, 0.4-0.6, 0.6-0.8, 0.8-0.95, >=0.95)
- **On error:** Halt and display error message

Progress line: `[2/6] Discovering unlinked candidates...`

## Step 4: Haiku semantic evaluation

If `--skip-eval` is set:
- Report: "Skipped (--skip-eval)"
- Continue to step 5

Otherwise, attempt the script first:

**4a. Try script:**
- Run (portable) via Bash:
```bash
NFBIN="$HOME/.claude/nf-bin"; [ -f "$NFBIN/haiku-semantic-eval.cjs" ] || NFBIN="./bin"
node "$NFBIN/haiku-semantic-eval.cjs"
```
- If exit code is 0: display verdict distribution from stderr output ("Evaluation complete (via: script). yes: X, no: Y, maybe: Z") and continue to Step 5. Done.
- If exit code is non-zero: log the error, then proceed to 4b (sub-agent fallback).

**4b. Sub-agent fallback:**
- Log: "Script failed (likely missing ANTHROPIC_API_KEY). Falling back to sub-agent evaluation."
- Read `.planning/formal/candidates.json` and parse the candidates array (orphans are excluded from evaluation).
- Filter to candidates that do NOT already have a `verdict` field (respect cache, same as the script does).
- If no candidates need evaluation, report "All candidates already evaluated (cached)" and continue.
- For each unevaluated candidate, dispatch a Haiku sub-agent with this prompt (matching the script's prompt format):

```
You are evaluating whether a formal model semantically satisfies a requirement.
Model path: {candidate.model}
Requirement ID: {candidate.requirement}
Does this model address the intent of this requirement? Consider both direct coverage and transitive coverage through related models.
Respond ONLY with valid JSON: {"verdict":"yes"|"no"|"maybe","confidence":<decimal 0.0-1.0>,"reasoning":"..."}
Note: confidence MUST be a decimal between 0.0 and 1.0 (NOT 0-100).
```

- Parse each sub-agent response as JSON. On any parse failure OR missing/invalid fields, fill defaults: `verdict="maybe"`, `confidence=0.0`, `reasoning=""`. Concretely: if JSON.parse throws, use all defaults; if JSON is valid but `verdict` is missing/invalid, default that field; if `confidence` is missing/non-numeric, default to `0.0`; if `reasoning` is missing, default to `""`.
- Normalize verdict: only "yes", "no", or "maybe" are valid; anything else becomes "maybe".
- Set on each candidate: `verdict`, `confidence`, `reasoning`, and `evaluation_timestamp` (ISO 8601).
- If candidate count exceeds 10, batch into groups of 10 and process each batch sequentially. Process each batch, log progress for each batch completion.
- After all candidates are evaluated, write the full candidates.json back to `.planning/formal/candidates.json` (preserving metadata, updating only the candidates array entries).
- Display verdict distribution AND which eval path ran: "Evaluation complete (via: sub-agent fallback). yes: X, no: Y, maybe: Z"

Progress line: `[3/6] Running semantic evaluation (Haiku)...`

## Step 5: Compute semantic scores

Run (portable):
```bash
NFBIN="$HOME/.claude/nf-bin"; [ -f "$NFBIN/compute-semantic-scores.cjs" ] || NFBIN="./bin"
node "$NFBIN/compute-semantic-scores.cjs" --json
```

- Display per-gate score summary (A, B, C scores)
- Show median, min, max for each gate
- **On error:** Halt and display error message

Progress line: `[4/6] Computing semantic scores...`

## Step 6: Generate pairings

Run (portable):
```bash
NFBIN="$HOME/.claude/nf-bin"; [ -f "$NFBIN/candidate-pairings.cjs" ] || NFBIN="./bin"
node "$NFBIN/candidate-pairings.cjs" --json
```

- Display pairing status summary:
  - Total pairings
  - Pending (not yet triaged)
  - Confirmed (accepted)
  - Rejected (dismissed)
- **On error:** Halt and display error message

Progress line: `[5/6] Generating candidate pairings...`

## Step 7: Summary dashboard

Consolidate all metrics into a formatted summary table:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Proximity Pipeline Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Graph             │  N nodes, E edges, U orphans
 Candidates        │  C candidates (graph-sourced)
 Orphans           │  X models, Y requirements (no graph coverage)
 Evaluation        │  yes/no/maybe counts (or SKIPPED)
 Semantic Scores   │  Gate A/B/C ranges
 Pairings          │  P pending, Q confirmed, R rejected

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**If pending pairings > 0:**
Show: "→ Run /nf:resolve to triage P pending pairings"

**If `--resolve` flag was passed:**
Show: "→ Ready to triage. Run: /nf:resolve --source pairings"

Progress line: `[6/6] Generating summary...`

</process>

<notes>
- Each step runs via Bash. If any step exits non-zero, halt and display the error.
- Steps display progress indicators before each script invocation.
- The `--skip-eval` flag is useful when Haiku quota is exhausted or you want to rebuild without re-evaluating.
- The `--resolve` flag is a convenience — it suggests the exact /nf:resolve command to triage results.
- The `--top` flag defaults to 0 (no limit). The ensemble naturally caps at ~100 secondary candidates. Haiku evaluation handles precision filtering.
- The `--non-neighbor-top` flag controls how many orphan models and requirements are surfaced based on coverage-gap ranking (default: 20). Pass `--non-neighbor-top 0` to disable orphan discovery.
- All pipeline scripts are expected to exist in bin/ and produce JSON output (when --json is passed).
- Step 4 tries the haiku-semantic-eval.cjs script first (works with ANTHROPIC_API_KEY in the environment). If the script fails, it falls back to inline Haiku sub-agent evaluation via Task(model='haiku'). Both paths produce identical output in candidates.json (verdict, confidence, reasoning, evaluation_timestamp fields).
</notes>

</process>

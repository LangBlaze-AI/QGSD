---
name: nf:quorum-test
description: Run the test suite and submit the full execution bundle to quorum workers for independent quality review. Parallel workers evaluate whether tests genuinely pass and whether assertions are meaningful.
argument-hint: "[path/to/test.file.js]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Task
  - Glob
---

<objective>
Run the project test suite, assemble a full execution bundle, and dispatch parallel quorum workers to independently evaluate whether the tests genuinely pass and whether they are real tests.

This command extends nForma quorum from *planning* (consensus on direction) to *verification* (consensus on test quality).
</objective>

<process>

**Detect test runner**

Read `package.json` if it exists (use the Read tool, not bash). Inspect `devDependencies`, `dependencies`, and `scripts.test`.

Determine `$RUNNER` using this priority order:
1. If `devDependencies` or `dependencies` contains `"vitest"` → `$RUNNER = vitest`
2. Else if `devDependencies` or `dependencies` contains `"jest"` or `"@jest/core"` or `"ts-jest"` or `"babel-jest"` → `$RUNNER = jest`
3. Else if `scripts.test` contains `"vitest"` → `$RUNNER = vitest`
4. Else if `scripts.test` contains `"jest"` → `$RUNNER = jest`
5. Else if `scripts.test` contains `"node --test"` → `$RUNNER = node`
6. Else → `$RUNNER = node` (default)

Set `$TEST_PATTERNS` based on `$RUNNER`:
- `jest` or `vitest`: `*.test.ts`, `*.test.tsx`, `*.test.js`, `*.test.jsx`, `*.spec.ts`, `*.spec.tsx`, `*.spec.js`, `*.spec.jsx`
- `node`: `*.test.js`, `*.test.cjs`, `*.test.mjs`

Set `$RUN_CMD` based on `$RUNNER`:
- `jest`: `npx jest --passWithNoTests`
- `vitest`: `npx vitest run`
- `node`: `node --test` (files appended per step 2)

Display: `Detected runner: $RUNNER`

**Parse and validate target**

Parse `$ARGUMENTS`:
- If non-empty and points to a **file**: use it directly as `$TEST_FILES`
- If non-empty and points to a **directory**: search within that directory using `$TEST_PATTERNS`
- If empty: search from repo root using `$TEST_PATTERNS`

For directory or root discovery, run one `find` covering all applicable patterns. Example for jest/vitest:
```bash
find <root> \( -name "*.test.ts" -o -name "*.test.tsx" -o -name "*.test.js" \
  -o -name "*.test.jsx" -o -name "*.spec.ts" -o -name "*.spec.tsx" \
  -o -name "*.spec.js" -o -name "*.spec.jsx" \) \
  -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/.next/*"
```

For node runner:
```bash
find <root> \( -name "*.test.js" -o -name "*.test.cjs" -o -name "*.test.mjs" \) \
  -not -path "*/node_modules/*" -not -path "*/.git/*"
```

Store the list as `$TEST_FILES`.

Empty check:

If `$TEST_FILES` is empty, display:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► QUORUM-TEST: No automated tests found
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Searched for: <$TEST_PATTERNS>
Runner detected: <$RUNNER>

If this checkpoint requires visual/manual verification, quorum-test does not apply.
Proceed with human verification or add automated tests before invoking quorum-test.
```

STOP — do not proceed.

File existence check:

For each file in `$TEST_FILES`, verify it exists on disk:
```bash
ls $TEST_FILES 2>&1
```

If any file is missing, display:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► QUORUM-TEST: BLOCK (missing test files)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Missing: <list of missing files>
Fix: Re-run discovery with `find . -name "*.test.*" | grep -v node_modules`
```

STOP — do not proceed to test execution.

Validation summary:

Display:
```
✓ Runner: $RUNNER
✓ N test file(s) found.
Proceeding to test execution...
```

**Capture execution bundle**

```bash
node --version
```
Store as `$NODE_VERSION`.

Execute tests using `$RUN_CMD`:
- **jest**: `npx jest --passWithNoTests $TEST_FILES 2>&1`
- **vitest**: `npx vitest run $TEST_FILES 2>&1`
- **node**: `node --test $TEST_FILES 2>&1`

Append `echo "EXIT:$?"` to capture exit code. Store full output as `$TEST_OUTPUT`. Extract exit code from the `EXIT:N` line at the end.

Read the full source of every file in `$TEST_FILES`. Store as `$TEST_SOURCES` — a combined block with filename headers:

```
=== hooks/nf-stop.test.js ===
<full source>

=== hooks/config-loader.test.js ===
<full source>
```

When reading each test source file:
- If the file content is empty: include `[WARN] empty source: <filename>` in place of content
- If the Read tool returns an error: include `[ERROR] read failed: <filename> — <reason>` in place of content

This lets quorum workers see exactly what happened per file rather than silently receiving an incomplete bundle.

**Immediate BLOCK if exit code is non-zero**

If exit code is non-zero, stop immediately and display:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► QUORUM-TEST: BLOCK (test infrastructure failure)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Tests did not run cleanly (exit code: N).
Fix the infrastructure failure before requesting quorum review.

<relevant excerpt from $TEST_OUTPUT>
```

Do NOT invoke quorum workers. Stop here.

**Assemble bundle**

Compose `$BUNDLE`:

```
NODE VERSION: $NODE_VERSION
TEST FILES: $TEST_FILES
EXIT CODE: 0

=== TEST OUTPUT ===
$TEST_OUTPUT

=== TEST SOURCES ===
$TEST_SOURCES
```

**Dispatch parallel quorum workers**

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► QUORUM-TEST: Dispatching workers...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Dispatch all four workers as parallel Task calls (Task subagents are isolated subprocesses — a failing Task does not propagate to sibling Tasks, so this is safe under CLAUDE.md R3.2 which restricts direct sibling MCP calls):

Worker prompt template for each:
```
You are a skeptical test reviewer for the nForma project.

<bundle>
$BUNDLE
</bundle>

Evaluate this test execution bundle.
Return ONLY:

verdict: PASS | BLOCK | REVIEW-NEEDED
concerns:
  - <most-impactful concern first, or "none" if no concerns>
  - <second concern if applicable, or "none" if only one concern>

Your job is NOT to confirm the pass. Read the assertion code and ask: if someone changed the implementation in a meaningful way, would this test catch it? Look for swallowed exceptions, trivially true assertions, mocked internals that bypass real logic.

If the bundle contains no test source code, return:
verdict: REVIEW-NEEDED
concerns:
  - Bundle missing test sources — cannot verify assertion quality
```

Dispatch (each call in a single parallel message — Task subagents are isolated subprocesses; a failing Task does not propagate to co-submitted Tasks, unlike direct sibling MCP calls):
- `Task(subagent_type="general-purpose", prompt="Call mcp__gemini-1__gemini with the following prompt. Pass the full literal text of the bundle inline — do not summarize or truncate: [full worker prompt with $BUNDLE inlined verbatim]")`
- `Task(subagent_type="general-purpose", prompt="Call mcp__opencode-1__opencode with the following prompt. Pass the full literal text of the bundle inline — do not summarize or truncate: [full worker prompt with $BUNDLE inlined verbatim]")`
- `Task(subagent_type="general-purpose", prompt="Call mcp__copilot-1__copilot with the following prompt. Pass the full literal text of the bundle inline — do not summarize or truncate: [full worker prompt with $BUNDLE inlined verbatim]")`
- `Task(subagent_type="general-purpose", prompt="Call mcp__codex-1__review with the following prompt. Pass the full literal text of the bundle inline — do not summarize or truncate: [full worker prompt with $BUNDLE inlined verbatim]")`

Note: `agents/nf-quorum-test-worker.md` defines this same role and output format and can be invoked directly with a bundle as `$ARGUMENTS`. The parallel Task dispatch above is used when targeting specific external models (Gemini, OpenCode, Copilot, Codex) rather than a single agent.

**Collect verdicts and render table**

Parse each worker response for `verdict:` and `concerns:` lines.
When parsing concerns: if a bullet reads `none`, treat it as absent and display `—` in the table.

If a worker errored or returned unparseable output, mark as `UNAVAIL`.

Determine consensus:
- All available models PASS → consensus `PASS`
- Any available model BLOCK → consensus `BLOCK`
- All available models REVIEW-NEEDED (no PASS, no BLOCK) → consensus `REVIEW-NEEDED`
- Mixed PASS/REVIEW → consensus `REVIEW-NEEDED`
- All UNAVAIL → stop: "All quorum models unavailable — cannot evaluate."

Display:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► QUORUM-TEST RESULTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

┌──────────────┬──────────────────┬─────────────────────────────────────┐
│ Model        │ Verdict          │ Concerns                            │
├──────────────┼──────────────────┼─────────────────────────────────────┤
│ Gemini       │ [verdict]        │ [first concern or —]                │
│ OpenCode     │ [verdict]        │ [first concern or —]                │
│ Copilot      │ [verdict]        │ [first concern or —]                │
│ Codex        │ [verdict]        │ [first concern or —]                │
├──────────────┼──────────────────┼─────────────────────────────────────┤
│ CONSENSUS    │ [consensus]      │ [N PASS, N BLOCK, N UNAVAIL]        │
└──────────────┴──────────────────┴─────────────────────────────────────┘
```

If any model has multiple concerns, list them below the table.

**Save artifact**

Write `.planning/quick/quorum-test-latest.md`:

```markdown
# quorum-test artifact
date: [ISO timestamp]
files: $TEST_FILES
exit_code: 0

## verdict
[consensus verdict]

## worker verdicts
[table as text]

## execution bundle
[full $BUNDLE]
```

</process>

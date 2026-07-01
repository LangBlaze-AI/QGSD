<purpose>
Ultra-hardening loop: quorum-verified adversarial review + fix, to convergence. Fans out
independent reviewers across security/correctness DIMENSIONS, has a multi-model QUORUM
adversarially verify every candidate finding (refuting false positives), then fixes each
CONFIRMED finding failing-test-first — looping until two consecutive rounds surface zero new
confirmed findings (convergence) or the round cap is hit. This is `harden` with independent
eyes: where `harden` is one agent probing edge cases, `ultra-hard` is a review panel plus a
verification quorum, for set-once / high-stakes code where a single reviewer is not enough.
</purpose>

<process>

**Step 1: Parse arguments**

Parse `$ARGUMENTS` for:
- `--area <path>` → `$AREA` (file or directory subtree to review; default: whole repo). The value is the next token.
- `--dimensions <csv>` → `$DIMENSIONS` (comma list; default: `correctness,security,leak,recoverability,failure,input`). Unknown names are kept verbatim (free-form lenses are allowed).
- `--rounds <N>` → `$MAX_ROUNDS` (integer, default: 4). Round cap.
- `--voters <N>` → `$VOTERS` (verification quorum size per finding, default: 3).
- `--test-cmd "<cmd>"` → `$TEST_CMD` (how to run the suite; auto-detected if omitted).
- `--commit` → `$COMMIT` (true/false; when set, commit each confirmed fix to the current branch).

Validation (fail fast):
- `--area` present without a value or empty → error: `Error: --area requires a non-empty path`.
- `--rounds` / `--voters` present and not a positive integer → error naming the flag and the bad value.
- If `--area` is set and the path does not exist → error: `Error: --area path not found: <path>`.

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► ULTRA-HARD (quorum + harden)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Area:        ${AREA || 'whole repo'}
  Dimensions:  ${DIMENSIONS}
  Verify:      ${VOTERS}-voter quorum per finding
  Rounds:      up to ${MAX_ROUNDS} (converge at 2 dry rounds)
  Commit:      ${COMMIT ? 'each confirmed fix to current branch' : 'no (report only)'}
```

---

**Step 2: Establish the baseline (green suite)**

Determine `$TEST_CMD` if not supplied: read `package.json` scripts.test (vitest → `npx vitest run`; jest → `npx jest --passWithNoTests`; node --test → `node --test`); else detect a project runner (`pytest`, a repo `test`/`run-tests` script, a Makefile `test` target). If nothing is found, emit `◆ WARNING: no test runner detected — set --test-cmd "<cmd>"` and use `npm test` as a last resort.

Run `$TEST_CMD` once. If it is **red**:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► ULTRA-HARD BLOCKED — baseline suite failing
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Fix the baseline before ultra-hardening (run /nf:fix-tests or /nf:harden first).
```
STOP — return status: `blocked`. A red baseline makes "did my fix break something" unanswerable.

Initialize: `$ROUND = 0`, `$DRY = 0`, `$SEEN = {}` (finding keys), `$CONFIRMED = []`, `$STATUS = "running"`.

---

**Step 3: Round loop** (while `$ROUND < $MAX_ROUNDS` AND `$DRY < 2`):

Increment `$ROUND`. Display `━━━ ROUND ${ROUND}/${MAX_ROUNDS} ━━━`.

**Step 3a — Fan out the review panel (one reviewer per dimension, in parallel).**

Spawn all `$DIMENSIONS` reviewers concurrently (one Task each). Each reviewer gets the dimension's charter and the standing context:

```
Task(
  subagent_type="general-purpose",
  model="{executor_model}",
  description="ultra-hard review:${dimension} (round ${ROUND})",
  prompt="
You are an adversarial security/correctness reviewer. Find REAL defects in the ${dimension}
dimension of this code — not style nits.

## Scope
${AREA || 'the repository'}

## Dimension charter
${CHARTER[dimension]}   // see 'Dimension charters' below

## Already hardened (do NOT re-report)
This code has been hardened before; every prior fix has a REGRESSION TEST. Before reporting a
finding, grep the test files for an existing guard — if one exists, it is already fixed; skip it.
Round ${ROUND}. Findings already surfaced this run: ${SEEN keys, summarized}.

## Output (STRICT)
Return a JSON object {\"findings\": [ ... ]}. Each finding:
  { file, line (1-indexed), severity (critical|high|medium|low), claim (one sentence),
    repro (concrete inputs/state -> wrong/leaky/unrecoverable outcome), suggested_fix }
Prefer a few HIGH-CONFIDENCE findings over many speculative ones. Empty findings array if nothing new.
"
)
```

Collect all reviewers' findings. Drop any whose key `file|normalized-claim` is already in `$SEEN`; add the rest to `$SEEN`. Call the survivors `$CANDIDATES`.

If `$CANDIDATES` is empty: `$DRY += 1`; log `round ${ROUND}: 0 new candidates (dry ${DRY}/2)`; continue the loop. Otherwise `$DRY = 0`.

**Step 3b — Quorum-verify each candidate (adversarial, refute-by-default).**

For EACH candidate, obtain `$VOTERS` independent verdicts. Prefer the multi-model quorum
(different models catch different failure modes); fall back to Claude skeptics if quorum is
unavailable — fail open, never block on quorum:

- **Multi-model path:** dispatch the candidate to `$VOTERS` quorum slots per
  `@core/references/quorum-dispatch.md` (provider preflight → team capture → fan-out). Give each
  slot the verify prompt below. Treat a slot timeout/error as a non-vote (does not count toward
  "real").
- **Fallback path (quorum unavailable / < 2 slots):** spawn `$VOTERS` Claude Task skeptics.

Verify prompt (each voter):
```
Adversarially VERIFY this claimed defect. Default to SKEPTICISM — mark real=false unless you can
point to the exact code and construct a concrete failing/leaky/unrecoverable scenario. If it is
already handled, guarded by a test, a false positive, or merely stylistic → real=false.

File: ${c.file}:${c.line} | severity: ${c.severity}
Claim: ${c.claim}
Repro: ${c.repro}

Read the ACTUAL code (and related files/tests) before deciding.
Return { real (bool), severity (critical|high|medium|low|not-a-bug), reasoning }.
```

A candidate is **CONFIRMED** iff a MAJORITY of the cast votes have `real=true`
(`yes >= ceil(cast/2)`, and at least 2 votes cast; if only 1 vote was obtainable, require it to be
`real=true` AND log `◆ single-voter verify (quorum degraded)`). Take the median severity of the
`real=true` votes. Drop refuted candidates. Log `round ${ROUND}: ${confirmed}/${candidates} confirmed`.

**Step 3c — Fix each confirmed finding, hardest first, failing-test-first.**

Sort confirmed findings by severity (critical→low). Fix them **sequentially** (a shared working
tree — parallel fixers would collide). For each, spawn ONE fix executor:

```
Task(
  subagent_type="nf-executor",
  model="{executor_model}",
  description="ultra-hard fix:${file} (round ${ROUND})",
  prompt="
Fix this QUORUM-CONFIRMED defect. Correct and MINIMAL.

File: ${f.file}:${f.line} | severity ${f.severity} | quorum ${f.votes}
Claim: ${f.claim}
Repro:  ${f.repro}
Suggested fix (advisory): ${f.suggested_fix}

Procedure (follow exactly):
1. Read the code and CONFIRM the defect yourself. If on inspection it is NOT real, set fixed=false
   with notes and STOP — do not force a change.
2. Write a FAILING test FIRST that reproduces it (add to the existing suite; do not delete/weaken
   existing tests). Run it; confirm it fails for the RIGHT reason.
3. Make the MINIMAL source fix.
4. HARD CONSTRAINTS — never violate:
   - never WEAKEN, delete, or skip an existing guard/test to make things pass;
   - never put a secret on argv / stdout / a log / a loose-perm file;
   - for any money/crypto/identity path, INDEPENDENTLY cross-check the result against an external
     reference (a published test vector or a separate library) before trusting it — say how.
5. Run the FULL suite (${TEST_CMD}) and ensure 0 failures.
6. ${COMMIT ? \"Commit atomically: <conventional-commit type>(<scope>): harden — <claim>\" : \"Do NOT commit.\"}
Return { fixed (bool), test_added, files_changed, suite_green (bool), crypto_crosscheck, notes }.
"
)
```

Append `{...f, fix}` to `$CONFIRMED` when `fixed && suite_green`. If a fixer reports
`suite_green=false`, log `◆ WARNING: suite red after fixing ${f.file} — halting round` and break to
Step 4 (do not stack fixes on a red tree).

**End round loop.** Termination: `$DRY >= 2` → `$STATUS = "converged"`; `$ROUND >= $MAX_ROUNDS` → `$STATUS = "cap_exhausted"`.

---

**Step 4: Completeness critic + result banner**

Spawn one final critic: "Given the confirmed+fixed findings this run, what is still UNVERIFIED or
out of scope — a dimension not probed, a claim not reproduced, a money-path not externally
cross-checked, a daemon/integration suite not run here? Be concrete." Fold its answer into the report.

If `$STATUS == "converged"`:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► ULTRA-HARD CONVERGED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Rounds:    ${ROUND}
  Confirmed & fixed: ${CONFIRMED.length}  (by severity: ...)
  Status:    Converged (2 consecutive rounds, 0 new confirmed findings)
```

If `$STATUS == "cap_exhausted"`:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► ULTRA-HARD CAP REACHED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Rounds:    ${ROUND} (max ${MAX_ROUNDS})
  Confirmed & fixed: ${CONFIRMED.length}
  Status:    Cap exhausted — run /nf:ultra-hard again to continue toward convergence
```

Then print the confirmed-findings table (severity · file:line · claim · quorum votes · test added ·
suite_green) and the critic's residual-risk notes. Return `$STATUS`.

---

**Dimension charters** (used in Step 3a; `--dimensions` selects which run):

- **correctness** — logic/state-machine bugs, off-by-one, boundary/overflow, ordering/idempotency, error paths that continue when they should abort, results that are silently wrong.
- **security** — auth/authz, injection (shell `eval`, SQL, path), unsafe deserialization, SSRF, secret handling, privilege/trust boundaries.
- **leak** — any path where a secret (key/PIN/token/seed/passphrase) reaches a log, stdout/stderr, a loose-perm file, the process command line (ps/proc/cmdline), shell history, swap, a spool, or a temp file outside tmpfs.
- **recoverability** — for backup/restore/split code: is EVERY produced artifact reconstruct-verified before it is relied upon? Threshold guarantees real? Could data be silently truncated / re-encoded / stored so recovery yields different bytes? Passphrase consistency.
- **failure** — failure modes & lockout: retry-counter exhaustion / bricking, partial/non-atomic writes, state corruption, a guard that fails OPEN when a tool/input is missing, error handling that proceeds when it should stop.
- **input** — validation of UNTRUSTED bytes (parsers, device/network responses, user files), length/type handling, and whether malformed/malicious input induces a wrong-but-plausible result or a silent failure.

Callers may pass any other lens name in `--dimensions`; treat an unknown lens as a free-form
charter ("review the code adversarially through the lens of: <name>").

</process>

# Changelog

All notable changes to nForma will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.44.2] - 2026-07-29 — Thread-persistent quorum loop, model-expanded slot roster, multi-repo scope, and goal delivery

### Added
- feat(quorum): **opt-in thread persistence per slot** (`quorum.persistent_threads`, default false). The CE-5 full-convergence loop was stateless by design: each round spawns a fresh CLI invocation with prior-round outputs spliced into the prompt, and the convergence check diffs that prompt-injected state. With `persistent_threads: true`, slot CLIs keep a native conversation across rounds — `codex exec resume <thread_id>`, `-p --resume <session_id>`, or `-c` for CWD-scoped continue (agy, kimi). Round 1 captures the session id from stdout (codex JSONL `thread.started`, claude `--output-format json`) and persists it to `.planning/quorum/sessions/<slot>-<invocation>.json`; round 2+ reads the file and replaces the fresh argv template with the resume argv before `{prompt}` substitution. GC: every invocation sweeps session files >24h old, fail-open. Drop-guard mirrors the existing pattern (garbage `persistent_threads` warns + falls back to false; absent restores silently). New: `bin/quorum-resume.cjs` (helper), `bin/quorum-sessions-store.cjs` (scratch store), `bin/quorum-resume.test.cjs` (28 PURE tests, red-proven). Also fixes a latent path bug: `bin/call-quorum-slot.cjs` required `./config-loader` which resolves to a nonexistent path; corrected to `../hooks/config-loader`.

  **Empirical findings (3 task classes, codex/gpt-5.5, judged on the FINAL design produced, not on word-reuse proxies):** the prevailing assumption "thread memory always helps" is **not what the data shows**. Across a 2-round essay expansion, a 3-round plan review, and a 5-round complex synthesis, the **default `false` (stateless) is at least as good as `true`** (persistent) in 2 of 3 task classes and ties the third. `FRESH` (no context at all) always refuses with a safety message — better than hallucinating. The right rule of thumb: enable persistent when the reasoning chain spans 10+ rounds, the orchestrator's prompt-injection window is too narrow for prior rounds, or the model is *evolving* its own prior reasoning rather than answering fresh; otherwise stateless preserves the documented CE-5 "team has nothing left to add" semantics and beats the model's noisier thread memory in mid-complexity tasks. **No change for existing callers** — default `false` preserves the current stateless CE-5 semantics.
- feat(quorum): **add Kimi Code (`kimi`) as a native CLI quorum family.** Kimi Code ships a `kimi` binary (`~/.kimi-code/bin/kimi`, v0.27.0) whose headless contract matches gemini/antigravity — `-p/--prompt <prompt>` runs one prompt non-interactively and prints the response. Wired the same way antigravity was (PR #274), and simpler because kimi's family name equals its binary name (no `agy`-style exception): `FAMILY_ARGS_TEMPLATE.kimi = ['-p','{prompt}']` (dispatch), both PATH-detection lists + `NF_KEYWORD_MAP` (`mcp__kimi-1__` prefix) + `KNOWN_CLI_PREFIXES` + install-hint in `install.js` (auto-detected on install), `skill-mcp-lint` `VALID_TOOLS.kimi` (so `mcp__kimi-1__kimi` passes the lint gate and a wrong tool like `ask` is still flagged), install metadata in `nForma.cjs`/`update-agents.cjs` (`kimi upgrade` self-update), and `token-dashboard` (managed-oauth flat-fee). `update-scoreboard`'s `VALID_MODELS` already listed `kimi`. **Verified end-to-end with a live `kimi -p` spawn** (the exact argv the quorum builds → exit 0, model replied). Scope: kimi as a quorum *slot* (a model nForma queries), not as an IDE install-target. New kimi cases in the three family test suites, mutation-proven red; the mcp-lint positive test was strengthened to be non-vacuous (a bare `deepEqual([])` passes for an unknown slot too).
- feat(quorum): **the CE-5 deliberation round cap is now configurable via `quorum.max_rounds`** (default 10). CE-5 full-convergence already "rounds until the improvement stream is dry under unanimity", but the *total-round* budget before it escalates was hardcoded to 10 in the skill prose — so a user whose consensus bar is "round until no more improvements are put forward" could have a contentious debate cut short at 10. `hooks/config-loader.js` adds `quorum.max_rounds` with the same partial-merge drop-guard as `min_live_voters`/`full_convergence`, plus a clamp so a dropped or garbage value (< 1, non-integer) restores to the default — the loop always has a finite upper bound, a bad config can never mean "loop forever". `commands/nf/quorum.md` replaces every hardcoded "10 total / 9 deliberation" with `MAX_ROUNDS = quorum.max_rounds`, read at R3.3 alongside `full_convergence`. Also fixes an adjacent papercut: an **absent** `maxSize` (the partial-merge drop) used to emit a spurious "maxSize must be a positive integer" warning on every hook run; it now restores silently like the other keys, and only a *provided-but-garbage* `maxSize` still warns. 6 config tests (QMR1–6) + 3 skill-prose gates, all mutation-proven red.
- feat(skill): **`/nf:goal-writer` gains a delivery target** — a goal whose definition of done is "live in staging" cannot be satisfied by an agent that stops at merge; it burns every remaining turn on work that cannot complete. **Merged is not delivered:** a PR that merges and then dies in a broken pipeline shipped nothing. The skill now resolves an explicit target (`merged` | `staging` | `production`) in step 1 and carries it through every downstream section. `nf:pr-resolve`'s **terminus** is stated explicitly: for a deploying target it must follow the deployment through and verify the change is **healthy** — not merely that the pipeline reported green (a green deploy job in front of a crashlooping service is not delivered) — with the health check written concretely (endpoint, smoke command, or error-rate signal, plus how long to observe). **Hard stops are reframed from "deployment is banned" to "deployment is scoped by the target":** deploying *to* the declared target is authorised work; deploying *past* it is a hard stop (`staging` never authorises a production promotion); **rolling back a deploy this session drove, when observed unhealthy, is authorised** because it restores known-good state; approval gates are waited on, never bypassed; and publish/release, secret rotation, destructive git, data migrations, money/identity and external communication stay hard-stopped at every target. The done-checklist's final item becomes "target reached and verified healthy" so a merge alone cannot satisfy it, the generated `/goal` end state must **name** the target (otherwise the evaluator accepts a merge as completion and the goal closes with nothing shipped), and a deploying target must be disclosed plainly — the session will deploy without asking, and the user must not learn that from a log line afterwards. 10 new contract tests in `bin/goal-writer-blocks.test.cjs`, all mutation-proven red; prose assertions match a whitespace-normalised view of the skill so reflowing a paragraph is not a false failure.
- test(release): **regression gates for the `@next == @latest` alias policy** — the guards shipped in #366/#367 had **zero tests**, which by the repo's own recurrence record (config-path drift fixed 6×, null-CLI 4×) means the class comes back. New `bin/release-guards.test.cjs` covers all five: `publish.sh`'s prerelease-version and caller-supplied-`--tag` refusals, `prepare-release.sh`'s explicit-target and `--auto`-current-version refusals, and `publish.yml`'s version guard plus the absence of the retired `v*-rc*`/`v*-next*` triggers and `dist_tag=next`/`mode=prerelease` modes. **Safety-critical design:** `publish.sh` ends in `npm publish`, so each script runs in a throwaway sandbox against a stub `npm` that only records argv — every test asserts `publish` was never reached, so a *broken* guard fails an assertion instead of publishing. All five mutation-proven **red** (guard removed → test fails; restored → passes), including a positive control that a stable version does reach the publish step, so the prerelease rejection is attributable to the version and not to sandbox breakage.
- test(skill): **live-path gate for `/nf:goal-writer`** (`bin/goal-writer-blocks.test.cjs`) — closes the recorded "skill live-path test gap" class where defects ship green because tests cover extracted helpers rather than the form that actually runs. Executes the skill's own embedded blocks: asserts no `node -e` survives in an executable shell fence (the `nf-node-eval-guard` PreToolUse hook *denies* that form, so a documented `node -e` command fails every run — a bug `lint:isolation` and all four skill lints passed, since they check for arguments *after* an eval, never the use of `-e` itself), `bash -n`-validates every shell block, runs the recurrence-scan grep pattern under **stock `/usr/bin/grep`** to catch non-POSIX `\w`, executes the char-count verifier against a condition containing quotes/backticks/parens/`$VAR` to prove the round-trip survives, and pins the four `/goal` contract facts (4000-char limit, no `@file.md` syntax, mandatory turn cap, no per-tool permission grant) whose drift would make a generated condition unsatisfiable. Both real shipped bugs mutation-proven red.
- feat(skill): **`/nf:goal-writer` — generate an operating doctrine + the matching Claude Code `/goal` condition** for a long-running autonomous session. Turns a rough intent ("multi-repo grind leaning on quorum + pr-resolve") into two artifacts: a durable doctrine `.md` the session reads and obeys, and a ≤4000-char `/goal` completion condition. Its differentiator is **grounding** — principles are derived from the project's *recorded* failures (the `MEMORY.md` corpus, the error store, and `git log` recurrence counts that expose a bug class fixed N times), each cited so the doctrine can be re-audited rather than taken on faith; a doctrine of generic best practices is defined as a failed run. Enforces a quality bar that rejects unfalsifiable filler ("write tests") in favour of cited classes ("config-path drift was fixed 6× because the fix was pasted per-call-site — extract the primitive and gate it"), ratifies a consequential principle set through `/nf:quorum` (recording dissent, which usually belongs in the hard-stop list), and requires ungrounded principles to be labelled as such. Bakes in the verified `/goal` contract so it cannot emit an unsatisfiable condition: no `@file.md` syntax exists (a path is prose instruction, not a harness load), the condition is a *completion check* judged after every turn by a fast model that sees only what the agent surfaced — so generated conditions must carry an observable end state, a per-turn reporting requirement, and a `stop after N turns` cap — and `/goal` removes the per-turn prompt but **not** per-tool permission prompts (unattended running also needs auto mode). New `commands/nf/goal-writer.md`; passes `lint:isolation`.

### Changed
- chore(release): retire the `@next` prerelease channel as a separate surface — `@next` is now an alias for `@latest` (both tags point to the same tarball). OIDC trusted publishing authorizes `npm publish` but not `npm dist-tag add`, so the old "next must never fall behind latest" invariant produced recurring drift that needed a manual fix after every stable release (`npm dist-tag add @nforma.ai/nforma@<v> next` under OIDC falls into a warning branch in `publish.yml`). With `@next == @latest` there is no separate prerelease channel to drift; anyone installing `@nforma.ai/nforma@next` gets the same package as `@latest`. CLAUDE.md invariant updated from `next ≥ latest` to `next == latest`. Verified post-change: `npm view @nforma.ai/nforma dist-tags --json` → `latest: 0.44.1, next: 0.44.1`.

### Removed
- chore(release): retire the prerelease flow entirely — the alias policy makes a separate prerelease channel nonsensical (publishing `0.40.2-rc.1` to `@latest` would silently install the prerelease for every user, and `@next == @latest` means there is no separate surface to ship it on). Concretely: (1) `.github/workflows/publish.yml` no longer triggers on `v*-rc*` / `v*-next*` tag pushes, the `prerelease` branch in the `context` job is gone, the `Stamp version from tag (prerelease only)` step is gone, and the workflow now REFUSES any `package.json` version with a `-` suffix (errors instead of publishing). (2) `scripts/release.sh` is deleted — its sole job was the prerelease flow (bump `-rc.N`, push tag). The stable path remains `scripts/prepare-release.sh` (PR-based, the only release path now). (3) `release/{VERSION}-rc.N` branch naming is no longer a thing; CLAUDE.md "Git workflow" now restricts direct-to-main pushes to CI fixes only. (4) CLAUDE.md "CI gates to remember" replaces the "regex accepts prerelease suffixes" note with "**No prerelease versions**". Older rc tags in git history (e.g. `v0.44.0-rc.2`) remain inert; the workflow no longer matches them.


## [Unreleased]

### Removed
- fix(package): **stop shipping a default user config — `templates/nf.json` is deleted.** A user's quorum config is theirs: `~/.claude/nf.json` is generated at install from the MCP servers *they* have (`buildRequiredModelsFromMcp` / `buildActiveSlots`), and `bin/providers.json` ships empty so install can scan their PATH and build it. `templates/nf.json` was the one exception, it was **read by nothing** in the codebase, and it had rotted in two directions: its `required_models` pointed at `mcp__codex-cli-1__` / `mcp__gemini-cli-1__` (slot names that no longer exist), and it was carrying **committed nf-benchmark mutation residue** — BENCH-073's `hooks: {"nf-bench-hook": {"event": "InvalidLifecycle", "command": "echo test"}}`, five stacked copies of BENCH-077's `includes: ["nf-aux.json"]` (one per benchmark run), BENCH-075's `solve.oscillation_window`, BENCH-078's zeroed `context_monitor.warning_threshold`, and BENCH-072 had **deleted the entire `quorum` block**, so the shipped "quorum config template" had no quorum section. The benchmark mutates SUT files in place and does not restore them, which makes any tracked config-shaped file a standing re-pollution target. New gate `bin/no-shipped-user-config.test.cjs` (in `test:ci`) pins the rule: `bin/providers.json` must ship as `{"providers": []}`, `templates/nf.json` must not come back, and no packaged file may carry user quorum/provider config as data — behavior defaults belong in `DEFAULT_CONFIG` (code), project scaffolding in `core/templates/` (a project's planning state, not the user's model fleet). Both regression shapes mutation-proven red. `templates` is dropped from `package.json` `files`.

### Fixed
- fix(quorum): **a slot's configured `idle_timeout_ms` now derives the header-only stall window** (issue #385). The `<500-byte` stall timer defaulted to 30s and could only be raised with a per-slot `stall_timeout_ms` — a field nothing sets, because slots are created by preset import / manual add, which write `idle_timeout_ms`. So the three third-party `claude-cli` routes (`claude-z-ai`, `claude-minimax`, `claude-kimi`) declared a 90s idle tolerance and were still killed at 30s inside their 217–420-byte preamble, every round: 2 retries × 30s of wasted wall-clock, then cooldown, then UNAVAIL — and with `max_quorum_size=3` these are the T1 fallback pool, so a run could fall below `min_live_voters` and refuse to declare consensus with 7 healthy slots configured. A slot that says "I may go quiet for 90s" does not want a 30s kill on its preamble. `stall_timeout_ms` still wins when set; a slot that configures nothing keeps the 30s fast-fail; and the derivation reads the slot's *configured* value, never the caller's `--timeout` (the orchestrator passes `quorum_timeout_ms=300000`, which would have made a genuinely dead slot cost 5 minutes per retry) — though a caller that *lowers* the idle budget still caps the window. The dispatch log now reports the window and its source (`stall=90000ms (idle)` / `(per-slot)` / `(default)`), so this is diagnosable from run output instead of by reading the source.
- fix(quorum): **stop warning that the dispatcher's own flags were "ignored" on every dispatch.** `quorum-slot-dispatch.cjs` (the parent) `require()`s `call-quorum-slot.cjs` for `parseVerdictLine`, which ran the #202 unknown-flag check against the *parent's* `process.argv` — so every single dispatch printed `WARN: unrecognized dispatch flag(s) ignored: --mode --question --artifact-path --review-context --request-improvements` for flags that demonstrably do reach the CLI. A false alarm on the happy path trains the reader to ignore the warning that exists to catch real parent→child contract drift; it cost real debugging time in #385. The check now runs only when the file is the child (`require.main === module`).
- fix(quorum): a **missing** `.planning/quorum/precedents.json` no longer warns on every dispatch — never having recorded a precedent is the normal state, and the per-call `precedents load failed (fail-open): ENOENT` line buried the real failures. A malformed or unreadable file still warns. `bin/quorum-slot-dispatch.test.cjs` (115 tests, previously ungated) is now part of `test:ci`.


## [0.44.1] - 2026-07-08 — Observability, OIDC publishing, cross-LLM delegation, and quorum hardening

### Added
- feat(skill): **`/nf:ultra-hard` — quorum-verified adversarial hardening to convergence.** A review panel fans out across security/correctness **dimensions** (`correctness,security,leak,recoverability,failure,input` by default, `--dimensions` to override), a **multi-model quorum verifies every candidate finding** (refute-by-default, majority-`real` to survive — so false positives are dropped, not fixed), and each **confirmed** finding is fixed **failing-test-first** — looping until two consecutive rounds surface zero new confirmed findings (convergence) or `--rounds N` is hit. It is `nf:harden` with independent eyes and a verification quorum, for set-once / high-stakes code (money, keys, migrations, auth) where one sequential reviewer demonstrably misses defects. Fixers run under hard constraints (never weaken/delete an existing guard or test to go green, never leak a secret, independently cross-check any money/crypto/identity result against an external reference), and the full suite must stay green after every fix. Flags: `--area <path>`, `--voters <N>`, `--test-cmd "<cmd>"`, `--commit`. New `commands/nf/ultra-hard.md` + `core/workflows/ultra-hard.md`; verified against the four skill lints (eval/state-parse/mcp/command-correctness). Proven on a real custodial-wallet key ceremony: a first quorum pass confirmed 38 findings (3/3-voted) on top of 17 manual, each fixed with a regression test.
- feat(lint): **Rule 7 — gate unguarded state-file parses in skills** — the proactive enforcement of the F47/F48 dogfooding class. Every inline `JSON.parse(<…>readFileSync(...))` in `commands/nf/` + `core/workflows/` must now be inside a `try/catch`; a missing or malformed file (a corrupt `.planning/*`, a half-written `~/.claude.json`/`providers.json`) otherwise crashes the skill's embedded-JS step with a raw stack trace, and an `existsSync` ternary guards *missing* but not *malformed*. New `bin/skill-state-parse-lint.cjs` (brace-matched try/catch detection — not a regex heuristic) is wired into `scripts/lint-isolation.js` (the required Lint check). The read-detection covers the inline call-receiver idiom `JSON.parse(require('fs').readFileSync(...))` (and `getFs().readFile…`) as well as the plain `fs.readFileSync`/`await fs.promises.readFile` chains — a call receiver like `require('fs').` breaks a bare identifier-dot match, so that common skill form is matched explicitly. Building the gate found **9 unguarded parses** and fixed them: `mcp-setup.md` (×2 `providers.json`), `mcp-update.md` (`~/.claude.json`), `solve-remediate.md` (stub recipes — also shape-guarded), `quick.md` (`scope-contract.json`), `verify-work.md` (×2 discover manifest — malformed discovery JSON now *skips* the automated batch and falls through to manual presentation, instead of writing a `files:[]` manifest that `run-batch` would score as a false 0-failure success), `solve.md` (the `node -p` incremental-filter parse — try/catch IIFE, fail-open preserved), and `verify-phase.md` (the ROADMAP success-criteria parse — an *empty* phase body still falls through to PLAN must_haves, but a *non-empty malformed* body now raises `ERROR (R9)` and halts rather than silently masking a corrupt ROADMAP). Each catch was chosen so a corrupt state file fails loudly or degrades safely — never a silent empty-success. New `bin/skill-state-parse-lint.test.cjs` (incl. the existsSync-isn't-malformed-safe, nested-brace, and inline-`require` call-receiver cases).
- feat(lint): **CHANGELOG section-dedup tool + gate** — duplicate `### Added`/`### Fixed` headers accrete under `## [Unreleased]` as each merged PR appends its own section, splitting entries across duplicate headers. New `bin/lint-changelog-sections.cjs` detects duplicate sections within a version block (`--fix` merges them surgically — only the offending block is rewritten, every other release block stays byte-for-byte identical, all bullets preserved in first-seen order) and a `bin/changelog-sections.test.cjs` gate (wired into `test:ci`) fails CI if any recur. Consolidated the current Unreleased block (2× Added + 2× Fixed → 1 each, 33 bullets preserved).
- feat(lint): **standardize + enforce inline-eval env/arg placement in skills** — the recurring class behind F1/F21 (env or args placed *after* `node -e "<js>"`, where shell assignments become argv not env, and trailing tokens break the eval-guard's heredoc rewrite). New `bin/skill-eval-lint.cjs` detector is wired into `scripts/lint-isolation.js` as Rule 5, so the existing **required "Lint" CI check** now fails on any `node -e "<js>" VAR=…` / `… --flag` / `… -- "$X"` across `commands/nf/` + `core/workflows/`. The standard is documented in `.claude/rules/skill-authoring.md`. **Building the gate surfaced two instances the per-skill fixes had missed** — `/nf:mcp-restart` (read `process.env.AGENT` with env-after → undefined) and `/nf:solve-remediate`'s coderlm seed-discovery snippet (read `process.argv[1]`/`[2]` via trailing `-- "$REQ_ID" "$SYMBOL_HINT"` → broke under the heredoc rewrite); both fixed (env-before / `process.env`-read). New `bin/skill-eval-lint.test.cjs` covers the detector and asserts the live tree is clean.
- feat(lint): **standardize + enforce MCP tool names** (Rule 6) — the recurring F18/F19/F24 class (CLI-slot refs drifting to `mcp__gemini-cli__…`, bare `mcp__opencode__…`, or non-existent tools like `mcp__copilot-1__ask`, which silently render the quorum/debug table all-UNAVAIL). New `bin/skill-mcp-lint.cjs` validates that the four CLI families (`codex`/`gemini`/`copilot`/`opencode`) use the real `<family>-<N>` slot and a tool the server exposes; install-specific (`claude-*`, `ccr-*`) and external (`context7`, `sentry`) slots and templates are exempt. Wired into `lint-isolation` (the required Lint check). **The full-tree scan caught what #232 missed**: `core/workflows/debug.md` still dispatched workers to `mcp__copilot-cli__ask` / `mcp__gemini-cli__gemini` / bare `mcp__opencode__opencode` / `mcp__codex-cli__codex` (the #232 fix only touched `commands/nf/debug.md`), plus stale examples in `plan-phase.md`/`discuss-phase.md` — 28 references across 3 workflows, all corrected. New `bin/skill-mcp-lint.test.cjs`.
- feat(health): `bin/validate-requirements-staleness.cjs` — a **detect-only** reporter for `.planning/formal/requirements.json` that surfaces requirement texts still referencing pre-rename paths/names from the qgsd→nForma migration (`qgsd.json` → `nf.json`, `.formal/` → `.planning/formal/`, `get-shit-done`). On this repo it flags 27 actionable references (plus 35 bare-`qgsd` mentions, reported informationally) across 479 requirements, with the offending requirement IDs + suggested replacements. It **never edits** the hash-protected requirements envelope — fixing 24+ doc strings in place would invalidate `content_hash` and is riskier than the stale text, so a human decides. `--json` for machine output, `--strict` exits 1 when stale refs exist (else exit 0), `--help`. Registered in `/nf:health`'s diagnostics list. New `bin/validate-requirements-staleness.test.cjs` (finds stale/suggests/skips-modern + never-writes + exit-code coverage), wired into `test:ci`. Closes the F14 dogfooding gap (no staleness pass existed).
- feat(skills): `/nf:pr-resolve` skill — evaluates bot review comments (CodeRabbit, Copilot, gitar) for validity before resolving threads, then polls CI and squash-merges when ready. Includes a worktree cleanliness pre-flight check before skill execution (#160, #181)
- feat(quorum): `min_live_voters` floor for thin-consensus safety — a verdict is trusted only once a minimum number of slots have returned live votes, so a lone surviving voter can no longer carry consensus (#192)
- feat(quorum): empirical score-delta calibration — consensus scoring thresholds are derived from observed score distributions rather than fixed constants (#175)
- feat(install): auto-install `uv` when missing, gated by an availability pre-check, before the River ML install step (#155)

### Changed
- fix(quorum): replace the fragile HTML-comment `FALLBACK_CHECKPOINT` transcript marker with a schema-validated structured checkpoint file (`.planning/quorum/checkpoints/round-<N>.json`). `/nf:quorum` now runs `quorum-checkpoint.cjs` to write the checkpoint; `nf-stop.js` reads and JSON-schema-validates that file instead of regex-parsing the transcript, so LLM stylistic variation in the comment can no longer bypass or trigger the FALLBACK-01 gate. The human-readable HTML comment is still emitted for the transcript but is no longer the gating mechanism. (#188)
- fix: consolidate `providers.json` onto the canonical `~/.claude/nf-bin/` path — installer, MCP server, and quorum dispatch now all read the same location, ending divergence between the legacy `nf/bin/` and `nf-bin/` copies (#186, closes #167)

### Removed
- ci(benchmark): **retire `benchmark-sync.yml`** (quorum-ratified) — the "auto-advance baseline" job invoked a hardcoded local path (`$HOME/code/nf-benchmark`) that never exists on GitHub runners, so it **failed on every push to main**, and its metric was noise (nf-solve is non-idempotent, stability 0/15). It is superseded by the deterministic, API-key-free `benchmark-fixtures.yml` gate (external fixture corpus + precision, run against the PR's own SUT). Removed the workflow and its two sync-only helpers (`scripts/benchmark-compare.py`, `scripts/benchmark-secrets-sync.py`); kept `benchmarks/solve-baseline.json` (still read by `benchmark-gate.yml`).
- chore(quorum): remove dead CCR code paths after the `ccr-*` fleet retirement (#177)

### Fixed
- fix(solve/formal): stop a generic cache key from mass-misclassifying solve items, and guard a formal-loop null deref (dogfooding — data-integrity + crash). (1) **`bin/solve-tui.cjs`** built the dtoc classification cache key by hashing **only `item.reason`** — but `reason` is generic for whole classes of items (e.g. "not in any dependency manifest"), so dozens of distinct items collapsed to a **single** cache key and one Haiku verdict was silently applied to all of them (44 items → 1 key observed). The key now discriminates on `value` + `doc_file` too, so each distinct item is classified on its own merits (identical items still hash stably, so caching is preserved). (2) **`bin/formal-model-loop.cjs`** (`/nf:close-formal-gaps`) crashed deref-ing `modelResult.spec` on iteration 2 when iteration 1 failed before `modelResult` was set; it now regenerates (`i === 1 || !modelResult`) instead of refining a null result. New red-proven `bin/solve-tui-itemkey.test.cjs`.
- fix(verify-work): stop auto-verifying a test with **zero real tests run** (dogfooding — high-impact false-positive). `/nf:verify-work`'s automated path marked a test "verified" whenever the batch reported `failed_count: 0` — but `core/bin/nf-tools.cjs`'s `maintain-tests run-batch` runs jest with `--passWithNoTests`, so a manifest pointing at nonexistent or test-less files exits 0 with **no tests executed**, satisfying `failed_count: 0` and **bypassing manual UAT with no coverage at all**. Two fixes: (a) run-batch now records a zero-test jest file as `status:'no_tests'` (not `'passed'`) and surfaces a `no_tests_count` in the batch output, so an empty file no longer inflates `passed_count`; (b) the verify-work gate now requires `failed_count: 0` **and** a non-zero `passed_count` (at least one real test actually passed) before auto-verifying. New red-proven `bin/verify-work-falsepass.test.cjs` (runs the shipped gate condition against zero-test / real-pass / has-failures batches + guards the run-batch status).
- fix(security/map-codebase): widen the pre-commit secret scan so modern `sk-` API keys can't slip through (dogfooding — a security false-negative). `/nf:map-codebase`'s "scan_for_secrets" gate used `sk-[a-zA-Z0-9]{20,}`, whose character class excludes `-`, so a modern OpenAI **`sk-proj-…`** or Anthropic **`sk-ant-api03-…`** key — both of which carry a hyphen immediately after the `sk-` prefix — was **not matched**, and a leaked live key could be committed into a generated `.planning/codebase/*.md` document undetected. Widened the class to `sk-[a-zA-Z0-9_-]{20,}` (the other patterns already allowed `-`). New red-proven `bin/map-codebase-secret-scan.test.cjs` extracts the actual grep alternation from the skill and asserts it matches `sk-proj-`/`sk-ant-api03-`/classic `sk-` keys (built at runtime so no literal key lands in the repo).
- fix(scoreboard): enforce verdict validation and fix the quorum vote-recording flag contract (dogfooding — this is the real cause behind "quorum scoreboard looks empty/UNAVAIL"). (1) `bin/update-scoreboard.cjs` declared `VALID_VERDICTS` but **never checked it**, so a typo'd/wrong verdict was silently recorded; `validate()` now rejects an out-of-set `--verdict`. (2) `/nf:discuss-phase` and `/nf:execute-phase` told the agent to pass `--model <model_name_or_slot>` and `--result <vote_code>` — but `update-scoreboard` **rejects an MCP slot name passed via `--model`** (slots aren't native families) and `--result` is a prediction-accuracy code (TP/TN/FP/FN), so passing the *verdict* there exited 1; the workflow swallowed the failure and **the vote was never recorded**, which downstream renders as empty/UNAVAIL-looking scoreboard rows. Both snippets now document the two-form identity (`--model <family>` for native CLIs vs `--slot <slot> --model-id <id>` for MCP slots) and pass `--result ""` (not scored) for a gray-area gating vote. New red-proven cases + a snippet scan-guard in `bin/update-scoreboard.test.cjs`.
- fix(plan-phase/quick/cli): contain the formal-scope-scan native-ML abort and stop falsy-zero coercion (dogfooding — NC-1 + falsy-zero). (1) **Native SIGABRT (exit 134)** — `bin/formal-scope-scan.cjs`'s Layer-3 semantic fallback (`@huggingface/transformers`) can throw an **uncatchable** C++ `mutex lock failed` abort whenever Layer-1/2 keyword matching returns zero hits, taking down `/nf:plan-phase` and `/nf:quick` (a JS `try/catch` can't catch it). The scan already supports `--no-l3`; both skills now pass it, so Layer 3 never runs in those paths (the semantic fallback was a nice-to-have; a hard crash was not). (2) **Falsy-zero** — `model-constrained-fix.cjs`'s `--max-constraints 0` and `renderConstraintSummary`'s `maxConstraints || 5` coerced a legitimate `0` up to `5`; `token-dashboard.cjs`'s `--last 0` did the same, and `(r.input_tokens || 0)` left a **string** token count truthy → `$NaN` totals. All now use `Number.isNaN`/numeric coercion (and `--last 0` is honored). New red-proven `bin/batch7-guards.test.cjs` (registered in `test:ci`).
- fix(coderlm/install): portable-path robustness (dogfooding). (1) `/nf:coderlm`'s four query blocks (`callers`/`implementation`/`tests`/`peek`) ran `const adapter = require(adapterPath).createAdapter()`, where `require(adapterPath)` throws `MODULE_NOT_FOUND` **synchronously** — *before* the promise `.catch` — when `coderlm-adapter.cjs` is installed in neither `~/.claude/nf-bin/` nor `./bin/`, so the whole inline-JS block died with a raw stack trace; each require is now wrapped to emit a clean `{error}` JSON like the rest of the path. (2) `bin/install.js` wrote the `nf/VERSION` file **without a trailing newline**, so a downstream read that concatenates VERSION with another token produced e.g. `0.41.10LOCAL`, making the install type undetectable (and `/nf:update` misclassify) — it now writes `pkg.version + '\n'`. New red-proven `bin/coderlm-skill-blocks.test.cjs` (extracts the 4 skill blocks, runs them with no adapter present → `{error}`, registered in `test:ci`) + a trailing-newline assertion in `test/install-virgin.test.cjs`.
- fix(nf-tools): close four silent-success / path-resolution gaps in `core/bin/nf-tools.cjs` (dogfooding — F49). (1) **`summary-extract` / `verify-summary` / plan reads** joined `cwd` onto the given path unconditionally, so an **absolute** path (e.g. one produced by another tool) became `cwd/<abs>` → `{error:"File not found"}` exit 0 for a file that exists — they now honor `path.isAbsolute`. This un-breaks `/nf:complete-milestone`, `/nf:audit-milestone`, `/nf:progress`. (2) **`commit`** mislabeled a real git failure (not-a-repo, hook rejection) as `reason:'nothing_to_commit'`, so callers gating on `reason` treated a *failed* commit as a benign no-op — a genuine git error is now `reason:'git_error'` (still exit 0, fail-open). (3) **`find-phase <missing> --raw`** emitted an empty string (indistinguishable from a crash/no-output); it now emits a `not-found` sentinel. (4) **`generate-slug`** returned an empty slug for whitespace/punctuation-only input (`'   '`, `'!!!'`) at exit 0, which callers turned into empty/trailing-dash directory names — it now fails loudly (and `generateSlugInternal` returns `null`). New red-proven `Batch 5` cases in `core/bin/nf-tools.test.cjs`.
- fix(mcp-update): `/nf:mcp-update` no longer tries to update a CLI flag instead of the package (dogfooding — BROKEN against the real playwright config). The npx/npm package name was read as `args[args.length-1]`, but when the package is followed by a flag — e.g. the actual `["@playwright/mcp@latest", "--headless"]` — that grabbed `--headless`, so the updater ran `npm install -g --headless`. Both classifier sites (single-agent + all-mode) now take the last **non-flag** arg (`[...args].reverse().find(a => !a.startsWith('-'))`), which also still handles a leading `-y`. New red-proven case in `bin/mcp-update-classify.test.cjs` (a `["@playwright/mcp@latest","--headless"]` slot classifies as package `@playwright/mcp@latest`, not `--headless`).
- fix(observe/polyrepo): shape-guard the observe pipeline and polyrepo group loader against wrong-shape state (dogfooding — F48). (1) `polyrepo.cjs` `loadGroup` returned the raw parsed object, so a partially-written / wrong-shape group file (non-array or missing `repos`, or a non-object top level) crashed every `group.repos.length/.some/.filter/for-of` in list/add/remove — it now rejects a non-object as `null` and normalizes a non-array `repos` to `[]`. (2) `observe-registry.cjs` `dispatchAll(sources)` `.map`'d a possibly-non-array `sources`; (3) `observe-render.cjs` `renderObserveOutput(results)` `.filter`'d a possibly-null/string `results`; (4) `observe-debt-writer.cjs` fed a possibly-non-array `debt_entries` to the dedup pass — all three now normalize a non-array to `[]`. (5) `observe-handler-session-insights.cjs` (`/nf:session-insights`) deref'd `sourceConfig.label` on a null config and `fileInfo.mtime.toISOString()` on a null mtime — the latter threw *inside* the handler's catch-all and **silently discarded every detected issue** for that session; both are now guarded (missing `name` too). New red-proven `test/observe-polyrepo-guards.test.cjs` (registered in `test:ci` — none of these had CI-wired tests).
- fix(proximity/resolve): guard the proximity → candidate → resolve pipeline against corrupt/wrong-shape state and stop `/nf:resolve` writing garbage to live `.planning` (dogfooding — F47/F48 + a data-pollution bug). (1) `candidate-discovery.cjs`, `compute-semantic-scores.cjs`, `candidate-pairings.cjs`, and `resolve-pairings.cjs` each did unguarded `JSON.parse(readFileSync(...))` on their required inputs (`proximity-index.json`, `model-registry.json`, `requirements.json`, `candidates.json`, `per-model-gates.json`, `candidate-pairings.json`) — a missing/corrupt file printed a raw `SyntaxError` stack trace; each now uses a `readJsonOrExit` helper that exits 1 with a clean `[script] ERROR:` message. (2) `resolve-pairings.cjs` did `data.pairings.filter(...)` with no array guard — a partially-written pairings file crashed; non-array `pairings` is now treated as "nothing pending". (3) `candidate-discovery --min-score notanumber` set a `NaN` threshold; non-numeric now falls back to the `0.7` default. (4) **data pollution**: `solve-tui.cjs`'s `createTodoFromItem({})` pushed a TODO with all-`undefined` fields into the real `.planning/todos.json`, and `archiveItem({})` pushed an all-`undefined` archive entry — both now refuse an item with no identifying field. (5) `/nf:resolve`'s orphan-count read used `(cd.orphans.models || []).length`, miscounting a non-array; now `Array.isArray`-guarded. New red-proven `test/proximity-resolve-guards.test.cjs` (registered in `test:ci` — none of these scripts had CI-wired tests).
- fix(requirements): harden the requirements/invariant validators against corrupt and wrong-shape envelopes (dogfooding — the F47/F48 parse-but-not-shape class). The classifiers behind `/nf:add-requirement`, `/nf:map-requirements`, and `/nf:review-requirements` crashed with raw `SyntaxError`/`TypeError` stack traces on malformed input. (1) `validate-invariant.cjs` — its CLI `JSON.parse` of the envelope was unguarded (corrupt file → raw `SyntaxError`); `validateInvariant` deref'd `req.text.replace(...)` so a requirement missing `text` (or a `null` array element) took down the whole batch; and `validateInvariantBatch` did `.map` on a non-array `requirements`. Now: guarded parse with a clean message, a per-req shape guard (null/non-string-`text` → `NON_INVARIANT`/`shape`), and `Array.isArray` at the batch entry. (2) `validate-memory.cjs` (`/nf:review-requirements`) — a non-array `requirements` crashed `checkContradictions`' `.map` and made `checkStaleCounts` read a string's `.length` as the count; both now treat non-array as empty, and element access is null-safe. (3) `aggregate-requirements.cjs` — the freeze guard used `frozen_at !== null`, which is **true for an absent key**, so a fresh envelope falsely tripped "Envelope is frozen"; changed to a truthy check (only a real timestamp freezes). (4) `validate-requirements-haiku.cjs` — the 0-requirements early return omitted `agreement_threshold` (renderer printed `undefined`); added. New red-proven `bin/validate-invariant.test.cjs` + `bin/validate-memory.test.cjs` (registered in `test:ci`) and new cases in the existing aggregate/haiku suites.
- fix(solve): restore the debt-convergence and baseline-drift features — both were silently dead (dogfooding — the library-module-invoked-as-CLI class, NC-2). `bin/solve-debt-bridge.cjs` and `bin/baseline-drift.cjs` each `module.exports`'d a function but had **no `if (require.main === module)` block**, so when `/nf:solve` ran `node solve-debt-bridge.cjs --read-open …` and `/nf:solve-report` ran `node baseline-drift.cjs …` the scripts emitted **nothing** — `DEBT_JSON` always fell back to `{"entries":[]}` and CONV-04 baseline-drift detection never fired, with zero error signal (both call-sites are fail-open). Added CLI entry blocks: `--read-open --project-root=<dir>` prints the open/acknowledged debt entries as JSON; the drift CLI reads `BASELINE_JSON`/`SNAPSHOT_JSON` from the env (guarded parse) and prints the `detectBaselineDrift` result. Their existing test files (`bin/solve-debt-bridge.test.cjs`, `test/baseline-drift.test.cjs`) were **not wired into `test:ci`** and only covered the exported functions — now registered, with new red-proven live-invocation tests (the dead path emitted empty; the CLI must print parseable JSON).
- fix(nf-tools): `phase remove` no longer corrupts ISO dates or collapses phase numbers in ROADMAP.md (dogfooding — confirmed data corruption). The renumber loop in `cmdRoadmapGetPhase`'s sibling `cmdPhaseRemove` had two bugs. (1) The plan-reference rewrite `${oldPad}-(\d{2})` was **unanchored**, so it matched the `YY-MM` inside any ISO date — removing a low phase rewrote `2026-03-20` → `2001-03-20` (the year cascaded down the whole document). It's now anchored with `(?<![\d-])…(?![\d-])` so only a standalone `NN-NN` plan ref (flanked by non-digit/non-dash) is touched. (2) The loop ran **high→low**, so each rename's output was re-matched by the next iteration (`3→2`, then `2→1` also caught the freshly-made `2`), collapsing every renumbered phase and plan ref to the same number. It now iterates **low→high**, so created values always fall below the remaining iterations' targets. (3) The loop was also hard-capped at phase 99, so a project with ≥100 phases renamed the on-disk directories but left `Phase 100`/`100-01` references stale in ROADMAP.md (tree/ROADMAP divergence); the upper bound is now derived from the document itself. Found by the all-skills dogfood round (cap noted by CodeRabbit on #259); new red-proven regression tests in `core/bin/nf-tools.test.cjs` (ISO dates survive, `2→1`/`3→2` renumber without collapse, and `Phase 100` renumbers rather than going stale).
- fix(quorum): cache Layer-1 binary probes + consolidate two divergent helpers (quorum-reliability audit). (1) **Per-prompt CLI spawns** — `quorum-preflight.cjs` cached only its Layer-2 HTTP probes, so every `--all` run re-spawned every CLI slot's binary (`codex`/`gemini`/`copilot`/`opencode`), and `nf-prompt` runs preflight up to twice per prompt — so each UserPromptSubmit paid 4–8 live binary spawns. Layer-1 probes now use a short-TTL cache (`bin:<target>` key, `kind:'binary'`, 60s), collapsing a prompt burst to a single spawn (proven by a spawn-count test, red against the uncached code). (2) **config-drift sub-class** — `probe-quorum-slots.cjs` spawned with **raw** `provider.env`, so a slot whose env carries a `${VAR}` secret placeholder was probed unresolved and **false-failed** (then filtered out before dispatch); it now runs `provider.env` through `resolveEnvPlaceholders` like `call-quorum-slot.cjs`. (3) **null-CLI sub-class** — `unified-mcp-server.mjs` kept its own `resolveSpawnTarget` returning a **bare** name; it now delegates to the shared `resolve-cli.cjs` resolver (absolute-path/`which`/Homebrew/npm), closing the last divergent copy (7/7 call sites unified) while preserving its throw-on-empty contract. New `test/quorum-preflight-binary-cache.test.cjs` (spawn-count behavioral + consolidation scan-guards). The semaphore class flagged in older notes is already consolidated (#201) — no change needed.
- fix(hooks): the `nf-stop` Stop hook no longer auto-commits regenerated formal artifacts onto the working branch (self-pollution). `autoCommitFormalArtifacts()` ran on every turn-end success path, sweeping dirty `.planning/formal/*` and committing them as `chore: [auto] …` to whatever branch was checked out (it only guarded `main`/`master`). Combined with `nf-spec-regen` (PostToolUse) regenerating those files on any `*.machine.ts` edit, this littered feature branches with stray commits during unrelated work. Removed the function and its call — regeneration still happens on disk (formal verification unaffected); formal artifacts are committed only by the explicit `/nf:solve` flow via `bin/solve-commit-artifacts.cjs`, which is branch-safe (refuses the default branch, excludes machine-local snapshots). No data-loss risk — regenerated specs are deterministic from the machine file. New `TC-FORMAL` guard in `hooks/nf-stop.test.js` (full suite 55/55).
- fix(lint+skills): close the Rule 5 detector hole for **quoted** arg-after-eval, and fix the 6 instances it was masking (dogfooding edge-path F51). The `skill-eval-lint` detector's OK-list allowed a leading quote, so an inline eval followed by a whitespace-separated quoted positional arg (`… " "$ENVELOPE_PATH"` / `… " '<intent_json>'`) was silently accepted — yet that is exactly the F21 bug (the `nf-node-eval-guard` rewrites `node -e` to a heredoc, and a token after the close lands past the terminator and breaks, leaving `process.argv[N]` undefined). The detector now flags a whitespace-separated quoted arg while still allowing an *immediately-adjacent* quote (shell string concatenation, `"a""b"`). Fixed the 6 masked instances by moving inputs to env-before and reading `process.env.*`: `mcp-status.md` (slots banner), `quorum.md` (envelope risk-level), `solve-remediate.md` (TLC-failure classifier), `sync-baselines.md` (intent persist — also guarded its previously-unguarded `config.json` parse), and `verify-work.md` (×2, test-batch manifest). Detector + concatenation-exception cases in `bin/skill-eval-lint.test.cjs`; standard updated in `.claude/rules/skill-authoring.md`.
- fix(nf-tools): close two parked error-path gaps (dogfooding edge-path F50). (1) **Conflict-marker blindness** — `validate consistency` and `validate health` never scanned for unresolved git conflict markers, so a conflicted `ROADMAP.md`/`STATE.md` read as "consistent"/"healthy" (the phase regexes simply matched nothing). Both now flag them (`validate consistency` → `passed:false` with a clear error; `validate health` → new `E006`). Detection keys on the `<<<<<<<` open marker specifically — it never appears in legitimate markdown, so a bare `=======` (setext-header underline) does **not** false-positive. (2) **No top-level error backstop** — `main()` is `async` and was invoked as a bare `main();`, so any throw not caught at a call site (e.g. an unguarded parse in a rarely-hit subcommand) surfaced as a raw unhandled-rejection stack trace; it now has a `main().catch()` that prints a clean `Error:` and exits 1 (the per-call-site guards still run first and give better messages — this is the net). New tests in `core/bin/nf-tools.test.cjs` (incl. the setext false-positive control).
- fix(tokens): `/nf:tokens --json` now emits valid JSON when there is no usage data (dogfooding edge-path F47). `token-dashboard.cjs`'s empty-records guard returned the human string `No token usage data found.` *before* the `--json` branch, so `--json` on a fresh project (no `.planning/telemetry/token-usage.jsonl`) printed non-JSON — any caller doing `JSON.parse($(… --json))` would throw. The empty path now returns the same empty-shape object as the populated result (`{"slots":{},"sessions":{},"total":{"input":0,"output":0,"estimatedCost":0}}`); the human (non-`--json`) path is unchanged. Found by an error-path probe that runs every skill-captured `--json` script under missing/corrupt state. New behavioral assertion in `bin/token-dashboard.test.cjs`.
- fix(nf-tools): three error-path robustness bugs in the `core/bin/nf-tools.cjs` router, found by an error-path dogfooding probe (F49). (1) `template fill --fields '<bad>'` ran an **unguarded** `JSON.parse(args[…])` (every other parse in the router, e.g. `frontmatter merge --data`, is wrapped) → a raw `SyntaxError` stack trace on malformed/missing JSON; now a clean `Error: Invalid --fields JSON: …`. (2) `summary-extract <file> --fields` with the flag but **no value** called `.split` on `undefined` → raw `TypeError`; now a clean `Error: --fields requires a comma-separated value`. (3) **`config-set <key>` with no value silently lied** — it set the key to `undefined`, which `JSON.stringify` drops, writing nothing, yet still reported `{updated: true}` and exit 0; now it requires a value and exits with a clear usage error (the dangerous one — a no-op that claimed success). New behavioral assertions in `core/bin/nf-tools.test.cjs` (proven red against unfixed `main`: stack traces at `nf-tools.cjs:5591`/`:5863` and a phantom `updated:true`).
- fix(skills): harden state-file reads in three skills against missing/malformed JSON (dogfooding edge-path F48). Each read a state file with a `JSON.parse(fs.readFileSync(...))` guarded only by `existsSync` (or nothing) — so a corrupt (but present) file, or a wrong-shape one, crashed the skill's inline-JS step with a raw stack trace; in every case the *same file* guarded an identical read elsewhere, so these were localized omissions. (1) **`/nf:mcp-status`** Step 1 — the `scoreboard.json` and `~/.claude.json` reads now `try/catch` (a malformed scoreboard or config no longer kills the whole status command). (2) **`/nf:resolve`** Step 1 — the `candidate-pairings.json` read is wrapped and shape-tolerant (`Array.isArray(pd.pairings)` / `pd.metadata || {}`, so a partially-written file doesn't throw `TypeError: …filter`), and the `candidates.json` read is wrapped too. (3) **`/nf:mcp-repair`** Steps 2b/2c/2d — the three `providers.json` reads were both unguarded *and* hardcoded to `bin/providers.json` (which doesn't exist when the skill runs installed from a non-repo CWD → raw `ENOENT`); they now use the canonical portable resolver (`~/.claude/nf/bin` → `~/.claude/nf-bin` → `./bin`) with a `try/catch` per candidate, and the Step-3 `~/.claude.json` read is guarded as well. New `bin/skill-state-guards.test.cjs` extracts the actual embedded blocks and runs them under malformed/missing state (proven red against unfixed `main`: `SyntaxError` from mcp-status, `ENOENT` from mcp-repair).
- fix(audit/mcp): payload-audit precision + mcp-set-model allowlist (dogfooding F4a/F4c/F38). (1) **F4a** — `/nf:health`'s payload audit ran `nf-solve.cjs --json` (a full orchestrator whose `--json` *is* captured but is run-dependent and slow) to a 15s timeout and reported `error`. (2) **F4c** — it warned that `trace-corpus-stats.cjs --json` emits ~256KB. Its one caller (`solve-remediate.md`) only needs the *evidence file* the script writes, but it was running it with `2>/dev/null` — which redirects **stderr only**, so the 256KB of **stdout** actually *was* landing in the agent's context (the audit warning was right, not a false positive). Fixed the skill to redirect stdout too (`>/dev/null 2>&1`), making it genuinely fire-and-forget, and the audit now reports the script `skipped` with that accurate reason. Both nf-solve and trace-corpus-stats are handled via a small `KNOWN_NON_PAYLOAD` map. `audit-agent-payloads.cjs` also gained a `require.main` guard + `module.exports` (importable without running the audit). (3) **F38** — `/nf:mcp-set-model` calls `mcp__<agent>__identity` **directly** (gated by `allowed-tools`), but the frontmatter listed phantom `ccr-*` slots while omitting the real default Daintree slots (`claude-z-ai`, `claude-minimax`) — so model-name validation was silently skipped for those slots (falling back to an unvalidated write). Replaced the `ccr-*` entries with the real slots. (`/nf:mcp-status` is unaffected — it calls identity via a Task sub-agent, so its allowlist is inert.) While in the file, also fixed a same-class **env-after-eval bug** spotted in its Step 5 write step (`node -e "<js>" AGENT="$AGENT" MODEL="$MODEL"` left `process.env.AGENT`/`MODEL` `undefined`, persisting `model_preferences[undefined]=undefined`); moved the assignments before `node` (same fix as the F1 mcp-setup sweep). New `bin/audit-allowlist-precision.test.cjs`, wired into `test:ci`.
- fix(audit/mcp): payload-audit precision + mcp-set-model allowlist (dogfooding F4a/F4c/F38). (1) **F4a** — `/nf:health`'s payload audit ran `nf-solve.cjs --json` (a full orchestrator whose `--json` *is* captured but is run-dependent and slow) to a 15s timeout and reported `error`. (2) **F4c** — it warned that `trace-corpus-stats.cjs --json` emits ~256KB. Its one caller (`solve-remediate.md`) only needs the *evidence file* the script writes, but it was running it with `2>/dev/null` — which redirects **stderr only**, so the 256KB of **stdout** actually *was* landing in the agent's context (the audit warning was right, not a false positive). Fixed the skill to redirect stdout too (`>/dev/null 2>&1`), making it genuinely fire-and-forget, and the audit now reports the script `skipped` with that accurate reason. Both nf-solve and trace-corpus-stats are handled via a small `KNOWN_NON_PAYLOAD` map. `audit-agent-payloads.cjs` also gained a `require.main` guard + `module.exports` (importable without running the audit). (3) **F38** — `/nf:mcp-set-model` calls `mcp__<agent>__identity` **directly** (gated by `allowed-tools`), but the frontmatter omitted the real default Daintree slots (`claude-z-ai`, `claude-minimax`) — so model-name validation was silently skipped for those slots (falling back to an unvalidated write). Added them. (A static allow-list can't be exhaustive since slots are user-configurable, so the CLI defaults and the documented `ccr-1..6` are kept and the graceful fallback covers any other user-added slot.) (`/nf:mcp-status` is unaffected — it calls identity via a Task sub-agent, so its allowlist is inert.) While in the file, also fixed a same-class **env-after-eval bug** spotted in its Step 5 write step (`node -e "<js>" AGENT="$AGENT" MODEL="$MODEL"` left `process.env.AGENT`/`MODEL` `undefined`, persisting `model_preferences[undefined]=undefined`); moved the assignments before `node` (same fix as the F1 mcp-setup sweep). New `bin/audit-allowlist-precision.test.cjs`, wired into `test:ci`.
- fix(test): de-flake the circuit-breaker / prompt hook suites on loaded CI (the recurring `CB-TC9` Node-22 failure). Those tests invoke the hook via `spawnSync('node', [HOOK_PATH], { timeout: 5000 })`. The git-walking hooks do node startup + `git log` + per-pair diff analysis; **measured cold-cache under heavy parallel load at ~9 s** (warm ~1 s), so the 5 s cap killed the subprocess → `status = null` → a spurious `"exit code must be 0"` failure that looked like an oscillation-detection bug but was pure resource starvation (confirmed: CB-TC9 is 0/10 in isolation, and the hook windows by commit *count*, not wall-clock, so detection is deterministic). Raised the three hook-invocation timeouts (CB `runHook`, CB-TC14 malformed-stdin, prompt `runHook`) to 30 s — test-side headroom only, no production/hook behaviour change. Verified: under the same artificial CPU load that reproduced ~9 s cold runs, CB-TC9 passed with 0 failures in 3 runs.
- fix(roadmap/health): `/nf:roadmap analyze` returned **zero** phases on a ROADMAP that uses the checklist phase format (`- [x] Phase 54: Title`), and `/nf:health` then flooded its report with one **W007** per orphan phase — pinning it permanently at DEGRADED. The phase-extraction regexes (in `cmdRoadmapAnalyze`, `cmdPhaseComplete`'s ROADMAP fallback, `cmdValidateConsistency`, and `cmdValidateHealth`) only matched `## Phase` headings or **bold** checklist items, never a plain `- [x] Phase N:`. Widened the shared prefix to accept the unbolded checklist form (heading and bold forms still match). Because the parser now finds the roadmap's phases, the bogus W007s disappear; and the on-disk-but-not-in-ROADMAP check now **collapses** its remaining orphans into a single actionable W007 (`N phase(s) … : 50, 51, … — run /nf:cleanup`) instead of one warning each. New `bin/roadmap-health-parser.test.cjs` (behavioral, wired into `test:ci`): a checklist-format ROADMAP yields phases; heading/bold forms still parse; multiple orphans collapse to one W007. Found by dogfooding `/nf:roadmap analyze` and `/nf:health`.
- fix(mcp-setup): `/nf:mcp-setup` passed shell variables to its inline `node` evals **after** the command (`node -e "<js>" AGENT_KEY="…" API_KEY="…"`). In the shell, assignments that follow a command are positional `argv`, not environment — so every `process.env.AGENT_KEY` / `API_KEY` / `BASE_URL` / etc. inside those evals was `undefined`. The key-storage step (`process.env.AGENT_KEY.toUpperCase()`) would throw `Cannot read properties of undefined`, and the slot-config / provider-update evals silently saw empty values. Moved the trailing env run to **before** `node` on all 17 affected evals (`AGENT_KEY="…" node -e "<js>"`), so `process.env.*` is populated (and the env prefix survives the eval-guard's runtime heredoc rewrite). The JS bodies are byte-for-byte unchanged — only the env placement moved (verified by a JS-identity + eval-count invariant during the edit). New `bin/mcp-setup-env-order.test.cjs` scans the skill for any `node -e "…" VAR=` trailing-env (the broken form) and asserts env-before placement (wired into `test:ci`). Found by dogfooding `/nf:mcp-setup` (empirically confirmed `node script.js FOO=bar` leaves `process.env.FOO` undefined).
- fix(skills): four dogfooding correctness fixes. (1) **F30** `/nf:sync-baseline-requirements` had no way to preview — it always wrote `.planning/formal/requirements.json` and had no `--help`. Added `--dry-run` (computes + reports the merge, writes nothing) and `--help`/`-h` (usage, no work); both threaded through `syncBaselineRequirements`/`…FromIntent`/`_syncFromBaseline`. (2) **F32** `pr-resolve` SKILL.md told users to "Use the export-threads script", which doesn't exist — it's the `--export-threads` flag of `scripts/pr-merge-autopilot.sh`; reworded to the real command. (3) **F4b** `solve-remediate.md` re-ran `node bin/gate-c-validation.cjs --json`, a script intentionally deleted in `chore(quick-241)`; removed the dead invocation (the count already comes from the diagnostic/preflight, and the step was fail-open anyway). (4) **F13** `validate-requirements-haiku.cjs` silently no-op'd its semantic-validation pass when `ANTHROPIC_API_KEY` was unset (every Claude-Code-via-OAuth user), so `/nf:review-requirements` looked complete when a pass had been skipped — it now writes a loud stderr warning and tags the result `skipped_pass: 'semantic-validation'`. New `bin/sync-baseline-dry-run.test.cjs` (behavioral: dry-run/help write nothing, real run writes) and `bin/skill-cli-sweep.test.cjs` (F32/F4b scan guards + F13 stderr-warning behavioral), both wired into `test:ci`. Found by dogfooding `/nf:sync-baseline-requirements`, `/nf:pr-resolve`, `/nf:solve-remediate`, `/nf:review-requirements`.
- fix(skills): three dogfooding papercuts. (1) `/nf:session-insights` — `observe-handler-session-insights.cjs` emitted issues with no `category` field, but the skill's renderer groups output "by category", so the grouping silently fell back to ungrouped. Each of the 5 issue types now sets a `category` matching the renderer's groups (Tool Failures / Long Sessions / Circuit Breaker / File Churn / Hook Failures). (2) `/nf:reapply-patches` showed "Current version: {read VERSION file}", but there is no top-level VERSION file (version lives in package.json) — now reads from package.json. (3) `/nf:link-daintree` (renamed from link-canopy) still printed "LINK CANOPY" banners and told users to "re-run /nf:link-canopy", a command that no longer exists — banners → "LINK DAINTREE", command refs → `/nf:link-daintree` (the canopy-app *legacy install path* fallback is intentional and left intact). New `bin/skill-papercut-sweep.test.cjs` (wired into `test:ci`) cross-checks the handler's category set against the renderer's group list and scan-guards the other two.
- fix(formal-test-sync): `/nf:formal-test-sync`'s "safe" modes were not safe. (1) There was no `--help` guard, so `--help` (and any unrecognized flag) fell through to the **default full sync** — which generates stub files and writes `formal-test-sync-report.json` + `unit-test-coverage.json`. Just asking for usage mutated `.planning/formal/`. `--help`/`-h` now print usage and exit 0 with no analysis and no writes. (2) `--dry-run` is documented "no writes" but only gated the stub *files* — it still wrote the report + sidecar JSONs every run. `--dry-run` now skips those writes too (it still computes and shows what *would* be generated). `--report-only` (already correctly read-only) and the default write path are unchanged. New `bin/formal-test-sync-safety.test.cjs` runs the real script against a throwaway `--project-root` and asserts exactly which files each mode writes (wired into `test:ci`). Found by dogfooding `/nf:formal-test-sync`. (The earlier hypothesis that `extract-annotations.cjs` mutates was wrong — it is read-only.)
- fix(skills): two thin-wrapper command bugs found by dogfooding. (1) `/nf:update`'s post-update step ran `node bin/migrate-planning.cjs --project-root=$(pwd)`, but `migrate-planning.cjs` only parses `--root <dir>` — the unrecognized flag was ignored and the layout migration silently ran against the default root instead of the project. Now passes `--root "$(pwd)"` (matching the workflow source). (2) `/nf:queue` wrote the task with `printf '%s' '$ARGUMENTS'`; any task text containing a single quote (e.g. `"it's"`) broke the surrounding single-quote and mangled or truncated the queued command. Now writes via a quoted heredoc so the task round-trips verbatim. New `bin/skill-command-correctness.test.cjs` — behavioral (runs the extracted queue.md bash with a quote-containing task and asserts an exact round-trip) + flag-correctness guard (wired into `test:ci`).
- fix(mcp-update): `/nf:mcp-update` failed for every standard-install slot. A `node`-served agent was always classified `type:'local'` with `repoDir = dirname(dirname(args[0]))`, then updated via `cd <repoDir> && git pull`. For a standard install the server runs from `~/.claude/nf-bin/`, so `repoDir` resolved to `~/.claude` — which is **not** a git repo — and `git pull` failed for all of them (codex-1, gemini-1, claude-1, …). It now walks up to the nearest real `.git` working tree: found (a dev clone) → `git pull && npm run build` against the actual repo root (not a fixed two-dirs-up guess); not found (standard install) → a new `nf-managed` outcome that routes the user to `/nf:update` instead of attempting an impossible `git pull`. New `bin/mcp-update-classify.test.cjs` extracts the skill's inline classification blocks and runs them against git-clone vs standard-install fixtures (wired into `test:ci`). Found by dogfooding `/nf:mcp-update`.
- fix(solve-classify): `/nf:solve-classify --force` crashed. The step ran `node -e "<js>" $FLAGS`; nForma's eval-guard rewrites `node -e` to a `node << 'NF_EVAL' … NF_EVAL` heredoc, which puts `$FLAGS` *after* the delimiter — node then sees `--force` as a CLI option and dies with `node: bad option: --force` (exit 9). Pass the flag through the `NF_CLASSIFY_FORCE` env var instead (set before the heredoc, read via `process.env`), so no CLI arg trails the eval. New `bin/skill-eval-args.test.cjs` regression guard. Found by dogfooding `/nf:solve-classify`.
- fix(hooks): `nf-node-eval-guard` no longer false-positives on an inline `node` eval that appears inside a **heredoc body** — e.g. a `git commit -F - <<'MSG' … MSG` message that merely *mentions* one. The guard's quote scanner (`isInsideQuotes`) only tracked `'`/`"`, not heredoc delimiters, so it rewrote the mention and mangled the command (this kept blocking legitimate commits whose message described an eval bug). Added `findHeredocRanges()` (handles `<< DELIM`, `<<-DELIM`, `<< 'DELIM'`, `<< "DELIM"`); matches inside a heredoc body are skipped. A `<<DELIM` opener that itself sits inside a quoted string (e.g. `echo "<<'EOF'"`) is ignored, so it can't open a bogus body range that swallows a later real eval. Real evals after a *closed* heredoc still rewrite. Regression tests cover heredoc-body skips, quoted-opener safety, and post-heredoc rewrites. (Follow-up to PR #227.)
- fix(mcp): two embedded-JS bugs in mcp-* skills found by dogfooding. (1) `/nf:mcp-setup`'s Composition Screen parsed `~/.claude/nf.json` into `nfCfg` but then read `nf.quorum_active` — `nf` is undefined, so the `ReferenceError` was caught and the screen always rendered the fail-open "ON (all)" state regardless of the real `quorum_active`. (2) `/nf:mcp-repair`'s CLI-binary check was gated on `if (p.cli && p.mainTool)`, but `providers.json` carries `cli: null` (the path is resolved via `mainTool`), so the guard was always false and the `which <mainTool>` fallback probe was dead code — `cli-missing` was never detected. Fixed to `nfCfg.quorum_active` and `if (p.mainTool)` (with a null-safe `existsSync`). New `bin/mcp-skill-embedded.test.cjs` scanning guard (wired into `test:ci`).
- fix(tools): `nf-tools find-phase` now resolves archived phases. `cmdFindPhase` scanned only `.planning/phases/`, while `findPhaseInternal` (used by `init plan-phase`/`phase-op`) also searches archived `.planning/milestones/v*-phases/`. So `find-phase <N>` returned `found:false` for any phase belonging to a completed milestone — and the workflows that depend on it (`execute-phase` gap-closure, `audit-milestone`, `resume-work`) guard the not-found case, so they silently skipped parent UAT/artifact closure. `cmdFindPhase` now delegates to `findPhaseInternal`, giving one consistent phase-resolution path. New regression test (archived phase under `milestones/v0.9-phases/` is found). Found by dogfooding `/nf:execute-phase`.
- fix(cli): CLI-robustness fixes found by dogfooding. (1) `bin/nf-solve.cjs --help` and `bin/detect-coverage-gaps.cjs --help` had no `--help` guard, so the flag fell through — `nf-solve --help` ran the full diagnostic sweep and hung (>1min, ~530MB), and `detect-coverage-gaps --help` wrote `coverage-gaps.md`. Both now short-circuit with usage and exit 0 without doing any work. (2) `bin/check-provider-health.cjs --json` printed a human-readable "No HTTP-backed MCP slots found" string on the no-slots path (and exited 1 with a non-JSON error when `~/.claude.json` was missing), so callers that `JSON.parse` it (e.g. `quorum.md`) threw on CLI-only setups and in environments without a home config; under `--json` it now always emits valid JSON (`[]`) and exits 0, and it honors the `NF_CLAUDE_JSON` test override like the rest of the codebase. New `bin/cli-robustness.test.cjs` regression suite (wired into `test:ci`).
- fix(observe): `/nf:observe` upstream-release detection silently returned nothing. `observe-handler-upstream.cjs` passed `url` in `gh release list --json tagName,name,publishedAt,isPrerelease,url`, but `url` is not a valid field for `gh release list` (only for `gh release view`) — gh exits non-zero with `Unknown JSON field: "url"`, the `try/catch` swallows it, and ALL upstream releases for tight-coupled repos drop to `[]`. Removed the invalid field (the release URL is already reconstructed from `tagName`). Wired the existing `bin/observe-handler-upstream.test.cjs` suite into `test:ci` + added a field-hygiene regression test. Found by dogfooding `/nf:observe`.
- fix(skills): correct stale MCP worker tool names that silently broke the `/nf:debug` and `/nf:quorum-test` consensus. `debug.md` dispatched workers to `mcp__gemini-cli__gemini`, `mcp__opencode__opencode`, `mcp__copilot-cli__ask`, `mcp__codex-cli__codex` — none of which exist (the servers are `mcp__gemini-1__`/`mcp__opencode-1__`/`mcp__copilot-1__`/`mcp__codex-1__`, and copilot exposes `copilot`/`suggest`/`explain`, not `ask`). `quorum-test.md` likewise called the non-existent `mcp__copilot-1__ask`. Every worker failed to find its tool, so the consensus tables rendered all-UNAVAIL. Corrected all five names, fixed `debug.md`'s `resolve-cli` call (`require(bin).resolveCli('claude')` instead of `require(bin)()`, which always threw and silently fell back), and added `bin/skill-mcp-tool-names.test.cjs` (wired into `test:ci`) to catch CLI-server-name drift and unknown tool names going forward. Found by dogfooding `/nf:debug` and `/nf:quorum-test`.
- fix(portability): replace hardcoded `/Users/jonathanborduas/.claude/...` author paths in skills/workflows that shipped verbatim and broke on every other user's machine. `complete-milestone.md`, `fix-tests.md`, `solve.md`, `solve-report.md`, and `close-formal-gaps.md` referenced the literal author home path (for `nf-tools.cjs`, `nf-bin/` scripts, `commands/nf/` sub-skills, and a workflow `@`-include) instead of the portable `~/`/`$HOME` forms the installer expands per-user — so on any non-author machine those `node` calls and `@`-includes resolved to a nonexistent path. Converted to `~/.claude/nf/...` (@-includes), `$HOME/.claude/nf-bin/` and `$HOME/.claude/commands/nf/` (the established conventions). The `lint:isolation` gate missed this entirely because it only scanned `commands/nf/` (never `core/workflows/`) and had no rule for absolute home paths; extended `SCAN_DIRS` to include `core/workflows/` and added an `absolute-home-path` rule that flags literal `/Users/<name>/.claude` and `/home/<name>/.config` paths. Found by dogfooding `/nf:complete-milestone`.
- fix(coderlm): `/nf:coderlm` query subcommands (`callers`, `implementation`, `tests`, `peek`) were completely broken — they threw `adapter.getCallers is not a function`. The skill called the query methods on the required *module*, but those methods are instance methods on the object returned by `createAdapter()` (the module only exports `createAdapter`, `healthCheck`, `filterSourceCallers`). Fixed all four snippets to `require(adapterPath).createAdapter()`. Added an adapter-API-contract regression test (module exposes `createAdapter`; the instance exposes `getCallers`/`getImplementation`/`findTests`/`peek`) so the skill's API shape can't silently drift again. Found by dogfooding `/nf:coderlm callers`.
- fix(solve): `solve-commit-artifacts` (the `nf:solve` auto-commit) no longer commits onto a protected/default branch and no longer leaks developer-local snapshots. It (1) **refuses to commit when on `main`/`master`** (or the resolved `origin/HEAD` default) — returning before it stages anything, so the index is left unmodified — so a solve run started on `main` no longer drops unpushed `chore(solve)` churn there (which previously polluted every branch cut from local `main`); and (2) **un-stages `test/golden/`** before committing, since those TUI golden snapshots embed absolute `/Users/...` paths and are never real solve artifacts. The existing `bin/solve-commit-artifacts.test.cjs` suite is now wired into `test:ci` with new protected-branch + golden-exclusion regression tests. Found by dogfooding (an `nf:solve` run had auto-committed 3× to `main` mid-session).
- fix(tools): `nf:tokens` (`token-dashboard.cjs`) now finds token telemetry again. It defaulted to the legacy flat path `.planning/token-usage.jsonl`, which the v0.27 layout migration emptied by moving telemetry into `.planning/telemetry/` — so the dashboard always printed "No token usage data found" even with hundreds of KB of real data present. It now resolves via `planning-paths.resolveWithFallback(cwd, 'token-usage')` (canonical telemetry path, then legacy fallback). Added CLI regression tests (canonical path, legacy fallback, graceful-empty). Found by dogfooding `/nf:tokens`.
- fix(hooks): `nf-node-eval-guard` no longer false-positives on `node -e "..."` substrings that appear *inside* another command's quoted argument. The guard rewrites real `node -e` evals to heredoc form, but it matched the literal `node -e "` anywhere in the command — so `grep -rl 'node -e "' src` or `echo "...node -e..."` got denied and "rewritten" into a garbled command spanning unrelated quote boundaries. A new `isInsideQuotes()` quote-state scanner skips matches sitting inside an open single/double quote, so only genuine command-position evals are rewritten. Added `isInsideQuotes` unit tests plus the exact grep repro as regression gates. Found by dogfooding `/nf:health`.
- fix(tools): `nf-tools progress` (`bar`/`table`) no longer crashes with `RangeError: Invalid count value` when a milestone has more SUMMARY files than PLAN files (orphan summaries → completion percent > 100). The progress bar computed `filled` from an unbounded percent, so `'░'.repeat(barWidth - filled)` received a negative count and threw — taking down the `/nf:progress` report step. `filled` is now clamped to `[0, barWidth]` at all three render sites; the bar shows full at ≥100%. New `core/bin/nf-tools.test.cjs` regression tests (200% fixture → exit 0, full bar). Found by dogfooding `/nf:progress`.
- fix(coderlm): `coderlm-adapter` now filters documentation/prose files (`.md`, `.markdown`, `.mdx`, `.txt`, `.rst`, `.adoc`) out of caller results. coderlm indexes Markdown and reports prose mentions of a symbol as "callers", which inflated caller-count priority ranking in `nf:solve` (`sweepGitHeatmap`/`sweepCtoR`/`sweepTtoR`) — e.g. `ensureRunning` returned 11 "callers", 4 of them doc mentions. Caller counts now reflect real source call sites only. New `bin/coderlm-adapter-filter.test.cjs` regression gate, wired into `test:ci` (the existing `coderlm-adapter.test.cjs` mock suite predates the v0.42 session API and never ran in CI).
- fix(quorum): `quorum-consensus-gate.cjs` no longer requires `run-prism.cjs` to borrow `readMCPAvailabilityRates`. Requiring `run-prism.cjs` used to run its entire PRISM pipeline at import time (`process.exit`, `spawnSync`, scoreboard `argv` forwarding), which could kill the consensus gate (read as a permanent defer/escalate) and append spurious `prism:quorum` records. The helper is now in a side-effect-free `bin/scoreboard-rates.cjs`, and `run-prism.cjs`'s pipeline is wrapped in `main()` behind `require.main === module`. Added `bin/no-side-effects-on-require.test.cjs` regression gate. (#198)
- fix(mcp): `unified-mcp-server.mjs` now resolves the spawn executable through the same 3-tier fallback as `call-quorum-slot.cjs` (`resolvedCli → cli → mainTool`) via a shared `resolveSpawnTarget` helper. The previous `provider.resolvedCli ?? provider.cli` expression could hand `null` to `child_process.spawn` for `mainTool`-only slots (`providers.json` carries `cli: null`), throwing the opaque `TypeError: The "file" argument must be of type string. Received null`. An unresolvable provider now fails with a named `[spawn error: provider <name> has no resolvable CLI ...]` instead. The deep health check binary lookup uses the same fallback (#193, follows #161/#164)
- fix(mcp/install): resolve a provider's CLI from `mainTool` when the `cli` field is null, and self-heal a missing `mainTool` — without this the resolved CLI stayed unset and spawn received `null`, taking the whole quorum offline (#161, #164)
- fix(quorum): backport the `mainTool` CLI fallback to `probe-quorum-slots` so slot health probes resolve binaries the same way dispatch does (#180)
- fix(quorum): replace a truthy gate in `detectInstalledProviders` that excluded validly-configured slots (#183)
- fix(mcp): auto-fall-back to the user-installed `providers.json`, and backfill `UNIFIED_PROVIDERS_CONFIG` when the repo-shipped source is empty (#162, #163)
- fix(quorum): prefer the slash-path `providers.json` so Daintree-registered slots are visible to the quorum (#165)
- fix(provider-concurrency): PID-based file semaphores no longer leave stale locks after a crash or `SIGKILL` — stale-lock reclamation (dead PID, previous-boot detection, TTL backstop) now runs on every pass of the acquire retry loop, so a slot freed by a holder that dies while another caller is waiting becomes available within one backoff cycle instead of blocking until timeout; `process.kill(pid,0)` `EPERM` is now treated as alive and a boot-time field guards against post-reboot PID reuse (#187, addresses #176)
- fix(call-quorum-slot): HTTP provider slots are now held for the full request lifetime — the slot was previously released in a synchronous `finally` the instant `req.end()` returned, before the response arrived, which defeated the per-provider concurrency cap (#176)
- fix(quorum): model correlated provider failures in the early-escalation gate so a shared-upstream outage no longer reads as independent slot failures (#190)
- fix(quorum/link-daintree): attribute fan-out slots to their actual upstream provider, make fan-out idempotent across installs, persist fan-out preset metadata to an install-immune store, and always register `health_check` plus smoke-probe for newly created slots (#158, #159, #179, #184)
- fix(quorum/link-daintree): store API tokens as `${VAR}` placeholders instead of plaintext (#182)
- fix(mcp-status): read the quorum scoreboard from the correct path (#166)
- fix(autopilot): trust GitHub server merge state over the `gh` CLI exit code when deciding whether a merge succeeded (#185)
- fix(statusline): River status cyan now means "has visits" (reward data exists), not merely "has arms" (#155)

## [0.43.1] - 2026-05-03

### Fixed
- fix(link-daintree): fan-out fallback logic no longer silently drops presets when no vanilla provider has a matching `provider` field — the family gate is now correctly bypassed when the inferred family doesn't match any vanilla slot, falling back to all candidates sorted by daintree_preset_id then numeric suffix

## [0.43.0] - 2026-05-02

### Changed
- refactor(install): manifest-driven CLI detection — `providers.json` now shipped empty and populated at install time from `~/.claude.json` MCP servers and PATH auto-detection

### Fixed
- fix(formal): resolve merge conflict markers in `.planning/formal/` JSON files that caused `extract-annotations.cjs` to fail with JSON parse errors
- fix(formal): give `max_retries` a safe default value in `oauth-rotation.pm` — PRISM requires all constants to be defined

## [0.43.0-rc.1] - 2026-04-23 — next prerelease

### Changed
- ci: testing next release pipeline (0.43.0 milestone)

## [0.42.6] - 2026-04-23 — CI/CD testing

### Changed
- ci: prepare-release.sh and release.sh now test the full release pipeline

## [0.42.5] - 2026-04-21

### Fixed
- `fix(providers)`: remove duplicate ccr-1..ccr-6 entries with hardcoded `/opt/homebrew/bin/ccr` path — quorum wiring now works on Linux/WSL (#108)

## [0.42.4] - 2026-04-21

### Added
- Six human phase skills ship with nForma: `nf:idea`, `nf:plan`, `nf:build`, `nf:ship`, `nf:debug`, `nf:observe` — each `SKILL.md` documents sub-skills, commands, entry/exit conditions, and routing across the full development lifecycle (closes #94)
- `benchmarks/full-benchmark-baseline.json` — source of truth for nForma's benchmark score (15.2% / 35/230)
- `nf-benchmark` submodule integrated for full 230-challenge benchmark suite

### Changed
- Benchmark CI gate now runs full 230-challenge suite on PRs with zero-tolerance regression blocking
- Baseline auto-updates in nForma repo on push to main when score improves

### Fixed
- `fix(nf-stop)`: `parseQuorumSizeFlag` now rejects fractional values (`--n 1.5`) instead of silently truncating to solo mode
- `fix(nf-stop)`: adversarial hardening added `--n 0` boundary handling and `is_error: true` propagation checks
- `fix(config-loader)`: `slotToToolCall` fallback invariants verified
- `fix(nf-circuit-breaker)`: `makeFileSetHash` order-independence and empty-array handling confirmed

## [0.42.3] - 2026-04-11 — Repowise Intelligence Integration (v0.42 milestone)

### Added
- `feat(solve)`: Add real impact tracking to solve skill — reports lead with bugs_fixed, tests_added, docs_fixed, dead_code_removed summary computed from git diff excluding .planning directory
- `feat(solve)`: Remediation dispatches now classified as real_fix, true_positive_closure, fp_suppression, or reclassification
- `feat(solve)`: Remediation sub-skill runs npm run test:ci and npm run lint:isolation after waves, dispatching /nf:quick fixes for any new failures
- `feat(solve)`: solve-state.json tracks real_impact per iteration

### Fixed
- `fix(test)`: River ML statusline tests (TC15/16/19/21/22/23) now mock `HOME` with a fake `nf-python-env/bin/python` — these tests passed locally (where `~/.claude/nf-python-env` exists) but failed in CI where the runner has no python env, causing the River indicator gate to skip the state file check entirely

## [0.42.1-rc.1] - 2026-04-10 — coderlm operational hardening

### Fixed
- `fix(coderlm)`: circuit-breaker in `sweepGitHeatmap` stops querying after 3 consecutive `getCallersSync` failures — prevents 5 s timeout × N-files overhead when server is unresponsive
- `fix(coderlm)`: pre-flight `healthSync()` before first sweep emits availability to stderr so fail-open status is visible before queries start
- `fix(coderlm)`: CDIAG-03 wired into solve loop — in `--skip-layers` incremental mode, call-graph expansion via `computeAffectedLayers` un-skips layers whose transitive callers were affected by remediation

## [0.42.0-rc.1] - 2026-04-10 — Deep coderlm Solve Integration

### Added
- `feat(repowise)`: XML context packing — `escape-xml.cjs`, `pack-file.cjs`, `context-packer.cjs` deliver file contents in `<file path="...">...</file>` XML format with proper escaping (PACK-01, PACK-02, PACK-03)
- `feat(repowise)`: Hotspot detection — `hotspot.cjs` computes per-file churn×complexity risk scores from git log with streaming parsing, mass-refactor weighting, and noise filtering (HOT-01, HOT-03, HOT-04)
- `feat(repowise)`: AST-based cyclomatic complexity — `computeAstComplexity()` uses skeleton.cjs tree-sitter AST parsing for per-file complexity, with line-count heuristic fallback; `computeHotspotsAst()` async variant and `--use-ast-complexity` CLI flag (HOT-02)
- `feat(repowise)`: Quorum escalation from hotspots — `resolve-hotspot-risk.cjs` + nf-prompt.js HOT-05 automatically escalate quorum fan-out for high-risk files (HOT-05)
- `feat(repowise)`: Co-change prediction — `cochange.cjs` mines file co-occurrence pairs from git history with temporal coupling scoring and inverse file-count weighting; `inject-cochange-debug.cjs` surfaces partners in debug context (COCH-01, COCH-02, COCH-03, COCH-04)
- `feat(repowise)`: Skeleton views — `skeleton.cjs` extracts structural code views via web-tree-sitter WASM (lazy init) with regex fallback; enriches entries with hotspot risk and coupling degree (SKEL-01, SKEL-02, SKEL-03, SKEL-04)
- `feat(repowise)`: Budget-aware compression — `budget-compressor.cjs` adapts context detail level to token budget with risk-weighted allocation; `--budget=N` flag in context-packer (PACK-04)
- `feat(context-retriever)`: `repowise` domain added to context-retriever — hotspot-cache.json, cochange-cache.json, and repowise keyword detection
- `feat(task-classifier)`: `adjustForHotspotRisk()` reads hotspot cache to escalate task complexity when touching high-risk files (simple→moderate at score >0.4, →complex at >0.7)
- `feat(workflows)`: Context-packer wired into plan-phase.md (step 4.7), quick.md (step 2.75), debug.md (step A.3) with fail-open pattern
- `feat(hotspot)`: `loadHeatmapChurn()` reuses git-heatmap.json churn ranking data instead of re-parsing git log

### Changed
- `refactor(repowise)`: hotspot.cjs now tries heatmap cache data first before git log reparse, merging existing git-heatmap.cjs signals

## [0.41.18] - 2026-04-09 — River ML Q-learning and tech debt standardization

### Added
- `feat(routing)`: River ML Q-learning replaces the bandit policy — `routing-policy.cjs` now uses `QLearning` with ε-greedy exploration, learning rate 0.1, discount 0.9, and a reward signal wired into Mode C dispatch on task completion (#73)
- `feat(statusline)`: River ML phase indicator in `nf-statusline.js` — shows current routing policy phase (exploration / exploitation / shadow) with live shadow-mode recommendations surfaced from the learning loop state file
- `feat(quick-384-386)`: E2E learning loop test (`quick-386`) validates the full River ML cycle: dispatch → reward recording → Q-table update → shadow recommendation persistence
- `feat(verify-work)`: framework-native tests (Playwright first, Jest fallback) now auto-discovered and run via `maintain-tests run-batch` before UAT prompt — UAT completes automatically when all pass
- `docs(issue-77)`: 10 technical debt items (DEBT-07–DEBT-16) formalized as tracked requirements in `requirements.json` — covering JSON serialization patterns, path resolution, empty catch blocks, 4 formal model gaps, and the audit process itself

### Changed
- `refactor(routing)`: `quorum-slot-dispatch.cjs` records routing reward after each Mode C dispatch result — success/failure/partial mapped to +1/−0.5/+0.25

## [0.41.17] - 2026-04-08 — Config-driven milestones

### Added
- `feat(config)`: `default_milestone` field in `.planning/config.json` allows projects to specify a milestone without requiring STATE.md or ROADMAP.md — enables milestone workflows in early-stage projects (#64)
- 10 tests covering all `default_milestone` code paths: config parsing, format normalization, priority ordering, "auto" bypass, empty string fallback, and `phase-plan-index` population
- Requirement CONF-10 elevated to formal requirements

### Fixed
- `fix(gsd-tools)`: `cmdInitQuick()` now populates `chosen_milestone` and `default_milestone_used` fields (were declared but never set)

## [0.41.16] - 2026-04-07 — The skills gap is now a skills overlap

### Added
- Six packaged skills ship with nForma out of the box: `nf:task-intake`, `nf:idea-refine`, `nf:code-review-and-quality`, `nf:security-and-hardening`, `nf:documentation-and-adrs`, and `nf:shipping-and-launch` — best practices from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills), now fluent in nForma's workflow language
- Checklist registry (`core/references/checklist-registry.json`) + `bin/checklist-match.cjs` — type a task description, get the right checklist back, no manual routing required
- Upstream guidance gaps closed: accessibility, API design, performance, security, TDD, testing patterns, verification patterns, and git integration checklists all now speak to nForma-specific concerns

### Changed
- Packaged skill commands trimmed to the essential six; removed skills' guidance folded into core workflow references so nothing is lost, just better placed
- Checklist routing in `nf:quick` now driven by the registry instead of hardcoded conditions

## [0.41.15] - 2026-04-07 — Automatic test reuse in verify-work

### Added
- `feat(verify-work)`: `present_test` step now auto-discovers and runs framework-native tests (Playwright first, Jest fallback) via `maintain-tests discover` + `maintain-tests run-batch` before presenting to user — UAT completes automatically when all discovered tests pass, falls back to manual checkpoint when tests fail or no tests are found

## [0.41.14] - 2026-04-06 — Dist-tag alignment automation

### Fixed
- `fix(ci)`: `release.yml` now auto-aligns `@next` dist-tag to match `@latest` after every stable publish — ensures `next` never falls behind `latest`
- `fix(publish)`: `publish.sh` (manual publish) also aligns `@next` after stable publish and prints dist-tag summary

### Changed
- `docs(CLAUDE.md)`: add dist-tag invariant rule — `next` must never fall behind `latest`, with verification command
- `docs(prepare-release.sh)`: PR body and post-merge instructions now mention `@next` alignment step
- `docs(release.sh)`: post-release instructions now mention dist-tag verification

## [0.41.13] - 2026-04-06 — Formal verify CI fix & CLAUDE.md tracking

### Fixed
- `fix(ci)`: remove `paths` filter from `formal-verify.yml` `pull_request` trigger — formal verification is a required branch protection check, so it must run on every PR regardless of which files changed

### Changed
- `chore`: track `CLAUDE.md` in git — release process docs, CI troubleshooting, and key commands are now available to all contributors and fresh clones

## [0.41.12] - 2026-04-06 — Skill distribution via installer

### Added
- `feat(install)`: distribute skills from `agents/skills/` to `~/.claude/skills/` during installation — currently installs `task-intake` skill

## [0.41.11] - 2026-04-06 — Multi-runtime installer & bug fixes

### Added
- `feat(install)`: support 9 new runtimes — kilo, cursor, windsurf, codex, copilot, antigravity, augment, trae, cline — each with `--{runtime}` flag, directory mapping, and config path
- `feat(install)`: defensive fallback for unknown runtimes in `getDirName()` (returns `.{runtime}` instead of crashing)
- `test(install)`: add smoke test for claude local skill distribution (`tests/bin/install-claude-skills.test.js`)

### Fixed
- `fix(gsd-tools)`: stdout truncation at 8KB when piped — `process.exit(0)` was called before `process.stdout.write()` buffer could flush; replaced with synchronous `fs.writeSync(1, data)` to guarantee full output
- `fix(install)`: resolve `binDir` reference error in CCR preset sync — use explicit `binDirResolved` fallback when `binDir` is undefined
- `fix(ci)`: add `npm ci || npm install` fallback to release.yml (test and publish jobs) — matches ci.yml resilience pattern; fixes 0.41.10 release pipeline failure
- `fix(test)`: isolate nf-stop quorum enforcement tests from project `.claude/nf.json` — pass `hookCwd` to `runHookWithEnv()` so `loadConfig()` reads from temp home instead of real project config

## [0.41.10] - 2026-04-06 — CI resilience & task-intake skill distribution

### Changed
- `fix(ci)`: workflow install steps now fall back to `npm install` when `npm ci` fails due to merge-ref lockfile drift — resolves persistent PR check failures
- `feat(skill)`: add task-intake skill distribution copy to `agents/skills/task-intake/SKILL.md`

## [0.41.8] - 2026-04-03 — Pure JS TUI & D→C FP Reduction

Deprecates blessed-xterm (native C++ node-pty dependency) in favor of pure JS blessed-terminal.cjs. Reduces D→C false positives with glob expansion, system tool allowlist, and design doc fuzzy rename detection.

### Changed
- `feat(tui)`: replace `blessed-xterm` + `node-pty` with pure JS `blessed-terminal.cjs` (`@xterm/headless` + `child_process.spawn`) — zero native dependencies, works on all platforms
- `feat(tui)`: remove 30-line node-pty auto-rebuild fallback from TUI boot

### Added
- `feat(solve)`: D→C glob pattern expansion — `seed_data/*.json` now resolves to matching files instead of being flagged as broken
- `feat(solve)`: system tool allowlist (40+ entries) — `nvidia-smi`, `docker`, `git`, etc. auto-suppressed from dependency checks
- `feat(solve)`: design doc fuzzy rename detection — files from `docs/plans/` with keyword-overlapping siblings are suppressed (catches `features.py` → `linucb.py` renames)

### Fixed
- `fix(test)`: ensure `~/.claude/` directory exists in `withNfJson` test helper — CI failure after node-pty removal (node-pty postinstall previously created this directory)

### Removed
- `blessed-xterm` dependency (v1.5.1)
- `node-pty` dependency (v1.1.0)
- `overrides.blessed-xterm` section from package.json
- `git-heatmap.json` from git tracking (gitignored — 138K+ line churn per solve run, still generated locally)

## [0.41.7] - 2026-04-02 — Solve Telemetry & Robustness

Comprehensive observability for the `/nf:solve` pipeline: per-layer timing, global deadline, session-aware token tracking, and convergence analysis tooling. Fixes diagnostic hang caused by unbounded test suite execution.

### Added
- `feat(solve)`: per-layer timing telemetry — 29 sweep calls timed with `Date.now()` deltas, `timing` object in JSON output with `{ layer_key: { duration_ms, skipped } }` and `total_diagnostic_ms`
- `feat(solve)`: diagnostic timing summary in solve-report (Step 6.3) — top-5 slowest layers, total wall-clock, skipped count
- `feat(solve)`: session-aware token tracking via `NF_SOLVE_SESSION_ID` env var propagated through Agent subprocesses
- `feat(solve)`: convergence timeline analysis tool (`bin/analyze-solve-convergence.cjs`) — sparklines, per-layer trends, requirement growth, timing bottlenecks
- `feat(solve)`: global deadline mechanism (`--global-timeout=<ms>`, default 180s) — wall-clock checks between sync operations prevent indefinite hangs
- `feat(solve)`: `--fast` default for initial diagnostic — skips T→C test execution and F→C formal verification layers, reducing diagnostic from ~30min to ~2.5s
- `feat(solve)`: `--full` flag to opt in to expensive T→C/F→C layers
- `feat(solve)`: `--no-timeout` flag to disable global deadline (for debugging/tests)

### Fixed
- `fix(resolve)`: use `nf-bin` path resolution for `solve-tui.cjs` instead of `PROJECT_ROOT` — fixes `/nf:resolve` failing in user projects where nForma bin/ tools aren't in the project directory

## [0.41.6] - 2026-04-02 — Quorum Infrastructure Overhaul & Project-Level Formal Specs

Major quorum infrastructure overhaul: HTTP API dispatch for claude-1..6, Option C file-based slot output, slot-worker hardening, truncation integrity pipeline, and file write reliability (25% → 100%). New project-level formal spec discovery with security-hardened execution.

### Added
- `feat(quick-365)`: truncation integrity pipeline — markers, metadata propagation, TLA+ model `NFOutputIntegrity.tla` with 6 invariants, nf-stop.js truncation awareness
- `feat(quick-366)`: `FLAG_TRUNCATED` verdict type — excluded from consensus when truncation caused verdict loss
- `feat(quick-368)`: 3-layer robust quorum fail-fast — idle timeout tuning, failure cooldowns, `--ensure-services` pre-flight
- `feat(quick-369)`: provider-level concurrency control — file-based semaphore limits Together.xyz to 3 concurrent HTTP requests, preventing rate-limit cascades
- `feat(quick-369)`: project-level formal spec discovery — `formal-scope-scan.cjs` discovers specs from `.planning/formal/specs/formal-checks.json` manifest, merges into model-registry view
- `feat(quick-369)`: structured command execution in `run-formal-check.cjs` — 3-gate security: command allowlist, dangerous arg pattern guard (`-e`/`-c`/`--eval`), path containment
- `feat(quorum)`: adaptive stall detection (30s timeout when < 500 bytes received) and early rate-limit detection (kills CLI after 2 consecutive retry messages)
- `feat(telemetry)`: `output_preview`, `output_length`, `exit_code` fields in quorum telemetry records
- `test`: 15 new tests for `formal-scope-scan.test.cjs` (manifest discovery, keyword/module matching, registry merge, E2E bug-mode)
- `test`: 12 new tests for `run-formal-check.test.cjs` (allowlist, arg guards, path traversal, pass/fail commands)

### Changed
- `fix(quorum)`: switch claude-1..6 from CCR subprocess to direct HTTP API dispatch — eliminates CCR overhead, adds HTTP-aware prompt adaptation for tool-less slots
- `fix(quorum)`: Option C file-based slot output — Node script writes result files directly via `--output-file`, removing Haiku from the critical path
- `fix(quorum)`: pre-built command agent — slot-worker runs one pre-formed Bash command (no YAML arg parsing)
- `fix(quorum)`: swap providers — AkashML→Together for claude-1/2, claude-5→GPT-OSS-120B, Gemini pro→flash (free tier quota)

### Fixed
- `fix(quorum)`: HTTP slot health check — skip layer1 binary probe for `type:http` slots, add layer2 API probe (0/6 → 6/6 HTTP slots available)
- `fix(quorum)`: bug-mode integration — `runBugModeMatching` now accepts preloaded registry parameter, merged project specs actually used in bug-mode matching
- `fix(quorum)`: prohibit background Bash in slot-worker agent — prevents file-write race from `run_in_background`
- `fix(quorum)`: early output-file PENDING marker — 3-state diagnostic (missing/PENDING/complete) for result file provenance
- `fix(quorum)`: defense-in-depth file write from `call-quorum-slot.cjs` child process — bypasses Haiku arg-stripping of `--output-file`
- `fix(quorum)`: context window pre-flight check + content-based STALL reclassification
- `fix(quorum)`: `FLAG_TRUNCATED` only when verdict was lost (not when it survived truncation)
- `fix(quorum)`: filter framework noise (hook logs) from valid-output detection
- `fix(quick-367)`: `findProjectRoot` honors `--cwd` argument; non-zero exit with valid output treated as available
- `fix(ci)`: add missing `latency_budget_ms` field to claude-5/claude-6 providers, update stale test expectations

## [0.41.5] - 2026-03-28 — Quorum Convergence Rewrite Restoration

Restores quorum convergence rewrite logic that was previously removed. When 3+ BLOCK verdicts accumulate, the workflow now triggers a fresh rewrite instead of continuing to iterate on a blocked approach.

### Fixed
- `fix(quick-364)`: restore `QUORUM_BLOCK_COUNT` tracking, accumulated block reasoning, and fresh-rewrite-after-3-BLOCKs convergence logic in `quick.md`

## [0.41.4] - 2026-03-27 — Loop 1 + Loop 2 Full Execution Path Coverage

Incremental on [0.41.3]. Wires debug routing (Loop 1) and formal simulation (Loop 2) into all default phase execution paths.

### Added
- `feat(quick-362)`: wire debug routing (Loop 1 + task classification + `debug_context` injection) into `execute-phase.md` — Step 1.5 classifies each plan via Haiku as bug_fix/feature/refactor, routes bug_fix plans through `/nf:debug` before executor spawn, injects `<debug_context>` block into executor prompt
- `feat(quick-363)`: push Loop 2 (`formal_coverage_auto_detection` + `solution-simulation-loop`) and `debug_context` passthrough into `execute-plan.md` Pattern A spawn prompt — nested child executors now inherit both verification loops

### Changed
- **Changelog rewrite** — all 0.41.x entries rewritten from git history; every `feat`/`fix`/`req` commit now has a corresponding entry with git prefix for traceability

### Coverage matrix

| Path | Loop 1 | Loop 2 |
|------|--------|--------|
| `quick.md` | Yes | Yes |
| `execute-phase.md` → Pattern A | Yes | Yes (new) |
| `execute-phase.md` → Pattern B | Yes | Yes |
| `execute-phase.md` → Pattern C | Yes | Yes |
| `execute-phase.md` → Pattern D | Yes | No (opt-in, deferred) |

## [0.41.3] - 2026-03-27 — Live Health Dashboard Fix

Incremental on [0.41.2]. Fixes TUI health dashboard that silently skipped all subprocess providers.

### Added
- `feat(agents)`: subprocess probing and `providers.json`-backed dashboard — TUI Live Health dashboard now probes subprocess providers via CLI `--version` checks and shows provider name + model from `providers.json`

### Fixed
- `fix(tui)`: remove duplicate `pdata` declaration in `checkHealthSingle` — eliminated early bail that blocked probing subprocess providers entirely

## [0.41.2] - 2026-03-27 — Enhanced Resolve Triage

Incremental on [0.41.1]. Overhauls `/nf:resolve` presentation with structured analysis and quorum integration.

### Added
- **Detailed resolve reports** — `/nf:resolve` now shows Key Files, Analysis, Pros & Cons, and Conclusion sections for every item type (solve items, pairings, orphan models, orphan requirements)
- **Clickable file paths** — all file references in resolve output use `file_path:line_number` format for direct navigation
- **Mandatory quorum action bar** — every resolve item and batch displays `[q] Quorum` option for multi-model consensus review
- **Batch action choices** — batch presentations include confirm-all, FP-all, and individual-item-by-number actions

### Changed
- **Resolve presentation format** — upgraded from simple verdict+recommendation to structured analysis with pros/cons trade-offs per action option
- **Orphan model context** — shows 15-20 lines of model file (up from 10-15) with module identification
- **Pairing analysis depth** — reads both model file and requirement text to assess semantic connection vs keyword overlap

### Fixed
- **Local patch drift** — synced enhanced resolve.md from nf-local-patches back to repo source
- `fix(ci)`: skip state-space guard for MCMCPEnv bounded model — individual step + master FV runner

## [0.41.1] - 2026-03-26 — Risk-Based Adaptive Quorum, Solve Reporting & Diagnostic Sweeps

Incremental on [0.41.0]. Adds risk-aware quorum sizing, expands diagnostic sweeps to 20 layers, and adds automation-first verification. Includes quick tasks 354-361.

### Added

#### Risk-Based Adaptive Quorum (quick-360)
- `feat(quick-360)`: add risk-based adaptive quorum fan-out with Haiku risk classifier — classifies tasks as low/medium/high risk based on file count, task type, requirements impact, and scope
- **Adaptive quorum fan-out** — Step 5.7 dispatches low=1 (skip quorum), medium=3, high=5 participants based on risk level
- **`--force-quorum` flag** — overrides low risk classification to medium, forcing external quorum dispatch
- **Quorum audit logging** — structured audit log emitted for every quorum reduction or skip with risk level, reason, and fan-out count
- **Risk guardrails** — ROADMAP, formal model, hook, and workflow files can never be classified as low risk
- **Scope contract risk fields** — `risk_level` and `risk_reason` persisted in scope-contract.json

#### Solve Pipeline Enhancements (quick-354 through quick-357)
- `feat(quick-354)`: add 5 missing layers to solve-report table renderer — full 20-layer coverage with checker alignment and signals fixes
- `feat(quick-355)`: auto-invoke `/nf:resolve` after solve finishes iterating
- `feat(quick-356)`: add 7 new sweep functions and fold 8 scripts into existing sweeps — wire 7 new sweeps into `computeResidual`, totals, table, `DEFAULT_WAVES`
- `feat(quick-357)`: add `@requirement` annotations to 8 domain-named test files + require-path tracing to `sweepTtoR` (TC-CODE-TRACE-8 test)

#### Formal & Discovery (quick-358, quick-359, quick-361)
- `feat(quick-358)`: extract unified graph search module and add graph-first discovery to `formal-scope-scan.cjs` — shared with `candidate-discovery.cjs`
- `feat(quick-359)`: allow `formal_artifacts: create` when scope-scan returns empty — enables new model bootstrapping
- **Automation-first verification** (quick-361) — verify-work and execute-phase workflows prefer Playwright/agent-browser over manual testing

### Changed
- **quorum-dispatch.md Section 3** — updated fan-out mapping: low=1/skip, medium=3, high=5 (previously low=2, high=MAX_QUORUM_SIZE)
- **Quorum timeout defaults** — increased from 30s to 300s for slot worker dispatch

### Fixed
- `fix(ci)`: allowlist quorum debate transcripts in gitleaks
- `fix(ci)`: fetch latest gitleaks version dynamically
- `fix(ci)`: use gitleaks-action v2 and unpin detect-secrets
- `fix(quick-354)`: revise plan to address checker alignment and signals issues
- `fix`: use portable nf-bin path in debug.md require() for lint-isolation
- **Orphan requirements** — triaged 48 orphan requirements across 6 category groups

## [0.41.0] - 2026-03-25 — Unified Autoresearch Execution Pipeline

Full milestone release building on [0.40.2]. Includes 4 milestone phases (50-53) and 17 quick tasks (337-353). Major themes: autoresearch-style iteration across all formal loops, solve pipeline optimization, debug unification, and `/nf:model-driven-fix` deprecation.

### Added — Milestone Phases

#### Phase 50: Debug Integration
- `feat(50-01)`: rewrite debug.md Steps A.5-A.8 to absorb model-driven-fix Phases 1-4
- `feat(50-02)`: wire constraint injection into quorum worker prompts and add formal model artifact tracking — constraints from Loop 1 injected as `[FORMAL CONSTRAINTS]` block

#### Phase 51: Task Classification & Debug Routing
- `feat(51-01)`: add task classification subagent to quick.md Step 2.7 — Haiku classifies tasks as bug_fix/feature/refactor with confidence scoring
- `feat(51-02)`: add debug routing (Step 5.8) and debug context to executor prompt — routes bug_fix tasks (confidence >= 0.7) through `/nf:debug` before executor
- **Classification persistence** — scope-contract.json extended with classification object (type, confidence, routed_through_debug)

#### Phase 52: Loop 2 Pre-Commit Simulation Gate
- `feat(phase-52)`: add Loop 2 pre-commit simulation gate to both executor workflows (GATE-01..04) — `simulateSolutionLoop` with `onTweakFix` fires before commit in quick.md and execute-phase.md
- **Fail-open/strict modes** — Loop 2 gate warns by default (fail-open), blocks with `--strict` flag

#### Phase 53: Skill Deprecation
- `feat(phase-53)`: replace model-driven-fix with deprecation shim (DEPR-01) — directs users to `/nf:debug`
- `feat(phase-53)`: rewire solve-remediate b_to_f layer to `/nf:debug` (DEPR-02)

### Added — Quick Tasks

#### Solve Loop Optimization (quick-337 through quick-346)
- `feat(quick-337)`: fast-path initial diagnostic in solve orchestrator — skips redundant re-scan when no residual exists
- `fix(quick-338)`: exit 0 on successful diagnostic, add `has_residual` JSON field
- `feat(quick-339)`: create `solve-inline-dispatch.cjs` for pre-running trivial layers without full Agent spawn + wire into solve orchestrator and remediation
- `feat(quick-340)`: conditional Haiku classification with 4 skip conditions — avoids redundant classify calls in solve-classify
- `feat(quick-341)`: cascade budget for R→F remediation dispatch — prevents unbounded cascades
- `feat(quick-341)`: add anti-self-answer guard + question-file + nonce to quorum dispatch
- `feat(quick-342)`: N-layer cycle detection with state hashing and bounce counting — detects remediation oscillation across layers
- `feat(quick-343)`: parallelize F→C sweep via background pre-spawn for faster diagnostics
- `feat(quick-344)`: incremental diagnostics by file delta — only re-scans files changed since last diagnostic run
- `feat(quick-345)`: two-phase solve with `--plan-only` and `--execute` flags
- `feat(quick-346)`: persistent solve state with `--resume` and iteration logging across context resets

#### Formal Model Enhancements (quick-347 through quick-353)
- `feat(quick-347)`: add `formal-coverage-intersect.cjs` with tests + `--sync` mode and executor auto-detection wiring
- `feat(quick-348)`: add `autoresearch-refine.cjs` with tests + wire into model-driven-fix and solve-remediate
- `feat(quick-350)`: add `onTweakFix`, rollback, TSV trace, when-stuck behaviors to solution-simulation-loop + update model-driven-fix Phase 4.5 from CLI to require()
- `fix(351)`: enforce FALLBACK-01 in all workflow fail-open rules and add preflight slot/fallback preview display
- `feat(quick-352)`: add TLC process timeout and model size guards to formal verification spawning
- `feat(quick-353)`: add state-space preflight guard to `run-tlc.cjs`

### Added — New Requirements
- `req(quick-337)`: add **PERF-03** — fast-path initial diagnostic performance target
- `req(quick-348)`: add **SOLVE-22** — autoresearch-style iteration for formal model refinement
- `req(quick-350)`: add **SOLVE-23** — autoresearch-style iteration for solution-simulation-loop

### Changed
- `feat(phase-53)`: solve-remediate b_to_f rewired from `/nf:model-driven-fix` to `/nf:debug` dispatch

### Deprecated
- **`/nf:model-driven-fix`** — replaced with deprecation shim directing to `/nf:debug`

### Removed
- **debug-formal-context.cjs single-shot call** — replaced by 4-step formal pipeline in debug skill

### Fixed
- `fix(formal)`: reduce NFHazardModelMerge state space from ~8T to 29K states
- `fix(quorum)`: sync FALLBACK-01 checkpoint to reference doc — prevent 1/1 consensus short-circuit

### Tested
- UAT: Phase 50 (10 passed), Phase 51 (10 passed), Phase 52 (8 passed), Phase 53 (4 passed)
- `test(50-02)`: validate end-to-end variable flow consistency
- `test(quick-341)`: add nonce tests + orchestrator/reference doc updates
- `test(quick-350)`: add 9 tests for onTweakFix, rollback, TSV, when-stuck behaviors

## [0.40.2] - 2026-03-20 — Prerelease (next channel)

See [0.40.1] for full changelog. This prerelease packages the same changes for testing via `@next`.

## [0.40.1] - 2026-03-20 — Structural Enforcement & TLC Failure Classification

Version bump within the 0.40 milestone. Never independently tagged — rolled into [0.40.2] prerelease and then [0.41.0].

### Added — v0.40 Milestone (tagged v0.40)
- `feat(v0.40-03-01)`: wire nf-scope-guard hook and register in installer — PreToolUse hook warns on out-of-scope file edits during phase execution
- `feat(v0.40-01-01)`: add three context injection blocks to `nf-prompt.js` for richer session intelligence
- `feat(v0.40-02-02)`: add Step 0f root cause quorum vote to `solve-diagnose.md`
- `feat(resolve)`: create 21 requirements from D→R/T→R triage + link `quorum.pm`
- `req(quick-334)`: add **QUORUM-04**
- `req(quick-335)`: add **AGENT-04**

### Added — Post-v0.40 (quick-336, shipped in 0.40.2-rc.1)
- `feat(quick-336)`: add TLC failure classifier with 6-class pattern matching engine for TLA+ model checker output (`bin/classify-tlc-failure.cjs`)
- `feat(quick-336)`: wire classifier into solve-remediate F→C dispatch + extend schema
- `req(quick-336)`: add **CLASS-03** — formal requirement for TLC failure classification coverage

### Fixed
- `fix(ci)`: skip prerelease tags in release workflow instead of erroring
- `fix(formal)`: resolve `tla:mcconvergencetest` inconclusive check
- `fix(ci)`: skip version stamp when package.json already matches tag
- `fix(lint)`: use portable require path for `classify-tlc-failure`
- `fix(test)`: allow prerelease suffixes in CLI version output test

## [0.39.0] - 2026-03-19 — Dual-Cycle Formal Reasoning & CI/CD Formalization

### Added
- **Dual-cycle formal reasoning** — Cycle 1 (diagnosis) + Cycle 2 (solution simulation) both iterate in model space before touching code
- **Prerelease pipeline** (`prerelease.yml`) — `v*-rc*` and `v*-next*` tags publish to npm `@next` dist-tag with provenance
- **CHANGELOG gate** — release and prerelease pipelines block if no CHANGELOG entry exists for the version being released
- **Layer 3 semantic + Layer 4 agentic scope scan** — sentence-transformer fallback and agentic scope scan for solve coverage
- **Implicit FSM detection** — state machine detection integrated into solve-diagnose and close-formal-gaps

### Changed
- **CI workflow** — scoped to `main` only (removed `staging` branch triggers)
- **`@next` replaces `@staging`** — prerelease channel is now `npx @nforma.ai/nforma@next`

### Fixed
- **`release.yml` git tag creation** — added `git config user.email/name` before annotated tag step (fixes "Committer identity unknown" error)
- **QGSD → nForma rename** — replaced remaining `qgsd` references in active code/core with `nf`

### Removed
- **`staging-publish.yml`** — dead workflow retired (staging branch was 21 commits behind main)
- **`@staging` npm dist-tag** — removed in favour of `@next`

## [0.37.2] - 2026-03-18 — Rebrand Polish & Changelog Backfill

### Fixed
- **GSD → nForma rename** in 8 workflow files — `/nf:update`, `/nf:help`, `/nf:quick`, `/nf:health`, `/nf:execute-phase`, `/nf:map-codebase`, `/nf:add-todo`, `/nf:set-profile` no longer reference "GSD" in user-facing text

### Added
- **Changelog backfill** — entries for v0.34.0 through v0.37.1 reconstructed from git history and release notes

## [0.37.1] - 2026-03-17 — Triage Fixes & Auto-Commit Formal Artifacts

### Fixed
- **#21**: `derived_from` array normalization in gate computation (fixes TypeError crash)
- **#24**: Formal spec path resolution — no more manual symlink needed
- **#25**: `code-trace-index.json` preserves user-added entries across regeneration
- **#28**: `hazard-model.json` preserves user detection overrides across regeneration

### Added
- **#30**: Stop hook auto-commits dirty `.planning/formal/` files at session end (fail-open, skips protected branches, `[auto]` tag in commit message)
- **#22**: D→C scanner supports Python, Go, and Rust dependency manifests + configurable `ignore_patterns`
- **#23**: T→C runner supports `exclude_paths` / `include_paths` in `config.solve.t_to_c`
- **#26**: Haiku classification retries failed batches with backoff; reports `error_types` and `failed_items`
- **#27**: R→F residual excludes `Pending` / `Future` requirements; reports `pending_excluded` count
- 8 new requirements: `GATE-05`, `RSN-06`, `TRACE-06`, `VERF-04`, `DIAG-04`, `DIAG-05`, `DIAG-06`, `CLASS-02` (371 → 379)

## [0.37.0] - 2026-03-17 — Close the Loop: Cross-Layer Feedback Integration

### Added
- **Embedding-amplified proximity scoring** via sentence-transformers with auto-detect cache
- **Hypothesis-layer targeting** — `hypothesis-layer-map.cjs` wired into solve remediation wave ordering
- **Wave-ordered autoClose dispatch** — LAYER_HANDLERS dispatch map with waveOrder parameter
- **Quorum precedent extraction** — `extract-precedents.cjs` for cross-session learning
- **D→R scanner tuning** — exclusion list and claim-type filter to reduce false positives
- **Annotation back-linking** — 19 reverse-discovery gaps resolved (C→R, T→R, D→R)

### Fixed
- **ALLDOWN-PROMOTE bug** — use pre-filter slot names for promotion exclusion
- **Quorum failure TTL** — reduced from 30min to 5min for faster self-healing
- **IVL-02 rebrand gap** — renamed `QGSDMCPEnv.tla` → `NFMCPEnv.tla`
- 23 pre-existing test failures resolved, 3 hanging test files fixed

### Removed
- UPPAAL formalism + solve convergence (89.7% reduction in formal spec size)

## [0.36.0] - 2026-03-15 — Solve Loop Convergence & Correctness

### Added
- **L2 layer collapse** — simplified 3-layer to 2-layer architecture (L1→L3 direct), all consumers updated
- **Wave-parallel remediation** — `solve-wave-dag.cjs` dependency DAG replaces sequential dispatch with wave-parallel execution, includes speedup ratio reporting
- **Gate B redesign** — changed from structural check to purpose check (requirement backing)
- **Gate cap reporting** — capped layers surfaced in solve remediation output (CONV-03)
- **Baseline drift detection** — drift module integrated into solve report (CONV-04)
- **Convergence E2E tests** — integration tests for convergence pipeline + cascade effect unit tests
- **Classification golden set** — test runner with golden set data files for focus filter completeness

### Changed
- `sweepL1toL2` renamed to `sweepL1toL3`, `sweepL2toL3` removed
- LAYER_KEYS count reduced from 19 to 18

## [0.35.0] - 2026-03-13 — Install & Setup Hardening

### Added
- **Auto-rebuild hooks/dist** — `buildHooksIfMissing()` in installer ensures fresh clones work without manual rebuild
- **MCP setup slot classification** — `auth_type` field in `providers.json` wired into mcp-setup workflow
- **Cross-platform provider paths** — `resolveCli` wired into `call-quorum-slot.cjs` and `unified-mcp-server.mjs`
- **TUI CLI Agent MCP entry** — `resolveCli` integrated into TUI CLI Agent form handler with executable validation

### Fixed
- Fresh-clone install no longer fails when `hooks/dist/` is missing

## [0.34.0] - 2026-03-11 — Semantic Gate Validation & Auto-Promotion

### Added
- **Semantic scoring pipeline** — wired into promotion gate with schema v3 fields preserved
- **Auto-promotion state initialization** — explicit `consecutive_clean_sessions` init and `semantic_score` diagnostic logging
- **E2E integration test** — full semantic scoring + auto-promotion pipeline test
- **PROMO-04 verification** — session_id tracking for promotion audit trail

### Fixed
- Quorum consensus enforcement (Quick-269)

## [0.33.1] - 2026-03-10 — Solve/Resolve Data Disconnect Fix

### Fixed
- **Solve/resolve data disconnect** (Quick-257) — `/nf:resolve` now reads from the same solve-state and trend data that `/nf:solve` writes, eliminating stale or missing item references during guided triage

### Added
- **SOLVE-07 requirement** — Formal requirement for solve-to-resolve data consistency

## [0.33.0] - 2026-03-10 — Outer-Loop Convergence Guarantees

### Added
- **Gate stability module** — Flip-flop detection and cooldown enforcement prevent gate oscillation during promotion pipeline
- **Oscillation detector** — Mann-Kendall trend detector with credit enforcement, integrated into autoClose and solve reports
- **JSONL trend tracking** — Append-only solve trend log with scope-growth detection
- **Promotion changelog dedup guard** — Prevents duplicate entries in promotion changelog
- **Predictive power module** — Bug-to-property linking and recall scoring for formal model coverage
- **Convergence velocity estimation** — Predictive power wired into nf-solve pipeline after updateVerdicts
- **Solve focus/topic filter** — `--focus` flag for nf:solve with 23 unit tests and Alloy spec
- **TLA+ meta-verification** — NFSolveConvergence TLA+ spec with Option C blocking and convergence; TLC verifies safety + liveness with zero counterexamples
- **Escalation classifier** — Haiku-based classification logic wired into nf-solve pipeline
- **Convergence report** — Sparkline rendering and action items integrated into solve-report.md
- **Observe pipeline** — Extracted observe pipeline as standalone `bin/observe-pipeline.cjs`
- **Per-model gate integration** — `--write-per-model` default added to sweepPerModelGates (INTG-01)
- **SAFE-03 and DIAG-04 requirements** — New formal requirements added

### Fixed
- **Solve subagent cwd/path bugs** — Project root validation prevents junk files in project root
- **Model-registry traversal** — Corrected close-formal-gaps workflow traversal
- **Cross-repo contamination guard** — Static steps in run-formal-verify.cjs guarded for safety
- **Per-model gate enrichment** — Gate evaluation enriched with per-model detail and reasons
- **XState machine bundle** — Install now copies machine bundle to nf-bin for gate scripts

## [0.32.1] - 2026-03-09 — nForma Branding & README Polish

### Changed
- **Terminal SVG rebrand** — Replaced QGSD ASCII art with nF pixel logo (salmon n + cyan F), updated tagline and help command
- **README improvements** — Quorum-reviewed (4/4 APPROVE): fixed milestone count (31→32), command count (30+→56), formal spec count (15+→18), git branch templates (gsd/→nf/), broadened audience framing, added prerequisites, removed redundant sections, added WSL2 note, linked formal CI workflow

### Fixed
- **Duplicate screenshot** — Removed duplicate `tui-solve.png` reference in Commands section
- **Stale color comments** — Fixed "Q in the nForma logo" → "n in the nForma logo" in SVG generator

## [0.32.0] - 2026-03-09 — Documentation & README Overhaul

### Added
- **TUI hierarchical requirements view** — Browse Reqs page now shows two-level hierarchy (principles → specifications) with principle-mapping module and groupByPrinciple
- **TUI configurable target path** — Target path selector with 53 unit tests
- **TUI Gate Scoring page** — Visualize per-model gate pass/fail in the Reqs module
- **Asset pipeline CI check** — `check-assets-stale.cjs` catches stale SVG assets in CI; integrated into both CI and release workflows
- **Solve sweep functions** — Export all 19 sweep functions from `nf-solve.cjs`
- **NAV-05 requirement** — New navigation requirement added

### Changed
- **README above-the-fold restructure** — TUI hero image, value props, comparison table, and metrics
- **README deep sections** — Expanded documentation for architecture, commands, and configuration
- **User Guide overhaul** — Getting Started walkthrough with embedded TUI screenshots
- **Asset output paths** — SVG generators now write to `docs/assets/` (was `assets/`); logo names rebranded from `gsd-` to `nf-`
- **Node engine floor** — Bumped to `>=18` with Node support table in README
- **VHS tape hardening** — Regenerated all 11 TUI screenshots with deterministic paths

### Fixed
- **TUI header gap calculation** — Target path line was hidden by line1 overflow
- **TUI auto-unfreeze** — Envelope unfreezes on Aggregate; Gate Scoring cwd fixed
- **TUI startup** — Removed OSC 11 probe leak; fixed startup via `nforma-cli`
- **CLI smart routing** — Installer on first run, TUI if already installed; `npx` routes to installer, global install routes to TUI
- **Gate A/B/C repairs** — Improved spec-module matching, fixed orphaned models, expanded failure mode catalog
- **Discord invite links** — Corrected to proper server URL
- **npm package** — Include `core/` in package (fixes ENOENT crash on install)

## [0.31.2] - 2026-03-09

### Fixed
- **Orphan PostToolUse hook from rebrand** — The rebrand (quick-186) renamed `qgsd-spec-regen.js` → `nf-spec-regen.js` but `OLD_HOOK_MAP` in the installer only covered 4 hook events (UserPromptSubmit, Stop, PreToolUse, SessionStart). The PostToolUse event was missed, so the orphan `qgsd-spec-regen.js` entry persisted in `~/.claude/settings.json` — pointing to a file that no longer exists. Added `PostToolUse: ['qgsd-spec-regen', 'qgsd-context-monitor']` to `OLD_HOOK_MAP` so future installs automatically clean up any remaining pre-rebrand PostToolUse hooks.

## [0.31.1] - 2026-03-09

### Changed
- **BREAKING: checkpoint:human-verify quorum gate** — Auto-mode no longer auto-approves `checkpoint:human-verify` tasks. Instead, a quorum consensus gate requires 100% APPROVE from all available workers before proceeding. Falls back to user escalation on any BLOCK vote or quorum unavailability. Affects `core/workflows/execute-phase.md`, `agents/nf-executor.md`, `core/references/checkpoints.md`.
- **TLA+ state space reduced ~65,000x** — Converted `QGSDSessionPersistence.tla` from SUBSET-based to counter-based tracking; all 4 safety invariants and liveness property preserved (quick-235)
- **TLC metadir pinned** — Uses fixed `/tmp/tlc-metadir` to prevent 1.1TB state accumulation from per-run temp directories

### Added
- **Safety hooks hardening** — `nf-destructive-git-guard.js` emits `additionalContext` warnings; new `nf-mcp-dispatch-guard.js` warns on direct MCP calls violating R3.2 dispatch rules; `nf-executor.md` pre-flight checks PLAN.md existence (quick-233)
- **Per-model gate maturity scoring** — `bin/compute-per-model-gates.cjs` evaluates which gates (A/B/C) each formal model passes with auto-promotion from ADVISORY to SOFT_GATE; wired into `nf-solve.cjs` as informational sweep layer (quick-234)
- **Evidence-aware gate promotion** — Gate promotion considers evidence readiness scores (SOFT_GATE ≥1/5, HARD_GATE ≥3/5 evidence files); per-model gates runs as nonCritical step in `run-formal-verify` pipeline; `bin/refresh-evidence.cjs` runs 4 evidence generators before solve convergence (quick-236)
- **Quorum debate trace persistence** — `emitResultBlock` enriched with `matched_requirement_ids`; per-slot debate traces auto-persisted to `.planning/quorum/debates/` with full frontmatter; fail-open on write failures (quick-237)
- **Gate promotion feedback loops** — Always-on evidence refresh at session end via `nf-stop.js`; promotion/demotion changelog (`promotion-changelog.json`, 200-entry cap); automatic gate demotion with hysteresis (SOFT_GATE demotes at <0.8, HARD_GATE at <2.5); `bin/formalization-candidates.cjs` ranks uncovered files by churn × trace density; TUI shows recent gate changes color-coded (quick-238)
- **Install-time path validation** — `validateHookPaths()` scans installed hooks for broken `path.join(__dirname, ...)` references; prints WARNINGs with "did you mean 'nf-bin'?" hints; fail-open (quick-239)

### Fixed
- **31 broken hook path references** — All `bin/` → `nf-bin/` path mismatches in installed hooks resolved
- **Stop hook evidence refresh path** — Corrected `nf-bin` path (was `bin`) for `refresh-evidence.cjs` in `nf-stop.js` (quick-238)
- **TLC metadir wired into all invokers** — Remaining TLC runners now use fixed metadir consistently

## [0.2.1] - 2026-03-03

### Fixed
- **Update checker scope** — `nf-check-update` hook was still querying `@nforma.ai/nforma`; now correctly queries `@nforma.ai/nforma`

### Added
- **Memory staleness check** — Session-start hook warns about outdated MEMORY.md entries via `bin/validate-memory.cjs`
- **Invariant validator** — `bin/validate-invariant.cjs` classifies requirements as invariant/non-invariant
- **Close formal gaps command** — `/nf:close-formal-gaps` analyzes and closes formal model coverage gaps
- **Workflow improvements** — Invariant gate in `add-requirement`, `--strict` flag for `map-requirements`
- **20 new formal verification models** — 8 Alloy (architecture-registry, config-two-layer, mcp-detection, multi-slot, quorum-policy, schema-extensions, traceability-annotations, unified-check), 2 PRISM (deliberation-healing, observability-delivery), 10 TLA+ (activity tracking, agent provisioning, breaker state, config portability, dispatch pipeline, enforcement, installer idempotency, key management, prompt hook, setup wizard)
- **Publish script** — `scripts/publish.sh` reads NPM_TOKEN from `.env` for local publishing
- **CI/CD publishing** — GitHub Actions `publish.yml` triggers on release with OIDC provenance support

### Changed
- **Package size reduced 25%** — 606.7 kB → 453.0 kB via expanded `.npmignore` and `files` negation patterns
- **Package files reduced 35%** — 258 → 169 files; all 87 test files and 4 dev-only scripts excluded from tarball
- **Author updated** — `TÂCHES` → `nForma AI`
- **Stale peerDependency removed** — `get-shit-done-cc` no longer required (bundled in `core/`)
- **package-lock.json scope** — Cleared all `@langblaze.ai` references to `@nforma.ai`
- **Git remote** — Updated from `LangBlaze-AI/QGSD` to `nForma-AI/QGSD`

## [0.2.0] - 2026-02-21

### Added
- **Circuit breaker hook** (`hooks/nf-circuit-breaker.js`) — PreToolUse hook that detects
  oscillation in git history (strict set equality across the last N commits) and persists
  breaker state to `.claude/circuit-breaker-state.json`; survives across tool calls
- **Enforcement blocking** — When the circuit breaker is active, any non-read-only Bash
  command is denied via `hookSpecificOutput.permissionDecision='deny'`; read-only commands
  (git log, git diff, grep, cat, ls, head, tail, find) always pass
- **Oscillation Resolution Mode** — Deny message renders the commit graph as a markdown table
  and explicitly invokes Oscillation Resolution Mode per R5 (CLAUDE.md); procedure detailed
  in `get-shit-done/workflows/oscillation-resolution-mode.md`
- **`circuit_breaker` config block** — `nf.json` extended with `circuit_breaker.oscillation_depth`
  (default: 3) and `circuit_breaker.commit_window` (default: 6); validated on load with
  stderr warnings for invalid values; two-layer merge (global + per-project) applies
- **`npx nforma --reset-breaker`** — CLI flag clears `.claude/circuit-breaker-state.json`
  (project-relative, resolved via git rev-parse) enabling manual recovery from deadlock
- **Installer auto-registers circuit breaker hook** — `npx nforma@latest` now writes a
  PreToolUse entry for `nf-circuit-breaker.js` in `~/.claude/settings.json` and writes
  the default `circuit_breaker` config block to `~/.claude/nf.json`; reinstall is
  idempotent (existing user values are never overwritten)
- **QGSD rebranding** — Package renamed to `qgsd`; banner updated to "QGSD: Quorum Gets Shit
  Done" with salmon Q; all commands use `/nf:` prefix; hooks updated to match both
  `/gsd:` and `/nf:` prefixes for backward compatibility (quick tasks 1, 8, 9, 10, 11)
- **Quorum agent scoring** (`R8`) — TP/TN/FP/FN weighted schema tracks each model's initial
  vote vs final consensus; scoreboard at `.planning/quorum-scoreboard.md`; Improvement
  Accepted/Rejected classifications track proposal quality (quick task 4)
- **`/nf:quorum-test` command** — Pre-flight validation collects artifacts before running
  quorum models; replaces human checkpoint:human-verify gates in plan templates (quick task 3, 5)
- **`/nf:debug` command** — Auto-proceeds when quorum reaches consensus; Step 7 executes
  consensus next step without user-permission gate (quick task 12)
- **`checkpoint:verify` flow in `/nf:execute-phase`** — Executor calls `/nf:quorum-test`
  at checkpoint:verify gates; enters 3-round debug loop on BLOCK/REVIEW-NEEDED; escalates
  to checkpoint:human-verify only after loop exhausts (quick task 6)
- **R3.6 Iterative Improvement Protocol** — When quorum approves but proposes improvements,
  Claude incorporates them and re-runs quorum; up to 10 iterations until no further
  improvements proposed (quick task 2)
- **User Guide updated** — Execution Wave Coordination diagram includes checkpoint:verify
  pipeline (quick task 7)
- **`--redetect-mcps` flag** — Re-runs MCP prefix detection and overwrites
  `~/.claude/nf.json` without a full reinstall

### Fixed
- **GUARD 5 delivery gaps** — `hooks/dist/` rebuilt to include Phase 4 GUARD 5 code
  (`hasArtifactCommit` + `hasDecisionMarker`); `buildQuorumInstructions()` in `bin/install.js`
  now appends the `<!-- GSD_DECISION -->` marker step so installer-written configs trigger
  `hasDecisionMarker()` correctly; `templates/nf.json` updated to match
- **Installer uninstall dead hook** (INST-08) — `uninstall()` now removes the PreToolUse
  circuit breaker hook entry from `~/.claude/settings.json`, mirroring the existing Stop
  and UserPromptSubmit removal pattern
- **`--reset-breaker` path resolution** (RECV-01) — Uses `git rev-parse --show-toplevel`
  with `process.cwd()` fallback, consistent with how `nf-circuit-breaker.js` resolves
  the git root
- **Installer sub-key backfill** (INST-10) — Uses `=== undefined` check (not falsy) to
  preserve user-set values including `0`; `validateConfig()` handles runtime validation

## [0.1.0] - 2026-02-20

### nForma — Initial Release

QGSD adds multi-model quorum enforcement to GSD via Claude Code hooks. It installs
alongside GSD without modifying any GSD source files.

**GSD compatibility:** `get-shit-done-cc >= 1.20.0`

**Files installed into `~/.claude/` by nForma:**
- `hooks/nf-stop.js` — Stop hook: reads transcript JSONL, blocks if quorum evidence missing
- `hooks/nf-prompt.js` — UserPromptSubmit hook: injects quorum instructions before planning commands
- `hooks/config-loader.js` — Shared config loader: two-layer merge (global + per-project nf.json)
- `nf.json` — Quorum config with MCP-auto-detected tool prefixes

**SYNC-04 audit (no GSD source modifications):**
QGSD adds only the files listed above. Zero imports from GSD internals
(`get-shit-done/`, `commands/`, `agents/`, `bin/`). GSD source is unmodified.

**SYNC-02 maintenance note:**
When GSD adds a new planning command, update `quorum_commands` in three places:
`hooks/config-loader.js` (DEFAULT_CONFIG), `bin/install.js` (qgsd config write block),
and `templates/nf.json`. Then cut a nForma patch release.

## [1.20.5] - 2026-02-19

### Fixed
- `/gsd:health --repair` now creates timestamped backup before regenerating STATE.md (#657)

### Changed
- Subagents now discover and load project CLAUDE.md and skills at spawn time for better project context (#671, #672)
- Improved context loading reliability in spawned agents

## [1.20.4] - 2026-02-17

### Fixed
- Executor agents now update ROADMAP.md and REQUIREMENTS.md after each plan completes — previously both documents stayed unchecked throughout milestone execution
- New `requirements mark-complete` CLI command enables per-plan requirement tracking instead of waiting for phase completion
- Executor final commit includes ROADMAP.md and REQUIREMENTS.md

## [1.20.3] - 2026-02-16

### Fixed
- Milestone audit now cross-references three independent sources (VERIFICATION.md + SUMMARY frontmatter + REQUIREMENTS.md traceability) instead of single-source phase status checks
- Orphaned requirements (in traceability table but absent from all phase VERIFICATIONs) detected and forced to `unsatisfied`
- Integration checker receives milestone requirement IDs and maps findings to affected requirements
- `complete-milestone` gates on requirements completion before archival — surfaces unchecked requirements with proceed/audit/abort options
- `plan-milestone-gaps` updates REQUIREMENTS.md traceability table (phase assignments, checkbox resets, coverage count) and includes it in commit
- Gemini CLI: escape `${VAR}` shell variables in agent bodies to prevent template validation failures

## [1.20.2] - 2026-02-16

### Fixed
- Requirements tracking chain now strips bracket syntax (`[REQ-01, REQ-02]` → `REQ-01, REQ-02`) across all agents
- Verifier cross-references requirement IDs from PLAN frontmatter instead of only grepping REQUIREMENTS.md by phase number
- Orphaned requirements (mapped to phase in REQUIREMENTS.md but unclaimed by any plan) are detected and flagged

### Changed
- All `requirements` references across planner, templates, and workflows enforce MUST/REQUIRED/CRITICAL language — no more passive suggestions
- Plan checker now **fails** (blocking, not warning) when any roadmap requirement is absent from all plans
- Researcher receives phase-specific requirement IDs and must output a `<phase_requirements>` mapping table
- Phase requirement IDs extracted from ROADMAP and passed through full chain: researcher → planner → checker → executor → verifier
- Verification report requirements table expanded with Source Plan, Description, and Evidence columns

## [1.20.1] - 2026-02-16

### Fixed
- Auto-mode (`--auto`) now survives context compaction by persisting `workflow.auto_advance` to config.json on disk
- Checkpoints no longer block auto-mode: human-verify auto-approves, decision auto-selects first option (human-action still stops for auth gates)
- Plan-phase now passes `--auto` flag when spawning execute-phase
- Auto-advance clears on milestone complete to prevent runaway chains

## [1.20.0] - 2026-02-15

### Added
- `/gsd:health` command — validates `.planning/` directory integrity with `--repair` flag for auto-fixing config.json and STATE.md
- `--full` flag for `/gsd:quick` — enables plan-checking (max 2 iterations) and post-execution verification on quick tasks
- `--auto` flag wired from `/gsd:new-project` through the full phase chain (discuss → plan → execute)
- Auto-advance chains phase execution across full milestones when `workflow.auto_advance` is enabled

### Fixed
- Plans created without user context — `/gsd:plan-phase` warns when no CONTEXT.md exists, `/gsd:discuss-phase` warns when plans already exist (#253)
- OpenCode installer converts `general-purpose` subagent type to OpenCode's `general`
- `/gsd:complete-milestone` respects `commit_docs` setting when merging branches
- Phase directories tracked in git via `.gitkeep` files

## [1.19.2] - 2026-02-15

### Added
- User-level default settings via `~/.gsd/defaults.json` — set GSD defaults across all projects
- Per-agent model overrides — customize which Claude model each agent uses

### Changed
- Completed milestone phase directories are now archived for cleaner project structure
- Wave execution diagram added to README for clearer parallelization visualization

### Fixed
- OpenCode local installs now write config to `./.opencode/` instead of overwriting global `~/.config/opencode/`
- Large JSON payloads write to temp files to prevent truncation in tool calls
- Phase heading matching now supports `####` depth
- Phase padding normalized in insert command
- ESM conflicts prevented by renaming gsd-tools.js to .cjs
- Config directory paths quoted in hook templates for local installs
- Settings file corruption prevented by using Write tool for file creation
- Plan-phase autocomplete fixed by removing "execution" from description
- Executor now has scope boundary and attempt limit to prevent runaway loops

## [1.19.1] - 2026-02-15

### Added
- Auto-advance pipeline: `--auto` flag on `discuss-phase` and `plan-phase` chains discuss → plan → execute without stopping. Also available as `workflow.auto_advance` config setting

### Fixed
- Phase transition routing now routes to `discuss-phase` (not `plan-phase`) when no CONTEXT.md exists — consistent across all workflows (#530)
- ROADMAP progress table plan counts are now computed from disk instead of LLM-edited — deterministic "X/Y Complete" values (#537)
- Verifier uses ROADMAP Success Criteria directly instead of deriving verification truths from the Goal field (#538)
- REQUIREMENTS.md traceability updates when a phase completes
- STATE.md updates after discuss-phase completes (#556)
- AskUserQuestion headers enforced to 12-char max to prevent UI truncation (#559)
- Agent model resolution returns `inherit` instead of hardcoded `opus` (#558)

## [1.19.0] - 2026-02-15

### Added
- Brave Search integration for researchers (requires BRAVE_API_KEY environment variable)
- GitHub issue templates for bug reports and feature requests
- Security policy for responsible disclosure
- Auto-labeling workflow for new issues

### Fixed
- UAT gaps and debug sessions now auto-resolve after gap-closure phase execution (#580)
- Fall back to ROADMAP.md when phase directory missing (#521)
- Template hook paths for OpenCode/Gemini runtimes (#585)
- Accept both `##` and `###` phase headers, detect malformed ROADMAPs (#598, #599)
- Use `{phase_num}` instead of ambiguous `{phase}` for filenames (#601)
- Add package.json to prevent ESM inheritance issues (#602)

## [1.18.0] - 2026-02-08

### Added
- `--auto` flag for `/gsd:new-project` — runs research → requirements → roadmap automatically after config questions. Expects idea document via @ reference (e.g., `/gsd:new-project --auto @prd.md`)

### Fixed
- Windows: SessionStart hook now spawns detached process correctly
- Windows: Replaced HEREDOC with literal newlines for git commit compatibility
- Research decision from `/gsd:new-milestone` now persists to config.json

## [1.17.0] - 2026-02-08

### Added
- **gsd-tools verification suite**: `verify plan-structure`, `verify phase-completeness`, `verify references`, `verify commits`, `verify artifacts`, `verify key-links` — deterministic structural checks
- **gsd-tools frontmatter CRUD**: `frontmatter get/set/merge/validate` — safe YAML frontmatter operations with schema validation
- **gsd-tools template fill**: `template fill summary/plan/verification` — pre-filled document skeletons
- **gsd-tools state progression**: `state advance-plan`, `state update-progress`, `state record-metric`, `state add-decision`, `state add-blocker`, `state resolve-blocker`, `state record-session` — automates STATE.md updates
- **Local patch preservation**: Installer now detects locally modified GSD files, backs them up to `gsd-local-patches/`, and creates a manifest for restoration
- `/gsd:reapply-patches` command to merge local modifications back after GSD updates

### Changed
- Agents (executor, planner, plan-checker, verifier) now use gsd-tools for state updates and verification instead of manual markdown parsing
- `/gsd:update` workflow now notifies about backed-up local patches and suggests `/gsd:reapply-patches`

### Fixed
- Added workaround for Claude Code `classifyHandoffIfNeeded` bug that causes false agent failures — execute-phase and quick workflows now spot-check actual output before reporting failure

## [1.16.0] - 2026-02-08

### Added
- 10 new gsd-tools CLI commands that replace manual AI orchestration of mechanical operations:
  - `phase add <desc>` — append phase to roadmap + create directory
  - `phase insert <after> <desc>` — insert decimal phase
  - `phase remove <N> [--force]` — remove phase with full renumbering
  - `phase complete <N>` — mark done, update state + roadmap, detect milestone end
  - `roadmap analyze` — unified roadmap parser with disk status
  - `milestone complete <ver> [--name]` — archive roadmap/requirements/audit
  - `validate consistency` — check phase numbering and disk/roadmap sync
  - `progress [json|table|bar]` — render progress in various formats
  - `todo complete <file>` — move todo from pending to completed
  - `scaffold [context|uat|verification|phase-dir]` — template generation

### Changed
- Workflows now delegate deterministic operations to gsd-tools CLI, reducing token usage and errors:
  - `remove-phase.md`: 13 manual steps → 1 CLI call + confirm + commit
  - `add-phase.md`: 6 manual steps → 1 CLI call + state update
  - `insert-phase.md`: 7 manual steps → 1 CLI call + state update
  - `complete-milestone.md`: archival delegated to `milestone complete`
  - `progress.md`: roadmap parsing delegated to `roadmap analyze`

### Fixed
- Execute-phase now correctly spawns `gsd-executor` subagents instead of generic task agents
- `commit_docs=false` setting now respected in all `.planning/` commit paths (execute-plan, debugger, reference docs all route through gsd-tools CLI)
- Execute-phase orchestrator no longer bloats context by embedding file content — passes paths instead, letting subagents read in their fresh context
- Windows: Normalized backslash paths in gsd-tools invocations (contributed by @rmindel)

## [1.15.0] - 2026-02-08

### Changed
- Optimized workflow context loading to eliminate redundant file reads, reducing token usage by ~5,000-10,000 tokens per workflow execution

## [1.14.0] - 2026-02-08

### Added
- Context-optimizing parsing commands in gsd-tools (`phase-plan-index`, `state-snapshot`, `summary-extract`) — reduces agent context usage by returning structured JSON instead of raw file content

### Fixed
- Installer no longer deletes opencode.json on JSONC parse errors — now handles comments, trailing commas, and BOM correctly (#474)

## [1.13.0] - 2026-02-08

### Added
- `gsd-tools history-digest` — Compiles phase summaries into structured JSON for faster context loading
- `gsd-tools phases list` — Lists phase directories with filtering (replaces fragile `ls | sort -V` patterns)
- `gsd-tools roadmap get-phase` — Extracts phase sections from ROADMAP.md
- `gsd-tools phase next-decimal` — Calculates next decimal phase number for insert operations
- `gsd-tools state get/patch` — Atomic STATE.md field operations
- `gsd-tools template select` — Chooses summary template based on plan complexity
- Summary template variants: minimal (~30 lines), standard (~60 lines), complex (~100 lines)
- Test infrastructure with 22 tests covering new commands

### Changed
- Planner uses two-step context assembly: digest for selection, full SUMMARY for understanding
- Agents migrated from bash patterns to structured gsd-tools commands
- Nested YAML frontmatter parsing now handles `dependency-graph.provides`, `tech-stack.added` correctly

## [1.12.1] - 2026-02-08

### Changed
- Consolidated workflow initialization into compound `init` commands, reducing token usage and improving startup performance
- Updated 24 workflow and agent files to use single-call context gathering instead of multiple atomic calls

## [1.12.0] - 2026-02-07

### Changed
- **Architecture: Thin orchestrator pattern** — Commands now delegate to workflows, reducing command file size by ~75% and improving maintainability
- **Centralized utilities** — New `gsd-tools.cjs` (11 functions) replaces repetitive bash patterns across 50+ files
- **Token reduction** — ~22k characters removed from affected command/workflow/agent files
- **Condensed agent prompts** — Same behavior with fewer words (executor, planner, verifier, researcher agents)

### Added
- `gsd-tools.cjs` CLI utility with functions: state load/update, resolve-model, find-phase, commit, verify-summary, generate-slug, current-timestamp, list-todos, verify-path-exists, config-ensure-section

## [1.11.2] - 2026-02-05

### Added
- Security section in README with Claude Code deny rules for sensitive files

### Changed
- Install respects `attribution.commit` setting for OpenCode compatibility (#286)

### Fixed
- **CRITICAL:** Prevent API keys from being committed via `/gsd:map-codebase` (#429)
- Enforce context fidelity in planning pipeline - agents now honor CONTEXT.md decisions (#326, #216, #206)
- Executor verifies task completion to prevent hallucinated success (#315)
- Auto-create `config.json` when missing during `/gsd:settings` (#264)
- `/gsd:update` respects local vs global install location
- Researcher writes RESEARCH.md regardless of `commit_docs` setting
- Statusline crash handling, color validation, git staging rules
- Statusline.js reference updated during install (#330)
- Parallelization config setting now respected (#379)
- ASCII box-drawing vs text content with diacritics (#289)
- Removed broken gsd-gemini link (404)

## [1.11.1] - 2026-01-31

### Added
- Git branching strategy configuration with three options:
  - `none` (default): commit to current branch
  - `phase`: create branch per phase (`gsd/phase-{N}-{slug}`)
  - `milestone`: create branch per milestone (`gsd/{version}-{slug}`)
- Squash merge option at milestone completion (recommended) with merge-with-history alternative
- Context compliance verification dimension in plan checker — flags if plans contradict user decisions

### Fixed
- CONTEXT.md from `/gsd:discuss-phase` now properly flows to all downstream agents (researcher, planner, checker, revision loop)

## [1.10.1] - 2025-01-30

### Fixed
- Gemini CLI agent loading errors that prevented commands from executing

## [1.10.0] - 2026-01-29

### Added
- Native Gemini CLI support — install with `--gemini` flag or select from interactive menu
- New `--all` flag to install for Claude Code, OpenCode, and Gemini simultaneously

### Fixed
- Context bar now shows 100% at actual 80% limit (was scaling incorrectly)

## [1.9.12] - 2025-01-23

### Removed
- `/gsd:whats-new` command — use `/gsd:update` instead (shows changelog with cancel option)

### Fixed
- Restored auto-release GitHub Actions workflow

## [1.9.11] - 2026-01-23

### Changed
- Switched to manual npm publish workflow (removed GitHub Actions CI/CD)

### Fixed
- Discord badge now uses static format for reliable rendering

## [1.9.10] - 2026-01-23

### Added
- Discord community link shown in installer completion message

## [1.9.9] - 2026-01-23

### Added
- `/gsd:join-discord` command to quickly access the GSD Discord community invite link

## [1.9.8] - 2025-01-22

### Added
- Uninstall flag (`--uninstall`) to cleanly remove GSD from global or local installations

### Fixed
- Context file detection now matches filename variants (handles both `CONTEXT.md` and `{phase}-CONTEXT.md` patterns)

## [1.9.7] - 2026-01-22

### Fixed
- OpenCode installer now uses correct XDG-compliant config path (`~/.config/opencode/`) instead of `~/.opencode/`
- OpenCode commands use flat structure (`command/gsd-help.md`) matching OpenCode's expected format
- OpenCode permissions written to `~/.config/opencode/opencode.json`

## [1.9.6] - 2026-01-22

### Added
- Interactive runtime selection: installer now prompts to choose Claude Code, OpenCode, or both
- Native OpenCode support: `--opencode` flag converts GSD to OpenCode format automatically
- `--both` flag to install for both Claude Code and OpenCode in one command
- Auto-configures `~/.opencode.json` permissions for seamless GSD doc access

### Changed
- Installation flow now asks for runtime first, then location
- Updated README with new installation options

## [1.9.5] - 2025-01-22

### Fixed
- Subagents can now access MCP tools (Context7, etc.) - workaround for Claude Code bug #13898
- Installer: Escape/Ctrl+C now cancels instead of installing globally
- Installer: Fixed hook paths on Windows
- Removed stray backticks in `/gsd:new-project` output

### Changed
- Condensed verbose documentation in templates and workflows (-170 lines)
- Added CI/CD automation for releases

## [1.9.4] - 2026-01-21

### Changed
- Checkpoint automation now enforces automation-first principle: Claude starts servers, handles CLI installs, and fixes setup failures before presenting checkpoints to users
- Added server lifecycle protocol (port conflict handling, background process management)
- Added CLI auto-installation handling with safe-to-install matrix
- Added pre-checkpoint failure recovery (fix broken environment before asking user to verify)
- DRY refactor: checkpoints.md is now single source of truth for automation patterns

## [1.9.2] - 2025-01-21

### Removed
- **Codebase Intelligence System** — Removed due to overengineering concerns
  - Deleted `/gsd:analyze-codebase` command
  - Deleted `/gsd:query-intel` command
  - Removed SQLite graph database and sql.js dependency (21MB)
  - Removed intel hooks (gsd-intel-index.js, gsd-intel-session.js, gsd-intel-prune.js)
  - Removed entity file generation and templates

### Fixed
- new-project now properly includes model_profile in config

## [1.9.0] - 2025-01-20

### Added
- **Model Profiles** — `/gsd:set-profile` for quality/balanced/budget agent configurations
- **Workflow Settings** — `/gsd:settings` command for toggling workflow behaviors interactively

### Fixed
- Orchestrators now inline file contents in Task prompts (fixes context issues with @ references)
- Tech debt from milestone audit addressed
- All hooks now use `gsd-` prefix for consistency (statusline.js → gsd-statusline.js)

## [1.8.0] - 2026-01-19

### Added
- Uncommitted planning mode: Keep `.planning/` local-only (not committed to git) via `planning.commit_docs: false` in config.json. Useful for OSS contributions, client work, or privacy preferences.
- `/gsd:new-project` now asks about git tracking during initial setup, letting you opt out of committing planning docs from the start

## [1.7.1] - 2026-01-19

### Fixed
- Quick task PLAN and SUMMARY files now use numbered prefix (`001-PLAN.md`, `001-SUMMARY.md`) matching regular phase naming convention

## [1.7.0] - 2026-01-19

### Added
- **Quick Mode** (`/gsd:quick`) — Execute small, ad-hoc tasks with GSD guarantees but skip optional agents (researcher, checker, verifier). Quick tasks live in `.planning/quick/` with their own tracking in STATE.md.

### Changed
- Improved progress bar calculation to clamp values within 0-100 range
- Updated documentation with comprehensive Quick Mode sections in help.md, README.md, and GSD-STYLE.md

### Fixed
- Console window flash on Windows when running hooks
- Empty `--config-dir` value validation
- Consistent `allowed-tools` YAML format across agents
- Corrected agent name in research-phase heading
- Removed hardcoded 2025 year from search query examples
- Removed dead gsd-researcher agent references
- Integrated unused reference files into documentation

### Housekeeping
- Added homepage and bugs fields to package.json

## [1.6.4] - 2026-01-17

### Fixed
- Installation on WSL2/non-TTY terminals now works correctly - detects non-interactive stdin and falls back to global install automatically
- Installation now verifies files were actually copied before showing success checkmarks
- Orphaned `gsd-notify.sh` hook from previous versions is now automatically removed during install (both file and settings.json registration)

## [1.6.3] - 2025-01-17

### Added
- `--gaps-only` flag for `/gsd:execute-phase` — executes only gap closure plans after verify-work finds issues, eliminating redundant state discovery

## [1.6.2] - 2025-01-17

### Changed
- README restructured with clearer 6-step workflow: init → discuss → plan → execute → verify → complete
- Discuss-phase and verify-work now emphasized as critical steps in core workflow documentation
- "Subagent Execution" section replaced with "Multi-Agent Orchestration" explaining thin orchestrator pattern and 30-40% context efficiency
- Brownfield instructions consolidated into callout at top of "How It Works" instead of separate section
- Phase directories now created at discuss/plan-phase instead of during roadmap creation

## [1.6.1] - 2025-01-17

### Changed
- Installer performs clean install of GSD folders, removing orphaned files from previous versions
- `/gsd:update` shows changelog and asks for confirmation before updating, with clear warning about what gets replaced

## [1.6.0] - 2026-01-17

### Changed
- **BREAKING:** Unified `/gsd:new-milestone` flow — now mirrors `/gsd:new-project` with questioning → research → requirements → roadmap in a single command
- Roadmapper agent now references templates instead of inline structures for easier maintenance

### Removed
- **BREAKING:** `/gsd:discuss-milestone` — consolidated into `/gsd:new-milestone`
- **BREAKING:** `/gsd:create-roadmap` — integrated into project/milestone flows
- **BREAKING:** `/gsd:define-requirements` — integrated into project/milestone flows
- **BREAKING:** `/gsd:research-project` — integrated into project/milestone flows

### Added
- `/gsd:verify-work` now includes next-step routing after verification completes

## [1.5.30] - 2026-01-17

### Fixed
- Output templates in `plan-phase`, `execute-phase`, and `audit-milestone` now render markdown correctly instead of showing literal backticks
- Next-step suggestions now consistently recommend `/gsd:discuss-phase` before `/gsd:plan-phase` across all routing paths

## [1.5.29] - 2025-01-16

### Changed
- Discuss-phase now uses domain-aware questioning with deeper probing for gray areas

### Fixed
- Windows hooks now work via Node.js conversion (statusline, update-check)
- Phase input normalization at command entry points
- Removed blocking notification popups (gsd-notify) on all platforms

## [1.5.28] - 2026-01-16

### Changed
- Consolidated milestone workflow into single command
- Merged domain expertise skills into agent configurations
- **BREAKING:** Removed `/gsd:execute-plan` command (use `/gsd:execute-phase` instead)

### Fixed
- Phase directory matching now handles both zero-padded (05-*) and unpadded (5-*) folder names
- Map-codebase agent output collection

## [1.5.27] - 2026-01-16

### Fixed
- Orchestrator corrections between executor completions are now committed (previously left uncommitted when orchestrator made small fixes between waves)

## [1.5.26] - 2026-01-16

### Fixed
- Revised plans now get committed after checker feedback (previously only initial plans were committed, leaving revisions uncommitted)

## [1.5.25] - 2026-01-16

### Fixed
- Stop notification hook no longer shows stale project state (now uses session-scoped todos only)
- Researcher agent now reliably loads CONTEXT.md from discuss-phase

## [1.5.24] - 2026-01-16

### Fixed
- Stop notification hook now correctly parses STATE.md fields (was always showing "Ready for input")
- Planner agent now reliably loads CONTEXT.md and RESEARCH.md files

## [1.5.23] - 2025-01-16

### Added
- Cross-platform completion notification hook (Mac/Linux/Windows alerts when Claude stops)
- Phase researcher now loads CONTEXT.md from discuss-phase to focus research on user decisions

### Fixed
- Consistent zero-padding for phase directories (01-name, not 1-name)
- Plan file naming: `{phase}-{plan}-PLAN.md` pattern restored across all agents
- Double-path bug in researcher git add command
- Removed `/gsd:research-phase` from next-step suggestions (use `/gsd:plan-phase` instead)

## [1.5.22] - 2025-01-16

### Added
- Statusline update indicator — shows `⬆ /gsd:update` when a new version is available

### Fixed
- Planner now updates ROADMAP.md placeholders after planning completes

## [1.5.21] - 2026-01-16

### Added
- GSD brand system for consistent UI (checkpoint boxes, stage banners, status symbols)
- Research synthesizer agent that consolidates parallel research into SUMMARY.md

### Changed
- **Unified `/gsd:new-project` flow** — Single command now handles questions → research → requirements → roadmap (~10 min)
- Simplified README to reflect streamlined workflow: new-project → plan-phase → execute-phase
- Added optional `/gsd:discuss-phase` documentation for UI/UX/behavior decisions before planning

### Fixed
- verify-work now shows clear checkpoint box with action prompt ("Type 'pass' or describe what's wrong")
- Planner uses correct `{phase}-{plan}-PLAN.md` naming convention
- Planner no longer surfaces internal `user_setup` in output
- Research synthesizer commits all research files together (not individually)
- Project researcher agent can no longer commit (orchestrator handles commits)
- Roadmap requires explicit user approval before committing

## [1.5.20] - 2026-01-16

### Fixed
- Research no longer skipped based on premature "Research: Unlikely" predictions made during roadmap creation. The `--skip-research` flag provides explicit control when needed.

### Removed
- `Research: Likely/Unlikely` fields from roadmap phase template
- `detect_research_needs` step from roadmap creation workflow
- Roadmap-based research skip logic from planner agent

## [1.5.19] - 2026-01-16

### Changed
- `/gsd:discuss-phase` redesigned with intelligent gray area analysis — analyzes phase to identify discussable areas (UI, UX, Behavior, etc.), presents multi-select for user control, deep-dives each area with focused questioning
- Explicit scope guardrail prevents scope creep during discussion — captures deferred ideas without acting on them
- CONTEXT.md template restructured for decisions (domain boundary, decisions by category, Claude's discretion, deferred ideas)
- Downstream awareness: discuss-phase now explicitly documents that CONTEXT.md feeds researcher and planner agents
- `/gsd:plan-phase` now integrates research — spawns `gsd-phase-researcher` before planning unless research exists or `--skip-research` flag used

## [1.5.18] - 2026-01-16

### Added
- **Plan verification loop** — Plans are now verified before execution with a planner → checker → revise cycle
  - New `gsd-plan-checker` agent (744 lines) validates plans will achieve phase goals
  - Six verification dimensions: requirement coverage, task completeness, dependency correctness, key links, scope sanity, must_haves derivation
  - Max 3 revision iterations before user escalation
  - `--skip-verify` flag for experienced users who want to bypass verification
- **Dedicated planner agent** — `gsd-planner` (1,319 lines) consolidates all planning expertise
  - Complete methodology: discovery levels, task breakdown, dependency graphs, scope estimation, goal-backward analysis
  - Revision mode for handling checker feedback
  - TDD integration and checkpoint patterns
- **Statusline integration** — Context usage, model, and current task display

### Changed
- `/gsd:plan-phase` refactored to thin orchestrator pattern (310 lines)
  - Spawns `gsd-planner` for planning, `gsd-plan-checker` for verification
  - User sees status between agent spawns (not a black box)
- Planning references deprecated with redirects to `gsd-planner` agent sections
  - `plan-format.md`, `scope-estimation.md`, `goal-backward.md`, `principles.md`
  - `workflows/plan-phase.md`

### Fixed
- Removed zombie `gsd-milestone-auditor` agent (was accidentally re-added after correct deletion)

### Removed
- Phase 99 throwaway test files

## [1.5.17] - 2026-01-15

### Added
- New `/gsd:update` command — check for updates, install, and display changelog of what changed (better UX than raw `npx get-shit-done-cc`)

## [1.5.16] - 2026-01-15

### Added
- New `gsd-researcher` agent (915 lines) with comprehensive research methodology, 4 research modes (ecosystem, feasibility, implementation, comparison), source hierarchy, and verification protocols
- New `gsd-debugger` agent (990 lines) with scientific debugging methodology, hypothesis testing, and 7+ investigation techniques
- New `gsd-codebase-mapper` agent for brownfield codebase analysis
- Research subagent prompt template for context-only spawning

### Changed
- `/gsd:research-phase` refactored to thin orchestrator — now injects rich context (key insight framing, downstream consumer info, quality gates) to gsd-researcher agent
- `/gsd:research-project` refactored to spawn 4 parallel gsd-researcher agents with milestone-aware context (greenfield vs v1.1+) and roadmap implications guidance
- `/gsd:debug` refactored to thin orchestrator (149 lines) — spawns gsd-debugger agent with full debugging expertise
- `/gsd:new-milestone` now explicitly references MILESTONE-CONTEXT.md

### Deprecated
- `workflows/research-phase.md` — consolidated into gsd-researcher agent
- `workflows/research-project.md` — consolidated into gsd-researcher agent
- `workflows/debug.md` — consolidated into gsd-debugger agent
- `references/research-pitfalls.md` — consolidated into gsd-researcher agent
- `references/debugging.md` — consolidated into gsd-debugger agent
- `references/debug-investigation.md` — consolidated into gsd-debugger agent

## [1.5.15] - 2025-01-15

### Fixed
- **Agents now install correctly** — The `agents/` folder (gsd-executor, gsd-verifier, gsd-integration-checker, gsd-milestone-auditor) was missing from npm package, now included

### Changed
- Consolidated `/gsd:plan-fix` into `/gsd:plan-phase --gaps` for simpler workflow
- UAT file writes now batched instead of per-response for better performance

## [1.5.14] - 2025-01-15

### Fixed
- Plan-phase now always routes to `/gsd:execute-phase` after planning, even for single-plan phases

## [1.5.13] - 2026-01-15

### Fixed
- `/gsd:new-milestone` now presents research and requirements paths as equal options, matching `/gsd:new-project` format

## [1.5.12] - 2025-01-15

### Changed
- **Milestone cycle reworked for proper requirements flow:**
  - `complete-milestone` now archives AND deletes ROADMAP.md and REQUIREMENTS.md (fresh for next milestone)
  - `new-milestone` is now a "brownfield new-project" — updates PROJECT.md with new goals, routes to define-requirements
  - `discuss-milestone` is now required before `new-milestone` (creates context file)
  - `research-project` is milestone-aware — focuses on new features, ignores already-validated requirements
  - `create-roadmap` continues phase numbering from previous milestone
  - Flow: complete → discuss → new-milestone → research → requirements → roadmap

### Fixed
- `MILESTONE-AUDIT.md` now versioned as `v{version}-MILESTONE-AUDIT.md` and archived on completion
- `progress` now correctly routes to `/gsd:discuss-milestone` when between milestones (Route F)

## [1.5.11] - 2025-01-15

### Changed
- Verifier reuses previous must-haves on re-verification instead of re-deriving, focuses deep verification on failed items with quick regression checks on passed items

## [1.5.10] - 2025-01-15

### Changed
- Milestone audit now reads existing phase VERIFICATION.md files instead of re-verifying each phase, aggregates tech debt and deferred gaps, adds `tech_debt` status for non-blocking accumulated debt

### Fixed
- VERIFICATION.md now included in phase completion commit alongside ROADMAP.md, STATE.md, and REQUIREMENTS.md

## [1.5.9] - 2025-01-15

### Added
- Milestone audit system (`/gsd:audit-milestone`) for verifying milestone completion with parallel verification agents

### Changed
- Checkpoint display format improved with box headers and unmissable "→ YOUR ACTION:" prompts
- Subagent colors updated (executor: yellow, integration-checker: blue)
- Execute-phase now recommends `/gsd:audit-milestone` when milestone completes

### Fixed
- Research-phase no longer gatekeeps by domain type

### Removed
- Domain expertise feature (`~/.claude/skills/expertise/`) - was personal tooling not available to other users

## [1.5.8] - 2025-01-15

### Added
- Verification loop: When gaps are found, verifier generates fix plans that execute automatically before re-verifying

### Changed
- `gsd-executor` subagent color changed from red to blue

## [1.5.7] - 2025-01-15

### Added
- `gsd-executor` subagent: Dedicated agent for plan execution with full workflow logic built-in
- `gsd-verifier` subagent: Goal-backward verification that checks if phase goals are actually achieved (not just tasks completed)
- Phase verification: Automatic verification runs when a phase completes to catch stubs and incomplete implementations
- Goal-backward planning reference: Documentation for deriving must-haves from goals

### Changed
- execute-plan and execute-phase now spawn `gsd-executor` subagent instead of using inline workflow
- Roadmap and planning workflows enhanced with goal-backward analysis

### Removed
- Obsolete templates (`checkpoint-resume.md`, `subagent-task-prompt.md`) — logic now lives in subagents

### Fixed
- Updated remaining `general-purpose` subagent references to use `gsd-executor`

## [1.5.6] - 2025-01-15

### Changed
- README: Separated flow into distinct steps (1 → 1.5 → 2 → 3 → 4 → 5) making `research-project` clearly optional and `define-requirements` required
- README: Research recommended for quality; skip only for speed

### Fixed
- execute-phase: Phase metadata (timing, wave info) now bundled into single commit instead of separate commits

## [1.5.5] - 2025-01-15

### Changed
- README now documents the `research-project` → `define-requirements` flow (optional but recommended before `create-roadmap`)
- Commands section reorganized into 7 grouped tables (Setup, Execution, Verification, Milestones, Phase Management, Session, Utilities) for easier scanning
- Context Engineering table now includes `research/` and `REQUIREMENTS.md`

## [1.5.4] - 2025-01-15

### Changed
- Research phase now loads REQUIREMENTS.md to focus research on concrete requirements (e.g., "email verification") rather than just high-level roadmap descriptions

## [1.5.3] - 2025-01-15

### Changed
- **execute-phase narration**: Orchestrator now describes what each wave builds before spawning agents, and summarizes what was built after completion. No more staring at opaque status updates.
- **new-project flow**: Now offers two paths — research first (recommended) or define requirements directly (fast path for familiar domains)
- **define-requirements**: Works without prior research. Gathers requirements through conversation when FEATURES.md doesn't exist.

### Removed
- Dead `/gsd:status` command (referenced abandoned background agent model)
- Unused `agent-history.md` template
- `_archive/` directory with old execute-phase version

## [1.5.2] - 2026-01-15

### Added
- Requirements traceability: roadmap phases now include `Requirements:` field listing which REQ-IDs they cover
- plan-phase loads REQUIREMENTS.md and shows phase-specific requirements before planning
- Requirements automatically marked Complete when phase finishes

### Changed
- Workflow preferences (mode, depth, parallelization) now asked in single prompt instead of 3 separate questions
- define-requirements shows full requirements list inline before commit (not just counts)
- Research-project and workflow aligned to both point to define-requirements as next step

### Fixed
- Requirements status now updated by orchestrator (commands) instead of subagent workflow, which couldn't determine phase completion

## [1.5.1] - 2026-01-14

### Changed
- Research agents write their own files directly (STACK.md, FEATURES.md, ARCHITECTURE.md, PITFALLS.md) instead of returning results to orchestrator
- Slimmed principles.md and load it dynamically in core commands

## [1.5.0] - 2026-01-14

### Added
- New `/gsd:research-project` command for pre-roadmap ecosystem research — spawns parallel agents to investigate stack, features, architecture, and pitfalls before you commit to a roadmap
- New `/gsd:define-requirements` command for scoping v1 requirements from research findings — transforms "what exists in this domain" into "what we're building"
- Requirements traceability: phases now map to specific requirement IDs with 100% coverage validation

### Changed
- **BREAKING:** New project flow is now: `new-project → research-project → define-requirements → create-roadmap`
- Roadmap creation now requires REQUIREMENTS.md and validates all v1 requirements are mapped to phases
- Simplified questioning in new-project to four essentials (vision, core priority, boundaries, constraints)

## [1.4.29] - 2026-01-14

### Removed
- Deleted obsolete `_archive/execute-phase.md` and `status.md` commands

## [1.4.28] - 2026-01-14

### Fixed
- Restored comprehensive checkpoint documentation with full examples for verification, decisions, and auth gates
- Fixed execute-plan command to use fresh continuation agents instead of broken resume pattern
- Rich checkpoint presentation formats now documented for all three checkpoint types

### Changed
- Slimmed execute-phase command to properly delegate checkpoint handling to workflow

## [1.4.27] - 2025-01-14

### Fixed
- Restored "what to do next" commands after plan/phase execution completes — orchestrator pattern conversion had inadvertently removed the copy/paste-ready next-step routing

## [1.4.26] - 2026-01-14

### Added
- Full changelog history backfilled from git (66 historical versions from 1.0.0 to 1.4.23)

## [1.4.25] - 2026-01-14

### Added
- New `/gsd:whats-new` command shows changes since your installed version
- VERSION file written during installation for version tracking
- CHANGELOG.md now included in package installation

## [1.4.24] - 2026-01-14

### Added
- USER-SETUP.md template for external service configuration

### Removed
- **BREAKING:** ISSUES.md system (replaced by phase-scoped UAT issues and TODOs)

## [1.4.23] - 2026-01-14

### Changed
- Removed dead ISSUES.md system code

## [1.4.22] - 2026-01-14

### Added
- Subagent isolation for debug investigations with checkpoint support

### Fixed
- DEBUG_DIR path constant to prevent typos in debug workflow

## [1.4.21] - 2026-01-14

### Fixed
- SlashCommand tool added to plan-fix allowed-tools

## [1.4.20] - 2026-01-14

### Fixed
- Standardized debug file naming convention
- Debug workflow now invokes execute-plan correctly

## [1.4.19] - 2026-01-14

### Fixed
- Auto-diagnose issues instead of offering choice in plan-fix

## [1.4.18] - 2026-01-14

### Added
- Parallel diagnosis before plan-fix execution

## [1.4.17] - 2026-01-14

### Changed
- Redesigned verify-work as conversational UAT with persistent state

## [1.4.16] - 2026-01-13

### Added
- Pre-execution summary for interactive mode in execute-plan
- Pre-computed wave numbers at plan time

## [1.4.15] - 2026-01-13

### Added
- Context rot explanation to README header

## [1.4.14] - 2026-01-13

### Changed
- YOLO mode is now recommended default in new-project

## [1.4.13] - 2026-01-13

### Fixed
- Brownfield flow documentation
- Removed deprecated resume-task references

## [1.4.12] - 2026-01-13

### Changed
- execute-phase is now recommended as primary execution command

## [1.4.11] - 2026-01-13

### Fixed
- Checkpoints now use fresh continuation agents instead of resume

## [1.4.10] - 2026-01-13

### Changed
- execute-plan converted to orchestrator pattern for performance

## [1.4.9] - 2026-01-13

### Changed
- Removed subagent-only context from execute-phase orchestrator

### Fixed
- Removed "what's out of scope" question from discuss-phase

## [1.4.8] - 2026-01-13

### Added
- TDD reasoning explanation restored to plan-phase docs

## [1.4.7] - 2026-01-13

### Added
- Project state loading before execution in execute-phase

### Fixed
- Parallel execution marked as recommended, not experimental

## [1.4.6] - 2026-01-13

### Added
- Checkpoint pause/resume for spawned agents
- Deviation rules, commit rules, and workflow references to execute-phase

## [1.4.5] - 2026-01-13

### Added
- Parallel-first planning with dependency graphs
- Checkpoint-resume capability for long-running phases
- `.claude/rules/` directory for auto-loaded contribution rules

### Changed
- execute-phase uses wave-based blocking execution

## [1.4.4] - 2026-01-13

### Fixed
- Inline listing for multiple active debug sessions

## [1.4.3] - 2026-01-13

### Added
- `/gsd:debug` command for systematic debugging with persistent state

## [1.4.2] - 2026-01-13

### Fixed
- Installation verification step clarification

## [1.4.1] - 2026-01-13

### Added
- Parallel phase execution via `/gsd:execute-phase`
- Parallel-aware planning in `/gsd:plan-phase`
- `/gsd:status` command for parallel agent monitoring
- Parallelization configuration in config.json
- Wave-based parallel execution with dependency graphs

### Changed
- Renamed `execute-phase.md` workflow to `execute-plan.md` for clarity
- Plan frontmatter now includes `wave`, `depends_on`, `files_modified`, `autonomous`

## [1.4.0] - 2026-01-12

### Added
- Full parallel phase execution system
- Parallelization frontmatter in plan templates
- Dependency analysis for parallel task scheduling
- Agent history schema v1.2 with parallel execution support

### Changed
- Plans can now specify wave numbers and dependencies
- execute-phase orchestrates multiple subagents in waves

## [1.3.34] - 2026-01-11

### Added
- `/gsd:add-todo` and `/gsd:check-todos` for mid-session idea capture

## [1.3.33] - 2026-01-11

### Fixed
- Consistent zero-padding for decimal phase numbers (e.g., 01.1)

### Changed
- Removed obsolete .claude-plugin directory

## [1.3.32] - 2026-01-10

### Added
- `/gsd:resume-task` for resuming interrupted subagent executions

## [1.3.31] - 2026-01-08

### Added
- Planning principles for security, performance, and observability
- Pro patterns section in README

## [1.3.30] - 2026-01-08

### Added
- verify-work option surfaces after plan execution

## [1.3.29] - 2026-01-08

### Added
- `/gsd:verify-work` for conversational UAT validation
- `/gsd:plan-fix` for fixing UAT issues
- UAT issues template

## [1.3.28] - 2026-01-07

### Added
- `--config-dir` CLI argument for multi-account setups
- `/gsd:remove-phase` command

### Fixed
- Validation for --config-dir edge cases

## [1.3.27] - 2026-01-07

### Added
- Recommended permissions mode documentation

### Fixed
- Mandatory verification enforced before phase/milestone completion routing

## [1.3.26] - 2026-01-06

### Added
- Claude Code marketplace plugin support

### Fixed
- Phase artifacts now committed when created

## [1.3.25] - 2026-01-06

### Fixed
- Milestone discussion context persists across /clear

## [1.3.24] - 2026-01-06

### Added
- `CLAUDE_CONFIG_DIR` environment variable support

## [1.3.23] - 2026-01-06

### Added
- Non-interactive install flags (`--global`, `--local`) for Docker/CI

## [1.3.22] - 2026-01-05

### Changed
- Removed unused auto.md command

## [1.3.21] - 2026-01-05

### Changed
- TDD features use dedicated plans for full context quality

## [1.3.20] - 2026-01-05

### Added
- Per-task atomic commits for better AI observability

## [1.3.19] - 2026-01-05

### Fixed
- Clarified create-milestone.md file locations with explicit instructions

## [1.3.18] - 2026-01-05

### Added
- YAML frontmatter schema with dependency graph metadata
- Intelligent context assembly via frontmatter dependency graph

## [1.3.17] - 2026-01-04

### Fixed
- Clarified depth controls compression, not inflation in planning

## [1.3.16] - 2026-01-04

### Added
- Depth parameter for planning thoroughness (`--depth=1-5`)

## [1.3.15] - 2026-01-01

### Fixed
- TDD reference loaded directly in commands

## [1.3.14] - 2025-12-31

### Added
- TDD integration with detection, annotation, and execution flow

## [1.3.13] - 2025-12-29

### Fixed
- Restored deterministic bash commands
- Removed redundant decision_gate

## [1.3.12] - 2025-12-29

### Fixed
- Restored plan-format.md as output template

## [1.3.11] - 2025-12-29

### Changed
- 70% context reduction for plan-phase workflow
- Merged CLI automation into checkpoints
- Compressed scope-estimation (74% reduction) and plan-phase.md (66% reduction)

## [1.3.10] - 2025-12-29

### Fixed
- Explicit plan count check in offer_next step

## [1.3.9] - 2025-12-27

### Added
- Evolutionary PROJECT.md system with incremental updates

## [1.3.8] - 2025-12-18

### Added
- Brownfield/existing projects section in README

## [1.3.7] - 2025-12-18

### Fixed
- Improved incremental codebase map updates

## [1.3.6] - 2025-12-18

### Added
- File paths included in codebase mapping output

## [1.3.5] - 2025-12-17

### Fixed
- Removed arbitrary 100-line limit from codebase mapping

## [1.3.4] - 2025-12-17

### Fixed
- Inline code for Next Up commands (avoids nesting ambiguity)

## [1.3.3] - 2025-12-17

### Fixed
- Check PROJECT.md not .planning/ directory for existing project detection

## [1.3.2] - 2025-12-17

### Added
- Git commit step to map-codebase workflow

## [1.3.1] - 2025-12-17

### Added
- `/gsd:map-codebase` documentation in help and README

## [1.3.0] - 2025-12-17

### Added
- `/gsd:map-codebase` command for brownfield project analysis
- Codebase map templates (stack, architecture, structure, conventions, testing, integrations, concerns)
- Parallel Explore agent orchestration for codebase analysis
- Brownfield integration into GSD workflows

### Changed
- Improved continuation UI with context and visual hierarchy

### Fixed
- Permission errors for non-DSP users (removed shell context)
- First question is now freeform, not AskUserQuestion

## [1.2.13] - 2025-12-17

### Added
- Improved continuation UI with context and visual hierarchy

## [1.2.12] - 2025-12-17

### Fixed
- First question should be freeform, not AskUserQuestion

## [1.2.11] - 2025-12-17

### Fixed
- Permission errors for non-DSP users (removed shell context)

## [1.2.10] - 2025-12-16

### Fixed
- Inline command invocation replaced with clear-then-paste pattern

## [1.2.9] - 2025-12-16

### Fixed
- Git init runs in current directory

## [1.2.8] - 2025-12-16

### Changed
- Phase count derived from work scope, not arbitrary limits

## [1.2.7] - 2025-12-16

### Fixed
- AskUserQuestion mandated for all exploration questions

## [1.2.6] - 2025-12-16

### Changed
- Internal refactoring

## [1.2.5] - 2025-12-16

### Changed
- `<if mode>` tags for yolo/interactive branching

## [1.2.4] - 2025-12-16

### Fixed
- Stale CONTEXT.md references updated to new vision structure

## [1.2.3] - 2025-12-16

### Fixed
- Enterprise language removed from help and discuss-milestone

## [1.2.2] - 2025-12-16

### Fixed
- new-project completion presented inline instead of as question

## [1.2.1] - 2025-12-16

### Fixed
- AskUserQuestion restored for decision gate in questioning flow

## [1.2.0] - 2025-12-15

### Changed
- Research workflow implemented as Claude Code context injection

## [1.1.2] - 2025-12-15

### Fixed
- YOLO mode now skips confirmation gates in plan-phase

## [1.1.1] - 2025-12-15

### Added
- README documentation for new research workflow

## [1.1.0] - 2025-12-15

### Added
- Pre-roadmap research workflow
- `/gsd:research-phase` for niche domain ecosystem discovery
- `/gsd:research-project` command with workflow and templates
- `/gsd:create-roadmap` command with research-aware workflow
- Research subagent prompt templates

### Changed
- new-project split to only create PROJECT.md + config.json
- Questioning rewritten as thinking partner, not interviewer

## [1.0.11] - 2025-12-15

### Added
- `/gsd:research-phase` for niche domain ecosystem discovery

## [1.0.10] - 2025-12-15

### Fixed
- Scope creep prevention in discuss-phase command

## [1.0.9] - 2025-12-15

### Added
- Phase CONTEXT.md loaded in plan-phase command

## [1.0.8] - 2025-12-15

### Changed
- PLAN.md included in phase completion commits

## [1.0.7] - 2025-12-15

### Added
- Path replacement for local installs

## [1.0.6] - 2025-12-15

### Changed
- Internal improvements

## [1.0.5] - 2025-12-15

### Added
- Global/local install prompt during setup

### Fixed
- Bin path fixed (removed ./)
- .DS_Store ignored

## [1.0.4] - 2025-12-15

### Fixed
- Bin name and circular dependency removed

## [1.0.3] - 2025-12-15

### Added
- TDD guidance in planning workflow

## [1.0.2] - 2025-12-15

### Added
- Issue triage system to prevent deferred issue pile-up

## [1.0.1] - 2025-12-15

### Added
- Initial npm package release

## [1.0.0] - 2025-12-14

### Added
- Initial release of GSD (Get Shit Done) meta-prompting system
- Core slash commands: `/gsd:new-project`, `/gsd:discuss-phase`, `/gsd:plan-phase`, `/gsd:execute-phase`
- PROJECT.md and STATE.md templates
- Phase-based development workflow
- YOLO mode for autonomous execution
- Interactive mode with checkpoints

[Unreleased]: https://github.com/nForma-AI/QGSD/compare/v0.2.0...HEAD
[0.2.1]: https://github.com/nForma-AI/QGSD/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/nForma-AI/QGSD/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nForma-AI/QGSD/releases/tag/v0.1.0
[1.20.5]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.20.5
[1.20.4]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.20.4
[1.20.3]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.20.3
[1.20.2]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.20.2
[1.20.1]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.20.1
[1.20.0]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.20.0
[1.19.2]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.19.2
[1.19.1]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.19.1
[1.19.0]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.19.0
[1.18.0]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.18.0
[1.17.0]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.17.0
[1.16.0]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.16.0
[1.15.0]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.15.0
[1.14.0]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.14.0
[1.13.0]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.13.0
[1.12.1]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.12.1
[1.12.0]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.12.0
[1.11.2]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.11.2
[1.11.1]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.11.0
[1.10.1]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.10.1
[1.10.0]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.10.0
[1.9.12]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.9.12
[1.9.11]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.9.11
[1.9.10]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.9.10
[1.9.9]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.9.9
[1.9.8]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.9.8
[1.9.7]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.9.7
[1.9.6]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.9.6
[1.9.5]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.9.5
[1.9.4]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.9.4
[1.9.2]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.9.2
[1.9.0]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.9.0
[1.8.0]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.8.0
[1.7.1]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.7.1
[1.7.0]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.7.0
[1.6.4]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.6.4
[1.6.3]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.6.3
[1.6.2]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.6.2
[1.6.1]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.6.1
[1.6.0]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.6.0
[1.5.30]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.30
[1.5.29]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.29
[1.5.28]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.28
[1.5.27]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.27
[1.5.26]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.26
[1.5.25]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.25
[1.5.24]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.24
[1.5.23]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.23
[1.5.22]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.22
[1.5.21]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.21
[1.5.20]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.20
[1.5.19]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.19
[1.5.18]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.18
[1.5.17]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.17
[1.5.16]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.16
[1.5.15]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.15
[1.5.14]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.14
[1.5.13]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.13
[1.5.12]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.12
[1.5.11]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.11
[1.5.10]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.10
[1.5.9]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.9
[1.5.8]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.8
[1.5.7]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.7
[1.5.6]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.6
[1.5.5]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.5
[1.5.4]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.4
[1.5.3]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.3
[1.5.2]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.2
[1.5.1]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.1
[1.5.0]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.5.0
[1.4.29]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.29
[1.4.28]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.28
[1.4.27]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.27
[1.4.26]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.26
[1.4.25]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.25
[1.4.24]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.24
[1.4.23]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.23
[1.4.22]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.22
[1.4.21]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.21
[1.4.20]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.20
[1.4.19]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.19
[1.4.18]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.18
[1.4.17]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.17
[1.4.16]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.16
[1.4.15]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.15
[1.4.14]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.14
[1.4.13]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.13
[1.4.12]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.12
[1.4.11]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.11
[1.4.10]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.10
[1.4.9]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.9
[1.4.8]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.8
[1.4.7]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.7
[1.4.6]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.6
[1.4.5]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.5
[1.4.4]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.4
[1.4.3]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.3
[1.4.2]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.2
[1.4.1]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.1
[1.4.0]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.4.0
[1.3.34]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.34
[1.3.33]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.33
[1.3.32]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.32
[1.3.31]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.31
[1.3.30]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.30
[1.3.29]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.29
[1.3.28]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.28
[1.3.27]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.27
[1.3.26]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.26
[1.3.25]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.25
[1.3.24]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.24
[1.3.23]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.23
[1.3.22]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.22
[1.3.21]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.21
[1.3.20]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.20
[1.3.19]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.19
[1.3.18]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.18
[1.3.17]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.17
[1.3.16]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.16
[1.3.15]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.15
[1.3.14]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.14
[1.3.13]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.13
[1.3.12]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.12
[1.3.11]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.11
[1.3.10]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.10
[1.3.9]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.9
[1.3.8]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.8
[1.3.7]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.7
[1.3.6]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.6
[1.3.5]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.5
[1.3.4]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.4
[1.3.3]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.3
[1.3.2]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.2
[1.3.1]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.1
[1.3.0]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.3.0
[1.2.13]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.2.13
[1.2.12]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.2.12
[1.2.11]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.2.11
[1.2.10]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.2.10
[1.2.9]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.2.9
[1.2.8]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.2.8
[1.2.7]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.2.7
[1.2.6]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.2.6
[1.2.5]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.2.5
[1.2.4]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.2.4
[1.2.3]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.2.3
[1.2.2]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.2.2
[1.2.1]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.2.1
[1.2.0]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.2.0
[1.1.2]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.1.2
[1.1.1]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.1.1
[1.1.0]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.1.0
[1.0.11]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.0.11
[1.0.10]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.0.10
[1.0.9]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.0.9
[1.0.8]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.0.8
[1.0.7]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.0.7
[1.0.6]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.0.6
[1.0.5]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.0.5
[1.0.4]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.0.4
[1.0.3]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.0.3
[1.0.2]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.0.2
[1.0.1]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.0.1
[1.0.0]: https://github.com/glittercowboy/get-shit-done/releases/tag/v1.0.0

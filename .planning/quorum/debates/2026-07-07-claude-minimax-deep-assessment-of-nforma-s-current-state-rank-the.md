---
date: 2026-07-07
question: "Deep assessment of nForma's current state — rank the top priorities and flag the top risks. Ground your answer in these verified facts.

RECENTLY SHIPPED (merged to main this session):
(a) observe CLI tooling detection for sentry-cli + gcx with install/auth probing and error-attribution;
(b) a standalone autodetection script (node bin/observe-tooling.cjs --json/--strict/--source);
(c) observe test CI-safety — went from 2/17 to 17/17 observe test files gated, fixing a real timer leak in observe-registry dispatch + a hermetic-test rewrite;
(d) NEW deterministic benchmark gate benchmark-fixtures.yml that runs the external nf-benchmark fixture corpus + precision gate against the PR's OWN bin/nf-solve.cjs (public nf-benchmark checkout, pinned SHA, no API key, ~40s, blocking).
All CI on main is green EXCEPT the items below.

OPEN TENSIONS / RISKS:
(1) There are now THREE overlapping benchmark workflows: benchmark-fixtures.yml (new, deterministic, works), benchmark-gate.yml (in-repo smoke), and benchmark-sync.yml (FAILS on every push to main — it invokes $HOME/code/nf-benchmark, a local path that does not exist on GitHub runners; it's the heavy LLM \"auto-advance baseline\" job). Per prior findings nf-solve is NON-IDEMPOTENT (benchmark stability 0/15 even on main), so the baseline-auto-advance metric chases noise. Should benchmark-sync.yml be FIXED (add an nf-benchmark checkout + point at the local SUT + needs ANTHROPIC_API_KEY) or RETIRED as superseded by the deterministic fixtures gate?

(2) RELEASE DRIFT: package.json on main is 0.44.0-rc.1 but npm dist-tags show next=0.43.1 AND latest=0.43.1 — nothing from 0.44.x has EVER published. PR #347 tries to bump to 0.44.0-rc.2 but its \"Publish to npm (@next)\" check FAILS on an NPM_TOKEN permission/auth error (404 on PUT @nforma.ai/nforma) that only the repo owner can fix. Main has since advanced well past 0.44.0-rc.1 with the observe/benchmark/autodetection work, so #347 is stale. What's the cleanest path to unblock and rationalize the release once NPM_TOKEN is fixed?

(3) .planning/STATE.md is stale (says v0.41 milestone, \"determining phase\", quick tasks dated April 2026) — it does not reflect current reality.

(4) Pending task #44: nf-solve aggregate residual coercion — a skipped layer (residual -1) is coerced to 0 so total==0 can't distinguish \"clean\" from \"unmeasured\"; a partial guard shipped (#346) but \"degraded\" is not yet wired into the convergence DECISION.

Give: (A) the top 3 priorities RANKED with rationale, (B) a clear FIX-vs-RETIRE verdict on benchmark-sync.yml, (C) the top 3 risks, (D) any blind spot the facilitator is missing. Vote APPROVE if you broadly agree with a sensible prioritization and can add refinements; BLOCK only if you believe a proposed priority or the benchmark-sync verdict would be actively wrong/harmful."
slot: claude-minimax
round: 1
mode: "A"
verdict: 
matched_requirement_ids: [CONV-03, TEST-01, DIAG-02, SENS-03, SIM-03, STOP-05, BTF-03, CL-01, CONV-02, SENS-02, STD-02, DISP-04, SAFE-01, SENS-01, SYNC-04, TRACK-02, INST-10, PF-01, RLS-02, STOP-02]
artifact_path: ""
---

# Debate Trace: claude-minimax on round 1

## Reasoning
[resolve-providers] using /Users/jonathanborduas/.claude/nf-bin/providers.json (via ~/.claude.json pointer)
[call-quorum-slot] Timeouts: idle=300000ms hard=300000ms for slot claude-minimax
[call-quorum-slot] retry 1/2 for slot claude-minimax after 1000ms
[call-quorum-slot] retry 2/2 for slot claude-minimax after 3000ms
[call-quorum-slot] STALL: only 202 bytes received then silence for 30000ms — no

## Citations
(none)

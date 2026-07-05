---
name: nf:autonomous
description: Run remaining roadmap phases autonomously — discuss→plan→execute→verify, quorum-gated planning + formal/harden verify
argument-hint: "[--from N] [--to N] [--only N] [--fully-auto] [--interactive]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Task
  - SlashCommand
---

<objective>
Drive every remaining milestone phase to completion with minimal supervision. For each phase: **discuss → plan → execute → verify**, advancing automatically and pausing only on real blockers.

Ported from open-gsd/gsd-core's `autonomous`, fused with nForma's differentiators:
- **Planning is quorum-gated** — `nf:plan-phase` already routes through the multi-LLM quorum (true consensus, not single-model multi-pass).
- **Verification is formal + adversarial** — each phase must pass formal model-checking (`run-formal-verify`) AND `nf:harden` before advancing. "Verified" means formally checked + hardened, not just tests-green.

Safe by default: **pauses before executing each phase** for a one-line go/no-go, pauses on every blocker, and never force-pushes. `--fully-auto` opts into unattended execution (still pauses on blockers).
</objective>

<execution_context>
@~/.claude/nf/workflows/autonomous.md
</execution_context>

<context>
Arguments: $ARGUMENTS

Flags:
- `--from N` / `--to N` / `--only N` — bound the phase range (default: all remaining incomplete phases).
- `--fully-auto` — execute each phase without the pre-execute go/no-go pause (still pauses on blockers).
- `--interactive` — run discuss inline with real questions (default: auto-answer from context where confident).
</context>

<process>
Follow ~/.claude/nf/workflows/autonomous.md. Discover the remaining phases, then loop each through discuss→plan→execute→verify with the quorum and formal/harden gates. Pause on blockers. After the last phase: audit → complete → cleanup. Never force-push; never skip the verify gate.
</process>

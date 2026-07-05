---
name: nf:forensics
description: Post-mortem for a stuck or failed workflow — diagnose root cause from git + .planning state
argument-hint: "[optional: what went wrong]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
---

<objective>
Investigate what went wrong during a stuck or failed nForma workflow. Analyze git history, `.planning/` artifacts, and filesystem state to detect anomalies and produce a structured diagnostic report — so you understand the root cause and can act, instead of guessing.

Ported from open-gsd/gsd-core's forensics. **nForma fusion:** on top of the generic anomalies, it probes the failure modes specific to our stack — a stuck/degraded quorum, a formal-verify failure or model-staleness, formal-artifact autocommit pollution, and circuit-breaker trips.

Output: a redacted report in `.planning/forensics/`, presented inline. Read-only; never mutates project state.
</objective>

<execution_context>
@~/.claude/nf/workflows/forensics.md
</execution_context>

<context>
Arguments: $ARGUMENTS (optional — a description of the symptom to focus the investigation).
</context>

<process>
1. Snapshot the evidence: `git log`/`status`/`diff` (recent commits, time gaps, uncommitted work, conflicts), `.planning/STATE.md`, and the active phase's artifacts.
2. Detect generic anomalies: interrupted commits, orphaned artifacts, state/roadmap disagreement, long time-gaps, uncommitted work on a "complete" phase.
3. **nForma-specific probes:** degraded/stuck quorum (roster all-UNAVAIL, below min_live_voters), formal-verify failures or stale models (`check-model-staleness`), formal-artifact autocommit pollution on a feature branch, circuit-breaker trips (`.claude/circuit-breaker-state.json`).
4. Write a redacted report to `.planning/forensics/`, rank findings by severity, and present the most likely root cause with 2–3 concrete recovery options.
</process>

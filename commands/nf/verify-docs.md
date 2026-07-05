---
name: nf:verify-docs
description: Adversarially verify factual claims in docs against the live codebase and formal artifacts
argument-hint: "[optional: doc path or glob, e.g. README.md or docs/**/*.md]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Task
---

<objective>
Fact-check the factual claims in project documentation against the live codebase using parallel `nf-doc-verifier` agents (adversarial FORCE stance: assume every claim is wrong until the filesystem proves it right).

Ported from open-gsd/gsd-core's doc-verifier and fused with nForma's formal layer — a 6th claim category verifies doc claims about requirement IDs, formal models, and invariants against `.planning/formal/`.

Output: a per-doc PASS/FAIL/UNVERIFIABLE summary; BLOCKER findings can be escalated to `/nf:quorum` for a second opinion.
</objective>

<execution_context>
@~/.claude/nf/workflows/verify-docs.md
</execution_context>

<context>
Target docs: $ARGUMENTS (optional — a path or glob). If empty, the workflow discovers the standard doc set (README, docs/, CONTRIBUTING, .planning docs).
</context>

<process>
1. Discover the doc set (from $ARGUMENTS or the default set).
2. Spawn one `nf-doc-verifier` agent per doc (parallel, capped at 6 concurrent), each writing `.planning/tmp/verify-<doc>.json`.
3. Aggregate results into a summary table: doc, claims passed/checked, BLOCKERs, WARNINGs.
4. If any BLOCKERs, offer to escalate them to `/nf:quorum` for adversarial confirmation before the user acts.
</process>

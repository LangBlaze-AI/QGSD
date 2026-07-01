---
name: nf:ultra-hard
description: Quorum-verified adversarial hardening to convergence. A review panel finds defects across security/correctness dimensions, a multi-model quorum verifies each (refuting false positives), and confirmed findings are fixed failing-test-first — looping until two dry rounds. Use for set-once / high-stakes code where one reviewer is not enough.
argument-hint: "[--area <path>] [--dimensions <csv>] [--rounds <N>] [--voters <N>] [--test-cmd \"<cmd>\"] [--commit]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
---

<objective>
Run a quorum + harden loop: fan out independent reviewers across security/correctness DIMENSIONS,
have a multi-model QUORUM adversarially verify every candidate finding (so false positives are
refuted, not fixed), then fix each CONFIRMED finding failing-test-first — repeating until two
consecutive rounds surface zero new confirmed findings (convergence) or the round cap is reached.

This is `nf:harden` with independent eyes and a verification quorum. `harden` is one agent probing
edge cases; `ultra-hard` is a review panel plus a majority-vote verification quorum, for
irreversible / high-stakes code (money, keys, migrations, auth) where a single sequential reviewer
demonstrably misses things.

Fixers operate under HARD CONSTRAINTS: never weaken or delete an existing guard/test to go green,
never leak a secret, and independently cross-check any money/crypto/identity result against an
external reference before trusting it. The full suite must stay green after every fix.
</objective>

<execution_context>
@~/.claude/nf/workflows/ultra-hard.md
@~/.claude/nf/references/quorum-dispatch.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute the ultra-hard workflow from the execution context end-to-end: parse args → establish a
green baseline (BLOCK if red) → for each round: fan out the review panel, quorum-verify every
candidate, fix each confirmed finding failing-test-first while keeping the suite green → converge at
two dry rounds (or the round cap) → print the confirmed-findings table + residual-risk notes and
return the final status.
</process>

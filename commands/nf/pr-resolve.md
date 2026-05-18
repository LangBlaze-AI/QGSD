---
name: nf:pr-resolve
description: Evaluate PR review threads from bots, judge validity, resolve threads, and merge when CI passes
argument-hint: "[PR number or URL (defaults to current branch PR)]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
  - Edit
  - AskUserQuestion
  - Agent
---

Load the `pr-resolve` skill, then apply it to the user's input.

<steps>
1. Use the `skill` tool to load the **pr-resolve** skill.
2. Follow the loaded skill instructions to process `$ARGUMENTS`.
</steps>

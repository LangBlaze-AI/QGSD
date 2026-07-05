---
name: nf:seed
description: Capture a forward-looking idea (a "seed") with a trigger condition, or list/promote seeds
argument-hint: "<idea text> [--trigger <when>] [--scope <area>] | list | promote <SEED-NNN>"
allowed-tools:
  - Read
  - Bash
  - Glob
---

<objective>
Park an idea that isn't a task yet. A **seed** carries a TRIGGER ("when X, do this") and rests in `.planning/seeds/` until it fires or is promoted to the roadmap. Fills the gap between "do it now" (todos) and "forget it" — the substrate `/nf:new-milestone` and `/nf:autonomous` can consume.

Ported from open-gsd/gsd-core's capture/seeds. **nForma fusion:** a seed touching a formally-modeled behavior is auto-tagged `formal`, so promotion routes through `/nf:close-formal-gaps` — a parked idea that changes a proven behavior lands as an invariant, not just a plan.
</objective>

<context>
Arguments: $ARGUMENTS
</context>

<process>
Dispatch to `bin/seeds.cjs` via the portable path:

```bash
REQ="${HOME}/.claude/nf-bin/seeds.cjs"; [ -f "$REQ" ] || REQ="./bin/seeds.cjs"
```

- **`list`** → `node "$REQ" list` — browse parked seeds (dormant/promoted, formal-tagged).
- **`promote <SEED-NNN>`** → `node "$REQ" promote <id>` — print the ROADMAP 999.x backlog entry (non-destructive; you then add it to ROADMAP.md, and if it's `formal` run `/nf:close-formal-gaps`).
- **anything else** → treat `$ARGUMENTS` as the idea text and plant it: `node "$REQ" plant "<text>" [--trigger <when>] [--scope <area>]`. Confirm the SEED id.

Keep it one action per invocation. Never auto-edit ROADMAP.md — promote prints; the user applies.
</process>

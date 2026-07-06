---
name: nf:next
description: Smart entry — detect project state and route to the right next nForma action
argument-hint: "[optional free-form intent]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - SlashCommand
---

<objective>
The state-aware front door. Detect what's going on in this project, show a short menu of the right next actions, and dispatch to exactly one. A launcher/router only — it never does the work itself.

Ported from open-gsd/gsd-core's smart-entry, fused with nForma: the menu is nForma-native — a verify-failed phase routes to `/nf:harden` or `/nf:solve`, open formal gaps surface `/nf:close-formal-gaps`, and every in-project situation offers `/nf:autonomous` (the quorum + formal/harden-gated phase loop).
</objective>

<context>
Arguments: $ARGUMENTS (optional — a free-form intent instead of picking a menu item).
</context>

<process>
1. Detect the situation:

   ```bash
   REQ="${HOME}/.claude/nf-bin/smart-entry.cjs"; [ -f "$REQ" ] || REQ="./bin/smart-entry.cjs"
   node "$REQ" --json 2>/dev/null || true
   ```

   Parse `{ situation, summary, actions[] }`. If the detector errors or returns nothing, fall back to running `/nf:progress` and stop (never strand the user).

2. Present the situation + the short menu (mark the recommended action). Keep it to the returned actions — don't invent options.

3. Dispatch **exactly one** command:
   - If the user picked an action, run its `command`.
   - If `$ARGUMENTS` is free-form intent, treat it as the goal and route to the closest action (or `/nf:progress` if unclear).

   After dispatching, **stop** — the dispatched command owns everything from here. Do not chain or re-enter.
</process>

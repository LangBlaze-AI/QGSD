---
name: nf:goal-writer
description: Write a durable operating-doctrine .md plus the matching Claude Code /goal condition for a long-running autonomous session. Grounds the doctrine in this project's real recorded failures rather than generic best practices.
argument-hint: "<rough intent, e.g. 'multi-repo grind leaning on quorum + pr-resolve'>"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - Task
  - AskUserQuestion
---

<objective>
Turn a rough intent into two artifacts:

1. **A doctrine `.md`** — the operating manual the autonomous session reads and obeys.
2. **A `/goal` condition** — the ≤4000-char completion condition pasted into Claude Code.

The value is in **grounding**: principles are derived from this project's *recorded*
failures (memory corpus, closed PRs, error store), each cited, so the doctrine can be
re-audited instead of taken on faith. A doctrine of generic best practices is a failed
run of this skill.
</objective>

<goal_command_facts>
Verified constraints on Claude Code's built-in `/goal` (v2.1.139+). Do not contradict these.

- **Syntax:** `/goal <condition>` — natural language, **≤4000 characters**.
- **No file references.** `/goal` has no `@file.md` syntax. A path named in the
  condition is read as *prose instruction to the agent*, not a harness-level load —
  so the condition must instruct the agent to read it, and the first turn must act on that.
- **It is a completion condition, not a task prompt.** After every turn a fast model
  judges whether the condition is met, using only what the agent surfaced in the
  conversation. It cannot inspect the filesystem independently.
- **Loop:** condition unmet → another turn starts automatically, with no human prompt.
- **Termination:** met → cleared and recorded as achieved. `/goal clear` stops it early.
  `/goal` with no args shows condition, elapsed time, turn count, token spend, and the
  evaluator's latest reason.
- **Scope:** session-scoped; survives `--resume`/`--continue` (timer and turn count reset).
- **Permissions:** `/goal` removes the per-turn prompt, **not** per-tool permission
  prompts. Unattended running needs auto mode (or pre-granted permissions) as well.
- **Therefore every generated condition MUST include:**
  - an explicitly **observable** end state (a command's exit code, an empty queue, a
    countable set) — never a subjective state like "the code is clean",
  - a **turn cap** (`or stop after N turns`) so an unsatisfiable condition cannot spin,
  - an instruction to **report progress each turn**, since the evaluator only sees
    what was surfaced.
</goal_command_facts>

<process>

<step name="1_parse_intent">
`$ARGUMENTS` is the rough intent. If empty, infer it from the conversation's most
recent open objective; if none, ask for it in one question and stop.

Extract and hold: the **work domain**, the **repo scope**, and any **named skills** to lean on.
Do not ask the user to fill gaps yet — §2 may answer them from evidence.
</step>

<step name="2_gather_evidence">
Ground the doctrine. Run these and read the results before writing a single principle.

**Recorded failures — the primary source:**
```bash
ls ~/.claude/projects/*/memory/MEMORY.md 2>/dev/null
```
Read the `MEMORY.md` for the current project and every memory it indexes whose hook
describes a **failure, false signal, or recurring class**. These are already-distilled
lessons — the highest-value input available.

**Error store (often noisy — treat as a lead, not a fact):**
```bash
node "$HOME/.claude/nf-bin/memory-store.cjs" query-errors 2>/dev/null || node ./bin/memory-store.cjs query-errors 2>/dev/null
```

**Recurrence evidence — the strongest signal of a real class.** A bug shape fixed
three or more times is a missing shared primitive plus a missing gate:
```bash
git log --oneline -400 | grep -iE '^\w+ (fix|revert)' | head -60
```

**Repo fleet, if the intent is multi-repo:**
```bash
find ~/code -maxdepth 2 -name .git -type d 2>/dev/null | sed 's|/.git$||' | head -40
ls ~/.claude/polyrepos/*.json 2>/dev/null
```

**Automation surface, if the intent mentions IaC/SOPS/CI:**
```bash
find ~/code -maxdepth 2 -name '.sops.yaml' 2>/dev/null | head -20
find ~/code -maxdepth 3 -path '*/.github/workflows' -type d 2>/dev/null | wc -l
```

**This session's own failures.** Scan the current conversation for reverts, retries,
corrections, and rejected tool calls. Recent first-hand mistakes are the most credible
principles in the document — include them.
</step>

<step name="3_derive_principles">
Convert evidence into principles. **Every principle must cite its evidence** — the
PR numbers, the metric that lied, the count of recurrences, the thing that broke.

Quality bar, enforced:
- ❌ "Write tests" / "Be careful with git" — generic, unfalsifiable, delete it.
- ✅ "Config-path drift was fixed 6× (#150 #148 #162 #163 #165 #186) because the fix
  was pasted per-call-site. On the second occurrence, extract the primitive and gate it."

Fold near-duplicates into one principle with multiple citations. Aim for **10–15**
principles: fewer reads as thin, more will not be retained.

Prefer classes that recur or that produced a **false green** — an ungated class and a
falsely-passing check are the two failure modes that cost the most downstream.
</step>

<step name="4_quorum_ratify">
For a consequential doctrine — one that will run unattended, touch multiple repos, or
gate merges — ratify the principle set through the quorum. Skip for a small,
single-repo, low-blast-radius goal, and say that you skipped it.

```
/nf:quorum Here is a derived operating doctrine for an autonomous session: <principles>.
Which of these are genuinely load-bearing, which are generic filler that should be cut,
and which important failure class is missing? Cite evidence for additions.
```

Record the verdict **and the dissent** — a minority position naming a concrete failure
mode usually belongs in §Hard stops. If the quorum returns all-UNAVAIL or thin
consensus, report that and continue with the underived doctrine clearly marked
`(unratified)`; never present a solo opinion as consensus.
</step>

<step name="5_write_doctrine">
Write the `.md`. Default path `~/.claude/goals/<slug>.md` — global, and outside the
directories `bin/install.js` wipes (`commands/nf/`, `nf/`, `agents/nf-*`). Use a
repo-local path only if the doctrine is genuinely repo-specific.

Required sections:

1. **Mission** — the loop, as concrete named steps, plus what makes a cycle *failed*.
2. **Meta-principles** — §3's output, each with cited evidence.
3. **Automate-by-default** — only if in scope. State the preference order explicitly
   (Actions → IaC → SOPS → checked-in scripts → manual) and the rule that a manual
   action performed twice is a defect to be codified.
4. **Skill protocol** — for each named skill: when it is *required*, when it is the
   wrong tool, and the discipline for reading its output. Judgment calls warrant a
   quorum; verifiable facts do not — checking is faster and more reliable than voting.
5. **Hard stops** — the non-negotiable list. Always include: publish/release,
   deploy/infra apply, secret rotation, destructive git, data migrations,
   money/identity, external communication. Add a reversibility test: if it cannot be
   undone in one command with no external side effects, it is a hard stop. Add a
   repeat-failure ceiling (escalate at 3 — a loop is not progress).
6. **Definition of done** — a per-unit checklist, each item traceable to a principle.
7. **Anti-patterns** — a table of what actually went wrong. This is the section that
   gets re-read; make each row a real incident, not a hypothetical.

Write for an agent that will re-read §Hard stops under time pressure: short sentences,
imperative voice, no hedging.
</step>

<step name="6_emit_goal_condition">
Emit the `/goal` condition. Verify **before** printing it:

```bash
GOAL_TEXT='<the condition>' node -e 'const t=process.env.GOAL_TEXT||""; console.log("chars:", t.length, t.length<=4000?"OK":"TOO LONG — TIGHTEN")'
```

The condition must contain, in this order:

1. **The read instruction** — "Read `<abs path>` and follow it as your operating
   doctrine" (prose, because `/goal` has no file-reference syntax).
2. **The observable end state** — phrased so the evaluator can judge it from what the
   agent reports. Prefer countable or exit-code-shaped conditions.
3. **The per-turn reporting requirement** — the evaluator sees only what was surfaced.
4. **The turn cap** — `or stop after N turns`.
5. **The stop-and-surface clause** — pointing at the doctrine's hard-stop list.

Print the condition in a single copy-pasteable block, then state plainly:
- the character count,
- that unattended running also needs auto mode (`/goal` only removes the per-turn prompt),
- that `/goal` alone shows live status and `/goal clear` stops it.
</step>

<step name="7_report">
Report: doctrine path, principle count with the evidence classes behind them, whether
quorum ratified (and any dissent carried into hard stops), the condition's character
count, and the exact next command to run.

Name what you could **not** ground. A principle included on general reasoning rather
than recorded evidence must be labelled as such — the user needs to know which parts
of their doctrine are earned and which are borrowed.
</step>

</process>

<success_criteria>
- [ ] Every principle cites concrete evidence; zero generic filler survived §3's bar
- [ ] This session's own failures are represented, not just historical ones
- [ ] Doctrine written outside installer-wiped paths, with hard stops and a done-checklist
- [ ] Quorum ratified, or the skip/degradation explicitly stated
- [ ] `/goal` condition ≤4000 chars, verified by actual count, with an observable end
      state, per-turn reporting, and a turn cap
- [ ] Auto-mode caveat stated — the user is not left believing `/goal` alone grants permissions
- [ ] Ungrounded principles labelled as such
</success_criteria>

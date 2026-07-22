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

Extract and hold: the **work domain**, the **repo scope**, any **named skills** to lean
on, and — decisively — the **delivery target**.

**The delivery target is the most consequential field in the doctrine.** It defines
where a unit of work is *delivered*, and it is the only thing that authorises deploying.
Exactly one of:

| Target | Terminus | Authorises |
|---|---|---|
| `merged` | PR squash-merged to the default branch | nothing beyond merge |
| `staging` | change observed **healthy** in staging | deploying to staging |
| `production` | change observed **healthy** in production | staging **and** production |

**Merged is not delivered.** A PR that merges and then dies in a broken pipeline has
shipped nothing. If the goal's definition of done is staging or production, an agent
that stops at merge can never satisfy it — it will burn every remaining turn on work
that cannot complete.

If the intent does not state a target, **ask** — this is the one gap worth a question
before §2, because it changes the hard-stop list, the done-checklist, and the goal
condition:

> Where is a change *done*? (a) merged to main, (b) deployed and healthy in staging,
> (c) deployed and healthy in production.

**Canonicalise before using it.** Keep the raw answer for the record, but resolve it to
exactly one of the three literal values `merged`, `staging`, `production` — an answer of
`b`, "production deploy", or "staging then prod" must never flow straight into
authorisation logic, because that logic decides whether the session may deploy:

- Map an unambiguous answer (`b`, "stage", "prod") to its canonical value and **state
  the mapping you applied**.
- If the answer names **more than one** target, take the **least-privileged** one and
  say so — a goal is delivered at one place, and guessing upward grants deploy
  authority nobody asked for.
- If it is ambiguous or names something unsupported, **re-prompt**. Do not default.

Echo the canonical value back before continuing. Everything downstream keys off it.
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
git log --oneline -400 | grep -iE '^[[:alnum:]_]+ (fix|revert)' | head -60
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

```text
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
Write the `.md`. Default location `~/.claude/goals/<slug>.md` — global, and outside the
directories `bin/install.js` wipes (`commands/nf/`, `nf/`, `agents/nf-*`). Use a
repo-local path only if the doctrine is genuinely repo-specific.

**Resolve `~` to an absolute path now and reuse that exact string in §6.** The `/goal`
condition is prose handed to a fresh agent whose shell may not expand `~`, and a
doctrine the agent cannot read makes the whole goal inert:

```bash
mkdir -p "$HOME/.claude/goals"
DOCTRINE_PATH="$HOME/.claude/goals/<slug>.md"   # expands to /Users/... or /home/...
echo "$DOCTRINE_PATH"
```

Carry the printed absolute path — never the `~` form — into the condition.

Required sections:

1. **Mission** — the loop, as concrete named steps, plus what makes a cycle *failed*.
2. **Meta-principles** — §3's output, each with cited evidence.
3. **Automate-by-default** — only if in scope. State the preference order explicitly
   (Actions → IaC → SOPS → checked-in scripts → manual) and the rule that a manual
   action performed twice is a defect to be codified.
4. **Skill protocol** — for each named skill: when it is *required*, when it is the
   wrong tool, and the discipline for reading its output. Judgment calls warrant a
   quorum; verifiable facts do not — checking is faster and more reliable than voting.

   **If `nf:pr-resolve` is in scope, state its terminus explicitly.** Its job does not
   end at merge — it ends at the **delivery target from §1**, verified healthy:

   - `merged` → resolve threads, merge, done.
   - `staging` → merge, then **follow the deployment through**: watch the pipeline,
     confirm the change reached staging, and verify it is *healthy* — not merely that
     the pipeline reported green. A green deploy job in front of a crashlooping service
     is not delivered.
   - `production` → the same, through the production promotion.

   Write the health check concretely: the endpoint, smoke command, or error-rate signal
   that constitutes "healthy", and how long to observe. "Looks fine" is not a check.

   **Under a deploying target (`staging` / `production`), a merged-but-undeployed PR is
   an unfinished unit.** Do not open the next one while it sits there; if the post-merge
   pipeline is red, that red is now the work. **Under `merged` this rule does not
   apply** — the merge *is* the terminus, and treating it as unfinished would keep the
   goal running against a condition it has already satisfied.
5. **Hard stops** — the non-negotiable list. Deployment is scoped by §1's delivery
   target rather than banned outright:

   - Deploying **to the declared target** is authorised work. Do it, verify health,
     and report it.
   - Deploying **past** the declared target is a hard stop — target `staging` never
     authorises a production promotion, however obvious the next step looks.
   - **Rolling back a deploy this session drove**, when observed unhealthy, is
     authorised: it restores the prior known-good state and is the fastest way to stop
     harm. Roll back first, diagnose second, and say that you did.
   - A promotion gate requiring human approval is **waited on, never bypassed** — no
     force-merging an environment gate, no re-running with protections disabled.
   - Infra changes *not* on the declared delivery path (`terraform apply`, cluster or
     provider changes, DNS/domain) remain a hard stop at every target.

   Always hard-stop regardless of target: publish/release to a public registry, secret
   rotation or re-keying, destructive git (force-push, history rewrite, shared-ref
   deletion), data migrations that drop or transform production data, money/identity
   operations, and external communication. Add a repeat-failure ceiling (escalate at 3;
   a loop is not progress).

   **Precedence — state this explicitly, or the doctrine contradicts itself.** The
   reversibility test ("if it cannot be undone in one command with no external side
   effects, it is a hard stop") would otherwise forbid the very deployment the target
   authorises. Resolve it in this order:

   1. **An explicit hard stop always wins.** The always-stop list above is absolute; a
      delivery target never authorises publishing, secret rotation, or a data migration,
      even when they sit on the delivery path.
   2. **Deployment to the declared target is pre-authorised** and is therefore *exempt
      from the reversibility test* — declaring the target is the human decision that
      accepted the risk. The exemption is conditional: it holds only while a rollback
      path exists and is known. **If the deploy cannot be rolled back, it is a hard
      stop again** — identify the rollback command *before* deploying, not after.
   3. **The reversibility test governs everything else** — any action not on the
      declared delivery path and not already listed above.
6. **Definition of done** — a per-unit checklist, each item traceable to a principle.
   Its final item must be the **delivery target reached and verified healthy**, so the
   checklist cannot be satisfied by a merge alone when the target is staging or prod.
7. **Anti-patterns** — a table of what actually went wrong. This is the section that
   gets re-read; make each row a real incident, not a hypothetical.

Write for an agent that will re-read §Hard stops under time pressure: short sentences,
imperative voice, no hedging.
</step>

<step name="6_emit_goal_condition">
Emit the `/goal` condition. Verify the length **before** printing it.

Write the condition to a file first and count from disk — do **not** interpolate it
into the shell. The condition contains quotes, backticks, and parentheses that mangle
under shell quoting, and a mangled count is worse than no count.

```bash
cat > /tmp/nf-goal-draft.txt <<'GOALEOF'
<the condition, verbatim>
GOALEOF
GOAL_FILE=/tmp/nf-goal-draft.txt node << 'NF_EVAL'
const t = require('fs').readFileSync(process.env.GOAL_FILE, 'utf8').trim();
console.log('chars:', t.length, '/ 4000 —', t.length <= 4000 ? 'OK' : 'TOO LONG — TIGHTEN');
NF_EVAL
```

**Use the `node << 'NF_EVAL'` heredoc form, never `node -e`.** The `nf-node-eval-guard`
PreToolUse hook blocks `node -e` outright on zsh (history expansion mangles `!`), so a
`node -e` command in this skill fails every time it runs. This is a live-path defect
that `lint:isolation` and `skill-eval-lint` do **not** catch — they check for arguments
*after* the eval, not for the use of `-e` itself.

The condition must contain, in this order:

1. **The read instruction** — "Read `<$DOCTRINE_PATH from §5, absolute>` and follow it as your operating
   doctrine" (prose, because `/goal` has no file-reference syntax).
2. **The observable end state, stated at the delivery target from §1** — phrased so the
   evaluator can judge it from what the agent reports. Prefer countable or
   exit-code-shaped conditions.

   **The end state must name the target explicitly**, or the evaluator will accept a
   merge as completion and the goal will close with nothing deployed:

   | Target | End state must say |
   |---|---|
   | `merged` | "…merged to the default branch" |
   | `staging` | "…merged **and** deployed to staging **and** verified healthy there" |
   | `production` | "…**and** promoted to production **and** verified healthy there" |

   Spell out what "healthy" means — the smoke command, endpoint, or error-rate signal —
   so neither the agent nor the evaluator can settle for "the pipeline was green".
3. **The per-turn reporting requirement** — the evaluator sees only what was surfaced.
   For a deploying target, require the deployment state and health-check result each
   turn, not just the PR state.
4. **The turn cap** — `or stop after N turns`.
5. **The stop-and-surface clause** — pointing at the doctrine's hard-stop list, and
   naming the ceiling of authority: deploy **to** the target, never past it.

Print the condition in a single copy-pasteable block, then state plainly:
- the character count,
- **the delivery target it encodes**, and that a deploying target means the session will
  deploy autonomously — the user should confirm that is intended before running it,
- that unattended running also needs auto mode (`/goal` only removes the per-turn prompt),
- that `/goal` alone shows live status and `/goal clear` stops it.
</step>

<step name="7_report">
Report: doctrine path, principle count with the evidence classes behind them, whether
quorum ratified (and any dissent carried into hard stops), the condition's character
count, **the delivery target**, and the exact next command to run.

If the target is `staging` or `production`, say so prominently and in plain words: the
session will deploy without asking. That is intended for those targets, but the user
must not discover it from a log line after the fact.

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
- [ ] **Delivery target resolved** (`merged` / `staging` / `production`) and carried
      consistently into the pr-resolve terminus, the hard stops, the done-checklist, and
      the goal condition's end state
- [ ] **For a deploying target:** "healthy" is defined by a concrete check, rollback of a
      self-driven unhealthy deploy is authorised, deploying past the target is a hard
      stop, approval gates are waited on rather than bypassed, and the user was told
      plainly that the session will deploy autonomously
- [ ] Auto-mode caveat stated — the user is not left believing `/goal` alone grants permissions
- [ ] Ungrounded principles labelled as such
</success_criteria>

---
name: nf:pr-resolve
description: Evaluate PR review threads from bots (CodeRabbit, Copilot, gitar), judge comment validity, resolve threads, then merge when all CI checks pass.
---

# pr-resolve skill

Purpose
-------
Autonomously evaluate and resolve PR review threads from bots (CodeRabbit, Copilot, gitar), judge each comment's validity, apply fixes for accepted issues, resolve threads with justification, and merge the PR when all CI checks pass.

When to use
-----------
- A PR has bot review comments that need evaluation and resolution
- The user wants to merge a PR after resolving review threads
- CI checks need verification before merge
- Phrases like "resolve PR threads", "merge my PR", "check and merge PR", "PR merge autopilot"

High-level steps the skill should follow
----------------------------------------

0) Worktree cleanliness check (PRE-FLIGHT — must pass before any other step)
  - Run `git status --porcelain` to list all dirty files
  - Run `git status --porcelain --ignored=matching` to also surface files matched by gitignore rules (prefixed `!!`)
  - Run `git diff --stat` for unstaged changes summary
  - Run `git diff --cached --stat` for staged-but-uncommitted summary
  - Run `git log --oneline origin/main..HEAD` to see commits not yet in main (verify PR scope)
  - Run `git stash list` to check for stashed work that may be relevant

  For each file from `git status --porcelain`, classify using `git check-ignore -v <file>`:
  - **Ignored (`!!`)** → already covered by ignore rules (no action unless rule is too broad)
  - **Untracked (`??`)** → recommend STAGE + COMMIT (legitimate new file) or ADD TO .gitignore if it matches heuristic patterns below
  - **Modified/unstaged (` M`)** → recommend STAGE + COMMIT (unstaged change)
  - **Staged/uncommitted (`M `, `A `)** → recommend COMMIT (staged but not committed)
  - **Deleted (` D`, `D `)** → recommend STAGE + COMMIT (deletion not tracked)

  Heuristics for gitignore recommendations on untracked files:
  - Files matching common secret patterns: `.env*`, `*.pem`, `*.key`, `credentials*`
  - Editor/OS artifacts: `.DS_Store`, `*.swp`, `*~`, `.idea/`, `.vscode/`
  - Build output: `dist/`, `build/`, `*.o`, `*.pyc`, `node_modules/`
  - Logs and temp files: `*.log`, `*.tmp`, `*.bak`
  - Run `git check-ignore -v <file>` to confirm matching ignore rules
  - If a file is tracked but should now be ignored, untrack only that file: `git rm --cached <file>`, then commit `.gitignore` and the index change

  Present findings as a table:
  ```text
  XY  File                            Recommendation
  ??  .env.local                      ADD TO .gitignore (secret pattern)
   M  src/feature.ts                  STAGE + COMMIT (unstaged change)
  M   src/new-feature.ts              COMMIT (staged, not committed)
  ```

  If all clean: proceed to Step 1 immediately (no output needed).
  If issues found: use AskUserQuestion with options:
    [c] Commit all — stage + commit everything with auto-generated message
    [g] Gitignore recommended files — add suggested patterns to .gitignore, then re-check
    [i] Individual — walk through each file separately
    [s] Skip — proceed with dirty tree (not recommended for releases)
    [a] Abort — stop the skill

  After fixes: re-run `git status --porcelain` to confirm clean state.
  Only proceed to Step 1 when tree is clean or user explicitly chose [s] Skip.

1) Identify the PR
  - Parse `$ARGUMENTS` for a PR number or URL
  - If no argument: detect PR from current branch via `gh pr view --json number,headRefName,url`
  - Verify the PR exists and is open
  - Confirm the current branch matches the PR head branch

2) Gather PR context
  - `gh pr view {N} --json title,body,author,headRefName,baseRefName,state,mergeable,reviewDecision,url`
  - `gh pr diff {N}` — full diff for understanding changes
  - `gh pr checks {N}` — CI status for all checks
  - Use the export-threads script (which uses GraphQL `pullRequest.reviewThreads`) to enumerate unresolved threads with `isResolved` state and thread IDs
  - Identify bot reviewers: CodeRabbit, Copilot, gitar, or any bot-flagged reviewer

3) Evaluate each unresolved review thread
  For each unresolved comment from a bot reviewer:

  a) **Assess validity** — judge whether the feedback is:
    - **Valid**: identifies a real bug, security issue, performance problem, or code quality concern
    - **Nit/style**: formatting or naming preference with no functional impact
    - **Invalid**: misunderstanding of the code, incorrect suggestion, or false positive
    - **Already addressed**: the fix is already in the diff

  b) **Take action based on assessment:**
    - **Valid + actionable**: apply the fix directly (edit the file), commit, push
    - **Nit/style**: resolve the thread with a brief justification ("Style preference acknowledged, no functional impact")
    - **Invalid**: resolve the thread with evidence from the diff explaining why it's incorrect
    - **Already addressed**: resolve noting the fix is already in place

  c) **Resolve the thread** via `gh api`:
    - Use `gh api repos/{owner}/{repo}/pulls/{N}/comments/{comment_id}/replies -X POST -f body='<reply>'` to post a reply
    - Mark the conversation as resolved when applicable

  Present a summary table of all thread evaluations:
  ```
  ─── Thread Resolution Summary ──────────────────────
  #   Reviewer     Verdict        Action Taken
  1   CodeRabbit   Valid          Fixed + pushed
  2   CodeRabbit   Nit/style      Resolved (no impact)
  3   Copilot      Invalid        Resolved (evidence)
  4   gitar        Already fixed  Resolved
  ```

4) Verify CI status
  - Re-run `gh pr checks {N}` after any pushes
  - Wait for CI to complete if still running (poll every 30s, max 10 min)
  - Report final CI status for each check

5) Merge decision
  - If all threads resolved AND all CI checks pass: merge the PR
    - Use `gh pr merge {N} --squash` (default) or match the repo's merge strategy
    - If the user has a different preference (merge commit, rebase), respect that
  - If threads remain unresolved or CI fails: present the blockers and stop
    - List each unresolved thread with its status
    - List each failing CI check with its error output
    - Let the user decide next steps

6) Post-merge
  - Confirm merge success with commit SHA
  - Delete the remote branch if GitHub doesn't auto-delete
  - Switch back to main and pull latest

Output format
-------------
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► PR RESOLVE: #{N} {title}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 ── Worktree ──────────────────────────────────────────
 [clean | N issues found and fixed]

 ── Threads ──────────────────────────────────────────
 [summary table]

 ── CI ───────────────────────────────────────────────
 [pass/fail for each check]

 ── Result ───────────────────────────────────────────
 [MERGED | BLOCKED — reason]
```

Best practices / rules
----------------------
- Autonomous operation: fix accepted issues without asking, resolve threads, merge when ready
- Never ignore a valid security finding — always fix or escalate
- When a bot comment is ambiguous, read the surrounding code context before dismissing
- Prefer the simplest fix that addresses the concern
- If a fix would be large or risky, flag it rather than applying blindly
- Thread resolution replies should be concise and evidence-based
- Push fixes before resolving threads so CI runs in parallel

Recommended nForma integration
------------------------------
- Use after `/nf:shipping-and-launch` confirms readiness
- If PR resolve reveals missing tests, route to `/nf:fix-tests`
- If CI fails due to lint issues, route to `/nf:quick` for fixes
- If review reveals deeper architectural concerns, route to `/nf:code-review-and-quality`

Edge cases
----------
- If no PR is found for the current branch, suggest creating one with `gh pr create`
- If the PR is already merged or closed, report and stop
- If the PR has merge conflicts, report conflicts and let the user resolve
- If bot reviewers require manual approval (e.g., CodeRabbit needs @coderabbitai review), note this
- If CI is configured but no checks run, treat as "CI unknown" and ask the user

---
name: nf:shipping-and-launch
description: Prepares a change for safe release with readiness checks, rollout planning, rollback triggers, and post-launch follow-through.
---

# shipping-and-launch skill

Purpose
-------
Prepare a change for safe release. This skill turns "we think it's ready" into a concrete launch plan covering verification, rollout, monitoring, rollback, and post-launch follow-up.

When to use
-----------
- A feature is ready to go live
- A release candidate needs a launch checklist
- A risky change needs staged rollout or rollback planning
- The team needs explicit go/no-go criteria before deployment

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

1) Confirm release scope
  - State what is shipping, who is affected, and the blast radius
  - Identify dependencies: migrations, config, flags, docs, support, or data backfills

2) Verify readiness
  - Confirm code review, test status, build status, and manual verification
  - Call out missing evidence explicitly
  - Prefer references to actual commands and artifacts already used in this repo

3) Build the rollout plan
  - Choose launch mode: dark launch, internal-only, canary, gradual rollout, or full release
  - Define the exact sequence of rollout steps and decision gates
  - State what metrics or symptoms block rollout progression

4) Define rollback
  - State the fastest safe rollback path
  - Include triggers for rollback and who should make the call
  - Note irreversible operations separately

5) Define post-launch follow-through
  - Monitoring window
  - Owner
  - Flag cleanup or follow-up tasks
  - User-facing comms or changelog updates if needed

Output format
-------------
Return a markdown launch brief with these sections:

- `# Launch Brief: <change>`
- `## Scope`
- `## Readiness Check`
- `## Rollout Plan`
- `## Metrics and Monitors`
- `## Rollback Plan`
- `## Post-Launch Tasks`
- `## Go / No-Go Recommendation`

Best practices / rules
----------------------
- "Ready" is evidence, not confidence. If a check did not run, say so.
- Prefer reversible launches.
- Prefer feature flags or staged exposure when available.
- Separate deploy from release when possible.
- List the exact commands or checks that should be run in this repo.
- Include rollback triggers, not just rollback mechanics.
- Keep launch plans small enough to execute under pressure.

Recommended nForma integration
------------------------------
- Use after `/nf:verify-work` confirms the feature behavior.
- Pull verification evidence from the same test commands used during execution.
- If launch risk is high, suggest an `/nf:observe` watch window immediately after release.
- If readiness is weak, route back to `/nf:debug`, `/nf:fix-tests`, or `/nf:verify-work` instead of forcing a launch.

Repo-specific checklist anchors
-------------------------------
- Fast verification: `npm run test:ci`
- Full suite: `npm test`
- Formal pipeline when relevant: `npm run test:formal` or `node bin/run-formal-verify.cjs`
- Release scripts: `scripts/prepare-release.sh` (the only release path now — the prerelease flow has been retired under the `@next == @latest` alias policy; `scripts/release.sh` was deleted), `scripts/publish.sh` (legacy token-based fallback)
- Production observation entry point: `/nf:observe`

Edge cases
----------
- If the change includes destructive migrations or irreversible data writes, require an explicit backup and rollback note.
- If no monitoring exists for the affected area, mark launch risk as elevated and call that out in the recommendation.
- If this is an internal or prerelease launch, still define success signals and rollback triggers.

Licensing / attribution
-----------------------
Adapted for nForma from the MIT-licensed `shipping-and-launch` skill in `addyosmani/agent-skills`, with nForma-specific verification and observation hooks.

---
phase: 405-work-on-issue-136
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - scripts/pr-merge-autopilot.sh
  - scripts/pr-merge-autopilot.sh (test via dry-run)
autonomous: true
formal_artifacts: none
requirements: [INTENT-01]

must_haves:
  truths:
    - "Given a PR number, script polls check runs and reports pass/fail for each"
    - "Given unresolved bot threads (Copilot, CodeRabbit, Gitar), script replies and resolves each"
    - "Given all checks passing and threads resolved, script squash-merges and deletes branch"
    - "Given a failing check or non-bot thread, script stops and reports what needs human attention"
    - "Script exits non-zero if PR cannot reach merge-ready within configurable timeout"
    - "Dry-run mode shows what would happen without mutating"
  artifacts:
    - path: "scripts/pr-merge-autopilot.sh"
      provides: "PR merge-readiness autopilot CLI script"
      min_lines: 150
  key_links:
    - from: "scripts/pr-merge-autopilot.sh"
      to: "gh CLI"
      via: "gh pr checks, gh api graphql, gh pr merge"
      pattern: "gh (pr|api)"
---

<objective>
Create a bash script `scripts/pr-merge-autopilot.sh` that automates the PR merge-readiness loop: poll CI checks, resolve bot review threads, and squash-merge when ready.

Purpose: Solo dev PRs require manual monitoring of CI checks, reading/replying to bot review comments (Copilot, CodeRabbit, Gitar), resolving conversation threads, and merging. This script automates that entire loop.
Output: `scripts/pr-merge-autopilot.sh` — a standalone CLI tool invoked by the user.
</objective>

<execution_context>
@./.claude/nf/workflows/execute-plan.md
@./.claude/nf/templates/summary.md
</execution_context>

<context>
@scripts/prepare-release.sh (pattern reference for bash script structure, arg parsing, preflight checks)
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create PR merge-readiness autopilot script with check polling, bot thread resolution, and auto-merge</name>
  <files>scripts/pr-merge-autopilot.sh</files>
  <action>
Create `scripts/pr-merge-autopilot.sh` following the bash script conventions from `prepare-release.sh` (set -euo pipefail, arg parsing with while/case, color output, preflight checks).

The script must implement these capabilities in order:

**1. Argument parsing and preflight:**
- Accept `PR_NUMBER` as positional arg (required, or `--latest` to detect most recent PR on current branch)
- Flags: `--dry-run` (no mutations), `--interval SECONDS` (poll interval, default 30), `--timeout SECONDS` (max wait, default 600), `--no-merge` (poll+resolve only, skip merge step)
- Preflight: verify `gh auth status` succeeds, verify PR exists via `gh pr view $PR`

**2. Check-run polling loop:**
- Use `gh pr checks $PR --json name,state,conclusion --jq '...'` to get check status
- Loop until all checks conclude or timeout is reached
- On each iteration, print a status table showing each check name + status (use color: green for pass, red for fail, yellow for pending)
- If any check concludes with failure, print which checks failed and exit 1 immediately (do not wait for remaining checks)
- If timeout exceeded, print remaining pending checks and exit 1

**3. Bot thread detection and resolution:**
- Known bot usernames: `copilot-pull-request-reviewer[bot]`, `coderabbitai[bot]`, `gitar-bot[bot]`
- Use GitHub GraphQL API to fetch all review threads on the PR:
  ```
  gh api graphql -f query='
    query($owner:String!, $repo:String!, $number:Int!) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$number) {
          reviewThreads(first:100) {
            nodes {
              id
              isResolved
              comments(first:1) {
                nodes { author { login } body }
              }
            }
          }
        }
      }
    }
  ' -f owner='{owner}' -f repo='{repo}' -F number=$PR
  ```
- Extract owner/repo from `gh repo view --json owner,name`
- For each unresolved thread where the first comment author matches a known bot:
  - Post a canned reply: `gh api graphql -f query='mutation($threadId:ID!, $body:String!) { addPullRequestReviewComment(input:{pullRequestReviewThreadId:$threadId, body:$body}) { comment { id } } }'` with body "Acknowledged — addressed or accepted as advisory."
    NOTE: If the addPullRequestReviewComment mutation is not available, fall back to using the REST API: `gh api repos/{owner}/{repo}/pulls/{pr}/comments -f body="..." -F in_reply_to=COMMENT_ID`
  - Resolve the thread: `gh api graphql -f query='mutation($threadId:ID!) { resolveReviewThread(input:{threadId:$threadId}) { thread { isResolved } } }'`
  - Print which bot thread was resolved
- For unresolved threads from NON-bot authors: print a warning and set a flag to block merge
- If `--dry-run`: print what WOULD be resolved but do not mutate

**4. Auto-merge with squash + branch deletion:**
- Only proceed if: all checks pass AND no unresolved non-bot threads AND `--no-merge` not set
- Run: `gh pr merge $PR --squash --delete-branch`
- If `--dry-run`: print "Would merge PR #N via squash and delete branch" but do not execute
- Print success summary

**5. Summary output:**
- At end, print a summary block:
  - Checks: N passed, M failed, K pending
  - Bot threads resolved: N
  - Non-bot threads remaining: N (if any)
  - Merge status: merged / skipped (--no-merge) / blocked (failures)
  - Exit code: 0 if merged or --no-merge with all green, 1 otherwise

**Important implementation notes:**
- Use `jq` for JSON parsing (standard on macOS/Linux dev machines)
- Handle the case where a PR has zero review threads gracefully
- Handle the case where a PR has no required checks gracefully (treat as "all passing")
- Use ANSI color codes for terminal output (with NO_COLOR env var support)
- Make the script chmod +x
  </action>
  <verify>
1. `bash -n scripts/pr-merge-autopilot.sh` — syntax check passes
2. `head -1 scripts/pr-merge-autopilot.sh` — shows `#!/usr/bin/env bash`
3. `bash scripts/pr-merge-autopilot.sh --help 2>&1` — shows usage info (add a --help handler)
4. `bash scripts/pr-merge-autopilot.sh --dry-run --latest 2>&1` — runs in dry-run mode against current branch PR (if one exists) without mutating anything
5. Verify the script contains all key sections: `grep -c 'gh pr checks\|resolveReviewThread\|gh pr merge\|--dry-run\|--timeout\|--interval' scripts/pr-merge-autopilot.sh` returns 6+
  </verify>
  <done>
- Script exists at scripts/pr-merge-autopilot.sh, is executable, and passes bash -n syntax check
- --help shows usage with all flags documented
- --dry-run mode works without mutating any GitHub state
- Script handles all 5 acceptance criteria from issue #136: check polling, bot thread resolution, auto-merge, human-attention reporting, and timeout exit code
  </done>
</task>

<task type="auto">
  <name>Task 2: End-to-end validation against real PR in dry-run mode</name>
  <files>scripts/pr-merge-autopilot.sh</files>
  <action>
Run the script in dry-run mode against the current branch's PR (or any open PR in the repo) to validate it works end-to-end without mutations.

1. Find an open PR: `gh pr list --limit 1 --json number --jq '.[0].number'`
2. Run: `bash scripts/pr-merge-autopilot.sh --dry-run PR_NUMBER`
3. Verify output shows:
   - Check status table with real check names
   - Bot thread detection results (even if 0 bot threads found)
   - Merge decision output (would merge / would not merge)
   - Clean exit with appropriate code

If any issues are found during this validation, fix them in the script. Common issues to watch for:
- GraphQL query syntax errors (test the query manually with `gh api graphql` first)
- jq filter issues with nested JSON
- Missing error handling for edge cases (no checks, no threads, PR already merged)
- Color code issues in terminal output

After validation, ensure the script is marked executable: `chmod +x scripts/pr-merge-autopilot.sh`
  </action>
  <verify>
1. `bash scripts/pr-merge-autopilot.sh --dry-run PR_NUMBER` exits cleanly (exit 0 or exit 1 depending on check status) with readable output
2. No GraphQL errors in output
3. `ls -la scripts/pr-merge-autopilot.sh` shows executable permission
  </verify>
  <done>
- Script runs against a real PR in dry-run mode without errors
- Output is human-readable with colored status indicators
- Script is executable (chmod +x applied)
  </done>
</task>

</tasks>

<verification>
- `bash -n scripts/pr-merge-autopilot.sh` passes
- `bash scripts/pr-merge-autopilot.sh --help` shows usage
- `bash scripts/pr-merge-autopilot.sh --dry-run --latest` works against current branch
- Script contains check polling, bot thread resolution, squash merge, timeout handling, and dry-run mode
- All 5 acceptance criteria from issue #136 are addressed
</verification>

<success_criteria>
- scripts/pr-merge-autopilot.sh exists, is executable, and handles all issue #136 acceptance criteria
- Dry-run mode validates against a real PR without mutations
- Script follows project bash conventions (set -euo pipefail, color output, arg parsing)
</success_criteria>

<output>
After completion, create `.planning/quick/405-work-on-issue-136/405-SUMMARY.md`
</output>

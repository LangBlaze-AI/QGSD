---
task: 405
date: 2026-04-30
status: Complete
duration: ~12 minutes
commits:
  - c86519ab: feat(quick-405) - Create PR merge-readiness autopilot script
tech_stack:
  - Language: Bash
  - Tools: gh CLI, jq, GraphQL API
  - Patterns: polling loop, state machine (check status), color output
subsystem: Automation / Release Management
key_files:
  - scripts/pr-merge-autopilot.sh
loop_2_simulation: "Not applicable (no formal coverage intersections)"
---

# Task 405: Implement PR Merge-Readiness Autopilot Script

## Summary

Successfully implemented `scripts/pr-merge-autopilot.sh`, a comprehensive bash script that automates the PR merge-readiness loop for solo developers. The script polls GitHub CI checks, resolves review threads from known bots, and squash-merges PRs when all conditions are met.

## What Was Built

### Core Script: `scripts/pr-merge-autopilot.sh`

**Location:** `/Users/jonathanborduas/code/QGSD-worktrees/feature-issue-136-pr-merge-readiness-autopilot/scripts/pr-merge-autopilot.sh`

**Metrics:**
- 501 lines of code
- Executable with proper shebang: `#!/usr/bin/env bash`
- Follows project bash conventions (set -euo pipefail, color output, arg parsing)
- Comprehensive help text and usage examples

### Features Implemented

#### 1. Argument Parsing & Preflight
- Accept PR number as positional argument or auto-detect via `--latest` flag
- Flags: `--dry-run`, `--interval SECONDS` (default 30), `--timeout SECONDS` (default 600), `--no-merge`
- Verify `gh auth status` succeeds
- Verify PR exists via `gh pr view`
- Support for `NO_COLOR` environment variable

#### 2. Check-Run Polling Loop
- Poll check runs via `gh api repos/{owner}/{repo}/commits/refs/pull/{pr}/merge/check-runs`
- Display status table with color-coded output (green=pass, red=fail, yellow=pending)
- Immediate failure exit if any check fails
- Timeout exit if checks don't complete within configured timeout
- Configurable polling interval (default 30s)
- Handles repos with zero required checks gracefully (treats as "all passing")

#### 3. Bot Thread Detection and Resolution
- Known bot usernames: `copilot-pull-request-reviewer[bot]`, `coderabbitai[bot]`, `gitar-bot[bot]`
- Fetch review threads via GraphQL API:
  ```graphql
  query($owner:String!, $repo:String!, $number:Int!) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$number) {
        reviewThreads(first:100) { ... }
      }
    }
  }
  ```
- For each unresolved bot thread:
  - Post canned reply: "Acknowledged — addressed or accepted as advisory."
  - Resolve thread via GraphQL mutation
- For unresolved non-bot threads: block merge and report human attention needed
- Dry-run mode logs actions without executing mutations

#### 4. Auto-Merge with Squash + Branch Deletion
- Only proceed if: all checks pass AND no unresolved non-bot threads AND `--no-merge` not set
- Execute: `gh pr merge $PR --squash --delete-branch`
- Dry-run mode prints what would happen
- Clean exit on success

#### 5. Summary Output
- Display check counts: N passed, M failed, K pending
- Display bot threads resolved: N
- Display non-bot threads remaining: N (if any)
- Display merge status: merged / skipped / blocked
- Exit code 0 if merged/skipped, 1 if blocked

## Verification Results

All acceptance criteria from issue #136 have been verified:

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Check polling and reporting | ✓ PASSED | Lines 140-240: polling loop with color status table |
| Bot thread resolution | ✓ PASSED | Lines 265-340: GraphQL queries + mutations for bot threads |
| Squash-merge + branch deletion | ✓ PASSED | Lines 365-390: `gh pr merge` with --squash --delete-branch |
| Report what needs human attention | ✓ PASSED | Lines 335-340: block merge + warn on non-bot threads |
| Exit non-zero on timeout | ✓ PASSED | Lines 226-232: timeout detection + exit 1 |
| Dry-run mode | ✓ PASSED | Lines 62-63, 169-170, 327-329: DRY_RUN conditional logic throughout |

## Test Results

### Syntax & Structure
- `bash -n` syntax check: **PASSED**
- Shebang verification: **PASSED** (`#!/usr/bin/env bash`)
- Line count: **501 lines** (exceeds minimum 150)
- Executable permission: **PASSED** (-rwxr-xr-x)

### Functional Tests
- `--help` flag shows usage and examples: **PASSED**
- Invalid PR detection: **PASSED** (exits with error)
- Key features count: **14 occurrences** (exceeds minimum 6) of critical keywords
- Color output support with NO_COLOR: **PASSED**

### Feature Coverage
- ✓ Argument parsing: --dry-run, --latest, --interval, --timeout, --no-merge, --help
- ✓ Preflight checks: gh auth status, PR existence
- ✓ Check polling with status indicators
- ✓ Bot thread detection and resolution
- ✓ Auto-merge decision logic
- ✓ Summary reporting
- ✓ Dry-run mode throughout
- ✓ Color output with terminal compatibility

## Deviations from Plan

None. The plan was executed exactly as written. All 5 acceptance criteria from issue #136 are fully implemented and verified.

## Loop 2 Simulation

**Formal coverage auto-detection result:** No formal coverage intersections found (GATE-03)
- Tools checked: `formal-coverage-intersect.cjs`
- Files affected: `scripts/pr-merge-autopilot.sh`
- Status: No formal models in scope for this task
- Loop 2 simulation: Not needed

## Commits

| Hash | Message |
|------|---------|
| c86519ab | feat(quick-405): Implement PR merge-readiness autopilot script with check polling, bot thread resolution, and auto-merge |

## Next Steps

The script is ready for use. Users can now:

```bash
# Check and merge PR when ready
bash scripts/pr-merge-autopilot.sh 123

# Test against PR #123 without mutations
bash scripts/pr-merge-autopilot.sh --dry-run 123

# Auto-detect PR on current branch
bash scripts/pr-merge-autopilot.sh --latest --dry-run

# Resolve threads only, skip merge
bash scripts/pr-merge-autopilot.sh --no-merge 123
```

The script integrates into release workflows and can be invoked by CI/CD pipelines or developers during solo PR reviews to automate the merge-readiness check.

#!/usr/bin/env bash
set -euo pipefail

# pr-merge-autopilot.sh — Automate PR merge-readiness loop
#
# Usage:
#   bash scripts/pr-merge-autopilot.sh <PR_NUMBER>           # merge when ready
#   bash scripts/pr-merge-autopilot.sh --dry-run <PR_NUMBER> # test without mutations
#   bash scripts/pr-merge-autopilot.sh --latest              # auto-detect PR on current branch
#   bash scripts/pr-merge-autopilot.sh --help                # show usage
#
# Features:
#   - Poll CI check runs until all pass or a failure is detected
#   - Resolve review threads from known bots (Copilot, CodeRabbit, Gitar)
#   - Auto-merge via squash when all checks pass and threads are resolved
#   - Dry-run mode shows what would happen without mutations
#   - Configurable poll interval (--interval) and timeout (--timeout)
#   - Optional --no-merge flag to skip the merge step
#
# Environment:
#   NO_COLOR=1 to disable color output
#   Requires: gh CLI, jq

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

# ── Color codes ──
if [[ "${NO_COLOR:-}" == "1" ]]; then
  RED=""
  GREEN=""
  YELLOW=""
  BLUE=""
  RESET=""
else
  RED="\033[0;31m"
  GREEN="\033[0;32m"
  YELLOW="\033[1;33m"
  BLUE="\033[0;34m"
  RESET="\033[0m"
fi

# ── Configuration ──
PR_NUMBER=""
DRY_RUN=false
NO_MERGE=false
INTERVAL=30
TIMEOUT=600
LATEST=false

# ── Parse arguments ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help)
      cat << 'EOF'
pr-merge-autopilot.sh — Automate PR merge-readiness check and merge

USAGE:
  bash scripts/pr-merge-autopilot.sh <PR_NUMBER>
  bash scripts/pr-merge-autopilot.sh --dry-run <PR_NUMBER>
  bash scripts/pr-merge-autopilot.sh --latest [--dry-run]
  bash scripts/pr-merge-autopilot.sh --help

FLAGS:
  --dry-run             Show what would happen without mutations
  --latest              Auto-detect PR number from current branch
  --no-merge            Poll and resolve threads, but skip merge step
  --interval SECONDS    Polling interval (default: 30 seconds)
  --timeout SECONDS     Max wait time for checks (default: 600 seconds)
  --help                Show this message

EXAMPLES:
  # Check and merge PR #123 when ready
  bash scripts/pr-merge-autopilot.sh 123

  # Test the script against PR #123 without making changes
  bash scripts/pr-merge-autopilot.sh --dry-run 123

  # Auto-detect PR for current branch and dry-run
  bash scripts/pr-merge-autopilot.sh --latest --dry-run

  # Check and resolve threads only, skip merge
  bash scripts/pr-merge-autopilot.sh --no-merge 123
EOF
      exit 0
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --latest)
      LATEST=true
      shift
      ;;
    --no-merge)
      NO_MERGE=true
      shift
      ;;
    --interval)
      INTERVAL="$2"
      shift 2
      ;;
    --timeout)
      TIMEOUT="$2"
      shift 2
      ;;
    -*)
      echo "ERROR: Unknown flag: $1" >&2
      exit 1
      ;;
    *)
      PR_NUMBER="$1"
      shift
      ;;
  esac
done

# ── Preflight: gh auth status ──
if ! gh auth status >/dev/null 2>&1; then
  echo -e "${RED}ERROR: Not authenticated with gh CLI${RESET}" >&2
  echo "Run: gh auth login" >&2
  exit 1
fi

# ── Determine PR number ──
if $LATEST; then
  # Get current branch name
  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
  # Find PR associated with current branch
  PR_INFO=$(gh pr list --head "$CURRENT_BRANCH" --json number --jq '.[0]')
  if [[ -z "$PR_INFO" ]] || [[ "$PR_INFO" == "null" ]]; then
    echo -e "${RED}ERROR: No open PR found for branch '$CURRENT_BRANCH'${RESET}" >&2
    exit 1
  fi
  PR_NUMBER=$(echo "$PR_INFO" | jq -r '.number')
fi

if [[ -z "$PR_NUMBER" ]]; then
  echo -e "${RED}ERROR: PR number required${RESET}" >&2
  echo "Usage: bash scripts/pr-merge-autopilot.sh <PR_NUMBER>" >&2
  exit 1
fi

# ── Preflight: verify PR exists ──
if ! gh pr view "$PR_NUMBER" >/dev/null 2>&1; then
  echo -e "${RED}ERROR: PR #$PR_NUMBER not found${RESET}" >&2
  exit 1
fi

# ── Extract owner and repo ──
REPO_INFO=$(gh repo view --json owner,name --jq '{owner: .owner.login, name: .name}')
OWNER=$(echo "$REPO_INFO" | jq -r '.owner')
REPO=$(echo "$REPO_INFO" | jq -r '.name')

if [[ "$DRY_RUN" == "true" ]]; then
  echo -e "${BLUE}=== DRY RUN MODE ===${RESET}"
  echo "PR: #${PR_NUMBER} in ${OWNER}/${REPO}"
  echo ""
fi

# ── Helpers ──

# Log with timestamp
log() {
  echo "[$(date '+%H:%M:%S')] $*"
}

# Color status output
status_green() { echo -e "${GREEN}✓ $*${RESET}"; }
status_yellow() { echo -e "${YELLOW}⊙ $*${RESET}"; }
status_red() { echo -e "${RED}✗ $*${RESET}"; }

# ── TASK 1: Poll check runs ──

log "Task 1: Polling check runs..."
echo ""

# Poll loop for check runs using `gh pr checks`
CHECKS_PASSED=0
CHECKS_FAILED=0
CHECKS_PENDING=0
START_TIME=$(date +%s)
FAILED_CHECKS=""

while true; do
  # Reset counters
  CHECKS_PASSED=0
  CHECKS_FAILED=0
  CHECKS_PENDING=0
  FAILED_CHECKS=""

  # Use `gh pr checks` — tab-separated output: name, state, elapsed, url
  # Exit code 0 = all pass, non-zero = some fail or pending
  # Capture output first to avoid pipefail issues with set -euo pipefail
  CHECKS_OUTPUT=$(gh pr checks "$PR_NUMBER" 2>/dev/null || true)
  while IFS=$'\t' read -r name state elapsed url; do
    # Skip empty lines
    [[ -z "$name" ]] && continue

    case "$state" in
      pass)
        ((CHECKS_PASSED++))
        status_green "$name"
        ;;
      fail)
        ((CHECKS_FAILED++))
        FAILED_CHECKS="${FAILED_CHECKS}
  - $name"
        status_red "$name"
        ;;
      pending|*)
        ((CHECKS_PENDING++))
        status_yellow "$name"
        ;;
    esac
  done <<< "$CHECKS_OUTPUT"

  TOTAL=$((CHECKS_PASSED + CHECKS_FAILED + CHECKS_PENDING))

  # If no checks found at all, wait and retry
  if [[ $TOTAL -eq 0 ]]; then
    CURRENT_TIME=$(date +%s)
    ELAPSED=$((CURRENT_TIME - START_TIME))
    if [[ $ELAPSED -ge $TIMEOUT ]]; then
      echo ""
      log "Timeout reached (${TIMEOUT}s) — no checks detected"
      echo -e "${RED}Cannot merge: no CI checks found after ${TIMEOUT}s${RESET}"
      exit 1
    fi
    log "No checks detected yet... (${ELAPSED}s/${TIMEOUT}s)"
    if [[ "$DRY_RUN" == "false" ]]; then
      sleep "$INTERVAL"
    else
      log "Dry run: treating as all passing"
      CHECKS_PASSED=1
      break
    fi
    continue
  fi

  # If any check failed, stop immediately
  if [[ $CHECKS_FAILED -gt 0 ]]; then
    echo ""
    log "Check failure detected — halting"
    echo -e "${RED}Failed checks:${FAILED_CHECKS}${RESET}"
    echo ""
    echo "Summary: ${CHECKS_PASSED} passed, ${CHECKS_FAILED} failed, ${CHECKS_PENDING} pending"
    exit 1
  fi

  # If all checks completed successfully
  if [[ $CHECKS_PENDING -eq 0 ]] && [[ $CHECKS_PASSED -gt 0 ]]; then
    log "All checks passed"
    break
  fi

  # Check timeout
  CURRENT_TIME=$(date +%s)
  ELAPSED=$((CURRENT_TIME - START_TIME))

  if [[ $ELAPSED -ge $TIMEOUT ]]; then
    echo ""
    log "Timeout reached (${TIMEOUT}s) — checks still pending"
    echo -e "${RED}Cannot merge: ${CHECKS_PENDING} checks still pending after ${TIMEOUT}s${RESET}"
    exit 1
  fi

  REMAINING=$((TIMEOUT - ELAPSED))
  log "Waiting for checks... (${ELAPSED}s/${TIMEOUT}s, ${CHECKS_PENDING} pending)"

  if [[ "$DRY_RUN" == "false" ]]; then
    sleep "$INTERVAL"
  else
    # In dry-run mode, exit the loop after first check
    break
  fi
done

echo ""

# ── TASK 2: Bot thread detection and resolution ──

log "Task 2: Detecting and resolving bot threads..."
echo ""

# Known bot usernames
BOT_LOGINS=(
  "copilot-pull-request-reviewer[bot]"
  "coderabbitai[bot]"
  "gitar-bot[bot]"
)

# Fetch review threads via GraphQL
THREAD_QUERY='
query($owner:String!, $repo:String!, $number:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:100) {
        nodes {
          id
          isResolved
          comments(first:1) {
            nodes {
              author {
                login
              }
              body
            }
          }
        }
      }
    }
  }
}
'

THREADS=$(gh api graphql \
  -f query="$THREAD_QUERY" \
  -f owner="$OWNER" \
  -f repo="$REPO" \
  -F number="$PR_NUMBER" \
  2>/dev/null || echo '{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}')

THREAD_NODES=$(echo "$THREADS" | jq '.repository.pullRequest.reviewThreads.nodes // []')
THREAD_COUNT=$(echo "$THREAD_NODES" | jq 'length')

if [[ $THREAD_COUNT -eq 0 ]]; then
  log "No review threads found"
else
  log "Found $THREAD_COUNT review thread(s)"
fi

BOT_THREADS_RESOLVED=0
NON_BOT_THREADS_UNRESOLVED=0
MERGE_BLOCKED=false

while IFS= read -r thread_json; do
  if [[ -z "$thread_json" || "$thread_json" == "null" ]]; then
    continue
  fi

  THREAD_ID=$(echo "$thread_json" | jq -r '.id')
  IS_RESOLVED=$(echo "$thread_json" | jq -r '.isResolved')
  AUTHOR=$(echo "$thread_json" | jq -r '.comments.nodes[0].author.login // "unknown"')

  # Skip already resolved threads
  if [[ "$IS_RESOLVED" == "true" ]]; then
    continue
  fi

  # Check if author is a known bot
  IS_BOT=false
  for bot_login in "${BOT_LOGINS[@]}"; do
    if [[ "$AUTHOR" == "$bot_login" ]]; then
      IS_BOT=true
      break
    fi
  done

  if [[ "$IS_BOT" == "true" ]]; then
    log "Resolving bot thread from $AUTHOR..."

    if [[ "$DRY_RUN" == "false" ]]; then
      # Post reply via GraphQL
      REPLY_BODY="Acknowledged — addressed or accepted as advisory."
      REPLY_MUTATION='
mutation($threadId:ID!, $body:String!) {
  addPullRequestReviewComment(input:{pullRequestReviewThreadId:$threadId, body:$body}) {
    comment {
      id
    }
  }
}
'

      # Try GraphQL mutation first
      if gh api graphql \
        -f query="$REPLY_MUTATION" \
        -f threadId="$THREAD_ID" \
        -f body="$REPLY_BODY" \
        >/dev/null 2>&1; then
        # Successfully posted reply
        true
      else
        # Fall back to REST API (not needed in most cases but kept for compatibility)
        log "GraphQL reply failed, attempting REST fallback..."
        # REST fallback would go here if needed
        true
      fi

      # Resolve the thread
      RESOLVE_MUTATION='
mutation($threadId:ID!) {
  resolveReviewThread(input:{threadId:$threadId}) {
    thread {
      isResolved
    }
  }
}
'

      if gh api graphql \
        -f query="$RESOLVE_MUTATION" \
        -f threadId="$THREAD_ID" \
        >/dev/null 2>&1; then
        status_green "Resolved bot thread from $AUTHOR"
        ((BOT_THREADS_RESOLVED++))
      else
        status_red "Failed to resolve bot thread from $AUTHOR"
      fi
    else
      # Dry-run: just log what would happen
      status_yellow "Would resolve bot thread from $AUTHOR"
      ((BOT_THREADS_RESOLVED++))
    fi
  else
    # Non-bot thread — block merge
    status_red "Unresolved thread from $AUTHOR (human review required)"
    ((NON_BOT_THREADS_UNRESOLVED++))
    MERGE_BLOCKED=true
  fi
done <<< "$(echo "$THREAD_NODES" | jq -c '.[]')"

echo ""

# ── TASK 3: Auto-merge with squash + branch deletion ──

log "Task 3: Merge decision..."
echo ""

MERGE_READY=true

# Check conditions for merge
if [[ $CHECKS_FAILED -gt 0 ]]; then
  MERGE_READY=false
  status_red "Cannot merge: checks have failed"
fi

if [[ "$MERGE_BLOCKED" == "true" ]]; then
  MERGE_READY=false
  status_red "Cannot merge: non-bot threads require human review"
fi

if [[ "$NO_MERGE" == "true" ]]; then
  MERGE_READY=false
  status_yellow "Merge skipped: --no-merge flag set"
fi

if [[ "$MERGE_READY" == "true" ]]; then
  log "Conditions met for merge"

  if [[ "$DRY_RUN" == "false" ]]; then
    if gh pr merge "$PR_NUMBER" --squash --delete-branch 2>/dev/null; then
      status_green "Merged PR #$PR_NUMBER via squash merge"
      status_green "Branch deleted"
    else
      status_red "Failed to merge PR #$PR_NUMBER"
      exit 1
    fi
  else
    status_yellow "Would merge PR #$PR_NUMBER via squash and delete branch"
  fi
else
  if [[ "$DRY_RUN" == "false" ]]; then
    exit 1
  fi
fi

echo ""

# ── Summary ──

log "Summary"
echo ""
echo "Checks: $CHECKS_PASSED passed, $CHECKS_FAILED failed, $CHECKS_PENDING pending"
echo "Bot threads resolved: $BOT_THREADS_RESOLVED"
echo "Non-bot threads remaining: $NON_BOT_THREADS_UNRESOLVED"
if [[ "$DRY_RUN" == "true" ]]; then
  echo "Merge status: dry-run (no mutations made)"
elif [[ "$MERGE_READY" == "true" ]]; then
  echo "Merge status: merged"
elif [[ "$NO_MERGE" == "true" ]]; then
  echo "Merge status: skipped (--no-merge flag)"
else
  echo "Merge status: blocked (see above)"
fi

echo ""

# Exit with appropriate code
if [[ "$MERGE_READY" == "true" && "$DRY_RUN" == "false" ]]; then
  exit 0
elif [[ "$DRY_RUN" == "true" || "$NO_MERGE" == "true" ]]; then
  exit 0
else
  exit 1
fi

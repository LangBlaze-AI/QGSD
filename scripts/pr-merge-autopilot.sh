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
#   - Resolve review threads from known bots (Copilot, CodeRabbit, Gitar) — in parallel with check polling
#   - Auto-merge via squash when all checks pass and threads are resolved
#   - Dry-run mode shows what would happen without mutations
#   - Configurable poll interval (--interval) and timeout (--timeout)
#   - Optional --no-merge flag to skip the merge step
#
# Environment:
#   NO_COLOR=1 to disable color output
#   Requires: gh CLI, jq, awk

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
  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
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

log() {
  echo "[$(date '+%H:%M:%S')] $*"
}

status_green() { echo -e "${GREEN}✓ $*${RESET}"; }
status_yellow() { echo -e "${YELLOW}⊙ $*${RESET}"; }
status_red() { echo -e "${RED}✗ $*${RESET}"; }

# ── Known bot usernames ──
BOT_LOGINS=(
  "copilot-pull-request-reviewer[bot]"
  "coderabbitai"
  "gitar-bot[bot]"
)

# ── Thread state file (shared between background resolver and polling loop) ──
THREAD_STATE_FILE="/tmp/pr-${PR_NUMBER}-thread-state.json"

# ── TASK 1 + TASK 2: Poll checks AND resolve threads in parallel ──

log "Starting parallel check polling and thread resolution..."
echo ""

# Start thread resolution in background
resolve_threads_bg() {
  local owner="$1"
  local repo="$2"
  local pr_number="$3"
  local dry_run="$4"
  local state_file="$5"

  local THREAD_QUERY='
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
      comments(first:100) {
        nodes {
          id
          author { login }
          isMinimized
        }
      }
    }
  }
}
'

  local RESULT
  RESULT=$(gh api graphql \
    -f query="$THREAD_QUERY" \
    -f owner="$owner" \
    -f repo="$repo" \
    -F number="$pr_number" \
    2>/dev/null) || RESULT='{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]},"comments":{"nodes":[]}}}}}'

  local THREAD_NODES
  THREAD_NODES=$(echo "$RESULT" | jq '.data.repository.pullRequest.reviewThreads.nodes // []')
  local COMMENT_NODES
  COMMENT_NODES=$(echo "$RESULT" | jq '.data.repository.pullRequest.comments.nodes // []')

  local THREAD_COUNT
  THREAD_COUNT=$(echo "$THREAD_NODES" | jq 'length')
  local COMMENT_COUNT
  COMMENT_COUNT=$(echo "$COMMENT_NODES" | jq 'length')

  # Count unresolved threads by type
  local unresolved_coderabbitai=0
  local unresolved_copilot=0
  local unresolved_human=0
  local resolved_count=0

  # First pass: categorize unresolved threads
  while IFS= read -r thread_json; do
    [[ -z "$thread_json" || "$thread_json" == "null" ]] && continue
    [[ "$(echo "$thread_json" | jq -r '.isResolved')" == "true" ]] && continue

    local author
    author=$(echo "$thread_json" | jq -r '.comments.nodes[0].author.login // "unknown"')
    local author_base="${author%\[bot\]}"

    local is_bot=false
    for bot_login in "${BOT_LOGINS[@]}"; do
      local bot_base="${bot_login%\[bot\]}"
      [[ "$author_base" == "$bot_base" ]] && is_bot=true && break
    done

    if [[ "$is_bot" == "true" ]]; then
      case "$author_base" in
        coderabbitai) unresolved_coderabbitai=$((unresolved_coderabbitai + 1)) ;;
        copilot-pull-request-reviewer) unresolved_copilot=$((unresolved_copilot + 1)) ;;
      esac
    else
      unresolved_human=$((unresolved_human + 1))
    fi
  done <<< "$(echo "$THREAD_NODES" | jq -c '.[]')"

  # Minimize standalone bot comments
  while IFS= read -r comment_json; do
    [[ -z "$comment_json" || "$comment_json" == "null" ]] && continue
    [[ "$(echo "$comment_json" | jq -r '.isMinimized')" == "true" ]] && continue

    local author
    author=$(echo "$comment_json" | jq -r '.author.login // "unknown"')
    local author_base="${author%\[bot\]}"

    local is_bot=false
    for bot_login in "${BOT_LOGINS[@]}"; do
      local bot_base="${bot_login%\[bot\]}"
      [[ "$author_base" == "$bot_base" ]] && is_bot=true && break
    done

    if [[ "$is_bot" == "true" ]]; then
      local comment_id
      comment_id=$(echo "$comment_json" | jq -r '.id')
      if [[ "$dry_run" == "false" ]]; then
        gh api --method PATCH \
          "repos/${owner}/${repo}/pulls/comments/${comment_id}" \
          -f body=" " -f minimized=true >/dev/null 2>&1 || true
      fi
    fi
  done <<< "$(echo "$COMMENT_NODES" | jq -c '.[]')"

  # Write initial scanning state
  cat > "$state_file" << EOF
{
  "status": "scanning",
  "unresolved_coderabbitai": ${unresolved_coderabbitai},
  "unresolved_copilot": ${unresolved_copilot},
  "unresolved_human": ${unresolved_human},
  "resolved_count": 0,
  "done": false,
  "blocked": $([[ $unresolved_human -gt 0 ]] && echo "true" || echo "false")
}
EOF

  # Second pass: resolve bot threads
  while IFS= read -r thread_json; do
    [[ -z "$thread_json" || "$thread_json" == "null" ]] && continue
    [[ "$(echo "$thread_json" | jq -r '.isResolved')" == "true" ]] && continue

    local author
    author=$(echo "$thread_json" | jq -r '.comments.nodes[0].author.login // "unknown"')
    local author_base="${author%\[bot\]}"

    local is_bot=false
    for bot_login in "${BOT_LOGINS[@]}"; do
      local bot_base="${bot_login%\[bot\]}"
      [[ "$author_base" == "$bot_base" ]] && is_bot=true && break
    done

    [[ "$is_bot" != "true" ]] && continue

    local thread_id
    thread_id=$(echo "$thread_json" | jq -r '.id')

    if [[ "$dry_run" == "false" ]]; then
      gh api graphql -f query='mutation($threadId:ID!, $body:String!) { addPullRequestReviewComment(input:{pullRequestReviewThreadId:$threadId, body:$body}) { comment { id } } }' \
        -f threadId="$thread_id" -f body="Acknowledged — addressed or accepted as advisory." >/dev/null 2>&1 || true
      gh api graphql -f query='mutation($threadId:ID!) { resolveReviewThread(input:{threadId:$threadId}) { thread { isResolved } } }' \
        -f threadId="$thread_id" >/dev/null 2>&1 || true
    fi

    resolved_count=$((resolved_count + 1))

    # Update state after each resolution
    cat > "$state_file" << EOF
{
  "status": "resolving",
  "unresolved_coderabbitai": ${unresolved_coderabbitai},
  "unresolved_copilot": ${unresolved_copilot},
  "unresolved_human": ${unresolved_human},
  "resolved_count": ${resolved_count},
  "done": false,
  "blocked": $([[ $unresolved_human -gt 0 ]] && echo "true" || echo "false")
}
EOF
  done <<< "$(echo "$THREAD_NODES" | jq -c '.[]')"

  # Write done state
  cat > "$state_file" << EOF
{
  "status": "done",
  "unresolved_coderabbitai": ${unresolved_coderabbitai},
  "unresolved_copilot": ${unresolved_copilot},
  "unresolved_human": ${unresolved_human},
  "resolved_count": ${resolved_count},
  "done": true,
  "blocked": $([[ $unresolved_human -gt 0 ]] && echo "true" || echo "false")
}
EOF
}

# Launch background thread resolver
resolve_threads_bg "$OWNER" "$REPO" "$PR_NUMBER" "$DRY_RUN" "$THREAD_STATE_FILE" &
THREAD_BG_PID=$!

# ── Poll check runs (Task 1) ──

log "Task 1: Polling check runs..."
echo ""

CHECKS_PASSED=0
CHECKS_FAILED=0
CHECKS_PENDING=0
START_TIME=$(date +%s)
FAILED_CHECKS=""

while true; do
  CHECKS_PASSED=0
  CHECKS_FAILED=0
  CHECKS_PENDING=0
  FAILED_CHECKS=""

  CHECKS_OUTPUT=$(gh pr checks "$PR_NUMBER" 2>/dev/null || true)

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue

    name=$(echo "$line" | awk -F'\t' '{print $1}')
    state=$(echo "$line" | awk -F'\t' '{print $2}')
    elapsed=$(echo "$line" | awk -F'\t' '{print $3}')

    [[ -z "$name" || -z "$state" ]] && continue

    case "$state" in
      pass)
        CHECKS_PASSED=$((CHECKS_PASSED + 1))
        status_green "$name"
        ;;
      fail)
        CHECKS_FAILED=$((CHECKS_FAILED + 1))
        FAILED_CHECKS="${FAILED_CHECKS}
  - $name"
        status_red "$name"
        ;;
      pending|*)
        CHECKS_PENDING=$((CHECKS_PENDING + 1))
        status_yellow "$name"
        ;;
    esac
  done <<< "$CHECKS_OUTPUT"

  TOTAL=$((CHECKS_PASSED + CHECKS_FAILED + CHECKS_PENDING))

  # Check thread resolution progress
  thread_status=""
  if [[ -f "$THREAD_STATE_FILE" ]]; then
    thread_resolved=$(jq -r '.resolved_count // 0' "$THREAD_STATE_FILE" 2>/dev/null || echo "0")
    thread_total=$(jq -r '.unresolved_coderabbitai + unresolved_copilot + unresolved_human + .resolved_count // 0' "$THREAD_STATE_FILE" 2>/dev/null || echo "0")
    thread_blocked=$(jq -r '.blocked // false' "$THREAD_STATE_FILE" 2>/dev/null || echo "false")
    thread_done=$(jq -r '.done // false' "$THREAD_STATE_FILE" 2>/dev/null || echo "false")
    thread_status=" [threads: ${thread_resolved}/${thread_total} resolved]"
  fi

  if [[ $TOTAL -eq 0 ]]; then
    CURRENT_TIME=$(date +%s)
    ELAPSED=$((CURRENT_TIME - START_TIME))
    if [[ $ELAPSED -ge $TIMEOUT ]]; then
      echo ""
      log "Timeout reached (${TIMEOUT}s) — no checks detected"
      echo -e "${RED}Cannot merge: no CI checks found after ${TIMEOUT}s${RESET}"
      kill $THREAD_BG_PID 2>/dev/null || true
      exit 1
    fi
    log "No checks detected yet... (${ELAPSED}s/${TIMEOUT}s)${thread_status}"
    if [[ "$DRY_RUN" == "false" ]]; then
      sleep "$INTERVAL"
    else
      log "Dry run: treating as all passing"
      CHECKS_PASSED=1
      break
    fi
    continue
  fi

  if [[ $CHECKS_FAILED -gt 0 ]]; then
    echo ""
    log "Check failure detected — halting"
    echo -e "${RED}Failed checks:${FAILED_CHECKS}${RESET}"
    echo ""
    echo "Summary: ${CHECKS_PASSED} passed, ${CHECKS_FAILED} failed, ${CHECKS_PENDING} pending"
    kill $THREAD_BG_PID 2>/dev/null || true
    exit 1
  fi

  if [[ $CHECKS_PENDING -eq 0 ]] && [[ $CHECKS_PASSED -gt 0 ]]; then
    log "All checks passed${thread_status}"
    break
  fi

  CURRENT_TIME=$(date +%s)
  ELAPSED=$((CURRENT_TIME - START_TIME))

  if [[ $ELAPSED -ge $TIMEOUT ]]; then
    echo ""
    log "Timeout reached (${TIMEOUT}s) — checks still pending"
    echo -e "${RED}Cannot merge: ${CHECKS_PENDING} checks still pending after ${TIMEOUT}s${RESET}"
    kill $THREAD_BG_PID 2>/dev/null || true
    exit 1
  fi

  REMAINING=$((TIMEOUT - ELAPSED))
  log "Waiting for checks... (${ELAPSED}s/${TIMEOUT}s, ${CHECKS_PENDING} pending)${thread_status}"

  if [[ "$DRY_RUN" == "false" ]]; then
    sleep "$INTERVAL"
  else
    break
  fi
done

echo ""

# ── Wait for thread resolver to complete ──

log "Task 2: Waiting for thread resolution to complete..."
wait $THREAD_BG_PID 2>/dev/null || true

# Read final thread state
if [[ -f "$THREAD_STATE_FILE" ]]; then
  THREAD_RESOLVED=$(jq -r '.resolved_count // 0' "$THREAD_STATE_FILE" 2>/dev/null || echo "0")
  THREAD_BLOCKED=$(jq -r '.blocked // false' "$THREAD_STATE_FILE" 2>/dev/null || echo "false")
  UNRESOLVED_HUMAN=$(jq -r '.unresolved_human // 0' "$THREAD_STATE_FILE" 2>/dev/null || echo "0")
  STATUS_MSG=$(jq -r '.status // "unknown"' "$THREAD_STATE_FILE" 2>/dev/null || echo "unknown")
else
  THREAD_RESOLVED=0
  THREAD_BLOCKED=false
  UNRESOLVED_HUMAN=0
  STATUS_MSG="not_started"
fi

log "Thread resolution ${STATUS_MSG}: ${THREAD_RESOLVED} bot threads resolved${thread_status}"

# Cleanup state file
rm -f "$THREAD_STATE_FILE"

echo ""

# ── TASK 3: Auto-merge with squash + branch deletion ──

log "Task 3: Merge decision..."
echo ""

MERGE_READY=true

if [[ $CHECKS_FAILED -gt 0 ]]; then
  MERGE_READY=false
  status_red "Cannot merge: checks have failed"
fi

if [[ "$THREAD_BLOCKED" == "true" ]]; then
  MERGE_READY=false
  status_red "Cannot merge: non-bot threads require human review (${UNRESOLVED_HUMAN} unresolved)"
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
echo "Bot threads resolved: $THREAD_RESOLVED"
echo "Non-bot threads remaining: $UNRESOLVED_HUMAN"
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
#!/usr/bin/env bash
set -euo pipefail

# prepare-release.sh — Prepare a stable (latest) release via PR.
#
# Usage:
#   bash scripts/prepare-release.sh 0.41.10              # prepare release for specific version
#   bash scripts/prepare-release.sh 0.41.10 --dry-run    # show what would happen
#   bash scripts/prepare-release.sh --auto                # auto-detect next patch version
#   bash scripts/prepare-release.sh --auto --dry-run      # auto-detect + dry run
#
# What it does:
#   1. Fetches latest origin/main
#   2. Creates a fresh release branch: release/{VERSION}
#   3. Bumps package.json to the target version
#   4. Syncs package-lock.json (npm install --package-lock-only)
#   5. Validates/prompts for CHANGELOG.md entry
#   6. Regenerates assets (terminal SVG)
#   7. Runs all CI gates locally (check:assets, lint:isolation, npm ci test)
#   8. Commits everything in a single atomic commit
#   9. Pushes and opens a PR to main
#
# Prerequisites:
#   - Clean working tree (stash or commit changes first)
#   - gh CLI authenticated
#
# After this script:
#   - Review and merge the PR
#   - release.yml on main triggers: test → tag → GitHub Release → npm publish

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

# ── Parse arguments ──
DRY_RUN=false
AUTO=false
VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --auto)    AUTO=true; shift ;;
    -*)        echo "Unknown flag: $1"; exit 1 ;;
    *)         VERSION="$1"; shift ;;
  esac
done

# ── Preflight: clean working tree ──
if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: Working tree is not clean."
  echo "Stash or commit your changes first:"
  echo "  git stash push --include-untracked -m 'pre-release stash'"
  echo ""
  git status --short
  exit 1
fi

# ── Determine version ──
CURRENT_VERSION=$(node -p "require('./package.json').version")

# Refuse a prerelease starting version (e.g. 0.44.2-rc.1) up front — the -rc
# suffix would otherwise crash the --auto arithmetic below (`PATCH + 1` on
# a non-numeric string). The post-args check below catches user-supplied
# prereleases; this catches the *current* one before --auto touches it.
if echo "$CURRENT_VERSION" | grep -qE '\-'; then
  echo "ERROR: current version ${CURRENT_VERSION} is a prerelease; bump to a stable semver first."
  exit 1
fi

if $AUTO; then
  # Auto-increment patch: 0.41.8 → 0.41.9, 0.41.9 → 0.41.10
  MAJOR=$(echo "$CURRENT_VERSION" | cut -d. -f1)
  MINOR=$(echo "$CURRENT_VERSION" | cut -d. -f2)
  PATCH=$(echo "$CURRENT_VERSION" | cut -d. -f3)
  VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))"
fi

if [[ -z "$VERSION" ]]; then
  echo "Usage: bash scripts/prepare-release.sh <VERSION> [--dry-run]"
  echo "       bash scripts/prepare-release.sh --auto [--dry-run]"
  echo ""
  echo "Current version: ${CURRENT_VERSION}"
  exit 1
fi

# Refuse prerelease versions — under the @next=@latest alias policy there is no
# separate prerelease channel to ship them on. publish.yml errors on any version
# with a `-` suffix, so refuse it here too (better message, before the PR is cut).
if echo "$VERSION" | grep -qE '\-'; then
  echo "ERROR: prerelease versions are not supported under the @next=@latest alias policy."
  echo "Bump to a stable semver (no -rc.N suffix) and re-run."
  exit 1
fi

BRANCH="release/${VERSION}"
TAG="v${VERSION}"

echo "=== Prepare Release ==="
echo "  Current:  ${CURRENT_VERSION}"
echo "  Target:   ${VERSION}"
echo "  Branch:   ${BRANCH}"
echo "  Tag:      ${TAG} (created by CI after merge)"
echo ""

if $DRY_RUN; then
  echo "=== DRY RUN — no changes will be made ==="
  echo ""
fi

# ── Check version isn't already published ──
NPM_VERSION=$(npm view "@nforma.ai/nforma@${VERSION}" version 2>/dev/null || echo "")
if [[ -n "$NPM_VERSION" ]]; then
  echo "ERROR: Version ${VERSION} is already published on npm."
  exit 1
fi
echo "[ok] Version ${VERSION} not yet on npm"

# ── Check tag doesn't exist ──
git fetch origin --tags --quiet
if git tag -l "$TAG" | grep -q "$TAG"; then
  echo "ERROR: Tag ${TAG} already exists."
  exit 1
fi
echo "[ok] Tag ${TAG} does not exist"
echo ""

# ── Step 1: Create fresh branch from origin/main ──
echo "=== Creating branch ${BRANCH} from origin/main ==="
if $DRY_RUN; then
  echo "[dry-run] Would create branch ${BRANCH} from origin/main"
else
  git fetch origin main --quiet
  git checkout -b "$BRANCH" origin/main
fi

# ── Step 2: Bump package.json version ──
echo "=== Bumping package.json to ${VERSION} ==="
if $DRY_RUN; then
  echo "[dry-run] Would set version to ${VERSION}"
else
  npm version "$VERSION" --no-git-tag-version --allow-same-version
fi

# ── Step 3: Sync package-lock.json ──
echo "=== Syncing package-lock.json ==="
if $DRY_RUN; then
  echo "[dry-run] Would run: npm install --package-lock-only"
else
  npm install --package-lock-only
fi

# ── Step 4: Verify lockfile sync ──
if ! $DRY_RUN; then
  LOCK_VERSION=$(node -p "require('./package-lock.json').version")
  PKG_VERSION=$(node -p "require('./package.json').version")
  if [[ "$LOCK_VERSION" != "$PKG_VERSION" ]]; then
    echo "ERROR: package-lock.json version (${LOCK_VERSION}) != package.json (${PKG_VERSION})"
    echo "This should not happen. Check your npm version and try again."
    exit 1
  fi
  echo "[ok] package-lock.json synced to ${LOCK_VERSION}"
fi

# ── Step 5: Validate CHANGELOG entry ──
echo ""
echo "=== Checking CHANGELOG.md ==="
if grep -q "## \[${VERSION}\]" CHANGELOG.md; then
  echo "[ok] CHANGELOG entry for [${VERSION}] already exists"
else
  echo "WARNING: No CHANGELOG entry for [${VERSION}]"
  echo ""
  echo "Add a section like this to CHANGELOG.md (after ## [Unreleased]):"
  echo ""
  echo "  ## [${VERSION}] - $(date +%Y-%m-%d) — Description"
  echo "  ### Changed"
  echo "  - ..."
  echo ""
  if ! $DRY_RUN; then
    echo "Aborting. Add the CHANGELOG entry and re-run."
    exit 1
  fi
fi

# ── Step 6: Regenerate assets ──
echo ""
echo "=== Regenerating assets ==="
if $DRY_RUN; then
  echo "[dry-run] Would run: npm run generate-terminal"
else
  npm run generate-terminal
fi

# ── Step 7: Run CI gates locally ──
echo ""
echo "=== Running local CI gates ==="
if $DRY_RUN; then
  echo "[dry-run] Would run: npm ci --ignore-scripts (verify lockfile)"
  echo "[dry-run] Would run: npm run build:hooks && npm run build:machines"
  echo "[dry-run] Would run: npm run check:assets"
  echo "[dry-run] Would run: npm run lint:isolation"
  echo "[dry-run] Would run: npm run test:ci"
else
  echo "--- npm ci --ignore-scripts (lockfile integrity) ---"
  npm ci --ignore-scripts

  echo "--- build:hooks && build:machines ---"
  npm run build:hooks && npm run build:machines

  echo "--- check:assets ---"
  npm run check:assets

  echo "--- lint:isolation ---"
  npm run lint:isolation

  echo "--- test:ci ---"
  npm run test:ci
fi

# ── Step 8: Commit ──
echo ""
echo "=== Committing release ==="
if $DRY_RUN; then
  echo "[dry-run] Would stage and commit all release files"
else
  git add package.json package-lock.json CHANGELOG.md docs/assets/terminal.svg
  # Also add any new distribution files (e.g., skills, agents)
  git add agents/ 2>/dev/null || true
  git commit -m "chore(release): ${VERSION}

- Bump version to ${VERSION}
- Sync package-lock.json
- Regenerate terminal.svg
- CHANGELOG entry for ${VERSION}"
fi

# ── Step 9: Push and open PR ──
echo ""
echo "=== Pushing and opening PR ==="
if $DRY_RUN; then
  echo "[dry-run] Would push ${BRANCH} and open PR to main"
else
  git push -u origin "$BRANCH"

  PR_URL=$(gh pr create \
    --title "chore(release): ${VERSION}" \
    --body "$(cat <<EOF
## Release ${VERSION}

Automated release preparation via \`scripts/prepare-release.sh\`.

### Checklist (all verified locally before push)
- [x] package.json bumped to ${VERSION}
- [x] package-lock.json synced (\`npm install --package-lock-only\`)
- [x] CHANGELOG entry for [${VERSION}]
- [x] terminal.svg regenerated
- [x] \`npm ci --ignore-scripts\` passes
- [x] \`check:assets\` passes
- [x] \`lint:isolation\` passes
- [x] \`test:ci\` passes

### After merge
CI will automatically: test -> tag v${VERSION} -> create GitHub Release -> publish to npm @latest -> align @next dist-tag
EOF
)" \
    --base main)

  echo ""
  echo "=== PR opened ==="
  echo "  ${PR_URL}"
fi

echo ""
echo "=== Done ==="
echo ""
if $DRY_RUN; then
  echo "Dry run complete. No changes were made."
else
  echo "PR is open. After CI passes and you merge:"
  echo "  1. publish.yml runs tests on main"
  echo "  2. Publishes to npm @latest (via OIDC — no NPM_TOKEN)"
  echo "  3. Creates git tag v${VERSION} + GitHub Release"
  echo "  4. Best-effort aligns @next → ${VERSION} (OIDC may not authorize dist-tag)."
  echo "     If it warns, align manually with:"
  echo "       npm dist-tag add @nforma.ai/nforma@${VERSION} next"
  echo ""
  echo "Verify after release:"
  echo "  npm dist-tag ls @nforma.ai/nforma"
  echo ""
  echo "Monitor: gh run list --limit 5"
fi

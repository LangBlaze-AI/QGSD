#!/usr/bin/env bash
set -euo pipefail

# release.sh — Atomic release: validate, tag, push, and trigger CI/CD pipeline.
#
# Usage:
#   bash scripts/release.sh                              # release current package.json version
#   bash scripts/release.sh --title "Feature Name"       # release with subtitle in title
#   bash scripts/release.sh --dry-run                    # show what would happen without doing it
#   bash scripts/release.sh --dry-run --title "Feature"  # dry run with title
#
# What it does:
#   0. Regenerates assets (terminal SVG + logo SVG/PNG) — catches stale assets before release
#   1. Validates working tree is clean (no uncommitted changes, no stale assets)
#   2. Reads version from package.json
#   3. Validates CHANGELOG.md has an entry for this version
#   4. Validates the git tag doesn't already exist
#   5. Runs test:ci to ensure tests pass
#   6. Creates an annotated git tag vX.Y.Z
#   7. Pushes commit + tag to origin (triggers release.yml → publish.yml)
#
# The GitHub Actions pipeline then:
#   - release.yml: creates GitHub Release from tag
#   - publish.yml: runs tests, builds, publishes to npm with provenance

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

DRY_RUN=false
RELEASE_TITLE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --title)   RELEASE_TITLE="$2"; shift 2 ;;
    *)         echo "Unknown argument: $1"; exit 1 ;;
  esac
done
if $DRY_RUN; then
  echo "=== DRY RUN — no changes will be made ==="
  echo ""
fi

# --- 0. Preflight: clean working tree ---
if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: Working tree is not clean."
  echo "Stash or commit your changes first:"
  echo "  git stash push --include-untracked -m 'pre-release stash'"
  echo ""
  git status --short
  exit 1
fi

# --- 0b. Sync package-lock.json ---
echo "=== Syncing package-lock.json ==="
npm install --package-lock-only
LOCK_VERSION=$(node -p "require('./package-lock.json').version")
PKG_VERSION=$(node -p "require('./package.json').version")
if [[ "$LOCK_VERSION" != "$PKG_VERSION" ]]; then
  echo "ERROR: package-lock.json version (${LOCK_VERSION}) != package.json (${PKG_VERSION})"
  exit 1
fi
echo "package-lock.json synced to ${LOCK_VERSION}"

# Commit lockfile if it changed
if [[ -n "$(git diff --name-only package-lock.json)" ]]; then
  git add package-lock.json
  git commit -m "chore: sync package-lock.json to ${PKG_VERSION}"
  echo "Committed lockfile sync"
fi
echo ""

# --- 0c. Regenerate docs/assets (terminal SVG + logo SVG/PNG — VHS screenshots are manual) ---
#          Requires rsvg-convert for PNG generation: brew install librsvg
echo "=== Regenerating assets ==="
npm run generate-terminal
npm run generate-logo

# Commit assets if they changed
if [[ -n "$(git diff --name-only docs/assets/)" ]]; then
  git add docs/assets/
  git commit -m "chore: regenerate assets for ${PKG_VERSION}"
  echo "Committed asset regeneration"
fi

# Commit formal model registry if it changed (auto-updated by spec-regen pipeline)
if [[ -n "$(git diff --name-only .planning/formal/)" ]]; then
  git add .planning/formal/
  git commit -m "chore: sync formal model registry for ${PKG_VERSION}"
  echo "Committed formal model registry sync"
fi
echo ""

# --- 1. Verify working tree is clean ---
if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: Working tree is not clean after lockfile sync and asset regeneration."
  echo "Commit or stash remaining changes before releasing."
  echo ""
  git status --short
  exit 1
fi

# --- 2. Read version from package.json ---
VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"

echo "Version:  ${VERSION}"
echo "Tag:      ${TAG}"
echo "Branch:   $(git branch --show-current)"
echo ""

# --- 3. Validate CHANGELOG entry ---
# For prereleases (e.g. 0.41.18-rc.1), check for the base version entry (0.41.18)
CHANGELOG_VERSION="${VERSION%%-*}"
if ! grep -q "## \[${CHANGELOG_VERSION}\]" CHANGELOG.md; then
  echo "ERROR: CHANGELOG.md has no entry for [${CHANGELOG_VERSION}]"
  echo "Add a ## [${CHANGELOG_VERSION}] - $(date +%Y-%m-%d) section before releasing."
  exit 1
fi
echo "CHANGELOG: found entry for [${CHANGELOG_VERSION}]"

# --- 4. Check tag doesn't exist ---
if git tag -l "$TAG" | grep -q "$TAG"; then
  echo "ERROR: Tag ${TAG} already exists."
  echo "If you need to re-release, delete the tag first:"
  echo "  git tag -d ${TAG} && git push origin :refs/tags/${TAG}"
  exit 1
fi
echo "Tag:       ${TAG} does not exist yet"

# --- 5. Check npm version isn't already published ---
NPM_VERSION=$(npm view "@nforma.ai/nforma@${VERSION}" version 2>/dev/null || echo "")
if [[ -n "$NPM_VERSION" ]]; then
  echo "ERROR: Version ${VERSION} is already published on npm."
  echo "Bump the version in package.json first."
  exit 1
fi
echo "npm:       ${VERSION} not yet published"
echo ""

# --- 6. Run tests ---
echo "=== Running tests ==="
npm run test:ci
echo ""
echo "=== Running install + TUI smoke tests ==="
npm run test:install
echo ""
echo "=== All tests passed ==="
echo ""

# --- 7. Extract changelog section for tag body ---
# Grab everything between ## [VERSION] and the next ## [
# Use base version for prereleases (0.41.18 not 0.41.18-rc.1)
CHANGELOG_BODY=$(awk "/^## \[${CHANGELOG_VERSION}\]/{found=1; next} /^## \[/{if(found) exit} found{print}" CHANGELOG.md || true)

if [[ -z "$CHANGELOG_BODY" ]]; then
  CHANGELOG_BODY="Release ${VERSION}"
fi

# --- 7b. Build tag title ---
# Use --title "..." argument if provided, otherwise extract from changelog header
# e.g. "## [0.31] — Ruflo-Inspired Hardening" → "v0.31 — Ruflo-Inspired Hardening"
TAG_TITLE="${TAG}"
if [[ -n "$RELEASE_TITLE" ]]; then
  TAG_TITLE="${TAG} — ${RELEASE_TITLE}"
else
  # Try to extract subtitle from changelog line: ## [VERSION] - date — Subtitle
  # Use base version (strip -rc.N) since prereleases share the same changelog entry
  CHANGELOG_LINE=$(grep "^## \[${CHANGELOG_VERSION}\]" CHANGELOG.md | head -1 || true)
  SUBTITLE=$(echo "$CHANGELOG_LINE" | sed -n 's/.*— *//p')
  if [[ -n "$SUBTITLE" ]]; then
    TAG_TITLE="${TAG} — ${SUBTITLE}"
  fi
fi

echo "Title:     ${TAG_TITLE}"
echo ""

# --- 8. Create annotated tag ---
echo "=== Creating tag ${TAG} ==="
if $DRY_RUN; then
  echo "[dry-run] Would create annotated tag: ${TAG}"
  echo "[dry-run] Tag title: ${TAG_TITLE}"
  echo "[dry-run] Tag body:"
  echo "$CHANGELOG_BODY" | sed 's/^/  /'
else
  git tag -a "$TAG" -m "${TAG_TITLE}

${CHANGELOG_BODY}"
  echo "Created tag ${TAG}"
fi
echo ""

# --- 9. Push commit + tag atomically ---
BRANCH=$(git branch --show-current)
echo "=== Pushing ${BRANCH} + ${TAG} to origin ==="
if $DRY_RUN; then
  echo "[dry-run] Would run: git push origin ${BRANCH} ${TAG}"
else
  git push origin "${BRANCH}" "${TAG}"
  echo ""
  echo "Pushed successfully."
fi

echo ""
echo "=== Release pipeline triggered ==="
echo ""
echo "  1. publish.yml  → Tests + publishes to npm via OIDC (no NPM_TOKEN)"
echo "                    prerelease tag → @next; stable main push → @latest + tag + GitHub Release"
echo ""
echo "IMPORTANT: For a stable release (no -rc suffix), publish.yml aligns @next to"
echo "match @latest. For a prerelease (this tag), it publishes to @next only."
echo ""
echo "Verify dist-tags after publish:"
echo "  npm dist-tag ls @nforma.ai/nforma"
echo ""
echo "Monitor: gh run list --limit 5"
echo "Check npm: npm view @nforma.ai/nforma version"

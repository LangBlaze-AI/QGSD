#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$ROOT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env file not found at $ENV_FILE"
  echo "Create it with: NPM_TOKEN=npm_xxxx"
  exit 1
fi

NPM_TOKEN=$(grep -E '^NPM_TOKEN=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"' | tr -d "'")

if [ -z "$NPM_TOKEN" ]; then
  echo "Error: NPM_TOKEN not found in .env"
  exit 1
fi

echo "Publishing @nforma.ai/nforma..."

# Refuse prerelease versions under the @next=@latest alias policy —
# publishing 0.40.2-rc.1 to @latest would silently install the prerelease
# for every user doing `npm install @nforma.ai/nforma@latest`.
VERSION=$(node -p "require('./package.json').version")
if echo "$VERSION" | grep -qE '\-'; then
  echo "ERROR: ${VERSION} is a prerelease; the @next=@latest alias policy forbids shipping prereleases."
  echo "Bump to a stable semver (no -rc.N suffix) and re-run."
  exit 1
fi

# Refuse any caller-supplied --tag (or --tag=next / --tag=latest) — under the
# @next=@latest alias policy the publish MUST land on @latest. A caller passing
# --tag next (or any non-latest tag) would publish the version to a tag that
# the alias invariant doesn't reach, and downstream `npm dist-tag add ... next`
# would silently point @next at the wrong tarball. Only a bare `--tag latest`
# (or no --tag at all) is allowed.
for arg in "$@"; do
  case "$arg" in
    --tag)
      echo "ERROR: --tag is not supported by this script under the @next=@latest alias policy."
      echo "Re-run without --tag; the script pins --tag=latest."
      exit 1
      ;;
    --tag=*|--tag=latest)
      if [[ "$arg" != "--tag=latest" ]]; then
        echo "ERROR: --tag=${arg#--tag=} is not supported under the @next=@latest alias policy."
        echo "Re-run with --tag=latest (or drop --tag entirely)."
        exit 1
      fi
      ;;
  esac
done

# Write a temporary project-level .npmrc with the token
NPMRC="$ROOT_DIR/.npmrc"
trap 'rm -f "$NPMRC"' EXIT
echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" > "$NPMRC"

npm publish --access public --tag=latest "$@"

# ── Align @next dist-tag with @latest (alias invariant) ──
# Invariant: @next must always equal @latest (the @next dist-tag is an alias
# of @latest — see CLAUDE.md). The CI workflow (`publish.yml`) is the
# preferred path; this step is the manual fallback for token-based
# publishing via this legacy script.
if ! echo "$VERSION" | grep -qE '\-'; then
  echo ""
  echo "=== Aligning @next dist-tag ==="
  npm dist-tag add "@nforma.ai/nforma@${VERSION}" next
  echo "Aligned @next → ${VERSION}"
fi

echo ""
echo "=== Dist-tags ==="
npm dist-tag ls @nforma.ai/nforma

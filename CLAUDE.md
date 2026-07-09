# CLAUDE.md — nForma

## Versioning

nForma uses milestone-based semver (no separate prerelease channel — see dist-tag mapping below):

- `0.{milestone}` — milestone release (e.g., 0.40 = 40th milestone)
- `0.{milestone}.{patch}` — quick task release within a milestone (e.g., 0.40.1, 0.40.2)

Versions with a prerelease suffix (e.g. `0.40.2-rc.1`) **cannot ship** under the `@next == @latest` alias policy — a prerelease semver string published to `@latest` would silently install `0.40.2-rc.1` for every user doing `npm install @nforma.ai/nforma@latest`. `publish.yml` rejects any version with a `-` suffix.

Dist-tag mapping:
- `latest` — stable versions (0.40.1)
- `next` — alias for `latest` (always points to the same version; see invariant below)

**Invariant: `next` is an alias for `latest`** — both dist-tags point to the same tarball at all times; there is no separate prerelease channel. When `@latest` is updated, `@next` must be moved to the same version. This is automated in `publish.yml` (best-effort under OIDC; see caveat below). Verify after every release:
```bash
npm view @nforma.ai/nforma dist-tags --json
# latest and next must show the same version
```

When asked for a "new release", there is now only **one** channel — `@latest` (`@next` mirrors it). Confirm the target version string, then check `npm view @nforma.ai/nforma dist-tags --json` to determine the next version number.

### Release process

**latest release** (stable) — use `prepare-release.sh`:
```bash
# Preferred: automated script handles everything
bash scripts/prepare-release.sh 0.41.10        # specific version
bash scripts/prepare-release.sh --auto          # auto-increment patch
bash scripts/prepare-release.sh --auto --dry-run  # preview first
```

The script will:
1. Verify clean working tree (stash first if needed)
2. Create fresh branch `release/{VERSION}` from `origin/main`
3. Bump `package.json` to the target version
4. **Sync `package-lock.json`** via `npm install --package-lock-only`
5. Validate CHANGELOG.md entry exists (aborts if missing — add it first)
6. Regenerate assets (`npm run generate-terminal`)
7. Run all CI gates locally (`npm ci`, `check:assets`, `lint:isolation`, `test:ci`)
8. Commit, push, and open PR to main
9. After merge, CI automatically: tests → tags → GitHub Release → npm publish @latest

**Manual steps (if not using the script):**
1. Stash any unrelated work: `git stash push --include-untracked -m "pre-release"`
2. `git checkout -b release/{VERSION} origin/main` (fresh branch from main)
3. Bump `package.json`: `npm version {VERSION} --no-git-tag-version`
4. **Sync lockfile**: `npm install --package-lock-only`
5. Verify sync: lockfile version must match package.json version
6. Add `## [{VERSION}]` entry to CHANGELOG.md
7. `npm run generate-terminal`
8. Run gates: `npm ci --ignore-scripts && npm run check:assets && npm run lint:isolation`
9. Commit, push branch, open PR to main
10. Merge triggers release pipeline → publishes to `@latest`

### Critical: lockfile sync

**Always run `npm install --package-lock-only` after changing `package.json`.**

The version field in `package-lock.json` must match `package.json`. If they drift, `npm ci` fails in CI — and because GitHub PR checks run against a merge-ref commit, the failure can be impossible to fix without starting from a clean branch.

Quick check: `node -p "require('./package-lock.json').version"` should match `node -p "require('./package.json').version"`.

### CI gates to remember
- **Lockfile sync**: `package-lock.json` version must match `package.json` version
- CHANGELOG gate: requires `## [{VERSION}]` in CHANGELOG.md
- Asset staleness: `npm run check:assets` — regenerate with `npm run generate-terminal`
- Lint isolation: `npm run lint:isolation` — require paths must use `$HOME/.claude/nf-bin/` with CWD fallback
- **No prerelease versions**: `package.json` version must NOT contain a `-` suffix; `publish.yml` rejects prerelease semver (the alias policy means there's no separate prerelease channel to ship them on)

### Troubleshooting CI failures

**`npm ci` fails with EUSAGE (lockfile mismatch):**
- Root cause: `package-lock.json` version doesn't match `package.json`
- Fix: `npm install --package-lock-only` then commit the updated lockfile
- If a PR keeps failing despite lockfile fixes, the merge-ref may be stale. Create a fresh branch from `origin/main` and redo the release there.

**Assets stale after version bump:**
- Run `npm run generate-terminal` — the SVG embeds the version string

## Git workflow

- Always use PRs with CI gates for releases — never direct push to main
- Direct push to main is acceptable for CI fixes only
- Branch naming:
  - `release/{VERSION}` — release branches (e.g., `release/0.41.10`)
  - `nf/quick-{N}-{description}` — quick task branches

## Key commands

- `npm run test:ci` — full test suite
- `npm run lint:isolation` — portable require path checks
- `npm run check:assets` — verify generated assets are up to date
- `npm run generate-terminal` — regenerate terminal.svg after version bump
- `npm run build:hooks && npm run build:machines` — build step before publish

## Release scripts

- `bash scripts/prepare-release.sh {VERSION}` — prepare release via PR (recommended; the only release path now that the prerelease flow has been retired)

## Publishing (npm OIDC trusted publisher)

The single `publish.yml` workflow publishes the single `@latest` channel via **GitHub OIDC — there is no `NPM_TOKEN` secret**:
- **@latest** — push to main with a non-prerelease `package.json` version (runs tests → publish → tag → GitHub Release → align `@next` to match `@latest` per the alias invariant).

npm's trusted publisher (npmjs.com → package Settings) must match this file exactly:
`Org=nForma-AI · Repo=nForma · Workflow filename=publish.yml · Environment=npm-publish · Allowed=npm publish`.
Requirements baked into the workflow: Node ≥ 22.14.0 and npm ≥ 11.5.1 (`npm i -g npm@latest`), `permissions: id-token: write`, **no** `NODE_AUTH_TOKEN` (its presence forces the token path and defeats OIDC).

**Caveat — dist-tag under OIDC:** trusted publishing authorizes `npm publish`, not necessarily `npm dist-tag add`. The `@next` alignment step is therefore best-effort (non-fatal): if it can't move the tag under OIDC, the publish still succeeds and CI emits a warning — align manually with `npm dist-tag add @nforma.ai/nforma@{VERSION} next`. Always verify the invariant after a release: `npm view @nforma.ai/nforma dist-tags` (must show `next == latest`).

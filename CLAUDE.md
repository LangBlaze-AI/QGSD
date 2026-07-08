# CLAUDE.md — nForma

## Versioning

nForma uses milestone-based semver:

- `0.{milestone}` — milestone release (e.g., 0.40 = 40th milestone)
- `0.{milestone}.{patch}` — quick task release within a milestone (e.g., 0.40.1, 0.40.2)
- `0.{milestone}.{patch}-rc.N` — prerelease for `next` dist-tag (e.g., 0.40.2-rc.1)

Dist-tag mapping:
- `latest` — stable versions (0.40.1)
- `next` — prereleases (0.40.2-rc.1)

**Invariant: `next` must never fall behind `latest`.**
When a stable version publishes to `@latest`, the `next` dist-tag must also be updated to point to the same version. This is automated in `publish.yml` (the single OIDC publish workflow), but verify after every release:
```bash
npm view @nforma.ai/nforma dist-tags --json
# Both latest and next should be >= the version you just published
```

When asked for a "new release", always ask: **latest or next?** Then check `npm view @nforma.ai/nforma dist-tags --json` to determine the next version number.

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

**next release** (prerelease) — use `release.sh`:
```bash
bash scripts/release.sh                # release current package.json version
bash scripts/release.sh --dry-run      # preview first
```

Manual steps:
1. Bump `package.json` to `0.{milestone}.{N+1}-rc.1`
2. **Sync lockfile**: `npm install --package-lock-only`
3. Add `## [0.{milestone}.{N+1}]` entry to CHANGELOG.md (gate checks base version)
4. `npm run generate-terminal` (asset staleness gate)
5. Commit, push to main, tag `v0.{milestone}.{N+1}-rc.1`, push tag
6. Prerelease pipeline publishes to `@next`

### Critical: lockfile sync

**Always run `npm install --package-lock-only` after changing `package.json`.**

The version field in `package-lock.json` must match `package.json`. If they drift, `npm ci` fails in CI — and because GitHub PR checks run against a merge-ref commit, the failure can be impossible to fix without starting from a clean branch.

Quick check: `node -p "require('./package-lock.json').version"` should match `node -p "require('./package.json').version"`.

### CI gates to remember
- **Lockfile sync**: `package-lock.json` version must match `package.json` version
- CHANGELOG gate: requires `## [{base_version}]` in CHANGELOG.md
- Asset staleness: `npm run check:assets` — regenerate with `npm run generate-terminal`
- Lint isolation: `npm run lint:isolation` — require paths must use `$HOME/.claude/nf-bin/` with CWD fallback
- CLI version test: regex accepts prerelease suffixes (`X.Y.Z-rc.N`)

### Troubleshooting CI failures

**`npm ci` fails with EUSAGE (lockfile mismatch):**
- Root cause: `package-lock.json` version doesn't match `package.json`
- Fix: `npm install --package-lock-only` then commit the updated lockfile
- If a PR keeps failing despite lockfile fixes, the merge-ref may be stale. Create a fresh branch from `origin/main` and redo the release there.

**Assets stale after version bump:**
- Run `npm run generate-terminal` — the SVG embeds the version string

## Git workflow

- Always use PRs with CI gates for stable releases — never direct push to main
- Direct push to main is acceptable for prerelease version bumps and CI fixes
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

- `bash scripts/prepare-release.sh {VERSION}` — prepare stable release via PR (recommended)
- `bash scripts/release.sh` — tag + push prerelease (direct push flow)
- `bash scripts/publish.sh` — manual npm publish (reads NPM_TOKEN from .env). **Legacy/token-based** — CI publishing moved to OIDC (`publish.yml`), so this only works if the npm package still allows token publishing (i.e. NOT with the "disallow tokens" setting).

## Publishing (npm OIDC trusted publisher)

The single `publish.yml` workflow publishes both channels via **GitHub OIDC — there is no `NPM_TOKEN` secret**:
- **@latest** — push to main with a non-prerelease `package.json` version (runs tests → publish → tag → GitHub Release → align `@next`).
- **@next** — push of a `v*-rc*` / `v*-next*` tag.

npm's trusted publisher (npmjs.com → package Settings) must match this file exactly:
`Org=nForma-AI · Repo=nForma · Workflow filename=publish.yml · Environment=npm-publish · Allowed=npm publish`.
Requirements baked into the workflow: Node ≥ 22.14.0 and npm ≥ 11.5.1 (`npm i -g npm@latest`), `permissions: id-token: write`, **no** `NODE_AUTH_TOKEN` (its presence forces the token path and defeats OIDC).

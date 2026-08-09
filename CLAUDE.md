# CLAUDE.md — nForma

## Versioning

nForma uses milestone-based semver (no separate prerelease channel — see dist-tag mapping below):

- `0.{milestone}` — milestone release (e.g., 0.40 = 40th milestone)
- `0.{milestone}.{patch}` — quick task release within a milestone (e.g., 0.40.1, 0.40.2)

Versions with a prerelease suffix (e.g. `0.40.2-rc.1`) **cannot ship** — there is only one channel, so a prerelease semver published to `@latest` would silently install `0.40.2-rc.1` for every user doing `npm install @nforma.ai/nforma@latest`. `publish.yml` rejects any version with a `-` suffix.

Dist-tag mapping:
- `latest` — stable versions (0.44.3). **The only channel.**
- `next` — **DEPRECATED alias, scheduled for retirement.** Best-effort mirror of `latest`; may lag.

**`@next` is deprecated (decided 2026-08-09).** It was the prerelease channel; #366/#367
retired that flow, leaving a tag that by policy always equals `@latest` — it therefore
carries **zero information** while costing a manual step after every release. Keeping it
in sync *can* be automated — `.github/workflows/align-dist-tags.yml` does exactly that —
but only on a credential class npm is retiring. OIDC does not cover `npm dist-tag` (see
"Aligning `@next`"),
so the only automated option is a long-lived publish-capable token in CI — precisely what
adopting trusted publishing was meant to eliminate, and it expires silently on a timer
(the current secret died exactly that way).

**npm is actively retiring that option.** Per
[GitHub's 2026-07-31 changelog](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/),
granular access tokens configured to bypass 2FA already cannot create/delete tokens or
change package access without an interactive 2FA challenge (this is why `npm token create`
now hangs on an OTP prompt in a non-interactive shell), and **from a targeted January 2027
they lose direct publishing capability altogether** — reduced to reading private packages
and staging a publish that a maintainer approves with 2FA. The recommended paths are
trusted publishing (OIDC) and staged publishing.

So the token route is not merely inconvenient: it is a mechanism npm is retiring, on a
published timeline. Deprecating `@next` removes the **last token dependency** from this
repo's release pipeline — publish is already OIDC, and the dist-tag step was the only
thing still needing a credential.

**Consequences, in force now:**
- Drift is **expected**, not a bug. Do not treat a stale `@next` as an incident.
- Align it opportunistically when convenient — see "Aligning `@next`" — or run the
  `Align dist-tags` workflow. Neither is required for a release to be correct.
- `@latest` is the supported channel. All docs, install instructions and support should
  say `@latest` or nothing at all.

**Retirement plan.** Do NOT run `npm dist-tag rm @nforma.ai/nforma next` yet. The package sees ~1.2k
downloads/month and someone may be pinned to `@next`; removing a tag makes
`npm i @nforma.ai/nforma@next` fail outright. Leave it pointing at a real version, revisit
after two or three releases, and remove it only if nothing appears to install from it.
Until then it is harmless — a slightly stale pointer to a real, published tarball.

```bash
npm view @nforma.ai/nforma dist-tags --json
# `latest` is authoritative; `next` may lag and that is expected
```

When asked for a "new release", there is only **one** channel — `@latest` (`@next` is a deprecated alias that may lag; it does not gate a release). Confirm the target version string, then check `npm view @nforma.ai/nforma dist-tags --json` to determine the next version number.

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
- **No prerelease versions**: `package.json` version must NOT contain a `-` suffix; `publish.yml` rejects prerelease semver (there is no separate prerelease channel to ship them on)

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

The single `publish.yml` workflow publishes the single `@latest` channel via **GitHub OIDC**. The *publish* itself uses no token; the `@next` alignment step is the one place that uses token auth, via a temporary `.npmrc` (see "Aligning `@next`" below for why):
- **@latest** — push to main with a non-prerelease `package.json` version (runs tests → publish → tag → GitHub Release). A final step *attempts* to align the deprecated `@next` alias, but it is inert while `NPM_TOKEN` is expired and, per the deprecation above, is not required for the release to be correct.

npm's trusted publisher (npmjs.com → package Settings) must match this file exactly:
`Org=nForma-AI · Repo=nForma · Workflow filename=publish.yml · Environment=npm-publish · Allowed=npm publish`.
Requirements baked into the workflow: Node ≥ 22.14.0 and npm ≥ 11.5.1 (`npm i -g npm@latest`), `permissions: id-token: write`, **no** `NODE_AUTH_TOKEN` (its presence forces the token path and defeats OIDC).

**Aligning `@next` — current state (2026-08-08).** Two independent facts, long conflated:

**Fact 1 — OIDC does not cover `npm dist-tag`.** Per [npm's trusted-publishers docs](https://docs.npmjs.com/trusted-publishers): *"OIDC authentication supports the `npm publish` and `npm stage publish` commands"*, and *"Other npm commands such as `install`, `view`, or `access` still require traditional authentication methods."* The trusted-publisher config states the same scope in its own field: `Allowed = npm publish`. So the alignment step must use token auth **as of this writing** — re-check the docs before assuming that still holds, since npm may extend OIDC scope. (An earlier revision of this file called that explanation "wrong". It was not: it was right about *why* a token is needed, and merely silent about the bug in *how* the token was supplied.)

**Fact 2 — the drift everyone kept chasing was a wiring bug, not the OIDC limit.** In order:

1. **Wiring bug (fixed, #391).** The align step exported `NPM_TOKEN` as a bare `env:` var. npm does not read `NPM_TOKEN` — auth comes from `.npmrc` — so `dist-tag add` ran *unauthenticated* and 401'd every release, while the warning text blamed a token that was configured and healthy. The step now writes `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` for its own duration (safe: it runs after the OIDC publish, so it cannot force publish onto the token path).
2. **The `NPM_TOKEN` secret is expired** (created 2026-02-21; CI returns `E401 — authentication token seems to be invalid`), so the automated step is inert. Given the deprecation above this is **not worth fixing**: alignment is optional, and replacing the secret would mean adopting a credential class npm retires in ~Jan 2027.

**Manual alignment (optional — `@next` is deprecated, so this never gates a release).**
Run it yourself in an interactive terminal:
```bash
npm dist-tag add @nforma.ai/nforma@{VERSION} next
```
It prints an `npmjs.com/auth/cli/...` URL; approve in the browser and it completes. Note `--otp=<code>` only works if your npm 2FA is an authenticator app — with a **security key / passkey** there is no 6-digit code and the browser flow is the only path. This also cannot be run unattended by an agent, which is why it needs a human.

**Making it automatic again — deliberately NOT recommended.** It is possible: a Granular Access Token scoped to `@nforma.ai/nforma` with Read and write, then `gh secret set NPM_TOKEN --repo nForma-AI/nForma`, verified with `gh workflow run "Align dist-tags"` (#396, dispatchable and idempotent). Don't, unless something changes: 2FA-bypass tokens lose direct publishing on a targeted January 2027, they expire silently in the meantime, and it would put a long-lived publish-capable credential back into a pipeline that is otherwise entirely OIDC. The tag being aligned is deprecated; the credential would be real.

**Checking:** `npm view @nforma.ai/nforma dist-tags --json`. `latest` is authoritative; `next` may lag and that is expected, not a failure. CI's `Verify @next == @latest` step reports drift as a `::notice::` with the fix command, for anyone who wants to align opportunistically.

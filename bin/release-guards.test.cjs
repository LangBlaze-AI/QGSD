'use strict';

// Regression gates for the @next == @latest alias policy (PRs #366/#367).
//
// The policy exists to stop a prerelease reaching @latest, where
// `npm install @nforma.ai/nforma` would silently install e.g. 0.44.2-rc.1 for
// every user. Three guards enforce it — publish.sh (version + --tag),
// prepare-release.sh (version), and publish.yml (version) — and until this file
// none of them had a test. Per the recurrence record in this repo (config-path
// drift fixed 6x, null-CLI 4x), an ungated class comes back.
//
// SAFETY: publish.sh ends in `npm publish`. These tests must never be able to
// reach it, INCLUDING in the red case where a guard is broken. Every script runs
// in a throwaway sandbox against a stub `npm` that only records its argv, and
// each test asserts the stub was never invoked with `publish`. A broken guard
// therefore fails the assertion instead of publishing anything.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');

/**
 * Build a throwaway repo root containing a copy of `script`, a package.json at
 * `version`, a dummy .env, and a stub npm on PATH.
 *
 * The scripts derive ROOT_DIR from their own location and `cd` to it, so copying
 * the script into the sandbox is what redirects them away from the real repo.
 */
function sandbox(script, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-relguard-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'stub-bin'));

  fs.copyFileSync(path.join(REPO, 'scripts', script), path.join(dir, 'scripts', script));
  fs.chmodSync(path.join(dir, 'scripts', script), 0o755);

  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: '@nforma-test-fixture/never-real', version, private: true }, null, 2)
  );
  // publish.sh aborts early without one; contents are never used by a guard path.
  fs.writeFileSync(path.join(dir, '.env'), 'NPM_TOKEN=npm_stub_token_not_real\n');

  // Stub npm: record argv, never touch the network. Exits 0 so that a BROKEN
  // guard produces a recorded `publish` line (test fails loudly) rather than an
  // incidental non-zero exit that might read as the guard having worked.
  const log = path.join(dir, 'npm-calls.log');
  fs.writeFileSync(
    path.join(dir, 'stub-bin', 'npm'),
    `#!/usr/bin/env bash\necho "$@" >> ${JSON.stringify(log)}\nexit 0\n`
  );
  fs.chmodSync(path.join(dir, 'stub-bin', 'npm'), 0o755);

  return { dir, log, script: path.join(dir, 'scripts', script) };
}

function run(sb, args = []) {
  const res = spawnSync('bash', [sb.script, ...args], {
    cwd: sb.dir,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PATH: `${path.join(sb.dir, 'stub-bin')}:${process.env.PATH}` },
  });
  const npmCalls = fs.existsSync(sb.log) ? fs.readFileSync(sb.log, 'utf8') : '';
  return { ...res, npmCalls, out: `${res.stdout || ''}${res.stderr || ''}` };
}

function cleanup(sb) {
  try { fs.rmSync(sb.dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

/** The invariant every guard test shares: nothing was published. */
function assertNothingPublished(r) {
  assert.ok(
    !/\bpublish\b/.test(r.npmCalls),
    `GUARD FAILED — npm publish was reached. npm calls:\n${r.npmCalls}`
  );
}

describe('publish.sh — prerelease version guard', () => {
  it('refuses a prerelease package.json version and never publishes', () => {
    const sb = sandbox('publish.sh', '0.44.2-rc.1');
    try {
      const r = run(sb);
      assert.notEqual(r.status, 0, 'expected non-zero exit for a prerelease version');
      assert.match(r.out, /prerelease/i);
      assertNothingPublished(r);
    } finally { cleanup(sb); }
  });

  it('accepts a stable version far enough to reach the publish call', () => {
    // Control for the test above: proves the prerelease rejection is caused by the
    // version, not by the sandbox failing for some unrelated reason. Reaching the
    // stub npm here is the CORRECT behaviour — the stub is what makes it safe.
    const sb = sandbox('publish.sh', '0.44.2');
    try {
      const r = run(sb);
      assert.match(r.npmCalls, /publish/, 'stable version should reach the publish step');
    } finally { cleanup(sb); }
  });
});

describe('publish.sh — --tag guard (alias policy: publish must land on @latest)', () => {
  for (const args of [['--tag', 'next'], ['--tag=next'], ['--tag=latest'], ['--tag', 'latest']]) {
    it(`refuses ${args.join(' ')} and never publishes`, () => {
      const sb = sandbox('publish.sh', '0.44.2'); // stable, so only the --tag guard can fire
      try {
        const r = run(sb, args);
        assert.notEqual(r.status, 0, `expected non-zero exit for ${args.join(' ')}`);
        assert.match(r.out, /--tag/);
        assertNothingPublished(r);
      } finally { cleanup(sb); }
    });
  }
});

describe('prepare-release.sh — prerelease guards', () => {
  it('refuses an explicit prerelease target version', () => {
    const sb = sandbox('prepare-release.sh', '0.44.1');
    try {
      const r = run(sb, ['0.44.2-rc.1']);
      assert.notEqual(r.status, 0, 'expected non-zero exit for a prerelease target');
      assert.match(r.out, /prerelease/i);
      assertNothingPublished(r);
    } finally { cleanup(sb); }
  });

  it('refuses --auto when the CURRENT version is a prerelease', () => {
    // Without the early guard, `cut -d. -f3` yields "2-rc" and $((PATCH + 1)) is a
    // bash arithmetic error — the crash CodeRabbit flagged on #368.
    const sb = sandbox('prepare-release.sh', '0.44.2-rc.1');
    try {
      const r = run(sb, ['--auto']);
      assert.notEqual(r.status, 0, 'expected non-zero exit for a prerelease current version');
      assert.match(r.out, /prerelease/i);
      assert.doesNotMatch(r.out, /arithmetic|syntax error/i, 'should fail cleanly, not crash');
      assertNothingPublished(r);
    } finally { cleanup(sb); }
  });
});

describe('publish.yml — CI-side prerelease rejection', () => {
  const YML = fs.readFileSync(path.join(REPO, '.github/workflows/publish.yml'), 'utf8');

  it('still contains a version guard that exits non-zero on a prerelease', () => {
    const guard = /if echo "\$VERSION" \| grep -qE '\\-'; then[\s\S]{0,400}?exit 1/;
    assert.match(YML, guard, 'publish.yml lost its prerelease version guard');
  });

  it('the guard expression actually matches a prerelease and not a stable version', () => {
    // Execute the real predicate rather than trusting the regex above.
    const matches = (v) =>
      spawnSync('bash', ['-c', `echo ${JSON.stringify(v)} | grep -qE '\\-'`]).status === 0;
    assert.equal(matches('0.44.2-rc.1'), true, 'prerelease must match the guard');
    assert.equal(matches('0.44.2'), false, 'stable version must not match the guard');
  });

  it('has no prerelease tag triggers (the retired v*-rc* / v*-next* channel)', () => {
    assert.doesNotMatch(YML, /v\*-rc\*/, 'v*-rc* trigger was reintroduced');
    assert.doesNotMatch(YML, /v\*-next\*/, 'v*-next* trigger was reintroduced');
  });

  it('does not reintroduce a prerelease publish mode', () => {
    assert.doesNotMatch(YML, /dist_tag=next/, 'a next-channel dist_tag was reintroduced');
    assert.doesNotMatch(YML, /mode=prerelease/, 'a prerelease mode was reintroduced');
  });
});

// ── DIST-TAG-01: the @next alignment must actually authenticate ───────────────
// The align step used to do nothing but `env: NPM_TOKEN: ${{ secrets.NPM_TOKEN }}`.
// npm does not read NPM_TOKEN — auth comes from .npmrc (or NODE_AUTH_TOKEN plus a
// setup-node registry-url). So `npm dist-tag add` ran UNAUTHENTICATED, 401'd, and hit
// the warning branch on every release while blaming a token that was configured and
// working. That is the recurring @next drift the alias invariant kept tripping over.
describe('publish.yml — @next alignment actually authenticates (DIST-TAG-01)', () => {
  const YML = fs.readFileSync(path.join(REPO, '.github/workflows/publish.yml'), 'utf8');
  const alignStep = (() => {
    const start = YML.indexOf('- name: Align @next with @latest');
    assert.ok(start !== -1, 'publish.yml lost its "Align @next with @latest" step');
    const rest = YML.slice(start + 1);
    const end = rest.indexOf('\n      - name:');
    return rest.slice(0, end === -1 ? undefined : end);
  })();

  it('writes an .npmrc authToken rather than relying on a bare NPM_TOKEN env var', () => {
    assert.match(
      alignStep, /_authToken=\$\{NPM_TOKEN\}/,
      'the align step must write //registry.npmjs.org/:_authToken=${NPM_TOKEN} into .npmrc — ' +
      'exporting NPM_TOKEN alone is a no-op and the dist-tag call runs unauthenticated',
    );
  });

  it('removes the .npmrc it wrote', () => {
    assert.match(alignStep, /rm -f \.npmrc/, 'the temporary .npmrc must be cleaned up');
  });

  it('distinguishes "secret missing" from "token rejected" in its warnings', () => {
    // The old message asserted the token "may be revoked or expired" in the one case
    // where that was never the cause. A wrong diagnosis costs the next reader real time.
    assert.match(alignStep, /NPM_TOKEN secret is not set/, 'must report an absent secret as absent');
    assert.match(alignStep, /revoked, expired, or lacks publish rights/, 'must report a rejected token distinctly');
  });

  it('verifies the invariant after aligning, instead of only printing dist-tags', () => {
    assert.match(YML, /- name: Verify @next == @latest/, 'publish.yml must verify the alias invariant');
    assert.match(YML, /DIST-TAG DRIFT/, 'a drifted tag must be called out explicitly, not left to be eyeballed');
  });

  it('keeps the publish step on OIDC — no NODE_AUTH_TOKEN in any non-comment line', () => {
    // Its presence forces the token path and defeats trusted publishing (CLAUDE.md).
    // Comments naming it are fine — two of them exist precisely to warn against it —
    // so strip comment lines before asserting rather than matching the whole file.
    const code = YML.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(code, /NODE_AUTH_TOKEN/, 'NODE_AUTH_TOKEN defeats OIDC trusted publishing');
  });
});

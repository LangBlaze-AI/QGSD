#!/usr/bin/env node
/**
 * CI guard: verifies that every hook registered by the installer has a
 * corresponding entry in the build-hooks HOOKS_TO_COPY list, that every
 * require('./...') dependency inside those hooks is also included, AND that
 * each hook's built artifact in hooks/dist/ is byte-identical to its source
 * (the installer ships hooks/dist/, so a stale dist means users run old code —
 * exactly the drift that shipped a stale nf-circuit-breaker for several releases).
 *
 * Exits non-zero on drift so the test suite catches it early.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INSTALL_JS = path.join(ROOT, 'bin', 'install.js');
const BUILD_HOOKS_JS = path.join(ROOT, 'scripts', 'build-hooks.js');
const HOOKS_DIR = path.join(ROOT, 'hooks');
const DIST_DIR = path.join(HOOKS_DIR, 'dist');

// --- Extract HOOKS_TO_COPY from build-hooks.js ---
function getHooksToCopy() {
  const src = fs.readFileSync(BUILD_HOOKS_JS, 'utf8');
  const match = src.match(/HOOKS_TO_COPY\s*=\s*\[([\s\S]*?)\]/);
  if (!match) throw new Error('Could not parse HOOKS_TO_COPY from build-hooks.js');
  const entries = [];
  for (const m of match[1].matchAll(/'([^']+)'/g)) {
    entries.push(m[1]);
  }
  return new Set(entries);
}

// --- Extract hook filenames registered by the installer via buildHookCommand() ---
function getInstallerHooks() {
  const src = fs.readFileSync(INSTALL_JS, 'utf8');
  const hooks = new Set();
  for (const m of src.matchAll(/buildHookCommand\(\s*\w+\s*,\s*'([^']+)'\s*\)/g)) {
    hooks.add(m[1]);
  }
  return hooks;
}

// --- Read a path's blob at HEAD. Returns a Buffer, or null when the path is
//     untracked / HEAD is unreadable / git is unavailable. Callers treat null as
//     "cannot determine" and skip, so this never fails a build spuriously.
function gitShowAtHead(relPath) {
  const r = spawnSync('git', ['show', `HEAD:${relPath}`], {
    cwd: ROOT,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'buffer',
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

// Is this a git work tree at all? A published npm tarball is not, and neither is
// a vendored copy — in those contexts the committed-dist check is meaningless.
function isGitWorkTree() {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return !r.error && r.status === 0 && r.stdout.trim() === 'true';
}

// --- Extract local require('./...') dependencies from a hook source file ---
function getLocalRequires(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const deps = new Set();
  for (const m of src.matchAll(/require\(\s*'\.\/([^']+)'\s*\)/g)) {
    let dep = m[1];
    // Node resolves require('./config-loader') to './config-loader.js'
    // Normalize to match HOOKS_TO_COPY entries which include extensions
    if (!path.extname(dep)) dep += '.js';
    deps.add(dep);
  }
  return deps;
}

// --- Main ---
const hooksToCopy = getHooksToCopy();
const installerHooks = getInstallerHooks();
const errors = [];

// Check 4 (below) compares the COMMITTED blobs, which only exists in a work tree.
const inWorkTree = isGitWorkTree();
let committedChecked = 0;
let committedSkipped = 0;

// 1. Every hook registered by the installer must be in HOOKS_TO_COPY
for (const hook of installerHooks) {
  if (!hooksToCopy.has(hook)) {
    errors.push(`MISSING from HOOKS_TO_COPY: '${hook}' (registered in installer via buildHookCommand)`);
  }
}

// 2. Every local require() dependency of copied hooks must also be in HOOKS_TO_COPY
for (const hook of hooksToCopy) {
  const hookPath = path.join(HOOKS_DIR, hook);
  if (!fs.existsSync(hookPath)) {
    errors.push(`HOOKS_TO_COPY entry '${hook}' does not exist at ${hookPath}`);
    continue;
  }
  const deps = getLocalRequires(hookPath);
  for (const dep of deps) {
    if (!hooksToCopy.has(dep)) {
      errors.push(`MISSING from HOOKS_TO_COPY: '${dep}' (required by ${hook})`);
    }
  }

  // 3. The built artifact in hooks/dist/ must be byte-identical to the source.
  //    build-hooks.js is a plain copy (no transform), so any difference means
  //    dist is stale — the installer would ship outdated hook code.
  const distPath = path.join(DIST_DIR, hook);
  if (!fs.existsSync(distPath)) {
    errors.push(`DIST MISSING: hooks/dist/${hook} does not exist (run 'npm run build:hooks')`);
  } else if (!fs.readFileSync(hookPath).equals(fs.readFileSync(distPath))) {
    // Compare raw Buffers (not UTF-8 strings) so the check is truly byte-level —
    // catches BOM, CRLF, and any non-UTF8 byte differences a string compare hides.
    errors.push(`DIST DRIFT: hooks/dist/${hook} differs from source hooks/${hook} (run 'npm run build:hooks' and commit)`);
  }

  // 4. The COMMITTED hooks/dist/ blob must match the COMMITTED source blob.
  //
  //    Check 3 compares the WORKING TREE, which CI rebuilds via 'npm run
  //    build:hooks' before this gate runs — so check 3 is always satisfied in CI
  //    and cannot see staleness that is committed to git. That blind spot is
  //    reachable: `git clone` + `node bin/install.js` installs hooks/dist/ as
  //    committed, and install.js rebuilds only when dist is MISSING or
  //    INCOMPLETE (see buildHooksIfMissing / isDistComplete) — never when it is
  //    merely STALE, since a stale file is present and therefore looks complete.
  //    A fresh-clone install would silently ship outdated hook code, so staleness
  //    has to be caught here at commit time instead.
  //
  //    Skipped outside a git work tree (npm tarball, vendored copy) and whenever
  //    either blob cannot be resolved at HEAD — untracked path, unreadable HEAD,
  //    or any git failure. "Cannot determine" must never fail the build.
  if (inWorkTree) {
    const committedSrc = gitShowAtHead(`hooks/${hook}`);
    const committedDist = gitShowAtHead(`hooks/dist/${hook}`);
    if (committedSrc === null || committedDist === null) {
      committedSkipped++;
    } else if (!committedSrc.equals(committedDist)) {
      committedChecked++;
      errors.push(
        `COMMITTED DIST DRIFT: the committed hooks/dist/${hook} differs from the ` +
        `committed hooks/${hook} — a fresh clone + install would ship stale code ` +
        `(run 'npm run build:hooks' and commit hooks/dist/)`
      );
    } else {
      committedChecked++;
    }
  }
}

if (errors.length > 0) {
  console.error('hooks-sync verification FAILED:\n');
  for (const e of errors) console.error(`  - ${e}`);
  console.error('\nFix: update HOOKS_TO_COPY in scripts/build-hooks.js, and/or run');
  console.error("     'npm run build:hooks' to refresh hooks/dist/, then commit the result.");
  process.exit(1);
} else {
  const committedNote = !inWorkTree
    ? 'committed-dist check skipped (not a git work tree)'
    : `${committedChecked} committed blob(s) verified` +
      (committedSkipped > 0 ? `, ${committedSkipped} unresolvable at HEAD (skipped)` : '');
  console.log(
    `hooks-sync OK: ${hooksToCopy.size} hooks in build list, ` +
    `${installerHooks.size} registered by installer, dist in sync; ${committedNote}`
  );
}

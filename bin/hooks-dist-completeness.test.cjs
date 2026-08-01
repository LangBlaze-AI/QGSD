'use strict';

// bin/hooks-dist-completeness.test.cjs
//
// Guards the fresh-clone install path. Only SOME hooks/dist/ files are tracked
// in git, so `git clone` yields a dist directory that EXISTS but is missing
// entries — including shared deps (nf-resolve-bin.js, conformance-schema.cjs)
// that other hooks require(). bin/install.js used to check existence only, so
// it returned early there and silently installed fewer hooks than the product
// needs.
//
// isDistComplete() is the guard. These tests pin its contract:
//   T1: a dist containing every expected entry            -> complete
//   T2: a dist missing one expected entry                 -> INCOMPLETE (the bug)
//   T3: an entry with no source file in hooks/            -> ignored (build-hooks
//                                                            skips those, so their
//                                                            absence is not drift)
//   T4: an unreadable/absent build script                 -> fails OPEN (complete)
//   T5: scripts/build-hooks.js really does export the list it builds from
//   T6: requiring scripts/build-hooks.js has no side effects (does not write dist)

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isDistComplete } = require('./install.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const REAL_BUILD_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-hooks.js');

// Build a throwaway tree: <tmp>/hooks/{a,b}.js, <tmp>/hooks/dist/..., and a
// fake build script exporting a known HOOKS_TO_COPY.
function makeTree(suffix, { distEntries, hookEntries, listEntries }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `nf-dist-${suffix}-`));
  const hooksDir = path.join(root, 'hooks');
  const distDir = path.join(hooksDir, 'dist');
  const scriptsDir = path.join(root, 'scripts');
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });

  for (const e of hookEntries) fs.writeFileSync(path.join(hooksDir, e), '// src\n');
  for (const e of distEntries) fs.writeFileSync(path.join(distDir, e), '// dist\n');

  const buildScript = path.join(scriptsDir, 'build-hooks.js');
  fs.writeFileSync(
    buildScript,
    `module.exports = { HOOKS_TO_COPY: ${JSON.stringify(listEntries)} };\n`
  );

  return { root, hooksDir, distDir, buildScript, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('isDistComplete — fresh-clone install guard', () => {
  const trees = [];
  after(() => { for (const t of trees) t.cleanup(); });

  it('T1: dist containing every expected entry is complete', () => {
    const t = makeTree('t1', {
      hookEntries: ['a.js', 'b.js'],
      distEntries: ['a.js', 'b.js'],
      listEntries: ['a.js', 'b.js'],
    });
    trees.push(t);
    assert.equal(isDistComplete(t.distDir, t.buildScript, t.hooksDir), true);
  });

  it('T2: dist missing an expected entry is INCOMPLETE (the fresh-clone bug)', () => {
    // This is the case that used to slip through: the directory exists, so the
    // old existence-only check returned early and skipped the rebuild.
    const t = makeTree('t2', {
      hookEntries: ['a.js', 'b.js'],
      distEntries: ['a.js'], // b.js absent — e.g. untracked in git
      listEntries: ['a.js', 'b.js'],
    });
    trees.push(t);
    assert.equal(isDistComplete(t.distDir, t.buildScript, t.hooksDir), false);
    assert.ok(fs.existsSync(t.distDir), 'sanity: dist dir exists, so existence-only would pass');
  });

  it('T3: an expected entry with no source file is ignored, not drift', () => {
    // build-hooks.js warns and skips entries whose source is absent, so dist
    // legitimately lacks them.
    const t = makeTree('t3', {
      hookEntries: ['a.js'],
      distEntries: ['a.js'],
      listEntries: ['a.js', 'ghost.js'], // ghost.js has no source
    });
    trees.push(t);
    assert.equal(isDistComplete(t.distDir, t.buildScript, t.hooksDir), true);
  });

  it('T4: an unreadable build script fails OPEN (treated as complete)', () => {
    const t = makeTree('t4', {
      hookEntries: ['a.js'],
      distEntries: [],
      listEntries: ['a.js'],
    });
    trees.push(t);
    const missing = path.join(t.root, 'scripts', 'does-not-exist.js');
    assert.equal(isDistComplete(t.distDir, missing, t.hooksDir), true,
      'cannot-determine must not force a rebuild loop');
  });

  it('T5: the real scripts/build-hooks.js exports the list it builds from', () => {
    const mod = require(REAL_BUILD_SCRIPT);
    assert.ok(Array.isArray(mod.HOOKS_TO_COPY), 'HOOKS_TO_COPY must be exported as an array');
    assert.ok(mod.HOOKS_TO_COPY.length > 0, 'HOOKS_TO_COPY must be non-empty');
    // Cross-check against the literal in the file so the export cannot drift
    // away from what build() actually iterates.
    const src = fs.readFileSync(REAL_BUILD_SCRIPT, 'utf8');
    const literal = (src.match(/HOOKS_TO_COPY\s*=\s*\[([\s\S]*?)\]/) || [])[1] || '';
    const names = [...literal.matchAll(/'([^']+)'/g)].map(m => m[1]);
    assert.deepEqual(mod.HOOKS_TO_COPY, names,
      'exported HOOKS_TO_COPY must equal the literal build() iterates');
  });

  it('T6: requiring the real build script does not write to hooks/dist/', () => {
    // Guards the require.main === module gate. Without it, install.js reading
    // HOOKS_TO_COPY would rebuild dist as a side effect.
    const distDir = path.join(REPO_ROOT, 'hooks', 'dist');
    const before = fs.existsSync(distDir)
      ? Object.fromEntries(fs.readdirSync(distDir).map(f => {
          const p = path.join(distDir, f);
          return [f, fs.statSync(p).mtimeMs];
        }))
      : {};
    delete require.cache[require.resolve(REAL_BUILD_SCRIPT)];
    require(REAL_BUILD_SCRIPT);
    const after_ = fs.existsSync(distDir)
      ? Object.fromEntries(fs.readdirSync(distDir).map(f => {
          const p = path.join(distDir, f);
          return [f, fs.statSync(p).mtimeMs];
        }))
      : {};
    assert.deepEqual(after_, before, 'require() must not modify hooks/dist/');
  });
});

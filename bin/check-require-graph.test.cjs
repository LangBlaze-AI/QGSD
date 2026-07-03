'use strict';

// Unit tests for bin/check-require-graph.cjs — source-decidable code-consistency
// (dangling relative requires + circular require cycles). These are the code-layer
// analog of the formal dangling-ref / trivial-invariant checks: purely static,
// --fast-native, and false-positive-free (baseline is 0 on a clean tree).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const { findings, analyze, relRequires, resolveRel, detectCycles, stripComments } = require('./check-require-graph.cjs');

function tmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-test-'));
  cp.execSync('git init -q', { cwd: root });
  return root;
}
function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
function commit(root) { cp.execSync('git add -A', { cwd: root }); }
function rules(root, kind) { return findings(root).filter(f => f.rule === kind); }

test('detects a dangling relative require', () => {
  const root = tmpRepo();
  try {
    write(root, 'a.cjs', "const x = require('./missing-module.cjs');\nmodule.exports = {};");
    commit(root);
    const d = rules(root, 'dangling-require');
    assert.strictEqual(d.length, 1);
    assert.match(d[0].message, /missing-module\.cjs/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('detects a circular require cycle', () => {
  const root = tmpRepo();
  try {
    write(root, 'a.cjs', "require('./b.cjs'); module.exports = {};");
    write(root, 'b.cjs', "require('./a.cjs'); module.exports = {};");
    commit(root);
    const c = rules(root, 'circular-require');
    assert.strictEqual(c.length, 1, 'a 2-node cycle is reported exactly once');
    assert.match(c[0].message, /a\.cjs.*b\.cjs.*a\.cjs/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a valid require to an existing file is NOT flagged', () => {
  const root = tmpRepo();
  try {
    write(root, 'a.cjs', "const b = require('./b.cjs'); module.exports = {};");
    write(root, 'b.cjs', "module.exports = { x: 1 };");
    commit(root);
    assert.deepStrictEqual(findings(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('resolves via extension and directory index like Node', () => {
  const root = tmpRepo();
  try {
    write(root, 'a.cjs', "require('./b'); require('./dir');");
    write(root, 'b.js', "module.exports = {};");
    write(root, 'dir/index.cjs', "module.exports = {};");
    commit(root);
    assert.deepStrictEqual(rules(root, 'dangling-require'), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('does NOT flag a require inside a comment', () => {
  const root = tmpRepo();
  try {
    write(root, 'a.cjs', "// require('./missing.cjs')\n/* require('./also-missing.cjs') */\nmodule.exports = {};");
    commit(root);
    assert.deepStrictEqual(rules(root, 'dangling-require'), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('does NOT flag placeholder/example specs (ellipsis, template)', () => {
  // The recurring lint-rule-message false positive: require('./bin/...') as prose.
  assert.deepStrictEqual(relRequires("const m = \"require('./bin/...')\";"), []);
  assert.deepStrictEqual(relRequires("require(`./${name}.cjs`)"), []);
  // A concrete spec IS extracted.
  assert.deepStrictEqual(relRequires("require('./real-module.cjs')"), ['./real-module.cjs']);
});

test('ignores requires to node_modules / bare specifiers', () => {
  const root = tmpRepo();
  try {
    write(root, 'a.cjs', "require('fs'); require('some-pkg'); module.exports = {};");
    commit(root);
    assert.deepStrictEqual(findings(root), [], 'only relative specifiers are graph edges');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a 3-node cycle is detected', () => {
  const root = tmpRepo();
  try {
    write(root, 'a.cjs', "require('./b.cjs'); module.exports = {};");
    write(root, 'b.cjs', "require('./c.cjs'); module.exports = {};");
    write(root, 'c.cjs', "require('./a.cjs'); module.exports = {};");
    commit(root);
    assert.strictEqual(rules(root, 'circular-require').length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a non-git directory THROWS rather than reporting a false-clean result', () => {
  // A silent git failure returning [] would masquerade as a clean tree and
  // defeat the "0 findings ⇒ clean" invariant (CodeRabbit #301). It must throw.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-nogit-'));
  try {
    assert.throws(() => findings(root), /git ls-files.*exited with status|failed to spawn git/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a DAG (diamond, no cycle) is NOT flagged', () => {
  const root = tmpRepo();
  try {
    write(root, 'a.cjs', "require('./b.cjs'); require('./c.cjs'); module.exports = {};");
    write(root, 'b.cjs', "require('./d.cjs'); module.exports = {};");
    write(root, 'c.cjs', "require('./d.cjs'); module.exports = {};");
    write(root, 'd.cjs', "module.exports = {};");
    commit(root);
    assert.deepStrictEqual(rules(root, 'circular-require'), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

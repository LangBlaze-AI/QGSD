#!/usr/bin/env node
'use strict';
// bin/machine-path-lint.test.cjs
//
// Rule 8 of scripts/lint-isolation.js — `machine-specific-path`.
//
// Files that are EXECUTED AS WRITTEN (vhs tapes, shell scripts, workflow YAML) must not
// name anyone's home directory. `scripts/tui-screenshot.tape` and
// `scripts/tui-regression.tape` both shipped to npm carrying
// `cd /Users/jonathanborduas/code/QGSD`, and benchmark-sync.yml broke CI the same way.
// Nobody else can run those lines. The rule is deliberately scoped to .tape/.sh/.yml so
// illustrative `/Users/foo/...` paths inside JS comments stay legal.
//
// The lint runs over the real tree, so these tests drive it through a temp ROOT-shaped
// fixture instead: they copy the linter, point it at a fake repo, and assert on exit code.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const LINT = path.join(REPO, 'scripts', 'lint-isolation.js');

const TMP = [];
process.on('exit', () => {
  for (const d of TMP) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

// Build a minimal tree the linter can walk: it needs commands/nf, core/workflows, bin,
// and the dirs Rule 8 scans. ROOT is derived from the script's own location, so the
// fixture gets a copy of the linter at <fixture>/scripts/lint-isolation.js.
function makeFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-machine-path-'));
  TMP.push(dir);
  for (const d of ['commands/nf', 'core/workflows', 'scripts', '.github/workflows']) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  }
  fs.copyFileSync(LINT, path.join(dir, 'scripts', 'lint-isolation.js'));
  // The linter require()s sibling lint modules out of bin/ and scans bin/ for the
  // providers-isolation rules. Symlink the real one — copying it would fork the very
  // code under test, and an incomplete bin/ makes the linter die at require time, which
  // an exit-code-only assertion would happily read as "the rule fired".
  fs.symlinkSync(path.join(REPO, 'bin'), path.join(dir, 'bin'), 'dir');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content, 'utf8');
  }
  return dir;
}

function runLint(dir) {
  const res = spawnSync(process.execPath, [path.join(dir, 'scripts', 'lint-isolation.js')], {
    cwd: dir, encoding: 'utf8', timeout: 60000,
  });
  const out = (res.stdout || '') + (res.stderr || '');
  // A require/parse crash also exits non-zero. Never let that count as a detection.
  assert.doesNotMatch(out, /Cannot find module|SyntaxError|ReferenceError/, `linter crashed:\n${out}`);
  return { status: res.status, out };
}

test('MPATH-1: a clean fixture passes (control)', () => {
  const dir = makeFixture({ 'scripts/demo.tape': 'Type "cd ${NF_REPO:-$PWD} && node bin/x.js"\n' });
  const { status, out } = runLint(dir);
  assert.equal(status, 0, `expected clean pass, got:\n${out}`);
});

test('MPATH-2: a hardcoded home path in a .tape FAILS the lint', () => {
  // The exact bug that shipped.
  const dir = makeFixture({ 'scripts/demo.tape': 'Type "cd /Users/jonathanborduas/code/QGSD && node bin/x.js"\n' });
  const { status, out } = runLint(dir);
  assert.equal(status, 1, 'a machine-specific path must fail the lint');
  assert.match(out, /machine-specific-path/);
  assert.match(out, /scripts\/demo\.tape:1/);
});

test('MPATH-3: shell scripts and workflow YAML are covered too', () => {
  const shell = runLint(makeFixture({ 'scripts/deploy.sh': 'cp x /home/alice/.local/bin/\n' }));
  assert.equal(shell.status, 1, '.sh must be scanned');
  assert.match(shell.out, /machine-specific-path[\s\S]*deploy\.sh/, 'must fail for THIS rule, not incidentally');
  const wf = runLint(makeFixture({ '.github/workflows/sync.yml': '    run: node /Users/alice/code/thing/bin/x.js\n' }));
  assert.equal(wf.status, 1, 'workflow YAML must be scanned (the benchmark-sync.yml bug)');
  assert.match(wf.out, /machine-specific-path[\s\S]*sync\.yml/);
});

test('MPATH-4: comments and documented placeholders do NOT trip it', () => {
  const dir = makeFixture({
    'scripts/demo.sh': [
      '# e.g. /Users/jonathanborduas/code/QGSD — a comment, not an executed path',
      'echo "installs to /Users/foo/.claude/hooks"',   // placeholder user
      'echo "or /home/<name>/.config"',                // angle-bracket placeholder
      'echo "runner path /home/runner/work is CI-provided"',
    ].join('\n') + '\n',
  });
  const { status, out } = runLint(dir);
  assert.equal(status, 0, `placeholders/comments must stay legal, got:\n${out}`);
});

test('MPATH-5: the rule is wired into the real lint run, not just defined', () => {
  // A rule that exists but is never called is not a gate. Assert the live tree is clean
  // AND that the scan function is actually invoked at top level.
  const src = fs.readFileSync(LINT, 'utf8');
  assert.match(src, /^scanMachinePaths\(\);$/m, 'scanMachinePaths() must be called at top level');
  const res = spawnSync(process.execPath, [LINT], { cwd: REPO, encoding: 'utf8', timeout: 60000 });
  assert.equal(res.status, 0, `the real tree must be clean:\n${res.stdout}${res.stderr}`);
});

'use strict';
// hooks/nf-console-guard.test.js
// Tests for the console.log advisory Stop hook.
// Uses Node.js built-in test runner (node --test)

const { describe, it, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK_PATH = path.join(__dirname, 'nf-console-guard.js');

function runHook(cwd) {
  const result = spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify({ cwd, hook_event_name: 'Stop' }),
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    exitCode: result.status,
  };
}

function setupRepo() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-cg-test-'));
  spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8', timeout: 5000 });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tempDir, timeout: 5000 });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir, timeout: 5000 });
  return tempDir;
}

// TC-CG-01: empty input → exit 0, no stdout (fail-open)
test('TC-CG-01: empty/malformed stdin exits 0 with no stdout (fail-open)', () => {
  const result = spawnSync('node', [HOOK_PATH], {
    input: '',
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.strictEqual(result.status, 0, 'must exit 0');
  assert.strictEqual((result.stdout || '').trim(), '', 'stdout must be empty');
});

// TC-CG-02: no modified JS files → exit 0, no output
test('TC-CG-02: no modified files exits 0 silently', () => {
  const tempDir = setupRepo();
  try {
    // Create initial commit so git diff works
    fs.writeFileSync(path.join(tempDir, 'readme.txt'), 'hello', 'utf8');
    spawnSync('git', ['add', '.'], { cwd: tempDir, timeout: 5000 });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir, timeout: 5000 });
    const { stdout, stderr, exitCode } = runHook(tempDir);
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(stdout, '', 'no modified JS files → no stdout');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-CG-03: modified JS file with console.log → warning on stderr, NOT stdout
test('TC-CG-03: console.log in modified file produces stderr warning, empty stdout', () => {
  const tempDir = setupRepo();
  try {
    // Create initial commit
    const jsFile = path.join(tempDir, 'app.js');
    fs.writeFileSync(jsFile, 'module.exports = {};\n', 'utf8');
    spawnSync('git', ['add', '.'], { cwd: tempDir, timeout: 5000 });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir, timeout: 5000 });

    // Now add console.log and leave unstaged
    fs.writeFileSync(jsFile, 'console.log("debug");\nmodule.exports = {};\n', 'utf8');

    const { stdout, stderr, exitCode } = runHook(tempDir);
    assert.strictEqual(exitCode, 0, 'must always exit 0');
    assert.strictEqual(stdout, '', 'stdout must be empty — no decision:warn in schema');
    assert.ok(stderr.includes('CONSOLE.LOG WARNING'), 'stderr must contain warning');
    assert.ok(stderr.includes('app.js'), 'stderr must mention the file');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-CG-04: console.log inside a comment → NOT flagged
test('TC-CG-04: commented console.log is not flagged', () => {
  const tempDir = setupRepo();
  try {
    const jsFile = path.join(tempDir, 'clean.js');
    fs.writeFileSync(jsFile, 'module.exports = {};\n', 'utf8');
    spawnSync('git', ['add', '.'], { cwd: tempDir, timeout: 5000 });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir, timeout: 5000 });

    // Only commented console.log
    fs.writeFileSync(jsFile, '// console.log("debug");\nmodule.exports = {};\n', 'utf8');

    const { stdout, stderr, exitCode } = runHook(tempDir);
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(stdout, '', 'stdout empty');
    assert.ok(!stderr.includes('CONSOLE.LOG WARNING'), 'commented lines should not trigger warning');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-CG-05: stdout never contains "decision" field (schema compliance)
test('TC-CG-05: stdout never contains decision field — schema compliance', () => {
  const tempDir = setupRepo();
  try {
    const jsFile = path.join(tempDir, 'bad.cjs');
    fs.writeFileSync(jsFile, 'module.exports = {};\n', 'utf8');
    spawnSync('git', ['add', '.'], { cwd: tempDir, timeout: 5000 });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir, timeout: 5000 });

    fs.writeFileSync(jsFile, 'console.log("oops");\nconsole.log("double");\nmodule.exports = {};\n', 'utf8');

    const { stdout, exitCode } = runHook(tempDir);
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(stdout, '', 'stdout must be empty — never output invalid schema');
    // If stdout were non-empty, parsing as JSON should never have "decision"
    if (stdout) {
      const parsed = JSON.parse(stdout);
      assert.ok(!('decision' in parsed), 'must never output decision field');
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-CG-07: console.log inside a multi-line block comment is not flagged
test('TC-CG-07: console.log inside /* */ block comment is not flagged', () => {
  const tempDir = setupRepo();
  try {
    const jsFile = path.join(tempDir, 'block.js');
    fs.writeFileSync(jsFile, 'module.exports = {};\n', 'utf8');
    spawnSync('git', ['add', '.'], { cwd: tempDir, timeout: 5000 });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir, timeout: 5000 });

    // console.log lives only inside a /* */ block comment
    fs.writeFileSync(
      jsFile,
      '/* disabled debug block\nconsole.log("debug");\n*/\nmodule.exports = {};\n',
      'utf8'
    );

    const { stdout, stderr, exitCode } = runHook(tempDir);
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(stdout, '');
    assert.ok(!stderr.includes('CONSOLE.LOG WARNING'),
      'console.log inside a /* */ block comment must not be flagged');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-CG-08: console.log in a non-ASCII (git-quoted) filename is still detected
test('TC-CG-08: console.log in a unicode-named file is detected', () => {
  const tempDir = setupRepo();
  try {
    // Force the default C-quoting so the test exercises the decode path
    // deterministically regardless of the caller's global git config.
    spawnSync('git', ['config', 'core.quotepath', 'true'], { cwd: tempDir, timeout: 5000 });
    const jsFile = path.join(tempDir, 'café.js');
    fs.writeFileSync(jsFile, 'module.exports = {};\n', 'utf8');
    spawnSync('git', ['add', '.'], { cwd: tempDir, timeout: 5000 });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir, timeout: 5000 });

    fs.writeFileSync(jsFile, 'console.log("debug");\nmodule.exports = {};\n', 'utf8');

    const { stdout, stderr, exitCode } = runHook(tempDir);
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(stdout, '');
    assert.ok(stderr.includes('CONSOLE.LOG WARNING'),
      'console.log in a unicode-named file must still be detected');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// TC-CG-06: non-JS files are ignored
test('TC-CG-06: non-JS modified files are ignored', () => {
  const tempDir = setupRepo();
  try {
    const mdFile = path.join(tempDir, 'notes.md');
    fs.writeFileSync(mdFile, 'hello\n', 'utf8');
    spawnSync('git', ['add', '.'], { cwd: tempDir, timeout: 5000 });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir, timeout: 5000 });

    fs.writeFileSync(mdFile, 'console.log("in markdown")\n', 'utf8');

    const { stdout, stderr, exitCode } = runHook(tempDir);
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(stdout, '');
    assert.ok(!stderr.includes('CONSOLE.LOG WARNING'), '.md files should not be scanned');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

#!/usr/bin/env node
'use strict';
// bin/no-side-effects-on-require.test.cjs
// Regression gate for issue #198.
//
// Requiring a bin module must be a PURE operation: it must NOT
//   - call process.exit (would kill a caller like quorum-consensus-gate.cjs,
//     whose try/catch can't intercept an exit → read as a permanent defer)
//   - spawn a child process (spawn / spawnSync / exec / execSync / fork)
//   - write to the filesystem (writeFile* / appendFile* / mkdir* / rm* / unlink*)
//
// Each target module is required inside an isolated child process whose cwd is a
// throwaway temp dir. Before the require runs, the child monkeypatches process.exit,
// child_process spawn/exec, and fs write APIs to record any violation. The child
// then prints a JSON verdict and exits 0; the parent asserts on the verdict.
//
// Root cause this guards: run-prism.cjs used to run its entire PRISM pipeline at
// import time (process.exit at multiple points, spawnSync, argv forwarding). The
// fix moved readMCPAvailabilityRates into the side-effect-free scoreboard-rates.cjs
// and wrapped run-prism's pipeline in main() behind require.main === module.

const { test }      = require('node:test');
const assert        = require('node:assert');
const { spawnSync } = require('child_process');
const fs            = require('fs');
const path          = require('path');
const os            = require('os');

const BIN_DIR = __dirname;

// Modules that MUST be side-effect-free on require.
// At minimum the two modules fixed for #198. scoreboard-rates.cjs is the new
// pure helper they share. Add more bin/run-*.cjs here as they are hardened.
const TARGETS = [
  'scoreboard-rates.cjs',
  'run-prism.cjs',
  'quorum-consensus-gate.cjs',
];

// Child harness: instruments side-effect surfaces, requires the target, reports.
// Reads the absolute module path from the last argv entry. Always exits 0 so the
// parent can distinguish "module called process.exit" (recorded as a violation)
// from the harness's own clean exit. (With `node -e <script> <arg>`, the arg
// lands at process.argv[1], not [2].)
const HARNESS = `
'use strict';
const violations = [];
const realExit = process.exit.bind(process);

// 1. process.exit — record code, then neutralize so the harness can finish.
process.exit = function (code) {
  violations.push('process.exit(' + (code === undefined ? '' : code) + ')');
  // do NOT actually exit; let the require finish so we can report.
};

// 2. child_process spawn/exec family
const cp = require('child_process');
for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  if (typeof cp[fn] === 'function') {
    const orig = cp[fn];
    cp[fn] = function (...args) {
      violations.push('child_process.' + fn + '(' + String(args[0]) + ')');
      // Return a benign stub instead of actually spawning.
      if (fn.endsWith('Sync')) return { status: 0, stdout: '', stderr: '', signal: null, error: undefined };
      return { on() {}, stdout: { on() {} }, stderr: { on() {} }, kill() {} };
    };
  }
}

// 3. fs write surfaces
const fsmod = require('fs');
for (const fn of ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile',
                  'mkdirSync', 'mkdir', 'rmSync', 'rm', 'rmdirSync', 'rmdir',
                  'unlinkSync', 'unlink', 'renameSync', 'rename',
                  'copyFileSync', 'copyFile', 'createWriteStream']) {
  if (typeof fsmod[fn] === 'function') {
    const orig = fsmod[fn];
    fsmod[fn] = function (...args) {
      violations.push('fs.' + fn + '(' + String(args[0]) + ')');
      return undefined;
    };
  }
}

const target = process.argv[process.argv.length - 1];
let requireError = null;
try {
  require(target);
} catch (e) {
  requireError = e && e.message ? e.message : String(e);
}

process.stdout.write(JSON.stringify({ violations, requireError }) + '\\n');
realExit(0);
`;

function requireInChild(moduleFile) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-side-effects-'));
  try {
    const res = spawnSync(
      process.execPath,
      ['-e', HARNESS, path.join(BIN_DIR, moduleFile)],
      { encoding: 'utf8', cwd: tmpDir, env: { ...process.env } }
    );
    // The harness always exits 0. A non-zero exit means the require crashed the
    // process before the harness could report (e.g. a real uncaught exit).
    let parsed = null;
    const lastLine = (res.stdout || '').trim().split('\n').filter(Boolean).pop();
    if (lastLine) {
      try { parsed = JSON.parse(lastLine); } catch (_) { /* not JSON */ }
    }
    return { res, parsed, tmpDir };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

for (const moduleFile of TARGETS) {
  test('require(' + moduleFile + ') has no side effects', () => {
    const { res, parsed } = requireInChild(moduleFile);

    assert.strictEqual(res.status, 0,
      'child process must exit 0 (harness clean exit). stderr:\n' + (res.stderr || ''));
    assert.ok(parsed, 'child must emit a JSON verdict. stdout:\n' + (res.stdout || '') +
      '\nstderr:\n' + (res.stderr || ''));
    assert.strictEqual(parsed.requireError, null,
      'require(' + moduleFile + ') threw: ' + parsed.requireError);
    assert.deepStrictEqual(parsed.violations, [],
      'require(' + moduleFile + ') must not call process.exit / spawn / write FS. ' +
      'Violations: ' + JSON.stringify(parsed.violations));
  });
}

// Sanity check: the harness itself detects a deliberate side effect, proving the
// instrumentation actually works (guards against a false-green test).
test('harness detects a deliberate side effect (self-check)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-side-effects-self-'));
  const evilModule = path.join(tmpDir, 'evil.cjs');
  fs.writeFileSync(evilModule,
    "'use strict';\nrequire('fs').writeFileSync(require('path').join(process.cwd(), 'x.txt'), 'boom');\nprocess.exit(1);\n");
  try {
    const res = spawnSync(
      process.execPath, ['-e', HARNESS, evilModule],
      { encoding: 'utf8', cwd: tmpDir, env: { ...process.env } }
    );
    const lastLine = (res.stdout || '').trim().split('\n').filter(Boolean).pop();
    const parsed = lastLine ? JSON.parse(lastLine) : null;
    assert.ok(parsed, 'self-check child must emit a verdict');
    assert.ok(parsed.violations.length >= 2,
      'harness must record both the fs write and the process.exit. Got: ' +
      JSON.stringify(parsed.violations));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

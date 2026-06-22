'use strict';
// bin/formal-test-sync-safety.test.cjs
// Guards F22 — "safe" invocations of formal-test-sync were not safe:
//   1. No --help guard. `--help` (and any unrecognized flag) fell through to the
//      DEFAULT full sync, which writes stubs + report + sidecar. Asking for usage
//      mutated .planning/formal/.
//   2. --dry-run (documented "no writes") only gated the stub FILES; it still
//      wrote formal-test-sync-report.json and unit-test-coverage.json.
//
// Each test runs the real script against a throwaway --project-root and asserts
// exactly which files appear. --report-only / default are covered too so the
// fix can't silently flip into "never writes" or "always writes".

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'formal-test-sync.cjs');

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-fts-'));
  fs.mkdirSync(path.join(root, '.planning', 'formal'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'formal', 'requirements.json'), '[]');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function run(flags) {
  let stdout = '', status = 0;
  try {
    stdout = execFileSync('node', [SCRIPT, '--project-root=' + root, ...flags], { encoding: 'utf8' });
  } catch (e) {
    status = e.status == null ? 1 : e.status;
    stdout = (e.stdout || '').toString();
  }
  const p = (n) => path.join(root, '.planning', 'formal', n);
  return {
    status,
    stdout,
    report: fs.existsSync(p('formal-test-sync-report.json')),
    sidecar: fs.existsSync(p('unit-test-coverage.json')),
  };
}

describe('F22 — formal-test-sync safe modes are actually safe', () => {
  it('--help prints usage, exits 0, and writes NOTHING', () => {
    const r = run(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^Usage:/m, 'should print usage');
    assert.equal(r.report, false, '--help must not write the report');
    assert.equal(r.sidecar, false, '--help must not write the sidecar');
  });

  it('-h behaves like --help (no writes)', () => {
    const r = run(['-h']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^Usage:/m);
    assert.equal(r.report, false);
    assert.equal(r.sidecar, false);
  });

  it('--dry-run writes NOTHING (report + sidecar included)', () => {
    const r = run(['--dry-run', '--json']);
    assert.equal(r.status, 0);
    assert.equal(r.report, false, '--dry-run must not write the report');
    assert.equal(r.sidecar, false, '--dry-run must not write the sidecar');
  });

  it('--report-only writes NOTHING', () => {
    const r = run(['--report-only', '--json']);
    assert.equal(r.status, 0);
    assert.equal(r.report, false);
    assert.equal(r.sidecar, false);
  });

  it('default run DOES write report + sidecar (no over-correction)', () => {
    const r = run(['--json']);
    assert.equal(r.status, 0);
    assert.equal(r.report, true, 'a real sync must still write the report');
    assert.equal(r.sidecar, true, 'a real sync must still write the sidecar');
  });
});

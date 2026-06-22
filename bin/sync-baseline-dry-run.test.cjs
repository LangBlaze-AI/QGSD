'use strict';
// bin/sync-baseline-dry-run.test.cjs
// Guards F30 — `/nf:sync-baseline-requirements` had no way to preview changes:
// it always wrote .planning/formal/requirements.json, and there was no --help.
// Adds --dry-run (compute + report, write nothing) and --help (usage, no work).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'sync-baseline-requirements.cjs');

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-sbr-'));
  fs.mkdirSync(path.join(dir, '.planning', 'formal'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'formal', 'requirements.json'),
    JSON.stringify({ requirements: [] }));
  return dir;
}
const reqHash = (dir) => crypto.createHash('md5')
  .update(fs.readFileSync(path.join(dir, '.planning', 'formal', 'requirements.json')))
  .digest('hex');

function run(dir, args) {
  let stdout = '', status = 0;
  try {
    stdout = execFileSync('node', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
  } catch (e) { status = e.status == null ? 1 : e.status; stdout = (e.stdout || '').toString(); }
  return { stdout, status };
}

describe('F30 — sync-baseline-requirements --dry-run / --help', () => {
  it('--help prints usage, exits 0, writes nothing', () => {
    const dir = tmpProject();
    try {
      const before = reqHash(dir);
      const r = run(dir, ['--help']);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^Usage:/m);
      assert.equal(reqHash(dir), before, '--help must not modify requirements.json');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('--dry-run computes a non-empty merge but writes nothing', () => {
    const dir = tmpProject();
    try {
      const before = reqHash(dir);
      const r = run(dir, ['--profile', 'cli', '--dry-run', '--json']);
      assert.equal(r.status, 0);
      const result = JSON.parse(r.stdout);
      assert.equal(result.dry_run, true);
      assert.ok(result.added.length > 0, 'cli profile should propose additions');
      assert.equal(reqHash(dir), before, '--dry-run must not modify requirements.json');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('a real run (no --dry-run) DOES write requirements.json', () => {
    const dir = tmpProject();
    try {
      const before = reqHash(dir);
      const r = run(dir, ['--profile', 'cli', '--json']);
      assert.equal(r.status, 0);
      assert.notEqual(reqHash(dir), before, 'a real sync must write the additions');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

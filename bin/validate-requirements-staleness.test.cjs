'use strict';
// bin/validate-requirements-staleness.test.cjs
// Guards F14's detect-only staleness reporter: it must FIND legacy
// qgsd→nForma references in requirement texts, suggest the right replacements,
// and NEVER modify requirements.json.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'validate-requirements-staleness.cjs');
const { scan } = require('./validate-requirements-staleness.cjs');

function tmpProject(reqs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-stale-'));
  fs.mkdirSync(path.join(dir, '.planning', 'formal'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'formal', 'requirements.json'),
    JSON.stringify({ content_hash: 'sha256:fixed', requirements: reqs }));
  return dir;
}
const reqHash = (dir) => crypto.createHash('md5')
  .update(fs.readFileSync(path.join(dir, '.planning', 'formal', 'requirements.json'))).digest('hex');

const STALE = [
  { id: 'CONF-01', text: 'Global config at `~/.claude/qgsd.json` applies to all projects' },
  { id: 'ARCH-01', text: 'All models declared in `.formal/model-registry.json`' },
  { id: 'INST-01', text: 'Installed via get-shit-done-cc' },
  { id: 'CLEAN-01', text: 'User can edit nf.json and .planning/formal/ normally' },
];

describe('F14 — requirements staleness reporter', () => {
  it('finds qgsd.json / .formal/ / get-shit-done with correct suggestions', () => {
    const dir = tmpProject(STALE);
    try {
      const r = scan(dir);
      assert.equal(r.total_requirements, 4);
      assert.equal(r.counts['qgsd-json'], 1);
      assert.equal(r.counts['dot-formal-dir'], 1);
      assert.equal(r.counts['get-shit-done'], 1);
      const ids = r.findings.map(f => f.id);
      assert.ok(ids.includes('CONF-01') && ids.includes('ARCH-01') && ids.includes('INST-01'));
      // the clean requirement (nf.json / .planning/formal/) must NOT be flagged
      assert.ok(!ids.includes('CLEAN-01'), 'modern paths must not be reported');
      const qgsd = r.findings.find(f => f.rule === 'qgsd-json');
      assert.equal(qgsd.suggest, 'nf.json');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('is detect-only — never writes requirements.json', () => {
    const dir = tmpProject(STALE);
    try {
      const before = reqHash(dir);
      execFileSync('node', [SCRIPT, '--project-root', dir, '--json'], { encoding: 'utf8' });
      assert.equal(reqHash(dir), before, 'the reporter must not modify the envelope');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('exit codes: default 0, --strict 1 when stale, --strict 0 when clean, --help 0', () => {
    const stale = tmpProject(STALE);
    const clean = tmpProject([{ id: 'OK-01', text: 'uses nf.json and .planning/formal/' }]);
    const run = (dir, args) => {
      try { execFileSync('node', [SCRIPT, '--project-root', dir, ...args], { stdio: 'ignore' }); return 0; }
      catch (e) { return e.status == null ? 1 : e.status; }
    };
    try {
      assert.equal(run(stale, []), 0, 'default exits 0');
      assert.equal(run(stale, ['--strict']), 1, '--strict exits 1 when stale found');
      assert.equal(run(clean, ['--strict']), 0, '--strict exits 0 when clean');
      assert.equal(run(stale, ['--help']), 0, '--help exits 0');
    } finally {
      fs.rmSync(stale, { recursive: true, force: true });
      fs.rmSync(clean, { recursive: true, force: true });
    }
  });
});

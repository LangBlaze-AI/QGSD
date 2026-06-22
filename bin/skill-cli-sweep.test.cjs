'use strict';
// bin/skill-cli-sweep.test.cjs
// Guards three dogfooding fixes:
//   F32 — pr-resolve SKILL.md told users to "Use the export-threads script", which
//         does not exist; it's the `--export-threads` flag of pr-merge-autopilot.sh.
//   F4b — solve-remediate.md re-ran `node bin/gate-c-validation.cjs --json`, a script
//         intentionally deleted (chore(quick-241)); the dead reference is removed.
//   F13 — validate-requirements-haiku.cjs silently no-op'd its semantic pass when no
//         ANTHROPIC_API_KEY (subscription users) — it now warns loudly on stderr.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

describe('F32 — pr-resolve thread export reference', () => {
  const md = read('agents/skills/pr-resolve/SKILL.md');
  it('no longer references a non-existent "export-threads script"', () => {
    assert.ok(!/export-threads script/.test(md));
  });
  it('points at the real pr-merge-autopilot.sh --export-threads flag', () => {
    assert.ok(/pr-merge-autopilot\.sh --export-threads/.test(md));
    assert.ok(fs.existsSync(path.join(REPO, 'scripts/pr-merge-autopilot.sh')), 'the script must exist');
  });
});

describe('F4b — solve-remediate gate-c-validation dead reference', () => {
  const md = read('commands/nf/solve-remediate.md');
  it('no longer invokes the deleted gate-c-validation.cjs', () => {
    assert.ok(!/node bin\/gate-c-validation\.cjs/.test(md));
    assert.ok(!fs.existsSync(path.join(REPO, 'bin/gate-c-validation.cjs')), 'sanity: the script is gone');
  });
});

describe('F13 — review-requirements semantic pass warns when skipped', () => {
  const { validateRequirements } = require('./validate-requirements-haiku.cjs');

  it('emits a loud stderr warning (not a silent skip) without an API key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-vrh-'));
    const envPath = path.join(dir, 'requirements.json');
    fs.writeFileSync(envPath, JSON.stringify({ requirements: [{ id: 'X-01', text: 'a requirement' }] }));

    const orig = process.stderr.write;
    let captured = '';
    process.stderr.write = (chunk) => { captured += chunk; return true; };
    let result;
    try {
      result = await validateRequirements({ envelopePath: envPath, apiKey: undefined, mockCall: null });
    } finally {
      process.stderr.write = orig;
      fs.rmSync(dir, { recursive: true, force: true });
    }

    assert.equal(result.status, 'skipped');
    assert.equal(result.skipped_pass, 'semantic-validation');
    assert.match(captured, /SKIPPED/);
    assert.match(captured, /ANTHROPIC_API_KEY/);
  });
});

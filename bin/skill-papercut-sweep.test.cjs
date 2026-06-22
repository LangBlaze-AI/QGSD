'use strict';
// bin/skill-papercut-sweep.test.cjs
// Guards three dogfooding papercuts:
//   F11 — observe-handler-session-insights.cjs emitted issues with NO `category`
//         field, but session-insights.md's renderer groups output "by category".
//         The grouping silently fell back to ungrouped. Each emitted issue now
//         carries a `category`, and the set must match the renderer's groups.
//   F40 — reapply-patches.md showed "Current version: {read VERSION file}", but
//         there is no top-level VERSION file (version lives in package.json).
//   F41 — link-daintree.md (renamed from link-canopy) still printed "LINK CANOPY"
//         banners and told users to "re-run /nf:link-canopy" — a command that no
//         longer exists. (The canopy-app *legacy path* fallback is intentional
//         and must stay.)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

// ─── F11: handler categories match the renderer's groups ───

describe('F11 — session-insights category field', () => {
  const handler = read('bin/observe-handler-session-insights.cjs');
  const skill = read('commands/nf/session-insights.md');

  it('every session-insights issue push carries a category', () => {
    // Count the distinct issue-emitting push sites (one per category) vs the
    // number of `category:` fields. They must be equal — no push without a category.
    const idSites = (handler.match(/id: `session-insights-[a-z-]+-\$\{sessionHash\}`/g) || []);
    const categories = (handler.match(/category: '[^']+'/g) || []);
    assert.ok(idSites.length >= 5, `expected >=5 issue push sites, found ${idSites.length}`);
    assert.equal(categories.length, idSites.length,
      'each session-insights issue push must set a category');
  });

  it('handler category values exactly match the renderer\'s "Group by category" list', () => {
    const handlerCats = new Set(
      [...handler.matchAll(/category: '([^']+)'/g)].map(m => m[1])
    );
    // Renderer lists groups as markdown bullets after "Group by category:".
    const groupBlock = skill.slice(skill.indexOf('Group by category'));
    const rendererCats = new Set(
      [...groupBlock.matchAll(/^- (Tool Failures|Long Sessions|Circuit Breaker|File Churn|Hook Failures)$/gm)]
        .map(m => m[1])
    );
    assert.deepEqual([...handlerCats].sort(), [...rendererCats].sort(),
      'handler categories and renderer groups must be identical sets');
  });
});

// ─── F40: reapply-patches references a real version source ───

describe('F40 — reapply-patches version source', () => {
  const md = read('commands/nf/reapply-patches.md');
  it('does not reference a non-existent VERSION file', () => {
    assert.ok(!/\{read VERSION file\}/.test(md), 'no top-level VERSION file exists');
    assert.ok(!fs.existsSync(path.join(REPO, 'VERSION')), 'sanity: there really is no VERSION file');
  });
  it('points at package.json for the version', () => {
    assert.ok(/package\.json/.test(md), 'should read the version from package.json');
  });
});

// ─── F41: link-daintree banners + command name ───

describe('F41 — link-daintree naming', () => {
  const md = read('commands/nf/link-daintree.md');
  it('no stale "LINK CANOPY" banner', () => {
    assert.ok(!/LINK CANOPY/.test(md), 'banners must say LINK DAINTREE');
  });
  it('does not tell users to run the removed /nf:link-canopy command', () => {
    assert.ok(!/\/nf:link-canopy/.test(md), '/nf:link-canopy no longer exists');
    assert.ok(!fs.existsSync(path.join(REPO, 'commands/nf/link-canopy.md')), 'sanity: command is gone');
    assert.ok(/\/nf:link-daintree/.test(md), 'should reference /nf:link-daintree');
  });
  it('keeps the intentional canopy-app legacy path fallback', () => {
    assert.ok(/canopy-app/.test(md), 'legacy canopy-app install paths must still be supported');
  });
});

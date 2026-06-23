'use strict';
// bin/changelog-sections.test.cjs
// Unit tests for the CHANGELOG section-dedup tool + a live gate asserting the
// repo's CHANGELOG has no duplicate `### Section` headers within a version block.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { findDuplicateSections, fixDuplicates } = require('./lint-changelog-sections.cjs');

const sample = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Added',
  '- a1',
  '- a2',
  '',
  '### Fixed',
  '- f1',
  '',
  '### Added',
  '- a3',
  '',
  '### Fixed',
  '- f2',
  '- f3',
  '',
  '## [0.1.0]',
  '',
  '### Fixed',
  '- old1',
  '',
].join('\n');

describe('findDuplicateSections', () => {
  it('reports each section name duplicated within a version block', () => {
    const d = findDuplicateSections(sample);
    const added = d.find((x) => x.section === 'Added');
    const fixed = d.find((x) => x.section === 'Fixed');
    assert.ok(added && added.count === 2, 'Added should be flagged 2x');
    assert.ok(fixed && fixed.count === 2, 'Fixed should be flagged 2x');
    // the single Fixed under [0.1.0] must NOT be flagged
    assert.ok(!d.some((x) => x.version.includes('0.1.0')), '0.1.0 has no dups');
  });

  it('returns [] for a clean changelog', () => {
    const clean = '# C\n\n## [Unreleased]\n\n### Fixed\n- x\n';
    assert.deepEqual(findDuplicateSections(clean), []);
  });
});

describe('fixDuplicates', () => {
  it('merges duplicate sections, preserving every bullet in order', () => {
    const fixed = fixDuplicates(sample);
    // exactly one Added and one Fixed under [Unreleased]
    const unreleased = fixed.split('## [0.1.0]')[0];
    assert.equal((unreleased.match(/^### Added$/gm) || []).length, 1);
    assert.equal((unreleased.match(/^### Fixed$/gm) || []).length, 1);
    // all bullets survive
    for (const b of ['- a1', '- a2', '- a3', '- f1', '- f2', '- f3']) {
      assert.ok(fixed.includes(b), `bullet ${b} must survive the merge`);
    }
    // Added bullets come before Fixed bullets (section order preserved)
    assert.ok(fixed.indexOf('- a3') < fixed.indexOf('### Fixed'), 'merged Added bullets stay under Added');
    // the [0.1.0] block's single Fixed is untouched
    assert.ok(fixed.includes('- old1'));
  });

  it('is idempotent (fixing a clean file is a no-op for sections)', () => {
    const once = fixDuplicates(sample);
    assert.deepEqual(findDuplicateSections(once), []);
  });
});

describe('the live CHANGELOG has no duplicate sections (gate)', () => {
  it('CHANGELOG.md has at most one of each ### section per version block', () => {
    const p = path.join(__dirname, '..', 'CHANGELOG.md');
    const dups = findDuplicateSections(fs.readFileSync(p, 'utf8'));
    assert.deepEqual(dups, [], `duplicate sections found (run: node bin/lint-changelog-sections.cjs --fix):\n${JSON.stringify(dups, null, 2)}`);
  });
});

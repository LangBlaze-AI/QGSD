#!/usr/bin/env node
'use strict';
// bin/git-history-evidence.test.cjs
// Unit tests for git-history-evidence.cjs commit classification and TLA+ cross-ref logic.
// Requirements: QUICK-218

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  parseArgs,
  validateSince,
  classifyCommit,
  buildTlaCoverageReverseMap,
  getTlaCrossRefs,
  computeFileBreakdown,
  SINCE_PATTERN,
  COMMIT_TYPES,
} = require('./git-history-evidence.cjs');

// ── classifyCommit tests ────────────────────────────────────────────────────

describe('classifyCommit', () => {
  test('classifies feat( prefix', () => {
    assert.strictEqual(classifyCommit('feat(auth): add login'), 'feat');
  });

  test('classifies feat: prefix', () => {
    assert.strictEqual(classifyCommit('feat: new feature'), 'feat');
  });

  test('classifies "add " prefix as feat', () => {
    assert.strictEqual(classifyCommit('add user registration'), 'feat');
  });

  test('classifies fix( prefix', () => {
    assert.strictEqual(classifyCommit('fix(api): null pointer'), 'fix');
  });

  test('classifies fix: prefix', () => {
    assert.strictEqual(classifyCommit('fix: broken login'), 'fix');
  });

  test('classifies bugfix keyword', () => {
    assert.strictEqual(classifyCommit('applied bugfix for crash'), 'fix');
  });

  test('classifies hotfix keyword', () => {
    assert.strictEqual(classifyCommit('hotfix for production'), 'fix');
  });

  test('classifies patch keyword', () => {
    assert.strictEqual(classifyCommit('patch security vulnerability'), 'fix');
  });

  test('classifies refactor( prefix', () => {
    assert.strictEqual(classifyCommit('refactor(core): simplify logic'), 'refactor');
  });

  test('classifies refactor: prefix', () => {
    assert.strictEqual(classifyCommit('refactor: clean up'), 'refactor');
  });

  test('classifies docs( prefix', () => {
    assert.strictEqual(classifyCommit('docs(readme): update install'), 'docs');
  });

  test('classifies docs: prefix', () => {
    assert.strictEqual(classifyCommit('docs: add API docs'), 'docs');
  });

  test('classifies test( prefix', () => {
    assert.strictEqual(classifyCommit('test(auth): add unit tests'), 'test');
  });

  test('classifies test: prefix', () => {
    assert.strictEqual(classifyCommit('test: coverage increase'), 'test');
  });

  test('classifies tests( prefix', () => {
    assert.strictEqual(classifyCommit('tests(api): integration'), 'test');
  });

  test('classifies build( prefix', () => {
    assert.strictEqual(classifyCommit('build(webpack): update config'), 'build');
  });

  test('classifies ci( prefix', () => {
    assert.strictEqual(classifyCommit('ci(github): add workflow'), 'build');
  });

  test('classifies chore( prefix as build', () => {
    assert.strictEqual(classifyCommit('chore(deps): bump version'), 'build');
  });

  test('falls back to chore for unrecognized messages', () => {
    assert.strictEqual(classifyCommit('update something or other'), 'chore');
    assert.strictEqual(classifyCommit('WIP'), 'chore');
    assert.strictEqual(classifyCommit('initial commit'), 'chore');
  });

  test('returns chore for empty/null/undefined', () => {
    assert.strictEqual(classifyCommit(''), 'chore');
    assert.strictEqual(classifyCommit(null), 'chore');
    assert.strictEqual(classifyCommit(undefined), 'chore');
  });

  test('is case-insensitive', () => {
    assert.strictEqual(classifyCommit('FEAT: big feature'), 'feat');
    assert.strictEqual(classifyCommit('Fix(bug): something'), 'fix');
    assert.strictEqual(classifyCommit('DOCS: readme'), 'docs');
  });
});

// ── buildTlaCoverageReverseMap tests ────────────────────────────────────────

describe('buildTlaCoverageReverseMap', () => {
  test('returns empty map for non-existent root', () => {
    const map = buildTlaCoverageReverseMap('/tmp/nonexistent-dir-xyz-999');
    assert.deepStrictEqual(map, {});
  });

  test('returns empty map when model-registry.json is missing', () => {
    const map = buildTlaCoverageReverseMap('/tmp');
    assert.deepStrictEqual(map, {});
  });
});

// ── getTlaCrossRefs tests ───────────────────────────────────────────────────

describe('getTlaCrossRefs', () => {
  test('returns direct match', () => {
    const map = { 'hooks/nf-prompt.js': ['.planning/formal/tla/Prompt.tla'] };
    assert.deepStrictEqual(getTlaCrossRefs('hooks/nf-prompt.js', map), ['.planning/formal/tla/Prompt.tla']);
  });

  test('returns suffix match', () => {
    const map = { 'hooks/nf-stop.js': ['.planning/formal/tla/Stop.tla'] };
    assert.deepStrictEqual(getTlaCrossRefs('some/prefix/hooks/nf-stop.js', map), ['.planning/formal/tla/Stop.tla']);
  });

  test('returns empty array for no match', () => {
    const map = { 'hooks/nf-prompt.js': ['.planning/formal/tla/Prompt.tla'] };
    assert.deepStrictEqual(getTlaCrossRefs('bin/install.js', map), []);
  });

  test('handles empty map', () => {
    assert.deepStrictEqual(getTlaCrossRefs('hooks/nf-prompt.js', {}), []);
  });
});

describe('getTlaCrossRefs prototype-key hardening', () => {
  test('returns [] for filename colliding with an inherited Object.prototype key', () => {
    assert.deepStrictEqual(getTlaCrossRefs('constructor', {}), []);
    assert.deepStrictEqual(getTlaCrossRefs('__proto__', {}), []);
    assert.deepStrictEqual(getTlaCrossRefs('hasOwnProperty', {}), []);
  });

  test('result is always an array (iterable) even for prototype-key filenames', () => {
    const refs = getTlaCrossRefs('toString', { 'hooks/x.js': ['Spec.tla'] });
    assert.ok(Array.isArray(refs), 'must return an array');
    // must not throw when iterated downstream
    assert.doesNotThrow(() => { for (const _ of refs) { /* noop */ } });
  });
});

describe('getTlaCrossRefs empty-filename hardening', () => {
  test('returns [] for empty-string filename instead of the first entry specs', () => {
    const map = { 'hooks/nf-prompt.js': ['.planning/formal/tla/Prompt.tla'] };
    assert.deepStrictEqual(getTlaCrossRefs('', map), []);
  });

  test('returns [] for non-string filename', () => {
    const map = { 'hooks/nf-prompt.js': ['.planning/formal/tla/Prompt.tla'] };
    assert.deepStrictEqual(getTlaCrossRefs(null, map), []);
    assert.deepStrictEqual(getTlaCrossRefs(undefined, map), []);
  });
});

// ── computeFileBreakdown tests ──────────────────────────────────────────────

describe('computeFileBreakdown', () => {
  test('aggregates commits per file with type counts', () => {
    const commits = [
      { sha: 'aaa', message: 'feat: x', type: 'feat', files: ['a.js', 'b.js'], tla_cross_refs: [] },
      { sha: 'bbb', message: 'fix: y', type: 'fix', files: ['a.js'], tla_cross_refs: [] },
      { sha: 'ccc', message: 'feat: z', type: 'feat', files: ['a.js'], tla_cross_refs: [] },
    ];
    const reverseMap = {};
    const breakdown = computeFileBreakdown(commits, reverseMap);

    const aFile = breakdown.find(b => b.file === 'a.js');
    assert.ok(aFile, 'a.js should be in breakdown');
    assert.strictEqual(aFile.total_commits, 3);
    assert.strictEqual(aFile.by_type.feat, 2);
    assert.strictEqual(aFile.by_type.fix, 1);
    assert.strictEqual(aFile.dominant_type, 'feat');
    assert.strictEqual(aFile.has_tla_coverage, false);

    const bFile = breakdown.find(b => b.file === 'b.js');
    assert.ok(bFile, 'b.js should be in breakdown');
    assert.strictEqual(bFile.total_commits, 1);
    assert.strictEqual(bFile.dominant_type, 'feat');
  });

  test('marks TLA+ coverage when reverse map matches', () => {
    const commits = [
      { sha: 'aaa', message: 'feat: x', type: 'feat', files: ['hooks/nf-prompt.js'], tla_cross_refs: [] },
    ];
    const reverseMap = { 'hooks/nf-prompt.js': ['.planning/formal/tla/Prompt.tla'] };
    const breakdown = computeFileBreakdown(commits, reverseMap);

    assert.strictEqual(breakdown[0].has_tla_coverage, true);
    assert.deepStrictEqual(breakdown[0].tla_specs, ['.planning/formal/tla/Prompt.tla']);
  });

  test('returns empty array for empty commits', () => {
    assert.deepStrictEqual(computeFileBreakdown([], {}), []);
  });

  test('sorts by total_commits descending', () => {
    const commits = [
      { sha: 'a', type: 'feat', files: ['x.js'], tla_cross_refs: [] },
      { sha: 'b', type: 'feat', files: ['y.js'], tla_cross_refs: [] },
      { sha: 'c', type: 'fix', files: ['y.js'], tla_cross_refs: [] },
    ];
    const breakdown = computeFileBreakdown(commits, {});
    assert.strictEqual(breakdown[0].file, 'y.js');
    assert.strictEqual(breakdown[1].file, 'x.js');
  });
});

// ── validateSince tests ─────────────────────────────────────────────────────

describe('validateSince', () => {
  test('accepts valid date strings', () => {
    assert.doesNotThrow(() => validateSince('2024-01-01'));
    assert.doesNotThrow(() => validateSince('2024-01-01T00:00:00Z'));
  });

  test('rejects injection attempts', () => {
    assert.throws(() => validateSince('2024-01-01; rm -rf /'), /Invalid --since/);
    assert.throws(() => validateSince('$(whoami)'), /Invalid --since/);
    assert.throws(() => validateSince('`id`'), /Invalid --since/);
  });

  test('accepts null/undefined without error', () => {
    assert.doesNotThrow(() => validateSince(null));
    assert.doesNotThrow(() => validateSince(undefined));
  });
});

// ── parseArgs tests ─────────────────────────────────────────────────────────

describe('parseArgs', () => {
  test('parses --json flag', () => {
    const args = parseArgs(['node', 'script', '--json']);
    assert.strictEqual(args.json, true);
  });

  test('parses --since', () => {
    const args = parseArgs(['node', 'script', '--since=2024-06-01']);
    assert.strictEqual(args.since, '2024-06-01');
  });

  test('parses --project-root', () => {
    const args = parseArgs(['node', 'script', '--project-root=/tmp/repo']);
    assert.strictEqual(args.projectRoot, '/tmp/repo');
  });

  test('defaults to cwd and no flags', () => {
    const args = parseArgs(['node', 'script']);
    assert.strictEqual(args.json, false);
    assert.strictEqual(args.since, null);
    assert.strictEqual(args.projectRoot, process.cwd());
  });
});

// ── COMMIT_TYPES sanity ─────────────────────────────────────────────────────

describe('COMMIT_TYPES', () => {
  test('has exactly 7 types', () => {
    assert.strictEqual(COMMIT_TYPES.length, 7);
    assert.ok(COMMIT_TYPES.includes('feat'));
    assert.ok(COMMIT_TYPES.includes('fix'));
    assert.ok(COMMIT_TYPES.includes('refactor'));
    assert.ok(COMMIT_TYPES.includes('docs'));
    assert.ok(COMMIT_TYPES.includes('test'));
    assert.ok(COMMIT_TYPES.includes('build'));
    assert.ok(COMMIT_TYPES.includes('chore'));
  });
});

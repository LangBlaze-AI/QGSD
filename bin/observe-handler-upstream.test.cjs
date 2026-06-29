/**
 * Tests for observe-handler-upstream.cjs
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  handleUpstream,
  loadUpstreamState,
  saveUpstreamState,
  fetchReleases,
  fetchNotablePRs,
  classifyUpstreamSeverity,
  INSPIRATION_KEYWORDS
} = require('./observe-handler-upstream.cjs');
const { formatAge, parseDuration } = require('./observe-utils.cjs');

// Helper: create temp dir for state file tests
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-test-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  return dir;
}

describe('parseDuration', () => {
  it('parses days', () => {
    assert.equal(parseDuration('7d'), 7 * 86400000);
  });
  it('parses hours', () => {
    assert.equal(parseDuration('24h'), 24 * 3600000);
  });
  it('returns 0 for invalid', () => {
    assert.equal(parseDuration('abc'), 0);
    assert.equal(parseDuration(null), 0);
  });
});

describe('formatAge', () => {
  it('formats recent as minutes', () => {
    const recent = new Date(Date.now() - 5 * 60000).toISOString();
    assert.equal(formatAge(recent), '5m');
  });
  it('formats hours', () => {
    const hours = new Date(Date.now() - 3 * 3600000).toISOString();
    assert.equal(formatAge(hours), '3h');
  });
  it('formats days', () => {
    const days = new Date(Date.now() - 2 * 86400000).toISOString();
    assert.equal(formatAge(days), '2d');
  });
  it('returns unknown for null', () => {
    assert.equal(formatAge(null), 'unknown');
  });
});

describe('classifyUpstreamSeverity', () => {
  it('returns warning for breaking release', () => {
    assert.equal(classifyUpstreamSeverity({ name: 'Breaking Changes v2', tagName: 'v2.0.0' }, 'release'), 'warning');
  });
  it('returns warning for major version bump', () => {
    assert.equal(classifyUpstreamSeverity({ name: 'v3.0.0', tagName: 'v3.0.0' }, 'release'), 'warning');
  });
  it('returns info for normal release', () => {
    assert.equal(classifyUpstreamSeverity({ name: 'v1.2.3', tagName: 'v1.2.3' }, 'release'), 'info');
  });
  it('returns warning for security PR', () => {
    assert.equal(classifyUpstreamSeverity({ title: 'security: fix XSS vulnerability' }, 'pr'), 'warning');
  });
  it('returns info for feature PR', () => {
    assert.equal(classifyUpstreamSeverity({ title: 'feat: add new plugin system' }, 'pr'), 'info');
  });
});

describe('loadUpstreamState / saveUpstreamState', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns empty object when no state file', () => {
    const state = loadUpstreamState(tmpDir);
    assert.deepEqual(state, {});
  });

  it('round-trips state', () => {
    const state = { 'owner/repo': { last_checked: '2026-01-01T00:00:00Z', coupling: 'tight' } };
    saveUpstreamState(state, tmpDir);
    const loaded = loadUpstreamState(tmpDir);
    assert.deepEqual(loaded, state);
  });
});

describe('fetchReleases', () => {
  it('parses gh release list output', () => {
    const mockExec = (cmd, args) => {
      if (cmd === 'gh' && args[0] === 'release') {
        return JSON.stringify([
          { tagName: 'v1.2.0', name: 'Release 1.2.0', publishedAt: '2026-03-01T00:00:00Z', isPrerelease: false, url: 'https://github.com/o/r/releases/tag/v1.2.0' },
          { tagName: 'v1.1.0', name: 'Release 1.1.0', publishedAt: '2026-01-01T00:00:00Z', isPrerelease: false, url: 'https://github.com/o/r/releases/tag/v1.1.0' }
        ]);
      }
      return '[]';
    };
    const releases = fetchReleases('o/r', '2026-02-01T00:00:00Z', 10, mockExec);
    assert.equal(releases.length, 1);
    assert.equal(releases[0].tagName, 'v1.2.0');
  });

  it('returns empty array on error', () => {
    const mockExec = () => { throw new Error('gh not found'); };
    const releases = fetchReleases('o/r', null, 10, mockExec);
    assert.deepEqual(releases, []);
  });
});

describe('fetchNotablePRs', () => {
  it('filters by keyword match', () => {
    const mockExec = (cmd, args) => {
      if (cmd === 'gh' && args[0] === 'pr') {
        return JSON.stringify([
          { number: 1, title: 'feat: add plugin hooks', mergedAt: '2026-03-01T00:00:00Z', changedFiles: 2, additions: 30, deletions: 5, url: '' },
          { number: 2, title: 'chore: update deps', mergedAt: '2026-03-01T00:00:00Z', changedFiles: 1, additions: 5, deletions: 5, url: '' },
          { number: 3, title: 'big refactor of core', mergedAt: '2026-03-01T00:00:00Z', changedFiles: 3, additions: 20, deletions: 10, url: '' }
        ]);
      }
      return '[]';
    };
    const prs = fetchNotablePRs('o/r', null, 10, mockExec);
    // PR 1 matches 'feat', PR 3 matches 'refactor', PR 2 is filtered out
    assert.equal(prs.length, 2);
    assert.equal(prs[0].number, 1);
    assert.equal(prs[1].number, 3);
  });

  it('includes PRs by size threshold', () => {
    const mockExec = () => JSON.stringify([
      { number: 10, title: 'misc update', mergedAt: '2026-03-01T00:00:00Z', changedFiles: 8, additions: 200, deletions: 50, url: '' }
    ]);
    const prs = fetchNotablePRs('o/r', null, 10, mockExec);
    assert.equal(prs.length, 1);
  });
});

describe('handleUpstream', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns error when no repo configured', () => {
    const result = handleUpstream({ type: 'upstream', label: 'Test' }, { basePath: tmpDir });
    assert.equal(result.status, 'error');
    assert.match(result.error, /No repo configured/);
  });

  it('fetches releases for tight coupling', () => {
    const mockExec = (cmd, args) => {
      if (args[0] === 'release') {
        return JSON.stringify([
          { tagName: 'v0.27.0', name: 'v0.27.0', publishedAt: new Date().toISOString(), isPrerelease: false, url: 'https://github.com/nf-build/get-shit-done/releases/tag/v0.27.0' }
        ]);
      }
      return '[]';
    };

    const result = handleUpstream(
      { type: 'upstream', label: 'NF', repo: 'nf-build/get-shit-done', coupling: 'tight', filter: { since: '30d' } },
      { execFn: mockExec, basePath: tmpDir }
    );

    assert.equal(result.status, 'ok');
    assert.equal(result.issues.length, 1);
    assert.match(result.issues[0].title, /\[Evaluate\]/);
    assert.equal(result.issues[0].issue_type, 'upstream');
  });

  it('fetches releases + notable PRs for loose coupling', () => {
    const mockExec = (cmd, args) => {
      if (args[0] === 'release') {
        return JSON.stringify([
          { tagName: 'v1.0.0', name: 'v1.0.0', publishedAt: new Date().toISOString(), isPrerelease: false, url: '' }
        ]);
      }
      if (args[0] === 'pr') {
        return JSON.stringify([
          { number: 42, title: 'feat: new agent pattern', mergedAt: new Date().toISOString(), changedFiles: 3, additions: 50, deletions: 10, url: '' }
        ]);
      }
      return '[]';
    };

    const result = handleUpstream(
      { type: 'upstream', label: 'Inspo', repo: 'affaan-m/everything-claude-code', coupling: 'loose', filter: { since: '14d' } },
      { execFn: mockExec, basePath: tmpDir }
    );

    assert.equal(result.status, 'ok');
    assert.equal(result.issues.length, 2);
    assert.match(result.issues[0].title, /\[Inspiration\]/);
    assert.match(result.issues[1].title, /\[Inspiration\]/);
  });

  it('persists state after fetch', () => {
    const mockExec = () => JSON.stringify([]);
    handleUpstream(
      { type: 'upstream', label: 'Test', repo: 'test/repo', coupling: 'tight', filter: { since: '7d' } },
      { execFn: mockExec, basePath: tmpDir }
    );

    const state = loadUpstreamState(tmpDir);
    assert.ok(state['test/repo']);
    assert.ok(state['test/repo'].last_checked);
    assert.equal(state['test/repo'].coupling, 'tight');
  });

  it('uses state last_checked as cursor on subsequent runs', () => {
    // Pre-seed state with a recent check
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    saveUpstreamState({ 'test/repo': { last_checked: yesterday, coupling: 'tight' } }, tmpDir);

    let capturedArgs;
    const mockExec = (cmd, args) => {
      capturedArgs = args;
      return JSON.stringify([]);
    };

    handleUpstream(
      { type: 'upstream', label: 'Test', repo: 'test/repo', coupling: 'tight' },
      { execFn: mockExec, basePath: tmpDir }
    );

    // State should be updated to now
    const state = loadUpstreamState(tmpDir);
    assert.ok(new Date(state['test/repo'].last_checked).getTime() > new Date(yesterday).getTime());
  });
});

describe('INSPIRATION_KEYWORDS', () => {
  it('contains expected keywords', () => {
    assert.ok(INSPIRATION_KEYWORDS.includes('feat'));
    assert.ok(INSPIRATION_KEYWORDS.includes('pattern'));
    assert.ok(INSPIRATION_KEYWORDS.includes('harden'));
    assert.ok(INSPIRATION_KEYWORDS.includes('security'));
    assert.ok(INSPIRATION_KEYWORDS.includes('agent'));
  });
});

// Regression: `url` is NOT a valid `gh release list --json` field — requesting it
// makes gh exit non-zero ("Unknown JSON field: url"), the try/catch swallows it,
// and ALL upstream release detection silently returns []. The URL is reconstructed
// from tagName instead.
describe('fetchReleases — gh release list field hygiene', () => {
  it('does not request the invalid `url` json field', () => {
    let capturedArgs = null;
    const execFn = (_cmd, args) => {
      capturedArgs = args;
      return JSON.stringify([
        { tagName: 'v1.2.3', name: 'Release', publishedAt: new Date().toISOString(), isPrerelease: false },
      ]);
    };
    const releases = fetchReleases('owner/repo', null, 5, execFn);
    const jsonIdx = capturedArgs.indexOf('--json');
    const fields = capturedArgs[jsonIdx + 1];
    assert.ok(!/\burl\b/.test(fields), `gh release list must not request 'url' (got: ${fields})`);
    assert.equal(releases.length, 1);
    assert.equal(releases[0].tagName, 'v1.2.3');
  });

  it('fails open to [] when gh errors (does not throw)', () => {
    const execFn = () => { throw new Error('Unknown JSON field: "url"'); };
    assert.deepEqual(fetchReleases('owner/repo', null, 5, execFn), []);
  });
});

describe('fetchReleases — unparseable since does not suppress all releases', () => {
  it('surfaces releases when the cutoff date is corrupt (NaN)', () => {
    const mockExec = () => JSON.stringify([
      { tagName: 'v2.0.0', name: 'R2', publishedAt: '2026-05-01T00:00:00Z', isPrerelease: false },
      { tagName: 'v1.0.0', name: 'R1', publishedAt: '2026-04-01T00:00:00Z', isPrerelease: false }
    ]);
    // 'not-a-date' -> new Date(...).getTime() === NaN -> every `> NaN` is false
    const releases = fetchReleases('o/r', 'not-a-date', 10, mockExec);
    assert.equal(releases.length, 2);
  });
});

describe('fetchNotablePRs — unparseable since does not suppress all PRs', () => {
  it('surfaces notable PRs when the cutoff date is corrupt (NaN)', () => {
    const mockExec = () => JSON.stringify([
      { number: 7, title: 'feat: x', mergedAt: '2026-05-01T00:00:00Z', changedFiles: 6, additions: 120, deletions: 1, url: '' }
    ]);
    const prs = fetchNotablePRs('o/r', 'not-a-date', 10, mockExec);
    assert.equal(prs.length, 1);
  });
});

describe('fetchReleases — non-array gh JSON fails open to []', () => {
  it('returns [] (not a raw object) when gh emits non-array JSON and since is falsy', () => {
    const mockExec = () => JSON.stringify({ unexpected: true });
    const releases = fetchReleases('o/r', null, 10, mockExec);
    assert.ok(Array.isArray(releases));
    assert.equal(releases.length, 0);
  });
});

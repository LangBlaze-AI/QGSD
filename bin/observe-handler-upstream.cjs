/**
 * Upstream tracking handler for /nf:observe
 * Fetches releases (and notable PRs for loose coupling) from upstream repos via gh CLI
 *
 * Coupling modes:
 *   tight  — All releases since last check (evaluate for cherry-pick — our code may already be better)
 *   loose  — Releases + notable merged PRs (inspirational — patterns, features, hardening)
 *
 * State persisted in .planning/upstream-state.json to track last-checked date per upstream
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parseDuration, formatAge } = require('./observe-utils.cjs');

const STATE_FILE = '.planning/upstream-state.json';

// Keywords that signal an inspirational change worth surfacing (loose coupling)
const INSPIRATION_KEYWORDS = [
  'feat', 'feature', 'pattern', 'harden', 'security', 'perf', 'refactor',
  'breaking', 'architecture', 'plugin', 'hook', 'workflow', 'agent'
];

/**
 * Load upstream state (last-checked timestamps per repo)
 * @param {string} [basePath]
 * @returns {object} { [repo]: { last_checked: ISO8601, last_release_tag: string } }
 */
function loadUpstreamState(basePath) {
  const stateFile = path.resolve(basePath || process.cwd(), STATE_FILE);
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Save upstream state
 * @param {object} state
 * @param {string} [basePath]
 */
function saveUpstreamState(state, basePath) {
  const stateFile = path.resolve(basePath || process.cwd(), STATE_FILE);
  const dir = path.dirname(stateFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Fetch releases from upstream repo since a cutoff date
 * @param {string} repo - owner/repo
 * @param {string} since - ISO8601 cutoff
 * @param {number} limit
 * @param {Function} execFn
 * @returns {Array} releases
 */
function fetchReleases(repo, since, limit, execFn) {
  const execFile = execFn || execFileSync;
  try {
    const output = execFile('gh', [
      'release', 'list', '--repo', repo,
      '--limit', String(limit),
      // NOTE: `url` is NOT a valid field for `gh release list --json` (it exists
      // only on `gh release view`). Including it makes gh exit non-zero with
      // "Unknown JSON field: url", which the caller's try/catch swallows → ALL
      // upstream release detection silently returns []. The release URL is
      // reconstructed from `tagName` below.
      '--json', 'tagName,name,publishedAt,isPrerelease'
    ], { encoding: 'utf8' });
    let releases = JSON.parse(output);
    if (since) {
      const cutoff = new Date(since).getTime();
      releases = releases.filter(r => new Date(r.publishedAt).getTime() > cutoff);
    }
    return releases;
  } catch {
    return [];
  }
}

/**
 * Fetch notable merged PRs from upstream repo (for loose/inspirational coupling)
 * Filters by keyword matches in title or size threshold
 * @param {string} repo
 * @param {string} since - ISO8601 cutoff
 * @param {number} limit
 * @param {Function} execFn
 * @returns {Array} PRs
 */
function fetchNotablePRs(repo, since, limit, execFn) {
  const execFile = execFn || execFileSync;
  try {
    const output = execFile('gh', [
      'pr', 'list', '--repo', repo,
      '--state', 'merged',
      '--limit', String(limit * 3), // fetch more, filter down
      '--json', 'number,title,url,mergedAt,changedFiles,additions,deletions,labels'
    ], { encoding: 'utf8' });
    let prs = JSON.parse(output);

    // Filter by date
    if (since) {
      const cutoff = new Date(since).getTime();
      prs = prs.filter(pr => pr.mergedAt && new Date(pr.mergedAt).getTime() > cutoff);
    }

    // Filter for "notable" PRs — keyword match OR substantial size
    prs = prs.filter(pr => {
      const title = (pr.title || '').toLowerCase();
      const hasKeyword = INSPIRATION_KEYWORDS.some(kw => title.includes(kw));
      const isSubstantial = (pr.changedFiles || 0) >= 5 || (pr.additions || 0) >= 100;
      return hasKeyword || isSubstantial;
    });

    return prs.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Classify severity/interest level from release or PR
 * @param {object} item - release or PR object
 * @param {string} itemType - 'release' or 'pr'
 * @returns {string} severity string
 */
function classifyUpstreamSeverity(item, itemType) {
  if (itemType === 'release') {
    const name = ((item.name || '') + ' ' + (item.tagName || '')).toLowerCase();
    if (name.includes('breaking') || /\d+\.0\.0/.test(item.tagName || '')) return 'warning';
    if (item.isPrerelease) return 'info';
    return 'info';
  }
  // PR
  const title = (item.title || '').toLowerCase();
  if (title.includes('breaking') || title.includes('security') || title.includes('harden')) return 'warning';
  if (title.includes('feat') || title.includes('pattern') || title.includes('refactor')) return 'info';
  return 'info';
}

// Keywords that signal incompatible/breaking changes
const BREAKING_KEYWORDS = ['breaking', 'remove', 'deprecat', 'drop', 'incompatible'];

// Keywords that signal candidate changes worth evaluating
const CANDIDATE_KEYWORDS = ['feat', 'feature', 'fix', 'perf', 'security', 'harden', 'plugin', 'hook'];

/**
 * Classify an upstream change as SKIP, CANDIDATE, or INCOMPATIBLE (OBS-11)
 * Evaluates whether an upstream release or PR should be ported/adopted.
 *
 * @param {object} item - Release or PR object with title/name/tagName fields
 * @param {string} coupling - 'tight' or 'loose'
 * @returns {'SKIP'|'CANDIDATE'|'INCOMPATIBLE'} Classification result
 */
function classifyUpstreamOverlap(item, coupling) {
  const text = ((item.title || '') + ' ' + (item.name || '') + ' ' + (item.tagName || '')).toLowerCase();

  // Check for breaking/incompatible signals first
  if (BREAKING_KEYWORDS.some(kw => text.includes(kw))) {
    return 'INCOMPATIBLE';
  }

  // For tight coupling: major version bumps are incompatible
  if (coupling === 'tight' && item.tagName && /\d+\.0\.0/.test(item.tagName)) {
    return 'INCOMPATIBLE';
  }

  // Check for candidate signals
  if (CANDIDATE_KEYWORDS.some(kw => text.includes(kw))) {
    return 'CANDIDATE';
  }

  // Default: skip — not relevant enough to evaluate
  return 'SKIP';
}

/**
 * Upstream source handler
 * @param {object} sourceConfig - { type, label, repo, coupling, branch?, filter?: { since } }
 * @param {object} options - { sinceOverride?, limitOverride?, execFn?, basePath? }
 * @returns {object} Standard observe schema result
 */
function handleUpstream(sourceConfig, options) {
  const label = sourceConfig.label || 'Upstream';
  const execFile = options.execFn || execFileSync;
  const basePath = options.basePath || process.cwd();
  const coupling = sourceConfig.coupling || 'loose';
  const repo = sourceConfig.repo;

  if (!repo) {
    return {
      source_label: label,
      source_type: 'upstream',
      status: 'error',
      error: 'No repo configured for upstream source',
      issues: []
    };
  }

  try {
    // Determine cutoff date
    const state = loadUpstreamState(basePath);
    const repoState = state[repo] || {};
    const filter = sourceConfig.filter || {};
    const sinceOverride = options.sinceOverride || filter.since;

    let since;
    if (repoState.last_checked) {
      since = repoState.last_checked;
    } else if (sinceOverride) {
      const ms = parseDuration(sinceOverride);
      since = ms > 0 ? new Date(Date.now() - ms).toISOString() : null;
    } else {
      // Default: 14 days for first run
      since = new Date(Date.now() - 14 * 86400000).toISOString();
    }

    const limit = options.limitOverride || filter.limit || 10;
    const issues = [];

    // Both tight and loose get releases
    const releases = fetchReleases(repo, since, limit, execFile);
    for (const rel of releases) {
      issues.push({
        id: `upstream-rel-${repo}-${rel.tagName}`,
        title: `[${coupling === 'tight' ? 'Evaluate' : 'Inspiration'}] ${rel.name || rel.tagName}`,
        severity: classifyUpstreamSeverity(rel, 'release'),
        url: rel.url || `https://github.com/${repo}/releases/tag/${rel.tagName}`,
        age: formatAge(rel.publishedAt),
        created_at: rel.publishedAt || new Date().toISOString(),
        meta: `${repo} ${rel.tagName}${rel.isPrerelease ? ' (pre-release)' : ''}`,
        source_type: 'upstream',
        issue_type: 'upstream',
        _upstream: { coupling, repo, tag: rel.tagName, classification: classifyUpstreamOverlap(rel, coupling) }
      });
    }

    // Loose coupling: also fetch notable merged PRs
    if (coupling === 'loose') {
      const prs = fetchNotablePRs(repo, since, limit, execFile);
      for (const pr of prs) {
        issues.push({
          id: `upstream-pr-${repo}-${pr.number}`,
          title: `[Inspiration] ${pr.title}`,
          severity: classifyUpstreamSeverity(pr, 'pr'),
          url: pr.url || `https://github.com/${repo}/pull/${pr.number}`,
          age: formatAge(pr.mergedAt),
          created_at: pr.mergedAt || new Date().toISOString(),
          meta: `${repo} #${pr.number} (+${pr.additions || 0}/-${pr.deletions || 0}, ${pr.changedFiles || 0} files)`,
          source_type: 'upstream',
          issue_type: 'upstream',
          _upstream: { coupling, repo, pr: pr.number, classification: classifyUpstreamOverlap(pr, coupling) }
        });
      }
    }

    // Update state
    state[repo] = {
      last_checked: new Date().toISOString(),
      last_release_tag: releases.length > 0 ? releases[0].tagName : (repoState.last_release_tag || null),
      coupling
    };
    saveUpstreamState(state, basePath);

    return {
      source_label: label,
      source_type: 'upstream',
      status: 'ok',
      issues
    };
  } catch (err) {
    return {
      source_label: label,
      source_type: 'upstream',
      status: 'error',
      error: `Upstream fetch failed: ${err.message}`,
      issues: []
    };
  }
}

module.exports = {
  handleUpstream,
  loadUpstreamState,
  saveUpstreamState,
  fetchReleases,
  fetchNotablePRs,
  classifyUpstreamSeverity,
  classifyUpstreamOverlap,
  INSPIRATION_KEYWORDS
};

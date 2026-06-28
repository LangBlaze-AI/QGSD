#!/usr/bin/env node
'use strict';
// bin/repowise/hotspot.cjs — Git-log churn scoring + heuristic complexity for Repowise hotspot detection

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { escapeXml } = require('./escape-xml.cjs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_EXCLUDE_PATTERNS = [
  /\/node_modules\//,
  /\/vendor\//,
  /\/dist\//,
  /\.min\.js$/,
  /\.min\.css$/,
  /package-lock\.json/,
  /\.generated\./,
  /\/\.planning\/|^[.]planning\//,
  /\/__snapshots__\//,
];

const DEFAULT_MASS_REFACTOR_THRESHOLD = 50;

const MAX_BUFFER = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Noise filtering
// ---------------------------------------------------------------------------

function isExcluded(filePath, excludePatterns) {
  const patterns = excludePatterns || DEFAULT_EXCLUDE_PATTERNS;
  for (const pat of patterns) {
    if (pat.test(filePath)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Git numstat parsing (HOT-01)
// ---------------------------------------------------------------------------

function parseGitNumstat(projectRoot, options) {
  const opts = options || {};
  const args = ['log', '--all', '--no-merges', '--numstat', '--diff-filter=AMD', '--format=%h %s'];
  if (opts.since) args.push(`--since=${opts.since}`);

  let result;
  try {
    result = spawnSync('git', args, {
      cwd: projectRoot,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    return [];
  }

  if (result.error || result.status !== 0) return [];

  const output = result.stdout || '';
  if (!output.trim()) return [];

  const commits = [];
  let currentCommit = null;

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Commit header line: SHA message
    const commitMatch = trimmed.match(/^([0-9a-f]{7,40})\s+(.+)$/);
    if (commitMatch) {
      currentCommit = { sha: commitMatch[1], message: commitMatch[2], files: [] };
      commits.push(currentCommit);
      continue;
    }

    // Numstat line: added\tdelimited\tfilepath
    const numstatMatch = trimmed.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (numstatMatch && currentCommit) {
      const added = numstatMatch[1] === '-' ? 0 : parseInt(numstatMatch[1], 10);
      const deleted = numstatMatch[2] === '-' ? 0 : parseInt(numstatMatch[2], 10);
      const filePath = numstatMatch[3];
      currentCommit.files.push({ path: filePath, added, deleted });
    }
  }

  return commits;
}

// ---------------------------------------------------------------------------
// Churn scoring (HOT-01)
// ---------------------------------------------------------------------------

function computeChurnScores(commits, options) {
  const opts = options || {};
  const threshold = opts.massRefactorThreshold || DEFAULT_MASS_REFACTOR_THRESHOLD;
  const excludePatterns = opts.excludePatterns || DEFAULT_EXCLUDE_PATTERNS;
  const churnMap = new Map();

  for (const commit of (commits || [])) {
    const fileList = (commit && Array.isArray(commit.files)) ? commit.files : [];
    const fileCount = fileList.length;
    const weight = fileCount >= threshold
      ? 1 / Math.max(1, fileCount / threshold)
      : 1;

    for (const file of fileList) {
      if (isExcluded(file.path, excludePatterns)) continue;
      const current = churnMap.get(file.path) || 0;
      churnMap.set(file.path, current + weight);
    }
  }

  return churnMap;
}

// ---------------------------------------------------------------------------
// Reuse existing git-heatmap.json evidence (avoid re-parsing git history)
// ---------------------------------------------------------------------------

function loadHeatmapChurn(projectRoot) {
  const heatmapPath = path.join(projectRoot, '.planning', 'formal', 'evidence', 'git-heatmap.json');
  try {
    if (!fs.existsSync(heatmapPath)) return null;
    const data = JSON.parse(fs.readFileSync(heatmapPath, 'utf8'));
    if (!data || !data.signals || !data.signals.churn_ranking) return null;

    const churnMap = new Map();
    const bugfixMap = new Map();

    for (const entry of data.signals.churn_ranking) {
      if (!isExcluded(entry.file)) {
        churnMap.set(entry.file, entry.commits);
      }
    }

    for (const entry of (data.signals.bugfix_hotspots || [])) {
      if (!isExcluded(entry.file)) {
        bugfixMap.set(entry.file, entry.fix_count);
      }
    }

    return { churnMap, bugfixMap };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Heuristic complexity (HOT-03 partial — line count proxy)
// ---------------------------------------------------------------------------

const COMMENT_PREFIXES = ['//', '#', '/*', '*', '--'];

function estimateComplexity(filePath, projectRoot) {
  try {
    const fullPath = path.resolve(projectRoot, filePath);
    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split('\n');
    let count = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const isComment = COMMENT_PREFIXES.some(prefix => trimmed.startsWith(prefix));
      if (!isComment) count++;
    }
    return count;
  } catch (_) {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Normalization (HOT-03)
// ---------------------------------------------------------------------------

function normalizeMap(scoreMap) {
  if (scoreMap.size === 0) return new Map();

  const values = [...scoreMap.values()].map(v => (Number.isFinite(v) ? v : 0));
  const min = Math.min(...values);
  const max = Math.max(...values);

  const normalized = new Map();
  if (max === min) {
    for (const [key] of scoreMap) {
      normalized.set(key, 0.5);
    }
    return normalized;
  }

  const range = max - min;
  for (const [key, val] of scoreMap) {
    const v = Number.isFinite(val) ? val : min;
    normalized.set(key, (v - min) / range);
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// AST-based cyclomatic complexity (HOT-02)
// ---------------------------------------------------------------------------

async function computeAstComplexity(filePath, projectRoot) {
  try {
    const { extractSkeleton } = require('./skeleton.cjs');
    const result = await extractSkeleton(filePath, projectRoot);
    if (result.method === 'ast' && result.entries.length > 0) {
      let totalDecisionPoints = 0;
      for (const entry of result.entries) {
        totalDecisionPoints += (entry.complexity || 1) - 1;
      }
      return totalDecisionPoints + result.entries.length;
    }
  } catch (_) {
    // Fall through to heuristic
  }
  return estimateComplexity(filePath, projectRoot);
}

// ---------------------------------------------------------------------------
// Main API: computeHotspots (HOT-01, HOT-03, HOT-04)
// ---------------------------------------------------------------------------

function computeHotspots(projectRoot, options) {
  const opts = options || {};

  let churnMap;
  const heatmapData = loadHeatmapChurn(projectRoot);
  if (heatmapData && !opts._forceReparse) {
    churnMap = heatmapData.churnMap;
  } else {
    const commits = parseGitNumstat(projectRoot, opts);
    churnMap = computeChurnScores(commits, opts);
  }

  const files = [];
  const complexityMap = new Map();

  for (const [filePath] of churnMap) {
    const complexity = estimateComplexity(filePath, projectRoot);
    complexityMap.set(filePath, complexity);
  }

  const normalizedChurn = normalizeMap(churnMap);
  const normalizedComplexity = normalizeMap(complexityMap);

  let highRiskCount = 0;
  let mediumRiskCount = 0;

  for (const [filePath, rawChurn] of churnMap) {
    const nChurn = normalizedChurn.get(filePath);
    const nComplexity = normalizedComplexity.get(filePath);
    const hotspotScore = nChurn * nComplexity;

    let risk = 'low';
    if (hotspotScore > 0.7) {
      risk = 'high';
      highRiskCount++;
    } else if (hotspotScore > 0.4) {
      risk = 'medium';
      mediumRiskCount++;
    }

    files.push({
      path: filePath,
      churn: rawChurn,
      complexity: complexityMap.get(filePath),
      hotspot_score: Math.round(hotspotScore * 1000) / 1000,
      risk,
    });
  }

  files.sort((a, b) => b.hotspot_score - a.hotspot_score);

  return {
    files,
    summary: {
      total_files: files.length,
      high_risk_count: highRiskCount,
      medium_risk_count: mediumRiskCount,
    },
  };
}

async function computeHotspotsAst(projectRoot, options) {
  const opts = options || {};

  let churnMap;
  const heatmapData = loadHeatmapChurn(projectRoot);
  if (heatmapData && !opts._forceReparse) {
    churnMap = heatmapData.churnMap;
  } else {
    const commits = parseGitNumstat(projectRoot, opts);
    churnMap = computeChurnScores(commits, opts);
  }

  const files = [];
  const complexityMap = new Map();

  for (const [filePath] of churnMap) {
    const complexity = await computeAstComplexity(filePath, projectRoot);
    complexityMap.set(filePath, complexity);
  }

  const normalizedChurn = normalizeMap(churnMap);
  const normalizedComplexity = normalizeMap(complexityMap);

  let highRiskCount = 0;
  let mediumRiskCount = 0;

  for (const [filePath, rawChurn] of churnMap) {
    const nChurn = normalizedChurn.get(filePath);
    const nComplexity = normalizedComplexity.get(filePath);
    const hotspotScore = nChurn * nComplexity;

    let risk = 'low';
    if (hotspotScore > 0.7) {
      risk = 'high';
      highRiskCount++;
    } else if (hotspotScore > 0.4) {
      risk = 'medium';
      mediumRiskCount++;
    }

    files.push({
      path: filePath,
      churn: rawChurn,
      complexity: complexityMap.get(filePath),
      hotspot_score: Math.round(hotspotScore * 1000) / 1000,
      risk,
    });
  }

  files.sort((a, b) => b.hotspot_score - a.hotspot_score);

  return {
    files,
    summary: {
      total_files: files.length,
      high_risk_count: highRiskCount,
      medium_risk_count: mediumRiskCount,
    },
  };
}

// ---------------------------------------------------------------------------
// XML formatting
// ---------------------------------------------------------------------------

function formatHotspotXml(hotspots) {
  const entries = hotspots.files.map(f => {
    const escapedPath = escapeXml(f.path);
    return `<file path="${escapedPath}" churn="${f.churn}" complexity="${f.complexity}" hotspot_score="${f.hotspot_score}" risk="${f.risk}"/>`;
  });
  return `<files>\n${entries.join('\n')}\n</files>`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`Usage: node bin/repowise/hotspot.cjs [options]

Options:
  --project-root=/path      Override project root directory
  --json                     Output structured JSON
  --use-ast-complexity       Use AST-based cyclomatic complexity (requires web-tree-sitter)
  --exclude=pattern1,pattern2  Additional exclude patterns (regex)
  --mass-refactor-threshold=N  Commits with N+ files get inverse weighting (default: 50)
  --since=date               Only analyze commits since this date
  --help                     Show this help message

Exit codes:
  0 — success
  1 — error`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const projectRoot = (() => {
    const a = args.find(a => a.startsWith('--project-root='));
    if (a) return a.split('=').slice(1).join('=');
    if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;
    return path.resolve(__dirname, '../..');
  })();

  const jsonOutput = args.includes('--json');
  const useAstComplexity = args.includes('--use-ast-complexity');

  const since = (() => {
    const a = args.find(a => a.startsWith('--since='));
    return a ? a.split('=').slice(1).join('=') : undefined;
  })();

  const massRefactorThreshold = (() => {
    const a = args.find(a => a.startsWith('--mass-refactor-threshold='));
    return a ? parseInt(a.split('=')[1], 10) : undefined;
  })();

  const excludePatterns = (() => {
    const a = args.find(a => a.startsWith('--exclude='));
    if (!a) return undefined;
    const custom = a.split('=').slice(1).join('=').split(',').map(p => new RegExp(p));
    return [...DEFAULT_EXCLUDE_PATTERNS, ...custom];
  })();

  try {
    const hotspots = useAstComplexity
      ? await computeHotspotsAst(projectRoot, { since, massRefactorThreshold, excludePatterns })
      : computeHotspots(projectRoot, { since, massRefactorThreshold, excludePatterns });

    if (jsonOutput) {
      console.log(JSON.stringify(hotspots, null, 2));
    } else {
      console.log(`=== Repowise Hotspot Detection ===\n`);
      console.log(`Total files: ${hotspots.summary.total_files}`);
      console.log(`High risk: ${hotspots.summary.high_risk_count}`);
      console.log(`Medium risk: ${hotspots.summary.medium_risk_count}\n`);

      if (hotspots.files.length > 0) {
        console.log('Top 20 hotspots:');
        for (const f of hotspots.files.slice(0, 20)) {
          console.log(`  ${f.risk.toUpperCase().padEnd(6)} ${f.path} (score: ${f.hotspot_score}, churn: ${f.churn}, complexity: ${f.complexity})`);
        }
      }
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = {
  computeHotspots,
  computeHotspotsAst,
  computeChurnScores,
  estimateComplexity,
  computeAstComplexity,
  normalizeMap,
  isExcluded,
  parseGitNumstat,
  formatHotspotXml,
  loadHeatmapChurn,
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_MASS_REFACTOR_THRESHOLD,
};

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

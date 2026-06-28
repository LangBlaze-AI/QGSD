#!/usr/bin/env node
'use strict';
// bin/repowise/cochange.cjs — Git-log co-change prediction for Repowise

const fs = require('fs');
const path = require('path');
const { parseGitNumstat, isExcluded, DEFAULT_EXCLUDE_PATTERNS, DEFAULT_MASS_REFACTOR_THRESHOLD } = require('./hotspot.cjs');
const { escapeXml } = require('./escape-xml.cjs');

// ---------------------------------------------------------------------------
// Co-occurrence mining (COCH-01, COCH-03)
// ---------------------------------------------------------------------------

function computeCoChange(projectRoot, options) {
  const opts = options || {};
  const minSharedCommits = opts.minSharedCommits || 3;
  const minCouplingDegree = opts.minCouplingDegree || 0.3;
  const massRefactorThreshold = opts.massRefactorThreshold || DEFAULT_MASS_REFACTOR_THRESHOLD;
  const excludePatterns = opts.excludePatterns || DEFAULT_EXCLUDE_PATTERNS;

  const commits = parseGitNumstat(projectRoot, { since: opts.since });

  const pairCounts = new Map();
  const fileCommitCounts = new Map();

  for (const commit of commits) {
    const allFiles = commit.files
      .map(f => f.path)
      .filter(f => !isExcluded(f, excludePatterns));

    const fileCount = allFiles.length;
    if (fileCount < 2) continue;

    const weight = fileCount >= massRefactorThreshold
      ? 1 / Math.max(1, fileCount / massRefactorThreshold)
      : 1;

    // Track per-file commit counts
    const uniqueInCommit = new Set(allFiles);
    for (const f of uniqueInCommit) {
      const current = fileCommitCounts.get(f) || 0;
      fileCommitCounts.set(f, current + weight);
    }

    // Generate all pairs
    const sorted = [...uniqueInCommit].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}::${sorted[j]}`;
        const current = pairCounts.get(key) || 0;
        pairCounts.set(key, current + weight);
      }
    }
  }

  // Compute coupling and filter (COCH-02)
  const pairs = [];
  for (const [key, sharedCount] of pairCounts) {
    if (sharedCount < minSharedCommits) continue;

    const [file1, file2] = key.split('::');
    const commits1 = fileCommitCounts.get(file1) || 0;
    const commits2 = fileCommitCounts.get(file2) || 0;

    if (commits1 === 0 || commits2 === 0) continue;

    const couplingDegree = sharedCount / Math.min(commits1, commits2);
    if (couplingDegree < minCouplingDegree) continue;

    pairs.push({
      file1,
      file2,
      shared_commits: Math.round(sharedCount * 1000) / 1000,
      coupling_degree: Math.round(couplingDegree * 1000) / 1000,
    });
  }

  pairs.sort((a, b) => b.coupling_degree - a.coupling_degree);

  const strongCouplingCount = pairs.filter(p => p.coupling_degree >= 0.5).length;

  // Build file index for fast partner lookup
  const fileIndex = new Map();
  for (const p of pairs) {
    if (!fileIndex.has(p.file1)) fileIndex.set(p.file1, []);
    if (!fileIndex.has(p.file2)) fileIndex.set(p.file2, []);
    fileIndex.get(p.file1).push({ partner: p.file2, shared_commits: p.shared_commits, coupling_degree: p.coupling_degree });
    fileIndex.get(p.file2).push({ partner: p.file1, shared_commits: p.shared_commits, coupling_degree: p.coupling_degree });
  }

  return {
    pairs,
    summary: {
      total_pairs: pairs.length,
      strong_coupling_count: strongCouplingCount,
    },
    fileIndex,
  };
}

// ---------------------------------------------------------------------------
// Partner lookup
// ---------------------------------------------------------------------------

function getPartnersForFile(filePath, cochangeResult) {
  if (!cochangeResult || !cochangeResult.fileIndex || typeof cochangeResult.fileIndex.get !== 'function') return [];
  return cochangeResult.fileIndex.get(filePath) || [];
}

// ---------------------------------------------------------------------------
// XML formatting
// ---------------------------------------------------------------------------

function formatCoChangeXml(cochange) {
  const pairsList = (cochange && Array.isArray(cochange.pairs)) ? cochange.pairs : [];
  const entries = pairsList.map(p => {
    const f1 = escapeXml(p.file1);
    const f2 = escapeXml(p.file2);
    return `<pair file1="${f1}" file2="${f2}" shared_commits="${p.shared_commits}" coupling_degree="${p.coupling_degree}"/>`;
  });
  return `<pairs>\n${entries.join('\n')}\n</pairs>`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`Usage: node bin/repowise/cochange.cjs [options]

Options:
  --project-root=/path          Override project root directory
  --json                        Output structured JSON
  --min-shared-commits=N        Minimum shared commits threshold (default: 3)
  --min-coupling-degree=F      Minimum coupling degree threshold (default: 0.3)
  --since=date                  Only analyze commits since this date
  --help                        Show this help message

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
  const minSharedCommits = (() => {
    const a = args.find(a => a.startsWith('--min-shared-commits='));
    return a ? parseInt(a.split('=')[1], 10) : undefined;
  })();
  const minCouplingDegree = (() => {
    const a = args.find(a => a.startsWith('--min-coupling-degree='));
    return a ? parseFloat(a.split('=')[1]) : undefined;
  })();
  const since = (() => {
    const a = args.find(a => a.startsWith('--since='));
    return a ? a.split('=').slice(1).join('=') : undefined;
  })();

  try {
    const result = computeCoChange(projectRoot, {
      minSharedCommits,
      minCouplingDegree,
      since,
    });

    if (jsonOutput) {
      const output = { pairs: result.pairs, summary: result.summary };
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(`=== Repowise Co-Change Prediction ===\n`);
      console.log(`Total pairs: ${result.summary.total_pairs}`);
      console.log(`Strong coupling: ${result.summary.strong_coupling_count}\n`);
      if (result.pairs.length > 0) {
        console.log('Top 20 co-change pairs:');
        for (const p of result.pairs.slice(0, 20)) {
          console.log(`  ${p.file1} <-> ${p.file2} (shared: ${p.shared_commits}, coupling: ${p.coupling_degree})`);
        }
      }
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { computeCoChange, formatCoChangeXml, getPartnersForFile };

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

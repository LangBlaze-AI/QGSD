#!/usr/bin/env node
'use strict';

/**
 * git-heatmap.cjs — Mine git history for numerical adjustments, bugfix hotspots,
 * and churn ranking. Produces .planning/formal/evidence/git-heatmap.json as
 * structured evidence for nf:solve consumption.
 *
 * Requirements: QUICK-193
 *
 * Usage:
 *   node bin/git-heatmap.cjs                        # print summary to stdout
 *   node bin/git-heatmap.cjs --json                  # print full JSON to stdout
 *   node bin/git-heatmap.cjs --since=2024-01-01      # limit git history depth
 *   node bin/git-heatmap.cjs --project-root=/path    # specify project root
 *
 * Security: Uses execFileSync with argument arrays (NOT exec with string
 * concatenation) to prevent command injection. The --since value is validated
 * against a strict date pattern before use.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ── CLI parsing ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { json: false, since: null, projectRoot: process.cwd(), maxCommits: 0 };
  for (const arg of argv.slice(2)) {
    if (arg === '--json') {
      args.json = true;
    } else if (arg.startsWith('--since=')) {
      args.since = arg.slice('--since='.length);
    } else if (arg.startsWith('--project-root=')) {
      args.projectRoot = arg.slice('--project-root='.length);
    } else if (arg.startsWith('--max-commits=')) {
      args.maxCommits = parseInt(arg.slice('--max-commits='.length), 10) || 0;
    }
  }
  return args;
}

// ── Input validation ───────────────────────────────────────────────────────

const SINCE_PATTERN = /^[\d\-\.TZ:a-z]+$/;

function validateSince(since) {
  if (since && !SINCE_PATTERN.test(since)) {
    throw new Error(`Invalid --since value: "${since}". Must match date pattern (e.g., 2024-01-01 or 2024-01-01T00:00:00Z)`);
  }
}

// ── Exec helper ────────────────────────────────────────────────────────────

const MAX_BUFFER = 50 * 1024 * 1024; // 50 MB

function gitExec(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (err.status !== null && err.status !== 0) {
      throw new Error(`git ${args[0]} failed (exit ${err.status}): ${(err.stderr || '').slice(0, 500)}`);
    }
    // Some git commands return non-zero for empty results
    return err.stdout || '';
  }
}

// ── Model registry cross-reference ─────────────────────────────────────────

function buildCoverageMap(root) {
  const registryPath = path.join(root, '.planning', 'formal', 'model-registry.json');
  const coverageSet = new Set();

  if (!fs.existsSync(registryPath)) {
    return coverageSet;
  }

  try {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const models = registry.models || {};

    for (const [modelPath, _entry] of Object.entries(models)) {
      const fullModelPath = path.join(root, modelPath);
      if (fs.existsSync(fullModelPath)) {
        try {
          const content = fs.readFileSync(fullModelPath, 'utf8');
          // Extract file references from model content — look for source file paths
          // Match patterns like hooks/xxx.js, bin/xxx.cjs, core/xxx, etc.
          const fileRefPattern = /(?:hooks|bin|core|src|lib)\/[\w\-\.\/]+\.\w+/g;
          let match;
          while ((match = fileRefPattern.exec(content)) !== null) {
            coverageSet.add(match[0]);
          }
        } catch (_e) {
          // Skip unreadable model files
        }
      }
    }
  } catch (_e) {
    // Registry parse failure — proceed with empty coverage
  }

  return coverageSet;
}

function hasFormalCoverage(file, coverageMap) {
  // Check direct match
  if (coverageMap.has(file)) return true;
  // Check if file basename appears in any coverage entry
  for (const covered of coverageMap) {
    if (file.endsWith(covered) || covered.endsWith(file)) return true;
  }
  return false;
}

// ── Signal 1: Numerical Adjustments ────────────────────────────────────────

/**
 * Parse a numeric value from a diff line (removed or added).
 * Returns { value, name, prefix } or null.
 */
function parseDiffNumericLine(line) {
  const prefix = line[0]; // '-' or '+'
  const content = line.slice(1);

  // Match lines with numeric constants/assignments
  const patterns = [
    // const TIMEOUT = 5000
    /^\s*(?:const|let|var)\s+(\w+)\s*=\s*(-?\d+(?:\.\d+)?)\s*[,;]?\s*$/,
    // property: 5000  or  property = 5000
    /^\s*([\w.]+)\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*[,;]?\s*$/,
    // timeout: 5000 (YAML/JSON style with quotes)
    /^\s*["']?([\w.]+)["']?\s*:\s*(-?\d+(?:\.\d+)?)\s*[,;]?\s*$/,
  ];

  for (const pat of patterns) {
    const m = content.match(pat);
    if (m) {
      return { name: m[1], value: parseFloat(m[2]), prefix };
    }
  }
  return null;
}

/**
 * Parse diff hunks respecting hunk boundaries.
 * Returns array of { constant_name, old_value, new_value } for numeric changes
 * within the same hunk and within 3 lines of each other.
 */
function parseHunksForNumericChanges(diffText) {
  const results = [];
  const lines = diffText.split('\n');

  let inHunk = false;
  let removedLines = []; // { lineIdx, parsed }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Hunk header resets state
    if (line.startsWith('@@')) {
      inHunk = true;
      removedLines = [];
      continue;
    }

    // New file header resets hunk
    if (line.startsWith('diff --git') || line.startsWith('---') || line.startsWith('+++')) {
      inHunk = false;
      removedLines = [];
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith('-') && !line.startsWith('---')) {
      const parsed = parseDiffNumericLine(line);
      if (parsed) {
        removedLines.push({ lineIdx: i, parsed });
      }
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      const parsed = parseDiffNumericLine(line);
      if (parsed) {
        // Find matching removed line within 3 lines, same constant name
        for (let j = removedLines.length - 1; j >= 0; j--) {
          const removed = removedLines[j];
          if (removed.parsed.name === parsed.name &&
              removed.parsed.value !== parsed.value &&
              (i - removed.lineIdx) <= 3) {
            results.push({
              constant_name: parsed.name,
              old_value: removed.parsed.value,
              new_value: parsed.value,
            });
            removedLines.splice(j, 1);
            break;
          }
        }
      }
    }
  }

  return results;
}

function computeDriftDirection(values) {
  if (values.length < 2) return 'stable';
  let increasing = true;
  let decreasing = true;
  for (let i = 1; i < values.length; i++) {
    if (values[i] <= values[i - 1]) increasing = false;
    if (values[i] >= values[i - 1]) decreasing = false;
  }
  if (increasing) return 'increasing';
  if (decreasing) return 'decreasing';
  return 'oscillating';
}

function extractNumericalAdjustments(root, since, coverageMap, maxCommits) {
  // Pass 1: identify candidate files via numstat
  const numstatArgs = ['log', '--all', '--numstat', '--format=%H %aI'];
  if (since) numstatArgs.push(`--since=${since}`);
  if (maxCommits > 0) numstatArgs.push(`--max-count=${maxCommits}`);

  const numstatOutput = gitExec(numstatArgs, root);

  // Count changes per file
  const fileChurn = {};
  for (const line of numstatOutput.split('\n')) {
    const numstatMatch = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (numstatMatch) {
      const file = numstatMatch[3];
      fileChurn[file] = (fileChurn[file] || 0) + parseInt(numstatMatch[1]) + parseInt(numstatMatch[2]);
    }
  }

  // Filter to candidate files (numeric-heavy, config files, etc.)
  // Exclude .planning/ — formal evidence files are auto-generated and produce enormous diffs
  const candidatePatterns = /\.(json|cjs|mjs|js|ts|config\.\w+|yml|yaml|toml)$/;
  const excludePatterns = /^\.planning\//;
  const candidates = Object.entries(fileChurn)
    .filter(([f]) => candidatePatterns.test(f) && !excludePatterns.test(f))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([f]) => f);

  // Pass 2: targeted diff per candidate file
  const adjustmentMap = {}; // key: file+constant_name

  for (const file of candidates) {
    const perFileLimit = maxCommits > 0 ? Math.min(maxCommits, 50) : 50;
    const diffArgs = ['log', '-p', '--all', `--max-count=${perFileLimit}`, '--format=%H %aI', '--', file];
    if (since) diffArgs.splice(2, 0, `--since=${since}`);

    let diffOutput;
    try {
      diffOutput = gitExec(diffArgs, root);
    } catch (_e) {
      continue;
    }

    if (!diffOutput || diffOutput.length < 10) continue;

    // Parse commits and their diffs
    const commitSections = diffOutput.split(/^(?=[0-9a-f]{40} \d{4})/m);

    for (const section of commitSections) {
      const headerMatch = section.match(/^([0-9a-f]{40})\s+(\S+)/);
      if (!headerMatch) continue;
      const commit = headerMatch[1].slice(0, 8);
      const date = headerMatch[2];

      const changes = parseHunksForNumericChanges(section);
      for (const change of changes) {
        const key = `${file}::${change.constant_name}`;
        if (!adjustmentMap[key]) {
          adjustmentMap[key] = {
            file,
            constant_name: change.constant_name,
            entries: [],
          };
        }
        adjustmentMap[key].entries.push({
          old_value: change.old_value,
          new_value: change.new_value,
          commit,
          date,
        });
      }
    }
  }

  // Build output array
  return Object.values(adjustmentMap).map(adj => {
    const values = [];
    for (const e of adj.entries) {
      if (values.length === 0 || values[values.length - 1] !== e.old_value) {
        values.push(e.old_value);
      }
      values.push(e.new_value);
    }
    return {
      file: adj.file,
      constant_name: adj.constant_name,
      touch_count: adj.entries.length,
      values,
      drift_direction: computeDriftDirection(values),
      has_formal_coverage: hasFormalCoverage(adj.file, coverageMap),
      changes: adj.entries,
    };
  });
}

// ── Signal 2: Bugfix Hotspots ──────────────────────────────────────────────

const BUGFIX_PATTERN = /\b(fix|bug|bugfix|patch|hotfix|resolve[ds]?)\b/i;

function isBugfixCommit(message) {
  return BUGFIX_PATTERN.test(message);
}

function extractBugfixHotspots(root, since, coverageMap, maxCommits) {
  const logArgs = ['log', '--all', '--oneline'];
  if (since) logArgs.push(`--since=${since}`);
  if (maxCommits > 0) logArgs.push(`--max-count=${maxCommits}`);

  const logOutput = gitExec(logArgs, root);
  const lines = logOutput.trim().split('\n').filter(Boolean);

  const fixCommits = [];
  for (const line of lines) {
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) continue;
    const sha = line.slice(0, spaceIdx);
    const msg = line.slice(spaceIdx + 1);
    if (isBugfixCommit(msg)) {
      fixCommits.push(sha);
    }
  }

  // Get files touched by each fix commit
  const fileFixes = {};
  for (const sha of fixCommits) {
    let filesOutput;
    try {
      filesOutput = gitExec(['diff-tree', '--no-commit-id', '-r', '--name-only', sha], root);
    } catch (_e) {
      continue;
    }
    const files = filesOutput.trim().split('\n').filter(Boolean);
    for (const file of files) {
      fileFixes[file] = (fileFixes[file] || 0) + 1;
    }
  }

  return Object.entries(fileFixes)
    .sort((a, b) => b[1] - a[1])
    .map(([file, fix_count]) => ({
      file,
      fix_count,
      has_formal_coverage: hasFormalCoverage(file, coverageMap),
    }));
}

// ── Signal 3: Churn Ranking ────────────────────────────────────────────────

function extractChurnRanking(root, since, maxCommits) {
  const logArgs = ['log', '--numstat', '--all', '--no-merges', '--format=%H'];
  if (since) logArgs.push(`--since=${since}`);
  if (maxCommits > 0) logArgs.push(`--max-count=${maxCommits}`);

  const logOutput = gitExec(logArgs, root);

  const fileStats = Object.create(null);
  let currentCommit = null;

  for (const line of logOutput.split('\n')) {
    if (/^[0-9a-f]{40}$/.test(line)) {
      currentCommit = line;
      continue;
    }
    const numstatMatch = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (numstatMatch) {
      const added = parseInt(numstatMatch[1]);
      const removed = parseInt(numstatMatch[2]);
      const file = numstatMatch[3];

      if (!fileStats[file]) {
        fileStats[file] = { commits: 0, lines_added: 0, lines_removed: 0, commitSet: new Set() };
      }
      fileStats[file].lines_added += added;
      fileStats[file].lines_removed += removed;
      if (currentCommit && !fileStats[file].commitSet.has(currentCommit)) {
        fileStats[file].commitSet.add(currentCommit);
        fileStats[file].commits++;
      }
    }
  }

  return Object.entries(fileStats)
    .map(([file, s]) => ({
      file,
      commits: s.commits,
      lines_added: s.lines_added,
      lines_removed: s.lines_removed,
      total_churn: s.lines_added + s.lines_removed,
    }))
    .sort((a, b) => b.total_churn - a.total_churn);
}

// ── Priority scoring ───────────────────────────────────────────────────────

function computePriority(churn, fixes, adjustments, calleeCount = 0) {
  return Math.max(churn, 1) * (1 + fixes) * (1 + adjustments) * (1 + Math.log1p(calleeCount));
}

// ── Cross-reference: uncovered hot zones ───────────────────────────────────

function buildUncoveredHotZones(numericalAdj, bugfixHotspots, churnRanking, coverageMap) {
  const allFiles = new Set();

  // Collect all files from all signals
  for (const adj of numericalAdj) allFiles.add(adj.file);
  for (const bf of bugfixHotspots) allFiles.add(bf.file);
  for (const ch of churnRanking) allFiles.add(ch.file);

  // Build lookup maps
  const churnMap = Object.create(null);
  for (const ch of churnRanking) churnMap[ch.file] = ch.total_churn;

  const fixMap = Object.create(null);
  for (const bf of bugfixHotspots) fixMap[bf.file] = bf.fix_count;

  const adjMap = Object.create(null);
  for (const adj of numericalAdj) {
    adjMap[adj.file] = (adjMap[adj.file] || 0) + adj.touch_count;
  }

  const uncovered = [];
  for (const file of allFiles) {
    if (hasFormalCoverage(file, coverageMap)) continue;

    const churn = churnMap[file] || 0;
    const fixes = fixMap[file] || 0;
    const adjustments = adjMap[file] || 0;

    const signals = [];
    if (churnMap[file]) signals.push('churn');
    if (fixMap[file]) signals.push('bugfix');
    if (adjMap[file]) signals.push('numerical');

    uncovered.push({
      file,
      priority: computePriority(churn, fixes, adjustments, 0),
      churn,
      fixes,
      adjustments,
      callee_count: 0,
      signals,
    });
  }

  return uncovered.sort((a, b) => b.priority - a.priority);
}

// ── Human-readable output ──────────────────────────────────────────────────

function printSummary(result) {
  const { signals, uncovered_hot_zones } = result;

  console.log('\n=== Git Heatmap Summary ===\n');

  console.log('--- Top 10 Numerical Adjustments ---');
  for (const adj of signals.numerical_adjustments.slice(0, 10)) {
    console.log(`  ${adj.file} :: ${adj.constant_name} (${adj.touch_count} changes, ${adj.drift_direction})${adj.has_formal_coverage ? ' [covered]' : ''}`);
  }
  if (signals.numerical_adjustments.length === 0) console.log('  (none found)');

  console.log('\n--- Top 10 Bugfix Hotspots ---');
  for (const bf of signals.bugfix_hotspots.slice(0, 10)) {
    console.log(`  ${bf.file} (${bf.fix_count} fixes)${bf.has_formal_coverage ? ' [covered]' : ''}`);
  }
  if (signals.bugfix_hotspots.length === 0) console.log('  (none found)');

  console.log('\n--- Top 10 by Churn ---');
  for (const ch of signals.churn_ranking.slice(0, 10)) {
    console.log(`  ${ch.file} (${ch.total_churn} lines, ${ch.commits} commits)`);
  }
  if (signals.churn_ranking.length === 0) console.log('  (none found)');

  console.log('\n--- Top 10 Uncovered Hot Zones ---');
  for (const hz of uncovered_hot_zones.slice(0, 10)) {
    console.log(`  ${hz.file} (priority: ${hz.priority}, signals: ${hz.signals.join(', ')})`);
  }
  if (uncovered_hot_zones.length === 0) console.log('  (none found)');

  console.log(`\nTotals: ${signals.numerical_adjustments.length} adjustments, ${signals.bugfix_hotspots.length} bugfix files, ${signals.churn_ranking.length} files by churn, ${uncovered_hot_zones.length} uncovered hot zones`);
  console.log('');
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);
  const root = path.resolve(args.projectRoot);

  // Validate --since
  validateSince(args.since);

  // Verify git repo
  try {
    gitExec(['rev-parse', '--git-dir'], root);
  } catch (err) {
    process.stderr.write(`Error: ${root} is not a git repository\n`);
    process.exit(1);
  }

  const coverageMap = buildCoverageMap(root);

  const numericalAdj = extractNumericalAdjustments(root, args.since, coverageMap, args.maxCommits);
  const bugfixHotspots = extractBugfixHotspots(root, args.since, coverageMap, args.maxCommits);
  const churnRanking = extractChurnRanking(root, args.since, args.maxCommits);
  const uncoveredHotZones = buildUncoveredHotZones(numericalAdj, bugfixHotspots, churnRanking, coverageMap);

  const result = {
    schema_version: '1',
    generated: new Date().toISOString(),
    signals: {
      numerical_adjustments: numericalAdj,
      bugfix_hotspots: bugfixHotspots,
      churn_ranking: churnRanking,
    },
    uncovered_hot_zones: uncoveredHotZones,
  };

  // Write evidence file
  const evidenceDir = path.join(root, '.planning', 'formal', 'evidence');
  if (!fs.existsSync(evidenceDir)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }
  const outPath = path.join(evidenceDir, 'git-heatmap.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    printSummary(result);
    console.log(`Evidence written to: ${outPath}`);
  }
}

// ── Exports for testing ────────────────────────────────────────────────────

module.exports = {
  parseArgs,
  validateSince,
  parseDiffNumericLine,
  parseHunksForNumericChanges,
  computeDriftDirection,
  isBugfixCommit,
  computePriority,
  hasFormalCoverage,
  buildCoverageMap,
  extractNumericalAdjustments,
  extractBugfixHotspots,
  extractChurnRanking,
  buildUncoveredHotZones,
  SINCE_PATTERN,
};

if (require.main === module) {
  main();
}

#!/usr/bin/env node
'use strict';

/**
 * git-history-evidence.cjs — Classify every commit by type (feat/fix/refactor/
 * docs/test/chore/build) and cross-reference changed files against TLA+
 * specifications from the model registry.
 *
 * Requirements: QUICK-218
 *
 * Usage:
 *   node bin/git-history-evidence.cjs                        # print summary
 *   node bin/git-history-evidence.cjs --json                  # print full JSON
 *   node bin/git-history-evidence.cjs --since=2024-01-01      # limit history
 *   node bin/git-history-evidence.cjs --project-root=/path    # specify root
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
  const args = { json: false, since: null, projectRoot: process.cwd() };
  for (const arg of argv.slice(2)) {
    if (arg === '--json') {
      args.json = true;
    } else if (arg.startsWith('--since=')) {
      args.since = arg.slice('--since='.length);
    } else if (arg.startsWith('--project-root=')) {
      args.projectRoot = arg.slice('--project-root='.length);
    }
  }
  return args;
}

// ── Input validation ───────────────────────────────────────────────────────

const SINCE_PATTERN = /^[\d\-\.TZ:]+$/;

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
    return err.stdout || '';
  }
}

// ── Commit classification ──────────────────────────────────────────────────

const COMMIT_TYPES = ['feat', 'fix', 'refactor', 'docs', 'test', 'build', 'chore'];

/**
 * Classify a commit message into exactly one category.
 * Prefix-first matching with fallback to chore.
 */
function classifyCommit(message) {
  if (!message || typeof message !== 'string') return 'chore';
  const msg = message.trim().toLowerCase();

  // Conventional commit prefix matching
  if (/^feat[:(]/.test(msg) || /^add\s/.test(msg)) return 'feat';
  if (/^fix[:(]/.test(msg) || /\b(bugfix|hotfix|patch)\b/.test(msg)) return 'fix';
  if (/^refactor[:(]/.test(msg)) return 'refactor';
  if (/^docs[:(]/.test(msg)) return 'docs';
  if (/^tests?[:(]/.test(msg)) return 'test';
  if (/^(build|ci|chore)[:(]/.test(msg)) return 'build';

  return 'chore';
}

// ── TLA+ cross-referencing ─────────────────────────────────────────────────

/**
 * Build a reverse map: source_file -> [tla_spec_paths]
 * by reading each TLA+ model from the registry and extracting file references.
 */
function buildTlaCoverageReverseMap(root) {
  const registryPath = path.join(root, '.planning', 'formal', 'model-registry.json');
  const reverseMap = {}; // source_file -> [tla_spec_path]

  let registry;
  try {
    const raw = fs.readFileSync(registryPath, 'utf8');
    registry = JSON.parse(raw);
  } catch (err) {
    process.stderr.write('[git-history-evidence] WARNING: Could not read model-registry.json: ' + err.message + '\n');
    return reverseMap;
  }

  const models = registry.models || {};
  const fileRefPattern = /(?:hooks|bin|core|src|lib)\/[\w\-\.\/]+\.\w+/g;

  for (const [modelPath, _entry] of Object.entries(models)) {
    // Only process .tla files
    if (!modelPath.endsWith('.tla')) continue;

    const fullModelPath = path.join(root, modelPath);
    if (!fs.existsSync(fullModelPath)) continue;

    try {
      const content = fs.readFileSync(fullModelPath, 'utf8');
      let match;
      while ((match = fileRefPattern.exec(content)) !== null) {
        const sourceFile = match[0];
        if (!reverseMap[sourceFile]) {
          reverseMap[sourceFile] = [];
        }
        if (!reverseMap[sourceFile].includes(modelPath)) {
          reverseMap[sourceFile].push(modelPath);
        }
      }
    } catch (_e) {
      // Skip unreadable model files
    }
  }

  return reverseMap;
}

/**
 * Look up TLA+ specs covering a file, checking both direct and suffix matches.
 */
function getTlaCrossRefs(file, reverseMap) {
  if (typeof file !== 'string' || file === '') return [];
  if (!reverseMap || typeof reverseMap !== 'object') return [];

  // Direct match — own-property only, never inherited keys like "constructor"
  if (Object.prototype.hasOwnProperty.call(reverseMap, file) && Array.isArray(reverseMap[file])) {
    return reverseMap[file];
  }

  // Suffix matching (e.g., file = "hooks/nf-prompt.js", key = "hooks/nf-prompt.js")
  for (const [key, specs] of Object.entries(reverseMap)) {
    if (key === '') continue;
    if (file.endsWith(key) || key.endsWith(file)) return specs;
  }
  return [];
}

// ── Core extraction ────────────────────────────────────────────────────────

/**
 * Extract all commits with classification and file lists.
 * Returns array of { sha, message, type, files, tla_cross_refs }
 */
function extractClassifiedCommits(root, since, reverseMap) {
  const logArgs = ['log', '--all', '--oneline', '--no-merges'];
  if (since) logArgs.push(`--since=${since}`);

  const logOutput = gitExec(logArgs, root);
  if (!logOutput || !logOutput.trim()) return [];

  const lines = logOutput.trim().split('\n').filter(Boolean);
  const commits = [];

  for (const line of lines) {
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) continue;

    const sha = line.slice(0, spaceIdx);
    const message = line.slice(spaceIdx + 1);
    const type = classifyCommit(message);

    // Get touched files
    let filesOutput;
    try {
      filesOutput = gitExec(['diff-tree', '--no-commit-id', '-r', '--name-only', sha], root);
    } catch (_e) {
      continue;
    }

    const files = filesOutput.trim().split('\n').filter(Boolean);

    // TLA+ cross-references
    const tlaCrossRefs = new Set();
    for (const file of files) {
      const refs = getTlaCrossRefs(file, reverseMap);
      for (const ref of refs) tlaCrossRefs.add(ref);
    }

    commits.push({
      sha,
      message,
      type,
      files,
      tla_cross_refs: Array.from(tlaCrossRefs),
    });
  }

  return commits;
}

/**
 * Compute per-file breakdown from classified commits.
 * Returns array of { file, total_commits, by_type, dominant_type, has_tla_coverage, tla_specs }
 */
function computeFileBreakdown(commits, reverseMap) {
  const fileMap = {}; // file -> { by_type: {}, total: N }

  for (const commit of commits) {
    for (const file of commit.files) {
      if (!fileMap[file]) {
        fileMap[file] = { by_type: {}, total: 0 };
      }
      fileMap[file].total++;
      fileMap[file].by_type[commit.type] = (fileMap[file].by_type[commit.type] || 0) + 1;
    }
  }

  return Object.entries(fileMap)
    .map(([file, data]) => {
      const tlaSpecs = getTlaCrossRefs(file, reverseMap);
      // Find dominant type
      let dominantType = 'chore';
      let maxCount = 0;
      for (const [type, count] of Object.entries(data.by_type)) {
        if (count > maxCount) {
          maxCount = count;
          dominantType = type;
        }
      }

      return {
        file,
        total_commits: data.total,
        by_type: data.by_type,
        dominant_type: dominantType,
        has_tla_coverage: tlaSpecs.length > 0,
        tla_specs: tlaSpecs,
      };
    })
    .sort((a, b) => b.total_commits - a.total_commits);
}

/**
 * Identify TLA+ drift candidates: files where code has feat/fix commits
 * more recent than the TLA+ spec's last_updated from model-registry.json.
 */
function findTlaDriftCandidates(commits, reverseMap, root) {
  // Load registry for last_updated timestamps
  let registry;
  try {
    const registryPath = path.join(root, '.planning', 'formal', 'model-registry.json');
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (_e) {
    return [];
  }

  const models = registry.models || {};

  // Build per-file recent feat/fix counts
  const fileFeatFix = {}; // file -> count

  for (const commit of commits) {
    if (commit.type !== 'feat' && commit.type !== 'fix') continue;
    for (const file of commit.files) {
      if (!fileFeatFix[file]) fileFeatFix[file] = 0;
      fileFeatFix[file]++;
    }
  }

  const candidates = [];
  const seen = new Set();

  for (const [file, featFixCount] of Object.entries(fileFeatFix)) {
    const tlaSpecs = getTlaCrossRefs(file, reverseMap);
    if (tlaSpecs.length === 0) continue;

    for (const specPath of tlaSpecs) {
      const key = `${file}::${specPath}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const specEntry = models[specPath];
      const lastUpdated = specEntry ? specEntry.last_updated : null;

      candidates.push({
        file,
        recent_commits: commits.filter(c => c.files.includes(file)).length,
        recent_feat_or_fix: featFixCount,
        tla_spec: specPath,
        tla_last_updated: lastUpdated || 'unknown',
      });
    }
  }

  return candidates.sort((a, b) => b.recent_feat_or_fix - a.recent_feat_or_fix);
}

// ── Human-readable output ──────────────────────────────────────────────────

function printSummary(result) {
  console.log('\n=== Git History Evidence Summary ===\n');

  console.log('--- Top 10 Files by Commit Count ---');
  for (const fb of result.file_breakdown.slice(0, 10)) {
    const typeDist = Object.entries(fb.by_type)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t}:${n}`)
      .join(', ');
    const coverage = fb.has_tla_coverage ? ' [TLA+ covered]' : '';
    console.log(`  ${fb.file} (${fb.total_commits} commits: ${typeDist})${coverage}`);
  }
  if (result.file_breakdown.length === 0) console.log('  (none found)');

  console.log('\n--- Top 10 TLA+ Drift Candidates ---');
  for (const dc of result.tla_drift_candidates.slice(0, 10)) {
    console.log(`  ${dc.file} (${dc.recent_feat_or_fix} feat/fix commits) -> ${dc.tla_spec} (last updated: ${dc.tla_last_updated})`);
  }
  if (result.tla_drift_candidates.length === 0) console.log('  (none found)');

  const s = result.summary;
  console.log(`\nTotals: ${s.total_commits} commits, ${s.files_analyzed} files, ${s.tla_covered_commits} TLA+-covered commits`);
  const typeStr = Object.entries(s.by_type).map(([t, n]) => `${t}:${n}`).join(', ');
  console.log(`By type: ${typeStr}`);
  console.log('');
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);
  const root = path.resolve(args.projectRoot);

  validateSince(args.since);

  // Verify git repo
  try {
    gitExec(['rev-parse', '--git-dir'], root);
  } catch (err) {
    process.stderr.write(`Error: ${root} is not a git repository\n`);
    process.exit(1);
  }

  const reverseMap = buildTlaCoverageReverseMap(root);
  const commits = extractClassifiedCommits(root, args.since, reverseMap);
  const fileBreakdown = computeFileBreakdown(commits, reverseMap);
  const driftCandidates = findTlaDriftCandidates(commits, reverseMap, root);

  // Summary stats
  const byType = {};
  let tlaCoveredCommits = 0;
  for (const commit of commits) {
    byType[commit.type] = (byType[commit.type] || 0) + 1;
    if (commit.tla_cross_refs.length > 0) tlaCoveredCommits++;
  }

  const result = {
    schema_version: '1',
    generated: new Date().toISOString(),
    summary: {
      total_commits: commits.length,
      by_type: byType,
      tla_covered_commits: tlaCoveredCommits,
      files_analyzed: fileBreakdown.length,
    },
    file_breakdown: fileBreakdown,
    tla_drift_candidates: driftCandidates,
  };

  // Write evidence file
  const evidenceDir = path.join(root, '.planning', 'formal', 'evidence');
  if (!fs.existsSync(evidenceDir)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }
  const outPath = path.join(evidenceDir, 'git-history-evidence.json');
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
  classifyCommit,
  buildTlaCoverageReverseMap,
  getTlaCrossRefs,
  extractClassifiedCommits,
  computeFileBreakdown,
  findTlaDriftCandidates,
  SINCE_PATTERN,
  COMMIT_TYPES,
};

if (require.main === module) {
  main();
}

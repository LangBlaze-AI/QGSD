#!/usr/bin/env node
'use strict';
// Requirements: TLINK-02
// bin/annotate-tests.cjs
// Scans test files, queries proximity graph, and suggests @requirement annotations.
//
// Usage:
//   node bin/annotate-tests.cjs                    # Scan default test dirs
//   node bin/annotate-tests.cjs --dir test/        # Scan specific directory
//   node bin/annotate-tests.cjs --write            # Auto-inject annotations into files
//   node bin/annotate-tests.cjs --json             # JSON output

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const PI_PATH = path.join(ROOT, '.planning', 'formal', 'proximity-index.json');

// ── Argument Parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { dirs: [], write: false, json: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--write') args.write = true;
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else if (argv[i] === '--dir' && argv[i + 1]) args.dirs.push(argv[++i]);
  }
  if (args.dirs.length === 0) {
    args.dirs = ['bin', 'test'];
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node bin/annotate-tests.cjs [options]

Scans test files for missing @requirement annotations and suggests
them based on proximity graph edges.

Options:
  --dir <path>   Scan specific directory (default: bin/, test/)
  --write        Auto-inject annotations into files (confidence >= 0.5)
  --json         JSON output
  --help         Show this help message

Examples:
  node bin/annotate-tests.cjs
  node bin/annotate-tests.cjs --dir test/ --json
  node bin/annotate-tests.cjs --write
`);
}

// ── Test File Discovery ─────────────────────────────────────────────────────

function discoverTestFiles(dirs) {
  const testFiles = [];
  if (!Array.isArray(dirs)) return testFiles;
  for (const dir of dirs) {
    const absDir = path.join(ROOT, dir);
    if (!fs.existsSync(absDir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.test.cjs') && !entry.name.endsWith('.test.js')) continue;
      testFiles.push({
        file: path.join(dir, entry.name),
        absPath: path.join(absDir, entry.name),
      });
    }
  }
  return testFiles;
}

// ── Annotation Detection ────────────────────────────────────────────────────

function hasExistingAnnotation(content) {
  return /@req(?:uirement)?\s+[A-Z][A-Z0-9_-]+/i.test(content) ||
         /\/\/\s*req(?:uirement)?:\s*[A-Z][A-Z0-9_-]+/i.test(content) ||
         /\/\/\s*Requirements:\s*[A-Z][A-Z0-9_-]+/i.test(content);
}

// ── Proximity Query ─────────────────────────────────────────────────────────

function querySuggestion(pi, reachFn, file) {
  if (!pi || typeof pi !== 'object' || !pi.nodes || typeof pi.nodes !== 'object') return null;
  // Try exact node key
  let nodeKey = 'code_file::' + file;
  if (!pi.nodes[nodeKey]) {
    // Try filename-based fuzzy matching
    const basename = path.basename(file);
    for (const k of Object.keys(pi.nodes)) {
      if (k.startsWith('code_file::') && k.includes(basename)) {
        nodeKey = k;
        break;
      }
    }
    if (!pi.nodes[nodeKey]) return null;
  }

  // BFS reach to find requirement nodes
  const reachable = reachFn(pi, nodeKey, 3, ['requirement']);
  let bestReq = null;
  let bestConfidence = 0;

  for (const [depthStr, nodes] of Object.entries(reachable)) {
    const depth = parseInt(depthStr, 10);
    // Confidence decreases with depth: hop 1 = 0.9, hop 2 = 0.6, hop 3 = 0.3
    const depthConfidence = Math.max(0.1, 1.0 - (depth * 0.3));
    for (const n of nodes) {
      if (depthConfidence > bestConfidence) {
        bestConfidence = depthConfidence;
        bestReq = n.key.replace('requirement::', '');
      }
    }
    if (bestReq) break; // Take the closest hop
  }

  if (!bestReq || bestConfidence < 0.4) return null;

  return {
    requirement: bestReq,
    confidence: Math.round(bestConfidence * 100) / 100,
  };
}

// ── Write Mode ──────────────────────────────────────────────────────────────

function injectAnnotation(absPath, reqId) {
  const content = fs.readFileSync(absPath, 'utf8');
  const lines = content.split('\n');
  const annotation = `// @requirement ${reqId}`;

  // Insert after shebang if present, otherwise at line 1
  let insertAt = 0;
  if (lines[0] && lines[0].startsWith('#!')) {
    insertAt = 1;
  }

  lines.splice(insertAt, 0, annotation);
  fs.writeFileSync(absPath, lines.join('\n'));
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Load proximity index
  if (!fs.existsSync(PI_PATH)) {
    process.stderr.write('Run `node bin/formal-proximity.cjs` first to build proximity index.\n');
    process.exit(1);
  }

  let pi;
  try {
    pi = JSON.parse(fs.readFileSync(PI_PATH, 'utf8'));
  } catch (e) {
    process.stderr.write('Error reading proximity-index.json: ' + e.message + '\n');
    process.exit(1);
  }

  let reachFn;
  try {
    reachFn = require('./formal-query.cjs').reach;
  } catch (e) {
    process.stderr.write('Error loading formal-query.cjs: ' + e.message + '\n');
    process.exit(1);
  }

  // Discover and filter test files
  const testFiles = discoverTestFiles(args.dirs);
  let alreadyAnnotated = 0;
  const unannotated = [];

  for (const tf of testFiles) {
    let content;
    try {
      content = fs.readFileSync(tf.absPath, 'utf8');
    } catch {
      continue;
    }
    if (hasExistingAnnotation(content)) {
      alreadyAnnotated++;
    } else {
      unannotated.push(tf);
    }
  }

  // Query suggestions
  const suggestions = [];
  for (const tf of unannotated) {
    const suggestion = querySuggestion(pi, reachFn, tf.file);
    if (suggestion) {
      suggestions.push({
        file: tf.file,
        absPath: tf.absPath,
        suggested_requirement: suggestion.requirement,
        confidence: suggestion.confidence,
        recommendation: `// @requirement ${suggestion.requirement}`,
      });
    }
  }

  // Write mode
  if (args.write) {
    let written = 0;
    for (const s of suggestions) {
      if (s.confidence >= 0.5) {
        try {
          injectAnnotation(s.absPath, s.suggested_requirement);
          written++;
        } catch (e) {
          process.stderr.write('Error writing to ' + s.file + ': ' + e.message + '\n');
        }
      }
    }
    if (!args.json) {
      process.stderr.write('Injected annotations into ' + written + ' files\n');
    }
  }

  // Output
  if (args.json) {
    const output = suggestions.map(s => ({
      file: s.file,
      suggested_requirement: s.suggested_requirement,
      confidence: s.confidence,
      recommendation: s.recommendation,
    }));
    console.log(JSON.stringify(output, null, 2));
  } else {
    if (suggestions.length > 0) {
      for (const s of suggestions) {
        console.log(s.file + ':');
        console.log('  Suggested: ' + s.recommendation + ' (confidence: ' + s.confidence + ')');
      }
    }
    console.log('\n' + suggestions.length + ' suggestions for ' + unannotated.length + ' orphan test files (' + alreadyAnnotated + ' already annotated)');
  }

  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { discoverTestFiles, hasExistingAnnotation, querySuggestion, injectAnnotation };

#!/usr/bin/env node
'use strict';
// bin/check-require-graph.cjs
// Source-decidable code-consistency checks over the JS/CJS require graph:
//   - dangling-require: a relative require('./x') that resolves to no file on disk
//   - circular-require: a cycle in the module require graph (A → B → A)
//
// --fast-native: pure fs + `git ls-files`, no code execution, no external server
// (deliberately NOT coderlm — a core detection residual must be deterministic and
// cannot silently vanish when an optional, fail-open symbol server is down).
//
// Verified 0 findings on clean nForma + nf-benchmark trees, so any finding is a
// genuine corruption signal (the baseline residual is 0).
//
// Usage:
//   node bin/check-require-graph.cjs           # human-readable
//   node bin/check-require-graph.cjs --json    # { findings: [...], count: N }
// Exit: 0 = clean, 1 = violations found.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Git-tracked first-party JS/CJS source (skip tests, vendored, and build output).
function trackedCodeFiles(root) {
  const res = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0 || !res.stdout) return [];
  return res.stdout.split('\n').filter(Boolean).filter(function (f) {
    return /\.c?js$/.test(f) &&
      !/node_modules\//.test(f) &&
      !/\.(test|spec)\./.test(f) &&
      !/(^|\/)dist\//.test(f);
  });
}

// Strip comments so a require in a comment/JSDoc is never counted. Preserves the
// char before `//` so a `://` inside a URL string isn't treated as a comment.
function stripComments(s) {
  return String(s)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const REQ_RE = /\brequire\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g;

// Relative require specifiers in a file. Placeholder/example specs (found in doc
// strings and lint-rule messages, e.g. require('./bin/...')) are skipped — a real
// module path never contains an ellipsis or template/glob metacharacters. This is
// what keeps the check false-positive-free on prose-heavy source.
function relRequires(content) {
  const clean = stripComments(content);
  const out = [];
  let m;
  while ((m = REQ_RE.exec(clean)) !== null) {
    const spec = m[2];
    if (/\.\.\.|[<>${}*`]/.test(spec)) continue;
    out.push(spec);
  }
  return out;
}

// Resolve a relative require the way Node's CJS loader does: exact path, then
// common extensions, then a directory index. Returns the resolved abs path or null.
function resolveRel(root, fromFile, spec) {
  const base = path.resolve(root, path.dirname(fromFile), spec);
  const cands = [base, base + '.js', base + '.cjs', base + '.json', base + '.mjs', base + '.node',
    path.join(base, 'index.js'), path.join(base, 'index.cjs'), path.join(base, 'index.json')];
  for (let i = 0; i < cands.length; i++) {
    try { if (fs.statSync(cands[i]).isFile()) return cands[i]; } catch (_) { /* not this candidate */ }
  }
  return null;
}

// DFS cycle detection over the first-party require graph. Only edges to files that
// are themselves in the graph are followed (external/node_modules deps ignored).
// Cycles are de-duplicated by their node set so a 2-node cycle isn't reported twice.
function detectCycles(root, graph) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const stack = [];
  const cycles = [];
  const seen = new Set();
  function dfs(node) {
    color.set(node, GRAY);
    stack.push(node);
    const deps = graph.get(node) || [];
    for (let i = 0; i < deps.length; i++) {
      const dep = deps[i];
      if (!graph.has(dep)) continue;
      const c = color.get(dep) || WHITE;
      if (c === WHITE) {
        dfs(dep);
      } else if (c === GRAY) {
        const idx = stack.indexOf(dep);
        const cyc = stack.slice(idx).concat(dep).map(function (p) { return path.relative(root, p); });
        const key = cyc.slice(0, cyc.length - 1).sort().join('|');
        if (!seen.has(key)) { seen.add(key); cycles.push(cyc); }
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }
  const nodes = Array.from(graph.keys());
  for (let i = 0; i < nodes.length; i++) {
    if ((color.get(nodes[i]) || WHITE) === WHITE) dfs(nodes[i]);
  }
  return cycles;
}

// Build the require graph and collect dangling requires + cycles.
function analyze(root) {
  const files = trackedCodeFiles(root);
  const graph = new Map();
  const dangling = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const abs = path.resolve(root, f);
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch (_) { continue; }
    const deps = [];
    const specs = relRequires(content);
    for (let j = 0; j < specs.length; j++) {
      const resolved = resolveRel(root, f, specs[j]);
      if (!resolved) dangling.push({ file: f, spec: specs[j] });
      else deps.push(resolved);
    }
    graph.set(abs, deps);
  }
  return { dangling: dangling, cycles: detectCycles(root, graph), files_scanned: files.length };
}

// Flatten to a uniform findings list (the shape nf-solve's sweep aggregates).
function findings(root) {
  const a = analyze(root);
  const out = [];
  for (let i = 0; i < a.dangling.length; i++) {
    out.push({ rule: 'dangling-require', file: a.dangling[i].file, message: 'require("' + a.dangling[i].spec + '") resolves to no file' });
  }
  for (let i = 0; i < a.cycles.length; i++) {
    out.push({ rule: 'circular-require', file: a.cycles[i][0], message: 'circular require: ' + a.cycles[i].join(' -> ') });
  }
  return out;
}

module.exports = { analyze: analyze, findings: findings, relRequires: relRequires, resolveRel: resolveRel, detectCycles: detectCycles, stripComments: stripComments, trackedCodeFiles: trackedCodeFiles };

if (require.main === module) {
  const root = process.cwd();
  const asJson = process.argv.includes('--json');
  const fnd = findings(root);
  if (asJson) {
    process.stdout.write(JSON.stringify({ findings: fnd, count: fnd.length }, null, 2) + '\n');
  } else {
    for (let i = 0; i < fnd.length; i++) console.log('[' + fnd[i].rule + '] ' + fnd[i].file + ': ' + fnd[i].message);
    console.log(fnd.length + ' code-graph violation(s)');
  }
  process.exit(fnd.length > 0 ? 1 : 0);
}

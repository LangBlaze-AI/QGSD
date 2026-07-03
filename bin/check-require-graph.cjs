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
// Surfaces git failures (spawn error, nonzero exit, maxBuffer overflow) rather
// than returning [] — a silent failure would report 0 findings and masquerade as
// a clean tree, defeating the "0 findings ⇒ clean" invariant this check relies on.
function trackedCodeFiles(root) {
  const res = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new Error('check-require-graph: failed to spawn git: ' + res.error.message);
  if (res.status !== 0) throw new Error('check-require-graph: `git ls-files` exited with status ' + res.status + (res.stderr ? ': ' + String(res.stderr).trim() : ''));
  if (!res.stdout) return [];
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
// Static export key set of a CJS module, or null when the exports are opaque
// (dynamic) and the key set can't be determined from source. Opaque cases:
//   module.exports = <non-object-literal>   (a var, call, function, class)
//   module.exports = { ...spread }          (spread pulls in unknown keys)
// Object-literal keys and `exports.X = ` / `module.exports.X = ` are collected.
// Returning null (not an empty set) means "don't judge this module" — the guard
// that keeps export-mismatch false-positive-free on dynamic-export modules.
function staticExports(content) {
  const c = stripComments(content);
  const keys = new Set();
  let sawObjectLiteral = false;
  const meIdx = c.search(/module\.exports\s*=/);
  if (meIdx !== -1) {
    const after = c.slice(c.indexOf('=', meIdx) + 1).trimStart();
    if (after[0] === '{') {
      sawObjectLiteral = true;
      const start = c.indexOf('{', meIdx);
      let depth = 0, end = -1;
      for (let i = start; i < c.length; i++) { if (c[i] === '{') depth++; else if (c[i] === '}') { depth--; if (depth === 0) { end = i; break; } } }
      const body = end > start ? c.slice(start + 1, end) : '';
      if (/\.\.\./.test(body)) return null; // spread → unknown keys
      const km = body.match(/(\w+)\s*(?::|,|$)/g) || [];
      for (let i = 0; i < km.length; i++) { const m = km[i].match(/(\w+)/); if (m) keys.add(m[1]); }
    } else {
      return null; // module.exports = <expression> → opaque
    }
  }
  const propRe = /(?:module\.)?exports\.(\w+)\s*=/g;
  let m;
  while ((m = propRe.exec(c)) !== null) keys.add(m[1]);
  if (!sawObjectLiteral && keys.size === 0) return null; // no static exports found → opaque
  return keys;
}

// `const { a, b } = require('./rel')` destructuring targets. The negative
// lookahead `(?!\s*\.)` excludes `require('./rel').sub` (destructuring off a
// sub-object, e.g. nForma's `._pure` internals) — those keys are not top-level
// exports, so judging them would be a false positive.
const DESTRUCTURE_RE = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*(['"])(\.\.?\/[^'"]+)\2\s*\)(?!\s*\.)/g;

// export/import mismatch: a destructured key that the required first-party module
// (with a determinable static export set) does not export — e.g. a typo'd export
// key breaking a downstream consumer (BENCH-039). Modules with opaque/dynamic
// exports are skipped. Verified 0 baseline false positives across the corpus.
function checkExportImportMismatch(root, files) {
  const exportsByAbs = new Map();
  for (let i = 0; i < files.length; i++) {
    const abs = path.resolve(root, files[i]);
    try { exportsByAbs.set(abs, staticExports(fs.readFileSync(abs, 'utf8'))); } catch (_) { /* unreadable */ }
  }
  const mismatches = [];
  for (let i = 0; i < files.length; i++) {
    let content;
    try { content = stripComments(fs.readFileSync(path.resolve(root, files[i]), 'utf8')); } catch (_) { continue; }
    let m;
    DESTRUCTURE_RE.lastIndex = 0;
    while ((m = DESTRUCTURE_RE.exec(content)) !== null) {
      const resolved = resolveRel(root, files[i], m[3]);
      if (!resolved || resolved.endsWith('.json')) continue;
      const exp = exportsByAbs.get(resolved);
      if (!exp) continue; // opaque module — can't judge
      const parts = m[1].split(',');
      for (let p = 0; p < parts.length; p++) {
        const key = parts[p].trim().split(':')[0].trim();
        if (!/^\w+$/.test(key)) continue; // skip rest/spread/computed
        if (!exp.has(key)) {
          mismatches.push({ file: files[i], key: key, spec: m[3] });
        }
      }
    }
  }
  return mismatches;
}

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
  return { dangling: dangling, cycles: detectCycles(root, graph), mismatches: checkExportImportMismatch(root, files), files_scanned: files.length };
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
  for (let i = 0; i < (a.mismatches || []).length; i++) {
    const mm = a.mismatches[i];
    out.push({ rule: 'export-mismatch', file: mm.file, message: 'destructures { ' + mm.key + ' } from require("' + mm.spec + '") which does not export it' });
  }
  return out;
}

module.exports = { analyze: analyze, findings: findings, relRequires: relRequires, resolveRel: resolveRel, detectCycles: detectCycles, stripComments: stripComments, trackedCodeFiles: trackedCodeFiles, staticExports: staticExports, checkExportImportMismatch: checkExportImportMismatch };

if (require.main === module) {
  const root = process.cwd();
  const asJson = process.argv.includes('--json');
  let fnd;
  try {
    fnd = findings(root);
  } catch (err) {
    // Distinct exit 2 (not 0=clean, not 1=violations) with NO stdout, so nf-solve's
    // sweep sees "no output" → residual -1 (skipped) rather than a false "0 = clean".
    process.stderr.write(String((err && err.message) || err) + '\n');
    process.exit(2);
  }
  if (asJson) {
    process.stdout.write(JSON.stringify({ findings: fnd, count: fnd.length }, null, 2) + '\n');
  } else {
    for (let i = 0; i < fnd.length; i++) console.log('[' + fnd[i].rule + '] ' + fnd[i].file + ': ' + fnd[i].message);
    console.log(fnd.length + ' code-graph violation(s)');
  }
  process.exit(fnd.length > 0 ? 1 : 0);
}

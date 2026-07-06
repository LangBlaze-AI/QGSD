#!/usr/bin/env node
'use strict';

/**
 * bin/skill-invocation-lint.cjs — verify every skill's REAL invocation surface resolves.
 *
 * The recurring "skill ships green but is non-functional" class (see the skill-livepath
 * test gap): a command/workflow references a `node .../<tool>.cjs`, spawns a
 * `subagent_type="nf-…"`, or `@`-includes a workflow that DOESN'T EXIST — unit tests pass
 * (they cover the pure helpers) but the skill dead-ends at runtime. This lint statically
 * resolves every such reference across commands/nf/*.md + their workflows.
 *
 * False-positive controls (learned from dogfooding): tool basenames are resolved across
 * ALL real locations (nf-bin, nf/bin, bin/ + subdirs, core/bin), and references that are
 * obviously placeholders (foo/example/missing/…) or sit inside an illustrative fenced
 * block are ignored — those are documentation, not invocations.
 *
 * Exports: lintSkills, resolveTool  ·  CLI: node bin/skill-invocation-lint.cjs [--json]
 * Exit 1 if any real reference is unresolved.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.join(__dirname, '..');
const HOME = os.homedir();
const CMDDIR = path.join(REPO, 'commands', 'nf');
const WFDIR = path.join(REPO, 'core', 'workflows');
const AGENTSRC = path.join(REPO, 'agents');

const PLACEHOLDER = /^(foo|bar|baz|example|sample|missing|dummy|old-script|placeholder|your-|my-|name)/;

const TOOL_DIRS = [
  path.join(HOME, '.claude', 'nf-bin'),
  path.join(HOME, '.claude', 'nf', 'bin'),
  path.join(REPO, 'bin'),
  path.join(REPO, 'core', 'bin'),
];

function resolveTool(t) {
  for (const d of TOOL_DIRS) if (fs.existsSync(path.join(d, t))) return path.join(d, t);
  // recursive scan of repo bin/ subdirs
  const stack = [path.join(REPO, 'bin')];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(d, e.name));
      else if (e.name === t) return path.join(d, e.name);
    }
  }
  return null;
}

// strip fenced blocks tagged as illustrative (```text/```output/no-lang display blocks that
// contain "not found"/"SHALL"/"Source:" mockups). We keep bash/sh blocks (real invocations).
function stripIllustrative(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let fence = null, illustrative = false, buf = [];
  for (const line of lines) {
    const m = line.match(/^\s*```(\w*)/);
    if (fence) {
      if (m) { // closing fence
        if (!illustrative) out.push(...buf);
        fence = null; illustrative = false; buf = [];
      } else buf.push(line);
      continue;
    }
    if (m) {
      fence = true;
      const lang = (m[1] || '').toLowerCase();
      illustrative = !['bash', 'sh', 'shell', 'zsh'].includes(lang) && lang !== '';
      buf = [];
      continue;
    }
    out.push(line);
  }
  if (fence && !illustrative) out.push(...buf);
  return out.join('\n');
}

// Only flag tools in real INVOCATION context — a `node <path>`, a shell var assignment to
// a .cjs path (the portable `REQ="…/<tool>.cjs"` pattern), or a `require(...)`. A bare
// `bin/x.cjs` mention in prose or a sample table is documentation, not an invocation.
function extractTools(text) {
  const tools = new Set();
  for (const m of text.matchAll(/node\s+(?:-[^\s]+\s+)*["']?[^"'\n|&;()]*?\/([a-z0-9-]+\.cjs)/g)) tools.add(m[1]);
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*=["']?\$?\{?[^"'\n]*?\/([a-z0-9-]+\.cjs)/g)) tools.add(m[1]);
  return [...tools].filter((t) => !PLACEHOLDER.test(t.replace(/\.cjs$/, '')));
}
function extractAgents(text) {
  const a = new Set();
  for (const m of text.matchAll(/subagent_type=["']?(nf-[a-z-]+)["']?/g)) a.add(m[1]);
  return [...a];
}

function lintSkills() {
  const findings = [];
  for (const f of fs.readdirSync(CMDDIR).filter((x) => x.endsWith('.md'))) {
    const name = f.replace('.md', '');
    const cmdText = fs.readFileSync(path.join(CMDDIR, f), 'utf8');
    const wfName = (cmdText.match(/~\/\.claude\/nf\/workflows\/([a-z-]+)\.md/) || [])[1];
    let wfText = '';
    if (wfName) {
      const wfPath = path.join(WFDIR, wfName + '.md');
      if (!fs.existsSync(wfPath)) findings.push({ skill: name, kind: 'workflow', ref: wfName, detail: 'command @-includes a workflow file that does not exist' });
      else wfText = fs.readFileSync(wfPath, 'utf8');
    }
    const scan = stripIllustrative(cmdText + '\n' + wfText);
    for (const t of extractTools(scan)) if (!resolveTool(t)) findings.push({ skill: name, kind: 'tool', ref: t, detail: 'referenced tool not found in any bin location' });
    for (const a of extractAgents(scan)) {
      if (!fs.existsSync(path.join(AGENTSRC, a + '.md'))) findings.push({ skill: name, kind: 'agent', ref: a, detail: 'spawned agent has no tracked source in agents/' });
    }
  }
  return findings;
}

if (require.main === module) {
  const findings = lintSkills();
  if (process.argv.includes('--json')) { process.stdout.write(JSON.stringify(findings, null, 2) + '\n'); process.exit(findings.length ? 1 : 0); }
  if (findings.length === 0) { process.stdout.write('skill-invocation-lint: all skill tool/agent/workflow references resolve ✓\n'); process.exit(0); }
  process.stdout.write('skill-invocation-lint: ' + findings.length + ' unresolved reference(s):\n');
  for (const x of findings) process.stdout.write('  ✗ ' + x.skill + ' → ' + x.kind + ' `' + x.ref + '` — ' + x.detail + '\n');
  process.exit(1);
}

module.exports = { lintSkills, resolveTool };

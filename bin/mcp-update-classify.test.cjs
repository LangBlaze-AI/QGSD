'use strict';
// bin/mcp-update-classify.test.cjs
// Guards F36 — /nf:mcp-update classified EVERY node-based slot as type:'local' with
// repoDir = dirname(dirname(args[0])), then ran `cd <repoDir> && git pull`. For a
// standard install the server runs from ~/.claude/nf-bin/, so repoDir resolved to
// ~/.claude — which is NOT a git repo — and `git pull` failed for every slot.
//
// The fix walks up to the nearest real .git working tree: found (a dev clone) →
// type:'local'; not found (standard install) → type:'nf-managed' (route to /nf:update).
//
// This test extracts the two inline `node << 'NF_EVAL'` blocks straight from the
// skill markdown and runs them against crafted ~/.claude.json fixtures with a fake
// HOME, so it exercises the exact code the skill ships.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MD = fs.readFileSync(path.join(__dirname, '../commands/nf/mcp-update.md'), 'utf8');

// Pull every `node << 'NF_EVAL' … NF_EVAL` heredoc body out of the markdown.
function heredocBodies(md) {
  // CRLF-tolerant: a checkout with autocrlf would otherwise break extraction.
  const re = /node << 'NF_EVAL'\r?\n([\s\S]*?)\r?\nNF_EVAL/g;
  const out = [];
  let m;
  while ((m = re.exec(md)) !== null) out.push(m[1]);
  return out;
}

const BODIES = heredocBodies(MD);
const SINGLE = BODIES.find(b => b.includes('process.env.AGENT') && b.includes('findGitRoot'));
const ALL = BODIES.find(b => b.includes('seenKeys') && b.includes('findGitRoot'));

// Run an extracted body as a standalone script with a given HOME + env.
function runBody(body, env) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-mcpupd-body-'));
  const file = path.join(tmp, 'body.cjs');
  fs.writeFileSync(file, body);
  try {
    const out = execFileSync('node', [file], { env: { ...process.env, ...env }, encoding: 'utf8' });
    return JSON.parse(out.trim());
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Build a fake HOME whose ~/.claude.json describes three slots:
//   nf-managed-slot — node, server under <HOME>/.claude/nf-bin/ (no .git ancestor)
//   dev-slot        — node, server under a real git working tree
//   npm-slot        — npx package
function makeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-fakehome-'));
  // Simulate a user who version-controls their HOME (dotfiles repo): there IS a
  // .git above the standard install. The ~/.claude guard must still classify the
  // managed server as nf-managed and NOT git-pull the dotfiles repo.
  fs.mkdirSync(path.join(home, '.git'), { recursive: true });
  // nf-managed: standard install path under ~/.claude/nf-bin/
  const nfBin = path.join(home, '.claude', 'nf-bin');
  fs.mkdirSync(nfBin, { recursive: true });
  const managedServer = path.join(nfBin, 'unified-mcp-server.mjs');
  fs.writeFileSync(managedServer, '// stub');

  // dev clone: a real git working tree two-or-more levels above the server
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-devrepo-'));
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'bin'), { recursive: true });
  const devServer = path.join(repo, 'bin', 'unified-mcp-server.mjs');
  fs.writeFileSync(devServer, '// stub');

  const cfg = {
    mcpServers: {
      'nf-managed-slot': { command: 'node', args: [managedServer] },
      'dev-slot': { command: 'node', args: [devServer] },
      'npm-slot': { command: 'npx', args: ['-y', 'some-mcp-package'] },
    },
  };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(cfg));
  return { home, repo, managedServer, devServer };
}

describe('F36 — mcp-update classifies node slots by real git root', () => {
  it('extracted both inline blocks from the skill', () => {
    assert.ok(SINGLE, 'single-agent NF_EVAL block (with findGitRoot) must exist');
    assert.ok(ALL, 'all-mode NF_EVAL block (with findGitRoot) must exist');
  });

  it('standard-install node slot → nf-managed even when HOME is a git (dotfiles) repo', () => {
    const fx = makeFixture();
    try {
      const r = runBody(SINGLE, { HOME: fx.home, AGENT: 'nf-managed-slot' });
      assert.equal(r.type, 'nf-managed', 'a server under ~/.claude/ is managed regardless of an ancestor .git');
      assert.ok(!('repoDir' in r), 'must not emit a repoDir that git-pull would cd into');
    } finally {
      fs.rmSync(fx.home, { recursive: true, force: true });
      fs.rmSync(fx.repo, { recursive: true, force: true });
    }
  });

  it('dev-clone node slot → local with the actual git root', () => {
    const fx = makeFixture();
    try {
      const r = runBody(SINGLE, { HOME: fx.home, AGENT: 'dev-slot' });
      assert.equal(r.type, 'local');
      assert.equal(r.repoDir, fx.repo, 'repoDir must be the .git working-tree root, not two-dirs-up');
    } finally {
      fs.rmSync(fx.home, { recursive: true, force: true });
      fs.rmSync(fx.repo, { recursive: true, force: true });
    }
  });

  it('npx slot → npm package (unchanged)', () => {
    const fx = makeFixture();
    try {
      const r = runBody(SINGLE, { HOME: fx.home, AGENT: 'npm-slot' });
      assert.equal(r.type, 'npm');
      assert.equal(r.package, 'some-mcp-package');
    } finally {
      fs.rmSync(fx.home, { recursive: true, force: true });
      fs.rmSync(fx.repo, { recursive: true, force: true });
    }
  });

  it('all-mode classifies each slot correctly and dedups nf-managed', () => {
    const fx = makeFixture();
    try {
      const tasks = runBody(ALL, { HOME: fx.home });
      const by = Object.fromEntries(tasks.map(t => [t.agent, t]));
      assert.equal(by['nf-managed-slot'].type, 'nf-managed');
      assert.equal(by['dev-slot'].type, 'local');
      assert.equal(by['dev-slot'].repoDir, fx.repo);
      assert.equal(by['npm-slot'].type, 'npm');
    } finally {
      fs.rmSync(fx.home, { recursive: true, force: true });
      fs.rmSync(fx.repo, { recursive: true, force: true });
    }
  });
});

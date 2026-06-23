#!/usr/bin/env node
'use strict';
// bin/skill-state-guards.test.cjs
// Dogfooding F48: skill .md inline-JS blocks that read state files must NOT
// crash with a raw stack trace when that state is missing or malformed. Each
// read here was guarded only by existsSync (or nothing) while the SAME file
// guarded an identical read elsewhere — localized omissions.
//
// These tests follow the live-path principle: they extract the ACTUAL embedded
// block from the .md and run it under broken state (helpers passing is not
// enough — the bug lived in the embedded snippet the skill runs at runtime).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CMD = path.join(__dirname, '..', 'commands', 'nf');
const read = (f) => fs.readFileSync(path.join(CMD, f), 'utf8');

// Extract `node << 'DELIM' ... DELIM` heredoc bodies from a skill .md.
function extractHeredocs(md, delim) {
  const bodies = [];
  const open = new RegExp(`<< '${delim}'\\s*$`);
  let cur = null;
  for (const line of md.split('\n')) {
    if (cur === null) {
      if (open.test(line)) cur = [];
    } else if (line.trim() === delim) {
      bodies.push(cur.join('\n'));
      cur = null;
    } else {
      cur.push(line);
    }
  }
  return bodies;
}

// Run an extracted block as a standalone script in an isolated cwd + HOME.
function runBlock(body, { cwd, home } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f48-'));
  const file = path.join(tmp, 'block.cjs');
  fs.writeFileSync(file, body);
  const r = spawnSync(process.execPath, [file], {
    cwd: cwd || tmp,
    env: { ...process.env, HOME: home || tmp },
    encoding: 'utf8',
    timeout: 10000,
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  return r;
}

const leaksCrash = (s) =>
  /\n\s+at .+:\d+:\d+/.test(s || '') || /\b(SyntaxError|TypeError|ReferenceError)\b/.test(s || '');

describe('mcp-status.md Step 1 tolerates malformed state (F48)', () => {
  const block = extractHeredocs(read('mcp-status.md'), 'EOF').find((b) => b.includes('scoreboard.json'));

  it('the Step 1 block is present', () => {
    assert.ok(block, 'could not extract the Step 1 EOF block that reads scoreboard.json');
  });

  it('emits valid JSON (no crash) when scoreboard.json AND ~/.claude.json are malformed', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'f48proj-'));
    fs.mkdirSync(path.join(proj, '.planning', 'quorum'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.planning', 'quorum', 'scoreboard.json'), '{bad,,,');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'f48home-'));
    fs.writeFileSync(path.join(home, '.claude.json'), '}{ not json');
    const r = runBlock(block, { cwd: proj, home });
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 0, `expected exit 0 (graceful), got ${r.status}; stderr=${r.stderr}`);
    assert.doesNotThrow(() => JSON.parse(r.stdout.trim()), `stdout must stay valid JSON, got: ${r.stdout}`);
  });
});

describe('mcp-repair.md providers.json blocks tolerate missing/malformed (F48)', () => {
  const blocks = extractHeredocs(read('mcp-repair.md'), 'NF_EVAL').filter((b) => b.includes('nf-bin'));

  it('the three guarded providers blocks are present', () => {
    assert.ok(blocks.length >= 3, `expected >=3 providers blocks, found ${blocks.length}`);
  });

  it('every providers block exits 0 with NO providers.json anywhere (installed-from-non-repo case)', () => {
    for (const b of blocks) {
      const r = runBlock(b, {}); // fresh empty cwd + HOME → no providers.json on any candidate path
      assert.equal(r.status, 0, `block crashed on missing providers.json (exit ${r.status}); stderr=${r.stderr}`);
      assert.ok(!leaksCrash(r.stdout), `a crash leaked to stdout: ${r.stdout}`);
    }
  });

  it('every providers block exits 0 with a MALFORMED ./bin/providers.json', () => {
    for (const b of blocks) {
      const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'f48mr-'));
      fs.mkdirSync(path.join(proj, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(proj, 'bin', 'providers.json'), '{bad json,,,');
      const r = runBlock(b, { cwd: proj, home: proj });
      fs.rmSync(proj, { recursive: true, force: true });
      assert.equal(r.status, 0, `block crashed on malformed providers.json (exit ${r.status}); stderr=${r.stderr}`);
    }
  });
});

describe('resolve.md Step 1 guards its state-file parses (F48)', () => {
  // The resolve block require()s solve-tui via _nfBin, which is not present in
  // a bare CI checkout — so this is a static guard rather than a live run.
  const md = read('resolve.md');

  it('the candidate-pairings parse is wrapped + shape-tolerant (no naked pd.pairings.filter)', () => {
    assert.ok(
      !/const pd = JSON\.parse\(fs\.readFileSync\(PAIRINGS_PATH[^]*?\n\s*const pending = pd\.pairings\.filter/.test(md),
      'unguarded `JSON.parse(PAIRINGS_PATH)` immediately followed by `pd.pairings.filter` is still present'
    );
    assert.ok(/Array\.isArray\(pd\.pairings\)/.test(md), 'expected shape-tolerant Array.isArray(pd.pairings) guard');
  });

  it('the candidates parse is wrapped in try/catch', () => {
    assert.ok(
      !/if \(fs\.existsSync\(CANDIDATES_PATH\)\) \{\s*\n\s*const cd = JSON\.parse/.test(md),
      'unguarded `JSON.parse(CANDIDATES_PATH)` directly under existsSync is still present'
    );
  });
});

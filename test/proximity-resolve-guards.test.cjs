'use strict';

// Dogfood Batch 3b (F47/F48): the proximity / candidate / resolve pipeline crashed
// with raw SyntaxError/TypeError stack traces on corrupt or wrong-shape state files,
// and solve-tui wrote garbage rows into the live .planning/todos.json / archive from
// an empty item. Each now degrades cleanly.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin');

// Run a pipeline script in a temp project whose .planning/formal holds the given
// files (value === null means write a corrupt/truncated JSON blob). Returns
// { code, stderr, stdout }.
function runIn(files, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prox-'));
  const formal = path.join(dir, '.planning', 'formal');
  fs.mkdirSync(formal, { recursive: true });
  for (const [name, val] of Object.entries(files)) {
    fs.writeFileSync(path.join(formal, name), val === null ? '{bad json' : JSON.stringify(val));
  }
  try {
    const stdout = execFileSync(process.execPath, [path.join(BIN, script)], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('proximity/resolve scripts emit a clean error (not a raw stack) on corrupt JSON', () => {
  it('candidate-discovery: corrupt proximity-index.json', () => {
    const r = runIn({
      'proximity-index.json': null,
      'model-registry.json': { models: {} },
      'requirements.json': { requirements: [] },
    }, 'candidate-discovery.cjs');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ERROR:.*not valid JSON/);
    assert.doesNotMatch(r.stderr, /at JSON\.parse/);
  });

  it('compute-semantic-scores: corrupt candidates.json', () => {
    const r = runIn({ 'candidates.json': null }, 'compute-semantic-scores.cjs');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ERROR:.*not valid JSON/);
    assert.doesNotMatch(r.stderr, /at JSON\.parse/);
  });

  it('candidate-pairings: corrupt candidates.json', () => {
    const r = runIn({ 'candidates.json': null }, 'candidate-pairings.cjs');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ERROR:.*not valid JSON/);
    assert.doesNotMatch(r.stderr, /at JSON\.parse/);
  });

  it('resolve-pairings: corrupt candidate-pairings.json', () => {
    const r = runIn({ 'candidate-pairings.json': null, 'model-registry.json': { models: {} } }, 'resolve-pairings.cjs');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ERROR:.*not valid JSON/);
    assert.doesNotMatch(r.stderr, /at JSON\.parse/);
  });
});

describe('resolve-pairings tolerates a non-array `pairings`', () => {
  it('does not crash on `.filter` of a wrong-shape pairings field', () => {
    const r = runIn({ 'candidate-pairings.json': { pairings: 'not-an-array' }, 'model-registry.json': { models: {} } }, 'resolve-pairings.cjs');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /No pending pairings/);
  });
});

describe('solve-tui refuses to write garbage from an empty item', () => {
  const tui = require(path.join(BIN, 'solve-tui.cjs'));

  it('createTodoFromItem({}) does not write a todo (returns ok:false)', () => {
    const res = tui.createTodoFromItem({});
    assert.equal(res.ok, false);
  });

  it('archiveItem({}) refuses (no identifying key)', () => {
    assert.equal(tui.archiveItem({}), false);
  });
});

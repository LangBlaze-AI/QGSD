'use strict';

// Unit tests for bin/check-petri-reachability.cjs — the structural Petri-net (PNML)
// unreachable-marking sweep. Pure fs + regex, no external tool, so these run
// unconditionally (no skip gating). They pin down BOTH the detection (a dead place
// is flagged) and the false-positive avoidance (live places, and ambiguous/malformed
// PNML that could hide an incoming arc, must NOT be flagged).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkPetriReachability, parsePnml, deadPlaces } = require('./check-petri-reachability.cjs');

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nf-petri-')); }
function writeNet(root, name, content) {
  const dir = path.join(root, '.planning', 'formal', 'petri');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

// s3: no initial marking, no incoming arc → structurally dead (unreachable marking).
// s2: fed by t1 → live. s1: initially marked → live.
const UNREACHABLE = '<?xml version="1.0"?><pnml><net id="bench" type="x"><page id="p1">'
  + '<place id="s1"><initialMarking><text>1</text></initialMarking></place>'
  + '<place id="s2"/><place id="s3"/><transition id="t1"/>'
  + '<arc id="a1" source="s1" target="t1"/><arc id="a2" source="t1" target="s2"/></page></net></pnml>';

// Every place is either initially marked or has an incoming arc → no dead place.
const CLEAN = '<?xml version="1.0"?><pnml><net id="ok" type="x"><page id="p1">'
  + '<place id="a"><initialMarking><text>1</text></initialMarking></place>'
  + '<place id="b"/><transition id="t1"/>'
  + '<arc id="r1" source="a" target="t1"/><arc id="r2" source="t1" target="b"/></page></net></pnml>';

// ── parse/analysis unit ──────────────────────────────────────────────────────

test('parsePnml extracts places, transitions, arcs; deadPlaces finds the dead one', () => {
  const net = parsePnml(UNREACHABLE);
  assert.ok(net, 'well-formed net parses');
  assert.strictEqual(net.places.length, 3);
  assert.strictEqual(net.transitions.length, 1);
  assert.strictEqual(net.arcs.length, 2);
  assert.deepStrictEqual(deadPlaces(net), ['s3']);
});

test('an initial marking of 0 does NOT count as marked', () => {
  const net = parsePnml('<pnml><net id="n"><place id="z"><initialMarking><text>0</text></initialMarking></place></net></pnml>');
  assert.ok(net);
  assert.deepStrictEqual(deadPlaces(net), ['z'], 'a 0-token initial marking is still empty → dead');
});

// ── fail-open FP guards ──────────────────────────────────────────────────────

test('parsePnml returns null when a <place> is malformed (count mismatch → fail-open)', () => {
  // Two raw `<place` tags but the second is unterminated: the regex can only capture
  // one, so the counts disagree and we refuse to reason (a hidden arc could exist).
  const net = parsePnml('<pnml><net id="n"><place id="a"/><place id="b" ></net></pnml>');
  assert.strictEqual(net, null);
});

test('parsePnml returns null when a place has no id (ambiguous)', () => {
  const net = parsePnml('<pnml><net id="n"><place/><transition id="t"/></net></pnml>');
  assert.strictEqual(net, null);
});

test('parsePnml returns null when there are no places at all', () => {
  assert.strictEqual(parsePnml('<pnml><net id="n"></net></pnml>'), null);
});

test('XML comments hiding an arc do not cause a false positive', () => {
  // The incoming arc to s2 is real; a comment near it must not desync the count guard.
  const withComment = '<pnml><net id="n"><page id="p">'
    + '<place id="s1"><initialMarking><text>1</text></initialMarking></place>'
    + '<place id="s2"/><transition id="t1"/>'
    + '<!-- wiring --><arc id="a1" source="s1" target="t1"/><arc id="a2" source="t1" target="s2"/>'
    + '</page></net></pnml>';
  const net = parsePnml(withComment);
  assert.ok(net);
  assert.deepStrictEqual(deadPlaces(net), [], 's2 is fed by t1 → live, not flagged');
});

// ── end-to-end sweep ─────────────────────────────────────────────────────────

test('detects the unreachable place end-to-end', () => {
  const root = tmpRoot();
  try {
    writeNet(root, 'bench.pnml', UNREACHABLE);
    const r = checkPetriReachability(root);
    assert.strictEqual(r.skipped, false);
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.findings[0].rule, 'unreachable-marking');
    assert.strictEqual(r.findings[0].place, 's3');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a clean net produces 0 findings', () => {
  const root = tmpRoot();
  try {
    writeNet(root, 'clean.pnml', CLEAN);
    const r = checkPetriReachability(root);
    assert.strictEqual(r.count, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('no petri dir → clean, never a crash', () => {
  const root = tmpRoot();
  try {
    const r = checkPetriReachability(root);
    assert.strictEqual(r.skipped, false);
    assert.strictEqual(r.count, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a malformed .pnml in the dir is skipped, not flagged (fail-open)', () => {
  const root = tmpRoot();
  try {
    writeNet(root, 'bad.pnml', '<pnml><net id="n"><place id="a"/><place id="b" ></net></pnml>');
    const r = checkPetriReachability(root);
    assert.strictEqual(r.count, 0, 'ambiguous parse yields no finding');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

#!/usr/bin/env node
'use strict';
// bin/check-petri-reachability.cjs
// Structural reachability sweep for Petri nets (PNML): flags places that can NEVER
// hold a token — a place with no initial marking AND no incoming arc from any
// transition. Such a place is structurally dead, so any marking that requires a
// token there is UNREACHABLE. This is a BEHAVIORAL formal defect (a modeled state
// the net can never actually reach) that structural lint over the file text misses.
//
// Soundness: a place gains tokens ONLY when a transition with an arc into it fires.
// No incoming arc + empty initial marking ⇒ the place is permanently empty ⇒ any
// marking placing a token there is unreachable. This is decidable STATICALLY (no
// state-space search) and false-positive-free — the same confidence profile as the
// deadlock/invariant-violation sweep (check-model-invariants.cjs).
//
// FP-safety: nForma ships no XML parser (zero-dep). Rather than trust a regex over
// arbitrary XML, the parser cross-checks its element counts against the raw
// `<place`/`<transition`/`<arc` tag counts; ANY mismatch (a missed or malformed
// element that could hide an incoming arc and cause a false "dead" verdict) makes
// the whole file skip — fail-open, never a false finding. Reporting a dead place
// requires a fully, unambiguously parsed net.
//
// Usage:  node bin/check-petri-reachability.cjs --json  → { findings, count, skipped? }
// Exit:   0 = clean/skipped, 1 = unreachable places found.

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();

function stripXmlComments(s) {
  return String(s).replace(/<!--[\s\S]*?-->/g, ' ');
}

function attr(attrs, name) {
  const m = attrs.match(new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"'));
  return m ? m[1] : null;
}

// Parse a PNML net into {places:[{id,marked}], transitions:[ids], arcs:[{source,target}]}
// or return null if the parse is ambiguous (element counts don't match raw tag counts).
function parsePnml(raw) {
  const content = stripXmlComments(raw);

  // Raw tag counts — the ground truth the regex extraction must exactly reproduce.
  const rawPlaces = (content.match(/<place\b/g) || []).length;
  const rawTransitions = (content.match(/<transition\b/g) || []).length;
  const rawArcs = (content.match(/<arc\b/g) || []).length;
  if (rawPlaces === 0) return null; // not a place/transition net we can reason about

  const places = [];
  const placeRe = /<place\b([^>]*?)(?:\/>|>([\s\S]*?)<\/place>)/g;
  let m;
  while ((m = placeRe.exec(content)) !== null) {
    const id = attr(m[1], 'id');
    if (id === null) return null; // a place without an id → ambiguous, bail
    const body = m[2] || '';
    // Initially marked iff an <initialMarking> carries a positive token count.
    const mk = body.match(/<initialMarking\b[^>]*>[\s\S]*?<text>\s*([0-9]+)\s*<\/text>[\s\S]*?<\/initialMarking>/);
    const marked = !!(mk && parseInt(mk[1], 10) > 0);
    places.push({ id, marked });
  }

  const transitions = [];
  const transRe = /<transition\b([^>]*?)(?:\/>|>[\s\S]*?<\/transition>)/g;
  while ((m = transRe.exec(content)) !== null) {
    const id = attr(m[1], 'id');
    if (id === null) return null;
    transitions.push(id);
  }

  const arcs = [];
  const arcRe = /<arc\b([^>]*?)(?:\/>|>[\s\S]*?<\/arc>)/g;
  while ((m = arcRe.exec(content)) !== null) {
    const source = attr(m[1], 'source');
    const target = attr(m[1], 'target');
    if (source === null || target === null) return null;
    arcs.push({ source, target });
  }

  // Cross-check: every raw tag must have been captured. A mismatch means the regex
  // missed/misparsed an element — an unseen incoming arc could turn a "dead" place
  // live, so we refuse to reason about this file (fail-open, no false positive).
  if (places.length !== rawPlaces || transitions.length !== rawTransitions || arcs.length !== rawArcs) {
    return null;
  }
  return { places, transitions, arcs };
}

// A place is structurally unreachable (dead) iff it is not initially marked AND no
// arc targets it (no transition can ever deposit a token there).
function deadPlaces(net) {
  const incoming = new Set(net.arcs.map(a => a.target));
  return net.places.filter(p => !p.marked && !incoming.has(p.id)).map(p => p.id);
}

function checkPetriReachability(root) {
  const dir = path.join(root, '.planning', 'formal', 'petri');
  if (!fs.existsSync(dir)) return { skipped: false, findings: [], count: 0 };
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.pnml')); }
  catch (_) { return { skipped: false, findings: [], count: 0 }; }

  const findings = [];
  for (const f of files) {
    let content;
    try { content = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { continue; }
    let net;
    try { net = parsePnml(content); } catch (_) { net = null; }
    if (!net) continue; // ambiguous/malformed → fail-open (no finding)
    const dead = deadPlaces(net);
    for (const pid of dead) {
      findings.push({
        rule: 'unreachable-marking',
        model: f.replace(/\.pnml$/, ''),
        place: pid,
        message: 'Petri place ' + pid + ' has no initial marking and no incoming arc — any marking requiring a token there is unreachable in ' + f,
      });
    }
  }
  return { skipped: false, findings: findings, count: findings.length };
}

module.exports = { checkPetriReachability: checkPetriReachability, parsePnml: parsePnml, deadPlaces: deadPlaces };

if (require.main === module) {
  const asJson = process.argv.includes('--json');
  const r = checkPetriReachability(ROOT);
  if (asJson) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  } else if (r.skipped) {
    console.log('[petri-check] skipped: ' + (r.reason || 'n/a'));
  } else {
    for (const f of r.findings) console.log('[' + f.rule + '] ' + f.model + ': ' + f.message);
    console.log(r.count + ' unreachable-marking finding(s)');
  }
  process.exit(!r.skipped && r.count > 0 ? 1 : 0);
}

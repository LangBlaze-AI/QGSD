#!/usr/bin/env node
'use strict';

/**
 * bin/seeds.cjs — forward-looking idea capture ("seeds").
 *
 * Ported from open-gsd/gsd-core's capture/seeds. A seed is an idea that isn't a task yet:
 * it carries a TRIGGER condition ("when X happens, do this") and parks in
 * .planning/seeds/SEED-NNN-slug.md until the trigger fires or it's promoted to the roadmap.
 * Fills a real gap — we had todos (do-now) but no way to park a conditional future idea.
 *
 * nForma fusion: a seed can be tagged `formal: true` (auto-detected from formal-relevant
 * text, or --formal) so promotion routes through /nf:close-formal-gaps — a parked idea
 * that changes a formally-modeled behavior lands as an invariant, not just a plan.
 *
 * Verbs:
 *   plant <text> [--trigger <cond>] [--scope <area>] [--formal] [--root <dir>]
 *   list [--status dormant|promoted|all] [--root <dir>] [--json]
 *   promote <SEED-NNN> [--root <dir>]   (prints a ROADMAP 999.x backlog entry — non-destructive)
 *
 * Exports: slugify, nextSeedId, parseSeed, looksFormal
 */

const fs = require('fs');
const path = require('path');

const FORMAL_HINT_RE = /\b(invariant|tla\+?|alloy|prism|petri|formal|model[- ]check|state machine|liveness|safety property|deadlock)\b/i;

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'seed';
}

function looksFormal(text) { return FORMAL_HINT_RE.test(String(text || '')); }

function seedsDir(root) { return path.join(root || process.cwd(), '.planning', 'seeds'); }

function nextSeedId(dir) {
  let max = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^SEED-(\d+)-/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch (_) { /* dir may not exist yet */ }
  return 'SEED-' + String(max + 1).padStart(3, '0');
}

function parseSeed(text) {
  const fm = {};
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (m) for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return fm;
}

function plant(root, textAndOpts) {
  const { text, trigger, scope, formal, now } = textAndOpts;
  const dir = seedsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const id = nextSeedId(dir);
  const slug = slugify(text);
  const isFormal = formal || looksFormal(text + ' ' + (trigger || ''));
  const file = path.join(dir, id + '-' + slug + '.md');
  const created = now || new Date().toISOString();
  const body = [
    '---',
    'id: ' + id,
    'title: ' + JSON.stringify(text),
    'status: dormant',
    'created: ' + created,
    'trigger: ' + JSON.stringify(trigger || 'none — surface at next /nf:new-milestone'),
    'scope: ' + JSON.stringify(scope || 'general'),
    'formal: ' + (isFormal ? 'true' : 'false'),
    '---',
    '',
    '# ' + text,
    '',
    '**Trigger:** ' + (trigger || 'none — review at next milestone planning.'),
    isFormal ? '\n**Formal:** touches a formally-modeled behavior — on promotion, route through `/nf:close-formal-gaps` to land the invariant.\n' : '',
  ].join('\n');
  fs.writeFileSync(file, body);
  return { id, path: file, formal: isFormal };
}

function list(root, status) {
  const dir = seedsDir(root);
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^SEED-\d+-.*\.md$/.test(f)); } catch (_) { return out; }
  for (const f of files) {
    let fm = {};
    try { fm = parseSeed(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
    if (status && status !== 'all' && fm.status !== status) continue;
    out.push({ id: fm.id || f, title: fm.title || '', status: fm.status || 'dormant', trigger: fm.trigger || '', scope: fm.scope || '', formal: fm.formal === 'true', file: f });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// ─── CLI ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  const get = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : undefined; };
  const has = (flag) => argv.includes(flag);
  const root = get('--root') || process.cwd();

  try {
    if (verb === 'plant') {
      // text = all args after `plant` up to the first --flag
      const textParts = [];
      for (let i = 1; i < argv.length && !argv[i].startsWith('--'); i++) textParts.push(argv[i]);
      const text = textParts.join(' ').trim();
      if (!text) { process.stderr.write('usage: seeds plant <text> [--trigger C] [--scope S] [--formal]\n'); process.exit(1); }
      const r = plant(root, { text, trigger: get('--trigger'), scope: get('--scope'), formal: has('--formal') });
      process.stdout.write('Planted ' + r.id + (r.formal ? ' (formal)' : '') + ' → ' + path.relative(root, r.path) + '\n');
      process.exit(0);
    }
    if (verb === 'list') {
      const seeds = list(root, get('--status') || 'all');
      if (has('--json')) { process.stdout.write(JSON.stringify(seeds, null, 2) + '\n'); process.exit(0); }
      if (seeds.length === 0) { process.stdout.write('No seeds planted.\n'); process.exit(0); }
      process.stdout.write('Seeds (' + seeds.length + '):\n');
      for (const s of seeds) process.stdout.write('  ' + s.id + ' [' + s.status + (s.formal ? '·formal' : '') + '] ' + s.title + '  — trigger: ' + s.trigger + '\n');
      process.exit(0);
    }
    if (verb === 'promote') {
      const id = argv[1];
      const seeds = list(root, 'all').filter((s) => s.id === id);
      if (seeds.length === 0) { process.stderr.write('No such seed: ' + id + '\n'); process.exit(1); }
      const s = seeds[0];
      process.stdout.write('Add to ROADMAP.md backlog (999.x):\n\n');
      process.stdout.write('### Phase 999.x: ' + s.title + '\n' + (s.formal ? '> Formal: route through /nf:close-formal-gaps on planning.\n' : '') + '> From ' + s.id + ' · scope: ' + s.scope + '\n');
      process.exit(0);
    }
    process.stderr.write('usage: seeds <plant|list|promote> …\n'); process.exit(1);
  } catch (e) { process.stderr.write('seeds error: ' + e.message + '\n'); process.exit(1); }
}

module.exports = { slugify, nextSeedId, parseSeed, looksFormal, plant, list, seedsDir };

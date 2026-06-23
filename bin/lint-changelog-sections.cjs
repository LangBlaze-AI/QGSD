#!/usr/bin/env node
'use strict';
// bin/lint-changelog-sections.cjs
//
// Detects (and with --fix, merges) duplicate "### <Section>" headers within a
// single version block of CHANGELOG.md. Two `### Fixed` under one `## [version]`
// accrete from PR merges (each PR adds its own section), which splits entries
// across duplicate headers and reads as a mess. The merge keeps one header per
// section name (first-seen order) and concatenates every occurrence's bullets.
//
// Usage:
//   node bin/lint-changelog-sections.cjs            # detect; exit 1 if dups
//   node bin/lint-changelog-sections.cjs --fix      # merge dups in place
//   node bin/lint-changelog-sections.cjs --file P   # operate on a custom path

const fs = require('fs');
const path = require('path');

// Split text into version blocks. Each block starts at a `## ` heading (or the
// file preamble before the first one) and runs to the next `## ` heading.
function splitVersionBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let cur = { heading: null, lines: [] };
  for (const line of lines) {
    if (/^## (?!#)/.test(line)) {
      blocks.push(cur);
      cur = { heading: line, lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  blocks.push(cur);
  return blocks; // blocks[0] is the preamble (heading null)
}

// Within one version block, return the ordered list of `### <name>` sections,
// each with its body lines (everything up to the next `### ` or block end).
function parseSections(blockLines) {
  const head = [];          // lines before the first ### (the ## heading + blanks)
  const sections = [];      // { name, body: [lines] }
  let cur = null;
  for (const line of blockLines) {
    const m = /^### (.+?)\s*$/.exec(line);
    if (m) {
      cur = { name: m[1], body: [] };
      sections.push(cur);
    } else if (cur) {
      cur.body.push(line);
    } else {
      head.push(line);
    }
  }
  return { head, sections };
}

// Returns [{ version, section, count }] for every section name that appears
// more than once inside a single version block.
function findDuplicateSections(text) {
  const dups = [];
  for (const block of splitVersionBlocks(text)) {
    if (!block.heading) continue;
    const { sections } = parseSections(block.lines);
    const counts = new Map();
    for (const s of sections) counts.set(s.name, (counts.get(s.name) || 0) + 1);
    for (const [section, count] of counts) {
      if (count > 1) dups.push({ version: block.heading.trim(), section, count });
    }
  }
  return dups;
}

// Merge duplicate sections within each block; returns the rewritten text.
function fixDuplicates(text) {
  const out = [];
  for (const block of splitVersionBlocks(text)) {
    if (!block.heading) { out.push(...block.lines); continue; }
    const { head, sections } = parseSections(block.lines);
    const names = sections.map((s) => s.name);
    const hasDup = names.length !== new Set(names).size;
    // Only the offending block is rewritten — blocks without duplicate sections
    // are emitted byte-for-byte unchanged (no whitespace normalization).
    if (!hasDup) { out.push(...block.lines); continue; }
    // Group bodies by section name, preserving first-seen order.
    const order = [];
    const merged = new Map();
    for (const s of sections) {
      const body = s.body.slice();
      // trim leading/trailing blank lines of each contribution for clean joins
      while (body.length && body[0].trim() === '') body.shift();
      while (body.length && body[body.length - 1].trim() === '') body.pop();
      if (!merged.has(s.name)) { merged.set(s.name, []); order.push(s.name); }
      merged.get(s.name).push(...body);
    }
    // trim trailing blank lines of the head
    const headTrim = head.slice();
    while (headTrim.length && headTrim[headTrim.length - 1].trim() === '') headTrim.pop();
    out.push(...headTrim, '');
    order.forEach((name) => {
      out.push(`### ${name}`);
      out.push(...merged.get(name));
      out.push('');
    });
  }
  // Single trailing newline; do NOT globally collapse blank runs (untouched
  // blocks must stay byte-for-byte identical).
  return out.join('\n').replace(/\n+$/, '\n');
}

function main() {
  const args = process.argv.slice(2);
  const fix = args.includes('--fix');
  const fileIdx = args.indexOf('--file');
  const file = fileIdx !== -1 && args[fileIdx + 1]
    ? args[fileIdx + 1]
    : path.join(__dirname, '..', 'CHANGELOG.md');

  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { process.stderr.write(`Error: cannot read ${file}: ${e.message}\n`); process.exit(2); }

  const dups = findDuplicateSections(text);
  if (fix) {
    if (!dups.length) { console.log('No duplicate sections — nothing to fix.'); return; }
    fs.writeFileSync(file, fixDuplicates(text));
    console.log(`Merged duplicate sections in ${path.basename(file)}:`);
    for (const d of dups) console.log(`  ${d.version}: "### ${d.section}" appeared ${d.count}× → merged`);
    return;
  }
  if (dups.length) {
    process.stderr.write('Duplicate CHANGELOG sections within a version block (run with --fix):\n');
    for (const d of dups) process.stderr.write(`  ${d.version}: "### ${d.section}" appears ${d.count}×\n`);
    process.exit(1);
  }
  console.log('CHANGELOG sections OK — no duplicates.');
}

if (require.main === module) main();
module.exports = { splitVersionBlocks, parseSections, findDuplicateSections, fixDuplicates };

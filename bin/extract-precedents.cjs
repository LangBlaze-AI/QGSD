#!/usr/bin/env node
'use strict';
// bin/extract-precedents.cjs
// Extracts APPROVE/BLOCK precedents from quorum debate archive markdown files.
// Produces a structured JSON database for downstream consumption by quorum dispatch.
//
// Usage:
//   node bin/extract-precedents.cjs [debates-dir] [output-path]
//   Defaults: debates-dir = .planning/quorum/debates/
//             output-path = .planning/quorum/precedents.json
//
// Requirements: QPREC-01

const fs   = require('fs');
const path = require('path');

// ── Default Paths ────────────────────────────────────────────────────────────

const DEFAULT_DEBATES_DIR = path.join(process.cwd(), '.planning', 'quorum', 'debates');
const DEFAULT_OUTPUT_PATH = path.join(process.cwd(), '.planning', 'quorum', 'precedents.json');

// ── TTL Configuration ────────────────────────────────────────────────────────

const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// ── Core Functions ───────────────────────────────────────────────────────────

/**
 * Extract precedent metadata from a single debate markdown file.
 * Returns object with { question, date, consensus, outcome, source_file, computed_at }
 * or null if required fields are missing or consensus is INCONCLUSIVE.
 */
function extractPrecedentMetadata(filePath, content) {
  // Guard: content must be a string to run regex matches against
  if (typeof content !== 'string') {
    return null;
  }

  // Extract Question (case-insensitive, whitespace-tolerant)
  const questionMatch = content.match(/^question:\s*(.+)/im);
  if (!questionMatch) {
    process.stderr.write(`Skipped ${path.basename(filePath)}: missing Question field\n`);
    return null;
  }
  const question = questionMatch[1].trim();

  // Extract Date as YYYY-MM-DD
  const dateMatch = content.match(/^date:\s*(\d{4}-\d{2}-\d{2})/im);
  if (!dateMatch) {
    process.stderr.write(`Skipped ${path.basename(filePath)}: missing Date field\n`);
    return null;
  }
  const date = dateMatch[1].trim();

  // Extract Consensus (case-insensitive)
  const consensusMatch = content.match(/^consensus:\s*(APPROVE|BLOCK|INCONCLUSIVE)/im);
  if (!consensusMatch) {
    process.stderr.write(`Skipped ${path.basename(filePath)}: missing or unrecognized Consensus field\n`);
    return null;
  }
  const consensus = consensusMatch[1].toUpperCase();

  // Skip INCONCLUSIVE — only APPROVE and BLOCK are precedents
  if (consensus === 'INCONCLUSIVE') {
    process.stderr.write(`Skipped ${path.basename(filePath)}: INCONCLUSIVE consensus\n`);
    return null;
  }

  // Extract Outcome section (everything between ## Outcome and next ## or EOF)
  let outcome = '';
  const outcomeIdx = content.search(/^## Outcome/im);
  if (outcomeIdx >= 0) {
    const afterHeader = content.slice(outcomeIdx).replace(/^## Outcome\s*\n/, '');
    const nextH2 = afterHeader.search(/\n## /);
    outcome = nextH2 >= 0 ? afterHeader.slice(0, nextH2).trim() : afterHeader.trim();
  }

  return {
    question,
    date,
    consensus,
    outcome,
    source_file: filePath,
    computed_at: new Date().toISOString()
  };
}

/**
 * Check if a precedent is fresh (within TTL).
 * Default maxAgeMs = 90 days.
 * Returns false for invalid dates (does not throw).
 */
function isPrecedentFresh(precedent, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  try {
    const precedentTime = new Date(precedent.date).getTime();
    if (isNaN(precedentTime)) {
      process.stderr.write(`Warning: invalid date "${precedent.date}" in precedent — treating as stale\n`);
      return false;
    }
    return (Date.now() - precedentTime) < maxAgeMs;
  } catch {
    return false;
  }
}

/**
 * Main orchestrator: scan debates dir, extract metadata, filter, write output.
 */
async function main(debatesDir, outputPath) {
  const dir = debatesDir || DEFAULT_DEBATES_DIR;
  const out = outputPath || DEFAULT_OUTPUT_PATH;

  if (!fs.existsSync(dir)) {
    process.stderr.write(`Error: debates directory not found: ${dir}\n`);
    process.exit(1);
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
  const debateCount = files.length;
  let skippedInconclusive = 0;
  let skippedMalformed = 0;
  let skippedStale = 0;
  const precedents = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      // Unreadable entry (directory named *.md, broken symlink, EACCES) — skip
      skippedMalformed++;
      continue;
    }
    const meta = extractPrecedentMetadata(filePath, content);

    if (!meta) {
      // Determine skip reason for stats
      const consensusMatch = content.match(/^consensus:\s*(APPROVE|BLOCK|INCONCLUSIVE)/im);
      if (consensusMatch && consensusMatch[1].toUpperCase() === 'INCONCLUSIVE') {
        skippedInconclusive++;
      } else {
        skippedMalformed++;
      }
      continue;
    }

    if (!isPrecedentFresh(meta)) {
      skippedStale++;
      continue;
    }

    precedents.push(meta);
  }

  const skippedTotal = skippedInconclusive + skippedStale + skippedMalformed;

  const output = {
    precedents,
    extracted_at: new Date().toISOString(),
    debate_count: debateCount,
    skipped_count: skippedTotal
  };

  // Ensure output directory exists
  const outDir = path.dirname(out);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  fs.writeFileSync(out, JSON.stringify(output, null, 2) + '\n');

  const parts = [`Extracted ${precedents.length} precedents`];
  if (skippedTotal > 0) {
    const reasons = [];
    if (skippedInconclusive > 0) reasons.push(`${skippedInconclusive} INCONCLUSIVE`);
    if (skippedStale > 0) reasons.push(`${skippedStale} stale`);
    if (skippedMalformed > 0) reasons.push(`${skippedMalformed} malformed`);
    parts.push(`(${skippedTotal} skipped: ${reasons.join(', ')})`);
  }
  process.stderr.write(parts.join(' ') + '\n');

  return output;
}

// ── Entry Point ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const debatesDir = args[0] || undefined;
  const outputPath = args[1] || undefined;
  main(debatesDir, outputPath).catch(err => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
  });
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = { extractPrecedentMetadata, isPrecedentFresh, main };

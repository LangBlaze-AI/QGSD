#!/usr/bin/env node
'use strict';

/**
 * assumption-register.cjs — Parses assumption-gaps.md into a structured JSON
 * register with validation status and linked L2 states.
 *
 * Requirements: SEM-03
 *
 * Usage:
 *   node bin/assumption-register.cjs            # print summary to stdout
 *   node bin/assumption-register.cjs --json     # print full register JSON to stdout
 */

const fs   = require('fs');
const path = require('path');

const ROOT = process.env.PROJECT_ROOT || path.join(__dirname, '..');
const FORMAL = path.join(ROOT, '.planning', 'formal');
const GAPS_PATH = path.join(FORMAL, 'assumption-gaps.md');
const OUT_DIR = path.join(FORMAL, 'semantics');
const OUT_FILE = path.join(OUT_DIR, 'assumption-register.json');

const JSON_FLAG = process.argv.includes('--json');

// ── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse a markdown table string into structured assumption entries.
 * @param {string} content - Raw markdown content containing a pipe-delimited table
 * @returns {Array} Parsed assumption entries
 */
function parseMarkdownTable(content) {
  if (typeof content !== 'string') return [];
  const lines = content.split('\n');
  const assumptions = [];
  let skipped = 0;

  for (const line of lines) {
    // Skip non-table lines, header rows, separator rows
    if (!line.startsWith('|')) continue;
    if (line.includes('---')) continue;

    const cells = line.split('|').map(c => c.trim());
    // Drop only the empty edges produced by the leading/trailing pipe,
    // not genuinely-empty interior cells (which would misalign columns).
    if (cells.length && cells[0] === '') cells.shift();
    if (cells.length && cells[cells.length - 1] === '') cells.pop();
    if (cells.length < 7) {
      // Check if this is the header row
      if (cells[0] === '#' || cells[0] === 'Metric') continue;
      skipped++;
      continue;
    }

    const numCell = cells[0];
    // Skip header row
    if (numCell === '#') continue;

    const id = parseInt(numCell, 10);
    if (isNaN(id)) {
      skipped++;
      continue;
    }

    assumptions.push({
      id,
      source: cells[1],
      name: cells[2],
      type: cells[3],
      coverage: cells[4],
      proposed_metric: cells[5].replace(/^`|`$/g, ''),
      metric_type: cells[6],
      validation_status: 'untested',
      linked_l2_states: []
    });
  }

  if (skipped > 0) {
    process.stderr.write(`Warning: skipped ${skipped} malformed table lines\n`);
  }

  return assumptions;
}

/**
 * Parse assumption-gaps.md file into structured entries.
 * @param {string} gapsPath - Path to the assumption-gaps.md file
 * @returns {Array} Parsed assumption entries
 */
function parseAssumptionGaps(gapsPath) {
  const content = fs.readFileSync(gapsPath, 'utf8');
  return parseMarkdownTable(content);
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(GAPS_PATH)) {
    console.error(`ERROR: assumption-gaps.md not found at ${GAPS_PATH}`);
    process.exit(1);
  }

  const assumptions = parseAssumptionGaps(GAPS_PATH);

  if (assumptions.length < 500) {
    console.error(`ERROR: Only parsed ${assumptions.length} assumptions, expected >= 500`);
    process.exit(1);
  }

  // Build summary
  const byType = {};
  const byCoverage = {};
  for (const a of assumptions) {
    byType[a.type] = (byType[a.type] || 0) + 1;
    byCoverage[a.coverage] = (byCoverage[a.coverage] || 0) + 1;
  }

  const register = {
    schema_version: '1',
    generated: new Date().toISOString(),
    assumptions,
    summary: {
      total_parsed: assumptions.length,
      by_type: byType,
      by_coverage: byCoverage,
      by_validation_status: {
        untested: assumptions.length,
        validated: 0,
        invalidated: 0
      }
    }
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(register, null, 2) + '\n');

  if (JSON_FLAG) {
    process.stdout.write(JSON.stringify(register, null, 2) + '\n');
  } else {
    console.log(`Assumption Register written to ${path.relative(ROOT, OUT_FILE)}`);
    console.log(`  Total parsed: ${assumptions.length}`);
    console.log(`  By type: ${Object.entries(byType).map(([k,v]) => `${k}=${v}`).join(' ')}`);
    console.log(`  By coverage: ${Object.entries(byCoverage).map(([k,v]) => `${k}=${v}`).join(' ')}`);
  }
}

// Export for testing
module.exports = { parseAssumptionGaps, parseMarkdownTable };

if (require.main === module) main();

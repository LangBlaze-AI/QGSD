#!/usr/bin/env node
'use strict';

/**
 * validate-memory.cjs
 *
 * Memory staleness checker for nForma auto-memory (MEMORY.md).
 *
 * Checks:
 *   1. Stale counts — numbers referencing requirements.json count vs actual
 *   2. Dead file references — file paths mentioned that don't exist on disk
 *   3. Temporal markers — entries with "as of", dates, version-specific milestones
 *   4. Contradiction with requirements — memory claims conflicting with current state
 *
 * Usage:
 *   node bin/validate-memory.cjs [--memory=path] [--cwd=path] [--quiet]
 *
 * Outputs findings to stderr (so they appear in Claude's context from hooks).
 * Exits 0 always (never blocks session start).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─────────────────────────────────────────────────────────────────────────────
// Find MEMORY.md
// ─────────────────────────────────────────────────────────────────────────────

function findMemoryPath(cwd) {
  if (typeof cwd !== 'string') return null;
  // Claude Code auto-memory path: ~/.claude/projects/<escaped-cwd>/memory/MEMORY.md
  const escaped = cwd.replace(/\//g, '-');
  const candidates = [
    path.join(os.homedir(), '.claude', 'projects', escaped, 'memory', 'MEMORY.md'),
    // Also try without leading dash
    path.join(os.homedir(), '.claude', 'projects', escaped.replace(/^-/, ''), 'memory', 'MEMORY.md'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 1: Stale counts
// ─────────────────────────────────────────────────────────────────────────────

function checkStaleCounts(memoryContent, cwd) {
  const findings = [];
  if (typeof memoryContent !== 'string') return findings;

  // Check requirements count references
  // Word-boundary \b prevents false positives like "R3.2 requires" matching "2 reqs"
  const reqCountMatch = memoryContent.match(/\b(\d+)\s+reqs?\b/i);
  if (reqCountMatch) {
    const claimedCount = parseInt(reqCountMatch[1], 10);
    const envelopePath = path.join(cwd, '.planning', 'formal', 'requirements.json');
    if (fs.existsSync(envelopePath)) {
      try {
        const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
        const actualCount = Array.isArray(envelope.requirements) ? envelope.requirements.length : 0;
        if (claimedCount !== actualCount) {
          findings.push({
            type: 'stale_count',
            message: `Requirements count: memory says "${claimedCount} reqs" but envelope has ${actualCount}`,
            fix: `Update "${claimedCount} reqs" → "${actualCount} reqs" in MEMORY.md`,
          });
        }
      } catch (_) {}
    }
  }

  // Check category group count references.
  // category-groups.json is a flat { rawCategory: groupName } map.
  // "N category groups" refers to unique target group names (values), not raw categories (keys).
  const catCountMatch = memoryContent.match(/(\d+)\s+category\s+groups?/i);
  if (catCountMatch) {
    const claimedCats = parseInt(catCountMatch[1], 10);
    const catPath = path.join(cwd, '.planning', 'formal', 'category-groups.json');
    if (fs.existsSync(catPath)) {
      try {
        const cats = JSON.parse(fs.readFileSync(catPath, 'utf8'));
        const mapping = cats.groups || cats;
        const uniqueGroups = new Set(
          Object.entries(mapping)
            .filter(([k]) => !k.startsWith('_'))
            .map(([, v]) => v)
        );
        const actualGroups = uniqueGroups.size;
        if (claimedCats !== actualGroups) {
          findings.push({
            type: 'stale_count',
            message: `Category groups: memory says "${claimedCats}" but file has ${actualGroups} unique groups`,
            fix: `Update "${claimedCats}" → "${actualGroups}" in MEMORY.md`,
          });
        }
      } catch (_) {}
    }
  }

  // Check category mapping references (e.g., "66→9")
  const mappingMatch = memoryContent.match(/(\d+)→(\d+)\s+category\s+mapping/i);
  if (mappingMatch) {
    const claimedFrom = parseInt(mappingMatch[1], 10);
    const claimedTo = parseInt(mappingMatch[2], 10);
    const catPath = path.join(cwd, '.planning', 'formal', 'category-groups.json');
    if (fs.existsSync(catPath)) {
      try {
        const cats = JSON.parse(fs.readFileSync(catPath, 'utf8'));
        const mapping = cats.groups || cats;
        const rawEntries = Object.keys(mapping).filter(k => !k.startsWith('_'));
        const uniqueGroups = new Set(rawEntries.map(k => mapping[k]));
        const actualFrom = rawEntries.length;
        const actualTo = uniqueGroups.size;
        if (actualFrom !== claimedFrom || actualTo !== claimedTo) {
          findings.push({
            type: 'stale_count',
            message: `Category mapping: memory says "${claimedFrom}→${claimedTo}" but actual is ${actualFrom}→${actualTo}`,
            fix: `Update mapping count in MEMORY.md`,
          });
        }
      } catch (_) {}
    }
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 2: Dead file references
// ─────────────────────────────────────────────────────────────────────────────

function checkDeadFileRefs(memoryContent, cwd) {
  const findings = [];

  // Match file paths in backticks: `path/to/file` or `path/to/file.ext`
  const pathPattern = /`([a-zA-Z0-9_./-]+\.[a-zA-Z]+)`/g;
  const dirPattern = /`([a-zA-Z0-9_./-]+\/)`/g;

  const seen = new Set();

  for (const pattern of [pathPattern, dirPattern]) {
    let match;
    while ((match = pattern.exec(memoryContent)) !== null) {
      const ref = match[1];
      if (seen.has(ref)) continue;
      seen.add(ref);

      // Skip URLs, patterns, and common non-path references
      if (ref.includes('://') || ref.includes('*') || ref.includes('{')) continue;
      // Skip package names like nforma@0.2.0
      if (ref.includes('@')) continue;
      // Skip references that start with ~ (home dir)
      if (ref.startsWith('~')) {
        const expanded = ref.replace('~', os.homedir());
        if (!fs.existsSync(expanded)) {
          findings.push({
            type: 'dead_ref',
            message: `File reference not found: \`${ref}\``,
            fix: `Remove or update the reference to \`${ref}\` in MEMORY.md`,
          });
        }
        continue;
      }

      // Check relative to cwd
      const fullPath = path.join(cwd, ref);
      if (!fs.existsSync(fullPath)) {
        findings.push({
          type: 'dead_ref',
          message: `File reference not found: \`${ref}\``,
          fix: `Remove or update the reference to \`${ref}\` in MEMORY.md`,
        });
      }
    }
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 3: Temporal markers
// ─────────────────────────────────────────────────────────────────────────────

function checkTemporalMarkers(memoryContent) {
  const findings = [];
  if (typeof memoryContent !== 'string') return findings;
  const lines = memoryContent.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // "as of YYYY-MM-DD" or "as of 2026-02-22"
    const asOfMatch = line.match(/as\s+of\s+(\d{4}-\d{2}-\d{2}|\w+\s+\d{4})/i);
    if (asOfMatch) {
      findings.push({
        type: 'temporal',
        message: `Line ${lineNum}: temporal marker "as of ${asOfMatch[1]}" — may be outdated`,
        fix: `Verify if the information on line ${lineNum} is still current`,
      });
    }

    // "until <date>" pattern
    const untilMatch = line.match(/until\s+(\w+\s+\d{1,2}\s+\d{4}|\d{4}-\d{2}-\d{2})/i);
    if (untilMatch) {
      findings.push({
        type: 'temporal',
        message: `Line ${lineNum}: expiry marker "until ${untilMatch[1]}" — may have passed`,
        fix: `Check if "until ${untilMatch[1]}" has passed and update accordingly`,
      });
    }

    // Specific version-milestone patterns that may be outdated
    const milestoneMatch = line.match(/Current\s+milestone:\s*(.+)/i);
    if (milestoneMatch) {
      findings.push({
        type: 'temporal',
        message: `Line ${lineNum}: milestone reference "${milestoneMatch[1].trim()}" — verify still current`,
        fix: `Check .planning/ROADMAP.md or PROJECT.md for actual current milestone`,
      });
    }
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 4: Contradiction with requirements
// ─────────────────────────────────────────────────────────────────────────────

function checkContradictions(memoryContent, cwd) {
  const findings = [];
  if (typeof memoryContent !== 'string') return findings;

  const envelopePath = path.join(cwd, '.planning', 'formal', 'requirements.json');
  if (!fs.existsSync(envelopePath)) return findings;

  let envelope;
  try {
    envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
  } catch (_) {
    return findings;
  }

  const requirements = Array.isArray(envelope.requirements) ? envelope.requirements : [];

  // Check if memory references CLAUDE.md but it doesn't exist
  if (memoryContent.includes('CLAUDE.md')) {
    const claudeMdPath = path.join(cwd, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      findings.push({
        type: 'contradiction',
        message: 'Memory references CLAUDE.md but file does not exist in repo',
        fix: 'Remove or update CLAUDE.md references in MEMORY.md',
      });
    }
  }

  // Check if memory mentions specific requirement IDs that no longer exist
  const idPattern = /\b([A-Z]+-\d+)\b/g;
  let match;
  const reqIds = new Set(requirements.map(r => r && r.id).filter(Boolean));
  const mentionedIds = new Set();

  while ((match = idPattern.exec(memoryContent)) !== null) {
    const id = match[1];
    // Only check IDs that look like requirement IDs (not arbitrary uppercase patterns)
    if (/^(ACT|AGENT|BREAKER|BLD|CL|CONF|DASH|DIAG|ENFC|HOOK|IMPR|MCP|OBS|QUICK|REN|RLS|SAFE|SCHEMA|SLOT|SPEC|STATE|STD|SYNC|VERIFY)-\d+$/.test(id)) {
      if (!reqIds.has(id) && !mentionedIds.has(id)) {
        mentionedIds.add(id);
        findings.push({
          type: 'contradiction',
          message: `Memory references requirement ${id} which is not in the current envelope`,
          fix: `Verify if ${id} was archived or renamed, and update MEMORY.md`,
        });
      }
    }
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function validateMemory(options = {}) {
  const { cwd = process.cwd(), memoryPath = null, quiet = false } = options;

  // Find memory file
  const resolvedMemoryPath = memoryPath || findMemoryPath(cwd);
  if (!resolvedMemoryPath || !fs.existsSync(resolvedMemoryPath)) {
    if (!quiet) process.stderr.write('[validate-memory] No MEMORY.md found — skipping\n');
    return { findings: [], memoryPath: null };
  }

  let content;
  try {
    content = fs.readFileSync(resolvedMemoryPath, 'utf8');
  } catch (_) {
    if (!quiet) process.stderr.write('[validate-memory] Could not read MEMORY.md — skipping\n');
    return { findings: [], memoryPath: null };
  }

  const allFindings = [
    ...checkStaleCounts(content, cwd),
    ...checkDeadFileRefs(content, cwd),
    ...checkTemporalMarkers(content),
    ...checkContradictions(content, cwd),
  ];

  return { findings: allFindings, memoryPath: resolvedMemoryPath };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entrypoint
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        args[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        args[arg.slice(2)] = true;
      }
    }
  }

  const cwd = args.cwd || process.cwd();
  const memoryPath = args.memory || null;
  const quiet = !!args.quiet;

  const { findings, memoryPath: resolvedPath } = validateMemory({ cwd, memoryPath, quiet });

  if (!resolvedPath) {
    process.exit(0);
  }

  if (findings.length === 0) {
    if (!quiet) console.log('Memory validation: all checks passed');
    process.exit(0);
  }

  // Group by type
  const grouped = {};
  for (const f of findings) {
    if (!grouped[f.type]) grouped[f.type] = [];
    grouped[f.type].push(f);
  }

  const typeLabels = {
    stale_count: 'Stale Counts',
    dead_ref: 'Dead File References',
    temporal: 'Temporal Markers',
    contradiction: 'Contradictions',
  };

  console.log(`\nMemory Validation — ${findings.length} finding(s):\n`);

  for (const [type, items] of Object.entries(grouped)) {
    console.log(`  ${typeLabels[type] || type} (${items.length}):`);
    for (const item of items) {
      console.log(`    - ${item.message}`);
      console.log(`      Fix: ${item.fix}`);
    }
    console.log('');
  }

  // Also write to stderr for hook integration
  if (!quiet) {
    const summary = findings.map(f => `[memory] ${f.message}`).join('\n');
    process.stderr.write(summary + '\n');
  }

  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  validateMemory,
  findMemoryPath,
  checkStaleCounts,
  checkDeadFileRefs,
  checkTemporalMarkers,
  checkContradictions,
};

if (require.main === module) {
  main();
}

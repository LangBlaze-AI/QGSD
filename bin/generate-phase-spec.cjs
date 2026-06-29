#!/usr/bin/env node
'use strict';
// bin/generate-phase-spec.cjs
// SPEC-04: Reads must_haves: truths: from *-PLAN.md YAML frontmatter and translates
// them into per-phase TLA+ scratch spec with INVARIANT/PROPERTY stubs.
//
// Data source: YAML frontmatter in *-PLAN.md files (NOT task-envelope.json — truths
// are empty in task-envelope.json at planning time; plan frontmatter is the correct source).
//
// Usage:
//   node bin/generate-phase-spec.cjs .planning/phases/v0.21-04-spec-completeness/
//   node bin/generate-phase-spec.cjs .planning/phases/v0.21-04-spec-completeness/v0.21-04-01-PLAN.md
//   node bin/generate-phase-spec.cjs <phase-dir-or-plan-file> --dry-run
//
// Output: .planning/formal/tla/scratch/<phase>-<timestamp>.tla

const fs   = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..');
const SCRATCH_DIR = path.join(ROOT, '.planning', 'formal', 'tla', 'scratch');

/**
 * Parse YAML frontmatter from a PLAN.md file.
 * Returns the frontmatter object (parsed manually — no yaml dependency).
 * Frontmatter is between the first two '---' lines.
 *
 * Extracts:
 *   - phase: string
 *   - truths: string[] from must_haves.truths
 */
function parsePlanFrontmatter(content) {
  if (typeof content !== 'string') return { truths: [] };
  const lines = content.split('\n');
  if (!lines[0] || lines[0].trim() !== '---') return { truths: [] };
  const endIdx = lines.slice(1).findIndex(l => l.trim() === '---');
  if (endIdx === -1) return { truths: [] };
  const fmLines = lines.slice(1, endIdx + 1);

  // Minimal YAML parser: extracts must_haves.truths array and phase field only.
  // Looks for 'must_haves:' block, then 'truths:' key, then collects '- "..."' or "- '...'" entries.
  const result = {};
  let inMustHaves = false;
  let inTruths = false;
  const truths = [];

  for (const line of fmLines) {
    // Detect phase field at top-level
    const phaseMatch = line.match(/^phase:\s*(.+)/);
    if (phaseMatch) {
      result.phase = phaseMatch[1].replace(/['"]/g, '').trim();
      continue;
    }

    if (/^must_haves:/.test(line)) {
      inMustHaves = true;
      inTruths = false;
      continue;
    }

    if (inMustHaves && /^\s{2}truths:/.test(line)) {
      inTruths = true;
      continue;
    }

    if (inMustHaves && inTruths) {
      // Match list items: "    - "text"" or "    - 'text'" or "    - text"
      const itemMatch = line.match(/^\s{4}-\s+"?'?(.+?)'?"?\s*$/);
      if (itemMatch) {
        // Clean up: strip surrounding quotes if present
        let truth = itemMatch[1].trim();
        // Remove leading/trailing quotes that may remain
        truth = truth.replace(/^["']|["']$/g, '');
        if (truth.length > 0) truths.push(truth);
        continue;
      }
      // Stop collecting truths when indentation drops below 4 spaces (non-list, non-empty)
      if (!/^\s{4}/.test(line) && line.trim() !== '') {
        inTruths = false;
      }
    }

    // Detect top-level key change inside must_haves (drops indentation)
    if (inMustHaves && !inTruths && !/^\s{2,}/.test(line) && line.trim() !== '') {
      inMustHaves = false;
    }
  }

  result.truths = truths;
  return result;
}

/**
 * Collect all *-PLAN.md files from a directory or single file path.
 * Returns sorted array of absolute paths.
 */
function collectPlanFiles(inputPath) {
  const resolved = path.resolve(inputPath);
  const stat = fs.statSync(resolved);
  if (stat.isFile()) return [resolved];
  // Directory: find *-PLAN.md files
  return fs.readdirSync(resolved)
    .filter(f => f.endsWith('-PLAN.md'))
    .sort()
    .map(f => path.join(resolved, f));
}

/**
 * Classify a truth string as safety (INVARIANT) or liveness (PROPERTY).
 *
 * Liveness keywords: eventually, deadline, async, progress, future, after, until, leads-to
 * Safety keywords: everything else (threshold, depth, count, max, min, never, always, etc.)
 *
 * @param {string} truth
 * @returns {'PROPERTY' | 'INVARIANT'}
 */
function classifyTruth(truth) {
  const lower = String(truth == null ? '' : truth).toLowerCase();
  const livenessKeywords = [
    'eventually',
    'deadline',
    'async',
    'progress',
    'future',
    'leads-to',
    'after',
    'until',
  ];
  const isLiveness = livenessKeywords.some(kw => lower.includes(kw));
  return isLiveness ? 'PROPERTY' : 'INVARIANT';
}

/**
 * Generate TLA+ module content from collected truths.
 *
 * @param {{ phase: string, truths: string[] }} options
 * @returns {{ moduleName: string, spec: string, truthCount: number }}
 */
function generatePhaseSpec({ phase, truths }) {
  const allTruths = (Array.isArray(truths) ? truths : []).filter(t => typeof t === 'string');

  // TLA+ module name: sanitize phase string (e.g. v0.21-04 → Phasev0_21_04Spec)
  const phaseStr = (typeof phase === 'string' && phase) ? phase : 'unknown';
  const moduleName = 'Phase' + phaseStr.replace(/[^a-zA-Z0-9]/g, '_') + 'Spec';
  const timestamp = new Date().toISOString();

  let spec = `---- MODULE ${moduleName} ----
(* Source: must_haves: truths: from *-PLAN.md YAML frontmatter *)
(* Generated by bin/generate-phase-spec.cjs — SPEC-04 *)
(* Phase: ${phase || 'unknown'} *)
(* Generated: ${timestamp} *)
(* Purpose: Verify proposed state machine changes before quorum approval *)
(* PLACEHOLDER properties — developer fills in formal logic before TLC run *)

EXTENDS Naturals, FiniteSets, TLC

VARIABLES state, counter

TypeOK == state \\in {"INIT", "RUNNING", "DONE"}

Init == state = "INIT" /\\ counter = 0

Next ==
    \\/ /\\ state = "INIT" /\\ state' = "RUNNING" /\\ counter' = counter + 1
    \\/ /\\ state = "RUNNING" /\\ state' = "DONE" /\\ counter' = counter
    \\/ /\\ state = "DONE" /\\ UNCHANGED <<state, counter>>

Spec == Init /\\ [][Next]_<<state, counter>>

\\* ── Requirements as Properties ──────────────────────────────────────────────

`;

  if (allTruths.length === 0) {
    spec += `\\* No must_haves: truths: found in *-PLAN.md frontmatter
\\* Add truths to see them translated to INVARIANT/PROPERTY stubs

`;
  }

  allTruths.forEach((truth, idx) => {
    const kind = classifyTruth(truth);
    const propName = `Req${String(idx + 1).padStart(2, '0')}`;
    // Escape backslashes and truncate label for TLA+ comment
    const label = truth.substring(0, 100).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    spec += `${kind} ${propName} ==
  \\* "${label}${truth.length > 100 ? '...' : ''}"
  TRUE  \\* PLACEHOLDER: replace TRUE with formal TLA+ expression

`;
  });

  spec += `====`;
  return { moduleName, spec, truthCount: allTruths.length };
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────
if (require.main === module) {
  const args    = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const flags   = process.argv.slice(2).filter(a => a.startsWith('--'));
  const isDryRun = flags.includes('--dry-run');

  if (args.length === 0) {
    process.stderr.write('[generate-phase-spec] Usage: node bin/generate-phase-spec.cjs <phase-dir-or-PLAN.md> [--dry-run]\n');
    process.stderr.write('[generate-phase-spec] Reads must_haves: truths: from *-PLAN.md YAML frontmatter (NOT task-envelope.json)\n');
    process.exit(1);
  }

  const inputPath = path.resolve(args[0]);
  if (!fs.existsSync(inputPath)) {
    process.stderr.write('[generate-phase-spec] Error: path not found: ' + inputPath + '\n');
    process.exit(1);
  }

  const planFiles = collectPlanFiles(inputPath);
  if (planFiles.length === 0) {
    process.stderr.write('[generate-phase-spec] Error: no *-PLAN.md files found in ' + inputPath + '\n');
    process.exit(1);
  }

  // Collect truths from all plan files
  let phase = 'unknown';
  const allTruths = [];
  for (const planFile of planFiles) {
    const content = fs.readFileSync(planFile, 'utf8');
    const fm = parsePlanFrontmatter(content);
    if (fm.phase) phase = fm.phase;
    if (fm.truths && fm.truths.length > 0) allTruths.push(...fm.truths);
  }

  const { moduleName, spec, truthCount } = generatePhaseSpec({ phase, truths: allTruths });
  const ts      = Date.now();
  const outName = phase.replace(/[^a-zA-Z0-9-]/g, '_') + '-' + ts + '.tla';
  const outPath = path.join(SCRATCH_DIR, outName);

  if (isDryRun) {
    process.stdout.write('[generate-phase-spec] DRY-RUN: would write ' + outPath + '\n');
    process.stdout.write('[generate-phase-spec] Plan files: ' + planFiles.join(', ') + '\n');
    process.stdout.write('[generate-phase-spec] Truths collected: ' + truthCount + '\n');
    process.stdout.write(spec + '\n');
  } else {
    fs.mkdirSync(SCRATCH_DIR, { recursive: true });
    fs.writeFileSync(outPath, spec, 'utf8');
    process.stdout.write(
      '[generate-phase-spec] Written: ' + outPath +
      ' (' + truthCount + ' truths from ' + planFiles.length + ' plan files → INVARIANT/PROPERTY stubs)\n'
    );
  }
}

module.exports = { generatePhaseSpec, classifyTruth, parsePlanFrontmatter };

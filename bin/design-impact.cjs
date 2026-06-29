#!/usr/bin/env node
'use strict';
// bin/design-impact.cjs
// Three-layer git diff impact analysis — traces changes through L1 (instrumentation),
// L2 (state transitions), and L3 (hazards) of the formal verification architecture.
//
// Usage:
//   node bin/design-impact.cjs                           # analyze HEAD~1..HEAD
//   node bin/design-impact.cjs --diff=HEAD~3..HEAD       # specific commit range
//   node bin/design-impact.cjs --stdin                   # read diff from stdin
//   node bin/design-impact.cjs --json                    # JSON output
//   node bin/design-impact.cjs --project-root=/path      # cross-repo usage
//
// Exit codes:
//   0 — success

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Resolve project root
// ---------------------------------------------------------------------------
const ROOT = (() => {
  const args = process.argv.slice(2);
  const rootArg = args.find(a => a.startsWith('--project-root='));
  if (rootArg) return rootArg.split('=').slice(1).join('=');
  if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;
  return path.resolve(__dirname, '..');
})();

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const ARGS = process.argv.slice(2);
const JSON_OUTPUT = ARGS.includes('--json');
const STDIN_MODE = ARGS.includes('--stdin');
const DIFF_ARG = ARGS.find(a => a.startsWith('--diff='));
const DIFF_REF = DIFF_ARG ? DIFF_ARG.split('=').slice(1).join('=') : 'HEAD~1..HEAD';

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff to extract changed file names.
 * Only looks at --- / +++ lines and 'diff --git' headers.
 * Returns deduplicated array of file paths (relative to repo root).
 */
function parseGitDiff(diffText) {
  const files = new Set();
  const lines = diffText.split('\n');
  for (const line of lines) {
    // Handle 'diff --git a/foo b/foo' header
    const gitMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (gitMatch) {
      files.add(gitMatch[2]);
      continue;
    }
    // Skip binary file markers
    if (line.startsWith('Binary files ')) continue;
    // Parse +++ b/path (new file path)
    if (line.startsWith('+++ b/')) {
      files.add(line.slice(6));
      continue;
    }
  }
  return [...files];
}

/**
 * Parse diff hunk headers to extract changed line ranges per file.
 * Returns Map<filePath, Array<{start, count}>> for the new-side (+) ranges.
 */
function parseDiffLineRanges(diffText) {
  const ranges = new Map();
  let currentFile = null;
  const lines = diffText.split('\n');
  for (const line of lines) {
    // Track current file from +++ header
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      if (!ranges.has(currentFile)) ranges.set(currentFile, []);
      continue;
    }
    if (line.startsWith('+++ ')) {
      // /dev/null or similar — skip
      currentFile = null;
      continue;
    }
    // Parse @@ hunk header
    if (currentFile && line.startsWith('@@')) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        const start = parseInt(match[1], 10);
        const count = match[2] !== undefined ? parseInt(match[2], 10) : 1;
        ranges.get(currentFile).push({ start, count });
      }
    }
  }
  return ranges;
}

/**
 * Check if a line number falls within any of the changed ranges for a file.
 */
function isLineInRanges(lineNum, ranges) {
  if (!ranges || ranges.length === 0) return false;
  for (const r of ranges) {
    if (lineNum >= r.start && lineNum < r.start + r.count) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Layer analysis
// ---------------------------------------------------------------------------

/**
 * L1: Instrumentation impact — find emission points in changed files.
 */
function analyzeL1(changedFiles, lineRanges, instrumentationMap) {
  const points = instrumentationMap.emission_points || [];
  const affected = [];
  for (const ep of points) {
    if (!ep || typeof ep !== 'object') continue;
    if (!changedFiles.includes(ep.file)) continue;
    const fileRanges = lineRanges.get(ep.file);
    const impactType = isLineInRanges(ep.line_number, fileRanges) ? 'direct' : 'file_level';
    affected.push({
      file: ep.file,
      line_number: ep.line_number,
      action: ep.action,
      xstate_event: ep.xstate_event,
      impact_type: impactType,
    });
  }
  return {
    affected_emission_points: affected.length,
    direct_hits: affected.filter(a => a.impact_type === 'direct').length,
    details: affected,
  };
}

/**
 * L2: State transition impact — find transitions for affected xstate events.
 */
function analyzeL2(l1Impact, observedFsm) {
  const affectedEvents = new Set();
  for (const ep of l1Impact.details) {
    if (ep.xstate_event) affectedEvents.add(ep.xstate_event);
  }
  const transitions = [];
  const observed = observedFsm.observed_transitions || {};
  for (const [state, events] of Object.entries(observed)) {
    if (!events || typeof events !== 'object') continue;
    for (const [event, info] of Object.entries(events)) {
      if (!info || typeof info !== 'object') continue;
      if (affectedEvents.has(event)) {
        transitions.push({
          state,
          event,
          to_state: info.to_state,
          count: info.count,
        });
      }
    }
  }
  return {
    affected_transitions: transitions.length,
    affected_events: [...affectedEvents],
    details: transitions,
  };
}

/**
 * L3: Hazard impact — find hazards and failure modes for affected state-event pairs.
 */
function analyzeL3(l2Impact, hazardModel, failureModeCatalog) {
  // Build set of affected (state, event) pairs from L2
  const affectedPairs = new Set();
  for (const t of l2Impact.details) {
    affectedPairs.add(`${t.state}|${t.event}`);
  }

  const hazards = (hazardModel.hazards || []).filter(h =>
    affectedPairs.has(`${h.state}|${h.event}`)
  );

  const failureModes = (failureModeCatalog.failure_modes || []).filter(fm =>
    affectedPairs.has(`${fm.state}|${fm.event}`)
  );

  const maxRpn = hazards.length > 0
    ? Math.max(0, ...hazards.map(h => (typeof h.rpn === 'number' && Number.isFinite(h.rpn) ? h.rpn : 0)))
    : 0;

  return {
    affected_hazards: hazards.length,
    max_rpn: maxRpn,
    affected_failure_modes: failureModes.length,
    details: hazards.map(h => ({
      hazard_id: h.id,
      state: h.state,
      event: h.event,
      rpn: h.rpn,
      severity: h.severity,
    })),
    failure_mode_details: failureModes.map(fm => ({
      id: fm.id,
      state: fm.state,
      event: fm.event,
      failure_mode: fm.failure_mode,
      severity_class: fm.severity_class,
    })),
  };
}

// ---------------------------------------------------------------------------
// Main analysis entry point
// ---------------------------------------------------------------------------

/**
 * Run complete three-layer impact analysis.
 * @param {Object} opts
 * @param {string[]} opts.changedFiles - list of changed file paths
 * @param {Map<string, Array<{start:number, count:number}>>} opts.lineRanges - per-file line ranges
 * @param {Object} opts.instrumentationMap - parsed instrumentation-map.json
 * @param {Object} opts.observedFsm - parsed observed-fsm.json
 * @param {Object} opts.hazardModel - parsed hazard-model.json
 * @param {Object} opts.failureModeCatalog - parsed failure-mode-catalog.json
 */
function analyzeImpact(opts) {
  const { changedFiles, lineRanges, instrumentationMap, observedFsm, hazardModel, failureModeCatalog } = opts;

  const l1 = analyzeL1(changedFiles, lineRanges, instrumentationMap);
  const l2 = l1.affected_emission_points > 0
    ? analyzeL2(l1, observedFsm)
    : { affected_transitions: 0, affected_events: [], details: [] };
  const l3 = l2.affected_transitions > 0
    ? analyzeL3(l2, hazardModel, failureModeCatalog)
    : { affected_hazards: 0, max_rpn: 0, affected_failure_modes: 0, details: [], failure_mode_details: [] };

  let summary;
  if (l1.affected_emission_points === 0) {
    summary = 'No instrumented files affected by this change';
  } else {
    summary = `${l1.affected_emission_points} emission point(s) affected (${l1.direct_hits} direct), ` +
      `${l2.affected_transitions} state transition(s), ` +
      `${l3.affected_hazards} hazard(s) (max RPN: ${l3.max_rpn})`;
  }

  return {
    schema_version: '1',
    generated: new Date().toISOString(),
    changed_files: changedFiles.length,
    l1_impact: l1,
    l2_impact: l2,
    l3_impact: l3,
    summary,
  };
}

// ---------------------------------------------------------------------------
// File loaders
// ---------------------------------------------------------------------------

function loadJSON(relPath) {
  const fullPath = path.join(ROOT, relPath);
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------------

function printReport(report) {
  console.log('=== Design Impact Report ===\n');
  console.log(`Changed files: ${report.changed_files}`);
  console.log(`Summary: ${report.summary}\n`);

  if (report.l1_impact.affected_emission_points === 0) {
    console.log('No instrumented files affected — L2/L3 analysis skipped.\n');
    return;
  }

  // L1
  console.log('--- L1: Instrumentation Impact ---');
  console.log(`  Affected emission points: ${report.l1_impact.affected_emission_points} (${report.l1_impact.direct_hits} direct)`);
  for (const ep of report.l1_impact.details) {
    console.log(`  [${ep.impact_type}] ${ep.file}:${ep.line_number} — ${ep.action} (${ep.xstate_event || 'no event'})`);
  }
  console.log('');

  // L2
  console.log('--- L2: State Transition Impact ---');
  console.log(`  Affected transitions: ${report.l2_impact.affected_transitions}`);
  console.log(`  Affected events: ${report.l2_impact.affected_events.join(', ')}`);
  for (const t of report.l2_impact.details) {
    console.log(`  ${t.state} --[${t.event}]--> ${t.to_state} (${t.count} observed)`);
  }
  console.log('');

  // L3
  console.log('--- L3: Hazard Impact ---');
  console.log(`  Affected hazards: ${report.l3_impact.affected_hazards} (max RPN: ${report.l3_impact.max_rpn})`);
  console.log(`  Affected failure modes: ${report.l3_impact.affected_failure_modes}`);
  for (const h of report.l3_impact.details) {
    console.log(`  ${h.hazard_id}: ${h.state} --[${h.event}]--> RPN=${h.rpn} severity=${h.severity}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// CLI main
// ---------------------------------------------------------------------------

async function main() {
  let diffText;

  if (STDIN_MODE) {
    // Read diff from stdin
    diffText = fs.readFileSync(0, 'utf8');
  } else {
    // Run git diff
    const [ref1, ref2] = DIFF_REF.includes('..')
      ? DIFF_REF.split('..')
      : [DIFF_REF + '~1', DIFF_REF];

    const diffResult = spawnSync('git', ['diff', '--unified=0', ref1, ref2], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });

    if (diffResult.error) {
      console.error(`Error running git diff: ${diffResult.error.message}`);
      process.exit(1);
    }

    diffText = diffResult.stdout || '';
  }

  const changedFiles = parseGitDiff(diffText);
  const lineRanges = parseDiffLineRanges(diffText);

  // Load formal verification artifacts
  const instrumentationMap = loadJSON('.planning/formal/evidence/instrumentation-map.json') || { emission_points: [] };
  const observedFsm = loadJSON('.planning/formal/semantics/observed-fsm.json') || { observed_transitions: {} };
  const hazardModel = loadJSON('.planning/formal/reasoning/hazard-model.json') || { hazards: [] };
  const failureModeCatalog = loadJSON('.planning/formal/reasoning/failure-mode-catalog.json') || { failure_modes: [] };

  const report = analyzeImpact({
    changedFiles,
    lineRanges,
    instrumentationMap,
    observedFsm,
    hazardModel,
    failureModeCatalog,
  });

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
}

// Export for testing
module.exports = { analyzeImpact, parseGitDiff, parseDiffLineRanges, analyzeL1, analyzeL2, analyzeL3, isLineInRanges };

// Run CLI if invoked directly
if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

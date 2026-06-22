#!/usr/bin/env node
'use strict';
// bin/detect-coverage-gaps.cjs
// TLC state-space vs conformance trace coverage gap detector.
// Requirements: SIG-01
//
// Usage:
//   node bin/detect-coverage-gaps.cjs [--spec=NFQuorum] [--log=path]
//
// Output:
//   .planning/formal/coverage-gaps.md — structured test backlog when gaps exist
//
// Computes: TLC-reachable states minus trace-observed states = coverage gaps.

const fs   = require('fs');
const path = require('path');

// ── State mapping definitions ────────────────────────────────────────────────
// Maps each TLA+ spec to its state variable name and value-to-name mapping.
// Source of truth: state comments in the TLA+ spec files.
const STATE_MAPS = {
  'NFQuorum': {
    variable: 's',
    values: { '0': 'COLLECTING_VOTES', '1': 'DECIDED', '2': 'DELIBERATING' },
  },
  'NFStopHook': {
    variable: 'phase',
    values: { '0': 'IDLE', '1': 'READING', '2': 'DECIDING', '3': 'BLOCKED' },
  },
  'NFCircuitBreaker': {
    variable: 'state',
    values: { '0': 'MONITORING', '1': 'TRIGGERED', '2': 'RECOVERING' },
  },
};

// ── Action-to-state reverse mapping ──────────────────────────────────────────
// Maps conformance event action names to state names for trace parsing.
const ACTION_TO_STATE = {
  'quorum_start':       'COLLECTING_VOTES',
  'quorum_complete':    'DECIDED',
  'quorum_block':       'DECIDED',
  'deliberation_round': 'DELIBERATING',
  'stop_hook_read':     'READING',
  'stop_hook_decide':   'DECIDING',
  'stop_hook_block':    'BLOCKED',
  'stop_hook_idle':     'IDLE',
  'breaker_trigger':    'TRIGGERED',
  'breaker_recover':    'RECOVERING',
  'breaker_monitor':    'MONITORING',
};

/**
 * parseTlcStates(specName) — returns the full set of named states for a spec.
 * @param {string} specName - TLA+ spec name (e.g. 'NFQuorum')
 * @returns {{ specName: string, states: Set<string>, variable: string } | null}
 */
function parseTlcStates(specName) {
  const map = STATE_MAPS[specName];
  if (!map) return null;
  return {
    specName,
    states: new Set(Object.values(map.values)),
    variable: map.variable,
  };
}

/**
 * parseTraceStates(logPath) — extracts observed states from conformance JSONL.
 * @param {string} logPath - path to conformance-events.jsonl
 * @returns {Set<string> | null} - set of observed state names, or null if file missing
 */
function parseTraceStates(logPath) {
  const pp = require('./planning-paths.cjs');
  const p = logPath || pp.resolveWithFallback(process.cwd(), 'conformance-events');
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    const observed = new Set();
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        // Try state field first
        if (event.state && typeof event.state === 'string') {
          observed.add(event.state);
        }
        // Map action to state
        if (event.action && ACTION_TO_STATE[event.action]) {
          observed.add(ACTION_TO_STATE[event.action]);
        }
      } catch (_) { /* skip malformed lines */ }
    }
    return observed;
  } catch (_) {
    return null;
  }
}

/**
 * detectCoverageGaps(options) — computes TLC reachable minus trace observed.
 * @param {{ specName?: string, logPath?: string, outputPath?: string }} options
 * @returns {{ status: string, gaps?: string[], outputPath?: string, reason?: string }}
 */
function detectCoverageGaps(options = {}) {
  const specName   = options.specName || 'NFQuorum';
  const pp2 = require('./planning-paths.cjs');
  const logPath    = options.logPath || pp2.resolveWithFallback(process.cwd(), 'conformance-events');
  const outputPath = options.outputPath || path.join(process.cwd(), '.planning', 'formal', 'coverage-gaps.md');

  const tlcResult = parseTlcStates(specName);
  if (!tlcResult) {
    return { status: 'unknown-spec', reason: 'Spec ' + specName + ' not found in STATE_MAPS' };
  }

  const traceStates = parseTraceStates(logPath);
  if (traceStates === null) {
    return { status: 'no-traces', reason: 'conformance log not found' };
  }

  // Compute gap = reachable - observed
  const gaps = [];
  for (const state of tlcResult.states) {
    if (!traceStates.has(state)) {
      gaps.push(state);
    }
  }

  if (gaps.length === 0) {
    return { status: 'full-coverage', gaps: [] };
  }

  // Write coverage-gaps.md
  const reachable = tlcResult.states.size;
  const observed  = reachable - gaps.length;
  const pct       = ((observed / reachable) * 100).toFixed(0);
  const timestamp = new Date().toISOString();

  // Build variable value lookup
  const specMap = STATE_MAPS[specName];
  const stateToValue = {};
  for (const [val, name] of Object.entries(specMap.values)) {
    stateToValue[name] = specMap.variable + '=' + val;
  }

  const md = [
    '# TLC Coverage Gaps',
    '',
    'Generated: ' + timestamp,
    'Spec: ' + specName,
    '',
    '## Unreached States',
    '',
    '| State | Variable Value | Description |',
    '|-------|---------------|-------------|',
  ];

  for (const gap of gaps.sort()) {
    const varVal = stateToValue[gap] || 'unknown';
    md.push('| ' + gap + ' | ' + varVal + ' | State reachable by TLC but never observed in conformance traces |');
  }

  md.push('');
  md.push('## Coverage Summary');
  md.push('');
  md.push('- TLC reachable: ' + reachable + ' states');
  md.push('- Trace observed: ' + observed + ' states');
  md.push('- Gaps: ' + gaps.length + ' states (' + pct + '% coverage)');
  md.push('');
  md.push('## Action Items');
  md.push('');
  md.push('Each gap represents a state that formal verification proves is reachable but production has never exercised.');
  md.push('Add test cases that drive the system into these states.');
  md.push('');

  // Ensure output directory exists
  const outDir = path.dirname(outputPath);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outputPath, md.join('\n'));

  return { status: 'gaps-found', gaps, outputPath };
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log([
      'Usage: detect-coverage-gaps.cjs [--spec=NAME] [--log=PATH] [--help]',
      '  Analyze formal-model requirement coverage.',
      '  Writes .planning/formal/coverage-gaps.md and candidates.json.',
    ].join('\n'));
    process.exit(0);
  }
  const specArg = args.find(a => a.startsWith('--spec='));
  const logArg  = args.find(a => a.startsWith('--log='));

  const specName = specArg ? specArg.split('=')[1] : 'NFQuorum';
  const logPath  = logArg ? logArg.split('=')[1] : undefined;

  const result = detectCoverageGaps({ specName, logPath });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  if (result.status === 'gaps-found') {
    process.stderr.write('[detect-coverage-gaps] ' + result.gaps.length + ' gap(s) found. See: ' + result.outputPath + '\n');
  } else if (result.status === 'no-traces') {
    process.stderr.write('[detect-coverage-gaps] No conformance log found — nothing to compare.\n');
  } else if (result.status === 'full-coverage') {
    process.stderr.write('[detect-coverage-gaps] Full coverage — all TLC-reachable states observed in traces.\n');
  }
}

module.exports = { detectCoverageGaps, parseTlcStates, parseTraceStates };

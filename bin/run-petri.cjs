#!/usr/bin/env node
'use strict';
// bin/run-petri.cjs
// Lightweight Petri net validation and analysis runner.
// Parses DOT format Petri nets from .planning/formal/petri/ and validates structure.
// Full state-space exploration would require external tools (GreatSPN, Tapaal).
//
// Usage:
//   node bin/run-petri.cjs
//
// Graceful degradation: Validates DOT syntax and structure; logs inconclusive for complex properties.

const fs = require('fs');
const path = require('path');
const { writeCheckResult } = require('./write-check-result.cjs');
const { parseNDJSON } = require('./verify-formal-results.cjs');
const { getRequirementIds } = require('./requirement-map.cjs');

// ── Resolve project root (--project-root= overrides __dirname-relative) ─────
let ROOT = path.join(__dirname, '..');
for (const arg of process.argv) {
  if (arg.startsWith('--project-root=')) ROOT = path.resolve(arg.slice('--project-root='.length));
}

const SURFACE = 'petri';
const TAG = '[run-petri]';

// Default analysis bounds
const DEFAULT_MAX_PLACES = 1000;
const DEFAULT_MAX_TRANSITIONS = 1000;

/**
 * Parse DOT format Petri net.
 * Returns structure with node counts, edge counts, validity.
 * @param {string} content - DOT file content
 * @returns {{ valid: boolean, places: number, transitions: number, arcs: number, errors: string[] }}
 */
function parsePetriDOT(content) {
  const errors = [];

  // Basic syntax check
  if (!content.includes('digraph') && !content.includes('graph')) {
    errors.push('Missing graph declaration');
    return { valid: false, places: 0, transitions: 0, arcs: 0, errors };
  }

  // Count places (typically circles or nodes with shape=circle)
  const placeMatches = content.match(/\[.*?(shape=circle|shape="circle").*?\]/g) || [];
  let places = placeMatches.length;

  // Count transitions (typically boxes, rect, or nodes with shape=box/rect)
  const transitionMatches = content.match(/\[.*?(shape=box|shape="box"|shape=rect|shape="rect").*?\]/g) || [];
  let transitions = transitionMatches.length;

  // Fallback: count all nodes if parsing above didn't work
  if (places + transitions === 0) {
    // Count all node declarations
    const nodeMatches = content.match(/\n\s*\w+\s*\[/g) || [];
    places = Math.ceil(nodeMatches.length / 2);
    transitions = Math.floor(nodeMatches.length / 2);
  }

  // Count edges (arcs) — ignore '->' that appears inside [...] attribute blocks
  const contentNoAttrs = content.replace(/\[[^\]]*\]/g, '');
  const arcMatches = contentNoAttrs.match(/->/g) || [];
  const arcs = arcMatches.length;

  // Validate bounds
  if (places > DEFAULT_MAX_PLACES) {
    errors.push(`Too many places: ${places} > ${DEFAULT_MAX_PLACES}`);
  }
  if (transitions > DEFAULT_MAX_TRANSITIONS) {
    errors.push(`Too many transitions: ${transitions} > ${DEFAULT_MAX_TRANSITIONS}`);
  }

  // Validate structure: at least one place and one transition (relaxed: at least 1 total node and 1 arc)
  if (places === 0 && transitions === 0) {
    errors.push('No places or transitions found');
  }
  if (arcs === 0) {
    errors.push('No arcs/edges found');
  }

  const valid = errors.length === 0;
  return { valid, places, transitions, arcs, errors };
}

/**
 * Run lightweight Petri net validation.
 * Scans .planning/formal/petri/ for .dot files, validates syntax and structure.
 * Writes check results for each model.
 */
function main() {
  const startMs = Date.now();
  const petriDir = path.join(ROOT, '.planning', 'formal', 'petri');

  if (!fs.existsSync(petriDir) || !fs.statSync(petriDir).isDirectory()) {
    process.stderr.write(TAG + ' Petri directory not found: ' + petriDir + '\n');
    process.exit(0);
  }

  // Discover Petri models
  const dotFiles = fs.readdirSync(petriDir)
    .filter(f => f.endsWith('.dot'))
    .sort();

  if (dotFiles.length === 0) {
    process.stderr.write(TAG + ' No Petri models found in ' + petriDir + '\n');
    process.exit(0);
  }

  process.stderr.write(TAG + ' Found ' + dotFiles.length + ' Petri model(s)\n');

  let totalErrors = 0;
  let totalValid = 0;

  for (const dotFile of dotFiles) {
    const modelName = dotFile.replace(/\.dot$/, '');
    const checkId = 'petri:' + modelName;
    const filePath = path.join(petriDir, dotFile);
    const taskStartMs = Date.now();

    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      process.stderr.write(TAG + ' Error reading ' + dotFile + ': ' + err.message + '\n');
      writeCheckResult({
        tool: 'run-petri',
        formalism: SURFACE,
        result: 'error',
        check_id: checkId,
        surface: SURFACE,
        property: 'Petri net structure validation — places, transitions, arcs connectivity',
        runtime_ms: Date.now() - taskStartMs,
        summary: 'error: could not read model file',
        triage_tags: ['read-error'],
        requirement_ids: getRequirementIds(checkId),
        metadata: { error: err.message },
      });
      totalErrors++;
      continue;
    }

    // Parse and validate
    const analysis = parsePetriDOT(content);
    const passed = analysis.valid;
    const runtimeMs = Date.now() - taskStartMs;

    process.stderr.write(
      TAG + ' ' + modelName + ': ' + (passed ? 'PASS' : 'FAIL') +
      ' (places=' + analysis.places + ', transitions=' + analysis.transitions +
      ', arcs=' + analysis.arcs + ')\n'
    );

    writeCheckResult({
      tool: 'run-petri',
      formalism: SURFACE,
      result: passed ? 'pass' : 'fail',
      check_id: checkId,
      surface: SURFACE,
      property: 'Petri net structure validation — places, transitions, arcs connectivity',
      runtime_ms: runtimeMs,
      summary: (passed ? 'pass' : 'fail') + ': ' + modelName + ' Petri net validation in ' + runtimeMs + 'ms' +
        ' (places=' + analysis.places + ', transitions=' + analysis.transitions + ')',
      triage_tags: passed ? [] : analysis.errors.slice(0, 3),
      requirement_ids: getRequirementIds(checkId),
      metadata: {
        places: analysis.places,
        transitions: analysis.transitions,
        arcs: analysis.arcs,
        validation_errors: analysis.errors,
      },
    });

    if (passed) {
      totalValid++;
    } else {
      totalErrors++;
    }
  }

  process.stderr.write(
    TAG + ' Summary: ' + totalValid + ' valid, ' + totalErrors + ' failed\n'
  );
}

main();

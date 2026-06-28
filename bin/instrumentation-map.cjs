#!/usr/bin/env node
'use strict';
// bin/instrumentation-map.cjs
// Scans hooks for conformance event emission points and maps to state variables.
// Validates discovered actions against event-vocabulary.json.
//
// Requirement: EVID-01

const fs   = require('fs');
const path = require('path');

const ROOT = process.env.PROJECT_ROOT || path.join(__dirname, '..');
const EVIDENCE_DIR = path.join(ROOT, '.planning', 'formal', 'evidence');
const VOCAB_PATH = path.join(EVIDENCE_DIR, 'event-vocabulary.json');
const OUTPUT_PATH = path.join(EVIDENCE_DIR, 'instrumentation-map.json');

const JSON_FLAG = process.argv.includes('--json');

// ── Hook scanning ───────────────────────────────────────────────────────────

const HOOK_FILES = [
  'hooks/nf-prompt.js',
  'hooks/nf-stop.js',
  'hooks/nf-circuit-breaker.js',
];

// Also scan observe handlers
const OBSERVE_GLOB = 'bin/observe-handler-';

/**
 * Scan a file for conformance event emission points.
 * Looks for appendFileSync calls near conformance-events and extracts action types.
 */
function scanFile(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return [];
  const absPath = path.join(ROOT, filePath);
  let lines;
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return [];
    lines = fs.readFileSync(absPath, 'utf8').split('\n');
  } catch {
    return [];
  }
  const emissionPoints = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Look for action: 'something' patterns (conformance event construction)
    const actionMatch = line.match(/action:\s+['"]([^'"]+)['"]/);
    if (actionMatch) {
      const action = actionMatch[1];

      // Look for state variable context in nearby lines (within 10 lines)
      const contextLines = lines.slice(Math.max(0, i - 10), Math.min(lines.length, i + 10)).join('\n');
      const stateVars = [];

      // Extract state-related variables
      if (/from_state|fromState|from:/i.test(contextLines)) stateVars.push('from_state');
      if (/to_state|toState|to:/i.test(contextLines)) stateVars.push('to_state');
      if (/verdict|decision/i.test(contextLines)) stateVars.push('verdict');
      if (/fanOut|fan_out|quorumSize/i.test(contextLines)) stateVars.push('quorum_size');
      if (/oscillation|breaker/i.test(contextLines)) stateVars.push('breaker_state');

      emissionPoints.push({
        file: filePath,
        line_number: i + 1,
        action,
        state_variables: stateVars,
        vocabulary_match: null, // filled later
        xstate_event: null,    // filled later
      });
    }

    // Also detect type: 'quorum_fallback_*' patterns
    const typeMatch = line.match(/type:\s+['"]([^'"]+)['"]/);
    if (typeMatch && /conformance|quorum_fallback/.test(typeMatch[1])) {
      emissionPoints.push({
        file: filePath,
        line_number: i + 1,
        action: typeMatch[1],
        state_variables: [],
        vocabulary_match: null,
        xstate_event: null,
      });
    }
  }

  return emissionPoints;
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  // Ensure output directory
  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  }

  // Load vocabulary
  const vocab = JSON.parse(fs.readFileSync(VOCAB_PATH, 'utf8'));
  const vocabActions = vocab.vocabulary;
  const vocabKeys = Object.keys(vocabActions).filter(k => k !== 'undefined');

  // Scan hook files
  let allEmissions = [];
  for (const hookFile of HOOK_FILES) {
    const points = scanFile(hookFile);
    allEmissions.push(...points);
  }

  // Scan observe handlers
  const binDir = path.join(ROOT, 'bin');
  if (fs.existsSync(binDir)) {
    const entries = fs.readdirSync(binDir);
    for (const entry of entries) {
      if (entry.startsWith('observe-handler-') && entry.endsWith('.cjs') && !entry.includes('.test.')) {
        const points = scanFile(path.join('bin', entry));
        allEmissions.push(...points);
      }
    }
  }

  // Validate against vocabulary and fill in xstate_event
  const mappedActions = new Set();
  for (const ep of allEmissions) {
    if (ep.action in vocabActions) {
      ep.vocabulary_match = true;
      const vocabEntry = vocabActions[ep.action];
      ep.xstate_event = vocabEntry.xstate_event; // may be null (e.g., mcp_call)
      if (ep.xstate_event === null) {
        ep.no_xstate_mapping = true;
      }
      mappedActions.add(ep.action);
    } else {
      ep.vocabulary_match = false;
    }
  }

  // Coverage calculation: mapped vocabulary actions / total vocabulary actions (excluding "undefined")
  const coveragePct = vocabKeys.length > 0
    ? Math.round((mappedActions.size / vocabKeys.length) * 1000) / 10
    : 0;

  const unmappedActions = vocabKeys.filter(k => !mappedActions.has(k));

  // Build output
  const result = {
    schema_version: '1',
    generated: new Date().toISOString(),
    emission_points: allEmissions,
    coverage: {
      total_vocabulary_actions: vocabKeys.length,
      mapped_actions: mappedActions.size,
      coverage_pct: coveragePct,
    },
    unmapped_actions: unmappedActions,
    summary: `Found ${allEmissions.length} emission points across ${HOOK_FILES.length} hooks and observe handlers. ` +
             `Coverage: ${mappedActions.size}/${vocabKeys.length} vocabulary actions mapped (${coveragePct}%). ` +
             `Unmapped: ${unmappedActions.join(', ') || 'none'}.`,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2) + '\n', 'utf8');

  if (JSON_FLAG) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Instrumentation Map Generated`);
    console.log(`  Emission points: ${allEmissions.length}`);
    console.log(`  Coverage: ${mappedActions.size}/${vocabKeys.length} (${coveragePct}%)`);
    if (unmappedActions.length > 0) {
      console.log(`  Unmapped: ${unmappedActions.join(', ')}`);
    }
  }
}

// Export for testing
module.exports = { scanFile, HOOK_FILES };

// Run if invoked directly
if (require.main === module) {
  main();
}

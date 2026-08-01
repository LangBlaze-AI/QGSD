'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { validateHookInput } = require('./config-loader');
const resolveBin = require('./nf-resolve-bin');

// Hard timeout: never block session exit longer than 5 seconds
const HARD_TIMEOUT = setTimeout(() => process.exit(0), 5000);
HARD_TIMEOUT.unref(); // do not keep process alive

// Belt-and-suspenders: catch any uncaught exception that escapes the try/catch
// (e.g., errors in require() at top level). Session-end hooks must NEVER exit non-zero.
process.on('uncaughtException', (err) => {
  process.stderr.write('[nf-session-end] Uncaught exception (non-fatal): ' + err.message + '\n');
  process.exit(0);
});

/**
 * Locate learning-extractor.cjs — try installed global path first, then local dev path.
 */
function findLearningExtractor() {
  try { return require(resolveBin('learning-extractor.cjs')); } catch (_) { return null; }
}

/**
 * Locate memory-store.cjs via resolveBin (nf-bin installed path, then repo bin/).
 */
function findMemoryStore() {
  try { return require(resolveBin('memory-store.cjs')); } catch (_) { return null; }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const _eventType = input.hook_event_name || input.hookEventName || 'SessionEnd';
    const _validation = validateHookInput(_eventType, input);
    if (!_validation.valid) {
      process.stderr.write('[nf] WARNING: nf-session-end: invalid input: ' + JSON.stringify(_validation.errors) + '\n');
      process.exit(0); // Fail-open
    }
    const cwd = input.cwd || process.cwd();
    const transcriptPath = input.transcript_path;

    // Profile guard
    const { loadConfig, shouldRunHook } = require('./config-loader');
    const config = loadConfig(cwd);
    const profile = config.hook_profile || 'standard';
    if (!shouldRunHook('nf-session-end', profile)) {
      process.exit(0);
    }

    // Feature flag guard
    if (config.learning_enabled === false) {
      process.exit(0);
    }

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      process.exit(0); // No transcript available
    }

    // Load extractor module
    const extractor = findLearningExtractor();
    if (!extractor) {
      process.exit(0);
    }

    // Load memory store module
    const memStore = findMemoryStore();
    if (!memStore) {
      process.exit(0);
    }

    // Read last N lines of transcript (avoid loading entire file)
    const lines = extractor.readLastLines(transcriptPath, 500);

    // LRNG-01: Extract error patterns
    const errorPatterns = extractor.extractErrorPatterns(lines);

    // LRNG-02: Extract user corrections (last 200 lines)
    const corrections = extractor.extractCorrections(lines.slice(-200));

    let errorCount = 0;
    let correctionCount = 0;

    // Persist error patterns via memory-store (dedup before appending)
    for (const ep of errorPatterns) {
      if (!memStore.isDuplicate(cwd, 'errors', 'symptom', ep.symptom)) {
        memStore.appendEntry(cwd, 'errors', ep);
        errorCount++;
      }
    }

    // Persist corrections via memory-store (dedup before appending)
    for (const cor of corrections) {
      if (!memStore.isDuplicate(cwd, 'corrections', 'wrong_approach', cor.wrong_approach)) {
        memStore.appendEntry(cwd, 'corrections', cor);
        correctionCount++;
      }
    }

    process.stderr.write('[nf-session-end] Extracted ' + errorCount + ' error patterns, ' + correctionCount + ' corrections\n');

    // LRNG-03: Skill extraction via skill-extractor.cjs (uses existing memStore instance)
    try {
      const skillExtractor = findSkillExtractor();
      if (skillExtractor && memStore) {
        const entries = skillExtractor.readRecentEntries(memStore, cwd);
        if (entries && entries.length > 0) {
          const clusters = skillExtractor.clusterByTags(entries);
          const candidates = skillExtractor.generateCandidates(clusters);
          let candidateCount = 0;
          for (const candidate of candidates) {
            if (!memStore.isDuplicate(cwd, 'skills', 'skill', candidate.skill)) {
              memStore.appendEntry(cwd, 'skills', { type: 'skill_candidate', ...candidate, status: 'pending_validation' });
              candidateCount++;
            }
          }
          process.stderr.write('[nf-session-end] Generated ' + candidateCount + ' skill candidates\n');
        }
      }
    } catch (skillErr) {
      // Fail-open: skill extraction failure must not block session end
      process.stderr.write('[nf-session-end] Skill extraction error (non-fatal): ' + skillErr.message + '\n');
    }
  } catch (e) {
    if (e instanceof SyntaxError) {
      process.stderr.write('[nf] WARNING: nf-session-end: malformed JSON on stdin: ' + e.message + '\n');
    } else {
      process.stderr.write('[nf-session-end] Error: ' + e.message + '\n');
    }
  }
  process.exit(0); // Always exit cleanly
});

/**
 * Locate skill-extractor.cjs — try installed global path first, then local dev path.
 */
function findSkillExtractor() {
  try { return require(resolveBin('skill-extractor.cjs')); } catch (_) { return null; }
}

// Export for unit testing
module.exports = { findLearningExtractor, findMemoryStore, findSkillExtractor };

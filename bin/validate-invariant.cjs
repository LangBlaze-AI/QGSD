#!/usr/bin/env node
'use strict';

/**
 * validate-invariant.cjs
 *
 * Two-layer invariant gate for requirements:
 *   Layer 1: Fast regex pass — rejects obvious non-invariants (<1ms)
 *   Layer 2: Heuristic borderline detection — flags cases for Haiku sub-agent review
 *
 * The script itself does NOT call Haiku. It outputs BORDERLINE verdicts for cases
 * that need classification. The calling workflow (add-requirement.md, map-requirements.md)
 * spawns a Haiku sub-agent via the Agent tool for those cases.
 *
 * Usage:
 *   node bin/validate-invariant.cjs --id=BLD-01 --text="hooks/dist/ rebuilt from current source"
 *   node bin/validate-invariant.cjs --batch --envelope=.planning/formal/requirements.json
 *   node bin/validate-invariant.cjs --batch --strict --envelope=.planning/formal/requirements.json
 *   node bin/validate-invariant.cjs --test
 *
 * Verdicts:
 *   INVARIANT      — requirement has invariant language, passed all gates
 *   NON_INVARIANT  — caught by regex fast-pass (Layer 1)
 *   BORDERLINE     — needs Haiku sub-agent classification (Layer 2: no invariant language, past-tense heavy)
 *   LOW_VALUE      — technically an invariant but not worth tracking (Layer 3: documentation structure, not system behavior)
 *
 * Exit codes:
 *   0 — validation complete (results printed)
 *   1 — operational error
 */

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1: Regex fast-pass
// ─────────────────────────────────────────────────────────────────────────────

const REGEX_RULES = [
  {
    name: 'past_achievement',
    pattern: /\b(ACHIEVED|IMPLEMENTED|DELIVERED)\b/,
    reason: 'Past achievement — archive as milestone finding',
  },
  {
    name: 'release_task',
    pattern: /\b(bumpe?d?\s+from\s+.*\s+to|git\s+tag|published\s+to\s+npm)\b/i,
    reason: 'Release task — belongs in changelog',
  },
  {
    name: 'migration_task',
    pattern: /\b(git\s+mv|ported\s+to|renamed.*preserved)\b/i,
    reason: 'One-time migration — already completed',
  },
  {
    name: 'changelog',
    pattern: /\bCHANGELOG\b/,
    reason: 'Changelog task — documentation, not invariant',
  },
  // REMOVED: build_ci_gate — CI/CD is part of the system; "tests pass" and
  // "dist reflects source" are invariants, not mere acceptance criteria.
  {
    name: 'audit_finding',
    pattern: /\b(no\s+drift\s+detected|audited\s+against|verified\s+by\s+spot.check)\b/i,
    reason: 'Audit finding — a snapshot, not ongoing constraint',
  },
  {
    name: 'past_improvement',
    pattern: /\b(hardened|validated\s+with.*test|gains\s+a\s+.*\s+field|improvement\s+areas\s+identified)\b/i,
    reason: 'Past improvement — describes what was done, not what must hold',
  },
  {
    name: 'past_completion',
    pattern: /\b(added\s+to\s+`|removed\s+from\s+`|created\s+with|no\s+old\s+names\s+remain)\b/i,
    reason: 'Past completion — describes a completed action, not ongoing constraint',
  },
];

/**
 * Run regex fast-pass on a requirement's text.
 * @param {string} text - Requirement text
 * @returns {{ matched: boolean, reason?: string, rule?: string }}
 */
function regexPass(text) {
  // Strip backticks so patterns match content inside code spans
  const stripped = text.replace(/`/g, '');
  for (const rule of REGEX_RULES) {
    if (rule.pattern.test(stripped)) {
      return { matched: true, reason: rule.reason, rule: rule.name };
    }
  }
  return { matched: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3: Value filter — would violating this cause a bug or regression?
// Catches "documentation-only" properties that are technically true but not
// worth tracking as system invariants. These get a LOW_VALUE verdict.
// ─────────────────────────────────────────────────────────────────────────────

const LOW_VALUE_RULES = [
  {
    name: 'readme_structure',
    pattern: /\b(README|readme)\b.*\b(section|diagram|added|includes?|near\s+top)\b/i,
    reason: 'README structure — documentation layout, not system behavior',
  },
  {
    name: 'user_guide_content',
    pattern: /\buser\s+guide\b.*\b(updated|screenshots?|cross.referenc)/i,
    reason: 'User guide content — documentation, not system behavior',
  },
  {
    name: 'changelog_content',
    pattern: /\b(changelog|what.s\s+new)\b.*\b(section|entry|added)\b/i,
    reason: 'Changelog/release notes content — documentation, not system behavior',
  },
];

/**
 * Check if a requirement describes a documentation-only property (low value).
 * @param {string} id - Requirement ID
 * @param {string} text - Requirement text
 * @returns {{ matched: boolean, reason?: string, rule?: string }}
 */
function lowValuePass(id, text) {
  const stripped = text.replace(/`/g, '');

  // Check text-based rules
  for (const rule of LOW_VALUE_RULES) {
    if (rule.pattern.test(stripped)) {
      return { matched: true, reason: rule.reason, rule: rule.name };
    }
  }

  // Check ID-prefix rules: RDME-* and GUIDE-* are documentation by convention.
  // Guard a missing/non-string id (a requirement may carry text but no id) so we
  // don't crash the whole batch on `id.replace(...)`.
  const prefix = typeof id === 'string' ? id.replace(/-\d+$/, '') : '';
  if (prefix === 'RDME' && /\b(section|diagram|added|near\s+top|contribution)\b/i.test(stripped)) {
    return { matched: true, reason: 'README structure — documentation layout, not system behavior', rule: 'readme_prefix' };
  }

  return { matched: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Borderline detection heuristic
// ─────────────────────────────────────────────────────────────────────────────

const INVARIANT_LANGUAGE = /\b(must|shall|always|never|ensures?|prevents?|rejects?|blocks?|validates?|enforces?|requires?|guarantees?|maintains?)\b/i;

// Past-tense action verbs (exclude common participial adjectives used as modifiers)
const PAST_TENSE_ACTIONS = /\b(updated|created|added|removed|renamed|reviewed|identified|ported|archived|implemented|delivered|achieved|migrated|completed|hardened|validated|published|bumped|cleared|finalized)\b/gi;
const PRESENT_TENSE = /\b(is|are|has|have|does|do|can|will|may|should|activates?|writes?|reads?|runs?|tracks?|checks?|detects?|responds?)\b/gi;

/**
 * Check if a requirement is borderline (needs Haiku sub-agent review).
 * Returns true if it lacks invariant language and has majority past-tense action verbs.
 * @param {string} text - Requirement text
 * @returns {boolean}
 */
function isBorderline(text) {
  if (INVARIANT_LANGUAGE.test(text)) return false;

  const pastMatches = (text.match(PAST_TENSE_ACTIONS) || []).length;
  const presentMatches = (text.match(PRESENT_TENSE) || []).length;

  // If majority past-tense action verbs or no strong present-tense verbs, it's borderline
  return pastMatches > presentMatches || (pastMatches > 0 && presentMatches === 0);
}

/**
 * Build the Haiku sub-agent prompt for a borderline requirement.
 * Callers pass this to Agent(model: "haiku") in the workflow.
 * @param {string} id - Requirement ID
 * @param {string} text - Requirement text
 * @returns {string}
 */
function buildHaikuPrompt(id, text) {
  return `You are a requirements invariant classifier.

## Definition

An INVARIANT is a property that must hold at any point in time.
Test: "If I inspect the system RIGHT NOW, does this property hold?"

A NON_INVARIANT is an event that happened once and has no ongoing testable property:
a release, a one-time migration, an audit that was performed, a review that was completed.

## Common traps — read carefully

1. PAST TENSE ≠ NON-INVARIANT. "X updated to use Y" means "X uses Y" — test the property, not the verb tense.
   Example: "Dispatch updated to use parallel calls" → INVARIANT (dispatch uses parallel calls right now)
   Example: "v0.2 milestone archived in MILESTONES.md" → NON_INVARIANT (one-time archival event)

2. FEATURES ARE INVARIANTS. "Dashboard refreshes on keypress" is testable at any point — press the key, observe the refresh. UI behavior is a system property.
   Example: "Dashboard refreshes on keypress with visible timestamp" → INVARIANT (UI behavior)
   Example: "User Guide updated with screenshots" → NON_INVARIANT (documentation content, not system behavior)

3. ROUTING/DISPATCH PATHS ARE INVARIANTS. "Layer X dispatches through Y" means at any point, inspecting the code shows X routes to Y.
   Example: "b_to_f layer dispatches through debug" → INVARIANT (routing property)
   Example: "Reviewed and improvement areas identified" → NON_INVARIANT (review event)

4. CI/CD AND BUILD CONFIG ARE INVARIANTS. The system = source code + CI/CD + build artifacts.
   Example: "VHS tape uses zsh shell and explicit PATH" → INVARIANT (CI config property)
   Example: "Git tag v0.2.0 created and pushed" → NON_INVARIANT (release event)

## Requirement to classify

${id}: ${text}

Classify as exactly one of:
- INVARIANT: <one-line reason>
- NON_INVARIANT: <one-line reason>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a single requirement (regex + borderline heuristic only).
 * Does NOT call Haiku — returns BORDERLINE for cases needing sub-agent review.
 * @param {{ id: string, text: string }} req
 * @returns {{ verdict: string, reason?: string, layer?: string }}
 */
function validateInvariant(req) {
  // Shape guard: a null/non-object req, or one without a string `text`, can't be
  // classified — return a NON_INVARIANT shape verdict instead of crashing on
  // `req.text.replace(...)` (dogfood F48: a requirement missing `text`, or a null
  // array element, took down the whole batch with a raw TypeError).
  if (!req || typeof req.text !== 'string') {
    return { verdict: 'NON_INVARIANT', reason: 'missing or non-string text field', layer: 'shape' };
  }

  // Layer 1: Regex fast-pass — obvious non-invariants
  const regexResult = regexPass(req.text);
  if (regexResult.matched) {
    return { verdict: 'NON_INVARIANT', reason: regexResult.reason, layer: 'regex' };
  }

  // Layer 2: Value filter — technically an invariant but not worth tracking
  // Test: "Would violating this cause a bug, regression, or broken user experience?"
  // Runs before borderline to avoid wasting Haiku calls on documentation-only items.
  const lowValue = lowValuePass(req.id, req.text);
  if (lowValue.matched) {
    return { verdict: 'LOW_VALUE', reason: lowValue.reason, layer: 'value' };
  }

  // Layer 3: Borderline detection → needs Haiku sub-agent
  if (isBorderline(req.text)) {
    return { verdict: 'BORDERLINE', reason: 'Lacks invariant language with past-tense verbs — needs Haiku sub-agent classification', layer: 'heuristic' };
  }

  // Has invariant language, passed regex, has system value → INVARIANT
  return { verdict: 'INVARIANT' };
}

/**
 * Validate a batch of requirements (regex + borderline heuristic only).
 * @param {Array<{ id: string, text: string }>} requirements
 * @returns {Array<{ id: string, verdict: string, reason?: string, layer?: string }>}
 */
function validateInvariantBatch(requirements) {
  // Non-array input (corrupt/wrong-shape envelope) → empty batch, not a `.map` crash.
  if (!Array.isArray(requirements)) return [];
  return requirements.map(req => ({ id: req ? req.id : null, ...validateInvariant(req) }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in test suite
// ─────────────────────────────────────────────────────────────────────────────

function runTests() {
  const archivePath = path.join(__dirname, '..', '.planning', 'formal', 'archived-non-invariants.json');
  if (!fs.existsSync(archivePath)) {
    console.error('Test data not found: .planning/formal/archived-non-invariants.json');
    process.exit(1);
  }

  const archived = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
  const nonInvariants = archived.entries || [];

  console.log('=== Invariant Gate Test Suite ===\n');

  // Test 1: All archived non-invariants should be caught by regex
  console.log(`Test 1: Regex catches archived non-invariants (${nonInvariants.length} entries)`);
  let regexCaught = 0;
  let regexMissed = [];
  for (const entry of nonInvariants) {
    const result = regexPass(entry.text);
    if (result.matched) {
      regexCaught++;
    } else {
      regexMissed.push(entry.id);
    }
  }
  console.log(`  Caught: ${regexCaught}/${nonInvariants.length}`);
  if (regexMissed.length > 0) {
    console.log(`  Missed (would go to Haiku sub-agent): ${regexMissed.join(', ')}`);
  }

  // Test 2: Known good invariants should pass
  const goodInvariants = [
    { id: 'ACT-01', text: '`.planning/current-activity.json` is written atomically at every major workflow state transition' },
    { id: 'CONF-05', text: 'Config changes must trigger validation before being applied' },
    { id: 'STATE-04', text: 'State transitions must be atomic — partial transitions are never persisted' },
    { id: 'ENFC-01', text: 'Quorum enforcement must block plan execution when quorum is not met' },
    { id: 'VERIFY-01', text: 'Verification always runs after phase execution completes' },
    { id: 'AGENT-01', text: 'User can add a new claude-mcp-server instance (name, provider, model, key)' },
    { id: 'BREAKER-01', text: 'Circuit breaker activates when 3+ alternating oscillation groups are detected' },
    { id: 'HOOK-01', text: 'Hooks must never block session start on transient errors' },
    { id: 'MCP-01', text: 'MCP server must respond to health_check within 10 seconds' },
    { id: 'QUICK-01', text: 'Quick tasks must create atomic commits for each logical change' },
  ];

  console.log(`\nTest 2: Known good invariants pass regex (${goodInvariants.length} entries)`);
  let goodPassed = 0;
  let goodFailed = [];
  for (const entry of goodInvariants) {
    const result = regexPass(entry.text);
    if (!result.matched) {
      goodPassed++;
    } else {
      goodFailed.push({ id: entry.id, reason: result.reason });
    }
  }
  console.log(`  Passed: ${goodPassed}/${goodInvariants.length}`);
  if (goodFailed.length > 0) {
    console.log(`  FALSE POSITIVES:`);
    for (const f of goodFailed) {
      console.log(`    ${f.id}: incorrectly rejected — "${f.reason}"`);
    }
  }

  // Test 3: isBorderline heuristic
  console.log('\nTest 3: Borderline detection heuristic');
  const borderlineCases = [
    { text: 'R3.6 quorum enforcement reviewed and improvement areas identified', expected: true },
    { text: 'Quorum enforcement must block plan execution when quorum is not met', expected: false },
    { text: 'All source files updated to use new slot names', expected: true },
    { text: 'Circuit breaker activates when 3+ alternating groups detected', expected: false },
  ];
  let heuristicCorrect = 0;
  for (const tc of borderlineCases) {
    const result = isBorderline(tc.text);
    if (result === tc.expected) {
      heuristicCorrect++;
    } else {
      console.log(`  MISMATCH: "${tc.text.slice(0, 50)}..." — expected ${tc.expected}, got ${result}`);
    }
  }
  console.log(`  Correct: ${heuristicCorrect}/${borderlineCases.length}`);

  // Summary
  const totalTests = nonInvariants.length + goodInvariants.length + borderlineCases.length;
  const totalCorrect = regexCaught + goodPassed + heuristicCorrect;
  console.log(`\n=== Summary: ${totalCorrect}/${totalTests} correct ===`);

  if (regexMissed.length > 0) {
    console.log(`\nNote: ${regexMissed.length} archived non-invariants not caught by regex.`);
    console.log('These would be classified by a Haiku sub-agent in the workflow.');
  }
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

  // --test: run built-in test suite
  if (args.test) {
    runTests();
    process.exit(0);
  }

  // --batch: validate entire envelope
  if (args.batch) {
    const envelopePath = args.envelope || '.planning/formal/requirements.json';
    if (!fs.existsSync(envelopePath)) {
      console.error(`Envelope not found: ${envelopePath}`);
      process.exit(1);
    }

    let envelope;
    try {
      envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
    } catch (e) {
      console.error(`validate-invariant: envelope is not valid JSON (${envelopePath}): ${e.message}`);
      process.exit(1);
    }
    const requirements = Array.isArray(envelope.requirements) ? envelope.requirements : [];

    console.log(`Validating ${requirements.length} requirements...\n`);

    const results = validateInvariantBatch(requirements);
    const nonInvariants = results.filter(r => r.verdict === 'NON_INVARIANT');
    const borderline = results.filter(r => r.verdict === 'BORDERLINE');
    const lowValue = results.filter(r => r.verdict === 'LOW_VALUE');

    if (nonInvariants.length === 0 && borderline.length === 0 && lowValue.length === 0) {
      console.log('All requirements passed invariant gate.');
    } else {
      if (nonInvariants.length > 0) {
        console.log(`NON-INVARIANTS DETECTED (${nonInvariants.length}):\n`);
        for (const ni of nonInvariants) {
          const req = requirements.find(r => r.id === ni.id);
          console.log(`  ${ni.id}: ${req?.text?.slice(0, 80)}...`);
          console.log(`    Reason: ${ni.reason} [${ni.layer}]`);
        }
      }
      if (lowValue.length > 0) {
        console.log(`\nLOW-VALUE — technically invariant but not system behavior (${lowValue.length}):`);
        for (const lv of lowValue) {
          const req = requirements.find(r => r.id === lv.id);
          console.log(`  ${lv.id}: ${req?.text?.slice(0, 80)}...`);
          console.log(`    Reason: ${lv.reason} [${lv.layer}]`);
        }
      }
      if (borderline.length > 0) {
        console.log(`\nBORDERLINE — need Haiku sub-agent review (${borderline.length}):`);
        for (const b of borderline) {
          const req = requirements.find(r => r.id === b.id);
          console.log(`  ${b.id}: ${req?.text?.slice(0, 80)}...`);
        }
      }
    }

    // --strict: archive non-invariants and remove from envelope
    if (args.strict && nonInvariants.length > 0) {
      const archivePath = args['archive-path'] || '.planning/formal/archived-non-invariants.json';
      let archive = { archived_at: null, reason: '', entries: [] };
      if (fs.existsSync(archivePath)) {
        try {
          archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
        } catch (e) {
          console.error(`validate-invariant: archive is not valid JSON (${archivePath}): ${e.message}`);
          process.exit(1);
        }
      }

      // Add any non-invariants not yet in the archive
      const existingIds = new Set((archive.entries || []).map(e => e.id));
      const toArchive = nonInvariants
        .map(ni => requirements.find(r => r.id === ni.id))
        .filter(r => r && !existingIds.has(r.id));

      if (toArchive.length > 0) {
        archive.entries = [...(archive.entries || []), ...toArchive];
        archive.archived_at = new Date().toISOString();
        archive.reason = archive.reason || 'Non-invariant entries removed by invariant gate';

        const dir = path.dirname(archivePath);
        const tmpArch = path.join(dir, '.archived-non-invariants.json.tmp');
        fs.writeFileSync(tmpArch, JSON.stringify(archive, null, 2) + '\n', 'utf8');
        fs.renameSync(tmpArch, archivePath);
        console.log(`\nArchived ${toArchive.length} new non-invariants to ${archivePath}`);
      }

      // Always remove non-invariants from envelope (even if already in archive)
      const nonInvariantIds = new Set(nonInvariants.map(ni => ni.id));
      envelope.requirements = requirements.filter(r => !nonInvariantIds.has(r.id));

      const dir = path.dirname(envelopePath);
      const tmpEnv = path.join(dir, '.requirements.json.tmp');
      fs.writeFileSync(tmpEnv, JSON.stringify(envelope, null, 2) + '\n', 'utf8');
      fs.renameSync(tmpEnv, envelopePath);

      console.log(`Envelope reduced: ${requirements.length} → ${envelope.requirements.length}`);
    }

    const invariantCount = results.length - nonInvariants.length - borderline.length - lowValue.length;
    const parts = [`${nonInvariants.length} non-invariant`];
    if (lowValue.length > 0) parts.push(`${lowValue.length} low-value`);
    parts.push(`${borderline.length} borderline`, `${invariantCount} invariant`);
    console.log(`\nSummary: ${parts.join(', ')}`);
    process.exit(0);
  }

  // Single requirement mode
  if (!args.id || !args.text) {
    console.error('Usage: node bin/validate-invariant.cjs --id=ID --text="requirement text"');
    console.error('       node bin/validate-invariant.cjs --batch [--envelope=path] [--strict]');
    console.error('       node bin/validate-invariant.cjs --test');
    process.exit(1);
  }

  const result = validateInvariant({ id: args.id, text: args.text });

  if (result.verdict === 'INVARIANT') {
    console.log('Invariant check: PASS');
  } else if (result.verdict === 'BORDERLINE') {
    console.log('Invariant check: BORDERLINE — needs Haiku sub-agent classification');
    console.log(`  Haiku prompt: ${buildHaikuPrompt(args.id, args.text).slice(0, 100)}...`);
  } else if (result.verdict === 'LOW_VALUE') {
    console.log('Invariant check: LOW_VALUE — technically an invariant but not system behavior');
    console.log(`  Reason: ${result.reason}`);
    console.log(`  Test: "Would violating this cause a bug, regression, or broken UX?" → No`);
  } else {
    console.log('Invariant check: FAIL');
    console.log(`  Reason: ${result.reason}`);
    console.log(`  Layer: ${result.layer}`);
  }

  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  regexPass,
  isBorderline,
  buildHaikuPrompt,
  validateInvariant,
  validateInvariantBatch,
  INVARIANT_LANGUAGE,
};

if (require.main === module) {
  main();
}

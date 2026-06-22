#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Internal helper: merge baseline into existing requirements.
 * Handles the core sync logic (steps 2-7 from original implementation).
 */
function _syncFromBaseline(baseline, projectRoot, opts = {}) {
  const root = projectRoot || process.cwd();
  const dryRun = !!opts.dryRun;

  // 2. Read existing requirements
  const reqPath = path.join(root, '.planning', 'formal', 'requirements.json');
  let rawEnvelope;
  let requirements;

  if (fs.existsSync(reqPath)) {
    try {
      rawEnvelope = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
      requirements = rawEnvelope.requirements || [];
    } catch (_) {
      rawEnvelope = {};
      requirements = [];
    }
  } else {
    // Create .formal directory if needed
    fs.mkdirSync(path.join(root, '.planning', 'formal'), { recursive: true });
    rawEnvelope = {};
    requirements = [];
  }

  // 3. Build lookup of existing requirement texts -> requirement object
  const existingByText = new Map(requirements.map(r => [r.text, r]));

  // 4. Build map of highest existing ID number per prefix
  const maxId = {};
  for (const r of requirements) {
    if (!r.id) continue;
    const dashIdx = r.id.lastIndexOf('-');
    if (dashIdx === -1) continue;
    const prefix = r.id.substring(0, dashIdx);
    const num = parseInt(r.id.substring(dashIdx + 1), 10);
    if (!isNaN(num)) {
      maxId[prefix] = Math.max(maxId[prefix] || 0, num);
    }
  }

  const added = [];
  const skipped = [];
  const updated = [];
  const totalBefore = requirements.length;

  // 5-6. Process each baseline category
  for (const cat of baseline.categories) {
    if (!cat.requirements || cat.requirements.length === 0) continue;

    // Derive prefix from first requirement's ID (e.g., "UX-01" -> "UX")
    const firstId = cat.requirements[0].id;
    const dashIdx = firstId.lastIndexOf('-');
    const prefix = firstId.substring(0, dashIdx);

    for (const req of cat.requirements) {
      const existing = existingByText.get(req.text);
      if (existing) {
        // 6a. Skip duplicate, but normalize baseline provenance on matched entries.
        if (!existing.provenance || existing.provenance.source_file !== 'nf-baseline') {
          existing.provenance = {
            ...(existing.provenance || {}),
            source_file: 'nf-baseline',
          };
          updated.push({
            id: existing.id,
            text: existing.text,
          });
        }
        skipped.push({
          id: req.id,
          text: req.text,
          existingId: existing.id,
        });
      } else {
        // 6c. Assign next available ID
        maxId[prefix] = (maxId[prefix] || 0) + 1;
        const padLen = maxId[prefix] > 99 ? String(maxId[prefix]).length : 2;
        const newId = prefix + '-' + String(maxId[prefix]).padStart(padLen, '0');

        const newReq = {
          id: newId,
          text: req.text,
          category: cat.name,
          phase: 'baseline',
          status: 'Pending',
          provenance: {
            source_file: 'nf-baseline',
            milestone: 'baseline',
          },
        };

        requirements.push(newReq);
        existingByText.set(req.text, newReq);
        added.push({ id: newId, text: req.text });
      }
    }
  }

  // 7. Write if anything changed
  if (added.length > 0 || updated.length > 0) {
    const contentHash = 'sha256:' + crypto
      .createHash('sha256')
      .update(JSON.stringify(requirements, null, 2))
      .digest('hex');

    // Defensive: only write if hash actually changed
    const existingHash = rawEnvelope.content_hash || null;
    if (existingHash !== contentHash) {
      const envelope = {
        ...rawEnvelope,
        aggregated_at: new Date().toISOString(),
        content_hash: contentHash,
        frozen_at: rawEnvelope.frozen_at || null,
        schema_version: rawEnvelope.schema_version || undefined,
        requirements,
      };

      // Remove undefined keys
      if (envelope.schema_version === undefined) delete envelope.schema_version;

      // --dry-run: compute the merge + report, but write nothing.
      if (!dryRun) {
        fs.writeFileSync(reqPath, JSON.stringify(envelope, null, 2) + '\n');
      }
    }
  }

  return {
    added,
    skipped,
    updated,
    total_before: totalBefore,
    total_after: requirements.length,
    dry_run: dryRun,
  };
}

/**
 * Merge baseline requirements into .planning/formal/requirements.json.
 * Idempotent: matches on exact `text` field to skip duplicates.
 * Assigns next-available IDs per category prefix for new entries.
 *
 * @param {string} profile - One of: web, mobile, desktop, api, cli, library
 * @param {string} [projectRoot] - Path to project root, defaults to process.cwd()
 * @returns {{ added: Array, skipped: Array, total_before: number, total_after: number }}
 */
function syncBaselineRequirements(profile, projectRoot, opts = {}) {
  const root = projectRoot || process.cwd();

  // 1. Load baseline requirements
  let baseline;
  try {
    const { loadBaselineRequirements } = require('./load-baseline-requirements.cjs');
    baseline = loadBaselineRequirements(profile);
  } catch (err) {
    console.error(`Error loading baseline requirements: ${err.message}`);
    process.exit(2);
  }

  return _syncFromBaseline(baseline, root, opts);
}

/**
 * Merge intent-based baseline requirements into .planning/formal/requirements.json.
 * Idempotent: matches on exact `text` field to skip duplicates.
 * Assigns next-available IDs per category prefix for new entries.
 *
 * @param {Object} intent - Intent object with base_profile and optional dimensions
 * @param {string} [projectRoot] - Path to project root, defaults to process.cwd()
 * @returns {{ added: Array, skipped: Array, total_before: number, total_after: number }}
 */
function syncBaselineRequirementsFromIntent(intent, projectRoot, opts = {}) {
  const root = projectRoot || process.cwd();

  // 1. Load baseline requirements from intent
  let baseline;
  try {
    const { loadBaselineRequirementsFromIntent } = require('./load-baseline-requirements.cjs');
    baseline = loadBaselineRequirementsFromIntent(intent);
  } catch (err) {
    console.error(`Error loading baseline requirements: ${err.message}`);
    process.exit(2);
  }

  return _syncFromBaseline(baseline, root, opts);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printReport(result, profile) {
  console.log(`Baseline sync: ${profile} profile${result.dry_run ? '  [DRY RUN — no changes written]' : ''}`);
  console.log(`  Before: ${result.total_before} requirements`);
  console.log(`  Added:  ${result.added.length} new requirements`);
  console.log(`  Updated: ${result.updated.length} existing requirements retagged`);
  console.log(`  Skipped: ${result.skipped.length} (already present by text match)`);
  console.log(`  After:  ${result.total_after} requirements`);

  if (result.added.length > 0) {
    console.log('\nAdded:');
    for (const a of result.added) {
      console.log(`  + [${a.id}] ${a.text}`);
    }
  }

  if (result.skipped.length > 0) {
    console.log('\nSkipped:');
    for (const s of result.skipped) {
      console.log(`  ~ [${s.id}] matched existing [${s.existingId}]`);
    }
  }

  if (result.updated.length > 0) {
    console.log('\nUpdated:');
    for (const u of result.updated) {
      console.log(`  * [${u.id}] provenance.source_file -> nf-baseline`);
    }
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log([
      'Usage: node bin/sync-baseline-requirements.cjs [options]',
      '',
      'Merge profile/intent baseline requirements into',
      '.planning/formal/requirements.json (idempotent — dedupes on `text`).',
      '',
      'Options:',
      '  --profile <web|mobile|desktop|api|cli|library>  Use a named profile.',
      '  --intent-file <path>  Use an intent JSON file.',
      '  --json                Machine-readable output.',
      '  --dry-run             Compute and report the merge but write NOTHING.',
      '  -h, --help            Show this help and exit (no analysis, no writes).',
      '',
      'With no --profile/--intent-file, the profile is read from',
      '.planning/config.json, else auto-detected.',
    ].join('\n'));
    process.exit(0);
  }

  // --json flag
  const jsonOutput = args.includes('--json');

  // --dry-run: compute + report the merge without writing requirements.json
  const dryRun = args.includes('--dry-run');
  const runOpts = { dryRun };

  // --detect is deprecated (auto-detect is now the default behavior) — silently strip it
  const cleanArgs = args.filter(arg => arg !== '--detect');

  // Priority: --intent-file > --profile > config.json intent > config.json profile > AUTO-DETECT

  // Check --intent-file
  const intentFileIdx = cleanArgs.indexOf('--intent-file');
  if (intentFileIdx !== -1 && cleanArgs[intentFileIdx + 1]) {
    try {
      const intentFilePath = cleanArgs[intentFileIdx + 1];
      const intentContent = fs.readFileSync(intentFilePath, 'utf8');
      const intent = JSON.parse(intentContent);
      const result = syncBaselineRequirementsFromIntent(intent, undefined, runOpts);
      if (jsonOutput) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printReport(result, `intent (base_profile: ${intent.base_profile})`);
      }
      process.exit(0);
    } catch (err) {
      console.error(`Error loading intent file: ${err.message}`);
      process.exit(1);
    }
  }

  // Parse --profile
  const profileIdx = cleanArgs.indexOf('--profile');
  let profile = null;

  if (profileIdx !== -1 && cleanArgs[profileIdx + 1]) {
    profile = cleanArgs[profileIdx + 1];
  } else {
    // Try reading from .planning/config.json (intent first, then profile)
    try {
      const config = JSON.parse(fs.readFileSync(
        path.join(process.cwd(), '.planning/config.json'), 'utf8'
      ));
      if (config.intent) {
        const result = syncBaselineRequirementsFromIntent(config.intent, undefined, runOpts);
        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          printReport(result, `config intent (base_profile: ${config.intent.base_profile})`);
        }
        process.exit(0);
      }
      profile = config.profile;
    } catch (_) {}
  }

  // If no profile found, auto-detect (new default behavior)
  if (!profile) {
    try {
      const { detectProjectIntent } = require('./detect-project-intent.cjs');
      const detectionResult = detectProjectIntent(process.cwd());
      const intent = detectionResult.suggested;
      const result = syncBaselineRequirementsFromIntent(intent, undefined, runOpts);
      if (jsonOutput) {
        console.log(JSON.stringify({ ...result, detection: detectionResult }, null, 2));
      } else {
        printReport(result, `auto-detected intent (base_profile: ${intent.base_profile})`);
      }
      process.exit(0);
    } catch (err) {
      console.error(`Error auto-detecting project intent: ${err.message}`);
      console.error('Hint: use --profile <web|mobile|desktop|api|cli|library> to specify manually');
      process.exit(1);
    }
  }

  const result = syncBaselineRequirements(profile, undefined, runOpts);
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printReport(result, profile);
  }
}

module.exports = { syncBaselineRequirements, syncBaselineRequirementsFromIntent };

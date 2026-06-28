#!/usr/bin/env node
'use strict';

/**
 * dedup-changelog.cjs — One-time cleanup script for promotion-changelog.json.
 *
 * Removes duplicate entries (same model, same from_level, same to_level within
 * a 5-minute window). Can be re-run safely — idempotent.
 *
 * Requirements: STAB-03
 *
 * Usage:
 *   node bin/dedup-changelog.cjs            # clean promotion-changelog.json
 *   node bin/dedup-changelog.cjs --dry-run  # show what would be removed
 */

const fs = require('fs');
const path = require('path');

const DEDUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Deduplicates a changelog array.
 * Keeps an entry only if no previously-kept entry matches on
 * (model, from_level, to_level) within the 5-minute window.
 *
 * @param {Array} changelog - Array of changelog entries
 * @returns {Array} Deduplicated array (preserves original order)
 */
function dedup(changelog) {
  if (!Array.isArray(changelog)) return [];
  const kept = [];
  for (const entry of changelog) {
    if (!entry || typeof entry !== 'object') continue;
    const entryTime = new Date(entry.timestamp).getTime();
    if (Number.isNaN(entryTime)) { kept.push(entry); continue; }
    let isDuplicate = false;
    // Scan kept entries in reverse for efficiency
    for (let i = kept.length - 1; i >= 0; i--) {
      const existing = kept[i];
      const existingTime = new Date(existing.timestamp).getTime();
      if (Math.abs(entryTime - existingTime) >= DEDUP_WINDOW_MS) break;
      if (existing.model === entry.model &&
          existing.from_level === entry.from_level &&
          existing.to_level === entry.to_level) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) {
      kept.push(entry);
    }
  }
  return kept;
}

if (require.main === module) {
  const ROOT = process.env.PROJECT_ROOT || path.join(__dirname, '..');
  const changelogPath = path.join(ROOT, '.planning', 'formal', 'promotion-changelog.json');
  const dryRun = process.argv.includes('--dry-run');

  if (!fs.existsSync(changelogPath)) {
    console.log('promotion-changelog.json not found at ' + changelogPath);
    process.exit(1);
  }

  let changelog;
  try {
    changelog = JSON.parse(fs.readFileSync(changelogPath, 'utf8'));
    if (!Array.isArray(changelog)) {
      console.log('promotion-changelog.json is not an array');
      process.exit(1);
    }
  } catch (e) {
    console.log('Failed to parse promotion-changelog.json: ' + e.message);
    process.exit(1);
  }

  const before = changelog.length;
  const cleaned = dedup(changelog);
  const after = cleaned.length;
  const removed = before - after;

  console.log('Before: ' + before + ', After: ' + after + ', Removed: ' + removed);

  if (!dryRun && removed > 0) {
    fs.writeFileSync(changelogPath, JSON.stringify(cleaned, null, 2) + '\n');
    console.log('Wrote cleaned changelog to ' + changelogPath);
  } else if (dryRun) {
    console.log('(dry-run: no changes written)');
  }
}

module.exports = { dedup, DEDUP_WINDOW_MS };
